/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import type { TChatConversation } from '../../../src/common/config/storage';
import type { SidebarFilterSource } from '../../../src/renderer/pages/conversation/GroupedHistory/utils/sidebarFilterHelpers';
import {
  applyHistoryFilter,
  collectWorkspaceOptions,
  DEFAULT_HISTORY_FILTER,
  hasNonHydratedImportedRows,
  type HistoryFilterCriteria,
  isHistoryFilterActive,
  matchesDateRange,
  NO_WORKSPACE_TOKEN,
  sectionKeyToPreset,
  sortConversations,
} from '../../../src/renderer/pages/history/utils/historyFilterHelpers';

type ConvOverrides = {
  id?: string;
  name?: string;
  source?: TChatConversation['source'];
  workspace?: string;
  modifyTime?: number;
  extraOverride?: unknown;
};

const makeConv = ({
  id = 'c1',
  name = 'Some chat',
  source,
  workspace,
  modifyTime = 0,
  extraOverride,
}: ConvOverrides = {}): TChatConversation => {
  const extra = extraOverride === undefined ? (workspace !== undefined ? { workspace } : {}) : extraOverride;
  return {
    id,
    createTime: 0,
    modifyTime,
    name,
    extra,
    source,
  } as unknown as TChatConversation;
};

const criteria = (overrides: Partial<HistoryFilterCriteria> = {}): HistoryFilterCriteria => ({
  ...DEFAULT_HISTORY_FILTER,
  ...overrides,
});

const sources = (...vals: SidebarFilterSource[]): Set<SidebarFilterSource> => new Set(vals);
const workspaces = (...vals: string[]): Set<string> => new Set(vals);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('isHistoryFilterActive', () => {
  it('returns false for the default criteria', () => {
    expect(isHistoryFilterActive(DEFAULT_HISTORY_FILTER)).toBe(false);
  });

  it('returns true when any axis narrows', () => {
    expect(isHistoryFilterActive(criteria({ sources: sources('claude_code') }))).toBe(true);
    expect(isHistoryFilterActive(criteria({ workspaces: workspaces('/foo') }))).toBe(true);
    expect(isHistoryFilterActive(criteria({ preset: 'last7' }))).toBe(true);
    expect(isHistoryFilterActive(criteria({ search: 'hello' }))).toBe(true);
  });

  it('treats whitespace-only search as inactive', () => {
    expect(isHistoryFilterActive(criteria({ search: '   ' }))).toBe(false);
  });
});

