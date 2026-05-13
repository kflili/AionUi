# AionUI Enhancement Plans — Index

**Date:** 2026-03-19 (updated 2026-04-14)
**Context:** Research and planning session covering AionUI architecture, CLI agent ecosystem, knowledge management, and personal AI workflow design.

---

## Implementation Order

Each step has its own plan. Multi-file plans live in a subfolder; standalone plans stay flat.

### Step 0.5: Copy Chat Reference — Done

**Plan:** Inside [`2026-03-19-cli-history/plan.md`](./2026-03-19-cli-history/plan.md) (Feature 1)
**Where:** AionUI project

Add "Copy Chat Reference" to conversation `...` menu. Low-risk, high-leverage, independent of other steps. Copies a file path or session ID that any CLI agent can use to read the conversation via existing tools. Can be built standalone before or alongside Step 1.

### Step 1: Terminal Wrapper Mode — Done

**Plan:** [`2026-03-19-terminal-wrapper/plan.md`](./2026-03-19-terminal-wrapper/plan.md)
**Where:** AionUI project
**Also:** [manual-tests.md](./2026-03-19-terminal-wrapper/manual-tests.md), [design-mockup.html](./2026-03-19-terminal-wrapper/design-mockup.html)

Build terminal wrapper infrastructure: embed xterm.js in the renderer, spawn CLIs via node-pty, create `TerminalSessionManager` for PTY lifecycle. Exposed as a mode toggle (`💬 Rich UI | >_ Terminal`) in the chat header — not a separate conversation type, but an alternative rendering mode on existing conversations. Both directions work via CLI `--resume`. Includes JSONL → TMessage converter for rendering terminal history as rich UI. New "AgentCLI" settings tab for default mode.

### Step 2: CLI History Integration — Done

**Plan:** [`2026-03-19-cli-history/plan.md`](./2026-03-19-cli-history/plan.md) (parent design)
**Implementation sub-plans:** [`importer-phase1.md`](./2026-03-19-cli-history/importer-phase1.md) (metadata index — done) · [`importer-phase2.md`](./2026-03-19-cli-history/importer-phase2.md) (on-demand message hydration — done) · [`sidebar-truncation.md`](./2026-03-19-cli-history/sidebar-truncation.md) (item 5 — done) · [`source-badge.md`](./2026-03-19-cli-history/source-badge.md) (item 4 — done) · [`full-history-view.md`](./2026-03-19-cli-history/full-history-view.md) (item 9 — done)
**Where:** AionUI project
**Shipped via:** PRs #17–#26 (items 0–9) + PRs #27–#30 (post-recovery fixes). See [`progress.md`](./progress.md) for the PR-by-PR rollup.

Import CLI sessions (Claude Code, Copilot, Codex) into AionUI's SQLite as first-class conversations. No separate data model — imported sessions appear in the normal sidebar timeline with full functionality (rename, pin, delete, export, resume). JSONL + SQLite hybrid approach, same as Copilot and Codex already use. Background message conversion newest-first. Codex CLI import remains V2 deferred.

### Step 3: Knowledge Consolidation

**Plan:** [`2026-03-19-personal-knowledge-consolidation.md`](./2026-03-19-personal-knowledge-consolidation.md)
**Where:** claude-toolkit (as a `/consolidate` skill), NOT in AionUI

Five-step pipeline: scan → extract → daily synthesis → library update → weekly synthesis. Produces journal summaries and knowledge library. Includes SQLite FTS5 indexing and local embeddings as later phases inside the same plan. AionUI can trigger via cron later, but the logic stays portable. Sub-features and phasing managed inside the plan file.

**Note:** Step 3 does NOT depend on Step 2's UI work — it only needs the same CLI history path knowledge (covered in the storage reference doc). Can start earlier if personal ROI is the priority.

---

## Shared Infrastructure

### Session Source Provider

Steps 1, 2, and 3 all need to discover and read CLI session history. Shared provider registry:

```typescript
type SessionSourceProvider = {
  id: string; // 'claude_code' | 'copilot' | 'codex'
  discoverSessions(): Promise<SessionMetadata[]>; // list sessions from native index
  readTranscript(sessionId: string): Promise<string[]>; // read JSONL lines
  canResume(sessionId: string): boolean;
  buildReference(sessionId: string): string; // for Copy Chat Reference
};
```

### JSONL → TMessage Converter

Converts CLI JSONL (Anthropic API format) to AionUI's `TMessage[]` for rich UI rendering. ~400-600 lines per CLI format (includes error handling, streaming state reconstruction, tool_result merging). Used by:

- **Step 1**: render terminal history when toggling Terminal → Rich UI
- **Step 2**: background-convert imported sessions into `messages` table
- **Step 3**: parse JSONL for knowledge extraction pipeline

### SQLite usage across steps

