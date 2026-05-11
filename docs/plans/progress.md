# AionUI Enhancement Progress

**Last updated:** 2026-05-10

Quick status of each step in the [plan index](./2026-03-19-plan-index.md).

---

## Overview

| Step | Feature                 | Status         | PRs    |
| ---- | ----------------------- | -------------- | ------ |
| 0.5  | Copy Chat Reference     | Done           | #2     |
| 1    | Terminal Wrapper Mode   | Done           | #5, #9 |
| 2    | CLI History Integration | Partially done | #5     |
| 3    | Knowledge Consolidation | Not started    | —      |

---

## Step 0.5: Copy Chat Reference — Done

"Copy Chat Reference" in conversation `...` menu. 3-tier resolution: imported CLI sessions (JSONL path), ACP sessions (resolved via backend), fallback (`aionui:{id} @ {dbPath}`).

**Key files:** `ConversationRow.tsx`, `useConversationActions.ts`, `cliHistoryBridge.ts`

---

## Step 1: Terminal Wrapper Mode — Done

All 3 iterations complete:

- **Core:** xterm.js rendering, `TerminalSessionManager` (node-pty), mode toggle (`Rich UI | Terminal`), PTY detach/reattach, orphan cleanup
- **Converters:** Claude Code and Copilot JSONL → TMessage converters for Terminal → Rich UI switch
- **Settings:** AgentCLI settings tab (default mode, font size, show thinking, max sessions, Copilot Gateway)
- **Iteration 2:** Remote access fixes, mobile improvements
- **Iteration 3:** Brain icon show-thinking toggle in chat header, terminal mode toggle on guide page, mobile tooltip auto-dismiss

**Key files:** `TerminalComponent.tsx`, `TerminalSessionManager.ts`, `ModeToggle.tsx`, `AgentCliModalContent.tsx`, `converters/claude.ts`, `converters/copilot.ts`

---

## Step 2: CLI History Integration — Partially Done

### Done (shared infrastructure)

- `SessionSourceProvider` type + `BaseSessionSourceProvider` abstract class
- Claude Code provider — discovers sessions via `~/.claude/projects/*/sessions-index.json`
- Copilot provider — discovers sessions via `~/.copilot/session-store.db`
- JSONL → TMessage converters (reused from Step 1)
- Session path resolution for Claude, Copilot, Codex

### Done (Phase 1 — metadata index)

- Import orchestrator — `discoverAndImport(source)` writes `conversations` rows for each CLI session (no message hydration yet)
- Per-source operation chain — disable/re-enable cannot race a scan
- Settings UI — per-CLI import toggles for Claude Code + Copilot under Settings → AgentCLI
- Incremental sync on app launch — `initCliHistoryImporter()` runs `discoverAndImportAll()` for enabled sources
- Soft disable / re-enable — `extra.importMeta.hidden` flag, with `getUserConversations` filter
- Deduplication by `source + acpSessionId` (fallback `source + sourceFilePath`)
- Source-aware auto-naming (Claude Code → `firstPrompt`; Copilot → `summary`/`title`); rename-preserving on re-sync via `generatedName` snapshot

**Key files:** `src/process/cli-history/importer.ts` (orchestrator), `src/process/bridge/conversationEvents.ts` (extracted listChanged emitter), `src/process/bridge/cliHistoryBridge.ts` (4 new IPC handlers), `src/process/services/database/index.ts` (hidden filter + importer-private DB methods), `src/renderer/components/settings/SettingsModal/contents/AgentCliModalContent.tsx` (toggles)

### Done (Phase 2 — on-demand message hydration)

- `hydrateSession(conversationId, options?)` — reads source JSONL, converts via existing converters, batch-replaces `messages` rows inside one SQLite transaction
- mtime-bound cache: `extra.hydratedAt` (source mtimeMs) + `extra.hydratedSourceFilePath` invalidate on file move or content change
- In-flight coalescing keyed by `conversationId` — concurrent open + export share one read+parse+insert pass
- Source-missing / unreadable / post-stat-race handling — surfaces as `{ status: 'unavailable' | 'cached', warning: 'source_missing' }` rather than throwing
- Corrupted-JSONL handling — skips malformed lines, returns `warningCount`
- Phase 2 title upgrade — replaces relative-time / generic fallback titles with the first user message, never downgrades a meaningful provider title, never overrides a manual rename
- IPC route `cli-history.hydrate` (forwards optional `showThinking`)

**Key files (Phase 2):** `src/process/cli-history/importer.ts` (hydrateSession + helpers), `src/process/services/database/index.ts` (getMessageCountForConversation + insertImportedMessages atomic replace), `src/common/config/storage.ts` (hydratedAt + hydratedSourceFilePath fields), `src/common/adapter/ipcBridge.ts` + `src/process/bridge/cliHistoryBridge.ts` (hydrate IPC route)

### Not started (Phase 3 and beyond)

- Transcript-mode UI for imported sessions (skeleton loading, read-only messages, "Resume this session" button)
- Background message conversion (newest-first)
- Sidebar integration — imported sessions visible in timeline with source badges
- Resume support for imported sessions
- Delete behavior (remove from AionUI only, preserve CLI files)
- Sidebar truncation / filter / search
- Full-history view page

**Plan:** [`2026-03-19-cli-history/plan.md`](./2026-03-19-cli-history/plan.md) (parent design) · [`2026-03-19-cli-history/importer-phase1.md`](./2026-03-19-cli-history/importer-phase1.md) (Phase 1 implementation plan) · [`2026-03-19-cli-history/importer-phase2.md`](./2026-03-19-cli-history/importer-phase2.md) (Phase 2 implementation plan)

---

## Step 3: Knowledge Consolidation — Not Started

5-step pipeline: scan → extract → daily synthesis → library update → weekly synthesis. Lives in claude-toolkit as a `/consolidate` skill, not in AionUI. Plan is complete; no code yet.

**Plan:** [`2026-03-19-personal-knowledge-consolidation.md`](./2026-03-19-personal-knowledge-consolidation.md)

---

## Backlog

See [`backlog.md`](./backlog.md) for deferred items:

- Auto-convert JSONL in background (blocked — needs spike)
- Shared `useAgentCliConfig()` hook (low priority)
- Temp file cleanup for paste/drag attachments (low priority)
