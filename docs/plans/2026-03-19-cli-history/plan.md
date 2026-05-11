# CLI History Integration

**Date:** 2026-03-19 (updated 2026-04-14)
**Status:** In progress — shared infra merged, import UX designed, core import not started

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

**No separate data model. No separate sidebar section.**

Import CLI sessions into AionUI's existing `conversations` and `messages` tables as regular `TChatConversation` entries. They appear in the normal sidebar timeline alongside native conversations. Same `...` menu — rename, pin, delete, export all work.

### How it works

1. **Scan** CLI history directories using provider-native indexes (fast, metadata only)
2. **Import metadata** into `conversations` table — creates a `TChatConversation` with:
   - `type: 'acp'` (same as native ACP conversations — passes existing CHECK constraint)
   - `source: 'claude_code' | 'copilot'` — uses existing `conversation.source` field (already extensible via `string & {}` union type). Codex deferred to V2.
   - `extra.sourceFilePath: string` — path to the original JSONL file
   - `extra.acpSessionId: string` — session ID for resume
   - `extra.backend: string` — CLI backend type (maps to `AcpBackend`)
   - `extra.workspace: string` — project directory from session metadata
   - `extra.hydratedAt: number` — timestamp of last message hydration (for staleness check)
   - `name: string` — provider-aware auto-generated title (Phase 1 uses provider metadata when available; Phase 2 upgrades from the first user message only when needed; see Auto-Naming)
   - `user_id` — uses default `'system_default_user'` (NOT NULL FK constraint requires this)
3. **Hydrate messages on demand** — only when user opens a session (see Two-Phase Import)
4. **Show in sidebar** immediately (metadata is enough for listing)

### Why not a separate model?

- Once in SQLite, imported sessions get all native features for free: rename, pin, delete, export, search, tabs
- Export on a non-hydrated session triggers auto-hydration first (read JSONL, convert, then export). This is transparent to the user — export just takes slightly longer on first use.
- No need for a separate "CLI Sessions" sidebar section — everything is in one timeline
- The Step 1 mode toggle still applies when resuming an imported session: from transcript mode, "Resume this session" launches the session in Rich UI or Terminal mode based on the user's default.
- Resume via ACP works: `acpSessionId` is stored in `extra`, same as native conversations

### DB schema compatibility

The existing schema supports imported sessions without migration:

