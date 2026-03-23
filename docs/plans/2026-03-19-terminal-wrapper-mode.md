# Terminal Wrapper Mode (xterm.js)

**Date:** 2026-03-19 (updated 2026-03-21)
**Status:** Draft — research complete, no implementation yet

---

## Motivation

AionUI communicates with CLI agents via ACP (JSON-RPC), which provides structured tool-call cards, permission dialogs, and expandable steps. However:

- Not all CLIs support ACP
- ACP integration can have bugs (e.g., the concurrent permission race condition fixed in `fix/acp-concurrent-permission-race-condition`)
- When ACP is broken, users have no way to use the CLI through AionUI

A terminal mode lets users switch any conversation to a raw terminal wrapper, keeping AionUI's key benefit — **the conversation history sidebar** — while using the CLI directly. This is not a fallback; it's an alternative mode users can choose.

---

## Core Design: Mode Toggle, Not Separate Conversation Type

Terminal is **not a new conversation type**. It's an alternative rendering mode for existing conversations. Every conversation has a CLI agent selected already — the toggle just changes the transport:

- **Rich UI (ACP):** CLI speaks JSON-RPC → AionUI renders structured cards, permission dialogs, expandable tool calls
- **Terminal:** CLI spawned via PTY → AionUI renders raw terminal via xterm.js

### Entry point

No separate "create terminal conversation" flow. Instead:

1. **Default mode setting:** Settings page has "Default conversation mode" — Rich UI (ACP) or Terminal. New conversations start in the chosen mode.
2. **Per-conversation toggle:** Header bar has a `💬 Rich UI | >_ Terminal` segmented control. User can switch modes anytime mid-conversation.

### How the toggle works

**Rich UI → Terminal:**

1. Kill ACP connection (`AcpConnection.disconnect()`)
2. Spawn same CLI binary via `node-pty` with resume flag (see per-CLI details below)
3. CLI resumes from its own JSONL history — full conversation context preserved
4. Content area swaps to xterm.js terminal (no input box — terminal IS the input)
5. AionUI's SQLite messages remain untouched for when user toggles back

**Terminal → Rich UI:**

1. Kill PTY process
2. Reconnect via ACP: `AcpConnection.connect()` → `session/new` with `resumeSessionId`
3. CLI resumes from its JSONL — same session, different transport
4. Parse CLI's JSONL history → convert to `TMessage[]` → render as rich UI
5. New messages from ACP streaming forward render natively as rich UI

Both directions work because **the CLI's JSONL is the source of truth** for conversation continuity. AionUI's SQLite is just for rendering the rich UI. They're independent stores of the same conversation.

### Per-CLI resume commands

Each CLI has different flags for terminal-mode resume and ACP-mode resume:

#### Claude Code CLI

