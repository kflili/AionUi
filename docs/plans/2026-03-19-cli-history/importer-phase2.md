# Plan: CLI History Importer — Phase 2 (On-Demand Message Hydration)

**Date:** 2026-05-11
**Status:** Active — implementation in progress on `feat/cli-history-importer-phase2`
**Scope:** Phase 2 only (on-demand message hydration + Phase-2 auto-name upgrade). Out of scope: transcript-mode UI (item 3), export-triggered hydration (item 7), resume gating (item 8), sidebar/badge/history (items 4/5/6/9).
**Parent design:** `docs/plans/2026-03-19-cli-history/plan.md`
**Phase 1 (predecessor):** `docs/plans/2026-03-19-cli-history/importer-phase1.md` (landed as PR #18, merged at `470b0813`).

This plan is the _implementation_ spec for Phase 2 of the parent design. It maps the parent's Phase 2 requirements (§§ "Phase 2: Message Hydration" lines 92–116, "Auto-Naming" lines 174–186, "Stale Data Handling" lines 207–222, "Edge Cases" lines 244–262, and "Test Plan §1 Phase 2 + Auto-Naming Phase-2 rows" lines 487–512) to specific files, function signatures, and test cases in the existing codebase.

## Context

Phase 1 (PR #18) landed the metadata-import orchestrator: a `conversations` row exists per discovered CLI session, but no `messages` rows yet. `hydrateSession()` is a stub that throws — kept deliberately as a clean integration surface for this PR.

Phase 2's value is the user-visible payoff: when the user opens a non-hydrated imported session, the JSONL transcript becomes browsable `TMessage[]` in the conversation-detail view, served from SQLite on every subsequent open. The expensive part (reading + parsing the JSONL) runs exactly once per session until the source file's `mtime` changes.

The converters (`src/process/cli-history/converters/claude.ts`, `converters/copilot.ts`) already exist on `main` and are item-1-stable callsites. They are pure functions `(lines: string[], conversationId?: string, options?) => TMessage[]` — Phase 2 just wires the orchestration: file-read → converter → batch-insert → metadata update.

Phase 2 also delivers the parent design's "Auto-Naming step 2" (lines 179–180): when a Phase-1-imported session has a generic title and the user has not renamed, upgrade the title using the first user message extracted from the JSONL during hydration.

## Objectives

- Replace the `hydrateSession(conversationId)` stub with a real implementation that:
  - reads the conversation row and its `extra.sourceFilePath`;
  - returns `'cached'` when prior hydration exists (`extra.hydratedAt > 0 || existing message count > 0`) and `mtime <= extra.hydratedAt`;
  - returns `'unavailable'` when the source file is missing/unreadable AND no prior hydration occurred;
  - returns `'cached'` with a warning when the source file is missing/unreadable AND prior hydration occurred, including successful zero-message hydrations (preserve cached transcript / cached empty state per parent line 251);
  - otherwise reads JSONL, calls the matching converter, batch-inserts `TMessage[]` rows, and updates `extra.hydratedAt`;
  - coalesces concurrent hydration requests for the same `conversationId` via an in-flight `Map<conversationId, Promise>`, so two callers (e.g. open + export) share one read+parse+insert pass.
- Add a Phase-2 title-upgrade helper (`upgradeTitleFromFirstUserMessage`) that:
  - runs only when `extra.importMeta.autoNamed === true` (never downgrades a manual rename);
  - extracts the first user-role `TMessage` from the freshly-hydrated batch;
  - truncates the candidate to 60 chars and appends ` · <workspace-basename>` (matches Phase-1 `buildAutoName` shape);
  - preserves a meaningful provider title that came from Phase 1 — do **not** overwrite a non-generic existing title with the first-user-message-derived title (only upgrade when the current title was generic / time-based / fallback per the parent design line 509 "does not downgrade").
- Wire an IPC route `cliHistory.hydrate` (channel `cli-history.hydrate`) returning `{ status: 'hydrated' | 'cached' | 'unavailable'; warningCount?: number; warning?: 'source_missing' }` so the future transcript-mode UI (item 3), export-triggered hydration (item 7), and resume gating (item 8) all share one call path.
- Cover the parent design's Phase-2-applicable test rows in the existing `tests/unit/cli-history/importer.test.ts` (extend, do NOT replace — keep the orchestrator suite cohesive per parent §7).

Non-objectives (explicit, out of scope for this PR):

- Transcript-mode renderer (`AcpChat.tsx`, `AcpSendBox.tsx`, `ChatConversation.tsx`) — item 3.
- Export code path (`useConversationActions.ts` export action) — item 7.
- Resume code path — item 8.
- Source badge / sidebar truncation / sidebar filter / full-history view — items 4, 5, 6, 9.
- Modifications to the existing converters — they are on `main` and are item-1-stable.
- Schema migration to the `messages` table — parent line 73: "no schema migration required."
- A "scan-in-flight" UI spinner — not in this PR; will be added by the transcript-mode UI consumer.

## Approach

Four contained changes, no schema migration, no new database column:

1. **Replace `hydrateSession()` stub** in `src/process/cli-history/importer.ts` with the real implementation. Reuse the in-flight coalescing primitive pattern from Phase 1's `discoverAndImport` (a `Map<key, Promise>` cleared in `finally`) — keyed by `conversationId` rather than by source.

2. **Add the Phase-2 title-upgrade helper** as an internal function in `importer.ts` (co-located rather than its own module — single call site, ~30 LoC). Pure logic for the "should upgrade?" decision is unit-testable in isolation.

3. **Extend the IPC surface** — add `cliHistory.hydrate` to the existing `cliHistory` namespace in `src/common/adapter/ipcBridge.ts`, and register the handler in `src/process/bridge/cliHistoryBridge.ts → initCliHistoryBridge()`. Match the existing kebab-case channel-naming convention (`cli-history.hydrate`) and the existing try/catch error shape (`IBridgeResponse<HydrateResult>` with `{ success: false, msg }` on throw).

4. **Database-side support** — two importer-private additions to `AionUIDatabase` in `src/process/services/database/index.ts`. The plan does NOT add a `getConversationById` — `AionUIDatabase.getConversation(conversationId)` already exists and is reused:
   - `getMessageCountForConversation(conversationId: string): IQueryResult<number>` — `SELECT COUNT(*) FROM messages WHERE conversation_id = ?`. Used to decide "already-hydrated?" cheaply. We compare against `extra.hydratedAt` for staleness, but a row with zero messages and no `hydratedAt` is the "never hydrated" path.
   - `insertImportedMessages(conversationId: string, messages: TMessage[]): IQueryResult<number>` — batch insert wrapped in a single `better-sqlite3` transaction. Returns the number of rows inserted. Must serialize each message via the existing `messageToRow` helper already imported in `src/process/services/database/index.ts` from `./types` (do not import from `export.ts` inside `index.ts` — that path would create a circular import). Column list: `id, conversation_id, msg_id, type, content, position, status, created_at` (no `updated_at` — verified absent from the `messages` schema). **Idempotency contract**: this method MUST `DELETE FROM messages WHERE conversation_id = ?` inside the same transaction before the INSERT loop (re-hydration replaces; never appends). The existing `deleteConversationMessages` and `insertMessage` helpers exist but are not wrapped in a transaction together — this method composes the atomic replace. Document the contract in the JSDoc.

   These two additions stay **off `IConversationRepository`** (importer-private, same pattern as `getImportedConversationsIncludingHidden` and `updateImportedConversation` in Phase 1).

### `hydrateSession` algorithm

```
hydrateSession(conversationId) -> HydrateResult:
  1. existing = inFlight.get(conversationId)
     if existing: return existing
  2. promise = (async () => runHydrate(conversationId))()
       .finally(() => inFlight.delete(conversationId) if still ours)
     inFlight.set(conversationId, promise)
     return promise

runHydrate(conversationId) -> HydrateResult:
  1. row = db.getConversation(conversationId)    // reuse existing AionUIDatabase method
     if !row.success or !row.data: throw — caller's contract violation, not "unavailable"
     conv = row.data
     extra = conv.extra ?? {}
  2. if !extra.sourceFilePath:
       throw — same as above; only imported rows are valid input
     if extra.importMeta?.hidden:
       throw — caller should re-enable first; not a hydration concern
     // Resolve the converter BEFORE any file I/O so an unsupported source
     // surfaces as a coding error instead of being masked by a stat/read race.
     converter = getConverterForSource(conv.source)
     if !converter:
       throw new Error(`Unsupported CLI history source for hydration: ${String(conv.source)}`)
  3. mtimeMs = await safeStatMtimeMs(extra.sourceFilePath)
     countResult = db.getMessageCountForConversation(conversationId)
     if !countResult.success: throw new Error(countResult.error ?? 'Failed to count imported messages')
     existingCount = countResult.data ?? 0
     hydratedAt = parseTimestampOr(extra.hydratedAt, 0)
     sourceFilePath = extra.sourceFilePath
     hydratedSourceFilePath =
       typeof extra.hydratedSourceFilePath === 'string'
         ? extra.hydratedSourceFilePath
         : sourceFilePath
     // "Prior hydration" = SOMETHING was written before AGAINST THE CURRENT PATH.
     // A session whose JSONL parses to zero renderable messages still gets
     // hydratedAt stamped — without the `OR existingCount > 0` check, that
     // session would re-hydrate on every open and return `unavailable` if the
     // source later disappeared. AND a Phase-1 scan can refresh
     // `extra.sourceFilePath` (when the dedup match is by acpSessionId but the
     // file moved); the path-equality check prevents reusing hydration state
     // from a different file.
     hasPriorHydration =
       (hydratedAt > 0 || existingCount > 0) &&
       hydratedSourceFilePath === sourceFilePath

     if mtimeMs === null:
       // source missing or unreadable
       if hasPriorHydration:
         return { status: 'cached', warning: 'source_missing', warningCount: 0 }
       return { status: 'unavailable', warning: 'source_missing' }

     if hasPriorHydration and mtimeMs <= hydratedAt:
       return { status: 'cached', warningCount: 0 }

  4. // read + parse
     readResult = await safeReadJsonl(extra.sourceFilePath)
     if readResult === null:
       // covers the race where the file disappears or becomes unreadable AFTER stat
       if hasPriorHydration:
         return { status: 'cached', warning: 'source_missing', warningCount: 0 }
       return { status: 'unavailable', warning: 'source_missing' }
     lines = readResult.split('\n')
     // warning counter is computed by counting malformed lines, NOT by trusting
     // the converter's `console.warn` side-effect. Use a thin wrapper here that
     // tries JSON.parse per non-empty line and increments a counter; pass
     // ONLY the parse-valid lines to the converter so the converter sees its
     // existing happy-path contract. This keeps converters/* untouched.
     [validLines, warningCount] = splitJsonlByValidity(lines)
     messages = converter(validLines, conversationId)

  5. insertResult = db.insertImportedMessages(conversationId, messages)  // deletes + inserts in one tx
     if !insertResult.success: throw new Error(insertResult.error ?? 'Failed to insert imported messages')
  6. // Re-read the row JUST BEFORE writing so a concurrent scan-write
     //   (refreshing acpSessionUpdatedAt/workspace/sourceFilePath/messageCount)
     // OR a concurrent manual rename (autoNamed flipped to false)
     // is preserved by the hydration write.
     freshResult = db.getConversation(conversationId)
     if !freshResult.success or !freshResult.data:
       throw — row deleted mid-hydration; caller surface concern
     fresh = freshResult.data
     freshExtra = fresh.extra ?? {}
     nextExtra = {
       ...freshExtra,
       hydratedAt: mtimeMs,
       hydratedSourceFilePath: sourceFilePath,
     }
     conv2 = { ...fresh, extra: nextExtra }

     // Re-evaluate autoNamed on the FRESH row, not the original snapshot.
     // If the user renamed between step 1 and step 6, freshExtra.importMeta.autoNamed
     // is false → skip the upgrade.
     if freshExtra.importMeta?.autoNamed === true and messages.length > 0:
       conv2 = upgradeTitleFromFirstUserMessage(conv2, messages)

     updateResult = db.updateImportedConversation(conv2)
     if !updateResult.success: throw new Error(updateResult.error ?? 'Failed to update imported conversation')
     emitConversationListChanged(conv2, 'updated')

  7. return { status: 'hydrated', warningCount }
```

Notes on the algorithm:

- **`safeStatMtimeMs(path)`** — wrap `fs.promises.stat(path)` in a try/catch; on `ENOENT` (and any other error: EACCES / EBUSY / EPERM) return `null`. Keep the helper local to `importer.ts` (single use site). Do NOT throw — surface as `null` so the user gets `unavailable` / `cached+warning` rather than an opaque exception that propagates out of the IPC layer.
- **`safeReadJsonl(path)`** — same shape as `safeStatMtimeMs` but wraps `fs.promises.readFile(path, 'utf8')`. Handles the race window where the source file becomes unreadable between stat (step 3) and read (step 4): ENOENT/EACCES/EBUSY/EPERM all map to `null` → callers fall back to the same `cached+warning` / `unavailable` paths as the stat-failure branch.
- **`splitJsonlByValidity(lines)`** — local helper: iterate lines, `trim()`, skip empty; try `JSON.parse(line)`; on success keep the original raw line for the converter, on parse failure increment `warningCount`. The converter's own `safeParseLine` will still operate on the valid subset (the converter currently logs+returns null for malformed; we're pre-filtering so the converter never sees them). This way the warning count reflects only JSON-syntax failures; lines that parse but are semantically irrelevant (e.g. `summary`, `file-history-snapshot`) are NOT counted as warnings — they are valid JSON, just not renderable.
- **`parseTimestampOr(input, fallback)`** — Phase 1's existing `parseDateOr(input: string | undefined, fallback)` returns the fallback for numeric inputs. Since Phase 2 stores `extra.hydratedAt` as the source JSONL `mtimeMs` observed before the successful read (a number), reading it back through `parseDateOr` would always yield `0` and trigger spurious re-hydration. Add a new sibling helper in `importer.ts`:
  ```ts
  function parseTimestampOr(input: unknown, fallback: number): number {
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input !== 'string') return fallback;
    const parsed = Date.parse(input);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  ```
  Keep `parseDateOr` in place for the Phase-1 string-only call sites (Claude/Copilot metadata timestamps are ISO strings); use `parseTimestampOr` only for `extra.hydratedAt`. Both helpers are unit-tested in the same suite.
- **Coalescing scope**: keyed by `conversationId`. Two open-callers race for the same session → one `runHydrate`. An open-caller and an export-caller (item 7) race for the same session → one `runHydrate`. Open-callers for two different sessions → two parallel `runHydrate`s (no shared lock). Eviction in `finally` ensures the next caller starts fresh.
- **Concurrency vs Phase-1 `discoverAndImport`**: hydration does NOT enqueue onto `operationChain` (the per-source operation chain). Hydration is per-conversation; scan/disable/reenable are per-source. They commute: a scan running concurrently with a hydration may update `extra.acpSessionUpdatedAt` on the same row, but the hydration's `updateImportedConversation` writes `extra.hydratedAt` + (optionally) `name`. **Step 6's re-read-before-write** loads the post-scan row and merges, so scan-supplied fields and manual renames between step 1 and step 6 are both preserved. The remaining lost-update window is the millisecond between step 6's re-read and the SQLite write, matching the scan's existing semantics (and acceptable because the event the renderer cares about — `listChanged` — is idempotent).

### Phase-2 title-upgrade rules

```
upgradeTitleFromFirstUserMessage(conv, messages):
  // Preconditions enforced by caller: extra.importMeta.autoNamed === true.
  // Find the first user-role text message; bail if none.
  firstUser = messages.find(m => m.type === 'text' && m.position === 'right')
  if !firstUser: return conv
  candidate = firstUser.content.content.trim()
  if candidate.length === 0: return conv

  // "Generic / time-based / fallback" detection — only upgrade these.
  // Concretely: if extra.importMeta.generatedName matches conv.name AND
  // (provider had no firstPrompt+title, OR autoName was relative-time fallback).
  // We detect "relative-time fallback" by the leading pattern from Phase 1's
  // relativeTime(): /^(just now|\d+ min ago|\d+ hours? ago|\d+ days? ago|\d+ months? ago|\d+ years? ago)/.
  // If conv.name does NOT start with one of those AND is not == generatedName,
  // it's a meaningful provider title — bail (do not downgrade).
  if !isFallbackOrGenericTitle(conv.name, conv.extra.importMeta.generatedName):
    return conv

  // Build the new title with the same shape as buildAutoName.
  truncated = truncateByCodepoints(candidate, 60)
  wsBase = workspaceBasename(conv.extra.workspace)
  newName = wsBase ? `${truncated} · ${wsBase}` : truncated

  return {
    ...conv,
    name: newName,
    extra: {
      ...conv.extra,
      importMeta: { ...conv.extra.importMeta, autoNamed: true, generatedName: newName }
    }
  }
```

- `isFallbackOrGenericTitle(name, generatedName)`:
  - True if `name === generatedName` AND `name` matches the relative-time fallback regex (the worst case: provider gave us nothing, Phase 1 wrote a time-based title).
  - True if `name === generatedName` AND `name` starts with `"(untitled)"` / matches UUID-like / matches raw-filename pattern (defensive — Phase 1 explicitly filters these, but legacy rows may have slipped through).
  - False otherwise — meaning the provider already gave a meaningful title (Claude Code `firstPrompt` or Copilot `summary`). Per parent line 509: "does not downgrade."

  Note: Phase 1 also stores meaningful provider titles as `generatedName`, so `name === generatedName` is necessary but NOT sufficient — the helper must additionally verify the generated name is one of the fallback shapes above. Otherwise a meaningful provider title (e.g. `"Fix the auth bug · my-project"`) would be overwritten with the first-user-message-derived title, violating the parent design's "does not downgrade" rule.

- `truncateByCodepoints(s, n)` — reuse the same code-point-safe truncation Phase 1's `buildAutoName` uses (avoid splitting a surrogate pair mid-emoji). Either factor it out into a tiny shared helper inside `importer.ts` or duplicate the 3-line `Array.from(s)` pattern — the latter is fine for a single sibling use.

### Provider → converter mapping

```ts
type JsonlConverter = (lines: string[], conversationId?: string) => TMessage[];
const CONVERTER_FOR_SOURCE = {
  claude_code: convertClaudeJsonl,
  copilot: convertCopilotJsonl,
} satisfies Record<SessionSourceId, JsonlConverter>;

function getConverterForSource(source: string | undefined): JsonlConverter | undefined {
  return source ? (CONVERTER_FOR_SOURCE as Partial<Record<string, JsonlConverter>>)[source] : undefined;
}
```

Look up the converter by `conv.source`. If `conv.source` is not in the map (a future provider missing from this PR, or a stray native row mis-routed here), throw a clear error — this is a coding bug, not a user-facing "unavailable" event. **The lookup happens in step 2 of the algorithm, BEFORE any file I/O**, so an unsupported source surfaces immediately rather than being masked by a stat/read race.

### IPC contract

```ts
// src/common/adapter/ipcBridge.ts — add to the existing cliHistory namespace
// (which already uses kebab-case channels: cli-history.scan, cli-history.scan-all,
// cli-history.disable-source, cli-history.reenable-source):
hydrate: bridge.buildProvider<
  IBridgeResponse<HydrateResult>,
  { conversationId: string }
>('cli-history.hydrate'),

// src/process/cli-history/types.ts:
export type HydrateResult = {
  status: 'hydrated' | 'cached' | 'unavailable';
  /** Number of JSONL lines we could not JSON-parse (skipped, partial transcript). */
  warningCount?: number;
  /**
   * Distinct from a clean cache hit. Surfaced to the UI so the future
   * transcript-mode renderer (item 3) can show the parent-design's
   * "Source file not found — showing last imported transcript." banner
   * (parent line 251) on top of the cached messages, OR the
   * "Transcript unavailable — source file not found." empty-state when
   * status === 'unavailable'.
   */
  warning?: 'source_missing';
};

// src/process/bridge/cliHistoryBridge.ts → initCliHistoryBridge():
ipcBridge.cliHistory.hydrate.provider(async ({ conversationId }) => {
  try {
    const result = await hydrateSession(conversationId);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, msg: err instanceof Error ? err.message : String(err) };
  }
});
```

The IPC layer never throws; only the in-process caller (renderer via `cliHistory.hydrate.invoke({ conversationId })`) sees the `{ success: false, msg }` envelope. The in-process `hydrateSession()` may throw for true contract violations (no such conversation; not an imported session; hidden). "File missing" and "corrupted JSONL" are NOT contract violations — they're expected runtime states represented in `HydrateResult`.

## Implementation Steps

1. **Database additions** — edit `src/process/services/database/index.ts`:
   - `getMessageCountForConversation(conversationId: string): IQueryResult<number>` — single `SELECT COUNT(*)` against `messages`.
   - `insertImportedMessages(conversationId: string, messages: TMessage[]): IQueryResult<number>` — wrapped in `db.transaction(...)`. Inside the transaction: `DELETE FROM messages WHERE conversation_id = ?` then a prepared INSERT looped over `messages`. **Idempotency contract is enforced inside the method**, not by the caller. Reuse `messageToRow` (already imported into `index.ts` from `./types`; the file `src/process/services/database/export.ts` re-exports it for external callers, but inside `index.ts` we use the existing `./types` import to avoid creating a circular import). Column list must match the existing `messages` schema: `id, conversation_id, msg_id, type, content, position, status, created_at` (verified — no `updated_at` column). The existing `insertMessage` SQL shape is the reference; either reuse it inside the transaction loop or write the same prepared INSERT inline.
   - Existing methods reused without changes: `AionUIDatabase.getConversation(conversationId)` (single-row read), `updateImportedConversation(...)` (Phase 1 — caller-supplied `modifyTime`), `deleteConversationMessages(...)` is available but the new method performs the delete inline inside the transaction for atomicity.
   - Both new methods live on `AionUIDatabase` (not on `IConversationRepository` — same importer-private pattern Phase 1 added with `getImportedConversationsIncludingHidden` / `updateImportedConversation`).

2. **Extend `importer.ts`** — replace the `hydrateSession` stub with the real implementation. Add internal helpers:
   - `inFlightHydrate: Map<string, Promise<HydrateResult>>` (module-level).
   - `safeStatMtimeMs(path)` (local async helper).
   - `safeReadJsonl(path)` (local async helper — returns `string | null`; handles the post-stat unreadable race).
   - `splitJsonlByValidity(lines)` (local pure helper).
   - `parseTimestampOr(input: unknown, fallback: number)` (local pure helper — number-aware sibling of Phase 1's `parseDateOr`, see hydrateSession algorithm).
   - `upgradeTitleFromFirstUserMessage(conv, messages)` (local pure helper).
   - `isFallbackOrGenericTitle(name, generatedName)` (local pure helper).
   - `runHydrate(conversationId)` (the inner async function; wraps the algorithm above).
   - Extend the existing importer-local `AcpImportedExtra` type AND the imported-ACP extra shape in `src/common/config/storage.ts` with `hydratedAt?: number` and `hydratedSourceFilePath?: string`. `hydratedAt` represents the source JSONL `mtimeMs` last successfully hydrated (NOT wall-clock `Date.now()`), and `hydratedSourceFilePath` records which source path that mtime belongs to. The cache check must require both `mtime <= hydratedAt` AND `hydratedSourceFilePath === sourceFilePath`, so an incremental Phase-1 scan that refreshes `sourceFilePath` (dedup by `acpSessionId` with a moved file) cannot accidentally reuse hydration state from a different file. `parseTimestampOr` remains defensive (accepts `unknown`) because older/future rows may contain a string.
   - Extend the existing `__resetInFlightForTests()` to also clear `inFlightHydrate` AND restore the default `fileIo` seam (see Risks below). Single test-only reset entry point — avoids two exports and keeps test setup uniform with Phase 1.

3. **Export `HydrateResult`** from `src/process/cli-history/types.ts` so `ipcBridge.ts` can import it type-only without pulling in importer module-level code (same pattern as `ImportResult` in Phase 1).

4. **Wire IPC** — add `hydrate` provider to `cliHistory` namespace in `ipcBridge.ts`. Register handler in `initCliHistoryBridge()`. Match try/catch + envelope shape.

5. **Tests** — extend `tests/unit/cli-history/importer.test.ts` with the rows below. Reuse the existing `vi.mock` setup for the database layer and providers; add new mocks for `fs.promises.stat` and `fs.promises.readFile` (or inject via a thin file-IO seam — see Risks below).

6. **Pre-commit gates** — `bun run lint:fix && bun run format && bunx tsc --noEmit && bun run test`. All four must pass before pushing. Expected: 1 pre-existing failure in `webuiConfig.test.ts` (documented in item-1's lessons — out of scope for this PR).

7. **Δ18 mitigation (WIP commits)** — Commit after each major milestone:
   - Database additions (steps 1).
   - `hydrateSession` core + coalescing (steps 2).
   - Title-upgrade helper (step 2 substep).
   - IPC wire (steps 3+4).
   - Tests + final gate run (step 5).

## Success Criteria

- `bun run lint:fix && bun run format && bunx tsc --noEmit && bun run test` all pass on `feat/cli-history-importer-phase2` (modulo the documented pre-existing `webuiConfig.test.ts` failure).
- `tests/unit/cli-history/importer.test.ts` now covers Phase-2 rows below and keeps existing Phase-1 rows passing. AGENTS.md ≥ 80% coverage target met for the Phase-2 additions.
- `hydrateSession()` no longer throws "not implemented" — callers get `{ status, warningCount?, warning? }`.
- Coalescing verified: a single in-flight hydration is shared by two concurrent callers (one `insertImportedMessages` call observed; `runHydrate` body executed once).
- mtime staleness check: second open with unchanged source file returns `'cached'` without re-reading the JSONL.
- Corrupted JSONL: malformed lines are skipped; `warningCount` reflects only JSON-syntax failures; the conversation still has a valid (partial) transcript.
- Missing source files: `'unavailable'` for never-hydrated sessions; `'cached'` for previously-hydrated sessions with the cached transcript intact.
- Phase-2 title upgrade: applies when `autoNamed === true` AND the current name is a fallback/generic title; never downgrades a meaningful provider title; never overrides a manual rename (`autoNamed === false`).
- PR #N opens against `kflili/AionUi:main`, bot review (codex + copilot) ends clean, all review threads resolved.
- `/complete-pr` lands the merge; `main` synced locally.
- Item 3's task-prompt finds a working `hydrateSession()` + `cliHistory.hydrate` IPC — clean integration surface.

### Test Coverage (mapped to parent design Test Plan §1 Phase 2 + Auto-Naming Phase-2 rows)

**Phase 2: Message Hydration**

- opens a non-hydrated imported session → loads its transcript once, then reuses cached data on second open with unchanged mtime.
- skips hydration (returns `'cached'`) if messages already exist AND `mtime <= extra.hydratedAt`.
- re-hydrates (returns `'hydrated'`) when source file mtime is newer than `extra.hydratedAt` — replaces existing messages (idempotent inside `insertImportedMessages`).
- coalesces concurrent hydration calls for the same `conversationId` — `runHydrate` body runs once; both callers receive the same resolved `HydrateResult`.
- coalesces export-triggered + open-triggered hydration for the same session (orchestration only — item 7's export wrapper will test the real export path; this PR tests the coalescing primitive).
- handles corrupted JSONL: skips bad lines, imports valid ones, returns `{ status: 'hydrated', warningCount: <n> }` where `n === malformed-line-count`.
- handles missing source file for never-hydrated session: returns `{ status: 'unavailable', warning: 'source_missing' }`, no `insertImportedMessages` call, no `updateImportedConversation` call.
- handles missing source file for previously-hydrated session: returns `{ status: 'cached', warning: 'source_missing', warningCount: 0 }`, no re-read attempt, existing messages untouched.
- throws on contract violations: unknown `conversationId`, hidden imported session, native (non-imported) row, row deleted between step 1 and step 6.
- manual rename during hydration: if `extra.importMeta.autoNamed` flips from `true` (step 1 snapshot) to `false` (step 6 fresh re-read), the title upgrade is skipped — the rename survives the hydration write.

**Auto-Naming Phase 2 upgrade**

- upgrades title using first user message when `extra.importMeta.autoNamed === true` AND current name matches the Phase-1 relative-time-fallback pattern.
- truncates the candidate to 60 chars (code-point-safe; emojis at the boundary don't split).
- appends ` · <workspace-basename>` for disambiguation (matches `buildAutoName` shape).
- does NOT upgrade if `extra.importMeta.autoNamed === false` (user has manually renamed).
- does NOT upgrade if the current name is a meaningful provider title (does not downgrade — parent line 509).
- does NOT upgrade if the JSONL contains zero user-role text messages (defensive: only assistant turns, or all text content is whitespace).
- persists the new title via `updateImportedConversation` (single write that also stamps `extra.hydratedAt`) — emits exactly one `conversationListChanged` event.

**Boundary / defensive**

- treats `extra.hydratedAt` as a number when read; defensively parses a string (older rows or future contract changes).
- treats `extra.hydratedAt > 0` as prior-hydration even when `existingCount === 0`. An empty-but-successfully-hydrated transcript (e.g. a JSONL file that contained only `summary`/`file-history-snapshot` lines) caches; a later missing-source call returns `'cached'` (with `source_missing`), not `'unavailable'`.
- handles post-stat read failure: `safeStatMtimeMs` succeeds, `safeReadJsonl` returns `null` (file deleted or permissions changed between stat and read), and hydration returns the same `source_missing` cached / unavailable result as the stat-missing path.
- after a Phase-1 scan refreshes `extra.sourceFilePath` (file moved on disk, dedup matched by `acpSessionId`), hydration re-runs even though `mtime <= hydratedAt` — because `hydratedSourceFilePath !== sourceFilePath`. The cache check is path-aware.
- `extra.acpSessionUpdatedAt` written by a concurrent scan is preserved by the re-read-before-write merge in step 6.
- `safeStatMtimeMs` / `safeReadJsonl` return `null` on EACCES, EBUSY, EPERM (not just ENOENT) → mapped to `'unavailable'` / `'cached'` per `hasPriorHydration`.

## Risks & Mitigations

- **Risk:** Mocking `fs.promises.stat` and `fs.promises.readFile` directly via `vi.mock` is brittle across Vitest versions and can leak between test files.
  **Mitigation:** Introduce a thin file-IO seam at the top of `importer.ts`:

  ```ts
  // Test seam — overridden via __setFileIoForTests() in the test file.
  const defaultFileIo = { statMtimeMs: realStatMtimeMs, readJsonl: realReadJsonl };
  let fileIo = { ...defaultFileIo };
  export function __setFileIoForTests(override: Partial<typeof fileIo>): void {
    fileIo = { ...fileIo, ...override };
  }
  ```

  Production code calls `fileIo.statMtimeMs(path)` and `fileIo.readJsonl(path)`. Tests override with in-memory implementations via `__setFileIoForTests(...)`. Extend `__resetInFlightForTests()` (already exported by Phase 1) to also restore `fileIo = { ...defaultFileIo }` so each test calls the existing reset hook without importing private real helpers. Avoids `vi.mock('fs')` and its bleed-through risks.

- **Risk:** Re-read-before-write in step 6 introduces a tiny extra DB read per hydration.
  **Mitigation:** A single point lookup against the `conversations` table (PK-indexed). Cost is negligible compared to the JSONL read+parse already happening. Documented in code with a comment explaining the scan-race rationale.

- **Risk:** A pre-existing `db.createMessage` or row-serialization helper may have subtle assumptions (e.g. auto-generated `id` overrides, side-effects). Reusing it blindly could surprise.
  **Mitigation:** Audit the existing helper first; if it adds side-effects (emits, normalizes), introduce `insertImportedMessages` as a thin parallel path using the same `messageToRow` serializer but no side-effects. Document the deliberate divergence.

- **Risk:** `insertImportedMessages` performs the `DELETE` step every time it runs — even on first hydration when there's nothing to delete. Better-sqlite3 makes this near-free, but it changes the apparent semantics from "insert" to "replace."
  **Mitigation:** Document the contract in the method JSDoc: "DELETE-then-INSERT inside a single transaction. Idempotent on the conversation_id." Tests cover both first-hydration (delete=0) and re-hydration (delete=N) paths.

- **Risk:** Title-upgrade fires only after hydration, but `updateImportedConversation` was originally designed to be called from the scan path (Phase 1). Adding a hydration caller changes the source of writes to that method.
  **Mitigation:** The method is a generic "update an imported row's `name` / `modifyTime` / `extra` without force-stamping `Date.now()`." Hydration's call preserves `modifyTime` (passes the existing value) — matches the "don't reorder the sidebar timeline" intent. No method-signature change needed.

- **Risk:** Concurrent hydration + concurrent scan racing on the same row — the scan loads pre-hydration `extra`, computes a new row, writes it back; meanwhile hydration loads pre-scan `extra`, parses JSONL, writes its updated `extra`. Whichever writes last wins. The same window opens for a concurrent manual rename — if the user renames between hydration step 1 and step 6, the cached `extra.importMeta.autoNamed === true` snapshot from step 1 would otherwise cause the title upgrade to overwrite the rename.
  **Mitigation:** Step 6's "re-read row before write, merge extras manually from the FRESH row, re-evaluate `autoNamed` on the FRESH row" pattern. Both code paths read+merge+write within the same algorithm structure, so the lost-update window shrinks to the millisecond between the re-read and the SQLite write. A test covers the rename-during-hydration case explicitly (see Test Coverage below).

- **Risk:** Bot reviewers (codex/copilot) push back on the IPC channel name shape.
  **Mitigation:** The channel name is `cli-history.hydrate`, in the existing `cliHistory` namespace, matching the existing kebab-case channels (`cli-history.scan`, `cli-history.scan-all`, `cli-history.disable-source`, `cli-history.reenable-source`). No new namespace; consistent with Phase 1's naming. If a future PR adds a "hydrate sidebar" or similar route, that PR is responsible for picking a non-conflicting name (e.g. `cli-history.refresh-sidebar`).

- **Risk:** Codex environment-unavailable trap (item-1 lesson) — codex auto-replies "create an environment for this repo" to @-mention re-review requests. Waiting indefinitely stalls the run.
  **Mitigation:** Per task-prompt: once `state=OPEN, mergeable=MERGEABLE, mergeStateStatus=CLEAN, all reviewThreads.isResolved=true`, declare bot-clean and proceed. Do NOT block on a codex re-review that cannot arrive in this repo's environment.

- **Risk:** Bot reviews push back on the warning-counter semantics (e.g. "warnings should include rows that parse-valid but produce zero messages").
  **Mitigation:** Reply with the parent design line 248 reference ("Imported with N skipped events") — the intent is "lines we couldn't parse as JSON," not "lines the renderer would have shown nothing for." Iterate only if a reviewer surfaces a concrete user-visible regression.

## Dependencies

- Phase 1 importer module (`src/process/cli-history/importer.ts`) — exported `__resetInFlightForTests`, `buildConversationRow`, `buildAutoName`, `dedupKey`, internal `parseDateOr` (string-only — Phase 2 adds a sibling `parseTimestampOr` rather than overload it), internal `workspaceBasename`, internal `isMeaningfulTitle`, internal `relativeTime`. This PR reuses the helpers as-is and extends the export list with hydration helpers.
- Existing converters: `src/process/cli-history/converters/claude.ts` (`convertClaudeJsonl`), `converters/copilot.ts` (`convertCopilotJsonl`). Signature: `(lines: string[], conversationId?: string, options?) => TMessage[]`. **Side-effect-free w.r.t. persistence** — no DB/file writes. They DO generate message IDs via `uuid()` and may fall back to `Date.now()` when JSONL timestamps are missing/malformed, and log malformed lines via `console.warn`. Do NOT modify.
- `AionUIDatabase` API in `src/process/services/database/index.ts` — extends with two new importer-private methods (`getMessageCountForConversation`, `insertImportedMessages`). Existing methods reused without changes: `getConversation` (single-row read — no `getConversationById` is added because this one already exists), `createConversation`, `updateImportedConversation`, `getImportedConversationsIncludingHidden`, `deleteConversationMessages`, `insertMessage`, `messageToRow`/`rowToMessage` (defined in `src/process/services/database/types.ts`; `export.ts` re-exports them only for external callers. `database/index.ts` must keep using its existing `./types` import to avoid a circular import).
- `messages` table schema — verified columns: `id`, `conversation_id`, `msg_id`, `type`, `content` (JSON), `position`, `status`, `created_at`. **No `updated_at` column** — `insertImportedMessages` must not write one. Parent design line 73: "no schema migration required." Confirmed.
- `emitConversationListChanged` from `src/process/bridge/conversationEvents.ts` (added by Phase 1) — reused for the post-hydration update emit.
- `ipcBridge.cliHistory` namespace (already exists with `scan`, `scanAll`, `disableSource`, `reenableSource` channels `cli-history.scan` / `cli-history.scan-all` / `cli-history.disable-source` / `cli-history.reenable-source`) + `initCliHistoryBridge()` boot path — extended with one new handler `hydrate` on channel `cli-history.hydrate`.

## Open Questions / Deferred Decisions

- **Phase-2 title upgrade fires inside hydration**, which means it only runs when the user (or item 7's export) actually opens a session. Sessions that exist in the sidebar but are never opened keep their Phase-1 fallback titles. The parent design (lines 174–186) describes this as expected: "Phase 2 upgrade" — not a background batch job. **(R3 — accepted trade-off, destination: post-V1 if user research flags this as confusing, when: not before all items 0–9 ship.)**

- **Item 7 (export) integration**: this PR establishes coalescing but does not call into the export path. Item 7's task-prompt will wire `useConversationActions.ts` export to `cliHistory.hydrate.invoke({ conversationId })` and rely on the in-flight Map to deduplicate against a concurrent open-triggered hydration. **(R2 — out of scope, destination: item 7, when: before item 7 lands.)**

- **Background re-hydration on source mtime change** (parent line 219 "Future improvement"): out of scope. Re-hydration happens on next open. Tail/watch is deferred. **(R3 — out of scope, destination: post-V1 polish, when: after V1 release.)**

- **Message-content search for non-hydrated sessions** (parent line 261): unchanged from Phase 1's deferral. `searchConversationMessages` continues to operate only on hydrated rows; the Full History view will surface the "Some sessions not yet indexed" notice (item 9). **(R3 — out of scope, destination: item 9, when: as part of full-history view.)**
