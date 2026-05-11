/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/config/storage';
import { useConversationListSync } from '@renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import HistoryFilterBar from './components/HistoryFilterBar';
import HistoryList from './components/HistoryList';
import { useHistoryFilter } from './hooks/useHistoryFilter';
import {
  applyHistoryFilter,
  collectWorkspaceOptions,
  hasNonHydratedImportedRows,
  isHistoryFilterActive,
  sortConversations,
} from './utils/historyFilterHelpers';

const MESSAGE_SEARCH_DEBOUNCE_MS = 250;
const MESSAGE_SEARCH_PAGE_SIZE = 200;

const HistoryPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { conversations } = useConversationListSync();
  const {
    criteria,
    toggleSource,
    setSources,
    setWorkspaces,
    setPreset,
    setCustomRange,
    setSearch,
    setIncludeMessageContent,
    setSort,
    reset,
  } = useHistoryFilter();

  const [messageMatchIds, setMessageMatchIds] = useState<ReadonlySet<string> | undefined>(undefined);
  const requestIdRef = useRef(0);

  // Async message-content search — debounced + race-safe via request ID.
  useEffect(() => {
    if (!criteria.includeMessageContent) {
      setMessageMatchIds(undefined);
      return;
    }
    const needle = criteria.search.trim();
    if (needle === '') {
      setMessageMatchIds(undefined);
      return;
    }
    const myRequestId = ++requestIdRef.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await ipcBridge.database.searchConversationMessages.invoke({
            keyword: needle,
            page: 0,
            pageSize: MESSAGE_SEARCH_PAGE_SIZE,
          });
          if (requestIdRef.current !== myRequestId) return;
          const ids = new Set(result.items.map((item) => item.conversation.id));
          setMessageMatchIds(ids);
        } catch (error) {
          if (requestIdRef.current !== myRequestId) return;
          console.error('[HistoryPage] Message search failed:', error);
          setMessageMatchIds(new Set());
        }
      })();
    }, MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [criteria.includeMessageContent, criteria.search]);

  const workspaceOptions = useMemo(() => collectWorkspaceOptions(conversations), [conversations]);

  const isActive = useMemo(() => isHistoryFilterActive(criteria), [criteria]);

  const filtered = useMemo(
    () => applyHistoryFilter(conversations, criteria, messageMatchIds),
    [conversations, criteria, messageMatchIds]
  );

  const sorted = useMemo(() => sortConversations(filtered, criteria.sort), [filtered, criteria.sort]);

  const showMessageIndexNotice = useMemo(() => {
    if (!criteria.includeMessageContent) return false;
    return hasNonHydratedImportedRows(sorted);
  }, [criteria.includeMessageContent, sorted]);

  const handleRowClick = useCallback(
    (conversation: TChatConversation) => {
      Promise.resolve(navigate(`/conversation/${conversation.id}`)).catch((error) => {
        console.error('[HistoryPage] Navigation failed:', error);
      });
    },
    [navigate]
  );

  const clearSources = useCallback(() => setSources(new Set()), [setSources]);

  return (
    <div className='size-full flex flex-col' data-testid='history-page'>
      <div className='shrink-0 px-24px pt-20px pb-12px flex items-center justify-between'>
        <h1 className='text-t-primary text-20px font-semibold m-0' data-testid='history-page-title'>
          {t('conversation.fullHistory.pageTitle')}
        </h1>
        <span className='text-t-secondary text-12px' data-testid='history-page-count'>
          {t('conversation.fullHistory.sessionCount', { count: sorted.length })}
        </span>
      </div>
      <HistoryFilterBar
        criteria={criteria}
        isActive={isActive}
        workspaceOptions={workspaceOptions}
        showMessageIndexNotice={showMessageIndexNotice}
        onToggleSource={toggleSource}
        onClearSources={clearSources}
        onWorkspacesChange={setWorkspaces}
        onPresetChange={setPreset}
        onCustomRangeChange={setCustomRange}
        onSearchChange={setSearch}
        onIncludeMessageContentChange={setIncludeMessageContent}
        onSortChange={setSort}
        onReset={reset}
      />
      <div className='flex-1 min-h-0'>
        <HistoryList conversations={sorted} isFiltered={isActive} onRowClick={handleRowClick} onReset={reset} />
      </div>
    </div>
  );
};

export default HistoryPage;
