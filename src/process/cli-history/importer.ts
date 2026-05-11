/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import { promises as fsPromises } from 'fs';
import { uuid } from '@/common/utils';
import { getDatabase } from '@process/services/database/export';
import { emitConversationListChanged } from '@process/bridge/conversationEvents';
import { ProcessConfig } from '@process/utils/initStorage';
import type { TChatConversation } from '@/common/config/storage';
import type { TMessage } from '@/common/chat/chatLib';
import { convertClaudeJsonl } from './converters/claude';
import { convertCopilotJsonl } from './converters/copilot';
import { ClaudeCodeProvider } from './providers/claude';
import { CopilotProvider } from './providers/copilot';
import type { HydrateResult, ImportResult, SessionMetadata, SessionSourceId, SessionSourceProvider } from './types';

/**
 * CLI history import orchestrator: Phase 1 (metadata index) + Phase 2 (on-demand hydration).
 *
 * Phase 1 scans registered `SessionSourceProvider`s and upserts one `conversations` row
 * per discovered CLI session — no messages yet, instant sidebar population.
 *
 * Phase 2 hydrates the `messages` table on demand (open or export) via `hydrateSession`:
 * stat the source JSONL, compare mtime against `extra.hydratedAt`, read+parse+convert
 * if stale, and batch-replace the conversation's messages inside a single SQLite
 * transaction. Concurrent calls for the same conversation share one in-flight pass.
 *
 * Persistence goes directly through `getDatabase()` (`AionUIDatabase`) — NOT through
 * `ConversationServiceImpl` (which has ACP-agent and workspace side-effects) and NOT
 * through `SqliteConversationRepository` (which discards DB-failure results).
 */

const SUPPORTED_SOURCES: readonly SessionSourceId[] = ['claude_code', 'copilot'] as const;
const SOURCE_TO_BACKEND: Record<SessionSourceId, 'claude' | 'copilot'> = {
  claude_code: 'claude',
  copilot: 'copilot',
};

/**
 * Title-length cap (chars) before workspace disambiguation is appended.
 * Matches the parent design's "truncated to 60 characters" requirement.
 */
const TITLE_MAX = 60;

const providerRegistry: Map<SessionSourceId, SessionSourceProvider> = new Map([
  ['claude_code' as SessionSourceId, new ClaudeCodeProvider() as SessionSourceProvider],
  ['copilot' as SessionSourceId, new CopilotProvider() as SessionSourceProvider],
]);

/**
 * In-flight scan promises keyed by source. Concurrent calls to `discoverAndImport`
 * for the same source return the in-flight promise instead of starting a parallel
 * scan, eliminating the "two concurrent scans, two rows" race. The entry is cleared
 * in `finally` so the next call starts a fresh scan.
 */
const inFlight: Map<SessionSourceId, Promise<ImportResult>> = new Map();

/**
 * Per-source operation chain. `discoverAndImport`, `disableSource`, and
 * `reenableSource` all enqueue onto the same per-source promise so cross-operation
 * races cannot interleave (e.g. a scan reading rows, a disable hiding them, then
 * the scan writing back stale `hidden: false`). Same-operation concurrency (two
 * simultaneous scans) is still coalesced via `inFlight`.
 */
const operationChain: Map<SessionSourceId, Promise<unknown>> = new Map();

function enqueueOperation<T>(source: SessionSourceId, task: () => Promise<T>): Promise<T> {
  const previous = operationChain.get(source) ?? Promise.resolve();
  // Run the task whether the previous step resolved or rejected — a prior failure
  // must not poison the chain.
  const next = previous.then(task, task);
  operationChain.set(source, next);
  // Observe both fulfillment and rejection without re-throwing on a discarded
  // promise (which would surface as `unhandledRejection`). `void next.then(...)`
  // is the safe sibling of `.finally(...)` here.
  const cleanup = () => {
    if (operationChain.get(source) === next) {
      operationChain.delete(source);
    }
  };
  void next.then(cleanup, cleanup);
  return next;
}

/**
 * ---------- Pure helpers (unit-tested in isolation) ----------
 */

/** Compute the dedup key used to match a discovered session against existing rows. */
export function dedupKey(
  source: SessionSourceId,
  acpSessionId: string | undefined,
  sourceFilePath: string | undefined
): string {
  if (acpSessionId && acpSessionId.length > 0) {
    return `${source}::id:${acpSessionId}`;
  }
  if (sourceFilePath && sourceFilePath.length > 0) {
    return `${source}::path:${sourceFilePath}`;
  }
  return `${source}::unknown:${Math.random()}`;
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RAW_FILENAME_LIKE = /^[a-z0-9_]+_\d{4}[_-]?\d{2}[_-]?\d{2}[_-]?\d{2,6}/i;

/**
 * A "meaningful" title candidate is a non-empty trimmed string that is not the
 * placeholder `(untitled)`, not a UUID, and not a raw filename pattern. Empty
 * trimmed strings collapse to "not meaningful" so the relative-time fallback fires.
 */
function isMeaningfulTitle(raw: string | undefined): raw is string {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === '(untitled)') return false;
  if (UUID_LIKE.test(trimmed)) return false;
  if (RAW_FILENAME_LIKE.test(trimmed)) return false;
  return true;
}

