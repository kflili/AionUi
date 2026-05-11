# Plan: CLI History Importer — Phase 1 (Metadata Index)

**Date:** 2026-05-10
**Status:** Active — implementation in progress on `feat/cli-history-importer-phase1`
**Scope:** Phase 1 only (metadata indexing). Phase 2 (message hydration) is a separate item.
**Parent design:** `docs/plans/2026-03-19-cli-history/plan.md`

This plan is the _implementation_ spec for Phase 1 of the parent design. It maps the design's Phase 1 requirements (parent §§ "Two-Phase Import Strategy" lines 80–116, "Done Means → CLI History Import" lines 437–451, "Test Plan §1 Phase 1 + §7 Dedup" lines 471–512 + 562–568) to specific files, function signatures, and test cases in the existing codebase.

## Context

The shared CLI-history infrastructure already exists on `main` (`src/process/cli-history/types.ts`, `providers/{claude,copilot}.ts`, `converters/*`). The metadata-import orchestrator does not. Without it, discovered CLI sessions never appear as `conversations` rows, so the rest of the design (transcript mode, source badges, sidebar filters, full-history view) has nothing to render.

Phase 1's value is "instant sidebar population." Reading the providers' native indexes (Claude Code's `sessions-index.json`, Copilot's `session-store.db`) and writing one `conversations` row per discovered session is enough to make the sessions browseable. Messages are deferred to Phase 2 (on first open).

## Objectives

- Add a Phase-1 orchestrator that scans registered providers and upserts `conversations` rows.
- Wire IPC so the renderer can trigger scans, disable a source, and re-enable it.
- Wire app-launch incremental sync so newly created CLI sessions appear without a manual toggle (parent "Done Means" line 444).
- Add per-CLI import toggles (Claude Code + Copilot — Codex deferred to V2) to the existing Settings → AgentCLI panel.
- Make `getUserConversations` filter out rows whose `extra.importMeta.hidden === true`, so disable/re-enable is end-to-end functional in this PR (parent line 448).
- Cover the design's Phase-1-applicable test rows at `tests/unit/cli-history/importer.test.ts`.
- Leave a stub `hydrateSession()` export so the Phase 2 item has a clean integration surface.

Non-objectives (explicit, out of scope for this PR):

- Phase 2 message hydration (item 2).
- Codex provider / Codex toggle (deferred to V2 per parent line 437).
- Converters (`converters/*`) — Phase 2 territory (item 2).
- Transcript-mode UI (`AcpChat.tsx`, `AcpSendBox.tsx` — item 3).
- Source-badge rendering on `ConversationRow.tsx` (item 4).
- Sidebar truncation / filter / search (items 5/6).
- Full-history view page (`src/renderer/pages/history/` — item 9).
- DB schema migration. The existing schema already supports imported sessions (parent §"DB schema compatibility" lines 65–74); only TypeScript type widening + a JSON-extract filter clause are needed.

## Approach

Six contained changes, no schema migration, no new database column:

1. **Type widening** — Extend the `acp` variant of `TChatConversation` in `src/common/config/storage.ts` with optional `sourceFilePath?: string`, `importMeta?: { autoNamed: boolean; generatedName?: string; hidden?: boolean }`. `source` is already extensible per the parent design (`ConversationSource = ... | (string & {})`); we start using `'claude_code'` and `'copilot'` as values.

2. **Orchestrator** — `src/process/cli-history/importer.ts` (NEW). Exports `discoverAndImport(source)`, `discoverAndImportAll(sources?)`, `disableSource(source)`, `reenableSource(source)`, `hydrateSession(id)` (throws). Persists rows by going directly through `getDatabase()` (`AionUIDatabase`) only, NOT through `ConversationServiceImpl` and NOT through `SqliteConversationRepository`. After every successful insert/update, emits a **newly added** `emitConversationListChanged(conversation, action)` helper (see step 1.5 — moved to its own module to avoid a circular import).

