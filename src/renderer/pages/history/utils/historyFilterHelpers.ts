/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TChatConversation } from '@/common/config/storage';
import type { SidebarFilterSource } from '@/renderer/pages/conversation/GroupedHistory/utils/sidebarFilterHelpers';

/** Sentinel value used to represent rows with no `extra.workspace` in the workspace filter. */
export const NO_WORKSPACE_TOKEN = '__none__';

export type HistoryDatePreset = 'last7' | 'last30' | 'all' | 'custom';

export type HistorySortKey = 'date' | 'name';

export type HistoryFilterCriteria = {
  /** Multi-select source set. Empty set means "filter inactive" (admit all sources). */
  sources: ReadonlySet<SidebarFilterSource>;
  /**
   * Multi-select workspace set. Empty set = inactive. Contains workspace strings;
   * the special `NO_WORKSPACE_TOKEN` admits rows where `extra.workspace` is missing/empty.
   */
  workspaces: ReadonlySet<string>;
  preset: HistoryDatePreset;
  customRange: { from: number | null; to: number | null };
  search: string;
  /** When true, the search needle also matches conversation IDs present in `messageMatchIds`. */
  includeMessageContent: boolean;
  sort: HistorySortKey;
};

export const DEFAULT_HISTORY_FILTER: HistoryFilterCriteria = {
  sources: new Set<SidebarFilterSource>(),
  workspaces: new Set<string>(),
  preset: 'all',
  customRange: { from: null, to: null },
  search: '',
  includeMessageContent: false,
  sort: 'date',
};

/** True iff any axis narrows the result vs. the full conversation list. */
export const isHistoryFilterActive = (criteria: HistoryFilterCriteria): boolean => {
  if (criteria.sources.size > 0) return true;
  if (criteria.workspaces.size > 0) return true;
  if (criteria.preset !== 'all') return true;
  if (criteria.search.trim() !== '') return true;
  return false;
};

const getWorkspace = (conversation: TChatConversation): string => {
  // `extra` is typed as required on most variants but legacy rows have produced
  // `null` in practice — guard before destructuring (same pattern as item 6).
  const extra = conversation.extra as { workspace?: unknown } | null | undefined;
  if (!extra) return '';
  const workspace = extra.workspace;
  return typeof workspace === 'string' ? workspace : '';
};

const matchesSourceSet = (conversation: TChatConversation, sources: ReadonlySet<SidebarFilterSource>): boolean => {
  if (sources.size === 0) return true;
  const convSource = conversation.source as string | null | undefined;
  // Translate the conversation's raw source into one of the four filter buckets.
  let bucket: SidebarFilterSource;
  if (convSource === 'claude_code') bucket = 'claude_code';
  else if (convSource === 'copilot') bucket = 'copilot';
  else if (convSource === 'aionui' || convSource == null) bucket = 'native';
  else {
    // outlier sources (telegram/lark/dingtalk/etc.) belong under 'all' only —
    // they are not 'native' and not CC/CP, so if the user has narrowed sources,
    // they should not appear.
    return sources.has('all');
  }
  return sources.has(bucket);
};

const matchesWorkspaceSet = (conversation: TChatConversation, workspaces: ReadonlySet<string>): boolean => {
  if (workspaces.size === 0) return true;
  const ws = getWorkspace(conversation);
  if (ws === '') return workspaces.has(NO_WORKSPACE_TOKEN);
  return workspaces.has(ws);
};

const millisPerDay = 24 * 60 * 60 * 1000;

const presetToRange = (
  preset: HistoryDatePreset,
  customRange: { from: number | null; to: number | null },
  now: number
): { from: number | null; to: number | null } => {
  switch (preset) {
    case 'last7':
      return { from: now - 7 * millisPerDay, to: null };
    case 'last30':
      return { from: now - 30 * millisPerDay, to: null };
    case 'custom':
      return customRange;
    case 'all':
    default:
      return { from: null, to: null };
  }
};

/** Exported for unit tests; the runtime path uses `applyHistoryFilter`. */
export const matchesDateRange = (
  conversation: TChatConversation,
  criteria: HistoryFilterCriteria,
  now: number = Date.now()
): boolean => {
  const range = presetToRange(criteria.preset, criteria.customRange, now);
  if (range.from === null && range.to === null) return true;
  const time = typeof conversation.modifyTime === 'number' ? conversation.modifyTime : 0;
  if (range.from !== null && time < range.from) return false;
  if (range.to !== null && time > range.to) return false;
  return true;
};

