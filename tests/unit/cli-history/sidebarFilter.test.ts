/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applySidebarFilter,
  DEFAULT_SIDEBAR_FILTER,
  isSidebarFilterActive,
  type SidebarFilterCriteria,
  type SidebarFilterSource,
} from '../../../src/renderer/pages/conversation/GroupedHistory/utils/sidebarFilterHelpers';
import type { TChatConversation } from '../../../src/common/config/storage';

// ---------------------------------------------------------------------------
// Test factories — minimal shapes; only fields the helper reads are populated.
// ---------------------------------------------------------------------------

type ConvOverrides = {
  id?: string;
  name?: string;
  source?: TChatConversation['source'];
  workspace?: string;
  extraOverride?: unknown;
};

const makeConv = ({
  id = 'c1',
  name = 'Some chat',
  source,
  workspace,
  extraOverride,
}: ConvOverrides = {}): TChatConversation => {
  const extra = extraOverride === undefined ? (workspace !== undefined ? { workspace } : {}) : extraOverride;
  return {
    id,
    createTime: 0,
    modifyTime: 0,
    name,
    extra,
    source,
  } as unknown as TChatConversation;
};

const criteria = (overrides: Partial<SidebarFilterCriteria> = {}): SidebarFilterCriteria => ({
  ...DEFAULT_SIDEBAR_FILTER,
  ...overrides,
});

const idsOf = (conversations: TChatConversation[]): string[] => conversations.map((c) => c.id);

// ---------------------------------------------------------------------------
// Fixtures — one of each source kind plus an outlier source.
// ---------------------------------------------------------------------------

const nativeAionui = makeConv({
  id: 'n-aionui',
  name: 'Refactor auth',
  source: 'aionui',
  workspace: '/Users/me/aionui-repo',
});
const nativeUndefined = makeConv({
  id: 'n-undef',
  name: 'Untitled chat',
  source: undefined,
  workspace: '/Users/me/aionui-repo',
});
const claudeCode = makeConv({
  id: 'cc-1',
  name: 'CC session',
  source: 'claude_code' as TChatConversation['source'],
  workspace: '/Users/me/cc-repo',
});
const copilot = makeConv({
  id: 'cp-1',
  name: 'CP session',
  source: 'copilot' as TChatConversation['source'],
  workspace: '/Users/me/copilot-repo',
});
const outlierTelegram = makeConv({ id: 'tg-1', name: 'Telegram chat', source: 'telegram' });

const ALL = [nativeAionui, nativeUndefined, claudeCode, copilot, outlierTelegram];

// ---------------------------------------------------------------------------
// isSidebarFilterActive
// ---------------------------------------------------------------------------

