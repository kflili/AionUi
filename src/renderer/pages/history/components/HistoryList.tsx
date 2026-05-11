/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@arco-design/web-react';
import { Virtuoso } from 'react-virtuoso';
import type { TChatConversation } from '@/common/config/storage';
import HistoryRow from './HistoryRow';

export type HistoryListProps = {
  conversations: TChatConversation[];
  isFiltered: boolean;
  onRowClick: (conversation: TChatConversation) => void;
  onReset: () => void;
};

const computeItemKey = (_index: number, item: TChatConversation): string => item.id;

const HistoryList: React.FC<HistoryListProps> = ({ conversations, isFiltered, onRowClick, onReset }) => {
  const { t } = useTranslation();

  const renderItem = useCallback(
    (_index: number, item: TChatConversation) => <HistoryRow conversation={item} onClick={onRowClick} />,
    [onRowClick]
  );

  if (conversations.length === 0) {
    return (
      <div
        data-testid='history-empty'
        className='flex-1 min-h-0 flex flex-col items-center justify-center gap-12px text-t-secondary'
      >
        <span>{isFiltered ? t('conversation.fullHistory.empty.noMatches') : t('conversation.history.noHistory')}</span>
        {isFiltered && (
          <Button size='small' onClick={onReset}>
            {t('conversation.fullHistory.filter.reset')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <Virtuoso
      data-testid='history-virtuoso'
      data={conversations}
      style={{ height: '100%' }}
      computeItemKey={computeItemKey}
      itemContent={renderItem}
    />
  );
};

export default HistoryList;