- **`type` CHECK constraint** allows `'acp'` — imported Claude Code and Copilot sessions use this. Imported Codex sessions can use `'codex'` (also allowed).
- **`user_id NOT NULL` FK** — use `'system_default_user'` (the app's default user).
- **`source` column** — already extensible via `ConversationSource = 'aionui' | 'telegram' | ... | (string & {})`. Add `'claude_code'`, `'copilot'` as new source values for V1. Codex (`'codex'`) deferred to V2.
- **Extra fields** — JSON TEXT, add `sourceFilePath`, `hydratedAt`, `importMeta.autoNamed` for import tracking.

No schema migration required for Claude Code / Copilot import: imported rows can use the existing `system_default_user`, existing `acp` conversation type, and arbitrary source strings after migration v15.

---

## Two-Phase Import Strategy

Do NOT eagerly import all messages. Split into metadata indexing (instant) and message hydration (on demand).

### Phase 1: Metadata Index (on enable)

Scan all session files via provider-native indexes, extract metadata only:

- Session ID, source file path, last modified time
- Title candidate from provider metadata: for Claude Code, use `firstPrompt` from `sessions-index.json`; for Copilot, use `summary` from `session-store.db`. If the provider lacks a good title candidate, promote the title during Phase 2 hydration (extract first user message from JSONL).
- Message count (if available from index)
- Workspace/project directory

Write a `conversations` row per session. This is near-instant — reading 200 index entries typically completes in under a second.

### Phase 2: Message Hydration (on click)

When the user opens a session for the first time:

1. Intercept before the normal `AcpChat` surface mounts (which would show a live editable chat)
2. If messages are not yet hydrated, show skeleton loading state
3. Read and parse the full JSONL file
4. Convert to TMessage[] using the appropriate converter
5. Insert into `messages` table
6. Set `extra.hydratedAt` to current timestamp
7. Render in **transcript mode** — disable the normal send box, show messages as read-only, display a primary "Resume this session" action

Only an explicit "Resume" action transitions the user into live ACP or terminal mode. This avoids confusion about whether typing into an imported session actually reaches the CLI.

### Performance expectations

| Session size      | Messages | Hydration time |
| ----------------- | -------- | -------------- |
| 50KB (~30 msgs)   | 30       | ~15ms          |
| 500KB (~150 msgs) | 150      | ~65ms          |
| 2MB (~500 msgs)   | 500      | ~200ms         |
| 5MB (~1000 msgs)  | 1000     | ~500ms         |
| 10MB+ (marathon)  | 2000+    | ~1.2s          |

Most sessions are under 2MB — hydration is fast enough to feel instant.

---

## Sidebar Volume Management

Importing hundreds of CLI sessions will flood the sidebar. The sidebar is a **recent-work launcher**, not an archive browser.

### Per-Section Truncation

Show a limited number of items per timeline group, with "Show N more" expanders:

| Timeline group | Default visible | Expand behavior         |
| -------------- | --------------- | ----------------------- |
| Today          | 15              | "Show N more" per click |
| Yesterday      | 10              | "Show N more" per click |
| Recent 7 Days  | 20              | "Show N more" per click |
| Earlier        | 20              | "Show N more" per click |

Implementation: Do not truncate `TimelineSection.items` directly. Because a section item may be a workspace group containing multiple conversations, truncation must be applied after expansion into visible rows (or with separate limits for standalone conversations vs workspace-group children). Track expanded section state independently from expanded workspace state.

### Sidebar Filter & Search

Two controls above the conversation list (only visible when CLI import is enabled):

1. **Source filter dropdown** — compact dropdown: All / Claude Code / Copilot / Native. Filters the visible list by `conversation.source`.
2. **Search bar** — filter visible items by title and workspace match (instant, client-side string matching against `conversation.name` and `conversation.extra.workspace`).

**Mobile/WebUI:** Both controls collapse into a single filter icon button that opens a bottom sheet with filter + search.

---

## Full History View

A dedicated full-screen panel for deep browsing beyond what the sidebar offers. The sidebar handles recent work; the History view handles the archive.

### Entry points

- "View all history" link at the bottom of the sidebar
- "Show all" link from expanded timeline sections
- Keyboard shortcut (TBD)

### Layout

Replaces the main content area (same pattern as new chat or existing chat). Shows a full-height scrollable conversation list with:

- **Source filter chips** — inline, with room for multiple selections
- **Workspace filter** — dropdown or chips by project directory
- **Date range filter** — quick presets (Last 7 days, Last 30 days, All time) + custom range
- **Full-text search** — searches conversation names; full message search only for hydrated sessions
- **Sort options** — by date (default), by name

### Pagination

Virtual scrolling or paginated loading (unlike sidebar which loads all at once). Handles thousands of sessions smoothly.

---

## Auto-Naming

CLI sessions often have meaningless auto-generated names. Imported sessions need human-scannable titles.

### Naming strategy (in priority order)

1. **Provider metadata title** — Claude Code's `firstPrompt` or Copilot's `summary`, truncated to 60 characters. Available at Phase 1 (no JSONL reading needed).
2. **First user message text** (Phase 2 upgrade) — if metadata title is missing or generic, extract from JSONL during hydration and update the title.
3. **Append workspace folder** for disambiguation: `"fix auth bug \u00b7 my-project"`
4. **Fallback**: relative time + workspace: `"2 days ago \u00b7 my-project"`

Never surface raw filenames like `claude_session_2025_01_15_143022` or session UUIDs as display names.

Users can always rename imported sessions via the `...` menu (same as native conversations).

---

## Source Badges

Visual distinction between native and imported conversations.

### Design

- **Position:** Trailing area of the conversation row (not competing with the name)
- **Style:** Small 2-letter chip in secondary text color
  - `CC` — Claude Code (orange)
  - `CP` — Copilot (blue)
  - Codex badge (`CX`, green) deferred to V2
- **Native conversations:** No badge (absence = native AionUI)
- **Distinction from agent icon:** The leading icon shows the current agent backend (which agent handles this conversation). The source badge shows origin (where the conversation was started). These are different axes — an imported Claude Code session could be resumed via a different backend.

---

## Stale Data Handling

CLI sessions can be updated externally (user continues working in terminal) while AionUI shows a cached version.

### Strategy: mtime check on open

When a user opens a hydrated imported session:

1. Check `mtime` of the source JSONL file
2. Compare against `extra.hydratedAt` timestamp
3. If file is newer → re-hydrate (re-read JSONL, re-convert, update messages in SQLite)
4. If unchanged → use cached messages

### Future improvement

- Rescan session index on app focus (detect new sessions without requiring restart)
- If an imported session is currently open, tail/refresh on file change

---

## Disable/Re-enable Import

### Disabling

When the user turns off CLI import:

1. Show confirmation: "This will hide N imported sessions from the sidebar, history view, and search. They won't be deleted."
2. Hide imported conversations from all discovery surfaces (sidebar, full-history view, and search results). SQLite rows remain intact.
3. User's customizations (renames, pins) are preserved in SQLite

### Re-enabling

- All previously imported sessions reappear with their customizations intact
- Incremental scan picks up any new sessions created while import was disabled

### Explicit delete

Deleting an imported conversation is a separate user action via the `...` menu. This removes the row from AionUI's SQLite only — the CLI's JSONL file is NOT affected. Tooltip: "Removes from AionUI. Original CLI session file is not affected."

---

## Edge Cases

### Corrupted JSONL

Import partially — skip malformed lines and continue. Show a non-blocking warning: "Imported with N skipped events." The conversation is still usable with the valid messages.

### Missing source files

If the source file is missing and the session has already been hydrated, continue showing the cached SQLite transcript and surface a warning banner: "Source file not found — showing last imported transcript." If the source file is missing before first hydration, show "Transcript unavailable — source file not found." In both cases the sidebar row remains (metadata is in SQLite).

### Deduplication

Key imported sessions by `source + extra.acpSessionId` (or `source + extra.sourceFilePath`). On incremental sync, upsert — never create duplicate rows for the same CLI session. Incremental sync may refresh provider-owned metadata (`updatedAt`, `messageCount`, `filePath`, `workspace`), but must not overwrite user-controlled fields such as manual renames or pin state. Track whether the current title is auto-generated (`extra.importMeta.autoNamed = true`) before replacing it on re-sync.

### Read-only by default

Imported sessions open in **transcript mode** (see Phase 2 above). The normal `AcpSendBox` is hidden; messages render as read-only. A primary "Resume this session" action starts an ACP or terminal session with the appropriate resume flags.

### Search scope

- **Metadata search** (conversation name, workspace): Works for all imported sessions immediately
- **Full-text message search**: Only works for hydrated sessions (messages in SQLite). Non-hydrated sessions won't appear in message search results. The Full History view should indicate this: "Some sessions not yet indexed for message search."

---

## Shared Session Source Provider

Both CLI History Integration (this plan) and Knowledge Consolidation (Step 3) need to discover and read CLI sessions. A shared provider registry avoids duplication:

```typescript
type SessionSourceProvider = {
  id: string; // 'claude_code' | 'copilot' | 'codex'
  discoverSessions(): Promise<SessionMetadata[]>; // list sessions from native index
  readTranscript(sessionId: string): Promise<string[]>; // read JSONL lines
  canResume(sessionId: string): boolean; // checks if transcript/reference is available for resume attempt
  buildReference(sessionId: string): string; // for Copy Chat Reference
};
```

> **Note:** `canResume` only checks transcript availability, not full resume validity. Actual resume depends on backend-specific factors (cwd, auth state, model selection) that are validated at resume time, not at discovery time. See Resume support section for details.

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

Only read full JSONL when hydrating messages on demand.

---

## Feature 1: Copy Chat Reference (Step 0.5) — DONE

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
  1. `conversation.extra.sourceFilePath` (imported CLI sessions) -> copy file path directly
  2. `conversation.extra.acpSessionId` -> resolve to JSONL file via IPC (`resolveClaudeSessionFilePath`) scanning `~/.claude/projects/`
  3. Fallback -> `aionui:{id} @ {dbPath}` (includes SQLite path hint for agent access)

---

## Feature 2: CLI History Import

### Import flow

1. **Settings toggle** (opt-in): Per-CLI toggles in Settings > AgentCLI (or a "CLI History" section):
   - [ ] Import Claude Code sessions — scans `~/.claude/`
   - [ ] Import Copilot sessions — scans `~/.copilot/`
   - Codex support deferred to V2 (no provider or converter yet)
2. **Initial scan**: On first enable, scan the CLI's native index and import all session metadata into `conversations` table (Phase 1 — instant)
3. **Incremental sync**: On app launch (or periodically), check for new sessions and import metadata
4. **On-demand hydration**: Messages converted from JSONL only when user opens a session (Phase 2)
5. **Deduplication**: Skip sessions already imported (match by `source + extra.acpSessionId` or `source + extra.sourceFilePath`)

### Resume support

Imported sessions open into transcript mode first:

- Click an imported session -> opens a read-only transcript surface
- User clicks "Resume this session" to start live ACP or terminal resume
- The Step 1 mode toggle decides whether that resume action launches Rich UI or Terminal mode
- Claude Code and Copilot resume are in V1; Codex remains V2 with Codex import

**Resume complexity note:** Session ID alone is not sufficient. Each backend may also need cwd, auth state, model selection. Treat as backend-by-backend validation. Start with Claude Code, then Copilot, then Codex.

### Unified search

Metadata search is automatic as soon as Phase 1 creates the conversation rows. Message-content search only works for hydrated sessions. Future: add full-text search over `messages.content` via SQLite FTS5.

---

## Key Files

```
Done (on main):
  src/process/bridge/cliHistoryBridge.ts        — Session path resolution for all 3 CLIs + isSessionIdle + Phase 1 IPC handlers
  src/renderer/pages/conversation/GroupedHistory/ConversationRow.tsx — Copy Chat Reference action
  src/renderer/pages/conversation/GroupedHistory/hooks/useConversationActions.ts — Copy reference logic
  src/process/cli-history/types.ts              — SessionSourceProvider, SessionMetadata, ImportResult types
  src/process/cli-history/index.ts              — Provider registry exports
  src/process/cli-history/providers/base.ts     — BaseSessionSourceProvider abstract class
  src/process/cli-history/providers/claude.ts   — Claude Code CLI provider
  src/process/cli-history/providers/copilot.ts  — Copilot CLI provider
  src/process/cli-history/converters/claude.ts  — Claude JSONL -> TMessage converter
  src/process/cli-history/converters/copilot.ts — Copilot JSONL -> TMessage converter

Done (Phase 1 metadata index):
  src/process/cli-history/importer.ts           — Phase 1 orchestrator (discoverAndImport, disableSource, reenableSource); Phase 2 hydrateSession also landed here
  src/process/bridge/conversationEvents.ts      — Extracted emitConversationListChanged helper (breaks circular import)
  src/common/adapter/ipcBridge.ts               — cliHistory.{scan, scanAll, disableSource, reenableSource} IPC routes
  src/process/services/database/index.ts        — getUserConversations hidden filter + getImportedConversationsIncludingHidden + updateImportedConversation
  src/renderer/components/settings/SettingsModal/contents/AgentCliModalContent.tsx — Per-CLI import toggles (Claude Code, Copilot)
  src/process/bridge/index.ts                   — Wires initCliHistoryImporter() for app-launch sync

Done (Phase 2 on-demand message hydration):
  src/process/cli-history/importer.ts           — hydrateSession + helpers (mtime cache keyed by hydratedAt + hydratedSourceFilePath, in-flight coalescing, splitJsonlByValidity, upgradeTitleFromFirstUserMessage)
  src/process/services/database/index.ts        — getMessageCountForConversation + atomic DELETE-then-INSERT insertImportedMessages
  src/common/config/storage.ts                  — extra.hydratedAt + extra.hydratedSourceFilePath optional fields on the acp variant
  src/common/adapter/ipcBridge.ts               — cliHistory.hydrate IPC route (forwards optional showThinking)

Not started:
  src/process/cli-history/providers/codex.ts    — Codex CLI provider (deferred to V2)
  src/renderer/pages/conversation/GroupedHistory/ — Per-section truncation, filter, search
  src/renderer/pages/conversation/components/ChatConversation.tsx — Transcript mode gating
  src/renderer/pages/conversation/platforms/acp/AcpChat.tsx — Read-only transcript surface
  src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx — Hide in transcript mode
  src/renderer/pages/history/                   — Full History view (new page)
```

---

## Privacy Considerations

- **Opt-in via toggle:** CLI history import disabled by default. Per-CLI toggles in Settings. Requires scanning home directory — must not do this without explicit user consent.
- **Read-only source access:** AionUI never modifies CLI history files. Only reads JSONL and native indexes.
- **Delete behavior:** Deleting an imported conversation removes it from AionUI's SQLite only. The CLI's JSONL file is NOT deleted. A tooltip explains this: "Removes from AionUI. Original CLI session file is not affected."
- CLI history may contain sensitive data. The same sensitive data filtering from Step 3 applies if/when search indexes conversation content.

---

## Implementation Priority

1. **Per-section truncation + "Show more"** — sidebar volume control (prerequisite for import)
2. **Two-phase import** (metadata eager, messages on-click) — core feature
3. **Source badges + sidebar filter dropdown + search bar** — makes imports distinguishable and filterable
4. **Provider-aware auto-naming + workspace disambiguation** — gives imported sessions usable titles before hydration and upgrades generic titles after hydration
5. **Full History view** — for browsing beyond the sidebar
6. **mtime staleness check** — correctness for externally-updated sessions
7. **Disable/re-enable hide logic** — safety net for users who change their mind

---

## Done Means

### Step 0.5: Copy Chat Reference — DONE (merged to main)

- [x] "Copy Chat Reference" action in conversation `...` menu
- [x] Copies correct file path for imported sessions (from `extra.sourceFilePath`)
- [x] Resolves JSONL path for ACP sessions via `acpSessionId` (Claude Code sessions)
- [x] Falls back to `aionui:{id} @ {dbPath}` for non-ACP native sessions
- [x] Agent can paste the reference and read the conversation using existing tools

### Shared Infra — DONE (merged to main)

- [x] Session source provider types and base class (`types.ts`, `providers/base.ts`)
- [x] Claude Code provider — discovers sessions via `sessions-index.json`
- [x] Copilot provider — discovers sessions via `session-store.db`
- [x] Claude JSONL -> TMessage converter (with tests)
- [x] Copilot JSONL -> TMessage converter (with tests)

### Sidebar Volume Management

- [x] Per-section truncation with configurable limits per timeline group
- [x] "Show N more" expander per section
- [x] Source filter dropdown (All / Claude Code / Copilot / Native)
- [x] Search bar for filtering by title and workspace match
- [x] Mobile-responsive: filter + search collapse to icon button

### CLI History Import

- [x] Per-CLI import toggles in Settings > AgentCLI (Claude Code + Copilot for V1)
- [x] Phase 1: metadata index on enable (instant scan)
- [x] Phase 2: on-demand message hydration (backend done; transcript-mode UI with skeleton loading is item 3)
- [ ] Imported sessions appear in normal sidebar timeline (mixed with native)
- [ ] Source badge visible on imported sessions (2-letter chips: CC, CP)
- [ ] Auto-naming uses provider metadata first, upgrades from first user message when needed, and appends workspace for disambiguation
- [ ] Full `...` menu works: rename, pin, delete, export (export auto-hydrates if messages not yet loaded)
- [x] Incremental sync: new sessions imported on app launch
- [ ] mtime staleness check: re-hydrate if source file changed
- [x] Deduplication by source + session ID
- [ ] Delete removes from AionUI only, not from CLI history files
- [x] Disable/re-enable hides/shows imported rows without deleting
- [ ] Corrupted JSONL handled gracefully (partial import + warning)
- [ ] Missing source files show "transcript unavailable" state
- [ ] Imported sessions open as read-only with "Resume" action

### Full History View

- [ ] Dedicated full-screen history panel (replaces main content)
- [ ] Source filter chips + workspace filter + date range
- [ ] Full-text search (for hydrated sessions)
- [ ] Virtual scrolling or paginated loading
- [ ] Entry from sidebar "View all history" link

### Resume

- [ ] Imported sessions can be resumed via ACP or terminal mode (Step 1 toggle)
- [ ] At least Claude Code resume works end-to-end
- [ ] Clear error message when resume fails (auth, cwd mismatch, etc.)

---

## Test Plan

Tests follow project conventions: Vitest 4, behavior-focused descriptions, at least one failure path per describe block. See `testing` skill for full standards.

### Unit Tests (`tests/unit/`)

#### 1. Importer Orchestrator (`cli-history/importer.test.ts`)

**Phase 1: Metadata Import**

- imports discovered Claude Code sessions as sidebar-ready conversations with provider metadata preserved
- imports discovered Copilot sessions using `summary` as title
- skips sessions that are already imported (deduplication by `source + acpSessionId`)
- incremental sync refreshes provider-owned metadata (`updatedAt`, `messageCount`) without overwriting user renames (`importMeta.autoNamed = false`)
- incremental sync preserves pin state on re-sync
- concurrent incremental sync runs do not create duplicate conversation rows
- handles provider returning empty session list gracefully
- handles provider throwing an error without crashing import of other providers

**Phase 2: Message Hydration**

- opens a non-hydrated imported session by loading its transcript once, then reuses cached data until the source changes
- skips hydration if messages already exist and source file mtime is unchanged
- re-hydrates if source file mtime is newer than `extra.hydratedAt`
- coalesces concurrent hydration requests for the same session and inserts messages only once
- coalesces export-triggered hydration with open-triggered hydration for the same session
- handles corrupted JSONL lines: skips bad lines, imports valid ones, returns warning count
- handles missing source file for never-hydrated session: returns "unavailable" status
- handles missing source file for previously-hydrated session: returns "cached" status with warning

**Auto-Naming**

- uses Claude Code `firstPrompt` as title when available
- uses Copilot `summary` as title when available
- falls back to relative time + workspace when provider metadata and first user message are both unavailable
- does not use raw session filenames or UUID-like identifiers as display titles
- truncates title to 60 characters
- appends workspace folder for disambiguation: `"topic · project-name"`
- upgrades generic title with first user message during Phase 2 hydration
- keeps meaningful provider titles unchanged during Phase 2 (does not downgrade)
- does not upgrade title if user has manually renamed (`importMeta.autoNamed = false`)

**Disable/Re-enable**

- disabling import marks imported conversations as hidden
- re-enabling import restores previously hidden conversations with customizations intact
- re-enabling triggers incremental sync for new sessions

#### 2. Sidebar Truncation (`groupingHelpers.truncation.test.ts`)

Extends existing `groupingHelpers.test.ts` patterns.

- truncates "Today" section to N visible rows with "Show M more" count
- truncates "Earlier" section independently from "Today"
- workspace groups count as their expanded row count, not 1 item
- expanding a section shows all items in that section
- collapsed workspace groups count as 1 row toward the section limit
- sections with fewer items than the limit show all items (no expander)
- empty sections are hidden (no "Show 0 more")

#### 3. Sidebar Filter & Search (`sidebarFilter.test.ts`)

- source filter "All" shows native + imported conversations
- source filter "Claude Code" shows only `source: 'claude_code'` conversations
- source filter "Copilot" shows only `source: 'copilot'` conversations
- source filter "Native" shows only `source: 'aionui'` or `source: undefined`
- search bar filters conversations by case-insensitive title or workspace match
- search + source filter combine (AND logic): only matching source AND title/workspace
- metadata search matches workspace names for non-hydrated imported sessions
- empty search shows all conversations (filter-only)
- no-match search shows empty state

#### 4. Source Badge (`sourceBadge.dom.test.ts`)

- renders "CC" chip for `source: 'claude_code'` conversations
- renders "CP" chip for `source: 'copilot'` conversations
- renders no badge for native AionUI conversations (`source: 'aionui'` or undefined)
- badge uses correct color class for each source
- unknown or unsupported source renders no badge instead of crashing
- malformed source metadata falls back to no badge

#### 5. Transcript Mode (`transcriptMode.dom.test.ts`)

- imported session renders messages as read-only (no send box)
- "Resume this session" action button is visible
- clicking "Resume" is required before live input appears
- resume launches Rich UI or Terminal mode according to the Step 1 default mode toggle
- failed resume shows a clear error message and keeps the transcript read-only
- native ACP conversation still renders normal send box (no regression)
- skeleton loading state shown while hydration is in progress

#### 6. Export Auto-Hydration (`exportAutoHydrate.test.ts`)

- exporting a hydrated session uses cached messages (no JSONL re-read)
- exporting a non-hydrated session triggers hydration first, then exports
- export of non-hydrated session with missing source file returns error

#### 7. Deduplication & Sync (covered in `cli-history/importer.test.ts`)

Dedup tests are consolidated into the importer orchestrator suite since deduplication is part of the import logic. Extract to a separate file only if dedup logic is extracted into its own module.

- same session imported twice produces only one conversation row
- session with changed `sourceFilePath` (moved file) updates the path without creating duplicate
- session with same ID but different source (e.g., both claude_code and copilot have same UUID) creates separate rows

### Integration Tests (`tests/integration/`)

#### 8. Database Import Round-Trip (`cli-history-db.integration.test.ts`)

- persists and reloads imported conversations without losing import metadata (`sourceFilePath`, `hydratedAt`, `importMeta.autoNamed`)
- `getUserConversations` returns imported sessions mixed with native, ordered by `updated_at`
- `getUserConversations` excludes hidden imported sessions when import is disabled
- `getUserConversations` returns imported names/workspaces available for client-side metadata filtering before hydration
- `searchConversationMessages` finds hydrated imported sessions by message content
- `searchConversationMessages` does not return non-hydrated imported sessions for message-content queries

### Manual E2E Verification

These flows require real CLI history on disk and are documented as operator checklists here. Not automated in CI. If any flow becomes automated later, add a Playwright spec under `tests/e2e/specs/*.e2e.ts`.

Where feasible, these manual tests should be automated as **Playwright + Electron E2E specs** — the same approach used for file-attach testing (`tests/e2e/specs/file-attach.e2e.ts`), which uses `electronApp.evaluate()` for native dialog mocking and `page.screenshot()` for visual verification. See `docs/conventions/electron-e2e-testing.md` for techniques. Flows that require real agent round-trips or native OS interactions that can't be mocked remain as manual checklists.

#### 9. End-to-End Import Flow

- [ ] Enable Claude Code import in Settings > AgentCLI
- [ ] Verify sidebar populates with CLI sessions within 1-2 seconds
- [ ] Verify sessions show correct auto-generated titles (not raw filenames)
- [ ] Verify "CC" source badge appears on imported sessions
- [ ] Click an imported session -> verify skeleton loading -> transcript renders
- [ ] Verify send box is hidden and "Resume this session" button is visible
- [ ] Click "Resume this session" -> verify live ACP session starts
- [ ] Enable Copilot import -> click an imported Copilot session -> verify resume works
- [ ] Set Step 1 default to Terminal -> click "Resume this session" -> verify terminal resume opens
- [ ] Force a resume failure (auth/cwd mismatch) -> verify a clear error is shown and the transcript stays read-only
- [ ] Rename an imported session -> disable import -> re-enable -> verify rename preserved
- [ ] Delete an imported session -> verify CLI JSONL file still exists on disk
- [ ] Continue a session in terminal -> reopen in AionUI -> verify new messages appear (mtime re-hydration)

#### 10. Sidebar Volume (Manual)

- [ ] Import 50+ sessions → verify sidebar truncates sections with "Show N more"
- [ ] Expand a truncated section → verify all items appear
- [ ] Use source filter dropdown → verify correct filtering
- [ ] Use search bar -> verify instant title and workspace filtering
- [ ] On mobile/WebUI → verify filter collapses to icon button

#### 11. Full History View (Manual)

- [ ] Click "View all history" -> verify full-screen panel opens
- [ ] Verify source chips, workspace filter, date range filter work
- [ ] Search for a session by name -> verify results
- [ ] Search for a session by workspace name -> verify results
- [ ] Sort by name -> verify order changes from default date sort
- [ ] Scroll through 100+ sessions -> verify smooth virtual scrolling / pagination
- [ ] Verify "Some sessions not yet indexed for message search" indicator when non-hydrated sessions exist
- [ ] Click a session from history view -> verify it opens in transcript mode
