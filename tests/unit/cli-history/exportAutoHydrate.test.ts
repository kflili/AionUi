/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ensureHydratedForExport,
  type HydrateInvoker,
} from '../../../src/renderer/pages/conversation/GroupedHistory/utils/exportHelpers';
import type { TChatConversation } from '../../../src/common/config/storage';

// ---------------------------------------------------------------------------
// Factories — only the fields the helper reads. The "fresh" factory mirrors
// what `importer.ts §hydrateSession` writes on a successful conversion:
// `hydratedAt` (mtime), `hydratedSourceFilePath` (matches `sourceFilePath`),
// and `hydratedShowThinking` (the option active at hydration time). These
// are the three keys `TranscriptView.isHydrationFresh` gates on; the export
// fast-path mirrors that logic and only skips the IPC when all three match.
// ---------------------------------------------------------------------------

const SOURCE_FILE = '/tmp/session.jsonl';
const HYDRATED_AT = 1_700_000_000_000;

type ConvOverrides = {
  id?: string;
  extra?: Record<string, unknown>;
};

const makeConversation = ({ id = 'conv-1', extra = {} }: ConvOverrides = {}): TChatConversation =>
  ({
    id,
    createTime: 0,
    modifyTime: 0,
    name: 'Imported session',
    type: 'acp',
    extra,
  }) as unknown as TChatConversation;

const importedNonHydrated = (overrides: Partial<Record<string, unknown>> = {}): TChatConversation =>
  makeConversation({
    extra: {
      sourceFilePath: SOURCE_FILE,
      acpSessionId: 'session-abc',
      ...overrides,
    },
  });

const importedFresh = (showThinking = false, overrides: Partial<Record<string, unknown>> = {}): TChatConversation =>
  makeConversation({
    extra: {
      sourceFilePath: SOURCE_FILE,
      acpSessionId: 'session-abc',
      hydratedAt: HYDRATED_AT,
      hydratedSourceFilePath: SOURCE_FILE,
      hydratedShowThinking: showThinking,
      ...overrides,
    },
  });

const makeHydrateInvoker = (
  response: Awaited<ReturnType<HydrateInvoker>> | (() => Awaited<ReturnType<HydrateInvoker>>) | Error
) => {
  return vi.fn<HydrateInvoker>().mockImplementation(async () => {
    if (response instanceof Error) {
      throw response;
    }
    return typeof response === 'function' ? (response as () => Awaited<ReturnType<HydrateInvoker>>)() : response;
  });
};

// ---------------------------------------------------------------------------
// Tests — Plan §6 cases + freshness mismatches + edge cases.
// ---------------------------------------------------------------------------

