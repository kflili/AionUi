# CLI History Integration

**Date:** 2026-03-19 (updated 2026-03-21)
**Status:** Draft — research complete, no implementation yet

---

## Motivation

AionUI's sidebar only shows conversations started from within AionUI. CLI sessions run in a regular terminal are invisible. Users want to browse, search, and resume CLI sessions from AionUI's UI — the main value being the conversation history sidebar that the raw CLI lacks.

---

## Current State

### Where conversations live on disk

| Source          | Storage                                                       | Index                       |
| --------------- | ------------------------------------------------------------- | --------------------------- |
| Claude Code CLI | `~/.claude/projects/{path-hash}/{session}.jsonl`              | `sessions-index.json`       |
| Copilot CLI     | `~/.copilot/session-state/{session-id}/events.jsonl`          | `session-store.db` (SQLite) |
| Codex CLI       | `~/.codex/sessions/YYYY/MM/DD/rollout-{date}-{session}.jsonl` | `state_5.sqlite`            |
| AionUI          | `~/Library/Application Support/AionUi/aionui/aionui.db`       | Same SQLite                 |

Key insight: Copilot and Codex already use a **JSONL + SQLite hybrid** — JSONL for conversation content, SQLite for fast listing/indexing. This is the trend. AionUI should do the same: import CLI session metadata into its own SQLite for unified listing, with JSONL as the content source.

### The Gap

- AionUI sidebar only shows AionUI-originated conversations
- CLI sessions started in a regular terminal are invisible
- No way to reference one conversation from another

---

## Core Design: Import into SQLite as First-Class Conversations

**No separate data model. No read-only limitation. No separate sidebar section.**

Import CLI sessions into AionUI's existing `conversations` and `messages` tables as regular `TChatConversation` entries. They appear in the normal sidebar timeline alongside native conversations. Same `...` menu — rename, pin, delete, export all work.

### How it works

1. **Scan** CLI history directories using provider-native indexes (fast, metadata only)
2. **Import metadata** into `conversations` table — creates a `TChatConversation` with:
   - `type: 'acp'` (same as native ACP conversations — passes existing CHECK constraint)
   - `source: 'claude_code' | 'copilot' | 'codex'` — uses existing `conversation.source` field (already extensible via `string & {}` union type)
   - `extra.sourceFilePath: string` — path to the original JSONL file
   - `extra.acpSessionId: string` — session ID for resume
   - `extra.backend: string` — CLI backend type (maps to `AcpBackend`)
   - `extra.workspace: string` — project directory from session metadata
   - `name: string` — first prompt text or session summary
   - `user_id` — uses default `'system_default_user'` (NOT NULL FK constraint requires this)
3. **Background-convert messages** from JSONL → TMessage[] → insert into `messages` table
4. **Show in sidebar** immediately (metadata is enough for listing)

### Why not a separate model?

- Once in SQLite, imported sessions get all native features for free: rename, pin, delete, export, search, tabs
- No need for a separate "CLI Sessions" sidebar section — everything is in one timeline
- The mode toggle from Step 1 works: user can open an imported session in Rich UI or Terminal mode
- Resume via ACP works: `acpSessionId` is stored in `extra`, same as native conversations

### DB schema compatibility

The existing schema supports imported sessions without migration:

- **`type` CHECK constraint** allows `'acp'` — imported Claude Code and Copilot sessions use this. Imported Codex sessions can use `'codex'` (also allowed).
- **`user_id NOT NULL` FK** — use `'system_default_user'` (the app's default user).
- **`source` column** — already extensible via `ConversationSource = 'aionui' | 'telegram' | ... | (string & {})`. Add `'claude_code'`, `'copilot'`, `'codex'` as new source values.
- **`extra` column** — JSON TEXT, already has `acpSessionId`, `workspace`, `backend` fields in the ACP type. Add `sourceFilePath: string` for the original JSONL path.

No schema migration needed. The `conversationToRow()` / `rowToConversation()` functions handle serialization.

### Source badge

The only visual difference: imported sessions show a small source indicator (orange dot for Claude Code, blue for Copilot, green for Codex) next to the agent icon in the sidebar. This tells users where the session came from but doesn't change how they interact with it.

---

## Performance: Background Message Conversion

Converting JSONL → TMessage[] → SQLite insertion takes time for large sessions:

| Session size      | Messages | Total time |
| ----------------- | -------- | ---------- |
| 50KB (~30 msgs)   | 30       | ~15ms      |
| 500KB (~150 msgs) | 150      | ~65ms      |
| 2MB (~500 msgs)   | 500      | ~200ms     |
| 5MB (~1000 msgs)  | 1000     | ~500ms     |
| 10MB+ (marathon)  | 2000+    | ~1.2s      |

**Strategy: background conversion, newest-first.**

1. **Import metadata** to `conversations` table immediately — sidebar shows the session within milliseconds
2. **Queue background conversion** of messages, processing newest sessions first (most likely to be opened)
3. When user opens a session:
   - If messages already converted → instant render
   - If not yet converted → show brief loading spinner → convert on-demand → render
4. Most sessions are under 2MB → under 200ms → on-demand fallback is fast enough

This is the same approach Copilot and Codex use with their own SQLite indexes.

---

## Shared Session Source Provider

Both CLI History Integration (this plan) and Knowledge Consolidation (Step 3) need to discover and read CLI sessions. A shared provider registry avoids duplication:

```typescript
type SessionSourceProvider = {
  id: string; // 'claude_code' | 'copilot' | 'codex'
  discoverSessions(): Promise<SessionMetadata[]>; // list sessions from native index
  readTranscript(sessionId: string): Promise<string[]>; // read JSONL lines
  canResume(sessionId: string): boolean;
  buildReference(sessionId: string): string; // for Copy Chat Reference
};
```

One provider per CLI. Each handles platform-specific path resolution internally.

### Cross-Platform Path Resolution

| CLI         | macOS                                   | Linux               | Windows                   |
| ----------- | --------------------------------------- | ------------------- | ------------------------- |
| Claude Code | `~/.claude/`                            | `~/.claude/`        | `%USERPROFILE%\.claude\`  |
| Copilot     | `~/.copilot/`                           | `~/.copilot/`       | `%USERPROFILE%\.copilot\` |
| Codex       | `~/.codex/`                             | `~/.codex/`         | `%USERPROFILE%\.codex\`   |
| AionUI      | `~/Library/Application Support/AionUi/` | `~/.config/AionUi/` | `%APPDATA%\AionUi\`       |

### Performance: Use provider-native indexes for listing

Don't scan full JSONL files to build the session list. Use each CLI's existing index:

- Claude Code: `sessions-index.json` (pre-built metadata with firstPrompt, summary, messageCount)
- Copilot: `session-store.db` (SQLite index)
- Codex: `state_5.sqlite` (SQLite `threads` table)

Only read full JSONL when converting messages to TMessage[].

---

## Feature 1: Copy Chat Reference (Step 0.5)

Add a "Copy Chat Reference" action to the `...` menu on each conversation in the sidebar.

### What gets copied

| Source              | Copied to clipboard                                          | Agent reads it via         |
| ------------------- | ------------------------------------------------------------ | -------------------------- |
| Claude Code session | `~/.claude/projects/-Users-lili-Projects-teleX/abc123.jsonl` | `Read` tool (file)         |
| Copilot session     | `~/.copilot/session-state/ea81c030-.../events.jsonl`         | `Read` tool (file)         |
| AionUI native       | `aionui:44144192` (ID + db path hint)                        | `Bash` tool: `sqlite3 ...` |

Works on both native and imported conversations. For imported sessions, the `extra.sourceFilePath` provides the path.

### Implementation

- Add "Copy Chat Reference" to the existing `...` dropdown in `ConversationRow.tsx`
- Three-tier reference resolution (best available path):
  1. `conversation.extra.sourceFilePath` (imported CLI sessions) → copy file path directly
  2. `conversation.extra.acpSessionId` → resolve to JSONL file via IPC (`resolveClaudeSessionFilePath`) scanning `~/.claude/projects/`
  3. Fallback → `aionui:{id} @ {dbPath}` (includes SQLite path hint for agent access)

---

## Feature 2: CLI History Import

### Import flow

1. **Settings toggle** (opt-in): Per-CLI toggles in Settings > AgentCLI (or a "CLI History" section):
   - ☑ Import Claude Code sessions — scans `~/.claude/`
   - ☑ Import Copilot sessions — scans `~/.copilot/`
   - ☐ Import Codex sessions — scans `~/.codex/`
2. **Initial scan**: On first enable, scan the CLI's native index and import all session metadata into `conversations` table
3. **Incremental sync**: On app launch (or periodically), check for new sessions and import them
4. **Background message conversion**: Convert JSONL → TMessage[] → `messages` table, newest first
5. **Deduplication**: Skip sessions already imported (match by `extra.sourceFilePath` or `extra.acpSessionId`)

### Resume support

Imported sessions can be resumed — same as Step 1's toggle:

- Click an imported session → opens in Rich UI (messages already in SQLite) or Terminal mode (based on default)
- User can resume via ACP (`session/new` with `resumeSessionId`) or terminal (`--resume {sessionId}`)
- All three CLIs support resume (see Step 1 plan for per-CLI commands)

**Resume complexity note:** Session ID alone is not sufficient. Each backend may also need cwd, auth state, model selection. Treat as backend-by-backend validation. Start with Claude Code, then Copilot, then Codex.

### Unified search

Once all sessions are in SQLite, search is automatic — AionUI's existing conversation search covers both native and imported sessions. Future: add full-text search over `messages.content` via SQLite FTS5.

---

## Key Files

```
New:
  src/process/cli-history/                     — Session source providers (shared with Step 3)
  src/process/cli-history/types.ts             — SessionSourceProvider, SessionMetadata types
  src/process/cli-history/providers/claude.ts   — Claude Code CLI provider
  src/process/cli-history/providers/copilot.ts  — Copilot CLI provider
  src/process/cli-history/providers/codex.ts    — Codex CLI provider (planned)
  src/process/cli-history/converters/           — JSONL → TMessage converters (shared with Step 1)
  src/process/cli-history/importer.ts           — Import + background conversion orchestrator (planned)

Modify:
  src/common/config/storage.ts     — Add sourceFilePath to ACP extra type
  src/renderer/pages/conversation/GroupedHistory/ConversationRow.tsx — Add Copy Chat Reference + source badge
  src/renderer/pages/conversation/GroupedHistory/hooks/useConversationActions.ts — Add copy reference action
  src/common/adapter/ipcBridge.ts  — Add IPC for CLI history import/sync
  src/process/bridge/              — Add bridge for CLI history import
  src/renderer/pages/settings/     — Add CLI history toggles to AgentCLI settings
```

---

## Privacy Considerations

- **Opt-in via toggle:** CLI history import disabled by default. Per-CLI toggles in Settings. Requires scanning home directory — must not do this without explicit user consent.
- **Read-only source access:** AionUI never modifies CLI history files. Only reads JSONL and native indexes.
- **Delete behavior:** Deleting an imported conversation removes it from AionUI's SQLite only. The CLI's JSONL file is NOT deleted. A tooltip explains this: "Removes from AionUI. Original CLI session file is not affected."
- CLI history may contain sensitive data. The same sensitive data filtering from Step 3 applies if/when search indexes conversation content.

---

## Priority

1. **Copy Chat Reference (Step 0.5)** — Highest. Trivial, immediately useful. ~0.5 day.
2. **CLI History Import** — High. The core feature. ~3-4 days (includes providers, importer, background conversion, settings UI).
3. **Resume support** — Medium. Backend-by-backend validation. ~2-3 days.
4. **Unified search (FTS5)** — Future. Nice to have once content is in SQLite. ~2-3 days.

---

## Done Means

### Step 0.5: Copy Chat Reference

- [ ] "Copy Chat Reference" action in conversation `...` menu
- [ ] Copies correct file path for imported sessions (from `extra.sourceFilePath`)
- [ ] Resolves JSONL path for ACP sessions via `acpSessionId` (Claude Code sessions)
- [ ] Falls back to `aionui:{id} @ {dbPath}` for non-ACP native sessions
- [ ] Agent can paste the reference and read the conversation using existing tools

### CLI History Import

- [ ] Per-CLI import toggles in Settings > AgentCLI
- [ ] Imported sessions appear in normal sidebar timeline (same as native conversations)
- [ ] Source badge visible on imported sessions (orange/blue/green dot per CLI)
- [ ] Full `...` menu works: rename, pin, delete, export
- [ ] Background message conversion: newest sessions converted first
- [ ] On-demand fallback: if not yet converted, show spinner then convert
- [ ] Incremental sync: new sessions imported on app launch
- [ ] Incremental message sync: sessions that continue in CLI after import get updated messages on next sync
- [ ] Delete removes from AionUI only, not from CLI history files

### Resume

- [ ] Imported sessions can be resumed via ACP or terminal mode (Step 1 toggle)
- [ ] At least Claude Code resume works end-to-end
- [ ] Clear error message when resume fails (auth, cwd mismatch, etc.)