describe('applyHistoryFilter', () => {
  const allConvs = [
    makeConv({ id: 'cc-1', source: 'claude_code', name: 'cc one', workspace: '/proj/a' }),
    makeConv({ id: 'cp-1', source: 'copilot', name: 'cp one', workspace: '/proj/b' }),
    makeConv({ id: 'na-1', source: 'aionui', name: 'native one', workspace: '/proj/a' }),
    makeConv({ id: 'na-undef', name: 'native undefined', workspace: '' }),
    makeConv({ id: 'odd-1', source: 'telegram', name: 'telegram one', workspace: '/proj/c' }),
  ];

  it('returns the input array reference unchanged when filter is inactive and no overlay', () => {
    expect(applyHistoryFilter(allConvs, DEFAULT_HISTORY_FILTER)).toBe(allConvs);
  });

  it('single-source filter drops Copilot + Native + outliers', () => {
    const result = applyHistoryFilter(allConvs, criteria({ sources: sources('claude_code') }));
    expect(result.map((c) => c.id)).toEqual(['cc-1']);
  });

  it('multi-source filter drops only sources not in the set', () => {
    const result = applyHistoryFilter(allConvs, criteria({ sources: sources('claude_code', 'copilot') }));
    expect(result.map((c) => c.id)).toEqual(['cc-1', 'cp-1']);
  });

  it("'native' source admits aionui + undefined + null source values", () => {
    const withNullSource = makeConv({ id: 'na-null', name: 'null src', workspace: '/proj/x' });
    (withNullSource as unknown as { source: unknown }).source = null;
    const set = [...allConvs, withNullSource];
    const result = applyHistoryFilter(set, criteria({ sources: sources('native') }));
    expect(result.map((c) => c.id).toSorted()).toEqual(['na-1', 'na-null', 'na-undef']);
  });

  it('workspace filter narrows by selected workspaces', () => {
    const result = applyHistoryFilter(allConvs, criteria({ workspaces: workspaces('/proj/a') }));
    expect(result.map((c) => c.id)).toEqual(['cc-1', 'na-1']);
  });

  it("workspace filter with '__none__' token admits rows without extra.workspace", () => {
    const result = applyHistoryFilter(allConvs, criteria({ workspaces: workspaces(NO_WORKSPACE_TOKEN) }));
    expect(result.map((c) => c.id)).toEqual(['na-undef']);
  });

  it('workspace filter narrows even when extra is null', () => {
    const nullExtra = makeConv({ id: 'extra-null', extraOverride: null });
    const set = [...allConvs, nullExtra];
    const result = applyHistoryFilter(set, criteria({ workspaces: workspaces(NO_WORKSPACE_TOKEN) }));
    expect(result.map((c) => c.id).toSorted()).toEqual(['extra-null', 'na-undef']);
  });

  it('search needle matches conversation name (case-insensitive)', () => {
    const result = applyHistoryFilter(allConvs, criteria({ search: 'CP ONE' }));
    expect(result.map((c) => c.id)).toEqual(['cp-1']);
  });

  it('search needle matches workspace substring', () => {
    const result = applyHistoryFilter(allConvs, criteria({ search: 'proj/b' }));
    expect(result.map((c) => c.id)).toEqual(['cp-1']);
  });

  it('search needle with empty messageMatchIds returns name/workspace matches only', () => {
    const result = applyHistoryFilter(allConvs, criteria({ search: 'native', includeMessageContent: true }), new Set());
    expect(result.map((c) => c.id)).toEqual(['na-1', 'na-undef']);
  });

  it('search needle with messageMatchIds admits rows whose name/workspace do not match', () => {
    const result = applyHistoryFilter(
      allConvs,
      criteria({ search: 'native', includeMessageContent: true }),
      new Set(['cp-1'])
    );
    expect(result.map((c) => c.id).toSorted()).toEqual(['cp-1', 'na-1', 'na-undef']);
  });

  it('message-overlay alone (no narrowing axis active) still triggers filtering', () => {
    const result = applyHistoryFilter(
      allConvs,
      criteria({ search: 'totally-not-in-name', includeMessageContent: true }),
      new Set(['cp-1'])
    );
    expect(result.map((c) => c.id)).toEqual(['cp-1']);
  });

  it('combined filters apply with AND semantics', () => {
    const result = applyHistoryFilter(
      allConvs,
      criteria({
        sources: sources('claude_code', 'copilot'),
        workspaces: workspaces('/proj/a', '/proj/b'),
        search: 'one',
      })
    );
    expect(result.map((c) => c.id)).toEqual(['cc-1', 'cp-1']);
  });

  it('outlier source (telegram) is excluded when sources is narrowed', () => {
    const result = applyHistoryFilter(allConvs, criteria({ sources: sources('claude_code', 'native') }));
    expect(result.find((c) => c.id === 'odd-1')).toBeUndefined();
  });

  it('outlier source (telegram) is admitted under inactive (empty) source set', () => {
    const result = applyHistoryFilter(allConvs, DEFAULT_HISTORY_FILTER);
    expect(result.find((c) => c.id === 'odd-1')).toBeDefined();
  });

  it('defensive: row with undefined name does not match a non-empty needle', () => {
    const undefNameConv = makeConv({ id: 'no-name', workspace: '/proj/x' });
    (undefNameConv as unknown as { name: unknown }).name = undefined;
    const set = [undefNameConv];
    expect(applyHistoryFilter(set, criteria({ search: 'foo' }))).toEqual([]);
  });
});

