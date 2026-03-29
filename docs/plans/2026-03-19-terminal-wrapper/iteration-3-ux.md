# Terminal Wrapper Mode — Iteration 3 UX Improvements

**Date:** 2026-03-28
**Branch:** `feat/terminal-wrapper-mode`
**Parent plan:** [plan.md](./plan.md)

---

## Context

Three UX improvements identified during remote/mobile testing of the terminal wrapper feature.

---

## Fix 1: Show Thinking toggle on Rich UI chat page

**Problem:** The "Show Thinking" toggle only exists in the Terminal Wrapper settings page (`AgentCliModalContent.tsx`). Users must navigate away from their conversation to toggle it — disruptive, especially on mobile.

**Current state:**

- Setting stored in `ConfigStorage` at `agentCli.config.showThinking` (boolean, default `false`)
- Read by `cliHistoryBridge.ts:216` during JSONL → TMessage conversion
- Only affects converted messages from Terminal → Rich UI switch
- Setting page: `AgentCliModalContent.tsx` uses an Arco `Switch`

**Fix: Compact icon toggle in the chat header, next to ModeToggle**

Add a `Brain` icon toggle button (already used in `GuidModelSelector.tsx`) in the `headerExtraNode` of `ChatConversation.tsx` (line 325-353), right next to the existing `ModeToggle` wrapper.

**Behavior:**

