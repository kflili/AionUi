/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';

import type { GroupedHistoryResult, TimelineSection } from '../types';
import { useConversationListSync } from './useConversationListSync';
import { buildGroupedHistory } from '../utils/groupingHelpers';
import { applySidebarFilter, type SidebarFilterCriteria } from '../utils/sidebarFilterHelpers';

const EXPANSION_STORAGE_KEY = 'aionui_workspace_expansion';

const collectWorkspaceNames = (sections: TimelineSection[]): Set<string> => {
  const names = new Set<string>();
  sections.forEach((section) => {
    section.items.forEach((item) => {
      if (item.type === 'workspace' && item.workspaceGroup) {
        names.add(item.workspaceGroup.workspace);
      }
    });
  });
  return names;
};

export const useConversations = (filter?: SidebarFilterCriteria) => {
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(EXPANSION_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return Array.isArray(parsed) ? [...new Set(parsed.filter((v): v is string => typeof v === 'string'))] : [];
      }
    } catch {
      // ignore
    }
    return [];
  });
  const { id } = useParams();
  const { t } = useTranslation();
  const { conversations, isConversationGenerating, hasCompletionUnread, clearCompletionUnread, setActiveConversation } =
    useConversationListSync();

  // Track whether auto-expand has already been performed to avoid
  // re-expanding workspaces after a user manually collapses them (#1156)
  const hasAutoExpandedRef = useRef(false);

  // Scroll active conversation into view
  useEffect(() => {
    if (!id) {
      setActiveConversation(null);
      return;
    }

    setActiveConversation(id);
    clearCompletionUnread(id);
    const rafId = requestAnimationFrame(() => {
      const element = document.getElementById('c-' + id);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [clearCompletionUnread, id, setActiveConversation]);

  // Persist expansion state
  useEffect(() => {
    try {
      localStorage.setItem(EXPANSION_STORAGE_KEY, JSON.stringify(expandedWorkspaces));
    } catch {
      // ignore
    }
  }, [expandedWorkspaces]);

  const filteredConversations = useMemo(
    // Filter narrows raw rows BEFORE timeline grouping + per-section truncation.
    // Plan line 12: filter narrows rows → truncation caps the narrowed list.
    () => (filter ? applySidebarFilter(conversations, filter) : conversations),
    [conversations, filter]
  );

  const groupedHistory: GroupedHistoryResult = useMemo(() => {
    return buildGroupedHistory(filteredConversations, t);
  }, [filteredConversations, t]);

  const { pinnedConversations, timelineSections } = groupedHistory;

  // Unfiltered grouping drives workspace-expansion bookkeeping so that a
  // transiently-hidden workspace (filter narrowed it out) doesn't lose its
  // expanded/collapsed state when the filter clears.
  const unfilteredTimelineSections: TimelineSection[] = useMemo(
    () => (filter ? buildGroupedHistory(conversations, t).timelineSections : timelineSections),
    [filter, conversations, t, timelineSections]
  );

  // Auto-expand all workspaces on first load only (#1156)
  useEffect(() => {
    if (hasAutoExpandedRef.current) return;
    if (expandedWorkspaces.length > 0) {
      hasAutoExpandedRef.current = true;
      return;
    }
    const allWorkspaces = collectWorkspaceNames(unfilteredTimelineSections);
    if (allWorkspaces.size > 0) {
      setExpandedWorkspaces([...allWorkspaces]);
      hasAutoExpandedRef.current = true;
    }
  }, [unfilteredTimelineSections]);

  // Remove stale workspace entries that no longer exist in the data
  useEffect(() => {
    const currentWorkspaces = collectWorkspaceNames(unfilteredTimelineSections);
    if (currentWorkspaces.size === 0) return;
    setExpandedWorkspaces((prev) => {
      const filtered = prev.filter((ws) => currentWorkspaces.has(ws));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [unfilteredTimelineSections]);

  const handleToggleWorkspace = useCallback((workspace: string) => {
    setExpandedWorkspaces((prev) => {
      if (prev.includes(workspace)) {
        return prev.filter((item) => item !== workspace);
      }
      return [...prev, workspace];
    });
  }, []);

  return {
    conversations,
    isConversationGenerating,
    hasCompletionUnread,
    expandedWorkspaces,
    pinnedConversations,
    timelineSections,
    handleToggleWorkspace,
  };
};
