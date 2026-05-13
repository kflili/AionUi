# AionUI Enhancement Progress

**Last updated:** 2026-05-12

Quick status of each step in the [plan index](./2026-03-19-plan-index.md).

---

## Overview

| Step | Feature                 | Status                                           | PRs                                                                      |
| ---- | ----------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| 0.5  | Copy Chat Reference     | Done                                             | #2                                                                       |
| 1    | Terminal Wrapper Mode   | Done                                             | #5, #9                                                                   |
| 2    | CLI History Integration | Done — items 0–9 shipped + 4 post-recovery fixes | #5, #17, #18, #19, #20, #21, #22, #23, #24, #25, #26, #27, #28, #29, #30 |
| 3    | Knowledge Consolidation | Not started                                      | —                                                                        |

Layout: PR #31 (`feat(layout): make the global left sidebar draggable to resize`) shipped during the same orchestration window but is NOT cli-history scope — it is a standalone layout feature mentioned here for traceability; no separate plan doc was created.

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

## Step 2: CLI History Integration — Done

All 10 cli-history items (0–9) shipped via PRs #17–#26, plus 4 post-recovery fix PRs (#27–#30). The orchestration run log is at `~/orchestration-experiments/aionui-cli-history-2026-05-10/MASTER-LOG.md`.

### Done (shared infrastructure)

- `SessionSourceProvider` type + `BaseSessionSourceProvider` abstract class
- Claude Code provider — discovers sessions via `~/.claude/projects/*/sessions-index.json`
- Copilot provider — discovers sessions via `~/.copilot/session-store.db`
- JSONL → TMessage converters (reused from Step 1)
- Session path resolution for Claude, Copilot, Codex

### Done (item 0 — useAgentCliConfig() hook — PR #17)

- Shared `useAgentCliConfig()` hook in `src/renderer/hooks/useAgentCliConfig.ts`. Replaces the 9 ad-hoc `ConfigStorage.get('agentCli.config')` call sites with one read+subscribe pattern. Originally tracked in `backlog.md` as low-priority cleanup; landed early as the orchestration smoke-test refactor.

### Done (item 1 — Phase 1 metadata index — PR #18)

- Import orchestrator — `discoverAndImport(source)` writes `conversations` rows for each CLI session (no message hydration yet)
- Per-source operation chain — disable/re-enable cannot race a scan
- Settings UI — per-CLI import toggles for Claude Code + Copilot under Settings → AgentCLI
- Incremental sync on app launch — `initCliHistoryImporter()` runs `discoverAndImportAll()` for enabled sources
- Soft disable / re-enable — `extra.importMeta.hidden` flag, with `getUserConversations` filter
- Deduplication by `source + acpSessionId` (fallback `source + sourceFilePath`)
- Source-aware auto-naming (Claude Code → `firstPrompt`; Copilot → `summary`/`title`); rename-preserving on re-sync via `generatedName` snapshot

**Key files:** `src/process/cli-history/importer.ts` (orchestrator), `src/process/bridge/conversationEvents.ts` (extracted listChanged emitter), `src/process/bridge/cliHistoryBridge.ts` (4 new IPC handlers), `src/process/services/database/index.ts` (hidden filter + importer-private DB methods), `src/renderer/components/settings/SettingsModal/contents/AgentCliModalContent.tsx` (toggles)

### Done (item 2 — Phase 2 on-demand message hydration — PR #19)

- `hydrateSession(conversationId, options?)` — reads source JSONL, converts via existing converters, batch-replaces `messages` rows inside one SQLite transaction
- mtime-bound cache: `extra.hydratedAt` (source mtimeMs) + `extra.hydratedSourceFilePath` invalidate on file move or content change
- In-flight coalescing keyed by `(conversationId, normalizedShowThinking)` — same-option concurrent callers share one read+parse+insert pass; mixed-option callers are serialized through a per-conversation chain so the latest request wins SQLite
- Source-missing / unreadable / post-stat-race handling — surfaces as `{ status: 'unavailable' | 'cached', warning: 'source_missing' }` rather than throwing
- Corrupted-JSONL handling — skips malformed lines, returns `warningCount`
- Phase 2 title upgrade — replaces relative-time / generic fallback titles with the first user message, never downgrades a meaningful provider title, never overrides a manual rename
- IPC route `cli-history.hydrate` (forwards optional `showThinking`)