- Only visible on ACP conversations (same condition as ModeToggle: `conversation?.type === 'acp'`)
- Icon: `Brain` from `@icon-park/react` — filled when enabled, outline when disabled
- Include `aria-label` for accessibility (don't rely on icon state alone)
- On click: toggle `agentCli.config.showThinking` in ConfigStorage
- **Future conversions only** — the toggle affects the next Terminal → Rich UI switch, NOT already-imported messages. Re-conversion on toggle would duplicate messages (DB inserts are append-only with fresh UUIDs per import). A proper reimport path would require deleting then re-inserting — out of scope for this iteration.
- Tooltip on desktop: "Show agent thinking (applies on next import)" / i18n key: `conversation.header.showThinking`
- Note: this writes the **global** `agentCli.config.showThinking` setting; tooltip should make this clear

**Changes:**

- `src/renderer/pages/conversation/components/ChatConversation.tsx` (lines 325-353):
  - Add `Brain` icon toggle in `headerExtraNode`, adjacent to ModeToggle
  - Add local state `showThinking` initialized from ConfigStorage on mount
  - On toggle: save to ConfigStorage, mutate state

- i18n: Add `conversation.header.showThinking` and `conversation.header.showThinkingTooltip` keys (6 locale files)
- Regenerate `i18n-keys.d.ts`

**Scope:** Small — 1 component file + 6 locale files

---

## Fix 2: Start in Terminal toggle on new chat page

**Problem:** When creating a new conversation from the guide page, there's no way to choose terminal mode — it always uses the default from settings (`agentCliConfig.defaultMode`). Users who frequently switch between modes must change the global default each time.

**Current state:**

- `useGuidSend.ts:322-323` reads `agentCliConfig?.defaultMode ?? 'acp'`
- Passes it as `extra.currentMode` to `conversation.create` at line 342
- No UI override on the guide page

**Fix: Terminal icon toggle button in GuidActionRow**

Add a compact toggle button with terminal icon (`TerminalCmd` or `Code` from `@icon-park/react`) in the action row of `GuidActionRow.tsx`, positioned between the agent mode selector and the send button.

**Behavior:**

- Default state: read from `agentCliConfig.defaultMode` on mount (respects global preference)
- Toggle is local React state — changing it does NOT save back to global config (per-send override only)
- When active (terminal mode): icon uses primary color fill, subtle background highlight
- When inactive (Rich UI mode): icon uses secondary color, no background
- Tooltip on desktop: "Start in terminal" / "Start in Rich UI"
- Visibility should follow the **actual conversation type that will be created** — `useGuidSend` can reroute presets and fallback to Gemini, so check the resolved agent type, not just the selected pill. Hide for Gemini and non-ACP backends.
- The selected state is passed to `useGuidSend` which uses it as `extra.currentMode` instead of the global default
- Note: terminal-first chats start without `--resume` if no `acpSessionId` exists yet — this is the existing TerminalChat behavior and is correct for new conversations

**Changes:**

- `src/renderer/pages/guid/components/GuidActionRow.tsx`:
  - Add terminal icon toggle button in the action tools area (near send button)
  - Accept `terminalMode` and `onTerminalModeChange` props

- `src/renderer/pages/guid/GuidPage.tsx`:
  - Add `terminalMode` state, initialized from `agentCliConfig.defaultMode`
  - Pass to GuidActionRow and useGuidSend

- `src/renderer/pages/guid/hooks/useGuidSend.ts` (line 322):
  - Accept `terminalModeOverride` parameter
  - Use it instead of reading `agentCliConfig.defaultMode` when provided

- i18n: Add `conversation.welcome.startInTerminal` and `conversation.welcome.startInRichUi` keys (6 locale files)
- Regenerate `i18n-keys.d.ts`

**Scope:** Small — 3 files + 6 locale files

---

## Fix 3: Tooltip auto-dismiss on mobile (ModeToggle)

**Problem:** On mobile, tapping the ModeToggle radio buttons triggers the Arco `Tooltip` (which defaults to `trigger='hover'`). Since mobile has no "mouse leave" event, the tooltip stays visible until the user taps elsewhere — feels broken.

**Current state:**

- `ModeToggle.tsx:89`: `<Tooltip position='bottom' content={...}>` with no `trigger` or `disabled` prop
- Codebase has established pattern: `disabled={isMobile}` using `useLayoutContext()`
- Used in `GuidInputCard.tsx`, `ConversationRow.tsx`, and others

**Fix: Disable tooltip on mobile**

Add `disabled={isMobile}` to the Tooltip in `ModeToggle.tsx`, using `useLayoutContext()`.

**Changes:**

- `src/renderer/pages/conversation/platforms/terminal/ModeToggle.tsx`:
  - Import `useLayoutContext` from `@renderer/hooks/context/LayoutContext`
  - Add `const layout = useLayoutContext(); const isMobile = layout?.isMobile ?? false;`
  - Add `disabled={isMobile}` to the `<Tooltip>` component

**Scope:** Minimal — 3 lines in 1 file

---

## Implementation Order

1. **Fix 3** (tooltip) — 3 lines, independent, immediate UX improvement
2. **Fix 2** (start in terminal) — small, self-contained in guide page
3. **Fix 1** (show thinking toggle) — involves re-conversion logic, slightly more complex

---

## GPT Review Summary

**Reviewed:** 2026-03-28 via GPT-5.4

**Key corrections applied:**

1. **Fix 1 re-conversion would duplicate messages** — DB inserts are append-only with fresh UUIDs per import. Reduced scope: toggle affects future conversions only, not already-imported messages.
2. **Fix 1 global vs local semantics** — header toggle writes global config but feels conversation-local. Tooltip must clarify it's a global import preference.
3. **Fix 2 agent visibility** — "ACP-compatible" is trickier than checking agent type. `useGuidSend` can reroute presets/fallback to Gemini. Visibility must follow the resolved conversation type.
4. **Fix 2 terminal-first path** — TerminalChat starts without `--resume` when no `acpSessionId` exists. This is correct for new conversations.
5. **Brain icon** — acceptable but add `aria-label` and tooltip; don't rely on filled/outline alone for state.
6. **Fix 3** — no objections. `disabled={isMobile}` matches established patterns.

---

## Done means

- [x] Brain icon toggle in chat header toggles showThinking (affects future imports)
- [x] Radio.Group "Rich UI | Terminal" on guide page overrides default mode for new conversations
- [x] ModeToggle tooltip auto-dismisses on mobile (disabled on touch devices)
- [x] All new i18n keys added for 6 languages
- [x] `bunx tsc --noEmit` passes
- [x] `bun run test` passes
- [x] `i18n-keys.d.ts` regenerated
