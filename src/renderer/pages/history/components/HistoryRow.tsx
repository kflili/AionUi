/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveLocaleKey } from '@/common/utils';
import type { TChatConversation } from '@/common/config/storage';
import SourceBadge from '@renderer/pages/conversation/GroupedHistory/parts/SourceBadge';

export type HistoryRowProps = {
  conversation: TChatConversation;
  onClick: (conversation: TChatConversation) => void;
};

const getWorkspace = (conversation: TChatConversation): string => {
  const extra = conversation.extra as { workspace?: unknown } | null | undefined;
  if (!extra) return '';
  const workspace = extra.workspace;
  return typeof workspace === 'string' ? workspace : '';
};

const HistoryRow: React.FC<HistoryRowProps> = ({ conversation, onClick }) => {
  const { t, i18n } = useTranslation();
  const localeKey = resolveLocaleKey(i18n.language);
  const workspace = getWorkspace(conversation);

  const formattedDate = useMemo(() => {
    const time = typeof conversation.modifyTime === 'number' ? conversation.modifyTime : 0;
    if (time === 0) return '';
    try {
      return new Date(time).toLocaleDateString(localeKey, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return new Date(time).toLocaleDateString();
    }
  }, [conversation.modifyTime, localeKey]);

  const name =
    typeof conversation.name === 'string' && conversation.name.length > 0
      ? conversation.name
      : t('conversation.historySearch.untitled');

  return (
    <div
      role='button'
      tabIndex={0}
      data-testid='history-row'
      data-conversation-id={conversation.id}
      onClick={() => onClick(conversation)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(conversation);
        }
      }}
      className='flex items-center gap-12px px-16px py-10px rd-0.5rem cursor-pointer hover:bg-hover transition-colors'
    >
      <div className='flex-1 min-w-0 flex flex-col gap-2px'>
        <div className='flex items-center gap-8px min-w-0'>
          <span className='text-t-primary text-14px font-medium truncate' title={name}>
            {name}
          </span>
          <SourceBadge source={conversation.source} />
        </div>
        {workspace && (
          <span className='text-t-secondary text-12px truncate' title={workspace}>
            {workspace}
          </span>
        )}
      </div>
      {formattedDate && <span className='shrink-0 text-t-tertiary text-12px'>{formattedDate}</span>}
    </div>
  );
};

export default React.memo(HistoryRow);