const matchesNameOrWorkspace = (conversation: TChatConversation, needle: string): boolean => {
  const name = typeof conversation.name === 'string' ? conversation.name.toLowerCase() : '';
  if (name.includes(needle)) return true;
  const workspace = getWorkspace(conversation).toLowerCase();
  if (workspace !== '' && workspace.includes(needle)) return true;
  return false;
};

/**
 * Pure filter. Returns a new array (or the input array reference unchanged when
 * the filter is inactive AND no message-match overlay is provided — preserves
 * downstream `useMemo` identity).
 *
 * `messageMatchIds`, when supplied with `criteria.includeMessageContent === true`,
 * contributes additional matches OR-ed with the name/workspace needle.
 */
export const applyHistoryFilter = (
  conversations: TChatConversation[],
  criteria: HistoryFilterCriteria,
  messageMatchIds?: ReadonlySet<string>,
  now: number = Date.now()
): TChatConversation[] => {
  const hasMessageOverlay = criteria.includeMessageContent && messageMatchIds !== undefined && messageMatchIds.size > 0;
  if (!isHistoryFilterActive(criteria) && !hasMessageOverlay) return conversations;
  const needle = criteria.search.trim().toLowerCase();
  return conversations.filter((conversation) => {
    if (!matchesSourceSet(conversation, criteria.sources)) return false;
    if (!matchesWorkspaceSet(conversation, criteria.workspaces)) return false;
    if (!matchesDateRange(conversation, criteria, now)) return false;
    if (needle === '') return true;
    if (matchesNameOrWorkspace(conversation, needle)) return true;
    if (criteria.includeMessageContent && messageMatchIds?.has(conversation.id) === true) return true;
    return false;
  });
};

/**
 * Collect distinct workspace options from a conversation list. Returns workspace
 * strings sorted ascending; appends `NO_WORKSPACE_TOKEN` at the end iff at least
 * one row has no workspace.
 */
export const collectWorkspaceOptions = (conversations: TChatConversation[]): string[] => {
  let hasNone = false;
  const set = new Set<string>();
  for (const c of conversations) {
    const ws = getWorkspace(c);
    if (ws === '') {
      hasNone = true;
    } else {
      set.add(ws);
    }
  }
  const sorted = [...set].toSorted((a, b) => a.localeCompare(b));
  if (hasNone) sorted.push(NO_WORKSPACE_TOKEN);
  return sorted;
};

/**
 * Sort conversations by the chosen key. Stable: ties preserve input order
 * via `Array.prototype.sort`'s ECMAScript stability guarantee.
 */
export const sortConversations = (conversations: TChatConversation[], sort: HistorySortKey): TChatConversation[] => {
  if (sort === 'name') {
    return conversations.toSorted((a, b) => {
      const aName = typeof a.name === 'string' ? a.name : '';
      const bName = typeof b.name === 'string' ? b.name : '';
      return aName.localeCompare(bName);
    });
  }
  return conversations.toSorted((a, b) => {
    const aTime = typeof a.modifyTime === 'number' ? a.modifyTime : 0;
    const bTime = typeof b.modifyTime === 'number' ? b.modifyTime : 0;
    return bTime - aTime;
  });
};

/**
 * Returns true iff at least one row in the visible set is an imported session
 * (has `extra.sourceFilePath`) that has NOT yet been hydrated — i.e., its
 * messages are not indexed in the local DB so message-content search will miss it.
 */
export const hasNonHydratedImportedRows = (conversations: TChatConversation[]): boolean => {
  for (const c of conversations) {
    const extra = c.extra as { sourceFilePath?: unknown; hydratedAt?: unknown } | null | undefined;
    if (!extra) continue;
    const isImported = typeof extra.sourceFilePath === 'string' && extra.sourceFilePath.length > 0;
    if (!isImported) continue;
    const isHydrated = typeof extra.hydratedAt === 'number' && extra.hydratedAt > 0;
    if (!isHydrated) return true;
  }
  return false;
};

/** Maps an item-5 `SectionTimelineKey` to the matching history-view date preset. */
export const sectionKeyToPreset = (sectionKey: string | null | undefined): HistoryDatePreset => {
  switch (sectionKey) {
    case 'conversation.history.today':
    case 'conversation.history.yesterday':
    case 'conversation.history.recent7Days':
      return 'last7';
    case 'conversation.history.earlier':
      return 'all';
    default:
      return 'all';
  }
};