describe('ensureHydratedForExport', () => {
  it('skips hydrate IPC for native (non-imported) conversations regardless of showThinking', async () => {
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'hydrated' },
    });
    const conversation = makeConversation({ extra: {} });

    const outcome = await ensureHydratedForExport(conversation, false, invokeHydrate);

    expect(outcome).toEqual({ status: 'skipped' });
    expect(invokeHydrate).not.toHaveBeenCalled();
  });

  // Plan §6 case (a): "exporting a hydrated session uses cached messages
  // (no JSONL re-read — assert hydrate IPC NOT called)" — only when ALL three
  // freshness keys still match (the importer's own cache-validity rules).
  it('skips hydrate IPC when sourceFilePath + showThinking + hydratedAt are all fresh', async () => {
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'hydrated' },
    });
    const conversation = importedFresh(false);

    const outcome = await ensureHydratedForExport(conversation, false, invokeHydrate);

    expect(outcome).toEqual({ status: 'skipped' });
    expect(invokeHydrate).not.toHaveBeenCalled();
  });

  it('calls hydrate when hydratedSourceFilePath no longer matches sourceFilePath', async () => {
    // Importer's incremental scan moved the row's source pointer — the cached
    // messages belong to the previous file and must be re-converted.
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'hydrated' },
    });
    const conversation = importedFresh(false, { hydratedSourceFilePath: '/tmp/old-session.jsonl' });

    const outcome = await ensureHydratedForExport(conversation, false, invokeHydrate);

    expect(outcome).toEqual({ status: 'hydrated' });
    expect(invokeHydrate).toHaveBeenCalledTimes(1);
    expect(invokeHydrate).toHaveBeenCalledWith({ conversationId: 'conv-1', showThinking: false });
  });

  it('calls hydrate when hydratedShowThinking differs from the current preference', async () => {
    // User toggled Show Thinking at the header after hydration — the bridge
    // keys its coalescing on the option, so the cached transcript variant
    // doesn't match the export request.
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'hydrated' },
    });
    const conversation = importedFresh(false);

    const outcome = await ensureHydratedForExport(conversation, true, invokeHydrate);

    expect(outcome).toEqual({ status: 'hydrated' });
    expect(invokeHydrate).toHaveBeenCalledTimes(1);
    expect(invokeHydrate).toHaveBeenCalledWith({ conversationId: 'conv-1', showThinking: true });
  });

  // Plan §6 case (b): "exporting a non-hydrated session triggers hydration
  // first, then exports".
  it('triggers hydrate IPC for non-hydrated imported conversations and forwards showThinking', async () => {
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'hydrated', warningCount: 0 },
    });
    const conversation = importedNonHydrated();

    const outcome = await ensureHydratedForExport(conversation, true, invokeHydrate);

    expect(outcome).toEqual({ status: 'hydrated' });
    expect(invokeHydrate).toHaveBeenCalledTimes(1);
    expect(invokeHydrate).toHaveBeenCalledWith({ conversationId: 'conv-1', showThinking: true });
  });

  // Plan §6 case (c): "export of non-hydrated session with missing source
  // file returns error".
  it('returns unavailable (no message field) when hydrate reports the source file is gone', async () => {
    // `success=true` responses don't populate `msg`; the helper drops it so
    // callers don't bind to a never-set field.
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'unavailable', warning: 'source_missing' },
    });
    const conversation = importedNonHydrated();

    const outcome = await ensureHydratedForExport(conversation, false, invokeHydrate);

    expect(outcome).toEqual({ status: 'unavailable' });
    expect(invokeHydrate).toHaveBeenCalledTimes(1);
  });

  // Plan line 250 / amendment §1: "previously hydrated, source missing now" —
  // export the cached transcript with a non-blocking warning.
  it('returns cached_warning when hydrate reports source_missing on a cached row', async () => {
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'cached', warning: 'source_missing', warningCount: 0 },
    });
    const conversation = importedNonHydrated();

    const outcome = await ensureHydratedForExport(conversation, false, invokeHydrate);

    expect(outcome).toEqual({ status: 'cached_warning' });
    expect(invokeHydrate).toHaveBeenCalledTimes(1);
  });

  it('treats clean cached (no warning) response as a no-op skip', async () => {
    // Race: importer hydrated this row between snapshot and export. Hydrate
    // returns 'cached' with no warning — source intact, nothing to do.
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'cached', warningCount: 0 },
    });
    const conversation = importedNonHydrated();

    const outcome = await ensureHydratedForExport(conversation, false, invokeHydrate);

    expect(outcome).toEqual({ status: 'skipped' });
    expect(invokeHydrate).toHaveBeenCalledTimes(1);
  });

  it('returns failed when the hydrate IPC throws (e.g. timeout / disconnect)', async () => {
    const invokeHydrate = makeHydrateInvoker(new Error('cliHistory.hydrate:conv-1 timeout'));
    const conversation = importedNonHydrated();

    const outcome = await ensureHydratedForExport(conversation, false, invokeHydrate);

    expect(outcome).toEqual({ status: 'failed', message: 'cliHistory.hydrate:conv-1 timeout' });
  });

  it('returns failed when the hydrate IPC reports success=false', async () => {
    const invokeHydrate = makeHydrateInvoker({ success: false, msg: 'backend offline' });
    const conversation = importedNonHydrated();

    const outcome = await ensureHydratedForExport(conversation, false, invokeHydrate);

    expect(outcome).toEqual({ status: 'failed', message: 'backend offline' });
  });

  it('returns failed when the hydrate IPC succeeds with no data envelope', async () => {
    const invokeHydrate = makeHydrateInvoker({ success: true });
    const conversation = importedNonHydrated();

    const outcome = await ensureHydratedForExport(conversation, false, invokeHydrate);

    expect(outcome.status).toBe('failed');
  });

  it('refuses to call hydrate when showThinking is undefined (config still loading)', async () => {
    // `useAgentCliConfig()` returns `undefined` during the initial fetch.
    // Calling hydrate with a fallback `false` would clobber the cached
    // variant if the user has Show Thinking enabled — the helper bails so
    // the caller can show a generic error and the user retries.
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'hydrated' },
    });
    const conversation = importedNonHydrated();

    const outcome = await ensureHydratedForExport(conversation, undefined, invokeHydrate);

    expect(outcome).toEqual({ status: 'failed', message: 'config_loading' });
    expect(invokeHydrate).not.toHaveBeenCalled();
  });

  it('skips immediately for native conversations even when showThinking is undefined', async () => {
    // No `sourceFilePath` → we never touch the importer, so the config
    // gate is irrelevant.
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'hydrated' },
    });
    const conversation = makeConversation({ extra: {} });

    const outcome = await ensureHydratedForExport(conversation, undefined, invokeHydrate);

    expect(outcome).toEqual({ status: 'skipped' });
    expect(invokeHydrate).not.toHaveBeenCalled();
  });

  it('ignores a non-numeric hydratedAt and still triggers hydrate', async () => {
    // Defensive against corrupted `extra` — only a finite `number > 0` is
    // accepted as the cache marker.
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'hydrated' },
    });
    const conversation = importedNonHydrated({ hydratedAt: 'recent' });

    const outcome = await ensureHydratedForExport(conversation, false, invokeHydrate);

    expect(outcome).toEqual({ status: 'hydrated' });
    expect(invokeHydrate).toHaveBeenCalledTimes(1);
  });

  it('ignores NaN / non-finite hydratedAt and still triggers hydrate', async () => {
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'hydrated' },
    });
    const conversation = importedNonHydrated({
      hydratedAt: Number.NaN,
      hydratedSourceFilePath: SOURCE_FILE,
      hydratedShowThinking: false,
    });

    const outcome = await ensureHydratedForExport(conversation, false, invokeHydrate);

    expect(outcome).toEqual({ status: 'hydrated' });
    expect(invokeHydrate).toHaveBeenCalledTimes(1);
  });
});
