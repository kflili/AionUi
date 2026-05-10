/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import { uuid } from '@/common/utils';
import { getDatabase } from '@process/services/database/export';
import { emitConversationListChanged } from '@process/bridge/conversationEvents';
import { ProcessConfig } from '@process/utils/initStorage';
import type { TChatConversation } from '@/common/config/storage';
import { ClaudeCodeProvider } from './providers/claude';
import { CopilotProvider } from './providers/copilot';
import type { ImportResult, SessionMetadata, SessionSourceId, SessionSourceProvider } from './types';

/**
 * Phase 1 metadata-import orchestrator.
 *
 * Scans registered `SessionSourceProvider`s and upserts one `conversations` row per
 * discovered CLI session. Messages are NOT hydrated — `hydrateSession()` is a stub
 * that throws so item 2 (Phase 2 message hydration) has a clean integration surface.
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

  const updatedTs = Date.parse(metadata.updatedAt) || Date.parse(metadata.createdAt) || now;
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
  const createTs = Date.parse(metadata.createdAt) || now;
  // For existing rows, prefer the row's current modifyTime when the provider's
  // updatedAt is unparseable — that preserves the sidebar timeline order. For
  // brand-new rows, fall back to createTs (which itself falls back to `now`).
  const fallbackTs = existing?.modifyTime ?? createTs;
  const updatedTs = Date.parse(metadata.updatedAt) || fallbackTs;

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
    const updated: TChatConversation = {
      ...row,
      modifyTime: row.modifyTime, // preserve order
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
 * incremental `discoverAndImport(source)` to pick up sessions created while
 * the source was disabled. Serialized with `discoverAndImport`/`disableSource`
 * via the per-source `operationChain`.
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
 * Phase 2 (item 2) integration surface. Throws in Phase 1 — callers must not invoke.
 */
export async function hydrateSession(_conversationId: string): Promise<never> {
  throw new Error('hydrateSession not implemented in Phase 1');
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
 * Test-only: clear in-flight scan cache and per-source operation chain. Avoids
 * state leaking between Vitest tests that exercise coalescing / serialization.
 * Not part of the production API.
 */
export function __resetInFlightForTests(): void {
  inFlight.clear();
  operationChain.clear();
}
