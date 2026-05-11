/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSectionVisibleBudgets } from '../../../src/renderer/pages/conversation/GroupedHistory/hooks/useSectionVisibleBudgets';
import type {
  SectionTimelineKey,
  TimelineItem,
  TimelineSection,
} from '../../../src/renderer/pages/conversation/GroupedHistory/types';
import { truncateSection } from '../../../src/renderer/pages/conversation/GroupedHistory/utils/groupingHelpers';
import type { TChatConversation } from '../../../src/common/config/storage';

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Test harness — a minimal render component that reproduces the exact
// JSX gating from WorkspaceGroupedHistory's timeline-section render branch:
//   - per-section truncation via truncateSection
//   - "Show N more" button rendered iff `!collapsed && hiddenRowCount > 0`
//   - click handler bumps the section budget
// Plus an isolated "pinned" branch that bypasses truncateSection entirely.
//
// This mirrors the production wiring without needing to mock the full
// WorkspaceGroupedHistory tree (8 hooks, drag/drop, batch, export, cron...).
// ---------------------------------------------------------------------------

const makeConv = (id: string): TChatConversation =>
  ({ id, createTime: 0, modifyTime: 0, extra: {} }) as TChatConversation;

const makeConvItem = (id: string): TimelineItem => ({
  type: 'conversation',
  time: 0,
  conversation: makeConv(id),
});

const makeSection = (key: SectionTimelineKey, count: number): TimelineSection => ({
  timeline: key,
  timelineKey: key,
  items: Array.from({ length: count }, (_, i) => makeConvItem(`${key}-${i}`)),
});

const SectionsHarness: React.FC<{
  timelineSections: TimelineSection[];
  pinnedConversations: TChatConversation[];
  collapsed: boolean;
}> = ({ timelineSections, pinnedConversations, collapsed }) => {
  const sectionBudgets = useSectionVisibleBudgets();

  const truncated = React.useMemo(() => {
    const isWorkspaceExpanded = (_ws: string) => collapsed; // never matters here — only standalone items
    return timelineSections.map((section) => {
      const budget = sectionBudgets.getBudget(section.timelineKey);
      const result = truncateSection({
        items: section.items,
        isWorkspaceExpanded,
        budget,
      });
      return { section, result };
    });
  }, [timelineSections, sectionBudgets, collapsed]);

  return (
    <div>
      {/* Pinned: never passes through truncateSection. */}
      {pinnedConversations.length > 0 && (
        <div data-testid='pinned-section'>
          {pinnedConversations.map((c) => (
            <div key={c.id} data-testid={`pinned-row-${c.id}`}>
              {c.id}
            </div>
          ))}
        </div>
      )}

      {/* Timeline sections, mirroring index.tsx's render gating. */}
      {truncated.map(({ section, result }) => (
        <div key={section.timelineKey} data-testid={`section-${section.timelineKey}`}>
          {result.visibleItems.map((item) => (
            <div key={item.conversation?.id ?? 'ws'} data-testid={`item-${item.conversation?.id ?? 'ws'}`} />
          ))}
          {!collapsed && result.hiddenRowCount > 0 && (
            <button
              data-testid={`expander-${section.timelineKey}`}
              onClick={() =>
                sectionBudgets.bumpBudget(section.timelineKey, result.totalRowCount, result.nextRevealBudget)
              }
            >
              Show {result.hiddenRowCount} more
            </button>
          )}
        </div>
      ))}
    </div>
  );
};

