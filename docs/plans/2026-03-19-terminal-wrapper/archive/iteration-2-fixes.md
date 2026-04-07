# Terminal Wrapper Mode — Iteration 2 Fixes

**Date:** 2026-03-25
**Status:** Implemented
**Branch:** `feat/terminal-wrapper-mode`
**Parent plan:** [plan.md](./plan.md)

---

## Context

Manual testing revealed issues with the Terminal → Rich UI JSONL conversion and UX gaps in the mode toggle. These 4 fixes address the findings.

---

## Fix 1: Use `terminalSwitchedAt` timestamp for JSONL import boundary

**Problem:** When converting JSONL to TMessages on Terminal → Rich UI toggle, comparing against the latest DB message timestamp causes duplicates. The JSONL and AionUI SQLite record the same messages with slightly different timestamps (CLI vs AionUI clocks), so "newer than latest DB" doesn't reliably deduplicate.

**Fix:** Record the timestamp when the user switches to terminal mode in `conversation.extra.terminalSwitchedAt`. When converting back, only import JSONL messages with timestamps strictly after `terminalSwitchedAt`. This creates a clean boundary: "only import messages that happened during the terminal session."

**Changes:**

- `storage.ts`: Add `terminalSwitchedAt?: number` to ACP conversation extra type
- `ModeToggle.tsx`: When switching ACP → Terminal, save `Date.now()` as `terminalSwitchedAt` in conversation extra
- `cliHistoryBridge.ts`: Accept `terminalSwitchedAt` parameter instead of querying latest DB message. Filter converted messages by `createdAt > terminalSwitchedAt`.
- `ipcBridge.ts`: Add `terminalSwitchedAt` to `convertSessionToMessages` params
- Edge cases: handle missing timestamps in JSONL (converter's `extractTimestamp()` falls back to `Date.now()`); kill PTY before import to avoid reading a partially-written JSONL

---

## Fix 2: Skip thinking blocks in JSONL converter

**Problem:** The Claude converter wraps thinking blocks in `<details><summary>Thinking</summary>` HTML, which renders as raw text in AionUI's markdown renderer. Both ACP mode and Claude Code CLI hide thinking blocks by default — converting them into visible messages is inconsistent.

**Fix:** Skip thinking blocks entirely in the converter. Change `case 'thinking'` to just `break` instead of creating a message.

**Changes:**

- `src/process/cli-history/converters/claude.ts`: Remove the thinking block rendering code (lines 319-330), replace with `break`
- `src/process/cli-history/converters/copilot.ts`: Check if copilot converter has similar thinking handling and skip if so

---

## Fix 3: Show Thinking toggle with collapsible rendering

**Problem:** Users may want to see thinking/reasoning content. Currently thinking blocks are hidden in both ACP and terminal modes. The converter wraps them in `<details>` HTML which renders as raw text.

**Fix:** Add a "Show Thinking" toggle in the Terminal settings page. When enabled, thinking blocks from JSONL conversion are included as collapsible sections using the existing `AionCollapse` component pattern. When disabled (default), thinking blocks are skipped entirely (Fix 2 behavior).

**Changes:**

- `storage.ts`: Add `showThinking?: boolean` to `agentCli.config`
- `AgentCliModalContent.tsx`: Add "Show Thinking" toggle (Arco `Switch` component)
- `claude.ts` converter: Accept `showThinking` option. When true, create a text message with thinking content wrapped in a markdown blockquote format (`> **Thinking**\n> content...`) that renders cleanly in the existing markdown renderer. When false, skip thinking blocks entirely.
- `copilot.ts` converter: Same — check for thinking blocks and apply same logic
- `cliHistoryBridge.ts`: Read `showThinking` from config and pass to converter
- i18n: Add `settings.terminalWrapper.showThinking` and `settings.terminalWrapper.showThinkingDesc` keys for all 6 languages
- Regenerate `i18n-keys.d.ts`

**Note:** This only affects JSONL-converted messages (Terminal → Rich UI). ACP streaming thinking blocks are a separate concern — out of scope.

---

## Fix 4: Mode toggle tooltip explaining Rich UI vs Terminal differences

**Problem:** Users may not understand the behavioral differences between Rich UI and Terminal modes, especially around chat history display.

**Fix:** Add a tooltip on the mode toggle that explains the difference.

**Changes:**

- `ModeToggle.tsx`: Wrap the `Radio.Group` in an Arco `Tooltip` component
- Tooltip content: Brief explanation that Rich UI shows full message history with modern UI, while Terminal provides native CLI experience where history display follows CLI behavior
- i18n: Add `settings.terminalWrapper.modeTooltip` key for all 6 languages

---

## Done means

- [x] Switching ACP → Terminal → ACP no longer duplicates messages
- [x] Thinking blocks don't appear as raw `<details>` HTML in Rich UI
- [x] "Show Thinking" toggle in Terminal settings controls thinking visibility
- [x] Hovering on mode toggle shows tooltip explaining the difference
- [x] All 6 languages have new i18n keys
- [x] `bunx tsc --noEmit` passes
- [x] `bun run test` passes
- [x] `i18n-keys.d.ts` regenerated
