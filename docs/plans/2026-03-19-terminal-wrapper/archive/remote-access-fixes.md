# Terminal Wrapper — Remote Access Fixes

**Date:** 2026-03-28
**Status:** Implemented
**Branch:** `feat/terminal-wrapper-mode`
**Parent plan:** [plan.md](../plan.md)

---

## Context

When AionUI is accessed remotely from a mobile browser via Tailscale (HTTP over `100.102.140.31`), three issues were found:

1. **Copy failed** — clipboard copy shows error toast
2. **Terminal mode blank** — switching to terminal shows blank black screen
3. **Mode toggle stuck** — clicking "Rich UI" after terminal mode does nothing

---

## Architecture Analysis

### Why Remote Should Work (In Theory)

The main process adapter (`src/common/adapter/main.ts`) is a **dual-transport fan-out** — every `bridge.emit()` sends to both Electron BrowserWindows AND all WebSocket clients. The entire `pty.*` namespace (spawn, write, resize, kill, output, exit, detach, reattach) flows through the same `bridgeEmitter` as Electron IPC. This is architecturally identical to how ttyd/wetty/VS Code Remote work.

### Transport Verification (Confirmed by Review)

The bridge runtime uses `subscribe-...` / `subscribe.callback-...` event names for `invoke()`/provider round-trips. The WebSocket layer forwards arbitrary event names, so **invoke/callback semantics are preserved over WebSocket**. This is not an architectural limitation — PTY over remote genuinely works at the transport level.

### What's Actually Broken

The failures are **client-side bugs**, not transport or architectural limitations. The two strongest hypotheses are:

1. **Zero-dimension spawn**: `FitAddon.fit()` can yield `0` cols/rows on mobile before layout stabilizes. `TerminalSessionManager.spawn()` only defaults `undefined` dimensions, not `0` — so a PTY spawns with `0x0`, producing no visible output.
2. **WebGL failure on mobile**: `WebglAddon` may fail silently on mobile Safari/HTTP. xterm.js has a built-in canvas renderer, but WebGL failure during init could leave the terminal in a broken state.

---

## Fix 1: Clipboard Copy on Insecure Context

**Problem:** `navigator.clipboard.writeText()` requires a secure context (HTTPS or localhost). Over plain HTTP via Tailscale IP, `window.isSecureContext === false`. The fallback `document.execCommand('copy')` is deprecated and fails silently on mobile browsers.

**File:** `src/renderer/utils/ui/clipboard.ts`

**Current behavior:**

1. Check `navigator.clipboard && window.isSecureContext` → fails (HTTP)
2. Fall back to `document.execCommand('copy')` → fails on mobile Safari/Chrome
3. Error thrown → "Copy failed" toast

**Fix approach — two-tier:**

### Tier 1: Recommend Tailscale HTTPS (documentation/config)

`tailscale cert <hostname>.ts.net` provides free, browser-trusted TLS certs. Accessing via `https://<hostname>.ts.net:port` restores secure context and makes `navigator.clipboard` work natively. This is the proper long-term solution.

- Add a note in settings or docs about remote access HTTPS setup
- No code changes needed for this tier

### Tier 2: Graceful degradation in code

When clipboard API is unavailable and `execCommand` fails, show a selectable text modal instead of an error toast. The user can then long-press to copy on mobile.

**Changes:**

- `src/renderer/utils/ui/clipboard.ts`:
  - Keep existing two-step logic (navigator.clipboard → execCommand)
  - When both fail, instead of throwing, return a `{ fallback: true, text: string }` result
  - Or: export a `canCopyProgrammatically()` check function

- Call sites (`CodeBlock.tsx`, `MessageText.tsx`, `useConversationActions.ts`):
  - When `copyText` fails, show a small modal/popover with the text pre-selected
  - User can long-press → "Select All" → "Copy" on mobile
  - Dismiss on tap outside

**Scope:** Small — 1 utility file + 3-4 call sites with fallback UI

---

## Fix 2: Terminal Mode Blank on Remote

**Problem:** Switching to terminal mode over WebSocket shows a blank black screen. The PTY data path (spawn → output → xterm.js) should work over WebSocket per architecture analysis, but something fails silently.

**Investigation plan (before coding):**

### Step 1: Identify the failure point

Add temporary diagnostic logging to trace the exact failure:

1. **WebSocket connection** — is the socket connected when terminal mode is toggled?
   - Check: `browser.ts` socket state at toggle time
   - Check: server-side WebSocket message handler receives `pty.spawn`

2. **PTY spawn** — does `pty.spawn` reach `TerminalSessionManager.spawn()`?
   - Check: server logs for `[TerminalSessionManager] Spawning PTY` message
   - Check: does `pty.spawn` invoke handler return result to WebSocket client?

3. **PTY output** — does `pty.output.emit()` reach the WebSocket broadcast?
   - Check: `main.ts` adapter `emit()` — does it broadcast `pty.output` events?
   - Check: `browser.ts` — does `emitterRef.emit('pty.output', data)` fire?

4. **xterm.js rendering** — does the terminal render on mobile?
   - Check: WebGL addon may fail on mobile Safari (no WebGL2 in some contexts)
   - Check: container `div` has non-zero dimensions on mobile layout

### Step 2: Likely fixes based on investigation

**Hypothesis A: Zero-dimension PTY spawn (HIGHEST PROBABILITY)**