describe('GroupedHistory truncation rendering', () => {
  it('renders all pinned rows and no expander for pinned (>30 pinned)', () => {
    const pinned = Array.from({ length: 35 }, (_, i) => makeConv(`p${i}`));
    render(<SectionsHarness timelineSections={[]} pinnedConversations={pinned} collapsed={false} />);

    expect(screen.getByTestId('pinned-section')).toBeTruthy();
    // All 35 pinned rows rendered.
    expect(screen.getAllByTestId(/^pinned-row-/)).toHaveLength(35);
    // No expander anywhere — pinned never goes through truncateSection.
    expect(screen.queryByTestId(/^expander-/)).toBeNull();
  });

  it('renders "Show N more" expander when timeline section overflows its budget (collapsed=false)', () => {
    const today = makeSection('conversation.history.today', 22); // default budget 15 → 7 hidden
    render(<SectionsHarness timelineSections={[today]} pinnedConversations={[]} collapsed={false} />);

    expect(screen.getAllByTestId(/^item-conversation\.history\.today-/)).toHaveLength(15);
    const expander = screen.getByTestId('expander-conversation.history.today');
    expect(expander.textContent).toBe('Show 7 more');
  });

  it('does NOT render the expander in collapsed-rail mode even when rows are hidden', () => {
    const today = makeSection('conversation.history.today', 22);
    render(<SectionsHarness timelineSections={[today]} pinnedConversations={[]} collapsed={true} />);

    // Truncation still applies (15 visible).
    expect(screen.getAllByTestId(/^item-conversation\.history\.today-/)).toHaveLength(15);
    // But the button must not be in the DOM.
    expect(screen.queryByTestId('expander-conversation.history.today')).toBeNull();
  });

  it('clicking "Show N more" reveals additional rows up to the section budget', () => {
    const today = makeSection('conversation.history.today', 40); // 40 - 15 = 25 hidden
    render(<SectionsHarness timelineSections={[today]} pinnedConversations={[]} collapsed={false} />);

    expect(screen.getAllByTestId(/^item-conversation\.history\.today-/)).toHaveLength(15);
    expect(screen.getByTestId('expander-conversation.history.today').textContent).toBe('Show 25 more');

    act(() => {
      fireEvent.click(screen.getByTestId('expander-conversation.history.today'));
    });

    // After one click: budget +15 → 30 visible.
    expect(screen.getAllByTestId(/^item-conversation\.history\.today-/)).toHaveLength(30);
    expect(screen.getByTestId('expander-conversation.history.today').textContent).toBe('Show 10 more');
  });

  it('hides the expander after enough clicks reveal every row', () => {
    const today = makeSection('conversation.history.today', 18); // 3 hidden
    render(<SectionsHarness timelineSections={[today]} pinnedConversations={[]} collapsed={false} />);

    act(() => {
      fireEvent.click(screen.getByTestId('expander-conversation.history.today'));
    });

    expect(screen.getAllByTestId(/^item-conversation\.history\.today-/)).toHaveLength(18);
    expect(screen.queryByTestId('expander-conversation.history.today')).toBeNull();
  });

  it('truncates Today and Earlier independently — each click only bumps its own section', () => {
    const today = makeSection('conversation.history.today', 18); // 3 hidden under budget 15
    const earlier = makeSection('conversation.history.earlier', 25); // 5 hidden under budget 20
    render(<SectionsHarness timelineSections={[today, earlier]} pinnedConversations={[]} collapsed={false} />);

    expect(screen.getAllByTestId(/^item-conversation\.history\.today-/)).toHaveLength(15);
    expect(screen.getAllByTestId(/^item-conversation\.history\.earlier-/)).toHaveLength(20);

    act(() => {
      fireEvent.click(screen.getByTestId('expander-conversation.history.today'));
    });

    expect(screen.getAllByTestId(/^item-conversation\.history\.today-/)).toHaveLength(18);
    // Earlier section unchanged.
    expect(screen.getAllByTestId(/^item-conversation\.history\.earlier-/)).toHaveLength(20);
    expect(screen.getByTestId('expander-conversation.history.earlier').textContent).toBe('Show 5 more');
  });

  it('renders nothing under a section that already fits inside its default budget', () => {
    const yesterday = makeSection('conversation.history.yesterday', 8); // budget 10, all fit
    render(<SectionsHarness timelineSections={[yesterday]} pinnedConversations={[]} collapsed={false} />);

    expect(screen.getAllByTestId(/^item-conversation\.history\.yesterday-/)).toHaveLength(8);
    expect(screen.queryByTestId('expander-conversation.history.yesterday')).toBeNull();
  });
});

describe('GroupedHistory truncation rendering — fail-fast guards', () => {
  it('truncating an empty section produces no visible items and no expander', () => {
    const today: TimelineSection = {
      timeline: 'conversation.history.today',
      timelineKey: 'conversation.history.today',
      items: [],
    };
    render(<SectionsHarness timelineSections={[today]} pinnedConversations={[]} collapsed={false} />);
    expect(screen.queryByTestId(/^item-/)).toBeNull();
    expect(screen.queryByTestId('expander-conversation.history.today')).toBeNull();
  });
});

// Ensure vi import isn't tree-shaken — leaving it here for parity with sibling tests.
void vi;