3. **List-filter consumption — filtered everywhere except a new importer-private path**:
   - `SqliteConversationRepository.getUserConversations()` (`src/process/services/database/index.ts:607`) gains the malformed-JSON-safe filter on both the SELECT and the matching `COUNT(*)`: `AND (CASE WHEN json_valid(extra) THEN COALESCE(json_extract(extra, '$.importMeta.hidden'), 0) = 0 ELSE 1 END)`. Pagination stays consistent because total + page rows use the same WHERE.
   - **`SqliteConversationRepository.listAllConversations()` stays as-is** (delegates to `getUserConversations` → filtered). Other consumers (`conversationBridge.getAssociateConversation()`, etc.) keep getting hidden-aware results — disabled imported rows do not leak into the associated-conversations dropdown or other surfaces.
   - Add an **importer-private** method on `AionUIDatabase` (the `getDatabase()` class in `src/process/services/database/index.ts`): `getImportedConversationsIncludingHidden(sources: SessionSourceId[]): IQueryResult<TChatConversation[]>`. This runs an unfiltered SELECT scoped to `source IN (...)` so dedup, disable, and re-enable can still match hidden rows. Do NOT expose this method on `IConversationRepository` — it is importer-specific and stays off the general conversation repository surface.
   - The importer's dedup index uses ONLY `getImportedConversationsIncludingHidden(['claude_code', 'copilot'])`. Sidebar/timeline keeps using filtered `getUserConversations`.

4. **IPC** — Extend the existing `cliHistory` namespace in `src/common/adapter/ipcBridge.ts` and the handlers in `src/process/bridge/cliHistoryBridge.ts`. Match the existing kebab-case channel-naming convention: `cli-history.scan`, `cli-history.disable-source`, `cli-history.reenable-source`, `cli-history.scan-all`.

5. **Settings UI** — Add two `PreferenceRow` + `Switch` rows to `AgentCliModalContent.tsx` (Claude Code, Copilot). On toggle, persist the boolean to `agentCli.config` AND call the corresponding IPC. Errors from the IPC roll the toggle back and surface `Message.error(...)`. i18n keys go under the existing `settings.terminalWrapper.*` namespace in every locale's `settings.json` — no new module added, no `i18n-config.json` change, no per-locale `cliHistory.json` files.