| Step           | SQLite usage                        | What                                                                          |
| -------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| Step 2         | AionUI's existing `aionui.db`       | Import CLI session metadata + converted messages as first-class conversations |
| Step 3 (later) | Separate `~/knowledge/knowledge.db` | FTS5 search index over knowledge library + embeddings                         |

These are different databases for different purposes. Step 2's SQLite is AionUI's conversation store. Step 3's SQLite is a search index for extracted knowledge.

---

## Reference Documents (no implementation)

### CLI History Storage Reference

**Doc:** [`2026-03-19-cli-history/storage-reference.md`](./2026-03-19-cli-history/storage-reference.md)

Research findings on how every CLI and desktop app stores conversation history. Covers Claude Code CLI, Claude Desktop (Chat/Code/Cowork modes), Copilot CLI, Codex CLI, Gemini CLI, Google Antigravity, and AionUI. Includes JSON vs JSONL comparison, why CLIs use JSONL, three approaches to Desktop UI ↔ CLI communication (Claude Desktop proprietary IPC, AionUI ACP, terminal wrapper), and comparison table. Includes cross-platform path notes.

### Agent Architecture Notes

**Doc:** [`2026-03-19-agent-architecture-notes.md`](./2026-03-19-agent-architecture-notes.md)

Design notes on the "root agent" pattern. Current CLI session already serves as root agent — no special infrastructure needed. Tmux delegation pattern for parallel heavy tasks. Future `/delegate` skill concept. Mobile/random chat workflow using a default workspace folder.

---

## Already Done

Implemented plans are archived in `docs/plans/archive/`.

- **ACP Permission Race Condition Fix** — `fix/acp-concurrent-permission-race-condition` (`372ba6a1`)
- **ACP Stale Running State Fix** — archived `2026-03-22-acp-stale-running-state-fix.md`
- **Copilot ACP Permission Modes** — archived `2026-03-29-copilot-acp-permission-modes.md`
- **Terminal Wrapper Iteration 2 Fixes** — archived in `2026-03-19-terminal-wrapper/archive/`
- **Terminal Remote Access Fixes** — archived in `2026-03-19-terminal-wrapper/archive/`

---

## Key Design Decisions from Discussion

### What goes in AionUI vs elsewhere

| Feature                           | Where                            | Plan file                          |
| --------------------------------- | -------------------------------- | ---------------------------------- |
| Copy Chat Reference               | AionUI                           | Step 0.5 ✅                        |
| Mode toggle (Rich UI / Terminal)  | AionUI                           | Step 1                             |
| AgentCLI settings tab             | AionUI                           | Step 1                             |
| JSONL → TMessage converter        | Shared (AionUI + claude-toolkit) | Steps 1, 2 & 3 ✅ (Claude+Copilot) |
| CLI History Import (into SQLite)  | AionUI                           | Step 2                             |
| Session Source Provider           | Shared (AionUI + claude-toolkit) | Steps 2 & 3 ✅ (Claude+Copilot)    |
| Knowledge consolidation pipeline  | claude-toolkit (skill)           | Step 3                             |
| Knowledge FTS5 index + embeddings | Inside Step 3 (later phase)      | Step 3                             |
| `/delegate` tmux                  | claude-toolkit (skill)           | Future (in architecture notes)     |

### Strategic principles

1. **AionUI is the UI layer** — history browsing, terminal rendering, conversation management
2. **Skills are the logic layer** — consolidation, delegation, batch processing. Portable across any CLI.
3. **Knowledge library is plain files** — markdown in a directory. Any tool can read them. SQLite index added later for speed, not as the primary store.
4. **Don't build infrastructure before you need it** — files first, SQLite when slow, embeddings when keyword search misses

### First-principles framework (from discussion)

- **LLM = CPU** — reasoning engine. Don't build your own. Use the best available from providers.
- **Agent/CLI = methodology** — process, playbook, rules for performing work. Where differentiation happens. Customize existing CLIs rather than building from scratch (ecosystem too volatile).
- **Memory/knowledge = hard drive** — persistent context. Most underinvested, highest ROI. A mediocre model with excellent context outperforms a brilliant model with no context. **This is what we should build.**

### Architecture: no root agent needed

The current CLI session IS the root agent. It has filesystem access across all projects, can spawn subagents, can delegate via tmux. No SDK, no worker framework, no message bus. Just tmux + existing CLIs + a knowledge scanner.

### Consolidation: read, don't write

Every CLI already logs conversations as JSONL. Don't duplicate. Don't build central logging. Just scan where they already are and produce journal + library output.

### MCP: avoid for now

MCP tools connect at session start and occupy context window. Skill-wrapping MCP does NOT solve this (skills can't register API tools). Claude Code's native `defer_loading` + `ToolSearch` partially addresses it but has bugs. For most tasks, skills + bash tools do the same thing without the overhead.

### Skills: project-level, not root-level

Keep skills in project directories, not root `~/.claude/commands/`. Each project is a focused agent with only the tools it needs. Avoids context bloat and conflict from too many root-level skills.