function relativeTime(then: number, now: number): string {
  const diffMs = Math.max(0, now - then);
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month} month${month === 1 ? '' : 's'} ago`;
  const year = Math.round(month / 12);
  return `${year} year${year === 1 ? '' : 's'} ago`;
}

function workspaceBasename(workspace: string | undefined): string {
  if (!workspace) return '';
  const base = path.basename(workspace);
  return base || workspace;
}

/**
 * `Date.parse` returns `NaN` for invalid input and a real number for valid input.
 * Using `Date.parse(x) || fallback` would also incorrectly substitute on a legitimate
 * epoch timestamp (`0`). Check for `NaN` explicitly so only invalid dates fall back.
 */
function parseDateOr(input: string | undefined, fallback: number): number {
  if (typeof input !== 'string') return fallback;
  const parsed = Date.parse(input);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Compute the auto-generated title for an imported session. Source-aware:
 *   - Claude Code: prefer `firstPrompt`, fall back to `title` (the provider's `summary`)
 *   - Copilot:     prefer `title` (the provider's `summary`)
 *
 * Truncates the chosen candidate to 60 chars and appends ` · <workspace>` for
 * disambiguation. Falls back to `<relative-time> · <workspace>` when no meaningful
 * candidate is available.
 *
 * Never returns raw filenames or UUID-like strings as the unmodified title.
 */
export function buildAutoName(metadata: SessionMetadata, now: number = Date.now()): string {
  const wsBase = workspaceBasename(metadata.workspace);

  let candidate: string | undefined;
  if (metadata.source === 'claude_code') {
    if (isMeaningfulTitle(metadata.firstPrompt)) {
      candidate = metadata.firstPrompt;
    } else if (isMeaningfulTitle(metadata.title)) {
      candidate = metadata.title;
    }
  } else {
    // copilot
    if (isMeaningfulTitle(metadata.title)) {
      candidate = metadata.title;
    } else if (isMeaningfulTitle(metadata.firstPrompt)) {
      candidate = metadata.firstPrompt;
    }
  }

  if (candidate) {
    const trimmed = candidate.trim();
    // Truncate by code-points (not UTF-16 code units) so the cap does not split
    // a surrogate pair mid-emoji.
    const chars = Array.from(trimmed);
    const truncated = chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('').trimEnd()}…` : trimmed;
    return wsBase ? `${truncated} · ${wsBase}` : truncated;
  }

  const updatedTs = parseDateOr(metadata.updatedAt, parseDateOr(metadata.createdAt, now));
  const rel = relativeTime(updatedTs, now);
  return wsBase ? `${rel} · ${wsBase}` : rel;
}

type AcpImportedExtra = {
  backend: 'claude' | 'copilot';
  workspace: string;
  acpSessionId: string;
  acpSessionUpdatedAt: number;
  sourceFilePath: string;
  messageCount?: number;
  hydratedAt?: number;
  hydratedSourceFilePath?: string;
  hydratedShowThinking?: boolean;
  importMeta: {
    autoNamed: boolean;
    generatedName?: string;
    hidden?: boolean;
  };
  pinned?: boolean;
  pinnedAt?: number;
};

/**
 * Build the `TChatConversation` row for a freshly-discovered session, or an updated
 * version of an existing row that preserves user-owned fields (rename, pin).
 *
 * - `existing` undefined → fresh insert with a new UUID and `autoNamed: true`
 * - `existing` defined  → update: refresh provider-owned fields, run the
 *   `wasAutoNamed` check to decide whether to refresh `name`/`generatedName`,
 *   preserve `pinned` / `pinnedAt`.
 */