describe('matchesDateRange', () => {
  const now = 1_700_000_000_000;
  const recent = makeConv({ id: 'recent', modifyTime: now - 2 * DAY });
  const old10 = makeConv({ id: 'old10', modifyTime: now - 10 * DAY });
  const old40 = makeConv({ id: 'old40', modifyTime: now - 40 * DAY });

  it("preset 'all' admits any modifyTime", () => {
    const c = criteria({ preset: 'all' });
    expect(matchesDateRange(recent, c, now)).toBe(true);
    expect(matchesDateRange(old10, c, now)).toBe(true);
    expect(matchesDateRange(old40, c, now)).toBe(true);
  });

  it("preset 'last7' admits only the last 7 days", () => {
    const c = criteria({ preset: 'last7' });
    expect(matchesDateRange(recent, c, now)).toBe(true);
    expect(matchesDateRange(old10, c, now)).toBe(false);
  });

  it("preset 'last30' admits the last 30 days", () => {
    const c = criteria({ preset: 'last30' });
    expect(matchesDateRange(recent, c, now)).toBe(true);
    expect(matchesDateRange(old10, c, now)).toBe(true);
    expect(matchesDateRange(old40, c, now)).toBe(false);
  });

  it("preset 'custom' with both bounds admits rows inside the range inclusively", () => {
    const c = criteria({
      preset: 'custom',
      customRange: { from: now - 15 * DAY, to: now - 5 * DAY },
    });
    expect(matchesDateRange(recent, c, now)).toBe(false);
    expect(matchesDateRange(old10, c, now)).toBe(true);
    expect(matchesDateRange(old40, c, now)).toBe(false);
  });

  it("preset 'custom' with from===null and to===null admits everything", () => {
    const c = criteria({ preset: 'custom', customRange: { from: null, to: null } });
    expect(matchesDateRange(recent, c, now)).toBe(true);
    expect(matchesDateRange(old40, c, now)).toBe(true);
  });

  it('exact boundary timestamps are admitted (inclusive)', () => {
    const c = criteria({
      preset: 'custom',
      customRange: { from: old10.modifyTime, to: old10.modifyTime },
    });
    expect(matchesDateRange(old10, c, now)).toBe(true);
  });
});

describe('collectWorkspaceOptions', () => {
  it('returns sorted workspace names + NO_WORKSPACE_TOKEN when at least one row has no workspace', () => {
    const opts = collectWorkspaceOptions([
      makeConv({ id: 'a', workspace: '/zeta' }),
      makeConv({ id: 'b', workspace: '/alpha' }),
      makeConv({ id: 'c', workspace: '' }),
    ]);
    expect(opts).toEqual(['/alpha', '/zeta', NO_WORKSPACE_TOKEN]);
  });

  it('omits NO_WORKSPACE_TOKEN when every row has a workspace', () => {
    const opts = collectWorkspaceOptions([
      makeConv({ id: 'a', workspace: '/zeta' }),
      makeConv({ id: 'b', workspace: '/alpha' }),
    ]);
    expect(opts).toEqual(['/alpha', '/zeta']);
  });

  it('treats null extra as no workspace', () => {
    const opts = collectWorkspaceOptions([
      makeConv({ id: 'a', extraOverride: null }),
      makeConv({ id: 'b', workspace: '/alpha' }),
    ]);
    expect(opts).toEqual(['/alpha', NO_WORKSPACE_TOKEN]);
  });

  it('deduplicates duplicate workspaces', () => {
    const opts = collectWorkspaceOptions([
      makeConv({ id: 'a', workspace: '/alpha' }),
      makeConv({ id: 'b', workspace: '/alpha' }),
    ]);
    expect(opts).toEqual(['/alpha']);
  });

  it('returns an empty array on empty input', () => {
    expect(collectWorkspaceOptions([])).toEqual([]);
  });
});

