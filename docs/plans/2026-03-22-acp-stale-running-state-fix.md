# ACP Stale Running State Fix

**Date:** 2026-03-22 (revised 2026-03-23 after GPT review)
**Status:** Implemented
**Branch:** `fix/acp-stale-running-state`

---

## Problem

When a Claude Code CLI session finishes a turn but AionUi misses the completion signal, the conversation UI gets permanently stuck in a "processing" state — spinner visible, send button disabled, no way to recover without restarting the app.

### Observed behavior

- User ran a pre-PR review (multi-agent task, ~12 minutes) via AionUi remote (phone → Mac via Tailscale)
- The CLI completed successfully (JSONL shows `stop_reason: 'end_turn'`)
- AionUi's UI remained stuck showing spinner on **both** the remote renderer and local Mac
- "Remote" here means the phone is a web renderer connecting to the same Mac Electron main process — all IPC, tasks, and CLI processes are local on the Mac

### Root cause analysis

Three bugs contribute, listed by likely impact:

**Bug A — `{ success: false }` silently swallowed without cleanup**

When `AcpAgent.sendMessage()` catches a timeout or other error, it:

1. Calls `emitErrorMessage()` → emits `'error'` to the renderer (renderer DOES handle this)
2. Returns `{ success: false, error }` without throwing

But `AcpAgentManager.sendMessage()` at line 557 sets `this.status = 'running'`, then at line 610-622 receives the `{ success: false }` return — **doesn't throw, so the catch block (line 631) is never reached**. Result:

- `this.status` stays whatever the last stream event set it to (could still be `'running'` if no content arrived before the error)
- `cronBusyGuard.setProcessing(false)` is never called (only runs in the catch block at line 633 or on `'finish'` signal at line 438)
- `conversationBridge.sendMessage()` at line 402-408 ignores the return value and always returns `{ success: true }` — masking the failure upstream

**Bug B — Orphaned `PromptResponse` silently dropped after timeout**

`sendPrompt` has a 5-minute rolling timeout (resets on each `session_update` via `resetSessionPromptTimeouts()` at `AcpConnection.ts:564-578`). If the timeout fires:

1. Pending request removed from `pendingRequests` (line 469)
2. `AcpAgent.sendMessage()` catch block emits error to renderer AND returns `{ success: false }` (see Bug A)
3. When the CLI eventually sends the `PromptResponse` with `stopReason: 'end_turn'`, `handleMessage()` can't find the request ID → **response silently ignored** (line 626)
4. `onEndTurn()` never called → `onSignalEvent({ type: 'finish' })` never emitted

The renderer may have recovered from the 'error' event, but the backend state and `cronBusyGuard` remain stale. And if a user retries, the stale state can interfere.

**Bug C — No recovery mechanism for stale state**

- `conversation.status` is derived from in-memory `task.status` (`conversationBridge.ts:277`)
- App restart recovers (no task in memory → defaults to `'finished'`)
- But during a live session, there's no self-healing: no liveness check, no way to detect that the process is dead while the task still says `'running'`

### Why we're guessing

There are **no diagnostic logs** for ACP state transitions. We can't determine which exact path led to the stuck state. All fixes below are informed by code analysis, but the logging gap must be closed to diagnose future incidents.

---

## Fix Plan

### Phase 1 — Fix the bugs (do first)

#### Fix 1.1: Clean up on `{ success: false }` return path

**Problem:** `AcpAgentManager.sendMessage()` only cleans up in its catch block. When `agent.sendMessage()` returns `{ success: false }` without throwing, status and cronBusyGuard leak.

**Files:** `src/process/task/AcpAgentManager.ts`

**Change:** After `await this.agent.sendMessage(...)` returns, check the result and do the same cleanup the catch block does:

```typescript
// After line 610 (const result = await this.agent.sendMessage(...))
// and line 625 (const result = await this.agent.sendMessage(data))
if (!result.success) {
  this.flushBufferedStreamTextMessages();
  cronBusyGuard.setProcessing(this.conversation_id, false);
  this.status = 'finished';
}
return result;
```

**Also fix:** `conversationBridge.sendMessage()` at line 402-408 — propagate the agent's failure result instead of always returning `{ success: true }`:

```typescript
// Line 402-408: change to propagate result
const result = await task.sendMessage({ ... });
return result?.success === false
  ? { success: false, msg: result.msg || result.error?.message || 'Agent failed' }
  : { success: true };
```

**Risk:** Low. Adds cleanup that should have always been there. The renderer already handles 'error' events from `AcpAgent.emitErrorMessage()`.

**Testing:**

