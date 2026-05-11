/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  getItemRowCount,
  getSectionDefaultLimit,
  SECTION_DEFAULT_LIMIT,
  truncateSection,
} from '../../../src/renderer/pages/conversation/GroupedHistory/utils/groupingHelpers';
import type {
  SectionTimelineKey,
  TimelineItem,
  WorkspaceGroup,
} from '../../../src/renderer/pages/conversation/GroupedHistory/types';
import type { TChatConversation } from '../../../src/common/config/storage';

// ---------------------------------------------------------------------------
// Test factories — minimal shapes; only fields the helpers read are populated.
// ---------------------------------------------------------------------------

const makeConv = (id: string): TChatConversation =>
  ({
    id,
    createTime: 0,
    modifyTime: 0,
    extra: {},
  }) as TChatConversation;

const makeStandaloneItem = (id: string, time = 0): TimelineItem => ({
  type: 'conversation',
  time,
  conversation: makeConv(id),
});

const makeWorkspaceGroup = (workspace: string, ids: string[]): WorkspaceGroup => ({
  workspace,
  displayName: workspace,
  conversations: ids.map((id) => makeConv(id)),
});

const makeWorkspaceItem = (workspace: string, ids: string[], time = 0): TimelineItem => ({
  type: 'workspace',
  time,
  workspaceGroup: makeWorkspaceGroup(workspace, ids),
});

// Predicate constants for clarity.
const alwaysExpanded = () => true;
const neverExpanded = () => false;
const expandedFor =
  (...workspaces: string[]) =>
  (ws: string) =>
    workspaces.includes(ws);

// ---------------------------------------------------------------------------
// getItemRowCount
// ---------------------------------------------------------------------------

