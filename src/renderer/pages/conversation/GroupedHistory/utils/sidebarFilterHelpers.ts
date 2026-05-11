/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TChatConversation } from '@/common/config/storage';

/**
 * Source filter values for the sidebar dropdown.
 *
 * - `'all'`        — pass-through; no source narrowing
 * - `'claude_code'` — only `conversation.source === 'claude_code'`
 * - `'copilot'`     — only `conversation.source === 'copilot'`
 * - `'native'`      — rows authored inside AionUi: `source === 'aionui'`,
 *                     `undefined`, or `null` (SQLite `source` column is
 *                     nullable; `rowToConversation` passes it through verbatim,
 *                     so older rows reach the renderer with a literal `null`).
 *
 * Conversations carrying any other source string (legacy `'telegram'`, `'lark'`,
 * `'dingtalk'`, or future entries) are present under `'all'` only — they are
 * deliberately excluded from `'native'` so the filter label doesn't lie.
 */
export type SidebarFilterSource = 'all' | 'claude_code' | 'copilot' | 'native';

export type SidebarFilterCriteria = {
  source: SidebarFilterSource;
  search: string;
};

export const DEFAULT_SIDEBAR_FILTER: SidebarFilterCriteria = {
  source: 'all',
  search: '',
};

export const isSidebarFilterActive = (criteria: SidebarFilterCriteria): boolean =>
  criteria.source !== 'all' || criteria.search.trim() !== '';

const getWorkspace = (conversation: TChatConversation): string | undefined => {
  // `extra` is typed as required on most variants but older / partially-migrated
  // rows have produced `null` in practice — guard before destructuring so the
  // pure filter never throws on a single bad row.
  const extra = conversation.extra as { workspace?: unknown } | null | undefined;
  if (!extra) return undefined;
  const workspace = extra.workspace;
  return typeof workspace === 'string' ? workspace : undefined;
};

const matchesSource = (conversation: TChatConversation, source: SidebarFilterSource): boolean => {
  // SQLite's `source` column is nullable and `rowToConversation` passes the
  // value through verbatim, so at runtime `convSource` can be a `string`,
  // `undefined`, OR a literal `null` — even though the TS type doesn't
  // expose null. Widen for the comparison so the Native filter admits the
  // legacy null shape.
  const convSource = conversation.source as string | null | undefined;
  switch (source) {
    case 'all':
      return true;
    case 'claude_code':
      return convSource === 'claude_code';
    case 'copilot':
      return convSource === 'copilot';
    case 'native':
      return convSource === 'aionui' || convSource == null;
    default:
      return true;
  }
};

const matchesSearch = (conversation: TChatConversation, needle: string): boolean => {
  if (needle === '') return true;
  const name = typeof conversation.name === 'string' ? conversation.name.toLowerCase() : '';
  if (name.includes(needle)) return true;
  const workspace = getWorkspace(conversation);
  if (workspace && workspace.toLowerCase().includes(needle)) return true;
  return false;
};

/**
 * Pure filter applied BEFORE timeline grouping and per-section truncation.
 * Plan line 12: filter narrows rows → truncation caps the narrowed list.
 *
 * AND semantics: a conversation passes only if it matches both the source
 * and the search needle. Empty `search` matches all rows (source-only).
 */
export const applySidebarFilter = (
  conversations: TChatConversation[],
  criteria: SidebarFilterCriteria
): TChatConversation[] => {
  if (!isSidebarFilterActive(criteria)) return conversations;
  const needle = criteria.search.trim().toLowerCase();
  return conversations.filter(
    (conversation) => matchesSource(conversation, criteria.source) && matchesSearch(conversation, needle)
  );
};