| Direction          | Command                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| Rich UI → Terminal | `claude --resume {sessionId}` (or `-r {sessionId}`)                            |
| Terminal → Rich UI | ACP `session/new` with `resumeSessionId` via `_meta.claudeCode.options.resume` |
| ACP flags          | `claude --experimental-acp` (spawned by AionUI's `connectClaude()`)            |

- Session history: `~/.claude/projects/{path-hash}/{sessionId}.jsonl`
- Also supports `--continue` (resume most recent), `--fork-session` (new ID, keep context)

#### GitHub Copilot CLI

| Direction          | Command                                                               |
| ------------------ | --------------------------------------------------------------------- |
| Rich UI → Terminal | `copilot --resume={sessionId}`                                        |
| Terminal → Rich UI | ACP `session/new` with `resumeSessionId`                              |
| ACP flags          | `copilot --acp --stdio` (spawned by AionUI's `spawnGenericBackend()`) |

- Session history: `~/.copilot/session-state/{sessionId}/events.jsonl`
- Also supports `--continue` (resume most recent), `--allow-all-tools --resume` (resume with auto-approval)

#### Codex CLI

| Direction          | Command                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| Rich UI → Terminal | `codex resume --session-id {sessionId}` (subcommand, not flag)             |
| Terminal → Rich UI | ACP `session/load` with `sessionId` (different method from Claude/Copilot) |
| ACP flags          | Spawned via `codex-acp` bridge package                                     |

- Session history: `~/.codex/sessions/YYYY/MM/DD/rollout-{date}-{sessionId}.jsonl`
- Also supports `codex resume --last` (resume most recent)
- Note: Codex uses `session/load` instead of `session/new` with `resumeSessionId` — AionUI already handles this in `AcpConnection.loadSession()`

---

## JSONL → TMessage Converter

When switching Terminal → Rich UI, the content area needs to show conversation history. The CLI's JSONL contains structured data (Anthropic API message format) that maps cleanly to AionUI's `TMessage` types:

### Format mapping

| CLI JSONL (Anthropic API format)                              | AionUI TMessage                                                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `{type: "user", message: {content: "..."}}`                   | `{type: "text", position: "right", content: {content: "..."}}`                                      |
| `{type: "assistant", content: [{type: "text", text: "..."}]}` | `{type: "text", position: "left", content: {content: "..."}}`                                       |
| `{type: "tool_use", name: "Bash", input: {command: "..."}}`   | `{type: "acp_tool_call", content: {update: {title: "Bash", rawInput: {...}, status: "completed"}}}` |
| `{type: "tool_result", content: "output"}`                    | Merged into the tool call's content array                                                           |
| `{type: "thinking", thinking: "..."}`                         | Collapsible thinking section or skip                                                                |

### Implementation

```typescript
// ~400-600 lines per CLI format (includes error handling, streaming state reconstruction, tool_result merging)
function jsonlToTMessages(lines: string[]): TMessage[] {
  // Parse JSONL lines → extract user/assistant/tool messages
  // Map Anthropic API blocks to AionUI TMessage types
  // Merge tool_result into preceding tool_use
  // Return ordered TMessage[] array
}
```

### Performance: background pre-conversion

Conversion cost depends on session size:

| Session size      | Messages | Total time |
| ----------------- | -------- | ---------- |
| 50KB (~30 msgs)   | 30       | ~15ms      |
| 500KB (~150 msgs) | 150      | ~65ms      |
| 2MB (~500 msgs)   | 500      | ~200ms     |
| 5MB (~1000 msgs)  | 1000     | ~500ms     |
| 10MB+ (marathon)  | 2000+    | ~1.2s      |

Most sessions are under 2MB → under 200ms → on-demand is fine. But marathon sessions can exceed 1s.

**Strategy: auto-convert after each response completes.**

When in terminal mode, listen for the CLI's "response finished" signal (end_turn, prompt idle, or PTY output pause). After each response completes, background-convert the latest JSONL content to TMessages and insert into AionUI's SQLite. This way, when user toggles Terminal → Rich UI, messages are already in the database — instant render with no loading delay.

> **🚫 BLOCKER: "Response finished" detection is unreliable in PTY mode — DO NOT implement auto-convert until a spike proves a viable detection method.** There is no ACP signal in terminal mode — detection relies on heuristics like prompt string matching or PTY output idle timeout. These are fragile: programs can suppress prompts, custom PS1 strings vary, and long tool outputs can have natural pauses. **A spike MUST validate a reliable detection approach before building the auto-convert infrastructure.** If the spike fails to find a reliable method, fall back to on-demand conversion only (convert when user toggles to Rich UI). Do not invest in auto-convert plumbing without a proven detection strategy.

This also means AionUI's SQLite stays in sync with the terminal session's progress, even if the user never toggles to Rich UI.

### Reuse across plans

This converter is shared infrastructure — needed by:

- **Terminal toggle** (this plan): render history when switching Terminal → Rich UI
- **Step 2 CLI History Integration**: convert imported CLI sessions to TMessages
- **Step 3 Knowledge Consolidation**: parse JSONL for extraction pipeline

Each CLI needs its own converter (Claude Code, Copilot, Codex have slightly different JSONL schemas), but these live in the shared Session Source Provider from the plan index.

### Rendering quality

- **~90% fidelity** with live ACP: tool call cards, user/assistant bubbles, markdown rendering all work
- **The ~10% gap** (what JSONL cannot reproduce):
  - Intermediate streaming states (partial tool outputs, in-progress indicators)
  - Real-time progress animations (typing indicators, streaming text chunks)
  - ACP-specific metadata that only exists during live streaming (`session/update` incremental fields)
  - `AcpAdapter` streaming merge logic — live ACP merges partial content blocks incrementally; JSONL replay must reconstruct the final state from individual events, which may lose ordering nuances
  - Permission dialog history (JSONL records the outcome but not the dialog flow)
- **Fallback**: if JSONL parsing fails for any reason, render raw text with user/assistant turns separated

---

## Architecture

### No new conversation type needed

The existing ACP conversation type already stores everything needed:

- `conversation.extra.backend` — which CLI (claude, copilot, codex, etc.)
- `conversation.extra.acpSessionId` — session ID for resume
- `conversation.extra.cliPath` — CLI binary path

Add one new field:

- `conversation.extra.currentMode` — `'acp'` | `'terminal'` (which mode is currently active)

### TerminalSessionManager

A dedicated manager for PTY sessions. Does NOT extend `BaseAgentManager` or `ForkTask`.

- **Own lifecycle:** spawn PTY via `node-pty`, handle resize, I/O streaming, shell exit
- **Shared interface:** implements conversation-list interface for sidebar display
- **Clean separation:** PTY logic isolated from ACP agent workers
- **Session registry:** thin registry lets sidebar and cleanup logic query both ACP and terminal managers

Why separate from `BaseAgentManager`: PTY needs resize events, raw I/O, shell exit detection — none of which `ForkTask` provides. Forcing it creates a leaky abstraction.

---

## Dependencies

| Package            | Status                                                      | Notes                             |
| ------------------ | ----------------------------------------------------------- | --------------------------------- |
| `node-pty`         | Already in tree (optional dep of `@office-ai/aioncli-core`) | Promote to direct dependency      |
| `@xterm/xterm`     | **Not installed**                                           | Terminal renderer for the browser |
| `@xterm/addon-fit` | **Not installed**                                           | Auto-resize terminal to container |

---

## UX Design

### Rich UI mode (default)

Normal AionUI chat view — structured messages, tool call cards, input box, workspace sidebar. The header shows:

```
Claude Opus 4.6 (1M context)    [💬 Rich UI | >_ Terminal]    GitHub Copilot
```

### Terminal mode

xterm.js fills the content area. No input box — terminal IS the input. Same header but toggle flipped:

```
Claude Opus 4.6 (1M context)    [💬 Rich UI | >_ Terminal]    GitHub Copilot
```

### Visual flow

```
Toggle Rich UI → Terminal:
┌──────────────────────────────────────┐
│ [header with toggle]                  │
│                                       │
│  $ copilot --resume abc123            │
│  Resuming session...                  │
│  ╭──────────────────────────╮        │
│  │ How can I help you?      │        │
│  ╰──────────────────────────╯        │
│  $ █                                  │
│  (full terminal, type directly)       │
└──────────────────────────────────────┘

Toggle Terminal → Rich UI:
┌──────────────────────────────────────┐
│ [header with toggle]                  │
│                                       │
│  [user bubble] refactor auth module   │
│                                       │
│  [tool card] Read src/auth/index.ts   │
│  [tool card] Edit src/auth/mw.ts      │
│                                       │
│  Here's my plan for refactoring...    │
│                                       │
│  [input box: Send message...]         │
└──────────────────────────────────────┘
```

When toggling Terminal → Rich UI, the full conversation history is rendered from JSONL as rich UI (tool cards, formatted text, etc.). No split view, no faded messages — clean full swap.

---

## Session Persistence

Terminal sessions need a transcript model for the sidebar to show meaningful history.

### Strategy: Append-only plain-text transcript

- Store raw terminal output as plain text (ANSI stripped) alongside the conversation record
- Append chunks as they arrive — same pattern as JSONL, crash-safe
- Location: `{AionUI data dir}/terminal-transcripts/{conversation-id}.txt`
- Sidebar preview: shell name (e.g. `zsh`, `bash`) or user-provided label. Do NOT try to extract "first user command" from PTY output — command echo is unreliable (programs can disable it, prompts vary wildly). A static label is simple and always correct.
- Search: grep over transcript files (Phase 1), SQLite FTS5 index later

### What NOT to store

- Raw ANSI escape codes (not useful for search/display, inflate size)
- TUI screen state (vim, htop, etc.) — these are ephemeral by nature
- Keystroke-level input (just the output stream is sufficient)

---

## Settings

### New "AgentCLI" tab in Settings

Add an **AgentCLI** tab to Settings (alongside Model, Agent, Tools, etc.). Route: `/settings/agent-cli`.

**Storage:** `ConfigStorage` key `'agentCli.config'` in `IConfigStorageRefer`:

```typescript
'agentCli.config': {
  defaultMode?: 'acp' | 'terminal';  // Default transport for new conversations (default: 'acp')
  shell?: string;                     // Override default shell (default: auto-detect)
  fontSize?: number;                  // Terminal font size (default: 14)
};
```

**Settings page contents:**

- **Default conversation mode** — segmented control: `💬 Rich UI (ACP)` | `>_ Terminal`. Applies to all new conversations regardless of agent.
- **Shell** — text input with auto-detected default shown as placeholder (e.g., `/bin/zsh`). Override for users who want a different shell.
- **Font size** — number input or slider for terminal font size.
- Note: "You can switch modes anytime using the toggle in the chat header."

**Wire-in:**

- `src/renderer/pages/settings/AgentCliSettings.tsx` — new page component
- `src/renderer/components/settings/SettingsModal/contents/AgentCliModalContent.tsx` — form content
- `src/renderer/pages/settings/components/SettingsSider.tsx` — add "AgentCLI" nav item (after "Agent" or "Tools")
- `src/renderer/components/layout/Router.tsx` — add `/settings/agent-cli` route
- `src/common/config/storage.ts` — add `'agentCli.config'` to `IConfigStorageRefer`
- `src/renderer/services/i18n/locales/*/settings.json` — add i18n keys

---

## Cross-Platform Considerations

- **Shell detection:** Use `process.env.SHELL` on macOS/Linux, `process.env.COMSPEC` on Windows
- **PTY behavior:** `node-pty` abstracts most differences, but terminal size, signal handling, and shell init files vary
- **Default shell:** macOS=zsh, Linux=bash, Windows=PowerShell/cmd
- **Path separators:** Not relevant for PTY (shell handles it), but matters for transcript storage paths

---

## New Files

1. **`src/renderer/pages/conversation/terminal/TerminalComponent.tsx`** (~100-150 lines)
   - React wrapper around xterm.js
   - Mount/unmount lifecycle, resize observer
   - Connects `xterm.onData → IPC → pty.write` (keyboard to CLI)
   - Connects `pty.onData → IPC → xterm.write` (CLI output to screen)

2. **`src/process/task/TerminalSessionManager.ts`** (~150-200 lines)
   - Separate from `BaseAgentManager` (does not extend `ForkTask`)
   - Spawns CLI via `node-pty` with `--resume {sessionId}`
   - Manages PTY lifecycle (start, resize, stop)
   - IPC bridge for stdin/stdout between renderer and main process

3. **`src/process/cli-history/converters/`** (~400-600 lines per CLI)
   - `claude.ts` — Claude Code JSONL → TMessage[]
   - `copilot.ts` — Copilot JSONL → TMessage[]
   - Shared with Step 2 (CLI History Import) and Step 3 (Knowledge Consolidation)
   - Complexity drivers: tool_result merging into preceding tool_use, streaming state reconstruction, error handling for malformed JSONL lines, AcpAdapter streaming merge logic reproduction

4. **Wire-in changes** (~50-80 lines across existing files)
   - `src/common/config/storage.ts` — add `currentMode` to ACP extra type
   - `src/renderer/pages/conversation/components/ChatConversation.tsx` — render terminal or ACP based on `currentMode`
   - `src/renderer/pages/conversation/platforms/acp/AcpChat.tsx` — add mode toggle to header
   - Settings page — add default mode setting

---

## Done Means

- [ ] Mode toggle (`💬 Rich UI | >_ Terminal`) visible in chat header
- [ ] Toggle Rich UI → Terminal: kills ACP, spawns PTY with `--resume`, xterm.js renders
- [ ] Toggle Terminal → Rich UI: kills PTY, reconnects ACP with `resumeSessionId`, renders rich UI
- [ ] JSONL → TMessage converter: Terminal → Rich UI shows full conversation history as rich UI (tool cards, formatted text)
- [ ] Default mode setting in Settings page
- [ ] xterm.js renders with working keyboard input, resize, Ctrl+C
- [ ] PTY lifecycle: clean stop on conversation close, no orphan processes
- [ ] PTY orphan cleanup: on app launch, detect and kill orphaned PTY processes from previous crashes
- [ ] **PREREQUISITE**: "Response finished" detection spike completed — either a reliable method is proven OR on-demand-only fallback is accepted. Do NOT build auto-convert without this.
- [ ] Session transcript persisted for sidebar preview and search