- `FitAddon.fit()` runs immediately after `terminal.open()` before mobile layout stabilizes
- If container has 0px dimensions → `fit()` yields 0 cols/rows
- `TerminalSessionManager.spawn()` defaults: `cols = 80, rows = 24` — but only for `undefined`, NOT for `0`
- PTY spawns with `0x0` terminal → no visible output → blank screen
- **Fix:** Guard against zero dimensions — clamp `cols` and `rows` to minimum values (e.g., 80x24) in both `TerminalComponent` (before invoke) and `TerminalSessionManager.spawn()` (server-side safety net). Add a short `requestAnimationFrame` or `setTimeout` delay before first `fit()` on mobile to let layout settle.

**Hypothesis B: WebGL fails on mobile Safari**

- `WebglAddon` requires WebGL2 which may not be available on mobile Safari or in non-secure HTTP contexts
- Current code catches the error silently (line 88-90) — xterm.js has a built-in canvas renderer that should take over
- However, a partial WebGL init failure could leave the renderer in a broken state
- **Fix:** Skip `WebglAddon` entirely on mobile/touch devices (`'ontouchstart' in window` or `navigator.maxTouchPoints > 0`). The canvas renderer is sufficient for remote mobile use.

**Hypothesis C: IPC invoke timeout or silent failure (LOWER PROBABILITY)**

- GPT review confirmed that `invoke()`/provider callback semantics ARE preserved over WebSocket (uses `subscribe-...`/`subscribe.callback-...` event name pattern)
- Transport-level failure is unlikely — but add client-side logging of `pty.spawn` result for diagnostics
- **Fix:** Log `pty.spawn` invoke result and any errors in `TerminalComponent`. Add a visible error message if spawn returns `success: false`.

### Step 3: Implement fixes

Based on investigation results, apply targeted fixes. Expected changes:

- `TerminalComponent.tsx`: Add mobile detection, skip WebGL, add dimension check, add error feedback
- `ModeToggle.tsx`: Replace `.catch((): null => null)` with proper error handling + toast
- Possibly `ChatConversation.tsx`: Ensure container has minimum dimensions on all viewports

**Scope:** Medium — depends on investigation results. Core fix likely 2-3 files.

---

## Fix 3: Mode Toggle Stuck (Terminal → Rich UI)

**Problem:** After switching to terminal mode (which shows blank), clicking "Rich UI" button doesn't switch back.

**Root cause:** Independent from Fix 2 (not just a side-effect of blank terminal). The `ModeToggle.handleToggle()` blocks the UI switch on a sequential chain:

```
pty.kill → conversation.get → cliHistory.convertSessionToMessages → conversation.update → onModeChange
```

The bottleneck is `convertSessionToMessages` which reads and parses the CLI session log — this can be slow. The UI switch (`onModeChange`) only fires AFTER all steps complete. If any step is slow or fails silently (`.catch((): null => null)`), the toggle appears stuck. The `conversation.update` return value is also not checked.

**Fix approach:**

1. **Decouple mode persistence from PTY cleanup** — update mode state first (optimistic), then do PTY cleanup in background
2. **Add timeouts to IPC calls** — if `pty.kill` doesn't respond in 3s, proceed anyway
3. **Replace silent catch with error toast** — `.catch((err) => { showToast(err); return null; })`
4. **Ensure `onModeChange(mode)` always fires** — even if IPC calls fail, the UI should switch

**Changes:**

- `ModeToggle.tsx`: Restructure `handleToggle` to be resilient:
  ```
  1. onModeChange(mode)  ← immediate UI switch
  2. conversation.update  ← persist mode
  3. pty.kill + convert   ← background cleanup (failures logged, not blocking)
  ```

**Scope:** Small — single file restructure of `handleToggle`

---

## Implementation Order

1. **Fix 2 (terminal blank)** — add zero-dimension guards + skip WebGL on mobile. These are concrete, targeted fixes that address the highest-probability root causes. Add client-side diagnostic logging to confirm.
2. **Fix 3 (mode toggle)** — decouple UI switch from background cleanup. Independent fix, but testing is easier once terminal mode works.
3. **Fix 1 (clipboard)** — independent, can be done in parallel. Build a shared `useCopyFallback` hook for the selectable-text modal.

---

## Out of Scope (Noted for Future)

- **PTY output broadcast routing**: Currently `pty.output` broadcasts to ALL WebSocket clients. For multi-device usage, per-client routing (associate PTY session with specific WebSocket connection) would be needed. ~20-30 lines change in `WebSocketManager` + `TerminalSessionManager`. Not a blocker for single-user Tailscale access.
- **HTTPS setup guide**: Documentation for `tailscale cert` setup with AionUI. Would be a helpful addition to project docs.
- **Broader clipboard audit**: Other places in the codebase may call `navigator.clipboard.writeText` directly (outside of `copyText` utility). A full audit of insecure-context clipboard surfaces should be done to ensure consistency.

---

## GPT Review Summary

**Reviewed:** 2026-03-28 via GPT-5.4

**Key corrections applied:**

1. **Transport is confirmed working** — bridge runtime uses `subscribe-...`/`subscribe.callback-...` for invoke/callback over WebSocket. The blank terminal is NOT a transport issue.
2. **Zero-dimension spawn elevated to primary hypothesis** — `TerminalSessionManager.spawn()` only defaults `undefined` dimensions, not `0`. Mobile layout timing can yield `0x0` from `FitAddon.fit()`.
3. **Mode toggle is independent** — the stuck toggle doesn't require PTY transport failure. The real issue is sequential blocking: `convertSessionToMessages` (slow I/O) blocks `conversation.update` and `onModeChange`. The plan's decoupling proposal is confirmed as the right fix.
4. **Implementation order revised** — terminal fixes first (concrete, testable), then mode toggle (independent), then clipboard (parallel).
