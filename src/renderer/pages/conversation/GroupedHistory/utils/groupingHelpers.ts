/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TChatConversation } from '@/common/config/storage';
import { getActivityTime, getTimelineLabel } from '@/renderer/utils/chat/timeline';
import { getWorkspaceDisplayName } from '@/renderer/utils/workspace/workspace';

import type { GroupedHistoryResult, SectionTimelineKey, TimelineItem, TimelineSection, WorkspaceGroup } from '../types';
import { getConversationSortOrder } from './sortOrderHelpers';

export const getConversationTimelineLabel = (conversation: TChatConversation, t: (key: string) => string): string => {
  const time = getActivityTime(conversation);
  return getTimelineLabel(time, Date.now(), t);
};

export const isConversationPinned = (conversation: TChatConversation): boolean => {
  const extra = conversation.extra as { pinned?: boolean } | undefined;
  return Boolean(extra?.pinned);
};

export const getConversationPinnedAt = (conversation: TChatConversation): number => {
  const extra = conversation.extra as { pinnedAt?: number } | undefined;
  if (typeof extra?.pinnedAt === 'number') {
    return extra.pinnedAt;
  }
  return 0;
};

export const groupConversationsByTimelineAndWorkspace = (
  conversations: TChatConversation[],
  t: (key: string) => string
): TimelineSection[] => {
  const allWorkspaceGroups = new Map<string, TChatConversation[]>();
  const withoutWorkspaceConvs: TChatConversation[] = [];

  conversations.forEach((conv) => {
    const workspace = conv.extra?.workspace;
    const customWorkspace = conv.extra?.customWorkspace;

    if (customWorkspace && workspace) {
      if (!allWorkspaceGroups.has(workspace)) {
        allWorkspaceGroups.set(workspace, []);
      }
      allWorkspaceGroups.get(workspace)!.push(conv);
    } else {
      withoutWorkspaceConvs.push(conv);
    }
  });

  const workspaceGroupsByTimeline = new Map<string, WorkspaceGroup[]>();
  const groupLookup = new Map<string, WorkspaceGroup>();

  allWorkspaceGroups.forEach((convList, workspace) => {
    convList.forEach((conv) => {
      const timeline = getConversationTimelineLabel(conv, t);

      if (!workspaceGroupsByTimeline.has(timeline)) {
        workspaceGroupsByTimeline.set(timeline, []);
      }

      const lookupKey = `${timeline}\0${workspace}`;
      let group = groupLookup.get(lookupKey);
      if (!group) {
        group = {
          workspace,
          displayName: getWorkspaceDisplayName(workspace),
          conversations: [],
        };
        workspaceGroupsByTimeline.get(timeline)!.push(group);
        groupLookup.set(lookupKey, group);
      }
      group.conversations.push(conv);
    });
  });

  workspaceGroupsByTimeline.forEach((groups) => {
    groups.forEach((group) => {
      group.conversations.sort((a, b) => getActivityTime(b) - getActivityTime(a));
    });
  });

  const withoutWorkspaceByTimeline = new Map<string, TChatConversation[]>();

  withoutWorkspaceConvs.forEach((conv) => {
    const timeline = getConversationTimelineLabel(conv, t);
    if (!withoutWorkspaceByTimeline.has(timeline)) {
      withoutWorkspaceByTimeline.set(timeline, []);
    }
    withoutWorkspaceByTimeline.get(timeline)!.push(conv);
  });

  const timelineOrder: SectionTimelineKey[] = [
    'conversation.history.today',
    'conversation.history.yesterday',
    'conversation.history.recent7Days',
    'conversation.history.earlier',
  ];
  const sections: TimelineSection[] = [];

  timelineOrder.forEach((timelineKey) => {
    const timeline = t(timelineKey);
    const withWorkspace = workspaceGroupsByTimeline.get(timeline) || [];
    const withoutWorkspace = withoutWorkspaceByTimeline.get(timeline) || [];

    if (withWorkspace.length === 0 && withoutWorkspace.length === 0) return;

    const items: TimelineItem[] = [];

    withWorkspace.forEach((group) => {
      const time = getActivityTime(group.conversations[0]);
      items.push({
        type: 'workspace',
        time,
        workspaceGroup: group,
      });
    });

    withoutWorkspace.forEach((conv) => {
      items.push({
        type: 'conversation',
        time: getActivityTime(conv),
        conversation: conv,
      });
    });

    items.sort((a, b) => b.time - a.time);

    sections.push({
      timeline,
      timelineKey,
      items,
    });
  });

  return sections;
};