- Mock `agent.sendMessage()` to return `{ success: false }`, verify `this.status === 'finished'` and cronBusyGuard cleared
- Verify `conversationBridge.sendMessage()` returns `{ success: false }` when agent fails

#### Fix 1.2: Self-healing liveness check in `conversationBridge.get`

**Problem:** Backend task stays `'running'` with a dead connection; renderer re-reads this on every mount.

**Files:** `src/process/bridge/conversationBridge.ts`

**Change:** Before returning `task.status === 'running'`, verify the agent's child process is alive via `AcpConnection.isConnected` (`this.child !== null && !this.child.killed`). If the process is dead, kill the task:

```typescript
// In conversationBridge.get handler, after line 276
const task = workerTaskManager.getTask(id);
if (task?.status === 'running') {
  const agent = (task as any).agent;
  if (agent && 'isConnected' in agent && !agent.isConnected) {
    workerTaskManager.kill(id);
    return { ...conversation, status: 'finished' };
  }
}
```

**Note:** Need to verify the exact way to access the agent from the task. `AcpAgentManager` holds `this.agent` (an `AcpAgent` instance) which exposes `isConnected` (delegates to `AcpConnection.isConnected`).

**Risk:** Low. `kill()` is already used during conversation deletion (`conversation.reset` at line 261-268). Only triggers when the process is genuinely dead.

**Testing:** Kill the CLI child process manually (`kill <pid>`), verify conversation auto-recovers on next page load.

#### Fix 1.3: Handle orphaned PromptResponse after timeout

**Problem:** After timeout, the eventual `PromptResponse` with `end_turn` is silently dropped because the request ID was removed from `pendingRequests`.

**Files:** `src/process/agent/acp/AcpConnection.ts`

**Change:** In `handleMessage()`, when a response arrives but has no matching pending request, check for `end_turn` and still fire `onEndTurn()`:

```typescript
// In handleMessage(), after the pending request check (around line 626)
// Instead of silently ignoring:
} else if ('id' in message && 'result' in message) {
  // Orphaned response — request was already resolved (e.g., by timeout).
  // Still fire onEndTurn if this is an end_turn so backend state resets.
  if (message.result && typeof message.result === 'object') {
    const result = message.result as Record<string, unknown>;
    if (result.stopReason === 'end_turn') {
      this.onEndTurn();
    }
  }
}
```

**Risk:** Medium. A late orphaned `end_turn` from a timed-out turn could fire `finish` during a newer retry. Mitigate by tracking the current turn's request ID and only accepting `onEndTurn()` from the expected turn. However, the consequence of a spurious `finish` is just the renderer resetting its loading state — which is already recoverable by sending a new message. So the practical risk is low even without turn-scoping.

**Testing:** Simulate timeout (set `timeoutDuration` to 5s), run a prompt that takes longer, verify `onEndTurn` fires when the late response arrives.

### Phase 2 — Recovery escape hatches (do second)

#### Fix 2.1: Use existing `conversation.reset` as force-stop fallback