describe('getItemRowCount', () => {
  it('returns 1 for a standalone conversation', () => {
    expect(getItemRowCount(makeStandaloneItem('c1'), neverExpanded)).toBe(1);
  });

  it('returns 1 for a collapsed workspace group', () => {
    const item = makeWorkspaceItem('/ws/a', ['a1', 'a2', 'a3']);
    expect(getItemRowCount(item, neverExpanded)).toBe(1);
  });

  it('returns 1 + children when the workspace is expanded', () => {
    const item = makeWorkspaceItem('/ws/a', ['a1', 'a2', 'a3']);
    expect(getItemRowCount(item, alwaysExpanded)).toBe(4);
  });

  it('uses the predicate per-workspace (only matching workspace expands)', () => {
    const itemA = makeWorkspaceItem('/ws/a', ['a1', 'a2']);
    const itemB = makeWorkspaceItem('/ws/b', ['b1', 'b2', 'b3', 'b4']);
    const predicate = expandedFor('/ws/b');
    expect(getItemRowCount(itemA, predicate)).toBe(1);
    expect(getItemRowCount(itemB, predicate)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// getSectionDefaultLimit & SECTION_DEFAULT_LIMIT
// ---------------------------------------------------------------------------

describe('getSectionDefaultLimit', () => {
  it('returns the documented default budget per timeline key', () => {
    expect(getSectionDefaultLimit('conversation.history.today')).toBe(15);
    expect(getSectionDefaultLimit('conversation.history.yesterday')).toBe(10);
    expect(getSectionDefaultLimit('conversation.history.recent7Days')).toBe(20);
    expect(getSectionDefaultLimit('conversation.history.earlier')).toBe(20);
  });

  it('SECTION_DEFAULT_LIMIT is exhaustive over the SectionTimelineKey union', () => {
    const expectedKeys: SectionTimelineKey[] = [
      'conversation.history.today',
      'conversation.history.yesterday',
      'conversation.history.recent7Days',
      'conversation.history.earlier',
    ];
    expect(Object.keys(SECTION_DEFAULT_LIMIT).toSorted()).toEqual([...expectedKeys].toSorted());
  });
});

// ---------------------------------------------------------------------------
// truncateSection
// ---------------------------------------------------------------------------

describe('truncateSection', () => {
  it('returns empty result for an empty section', () => {
    const result = truncateSection({ items: [], isWorkspaceExpanded: neverExpanded, budget: 10 });
    expect(result).toEqual({
      visibleItems: [],
      hiddenItemCount: 0,
      hiddenRowCount: 0,
      totalRowCount: 0,
      nextRevealBudget: null,
    });
  });

  it('truncates "Today" to its budget with the correct hidden-row count', () => {
    // 20 standalone conversations, Today budget 15.
    const items = Array.from({ length: 20 }, (_, i) => makeStandaloneItem(`c${i}`));
    const result = truncateSection({ items, isWorkspaceExpanded: neverExpanded, budget: 15 });
    expect(result.visibleItems).toHaveLength(15);
    expect(result.hiddenItemCount).toBe(5);
    expect(result.hiddenRowCount).toBe(5);
    expect(result.totalRowCount).toBe(20);
    expect(result.nextRevealBudget).toBe(16);
  });

  it('truncates each section independently (separate budgets, no bleed)', () => {
    // Today section, budget 15.
    const today = Array.from({ length: 18 }, (_, i) => makeStandaloneItem(`t${i}`));
    const todayResult = truncateSection({
      items: today,
      isWorkspaceExpanded: neverExpanded,
      budget: 15,
    });
    // Earlier section, budget 20.
    const earlier = Array.from({ length: 25 }, (_, i) => makeStandaloneItem(`e${i}`));
    const earlierResult = truncateSection({
      items: earlier,
      isWorkspaceExpanded: neverExpanded,
      budget: 20,
    });
    expect(todayResult.visibleItems).toHaveLength(15);
    expect(todayResult.hiddenItemCount).toBe(3);
    expect(earlierResult.visibleItems).toHaveLength(20);
    expect(earlierResult.hiddenItemCount).toBe(5);
  });

  it('counts an expanded workspace group as 1 + children rows', () => {
    const items: TimelineItem[] = [
      makeWorkspaceItem('/ws/a', ['a1', 'a2', 'a3', 'a4', 'a5']), // 6 rows expanded
      makeStandaloneItem('c1'),
      makeStandaloneItem('c2'),
      makeStandaloneItem('c3'),
      makeStandaloneItem('c4'),
    ];
    const result = truncateSection({
      items,
      isWorkspaceExpanded: alwaysExpanded,
      budget: 10,
    });
    expect(result.visibleItems).toHaveLength(5);
    expect(result.totalRowCount).toBe(10);
    expect(result.hiddenItemCount).toBe(0);
    expect(result.nextRevealBudget).toBeNull();
  });

  it('counts a collapsed workspace group as 1 row', () => {
    const items: TimelineItem[] = [
      makeWorkspaceItem('/ws/a', ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']),
      makeWorkspaceItem('/ws/b', ['b1', 'b2', 'b3']),
      makeStandaloneItem('c1'),
    ];
    const result = truncateSection({
      items,
      isWorkspaceExpanded: neverExpanded,
      budget: 10,
    });
    expect(result.visibleItems).toHaveLength(3);
    expect(result.totalRowCount).toBe(3);
    expect(result.hiddenItemCount).toBe(0);
  });

  it('always admits the first item even when it exceeds the budget', () => {
    // First item is a huge expanded workspace (51 rows), budget = 10.
    const huge = makeWorkspaceItem(
      '/ws/big',
      Array.from({ length: 50 }, (_, i) => `big${i}`)
    );
    const small = makeStandaloneItem('c1');
    const result = truncateSection({
      items: [huge, small],
      isWorkspaceExpanded: alwaysExpanded,
      budget: 10,
    });
    expect(result.visibleItems).toHaveLength(1);
    expect(result.visibleItems[0]).toBe(huge);
    expect(result.hiddenItemCount).toBe(1);
    expect(result.hiddenRowCount).toBe(1);
    expect(result.nextRevealBudget).toBe(52);
  });

  it('returns all items with no hidden counts when total rows fit under the budget', () => {
    const items: TimelineItem[] = [makeStandaloneItem('c1'), makeStandaloneItem('c2'), makeStandaloneItem('c3')];
    const result = truncateSection({
      items,
      isWorkspaceExpanded: neverExpanded,
      budget: 20,
    });
    expect(result.visibleItems).toEqual(items);
    expect(result.hiddenItemCount).toBe(0);
    expect(result.hiddenRowCount).toBe(0);
    expect(result.nextRevealBudget).toBeNull();
  });

  it('admits the first item when budget is 0', () => {
    // Edge case: defensive — production code never passes 0 (min default is 10).
    const items = [makeStandaloneItem('c1'), makeStandaloneItem('c2')];
    const result = truncateSection({
      items,
      isWorkspaceExpanded: neverExpanded,
      budget: 0,
    });
    expect(result.visibleItems).toHaveLength(1);
    expect(result.hiddenItemCount).toBe(1);
    expect(result.nextRevealBudget).toBe(2);
  });

  it('stops admission at the first overflow — does NOT pull a smaller later item forward', () => {
    // budget=10. Items: small (1), small (1), big workspace (10 rows expanded), small (1).
    // After two smalls (total 2), the big workspace would push to 12 > 10, so it's rejected.
    // The trailing small standalone must NOT be pulled forward, even though it would fit (2+1).
    const items: TimelineItem[] = [
      makeStandaloneItem('c1'),
      makeStandaloneItem('c2'),
      makeWorkspaceItem('/ws/big', ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9']), // 10 rows expanded
      makeStandaloneItem('c3'),
    ];
    const result = truncateSection({
      items,
      isWorkspaceExpanded: alwaysExpanded,
      budget: 10,
    });
    expect(result.visibleItems).toHaveLength(2);
    expect(result.visibleItems[0].conversation?.id).toBe('c1');
    expect(result.visibleItems[1].conversation?.id).toBe('c2');
    expect(result.hiddenItemCount).toBe(2);
    expect(result.hiddenRowCount).toBe(11); // 10 (workspace) + 1 (c3)
    expect(result.nextRevealBudget).toBe(12);
  });

  it('boundary: section with rows exactly equal to budget shows everything', () => {
    const items = Array.from({ length: 15 }, (_, i) => makeStandaloneItem(`c${i}`));
    const result = truncateSection({
      items,
      isWorkspaceExpanded: neverExpanded,
      budget: 15,
    });
    expect(result.visibleItems).toHaveLength(15);
    expect(result.hiddenItemCount).toBe(0);
    expect(result.nextRevealBudget).toBeNull();
  });

  it('admits standalone + workspace mix in original order until the budget is exhausted', () => {
    const items: TimelineItem[] = [
      makeStandaloneItem('c1'),
      makeWorkspaceItem('/ws/a', ['a1', 'a2', 'a3']), // 4 rows expanded
      makeStandaloneItem('c2'),
      makeStandaloneItem('c3'),
      makeStandaloneItem('c4'),
      makeStandaloneItem('c5'),
    ];
    const result = truncateSection({
      items,
      isWorkspaceExpanded: alwaysExpanded,
      budget: 7,
    });
    // Order: c1 (1) -> total 1; ws/a (4) -> total 5; c2 (1) -> total 6; c3 (1) -> total 7;
    // c4 would push to 8 — rejected, admission stops; c5 also hidden.
    expect(result.visibleItems).toHaveLength(4);
    expect(result.visibleItems[0].conversation?.id).toBe('c1');
    expect(result.visibleItems[1].workspaceGroup?.workspace).toBe('/ws/a');
    expect(result.visibleItems[2].conversation?.id).toBe('c2');
    expect(result.visibleItems[3].conversation?.id).toBe('c3');
    expect(result.hiddenItemCount).toBe(2);
    expect(result.hiddenRowCount).toBe(2);
    expect(result.nextRevealBudget).toBe(8);
  });

  it('reports nextRevealBudget as the row count required to admit the next hidden item', () => {
    const items: TimelineItem[] = [
      makeStandaloneItem('c1'),
      makeStandaloneItem('c2'),
      makeWorkspaceItem(
        '/ws/big',
        Array.from({ length: 9 }, (_, i) => `b${i}`)
      ), // 10 rows expanded
    ];
    const result = truncateSection({
      items,
      isWorkspaceExpanded: alwaysExpanded,
      budget: 5,
    });
    expect(result.visibleItems).toHaveLength(2);
    expect(result.nextRevealBudget).toBe(12); // 2 visible + 10 workspace rows
  });
});
