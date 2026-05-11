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
// Factories — only the fields the helper reads.
// ---------------------------------------------------------------------------

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

const importedConversation = (overrides: Partial<Record<string, unknown>> = {}): TChatConversation =>
  makeConversation({
    extra: {
      sourceFilePath: '/tmp/session.jsonl',
      acpSessionId: 'session-abc',
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
// Tests — Plan §6 cases + edge cases.
// ---------------------------------------------------------------------------

describe('ensureHydratedForExport', () => {
  it('skips hydrate IPC for native (non-imported) conversations', async () => {
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'hydrated' },
    });
    const conversation = makeConversation({ extra: {} });

    const outcome = await ensureHydratedForExport(conversation, invokeHydrate);

    expect(outcome).toEqual({ status: 'skipped' });
    expect(invokeHydrate).not.toHaveBeenCalled();
  });

  // Plan §6 case (a): "exporting a hydrated session uses cached messages
  // (no JSONL re-read — assert hydrate IPC NOT called)".
  it('skips hydrate IPC for already-hydrated imported conversations', async () => {
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'hydrated' },
    });
    const conversation = importedConversation({ hydratedAt: 1_700_000_000_000 });

    const outcome = await ensureHydratedForExport(conversation, invokeHydrate);

    expect(outcome).toEqual({ status: 'skipped' });
    expect(invokeHydrate).not.toHaveBeenCalled();
  });

  // Plan §6 case (b): "exporting a non-hydrated session triggers hydration
  // first, then exports".
  it('triggers hydrate IPC for non-hydrated imported conversations and reports success', async () => {
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'hydrated', warningCount: 0 },
    });
    const conversation = importedConversation();

    const outcome = await ensureHydratedForExport(conversation, invokeHydrate);

    expect(outcome).toEqual({ status: 'hydrated' });
    expect(invokeHydrate).toHaveBeenCalledTimes(1);
    expect(invokeHydrate).toHaveBeenCalledWith({ conversationId: 'conv-1' });
  });

  // Plan §6 case (c): "export of non-hydrated session with missing source
  // file returns error".
  it('returns unavailable when hydrate reports the source file is gone (never hydrated)', async () => {
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'unavailable', warning: 'source_missing' },
      msg: 'source_missing',
    });
    const conversation = importedConversation();

    const outcome = await ensureHydratedForExport(conversation, invokeHydrate);

    expect(outcome).toEqual({ status: 'unavailable', message: 'source_missing' });
    expect(invokeHydrate).toHaveBeenCalledTimes(1);
  });

  // Plan line 250 / amendment §1: "previously hydrated, source missing now" —
  // export the cached transcript with a non-blocking warning. This branch is
  // only reachable from a row whose `hydratedAt` is unset in the renderer
  // snapshot but already-hydrated server-side (e.g. importer just hydrated in
  // a parallel pass), so the IPC must still fire.
  it('returns cached_warning when hydrate reports source_missing on a cached row', async () => {
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'cached', warning: 'source_missing', warningCount: 0 },
    });
    const conversation = importedConversation();

    const outcome = await ensureHydratedForExport(conversation, invokeHydrate);

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
    const conversation = importedConversation();

    const outcome = await ensureHydratedForExport(conversation, invokeHydrate);

    expect(outcome).toEqual({ status: 'skipped' });
    expect(invokeHydrate).toHaveBeenCalledTimes(1);
  });

  it('returns failed when the hydrate IPC throws', async () => {
    const invokeHydrate = makeHydrateInvoker(new Error('ipc disconnected'));
    const conversation = importedConversation();

    const outcome = await ensureHydratedForExport(conversation, invokeHydrate);

    expect(outcome).toEqual({ status: 'failed', message: 'ipc disconnected' });
  });

  it('returns failed when the hydrate IPC reports success=false', async () => {
    const invokeHydrate = makeHydrateInvoker({ success: false, msg: 'backend offline' });
    const conversation = importedConversation();

    const outcome = await ensureHydratedForExport(conversation, invokeHydrate);

    expect(outcome).toEqual({ status: 'failed', message: 'backend offline' });
  });

  it('returns failed when the hydrate IPC succeeds with no data envelope', async () => {
    const invokeHydrate = makeHydrateInvoker({ success: true });
    const conversation = importedConversation();

    const outcome = await ensureHydratedForExport(conversation, invokeHydrate);

    expect(outcome.status).toBe('failed');
  });

  it('ignores a non-numeric hydratedAt and still triggers hydrate', async () => {
    // Defensive against corrupted `extra` — only a `number > 0` is the cache
    // signal. Strings, booleans, NaN, etc. fall through to the IPC.
    const invokeHydrate = makeHydrateInvoker({
      success: true,
      data: { status: 'hydrated' },
    });
    const conversation = importedConversation({ hydratedAt: 'recent' });

    const outcome = await ensureHydratedForExport(conversation, invokeHydrate);

    expect(outcome).toEqual({ status: 'hydrated' });
    expect(invokeHydrate).toHaveBeenCalledTimes(1);
  });
});