export const buildGroupedHistory = (
  conversations: TChatConversation[],
  t: (key: string) => string
): GroupedHistoryResult => {
  const pinnedConversations = conversations
    .filter((conversation) => isConversationPinned(conversation))
    .toSorted((a, b) => {
      const orderA = getConversationSortOrder(a);
      const orderB = getConversationSortOrder(b);
      if (orderA !== undefined && orderB !== undefined) return orderA - orderB;
      if (orderA !== undefined) return -1;
      if (orderB !== undefined) return 1;
      return getConversationPinnedAt(b) - getConversationPinnedAt(a);
    });

  const normalConversations = conversations.filter((conversation) => !isConversationPinned(conversation));

  return {
    pinnedConversations,
    timelineSections: groupConversationsByTimelineAndWorkspace(normalConversations, t),
  };
};

/**
 * Per-section row-count budget defaults. Keyed by timeline key (not translated
 * label) so locale changes don't desync. Exhaustive over SectionTimelineKey —
 * adding a new key fails type-check until this record is updated.
 */
export const SECTION_DEFAULT_LIMIT: Record<SectionTimelineKey, number> = {
  'conversation.history.today': 15,
  'conversation.history.yesterday': 10,
  'conversation.history.recent7Days': 20,
  'conversation.history.earlier': 20,
};

export const getSectionDefaultLimit = (timelineKey: SectionTimelineKey): number => SECTION_DEFAULT_LIMIT[timelineKey];

/**
 * Row count contributed by a timeline item to its section's visible-row budget.
 * A workspace group counts as `1 + children` when its workspace is treated as
 * expanded by the caller's predicate; otherwise `1`. Standalone conversations
 * are always `1`.
 */
export const getItemRowCount = (item: TimelineItem, isWorkspaceExpanded: (workspace: string) => boolean): number => {
  if (item.type === 'workspace' && item.workspaceGroup) {
    return isWorkspaceExpanded(item.workspaceGroup.workspace) ? 1 + item.workspaceGroup.conversations.length : 1;
  }
  return 1;
};

export type TruncateSectionResult = {
  visibleItems: TimelineItem[];
  hiddenItemCount: number;
  hiddenRowCount: number;
  totalRowCount: number;
  /** Smallest budget that would admit at least one currently-hidden item; null if nothing hidden. */
  nextRevealBudget: number | null;
};

/**
 * Apply a visible-row budget to a timeline section in time-descending order.
 *
 * Rules:
 *   - Items are admitted in their original (time-descending) order.
 *   - A workspace item is included whole (all-or-nothing) — never partially sliced.
 *   - Admission stops at the first item whose row count would push past the budget.
 *     A later smaller item is NOT pulled forward, preserving the timeline contract.
 *   - The first item in a non-empty section is always admitted, even if it alone
 *     exceeds the budget — guarantees at least one visible row per non-empty section.
 *   - `nextRevealBudget` is the cumulative row count required to admit the first
 *     hidden item; null when no items are hidden.
 */
export const truncateSection = (args: {
  items: TimelineItem[];
  isWorkspaceExpanded: (workspace: string) => boolean;
  budget: number;
}): TruncateSectionResult => {
  const { items, isWorkspaceExpanded, budget } = args;
  const visibleItems: TimelineItem[] = [];
  let visibleRowCount = 0;
  let hiddenItemCount = 0;
  let hiddenRowCount = 0;
  let nextRevealBudget: number | null = null;
  let totalRowCount = 0;
  let admissionClosed = false;

  for (const item of items) {
    const itemRows = getItemRowCount(item, isWorkspaceExpanded);
    totalRowCount += itemRows;

    if (admissionClosed) {
      hiddenItemCount += 1;
      hiddenRowCount += itemRows;
      continue;
    }

    const fits = visibleRowCount + itemRows <= budget;
    const isFirst = visibleItems.length === 0;

    if (fits || isFirst) {
      visibleItems.push(item);
      visibleRowCount += itemRows;
    } else {
      admissionClosed = true;
      if (nextRevealBudget === null) {
        nextRevealBudget = visibleRowCount + itemRows;
      }
      hiddenItemCount += 1;
      hiddenRowCount += itemRows;
    }
  }

  return {
    visibleItems,
    hiddenItemCount,
    hiddenRowCount,
    totalRowCount,
    nextRevealBudget,
  };
};