export function buildConversationRow(
  metadata: SessionMetadata,
  existing: TChatConversation | undefined,
  now: number = Date.now()
): TChatConversation {
  const generatedName = buildAutoName(metadata, now);
  const createTs = parseDateOr(metadata.createdAt, now);
  // For existing rows, prefer the row's current modifyTime when the provider's
  // updatedAt is unparseable — that preserves the sidebar timeline order. For
  // brand-new rows, fall back to createTs (which itself falls back to `now`).
  const fallbackTs = existing?.modifyTime ?? createTs;
  const updatedTs = parseDateOr(metadata.updatedAt, fallbackTs);

  if (!existing) {
    const extra: AcpImportedExtra = {
      backend: SOURCE_TO_BACKEND[metadata.source],
      workspace: metadata.workspace,
      acpSessionId: metadata.id,
      acpSessionUpdatedAt: updatedTs,
      sourceFilePath: metadata.filePath,
      messageCount: metadata.messageCount,
      importMeta: {
        autoNamed: true,
        generatedName,
        hidden: false,
      },
      pinned: false,
    };
    return {
      id: uuid(),
      type: 'acp',
      name: generatedName,
      createTime: createTs,
      modifyTime: updatedTs,
      source: metadata.source,
      extra,
    } as unknown as TChatConversation;
  }

  const existingExtra = (existing.extra ?? {}) as Partial<AcpImportedExtra>;
  const priorGeneratedName = existingExtra.importMeta?.generatedName;
  const wasAutoNamed =
    existingExtra.importMeta?.autoNamed === true &&
    typeof priorGeneratedName === 'string' &&
    priorGeneratedName.trim().length > 0 &&
    existing.name === priorGeneratedName;

  const nextExtra: AcpImportedExtra = {
    ...existingExtra,
    backend: SOURCE_TO_BACKEND[metadata.source],
    workspace: metadata.workspace,
    acpSessionId: metadata.id,
    acpSessionUpdatedAt: updatedTs,
    sourceFilePath: metadata.filePath,
    messageCount: metadata.messageCount ?? existingExtra.messageCount,
    importMeta: {
      ...existingExtra.importMeta,
      autoNamed: wasAutoNamed,
      generatedName: wasAutoNamed ? generatedName : existingExtra.importMeta?.generatedName,
      hidden: existingExtra.importMeta?.hidden ?? false,
    },
  };

  return {
    ...existing,
    name: wasAutoNamed ? generatedName : existing.name,
    modifyTime: updatedTs,
    source: metadata.source,
    extra: nextExtra,
  } as TChatConversation;
}

/**
 * Compare two conversation rows for importer-relevant equality. Returns true if
 * the update would be a no-op (skip the DB write to avoid spurious listChanged emits).
 */
function rowsEqualForImporter(a: TChatConversation, b: TChatConversation): boolean {
  if (a.name !== b.name) return false;
  if (a.modifyTime !== b.modifyTime) return false;
  if (a.source !== b.source) return false;
  return JSON.stringify(a.extra) === JSON.stringify(b.extra);
}

/**
 * ---------- Public API ----------
 */

/**
 * Scan a single source's native session index and upsert one row per discovered
 * session. Concurrent calls for the same source share the in-flight promise so
 * we never run two scans in parallel against the same provider. Disable/re-enable
 * operations are serialized via the per-source `operationChain` so a scan cannot
 * race a hide/unhide pair.
 *
 * Returns the in-flight promise reference (not an async-wrapped copy) so that
 * `discoverAndImport(s) === discoverAndImport(s)` while a scan is pending.
 */
export function discoverAndImport(source: SessionSourceId): Promise<ImportResult> {
  const existing = inFlight.get(source);
  if (existing) return existing;

  const scan = enqueueOperation(source, () => runDiscoverAndImport(source)).finally(() => {
    // Clear in `finally` so the next caller starts a fresh scan.
    if (inFlight.get(source) === scan) {
      inFlight.delete(source);
    }
  });
  inFlight.set(source, scan);
  return scan;
}