**Key files (Phase 2):** `src/process/cli-history/importer.ts` (hydrateSession + helpers), `src/process/services/database/index.ts` (getMessageCountForConversation + insertImportedMessages atomic replace), `src/common/config/storage.ts` (hydratedAt + hydratedSourceFilePath fields), `src/common/adapter/ipcBridge.ts` + `src/process/bridge/cliHistoryBridge.ts` (hydrate IPC route)

### Done (item 3 — transcript mode — PR #20)

- Read-only transcript surface for imported sessions: skeleton loading, read-only messages, hidden `AcpSendBox`, primary "Resume this session" CTA.
- Gates `ChatConversation.tsx`, `AcpChat.tsx`, `AcpSendBox.tsx` on `conversation.extra.imported` + hydration state.

### Done (item 4 — CC/CP source badges — PR #21)

- `SourceBadge` chip primitive at `src/renderer/pages/conversation/GroupedHistory/parts/SourceBadge.tsx`. 2-letter chips: orange "CC" for Claude Code, blue "CP" for Copilot. No badge for native AionUI conversations. Unknown source values fail soft (no crash). Reused by the full-history view (item 9).

### Done (item 5 — sidebar truncation + Show N more — PR #22)

- Per-section truncation in `GroupedHistory/` with workspace-aware row counting (Today: 15, Yesterday: 10, Recent 7 Days: 20, Earlier: 20). Workspace groups count as expanded row count when expanded, 1 when collapsed.

### Done (item 6 — sidebar filter + search — PR #23)

- Source filter dropdown (All / Claude Code / Copilot / Native) + search bar above the conversation list. Searches conversation name and workspace. Mobile/WebUI collapses both controls to a single filter icon. Pure helper at `GroupedHistory/utils/sidebarFilterHelpers.ts` reused by item 9.

### Done (item 7 — export auto-hydrate — PR #24)

- Export wrapper triggers hydration on cache miss; missing-source-file surfaces a clean error path instead of empty export. Wires `useConversationActions.ts` export to `cliHistory.hydrate.invoke`.

### Done (item 8 — Resume button → live ACP/terminal — PR #25)

- "Resume this session" button transitions from transcript mode to live ACP or terminal mode based on the Step 1 default mode toggle. Auth/cwd mismatch surfaces a clear error and keeps the transcript read-only.

### Done (item 9 — full-screen `/history` view — PR #26)

- Dedicated full-screen history route at `/history`. Multi-select source chips, workspace dropdown, date-range presets + custom range, name+workspace search with optional "Include message content" toggle (hydrated-only message search), sort by date/name, virtuoso-backed virtual scrolling. Sidebar gets a "View all history" footer link; each timeline section gets a "Show all" deep link.

### Done (post-recovery fix PRs)

- **PR #27** — `fix(cli-history): handle 'X as Y' icon-park renames (E2E recovery PR)` — Phase F recovery for item-9 E2E.
- **PR #28** — `fix(cli-history): scan claude-code .jsonl files when sessions-index.json is stale` — Phase K-fix Bug 1 + 3a. Fallback discovery when the Claude Code index is missing or stale.
- **PR #29** — `fix(cli-history): tag imported sessions with customWorkspace so they group by workspace` — Phase K-fix Bug 2.
- **PR #30** — `fix(cli-history): flag rotated source files with a sidebar affordance (Bug 3b)` — Phase M cleanup sweep.

**Plan:** [`2026-03-19-cli-history/plan.md`](./2026-03-19-cli-history/plan.md) (parent design) · [`2026-03-19-cli-history/importer-phase1.md`](./2026-03-19-cli-history/importer-phase1.md) (Phase 1) · [`2026-03-19-cli-history/importer-phase2.md`](./2026-03-19-cli-history/importer-phase2.md) (Phase 2) · [`2026-03-19-cli-history/sidebar-truncation.md`](./2026-03-19-cli-history/sidebar-truncation.md) (item 5) · [`2026-03-19-cli-history/source-badge.md`](./2026-03-19-cli-history/source-badge.md) (item 4) · [`2026-03-19-cli-history/full-history-view.md`](./2026-03-19-cli-history/full-history-view.md) (item 9)

---

## Step 3: Knowledge Consolidation — Not Started

5-step pipeline: scan → extract → daily synthesis → library update → weekly synthesis. Lives in claude-toolkit as a `/consolidate` skill, not in AionUI. Plan is complete; no code yet.

**Plan:** [`2026-03-19-personal-knowledge-consolidation.md`](./2026-03-19-personal-knowledge-consolidation.md)

---

## Backlog

See [`backlog.md`](./backlog.md) for deferred items:

- Auto-convert JSONL in background (blocked — needs spike)
- Temp file cleanup for paste/drag attachments (low priority)