describe('isSidebarFilterActive', () => {
  it('returns false for the default criteria (source=all, empty search)', () => {
    expect(isSidebarFilterActive(DEFAULT_SIDEBAR_FILTER)).toBe(false);
  });

  it('returns true when source is narrowed', () => {
    expect(isSidebarFilterActive(criteria({ source: 'claude_code' }))).toBe(true);
  });

  it('returns true when search is non-empty after trim', () => {
    expect(isSidebarFilterActive(criteria({ search: '  hello  ' }))).toBe(true);
  });

  it('returns false when search is whitespace-only', () => {
    expect(isSidebarFilterActive(criteria({ search: '    ' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applySidebarFilter — source filter cases (Test Plan §3 rows 1–4)
// ---------------------------------------------------------------------------

describe('applySidebarFilter — source filter', () => {
  it('source filter "all" returns every conversation including outlier sources', () => {
    expect(idsOf(applySidebarFilter(ALL, criteria({ source: 'all' })))).toEqual(idsOf(ALL));
  });

  it('source filter "claude_code" returns only conversations with source === "claude_code"', () => {
    expect(idsOf(applySidebarFilter(ALL, criteria({ source: 'claude_code' })))).toEqual(['cc-1']);
  });

  it('source filter "copilot" returns only conversations with source === "copilot"', () => {
    expect(idsOf(applySidebarFilter(ALL, criteria({ source: 'copilot' })))).toEqual(['cp-1']);
  });

  it('source filter "native" returns rows where source === "aionui" OR source === undefined', () => {
    // outlier source (telegram) MUST be excluded — pinned policy per helper comment
    expect(idsOf(applySidebarFilter(ALL, criteria({ source: 'native' })))).toEqual(['n-aionui', 'n-undef']);
  });
});

// ---------------------------------------------------------------------------
// applySidebarFilter — search cases (Test Plan §3 rows 5–6, 8)
// ---------------------------------------------------------------------------

describe('applySidebarFilter — search', () => {
  it('search bar performs case-insensitive substring match against conversation.name', () => {
    const result = applySidebarFilter([nativeAionui, claudeCode], criteria({ search: 'REFACTOR' }));
    expect(idsOf(result)).toEqual(['n-aionui']);
  });

  it('search bar performs case-insensitive substring match against extra.workspace', () => {
    const result = applySidebarFilter(ALL, criteria({ search: 'copilot-repo' }));
    expect(idsOf(result)).toEqual(['cp-1']);
  });

  it('metadata search matches workspace for non-hydrated imported sessions (generic name, real workspace)', () => {
    const generic = makeConv({
      id: 'imp-1',
      name: 'Untitled imported chat',
      source: 'claude_code' as TChatConversation['source'],
      workspace: '/srv/projects/payments-api',
    });
    const result = applySidebarFilter([generic, claudeCode], criteria({ search: 'PAYMENTS-api' }));
    expect(idsOf(result)).toEqual(['imp-1']);
  });

  it('trims surrounding whitespace before matching', () => {
    const result = applySidebarFilter(ALL, criteria({ search: '  cc  ' }));
    expect(idsOf(result)).toEqual(['cc-1']);
  });
});

// ---------------------------------------------------------------------------
// applySidebarFilter — combined / empty / no-match (Test Plan §3 rows 7, 9, 10)
// ---------------------------------------------------------------------------

describe('applySidebarFilter — combined behavior', () => {
  it('search + source filter combine via AND', () => {
    const ccTwo = makeConv({
      id: 'cc-2',
      name: 'Another CC topic',
      source: 'claude_code' as TChatConversation['source'],
      workspace: '/work/cc-other',
    });
    const result = applySidebarFilter(
      [claudeCode, copilot, ccTwo],
      criteria({ source: 'claude_code', search: 'another' })
    );
    expect(idsOf(result)).toEqual(['cc-2']);
  });

  it('empty search returns all conversations matching the active source filter (filter-only)', () => {
    const result = applySidebarFilter(ALL, criteria({ source: 'claude_code', search: '' }));
    expect(idsOf(result)).toEqual(['cc-1']);
  });

  it('no-match search returns an empty array', () => {
    const result = applySidebarFilter(ALL, criteria({ search: 'nothing-matches-this-needle-xyz' }));
    expect(result).toEqual([]);
  });

  it('default criteria short-circuits and returns the input array reference unchanged', () => {
    // Performance contract: when the filter is inactive, we don't allocate a new
    // array. Item 5's truncation runs on top of this output, so re-allocation
    // would force needless re-renders downstream.
    expect(applySidebarFilter(ALL, DEFAULT_SIDEBAR_FILTER)).toBe(ALL);
  });
});

// ---------------------------------------------------------------------------
// applySidebarFilter — defensive guards (Test Plan §3 rows 11–13)
// ---------------------------------------------------------------------------

describe('applySidebarFilter — defensive guards', () => {
  it('does not throw when extra is null; falls back to no workspace match', () => {
    const conv = makeConv({ id: 'bad', name: 'Legacy row', extraOverride: null });
    // Search hits the name; workspace is not consulted because extra is null.
    expect(idsOf(applySidebarFilter([conv], criteria({ search: 'legacy' })))).toEqual(['bad']);
    // A workspace-shaped needle finds nothing because extra is null.
    expect(applySidebarFilter([conv], criteria({ search: '/work' }))).toEqual([]);
  });

  it('does not throw when extra is undefined', () => {
    const conv = makeConv({ id: 'bad-2', name: 'Another legacy row', extraOverride: undefined });
    expect(idsOf(applySidebarFilter([conv], criteria({ search: 'another' })))).toEqual(['bad-2']);
  });

  it('treats source: undefined as Native', () => {
    expect(idsOf(applySidebarFilter([nativeUndefined], criteria({ source: 'native' })))).toEqual(['n-undef']);
  });

  it('excludes unknown source strings from Native (e.g., "telegram" falls through to All-only)', () => {
    // Pinned policy: outlier sources appear under "All" only — not under
    // Native — so the filter label remains literally true ("native" means
    // AionUi-authored, never "anything I don't recognize").
    expect(applySidebarFilter([outlierTelegram], criteria({ source: 'native' }))).toEqual([]);
    expect(idsOf(applySidebarFilter([outlierTelegram], criteria({ source: 'all' })))).toEqual(['tg-1']);
  });

  it('survives a conversation whose name is missing', () => {
    const conv = makeConv({ id: 'no-name', extraOverride: { workspace: '/wk' } });
    // Force-delete name (legacy persisted rows have surfaced this in the wild).
    (conv as unknown as { name?: string }).name = undefined;
    expect(idsOf(applySidebarFilter([conv], criteria({ search: '/wk' })))).toEqual(['no-name']);
  });

  it('rejects an unknown SidebarFilterSource value by passing all rows through (exhaustive-default safety net)', () => {
    const bogus = 'bogus' as unknown as SidebarFilterSource;
    expect(idsOf(applySidebarFilter(ALL, { source: bogus, search: '' }))).toEqual(idsOf(ALL));
  });
});