async function runDiscoverAndImport(source: SessionSourceId): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, updated: 0, skipped: 0, errors: [] };

  const provider = providerRegistry.get(source);
  if (!provider) {
    result.errors.push({ sessionId: '', message: `No provider registered for source: ${source}` });
    return result;
  }

  let discovered: SessionMetadata[];
  try {
    discovered = await provider.discoverSessions();
  } catch (err) {
    result.errors.push({
      sessionId: '',
      message: `Provider ${source} failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return result;
  }

  if (discovered.length === 0) {
    return result;
  }

  const db = getDatabase();
  const existingResult = db.getImportedConversationsIncludingHidden([source]);
  if (!existingResult.success) {
    result.errors.push({ sessionId: '', message: existingResult.error ?? 'Failed to read existing imported rows' });
    return result;
  }
  const existingRows = existingResult.data ?? [];

  // Build dedup index. Index by both keys so a session whose acpSessionId is set
  // can still be matched if a previous import only had sourceFilePath.
  const byKey = new Map<string, TChatConversation>();
  for (const row of existingRows) {
    const extra = (row.extra ?? {}) as Partial<AcpImportedExtra>;
    if (extra.acpSessionId) byKey.set(`${source}::id:${extra.acpSessionId}`, row);
    if (extra.sourceFilePath) byKey.set(`${source}::path:${extra.sourceFilePath}`, row);
  }

  for (const metadata of discovered) {
    try {
      const idKey = `${source}::id:${metadata.id}`;
      const pathKey = `${source}::path:${metadata.filePath}`;
      const existingRow = byKey.get(idKey) ?? byKey.get(pathKey);

      if (existingRow) {
        const updated = buildConversationRow(metadata, existingRow);
        if (rowsEqualForImporter(existingRow, updated)) {
          result.skipped++;
          continue;
        }
        const writeResult = db.updateImportedConversation(updated);
        if (writeResult.success) {
          result.updated++;
          emitConversationListChanged(updated, 'updated');
        } else {
          result.errors.push({ sessionId: metadata.id, message: writeResult.error ?? 'Unknown database error' });
        }
      } else {
        const created = buildConversationRow(metadata, undefined);
        const writeResult = db.createConversation(created);
        if (writeResult.success) {
          result.imported++;
          emitConversationListChanged(created, 'created');
          // Update local dedup index so a duplicate entry in the same scan does not
          // produce a second row.
          const createdExtra = (created.extra ?? {}) as Partial<AcpImportedExtra>;
          if (createdExtra.acpSessionId) byKey.set(`${source}::id:${createdExtra.acpSessionId}`, created);
          if (createdExtra.sourceFilePath) byKey.set(`${source}::path:${createdExtra.sourceFilePath}`, created);
        } else {
          result.errors.push({ sessionId: metadata.id, message: writeResult.error ?? 'Unknown database error' });
        }
      }
    } catch (err) {
      result.errors.push({
        sessionId: metadata.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Scan every requested source. One source's failure does not block another.
 * Default = all registered supported sources (`claude_code`, `copilot`).
 */
export async function discoverAndImportAll(
  sources: SessionSourceId[] = [...SUPPORTED_SOURCES]
): Promise<Partial<Record<SessionSourceId, ImportResult>>> {
  const out: Partial<Record<SessionSourceId, ImportResult>> = {};
  await Promise.all(
    sources.map(async (source) => {
      try {
        out[source] = await discoverAndImport(source);
      } catch (err) {
        out[source] = {
          imported: 0,
          updated: 0,
          skipped: 0,
          errors: [{ sessionId: '', message: err instanceof Error ? err.message : String(err) }],
        };
      }
    })
  );
  return out;
}

/**
 * Soft-disable a source: flip `extra.importMeta.hidden = true` on every imported
 * row whose `extra.importMeta.hidden !== true`. Preserves the existing `modifyTime`
 * (so the sidebar timeline does not reorder) and never touches user-owned fields
 * (`name`, `pinned`, `pinnedAt`). Serialized with `discoverAndImport`/`reenableSource`
 * via the per-source `operationChain` so we cannot race an in-flight scan.
 */
export function disableSource(
  source: SessionSourceId
): Promise<{ hidden: number; errors: Array<{ sessionId: string; message: string }> }> {
  return enqueueOperation(source, () => runDisableSource(source));
}

async function runDisableSource(
  source: SessionSourceId
): Promise<{ hidden: number; errors: Array<{ sessionId: string; message: string }> }> {
  const db = getDatabase();
  const listResult = db.getImportedConversationsIncludingHidden([source]);
  if (!listResult.success) {
    return { hidden: 0, errors: [{ sessionId: '', message: listResult.error ?? 'Failed to read imported rows' }] };
  }
  const rows = listResult.data ?? [];
  let hidden = 0;
  const errors: Array<{ sessionId: string; message: string }> = [];
  for (const row of rows) {
    const extra = (row.extra ?? {}) as Partial<AcpImportedExtra>;
    if (!extra.importMeta) continue; // Defensive: only touch rows that look imported.
    if (extra.importMeta.hidden === true) continue;
    // Restate `modifyTime` from the spread to make the contract explicit: unlike
    // `db.updateConversation` which force-stamps `Date.now()`, hide MUST keep the
    // existing modifyTime so the sidebar timeline does not reorder.
    const updated: TChatConversation = {
      ...row,
      modifyTime: row.modifyTime,
      extra: {
        ...extra,
        importMeta: { ...extra.importMeta, hidden: true },
      },
    } as TChatConversation;
    const writeResult = db.updateImportedConversation(updated);
    if (writeResult.success) {
      hidden++;
      emitConversationListChanged(updated, 'updated');
    } else {
      errors.push({ sessionId: extra.acpSessionId ?? row.id, message: writeResult.error ?? 'Unknown database error' });
    }
  }
  return { hidden, errors };
}

/**
 * Soft-re-enable a source: flip `extra.importMeta.hidden = false` on every
 * previously-hidden row (preserving customizations + `modifyTime`), then run an
 * incremental scan to pick up sessions created while the source was disabled.
 * Serialized with `discoverAndImport`/`disableSource` via the per-source
 * `operationChain`.
 *
 * Note: the inner scan calls `runDiscoverAndImport(source)` directly (NOT the
 * public `discoverAndImport(source)`) — re-entering `enqueueOperation` while
 * already running on the same chain entry would deadlock waiting on its own
 * tail. See the call site below for the same warning.
 *
 * Unhide failures are accumulated into the returned `ImportResult.errors` so the
 * IPC caller can surface them in the UI (rather than silently swallowing them).
 */
export function reenableSource(source: SessionSourceId): Promise<ImportResult> {
  return enqueueOperation(source, () => runReenableSource(source));
}

async function runReenableSource(source: SessionSourceId): Promise<ImportResult> {
  const db = getDatabase();
  const unhideErrors: Array<{ sessionId: string; message: string }> = [];
  const listResult = db.getImportedConversationsIncludingHidden([source]);
  if (!listResult.success) {
    unhideErrors.push({ sessionId: '', message: listResult.error ?? 'Failed to read imported rows for re-enable' });
  } else {
    const rows = listResult.data ?? [];
    for (const row of rows) {
      const extra = (row.extra ?? {}) as Partial<AcpImportedExtra>;
      if (!extra.importMeta) continue;
      if (extra.importMeta.hidden !== true) continue;
      // Restate `modifyTime` from the spread to make the contract explicit: unlike
      // `db.updateConversation` which force-stamps `Date.now()`, unhide MUST keep
      // the existing modifyTime so re-enable does not reorder the timeline.
      const updated: TChatConversation = {
        ...row,
        modifyTime: row.modifyTime,
        extra: {
          ...extra,
          importMeta: { ...extra.importMeta, hidden: false },
        },
      } as TChatConversation;
      const writeResult = db.updateImportedConversation(updated);
      if (writeResult.success) {
        emitConversationListChanged(updated, 'updated');
      } else {
        unhideErrors.push({
          sessionId: extra.acpSessionId ?? row.id,
          message: writeResult.error ?? 'Failed to unhide row',
        });
      }
    }
  }
  // Run the scan inline (it's already on this operation chain via runReenableSource
  // being executed by enqueueOperation; calling discoverAndImport would re-enqueue
  // and deadlock waiting on its own chain entry).
  const scanResult = await runDiscoverAndImport(source);
  return {
    imported: scanResult.imported,
    updated: scanResult.updated,
    skipped: scanResult.skipped,
    errors: [...unhideErrors, ...scanResult.errors],
  };
}

/**
 * ---------- Phase 2: On-demand message hydration ----------
 */

type ConverterOptions = { showThinking?: boolean };
type JsonlConverter = (lines: string[], conversationId?: string, options?: ConverterOptions) => TMessage[];

/**
 * Converter registry keyed by `SessionSourceId`. The plan deliberately keeps
 * this list small (claude_code, copilot) — adding a new source means adding
 * an entry here AND a provider in `providers/`. Lookup via
 * `getConverterForSource` so an unknown `conv.source` surfaces as a coding
 * bug (thrown) rather than silently defaulting to one of the existing
 * converters.
 */
const CONVERTER_FOR_SOURCE = {
  claude_code: convertClaudeJsonl,
  copilot: convertCopilotJsonl,
} satisfies Record<SessionSourceId, JsonlConverter>;

function getConverterForSource(source: string | undefined): JsonlConverter | undefined {
  if (!source) return undefined;
  return (CONVERTER_FOR_SOURCE as Partial<Record<string, JsonlConverter>>)[source];
}

/**
 * Number-aware sibling of Phase 1's `parseDateOr`. Phase 2 stores
 * `extra.hydratedAt` as a number (the source JSONL `mtimeMs`), so reading
 * it back through the string-only `parseDateOr` would always yield the
 * fallback and trigger spurious re-hydration. Accepts `unknown` because
 * older / future rows may carry a string.
 */
function parseTimestampOr(input: unknown, fallback: number): number {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input !== 'string') return fallback;
  const parsed = Date.parse(input);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Real-world file IO. Exposed as a single object so tests can swap in
 * in-memory implementations via `__setFileIoForTests(...)` and avoid
 * `vi.mock('fs')` and its bleed-through risks.
 *
 * Note on sync-vs-async: `cliHistoryBridge.convertSessionToMessages`
 * (the legacy terminal-switching path) uses synchronous `fsSync.readFileSync`
 * "to avoid Electron async I/O deadlock". That comment is specific to the
 * IPC hot path where the conversion runs synchronously inside the IPC reply.
 * `hydrateSession` runs off the IPC reply path — the IPC handler awaits
 * the entire algorithm and only returns when the messages have been written,
 * so we can safely use `fsPromises` here without blocking the event loop
 * the way `convertSessionToMessages` would have.
 */
async function realStatMtimeMs(filePath: string): Promise<number | null> {
  try {
    const st = await fsPromises.stat(filePath);
    return st.mtimeMs;
  } catch {
    return null;
  }
}

async function realReadJsonl(filePath: string): Promise<string | null> {
  try {
    return await fsPromises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

type FileIo = {
  statMtimeMs: (filePath: string) => Promise<number | null>;
  readJsonl: (filePath: string) => Promise<string | null>;
};

const defaultFileIo: FileIo = {
  statMtimeMs: realStatMtimeMs,
  readJsonl: realReadJsonl,
};

let fileIo: FileIo = { ...defaultFileIo };

/**
 * Test-only: layer overrides on top of the current file-IO seam. Does NOT
 * restore defaults — call `__resetInFlightForTests()` between tests to
 * reset both the in-flight maps AND the file-IO seam back to `defaultFileIo`.
 */
export function __setFileIoForTests(override: Partial<FileIo>): void {
  fileIo = { ...fileIo, ...override };
}

/**
 * Split JSONL `\n`-terminated lines into the subset that parses as valid
 * JSON plus a warning count for the rest. Empty / whitespace-only lines
 * are skipped silently (not counted as warnings). The converter's own
 * `safeParseLine` would also log+drop malformed lines, but pre-filtering
 * here means we can report `warningCount` to the renderer without
 * modifying the converter contract.
 */
function splitJsonlByValidity(lines: string[]): { validLines: string[]; warningCount: number } {
  const validLines: string[] = [];
  let warningCount = 0;
  for (const raw of lines) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    try {
      JSON.parse(trimmed);
      validLines.push(raw);
    } catch {
      warningCount++;
    }
  }
  return { validLines, warningCount };
}

const RELATIVE_TIME_FALLBACK_RE =
  /^(just now|\d+ min ago|\d+ hour(?:s)? ago|\d+ day(?:s)? ago|\d+ month(?:s)? ago|\d+ year(?:s)? ago)/;

/**
 * Phase-2-only "is this title safe to upgrade?" check. Returns true ONLY
 * when the current name is one of the Phase-1 fallback / defensive
 * patterns AND it still matches `generatedName` (so a user rename has
 * not happened). Phase 1 also stores meaningful provider titles as
 * `generatedName`, so `name === generatedName` is necessary but NOT
 * sufficient — the additional fallback-shape check prevents this helper
 * from declaring a meaningful provider title (e.g. "Fix the auth bug ·
 * my-project") as "generic and safe to overwrite."
 */
function isFallbackOrGenericTitle(name: string | undefined, generatedName: string | undefined): boolean {
  if (typeof name !== 'string' || typeof generatedName !== 'string') return false;
  if (name !== generatedName) return false;
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  if (RELATIVE_TIME_FALLBACK_RE.test(trimmed)) return true;
  if (trimmed.startsWith('(untitled)')) return true;
  if (UUID_LIKE.test(trimmed)) return true;
  if (RAW_FILENAME_LIKE.test(trimmed)) return true;
  return false;
}

/**
 * Phase-2 title upgrade: when a Phase-1 row was generic-named, pull the
 * first user-role text message from the freshly-hydrated transcript and
 * use it as the new title. Truncates to 60 codepoints and appends
 * ` · <workspace-basename>` to match `buildAutoName`.
 *
 * Returns the conversation unchanged if no user-role text is present,
 * if the candidate is empty, or if the title is not a fallback/generic
 * one (preserves meaningful provider titles per parent design line 509).
 */
function upgradeTitleFromFirstUserMessage(conv: TChatConversation, messages: TMessage[]): TChatConversation {
  const extra = (conv.extra ?? {}) as Partial<AcpImportedExtra>;
  if (!isFallbackOrGenericTitle(conv.name, extra.importMeta?.generatedName)) {
    return conv;
  }

  const firstUser = messages.find(
    (m): m is Extract<TMessage, { type: 'text' }> => m.type === 'text' && m.position === 'right'
  );
  if (!firstUser) return conv;

  const raw = firstUser.content.content;
  if (typeof raw !== 'string') return conv;
  const candidate = raw.trim();
  if (candidate.length === 0) return conv;

  const wsBase = workspaceBasename(extra.workspace);
  const chars = Array.from(candidate);
  const truncated = chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('').trimEnd()}…` : candidate;
  const newName = wsBase ? `${truncated} · ${wsBase}` : truncated;

  const nextImportMeta = {
    ...(extra.importMeta ?? { autoNamed: true }),
    autoNamed: true,
    generatedName: newName,
  };

  return {
    ...conv,
    name: newName,
    extra: {
      ...(extra as object),
      importMeta: nextImportMeta,
    },
  } as TChatConversation;
}

/**
 * In-flight hydration promises keyed by `(conversationId, normalizedShowThinking)`.
 * Two concurrent callers for the same conversation with the SAME requested
 * `showThinking` value (after normalizing `undefined`→`false`) share a single
 * read+parse+insert pass. Callers with DIFFERENT requested values do NOT
 * coalesce — joining the wrong in-flight pass would resolve the late caller's
 * promise with messages produced under the other variant, leaving SQLite in
 * a state that contradicts the late caller's request. Entry is cleared in
 * `finally` so the next caller starts fresh.
 */
const inFlightHydrate: Map<string, Promise<HydrateResult>> = new Map();

function hydrationKey(conversationId: string, showThinking: boolean | undefined): string {
  // Treat `undefined` and `false` as equivalent (both → the converter's default).
  const normalized = showThinking === true ? 't' : 'f';
  return `${conversationId}:${normalized}`;
}

/**
 * Hydrate an imported session's transcript on demand. Reads the conversation
 * row, compares the source file `mtime` to `extra.hydratedAt`, and either
 * returns the cached state or re-reads + re-converts + replaces the
 * `messages` rows inside a single SQLite transaction. Phase-2 title
 * upgrade runs when the row was Phase-1-imported with a generic name.
 *
 * Concurrent callers for the same `conversationId` and the same requested
 * `showThinking` (after normalizing `undefined`→`false`) share one in-flight
 * promise via `inFlightHydrate`. Callers with a different requested value
 * do NOT coalesce — they run a separate hydration pass so each caller's
 * promise reflects the variant it asked for. The cache predicate then
 * invalidates the previous variant's SQLite state. Item 3's render-time
 * filter remains the cleaner long-term path — at that point the
 * `showThinking` axis can drop from both the cache key and the in-flight
 * key.
 *
 * Hydration does NOT enqueue onto the per-source `operationChain` —
 * hydration is per-conversation, scan / disable / reenable are per-source.
 * Step 6 re-reads the row immediately before writing so concurrent scan
 * updates and concurrent manual renames are preserved.
 *
 * Throws for contract violations (unknown conversationId, non-imported row,
 * hidden imported row, unsupported source, DB failures, row deleted
 * mid-hydration). Missing / unreadable source files are NOT contract
 * violations — they map to `{ status: 'unavailable' | 'cached', warning:
 * 'source_missing' }`.
 */
export function hydrateSession(conversationId: string, options?: ConverterOptions): Promise<HydrateResult> {
  const key = hydrationKey(conversationId, options?.showThinking);
  const existing = inFlightHydrate.get(key);
  if (existing) return existing;

  const promise = runHydrate(conversationId, options ?? {}).finally(() => {
    if (inFlightHydrate.get(key) === promise) {
      inFlightHydrate.delete(key);
    }
  });
  inFlightHydrate.set(key, promise);
  return promise;
}

async function runHydrate(conversationId: string, options: ConverterOptions): Promise<HydrateResult> {
  const db = getDatabase();
  const rowResult = db.getConversation(conversationId);
  if (!rowResult.success || !rowResult.data) {
    throw new Error(rowResult.error ?? `Conversation not found: ${conversationId}`);
  }
  const conv = rowResult.data;
  const extra = (conv.extra ?? {}) as Partial<AcpImportedExtra>;

  if (!extra.sourceFilePath) {
    throw new Error(`Conversation is not an imported CLI session: ${conversationId}`);
  }
  if (extra.importMeta?.hidden === true) {
    throw new Error(`Cannot hydrate hidden imported session: ${conversationId}`);
  }
  const converter = getConverterForSource(conv.source);
  if (!converter) {
    throw new Error(`Unsupported CLI history source for hydration: ${String(conv.source)}`);
  }

  const sourceFilePath = extra.sourceFilePath;

  const mtimeMs = await fileIo.statMtimeMs(sourceFilePath);

  const countResult = db.getMessageCountForConversation(conversationId);
  if (!countResult.success) {
    throw new Error(countResult.error ?? 'Failed to count imported messages');
  }
  const existingCount = countResult.data ?? 0;

  const hydratedAt = parseTimestampOr(extra.hydratedAt, 0);
  const hydratedSourceFilePath =
    typeof extra.hydratedSourceFilePath === 'string' ? extra.hydratedSourceFilePath : undefined;
  // Normalize `showThinking` so callers that omit the option don't spuriously
  // invalidate the cache vs callers that pass `false` (the converter's default).
  const requestedShowThinking = options.showThinking === true;
  const storedShowThinking = extra.hydratedShowThinking === true;
  // Prior hydration counts only if it was against the CURRENT source path AND
  // produced messages under the CURRENT showThinking variant. A Phase-1 scan
  // that refreshes `sourceFilePath` (file moved on disk) invalidates the cache
  // regardless of mtime; toggling the renderer's "show thinking" setting
  // similarly invalidates the cache so SQLite reflects the requested variant.
  // A pre-Phase-2 row that has `existingCount > 0` but no `hydratedSourceFilePath`
  // recorded does NOT match — we cannot prove the existing messages came from
  // the current path, so we re-hydrate to be safe.
  const hasPriorHydration =
    (hydratedAt > 0 || existingCount > 0) &&
    hydratedSourceFilePath === sourceFilePath &&
    storedShowThinking === requestedShowThinking;

  if (mtimeMs === null) {
    if (hasPriorHydration) {
      return { status: 'cached', warning: 'source_missing', warningCount: 0 };
    }
    return { status: 'unavailable', warning: 'source_missing' };
  }

  if (hasPriorHydration && mtimeMs <= hydratedAt) {
    return { status: 'cached', warningCount: 0 };
  }

  // Read + parse. `fileIo.readJsonl` (the production impl, `realReadJsonl`,
  // catches all errors and returns null) handles the race where the file
  // disappears or flips permissions between stat (step 3) and read (step 4).
  const fileContent = await fileIo.readJsonl(sourceFilePath);
  if (fileContent === null) {
    if (hasPriorHydration) {
      return { status: 'cached', warning: 'source_missing', warningCount: 0 };
    }
    return { status: 'unavailable', warning: 'source_missing' };
  }

  const lines = fileContent.split('\n');
  const { validLines, warningCount } = splitJsonlByValidity(lines);
  const messages = converter(validLines, conversationId, options);

  const insertResult = db.insertImportedMessages(conversationId, messages);
  if (!insertResult.success) {
    throw new Error(insertResult.error ?? 'Failed to insert imported messages');
  }

  // Re-read the row immediately before the metadata write so a concurrent
  // scan (refreshing acpSessionUpdatedAt / workspace / sourceFilePath /
  // messageCount) and a concurrent manual rename (autoNamed → false)
  // both survive this update.
  const freshResult = db.getConversation(conversationId);
  if (!freshResult.success || !freshResult.data) {
    throw new Error(freshResult.error ?? `Conversation row vanished mid-hydration: ${conversationId}`);
  }
  const fresh = freshResult.data;
  const freshExtra = (fresh.extra ?? {}) as Partial<AcpImportedExtra>;

  const nextExtra: Partial<AcpImportedExtra> = {
    ...freshExtra,
    hydratedAt: mtimeMs,
    hydratedSourceFilePath: sourceFilePath,
    hydratedShowThinking: requestedShowThinking,
  };

  let conv2: TChatConversation = {
    ...fresh,
    extra: nextExtra,
  } as TChatConversation;

  if (freshExtra.importMeta?.autoNamed === true && messages.length > 0) {
    conv2 = upgradeTitleFromFirstUserMessage(conv2, messages);
  }

  const updateResult = db.updateImportedConversation(conv2);
  if (!updateResult.success) {
    throw new Error(updateResult.error ?? 'Failed to update imported conversation after hydration');
  }
  emitConversationListChanged(conv2, 'updated');

  return { status: 'hydrated', warningCount };
}

/**
 * App-launch incremental sync. Reads `agentCli.config` for enabled sources and
 * kicks off a non-blocking `discoverAndImportAll(enabledSources)`. Errors are
 * logged, never thrown — startup must not be gated on importer success.
 */
export function initCliHistoryImporter(): void {
  void (async () => {
    try {
      const config = await ProcessConfig.get('agentCli.config');
      const enabled: SessionSourceId[] = [];
      if (config?.importClaudeCode) enabled.push('claude_code');
      if (config?.importCopilot) enabled.push('copilot');
      if (enabled.length === 0) return;
      const results = await discoverAndImportAll(enabled);
      for (const [source, result] of Object.entries(results)) {
        if (!result) continue;
        console.log(
          `[cliHistoryImporter] ${source}: imported=${result.imported} updated=${result.updated} skipped=${result.skipped} errors=${result.errors.length}`
        );
      }
    } catch (err) {
      console.error('[cliHistoryImporter] app-launch sync failed', err);
    }
  })();
}

/**
 * Test-only: clear in-flight scan cache, per-source operation chain, the
 * Phase-2 hydration in-flight map, and restore the default file-IO seam.
 * Avoids state leaking between Vitest tests that exercise coalescing /
 * serialization / hydration. Not part of the production API.
 */
export function __resetInFlightForTests(): void {
  inFlight.clear();
  operationChain.clear();
  inFlightHydrate.clear();
  fileIo = { ...defaultFileIo };
}