**Problem:** `conversation.stop` calls `task.stop()` directly in the main process (line 334-337). This should work, but if `task.stop()` hangs (e.g., agent's `stop()` awaits a stuck disconnect), the user has no harder escape hatch.

**Existing infrastructure:** `conversation.reset` at line 261-268 already calls `workerTaskManager.kill(id)`, which removes the task from memory and kills the process. No new IPC needed.

**Files:** `src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx`

**Change:** Update `handleStop` to fall back to `conversation.reset` if `stop` doesn't complete within 3 seconds:

```typescript
const handleStop = async (): Promise<void> => {
  try {
    const stopPromise = ipcBridge.conversation.stop.invoke({ conversation_id });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('stop timeout')), 3000));
    await Promise.race([stopPromise, timeout]);
  } catch {
    await ipcBridge.conversation.reset.invoke({ id: conversation_id });
  } finally {
    resetState();
  }
};
```

**Scope:** Apply to all platform SendBoxes or extract a shared hook.

**Risk:** Low. `conversation.reset` → `kill()` is already used during conversation deletion.

**Testing:** Verify stop button force-kills within 3s when agent is unresponsive.

#### Fix 2.2: JSONL last-entry check for local sessions

**Problem:** Even with fix 1.2, the child process may still be alive (waiting for next user input) while the UI thinks it's still processing. The JSONL file is the ground truth for local sessions.

**Files:**

- `src/process/cli-history/converters/claude.ts` — add `isClaudeSessionIdle(lastLines)` utility
- `src/process/bridge/conversationBridge.ts` — integrate into liveness check from fix 1.2

**Change:** Add a lightweight function that reads the last few lines of a JSONL file and checks for `stop_reason: 'end_turn'` on the last assistant message:

```typescript
export function isClaudeSessionIdle(lastLines: string[]): boolean {
  for (let i = lastLines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lastLines[i]);
      if (entry.type === 'assistant' && entry.message?.stop_reason === 'end_turn') {
        return true;
      }
      if (entry.type === 'user') {
        return false;
      }
    } catch {
      continue;
    }
  }
  return false;
}
```

Integrate into `conversationBridge.get`: if `task.status === 'running'` and `agent.isConnected` is true (process alive), resolve the JSONL path via `cliHistoryBridge.resolveSessionFilePath` and check `isClaudeSessionIdle()`. If idle AND the last JSONL entry is older than 10 seconds (guards against race conditions), emit `'finish'` signal and return `'finished'`.

**Risk:** Medium. False positives if the CLI hasn't written the final entry yet. The 10-second staleness check mitigates this.

**Testing:** Run a CLI session to completion, verify `isClaudeSessionIdle()` returns true.

### Phase 3 — Diagnostics (do third)

#### Fix 3.1: ACP lifecycle logging

**Problem:** No diagnostic logs for state transitions. Can't determine root cause of stuck states.

**Files:**

- `src/process/utils/acpLogger.ts` — new file, lightweight rotating logger
- `src/process/agent/acp/AcpConnection.ts` — instrument timeout, end_turn, orphaned response
- `src/process/agent/acp/index.ts` — instrument handleEndTurn, handleDisconnect, sendMessage result
- `src/process/task/AcpAgentManager.ts` — instrument status transitions, signal events, `{ success: false }` path
- `src/renderer/pages/conversation/platforms/acp/useAcpMessage.ts` — instrument state changes

**Change:**

Create a simple file-based logger that writes to `~/Library/Logs/AionUi/acp-lifecycle.log` (or use `electron-log` which is already a dependency). Instrument these critical points:

| Location                                 | What to log                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `AcpAgentManager.sendMessage`            | `status: running` with conversation_id                                       |
| `AcpAgentManager.sendMessage` (result)   | `agent returned { success: false }` with error details                       |
| `AcpAgentManager.onStreamEvent`          | `status: finished (reason: content_arrived, type={type})`                    |
| `AcpAgentManager.onSignalEvent`          | `signal: {type}` with conversation_id                                        |
| `AcpConnection.sendRequest`              | `prompt_sent (request_id={id})`                                              |
| `AcpConnection.handleMessage` (response) | `prompt_response: {stopReason} (request_id={id}, elapsed={ms})`              |
| `AcpConnection.handleMessage` (orphaned) | `orphaned_response: request_id={id} not in pendingRequests`                  |
| `AcpConnection` timeout handler          | `prompt_timeout: request_id={id}, last_update={ms}ago`                       |
| `AcpConnection.handleProcessExit`        | `process_exit: code={code}, signal={signal}`                                 |
| `conversationBridge.get`                 | `liveness_check: task={status}, connected={bool}` (only when status=running) |
| `conversationBridge.sendMessage`         | `agent_result: success={bool}` (when false)                                  |
| `useAcpMessage` (renderer)               | `ui_state: running={bool}, aiProcessing={bool}, trigger={event_type}`        |

**Log format:**

```
[2026-03-23T01:00:34.835Z] [acp] [conv:4e93288a] status: running → finished (reason: content_arrived, type: content)
[2026-03-23T01:00:34.900Z] [acp] [conn:claude] prompt_response: end_turn (request_id: 7, elapsed: 42100ms)
[2026-03-23T01:00:34.901Z] [acp] [conv:4e93288a] signal: finish emitted
[2026-03-23T01:05:34.000Z] [acp] [conn:claude] prompt_timeout: request_id=7, last_update=300s_ago
[2026-03-23T01:05:34.001Z] [acp] [conv:4e93288a] agent returned { success: false }: LLM request timed out
```

**Rotation:** Daily rotation, keep 7 days, max 10MB per file. Use `electron-log` if already available, otherwise a simple `appendFileSync` wrapper.

**Risk:** None. Read-only instrumentation.

### Phase 4 — UX polish (do last)

#### Fix 4.1: "No activity" visual hint

**Problem:** When a session is stuck, the user doesn't know it's stuck vs legitimately processing.

**Files:**

- `src/renderer/components/chat/SendBox.tsx` (or the shared component)
- `src/renderer/pages/conversation/platforms/acp/useAcpMessage.ts`

**Change:**

Track the timestamp of the last received stream event. When `running === true` and no event has arrived for 2+ minutes, show a subtle label near the stop button:

```
"No response for 2m — click stop to reset"
```

**Implementation:** Add a `lastStreamEventAt` ref in `useAcpMessage`. Update it on every `handleResponseMessage` call. In the SendBox, compare `Date.now() - lastStreamEventAt` against a threshold (120s). Show the hint text when exceeded.

**Risk:** None. Informational only, no auto-reset.

---

## Implementation Order

```
Phase 1 (bugs):     Fix 1.1 → Fix 1.2 → Fix 1.3
Phase 2 (recovery): Fix 2.1 → Fix 2.2
Phase 3 (logging):  Fix 3.1
Phase 4 (UX):       Fix 4.1
```

Each fix is independent and can be shipped separately. Phase 1 is the critical path — fixes the root cause. Phase 2 adds escape hatches. Phase 3 ensures future incidents are diagnosable. Phase 4 is polish.

---

## Estimated Effort

| Fix                                                   | Lines changed | Files   | Effort        |
| ----------------------------------------------------- | ------------- | ------- | ------------- |
| 1.1 `{ success: false }` cleanup + bridge propagation | ~25           | 2       | Small         |
| 1.2 Liveness check                                    | ~15           | 1       | Small         |
| 1.3 Orphaned response handling                        | ~15           | 1       | Small         |
| 2.1 Force-stop via existing `conversation.reset`      | ~15           | 1-5     | Small         |
| 2.2 JSONL idle check                                  | ~40           | 2       | Medium        |
| 3.1 Lifecycle logging                                 | ~80           | 5-6     | Medium        |
| 4.1 No-activity hint                                  | ~25           | 2       | Small         |
| **Total**                                             | **~215**      | **~12** | **~1-2 days** |

---

## Testing

| Fix | Test approach                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Mock `agent.sendMessage()` to return `{ success: false }` → verify `this.status === 'finished'`, cronBusyGuard cleared, bridge returns failure |
| 1.2 | Kill CLI child process (`kill <pid>`) → verify conversation auto-recovers on next page load                                                    |
| 1.3 | Set `timeoutDuration` to 5s, run slow prompt → verify `onEndTurn` fires when late response arrives                                             |
| 2.1 | Make `task.stop()` hang (mock) → verify stop button falls back to `reset` within 3s                                                            |
| 2.2 | Run CLI session to completion → verify `isClaudeSessionIdle()` returns true                                                                    |
| 3.1 | Trigger each instrumented path → verify log entries appear in file                                                                             |
| 4.1 | Pause streaming mid-turn → verify hint appears after 2 minutes                                                                                 |

**Regression tests (from GPT review):**

- Remount behavior: `conversation.get()` after timeout/error returns correct status
- Late orphaned `end_turn` arriving after a retry doesn't break the new turn
- `cronBusyGuard` is always cleared on both `{ success: false }` and thrown-error paths

---

## Review Notes

### GPT review corrections (2026-03-23)

1. **Timeout is NOT silent for the renderer.** `AcpAgent.sendMessage()` catch calls `emitErrorMessage()` → emits `'error'` to renderer → renderer resets `running`/`aiProcessing`. Original plan overclaimed this.
2. **Real Bug A is `{ success: false }` swallowed.** `AcpAgentManager.sendMessage()` doesn't clean up status/cronBusyGuard when agent returns failure without throwing. `conversationBridge.sendMessage()` masks the failure by always returning `{ success: true }`.
3. **No new `forceStop` IPC needed.** Existing `conversation.reset` (line 261-268) already calls `workerTaskManager.kill()`.
4. **`conversation.stop` is NOT a dead worker channel.** It directly calls `task.stop()` in the main process (line 334-337). Original plan's rationale was wrong.
5. **Orphaned response fix needs care.** A late `end_turn` from a timed-out turn could fire `finish` during a newer retry. Practical risk is low (spurious finish just resets loading state) but noted.
6. **`cronBusyGuard` leak** on the `{ success: false }` path — added to Fix 1.1.
7. **Logging (Fix 3.1) had no objections** — well-scoped and clearly needed.

---

## Done Means

- [x] No conversation can get permanently stuck in "processing" state
- [x] `{ success: false }` from agent properly cleans up status and cronBusyGuard
- [x] `conversationBridge.sendMessage()` propagates agent failures
- [x] Stop button always works via `conversation.reset` fallback
- [x] ACP state transitions logged via `mainLog`/`mainWarn`/`console.warn` (routed to electron-log file)
- [x] User gets visual feedback when a session may be stuck
- [x] All existing tests pass (`bun run test`)
