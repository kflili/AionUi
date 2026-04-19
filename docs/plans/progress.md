# AionUI Enhancement Progress

**Last updated:** 2026-04-14

Quick status of each step in the [plan index](./2026-03-19-plan-index.md).

---

## Overview

| Step | Feature                  | Status           | PRs      |
| ---- | ------------------------ | ---------------- | -------- |
| 0.5  | Copy Chat Reference      | Done             | #2       |
| 1    | Terminal Wrapper Mode    | Done             | #5, #9   |
| 2    | CLI History Integration  | Partially done   | #5       |
| 3    | Knowledge Consolidation  | Not started      | —        |

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

### Not started

- Import orchestrator — discover sessions, insert into SQLite `conversations` + `messages` tables
- Background message conversion (newest-first)
- Settings UI — per-CLI import toggles
- Sidebar integration — imported sessions visible in timeline with source badges
- Resume support for imported sessions
- Incremental sync on app launch
- Delete behavior (remove from AionUI only, preserve CLI files)

**Plan:** [`2026-03-19-cli-history/plan.md`](./2026-03-19-cli-history/plan.md)

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