describe('sortConversations', () => {
  it("'date' sorts by modifyTime descending", () => {
    const out = sortConversations(
      [
        makeConv({ id: 'a', modifyTime: 100 }),
        makeConv({ id: 'b', modifyTime: 300 }),
        makeConv({ id: 'c', modifyTime: 200 }),
      ],
      'date'
    );
    expect(out.map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });

  it("'name' sorts by name ascending (locale-aware)", () => {
    const out = sortConversations(
      [
        makeConv({ id: 'a', name: 'Zebra' }),
        makeConv({ id: 'b', name: 'apple' }),
        makeConv({ id: 'c', name: 'banana' }),
      ],
      'name'
    );
    // localeCompare is case-insensitive in most locales — apple < banana < Zebra
    expect(out.map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });

  it('preserves input order on ties (stable sort)', () => {
    const out = sortConversations(
      [
        makeConv({ id: 'a', modifyTime: 100 }),
        makeConv({ id: 'b', modifyTime: 100 }),
        makeConv({ id: 'c', modifyTime: 100 }),
      ],
      'date'
    );
    expect(out.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const input = [makeConv({ id: 'a', modifyTime: 100 }), makeConv({ id: 'b', modifyTime: 200 })];
    const snapshot = input.map((c) => c.id);
    sortConversations(input, 'date');
    expect(input.map((c) => c.id)).toEqual(snapshot);
  });

  it('treats missing modifyTime as 0', () => {
    const noTime = makeConv({ id: 'no-time' });
    (noTime as unknown as { modifyTime: unknown }).modifyTime = undefined;
    const out = sortConversations([noTime, makeConv({ id: 'has', modifyTime: 1 })], 'date');
    expect(out.map((c) => c.id)).toEqual(['has', 'no-time']);
  });
});

describe('hasNonHydratedImportedRows', () => {
  it('returns false when no row is imported', () => {
    expect(hasNonHydratedImportedRows([makeConv({ id: 'a', source: 'aionui' }), makeConv({ id: 'b' })])).toBe(false);
  });

  it('returns true when at least one imported row has no hydratedAt', () => {
    const rows = [
      makeConv({
        id: 'a',
        source: 'claude_code',
        extraOverride: { workspace: '/p', sourceFilePath: '/x.jsonl' },
      }),
    ];
    expect(hasNonHydratedImportedRows(rows)).toBe(true);
  });

  it('returns false when every imported row is hydrated', () => {
    const rows = [
      makeConv({
        id: 'a',
        source: 'claude_code',
        extraOverride: { workspace: '/p', sourceFilePath: '/x.jsonl', hydratedAt: 12345 },
      }),
    ];
    expect(hasNonHydratedImportedRows(rows)).toBe(false);
  });

  it('treats hydratedAt === 0 as not hydrated', () => {
    const rows = [
      makeConv({
        id: 'a',
        source: 'claude_code',
        extraOverride: { workspace: '/p', sourceFilePath: '/x.jsonl', hydratedAt: 0 },
      }),
    ];
    expect(hasNonHydratedImportedRows(rows)).toBe(true);
  });
});

describe('sectionKeyToPreset', () => {
  it('maps today/yesterday/recent7Days to last7', () => {
    expect(sectionKeyToPreset('conversation.history.today')).toBe('last7');
    expect(sectionKeyToPreset('conversation.history.yesterday')).toBe('last7');
    expect(sectionKeyToPreset('conversation.history.recent7Days')).toBe('last7');
  });

  it("maps earlier to 'all'", () => {
    expect(sectionKeyToPreset('conversation.history.earlier')).toBe('all');
  });

  it("falls back to 'all' for unknown keys", () => {
    expect(sectionKeyToPreset('nope')).toBe('all');
    expect(sectionKeyToPreset(null)).toBe('all');
    expect(sectionKeyToPreset(undefined)).toBe('all');
  });
});