6. **App-launch incremental sync** — `src/process/bridge/index.ts` (where `initCliHistoryBridge()` is called at line 79) gains a follow-up `void initCliHistoryImporter()` call. That helper reads `agentCli.config` from the process config, and for each enabled source calls `discoverAndImportAll(enabledSources)` directly (NOT through IPC — IPC is for renderer-driven scans). Errors are caught + logged but never thrown. The bridge init must remain effectively synchronous (it's synchronous today), so the helper returns void and uses fire-and-forget.

### Loading-state contract (item-0 lesson)

PR #17 was bot-flagged P1 for returning `undefined` from an async hook for both "still loading" and "loaded but empty." This plan's UI surface uses two async signals: the per-source enabled flag from `agentCli.config` (already gated through `useAgentCliConfig() === undefined`, see `AgentCliModalContent.tsx:62`), and the IPC scan result for the toggle action. Both have well-defined tri-states:

- `agentCli.config`: `undefined` (loading) → `AgentCliConfig` (loaded; may have `importClaudeCode === undefined` meaning "loaded but not yet enabled"). The existing component already gates render on `config === undefined`. ✅
- IPC `scan` action: returns `IBridgeResponse<ImportResult>` (success+data | failure+msg). No tri-state because it's a one-shot RPC.

If a future iteration adds a "scan-in-flight" spinner (not in this PR), it MUST use a separate `isScanning: boolean` flag rather than overloading `undefined`. Calling this out so subsequent items don't repeat PR #17's pattern.

### Schema mapping (one row per imported session)

`TChatConversation` has NO `user_id` field on the type itself (verified — `IChatConversation` shape at `src/common/config/storage.ts:207` carries `createTime`, `modifyTime`, `name`, `desc?`, `id`, `type`, `extra`, `model`, `status?`, `source?`, `channelChatId?`). The SQLite layer supplies `user_id = 'system_default_user'` internally via `defaultUserId` in `SqliteConversationRepository`.

For each `SessionMetadata` returned by a provider, the orchestrator builds an `acp`-variant `TChatConversation`:

| `TChatConversation` field   | Value                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------- | --- | ----------- |
| `id`                        | New UUID (NOT the session id — keeps native + imported namespaces separate)               |
| `type`                      | `'acp'`                                                                                   |
| `source`                    | `metadata.source` (`'claude_code'` or `'copilot'`)                                        |
| `name`                      | `buildAutoName(metadata)` (see Auto-naming below)                                         |
| `createTime`                | `Date.parse(metadata.createdAt)                                                           |     | Date.now()` |
| `modifyTime`                | `Date.parse(metadata.updatedAt)                                                           |     | Date.now()` |
| `extra.backend`             | `'claude'` for `claude_code`, `'copilot'` for `copilot` (the existing `AcpBackend` value) |
| `extra.workspace`           | `metadata.workspace`                                                                      |
| `extra.acpSessionId`        | `metadata.id`                                                                             |
| `extra.acpSessionUpdatedAt` | `Date.parse(metadata.updatedAt)`                                                          |
| `extra.sourceFilePath`      | `metadata.filePath`                                                                       |
| `extra.messageCount`        | `metadata.messageCount` (optional — present for Claude Code via `sessions-index.json`)    |
| `extra.importMeta`          | `{ autoNamed: true, generatedName: <the auto-name we just produced>, hidden: false }`     |
| `extra.pinned`              | `false`                                                                                   |

`generatedName` is the source-of-truth for "was this name auto-generated?". On re-sync:

```ts
const priorGeneratedName = existing.extra?.importMeta?.generatedName;
const wasAutoNamed =
  existing.extra?.importMeta?.autoNamed === true &&
  typeof priorGeneratedName === 'string' &&
  priorGeneratedName.trim().length > 0 &&
  existing.name === priorGeneratedName;
```

If `wasAutoNamed`, update both `name` and `importMeta.generatedName` to the fresh auto-name; otherwise preserve `name`, set `autoNamed: false`, and do not advance `generatedName`. Rows with missing or empty `generatedName` (e.g., legacy data before this PR) are treated as user-named for safety. The remaining edge — user renames to exactly the current `generatedName` while `autoNamed === true` — is documented as acceptable; if the provider's metadata never changes, the auto-name would not be regenerated anyway.

### Persistence semantics (extras merge — never replace; DB failures surfaced; preserve modifyTime)

Importer write paths go directly through `getDatabase()` (`AionUIDatabase`) only, NOT through `ConversationServiceImpl` and NOT through `SqliteConversationRepository`. Inserts call `getDatabase().createConversation(...)`. **Updates / disable / re-enable do NOT call `getDatabase().updateConversation(...)`**, because that method force-stamps `modifyTime = Date.now()` (`src/process/services/database/index.ts:648`) — which would reorder imported rows on every startup scan or toggle. Add an importer-private method `AionUIDatabase.updateImportedConversation(conversation: TChatConversation): IQueryResult<TChatConversation>` (NOT on `IConversationRepository`) that serializes via `conversationToRow` and updates `name`, `extra`, `model`, `status`, `source`, `channel_chat_id`, `updated_at` using the caller-supplied `conversation.modifyTime`. Importer sets:

- Sync updates: `modifyTime = Date.parse(metadata.updatedAt) || existing.modifyTime`
- Disable / re-enable (hidden flag only): `modifyTime = existing.modifyTime` (preserves order)
- Skip no-op updates (e.g., re-enable on a row whose `hidden` was already false).

For every update, build `partial.extra` manually as `{ ...existing.extra, ...providerOwnedUpdates, importMeta: { ...existing.extra?.importMeta, ...importMetaUpdates } }`. Pin state (`pinned`, `pinnedAt`), `presetRules`, `customWorkspace`, `enabledSkills` are never touched.

After every persistence call, inspect `result.success`. Only on `true` do we (a) increment `imported` / `updated` / `hidden` counters and (b) call `emitConversationListChanged(conversation, 'created' | 'updated' | 'deleted')`. On `false`, append `{ sessionId: metadata.id, message: result.error ?? 'Unknown database error' }` to `ImportResult.errors` and continue to the next session.

### Deduplication (parent §"Edge Cases → Deduplication", lines 244–254)

Primary key: `source + extra.acpSessionId`. Fallback: `source + extra.sourceFilePath` when `acpSessionId` is missing. The orchestrator builds an in-memory `Map<dedupKey, TChatConversation>` from `getDatabase().getImportedConversationsIncludingHidden(['claude_code', 'copilot']).data ?? []` (importer-private unfiltered read — hidden rows INCLUDED, so re-enable can match them). For each discovered session:

- If a matching row exists → **update** provider-owned fields (`extra.acpSessionUpdatedAt`, `extra.workspace`, `extra.sourceFilePath`, `extra.messageCount`, `modifyTime` per persistence semantics). Use the `generatedName` check above to decide whether to refresh `name`. NEVER touch `extra.pinned` / `extra.pinnedAt`. Skip the write if no field actually changed.
- If no match → **insert** a new row.

Concurrent scan calls are serialized via a per-source in-flight `Promise` cache (`Map<SessionSourceId, Promise<ImportResult>>`). A second call while one is in flight returns the existing promise. The map entry is deleted in `finally` so the next call can start a fresh scan; this avoids the race window where a third caller finds the map empty mid-cleanup.

### Auto-naming (parent §"Auto-Naming", lines 177–183) — source-aware

`buildAutoName(metadata)` picks the title candidate by source because the provider semantics differ:

- **Claude Code (`source: 'claude_code'`)**: use `metadata.firstPrompt` first; fall back to `metadata.title` only if `firstPrompt` is empty AND `title` is meaningful (see "meaningful" below).
- **Copilot (`source: 'copilot'`)**: use `metadata.title`, treating any of these as missing: empty string, `'(untitled)'`, raw filename patterns (matches `^[a-z0-9_]+_\d{4}_\d{2}_\d{2}_\d{6}$` etc.), UUID-like strings (matches `^[0-9a-f]{8}-[0-9a-f]{4}-...$`).

If no meaningful candidate remains, fall back to `"<relative-time> · <workspace-basename>"`. Relative-time uses a small inline helper (e.g., `"just now"`, `"5 min ago"`, `"2 hours ago"`, `"3 days ago"`); no new dependency.

When a candidate exists:

1. Trim and truncate to 60 characters.
2. Append ` · <workspace-basename>` for disambiguation (using `path.basename(metadata.workspace)`).
3. The combined final string may exceed 60 chars by the workspace suffix — that's intentional and matches the parent design's `"fix auth bug · my-project"` example.

The returned string is also stored as `extra.importMeta.generatedName` (the snapshot for rename detection).

### Disable / re-enable (parent §"Disable/Re-enable", lines 225–237, "Done Means" line 448)

Disable: for every imported row whose `source` matches AND `extra.importMeta` exists AND `extra.importMeta.hidden !== true`, call `getDatabase().updateImportedConversation(updated)` (the importer-private method that preserves caller-supplied `modifyTime` — see Persistence semantics). Build `updated` as `{ ...existing, modifyTime: existing.modifyTime, extra: { ...existing.extra, importMeta: { ...existing.extra.importMeta, hidden: true } } }`. Emit `listChanged` per successful write. SQLite rows preserved; user renames + pin state untouched.

Re-enable: for every imported row whose `source` matches AND `extra.importMeta?.hidden === true`, set `hidden: false` via the same merge pattern (preserving `modifyTime`); emit `listChanged`. Then call `discoverAndImport(source)` to pick up sessions created while disabled.

`AionUIDatabase.getUserConversations()` is updated to filter via `CASE WHEN json_valid(extra) THEN COALESCE(json_extract(extra, '$.importMeta.hidden'), 0) = 0 ELSE 1 END`. `SqliteConversationRepository.listAllConversations()` remains unchanged and therefore stays hidden-aware through its existing `getUserConversations()` delegation — other consumers (`conversationBridge.getAssociateConversation()`, etc.) keep their semantics. Importer dedup, disable, and re-enable use the new `getImportedConversationsIncludingHidden()` path instead.

## Implementation Steps

1. **Widen `TChatConversation` + add `ImportResult` type** — edit `src/common/config/storage.ts` to add `sourceFilePath?: string`, `importMeta?: { autoNamed: boolean; generatedName?: string; hidden?: boolean }`, `messageCount?: number` on the `acp` variant's extras object. Single-file change, no runtime effect on existing rows. Also add to `src/process/cli-history/types.ts`:
   ```ts
   export type ImportResult = {
     imported: number;
     updated: number;
     skipped: number;
     errors: Array<{ sessionId: string; message: string }>;
   };
   ```
   so it can be imported type-only from both `importer.ts` and `ipcBridge.ts`.

1.5. **Export `emitConversationListChanged` via a dedicated shared module** — Do NOT export this helper from `conversationBridge.ts`: that file already imports `isSessionIdle` from `cliHistoryBridge.ts`, so importing back from `conversationBridge.ts` into `importer.ts` (which is loaded from `cliHistoryBridge.ts`) would create a real cycle. Instead:

- Create `src/process/bridge/conversationEvents.ts` with the single export:
  ```ts
  import { ipcBridge } from '@/common';
  import type { TChatConversation } from '@/common/config/storage';
  export function emitConversationListChanged(
    conversation: Pick<TChatConversation, 'id' | 'source'>,
    action: 'created' | 'updated' | 'deleted'
  ): void {
    ipcBridge.conversation.listChanged.emit({
      conversationId: conversation.id,
      action,
      source: conversation.source || 'aionui',
    });
  }
  ```
- Update `conversationBridge.ts:65-74` to import + use this helper instead of the local closure.
- Import the helper from `src/process/cli-history/importer.ts`.

2. **Add `hidden` filter, importer-private unfiltered read, importer-private mtime-preserving update** — edit `src/process/services/database/index.ts`:
   - In `getUserConversations()`, append the malformed-JSON-safe filter (`CASE WHEN json_valid(extra) THEN COALESCE(json_extract(extra, '$.importMeta.hidden'), 0) = 0 ELSE 1 END`) to both the SELECT (line ~617-625) and the COUNT (line ~611-615) for pagination consistency.
   - Add `getImportedConversationsIncludingHidden(sources: SessionSourceId[]): IQueryResult<TChatConversation[]>` — unfiltered SELECT scoped to `source IN (?, ?)` parameterised. Importer-private; not added to `IConversationRepository`. Import `SessionSourceId` type-only from `@process/cli-history/types`.
   - Add `updateImportedConversation(conversation: TChatConversation): IQueryResult<TChatConversation>` — importer-only update that serializes via `conversationToRow` and uses caller-supplied `conversation.modifyTime` for `updated_at` (does NOT force `Date.now()`). Not on `IConversationRepository`.
   - `SqliteConversationRepository.listAllConversations()` stays as-is.
   - Add fixture tests: "hidden rows excluded from `getUserConversations`", "hidden rows included in `getImportedConversationsIncludingHidden`", "hidden rows still excluded from `listAllConversations` (via filtered delegation)", "`updateImportedConversation` preserves caller-supplied `modifyTime`".

3. **Write `src/process/cli-history/importer.ts`** (NEW):
   - Module-level `providerRegistry: Map<SessionSourceId, SessionSourceProvider>` initialized with `ClaudeCodeProvider` + `CopilotProvider` instances (singletons — instantiated once at module load).
   - Module-level `inFlight: Map<SessionSourceId, Promise<ImportResult>>` for concurrent-call coalescing.
   - `export async function discoverAndImport(source: SessionSourceId): Promise<ImportResult>` — coalesces concurrent calls; failures from one provider isolated.
   - `export async function discoverAndImportAll(sources?: SessionSourceId[]): Promise<Partial<Record<SessionSourceId, ImportResult>>>` — invokes `discoverAndImport` for each source, catches per-source errors so one provider failing doesn't crash siblings. Default = all registered sources. Return type is `Partial<Record<...>>` because the caller may pass a subset; only requested sources appear in the result.
   - `export async function disableSource(source: SessionSourceId): Promise<{ hidden: number }>` — flips `hidden` flag on existing rows, emits `listChanged`.
   - `export async function reenableSource(source: SessionSourceId): Promise<ImportResult>` — unflips `hidden`, then runs `discoverAndImport`.
   - `export async function hydrateSession(_conversationId: string): Promise<never>` — throws `Error('hydrateSession not implemented in Phase 1')`. Stub for item 2's wire-up.
   - Internal `buildConversationRow(metadata, existing?)` — pure function, easy to unit-test.
   - Internal `buildAutoName(metadata, now = Date.now())` — pure function, unit-tested in isolation.
   - Internal `dedupKey(source, acpSessionId?, sourceFilePath?)` — pure function.
   - Re-export `ImportResult` from `src/process/cli-history/types.ts` (see step 0 below) so `ipcBridge.ts` can import it type-only without pulling in importer module-level code.

4. **Wire IPC**:
   - Add to `cliHistory` namespace in `src/common/adapter/ipcBridge.ts`:
     ```ts
     scan: bridge.buildProvider<IBridgeResponse<ImportResult>, { source: SessionSourceId }>('cli-history.scan'),
     scanAll: bridge.buildProvider<IBridgeResponse<Partial<Record<SessionSourceId, ImportResult>>>, { sources?: SessionSourceId[] }>('cli-history.scan-all'),
     disableSource: bridge.buildProvider<IBridgeResponse<{ hidden: number }>, { source: SessionSourceId }>('cli-history.disable-source'),
     reenableSource: bridge.buildProvider<IBridgeResponse<ImportResult>, { source: SessionSourceId }>('cli-history.reenable-source'),
     ```
   - `scanAll` is exposed for manual / dev / full-refresh consumers (e.g., a future "Refresh imported sessions" button). App-launch sync does NOT depend on it — startup calls `discoverAndImportAll()` directly in-process.
   - Register handlers in `src/process/bridge/cliHistoryBridge.ts → initCliHistoryBridge()`. Wrap each in try/catch returning `{ success: false, msg }` on error (matches existing `convertSessionToMessages` pattern at line 197).

5. **App-launch sync** — `src/process/bridge/index.ts` line 79 area: after `initCliHistoryBridge()`, add a non-blocking call to a new helper (defined in `importer.ts` or a thin sibling) that reads `agentCli.config` enabled flags and fires `discoverAndImportAll(enabledSources)`. Failures are logged, not thrown. No await — the bridge init must remain synchronous-ish (it's already synchronous today).

6. **Settings toggles** — edit `AgentCliModalContent.tsx`:
   - Read `config.importClaudeCode` and `config.importCopilot` (new boolean fields on `AgentCliConfig` — add to type declaration in `useAgentCliConfig` hook).
   - Two new `PreferenceRow` rows after the existing `Copilot Gateway` row.
   - Add a sibling `saveConfigAwaitable` helper alongside the existing `saveConfig` (do NOT modify or wrap the existing `saveConfig` — it is intentionally fire-and-forget and is used by other handlers that don't need rollback). Sketch:
     ```ts
     const saveConfigAwaitable = useCallback(async (updates: Partial<AgentCliConfig>) => {
       const previous = configRef.current;
       const next = { ...previous, ...updates };
       configRef.current = next;
       try {
         await ConfigStorage.set('agentCli.config', next);
         return { previous, next };
       } catch (error) {
         if (configRef.current === next) configRef.current = previous;
         throw error;
       }
     }, []);
     ```
   - Track per-source pending state (`useState<Record<SessionSourceId, boolean>>({ claude_code: false, copilot: false })`). Disable the corresponding `<Switch>` while its persist + IPC + rollback flow is in flight, so rapid toggling cannot interleave persist/rollback paths.
   - On toggle `true`: set pending, `await saveConfigAwaitable({ importClaudeCode: true })`. On persist failure → `Message.error(t('settings.terminalWrapper.cliHistoryEnableFailed'))`, clear pending, return. On persist success → `await ipcBridge.cliHistory.reenableSource.invoke({ source: 'claude_code' })`. On IPC failure → revert via `saveConfigAwaitable({ importClaudeCode: false })` AND show `Message.error(...)`. Finally clear pending.
   - On toggle `false`: same pattern with `disableSource` IPC and inverted rollback.
   - i18n: add new keys under `settings.terminalWrapper.*` in every locale's `settings.json` (6 files): `cliHistoryClaudeCodeLabel`, `cliHistoryClaudeCodeDesc`, `cliHistoryCopilotLabel`, `cliHistoryCopilotDesc`, `cliHistoryEnableFailed`, `cliHistoryDisableFailed`. Run `bun run i18n:types` and `node scripts/check-i18n.js` (both verified to exist).

7. **Tests** — `tests/unit/cli-history/importer.test.ts`:
   - Mock the database layer (`getDatabase()` or the repository instance) and the provider registry via Vitest module mocks (`vi.mock`).
   - Pure-function tests for `buildAutoName` and `buildConversationRow` and `dedupKey` (no mocks needed).
   - Orchestrator tests covering the rows in "Test Coverage" below.
   - For the `getUserConversations` hidden-filter test: add to `tests/unit/databaseBridge.test.ts` (or similar) using a real in-memory better-sqlite3 instance to verify the SQL clause.

8. **Pre-commit gates** — Run `bun run lint:fix && bun run format && bunx tsc --noEmit && bun run test` locally. All four must pass before pushing.

9. **Δ18 mitigation (WIP commits)** — Commit after each major milestone:
   - Type widening + `hidden`-filter in `getUserConversations`.
   - Importer skeleton + auto-name helper + dedup logic.
   - IPC wire + app-launch sync.
   - Settings UI + i18n.
   - Tests.

## Success Criteria

- `bun run lint:fix && bun run format && bunx tsc --noEmit && bun run test` all pass on `feat/cli-history-importer-phase1`.
- `tests/unit/cli-history/importer.test.ts` exists, covers the rows below, and meets the AGENTS.md ≥ 80% coverage target on `src/process/cli-history/importer.ts`.
- `getUserConversations` returns `hidden: false`/missing rows only (verified by added test).
- App startup with `importClaudeCode: true` in `agentCli.config` triggers an automatic scan visible in logs; rows appear in sidebar without manual toggle.
- PR #N opens against `kflili/AionUi:main`, bot review (codex + copilot) ends clean, all review threads resolved.
- `/complete-pr` lands the merge; `main` synced locally.
- Item 2's task-prompt finds `hydrateSession()` exported and throwing — clean integration surface.

### Test Coverage (mapped to parent design Test Plan §1 + §7)

**Phase 1: Metadata Import**

- imports Claude Code sessions with `firstPrompt` as title
- imports Copilot sessions with `summary` (via `SessionMetadata.title`) as title
- skips already-imported sessions (dedup by `source + acpSessionId`)
- incremental sync refreshes `acpSessionUpdatedAt`/`workspace`/`sourceFilePath`/`messageCount` without overwriting user-renamed `name` (`generatedName` mismatch path)
- incremental sync preserves `pinned` and `pinnedAt` (verified via Object equality after re-sync)
- concurrent `discoverAndImport(source)` calls do not duplicate rows (in-flight Promise coalescing)
- handles provider returning empty session list gracefully (`imported: 0`, no throw)
- one provider throwing does not crash another (`discoverAndImportAll` resilience)

**Auto-Naming (Phase-1-applicable subset only)**

- uses Claude Code `firstPrompt` as title when present
- uses Copilot `summary` (via `metadata.title`) as title when present
- falls back to `"<relative-time> · <workspace>"` when both provider titles are empty
- treats Copilot `'(untitled)'` and UUID-like / raw-filename strings as missing (uses fallback)
- truncates the title candidate to 60 chars before appending the workspace
- appends workspace basename for disambiguation: `"topic · project-name"`
- never uses raw filenames or UUID-like identifiers as the unmodified title

**Disable / Re-enable**

- disabling sets `extra.importMeta.hidden = true` on every matching row without deleting
- re-enabling sets `hidden = false` and preserves prior renames + pins
- re-enabling triggers an incremental scan for new sessions
- `getUserConversations` excludes rows with `hidden = true` (database test)

**§7 Deduplication & Sync (consolidated into the importer suite)**

- same session imported twice → exactly one conversation row
- session whose `sourceFilePath` changed → row updates without duplicate
- two providers producing rows with the same UUID → two separate rows (different `source`)
- dedup falls back to `source + sourceFilePath` when `acpSessionId` is missing

## Risks & Mitigations

- **Risk:** `TChatConversation` `acp` variant type widening lands unused fields if items 2–9 take longer than planned.
  **Mitigation:** Fields are all optional. Zero runtime effect on native ACP conversations until populated.

- **Risk:** Adding the `json_extract` filter could fail on databases with malformed `extra` columns; `json_extract` raises in some SQLite builds and returns NULL in others.
  **Mitigation:** Guard via `CASE WHEN json_valid(extra) THEN COALESCE(json_extract(extra, '$.importMeta.hidden'), 0) = 0 ELSE 1 END`. `json_valid` exists in better-sqlite3's bundled SQLite (verified via runtime check during plan review). Note: the SQL guard prevents the SELECT/COUNT from failing on malformed rows, but downstream `rowToConversation()` would still throw when it tries to `JSON.parse(row.extra)`. Malformed `extra` is pre-existing database-corruption behavior; this PR does not change it — the guard only ensures the hidden filter itself is non-destructive. Tests cover valid-JSON rows (with and without `importMeta.hidden`); malformed-row handling stays out of scope.

- **Risk:** Direct repository calls bypass `ConversationServiceImpl` lifecycle and could miss future side-effects (e.g., new emitters added there).
  **Mitigation:** Document the choice in `importer.ts` doc comment with reasoning. We explicitly call `emitConversationListChanged()` for the only side-effect the renderer cares about. If `ConversationServiceImpl` grows new behaviours later, they belong in the rename / chat-send flow, not the imported-metadata flow.

- **Risk:** App-launch sync runs disk I/O on the hot startup path.
  **Mitigation:** Non-blocking (`void discoverAndImportAll(...)`), no await in `initCliHistoryImporter()`. Errors logged, never thrown. Worst case: imported rows appear a few hundred ms later than native rows.

- **Risk:** Bot reviewers (codex/copilot) push back on dedup key choice (id vs. filePath fallback), the disabled-but-hidden semantics, or auto-naming priority.
  **Mitigation:** All three behaviours are dictated by the parent design (lines 244–254, 225–237, 177–183). Reply to comments with the design-doc reference; only iterate if the reviewer surfaces a genuine bug.

- **Risk:** Toggle UX (enable → instant scan) feels heavy with hundreds of sessions.
  **Mitigation:** Parent design line 90: "near-instant — reading 200 index entries typically completes in under a second." Scan is metadata-only, no JSONL parsing.

- **Risk:** Item-0 lesson — "loaded but empty" vs "still loading" — could resurface if the UI grows an in-flight indicator before this PR ships.
  **Mitigation:** Explicit note in "Loading-state contract" section above.

- **Risk:** Bot reviews take 5+ rounds (item-0 hit 5).
  **Mitigation:** Use `/fix-pr-feedback-loop`. Push promptly after each fix. `/push-resolve` for reply-then-resolve. Force-progress condition per task-prompt.

## Dependencies

- Shared `SessionSourceProvider` infra on `main` — verified in `src/process/cli-history/types.ts`, `providers/base.ts`, `providers/claude.ts`, `providers/copilot.ts`.
- Existing `getDatabase()` API with `createConversation` / `getUserConversations` — verified in `src/process/services/database/index.ts`. **No `listAllConversations()` on `getDatabase()` directly**; that method lives on `SqliteConversationRepository` and remains filtered through `getUserConversations`. This PR adds importer-private `getImportedConversationsIncludingHidden(...)` and `updateImportedConversation(...)` methods to `AionUIDatabase` (not on `IConversationRepository`).
- `emitConversationListChanged` does NOT exist as an exported helper today — it is a local closure in `src/process/bridge/conversationBridge.ts:65-74`. This PR moves it to a new module `src/process/bridge/conversationEvents.ts` (see Implementation Step 1.5) to avoid a circular import.
- Existing `ipcBridge.cliHistory` namespace + `initCliHistoryBridge()` boot path — verified in `src/process/bridge/cliHistoryBridge.ts:188` and `src/process/bridge/index.ts:79`.
- Existing `useAgentCliConfig()` + `ConfigStorage.set('agentCli.config', ...)` pattern — verified in `AgentCliModalContent.tsx:33, 54`.
- Existing per-locale `settings.json` with `settings.terminalWrapper` namespace — verified at `src/renderer/services/i18n/locales/en-US/settings.json:661`.

## Open Questions / Deferred Decisions

- **i18n type-gen command** — `bun run i18n:types` exists and `scripts/check-i18n.js` exists (verified). Run both after editing locale files. **(R1 — fix-in-PR.)**
- **Channel-scoped / search list queries** — `searchConversationMessages` operates on `messages` table (hydrated rows only). Since this PR does not hydrate messages, hidden imported rows never appear in message-content search results. Documented as out-of-scope for this PR; consumers that want to filter hidden rows from hydrated-search results will need to revisit when Phase 2 hydration lands. **(R3 — out of scope, destination: item 2 / item 9 search work, when: before V1 ships.)**
