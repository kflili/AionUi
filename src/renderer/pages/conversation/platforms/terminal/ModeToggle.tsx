/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { CommentOne, Terminal as TerminalIcon } from '@icon-park/react';
import classNames from 'classnames';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

type ConversationMode = 'acp' | 'terminal';

const ModeToggle: React.FC<{
  conversationId: string;
  currentMode: ConversationMode;
  onModeChange: (mode: ConversationMode) => void;
}> = ({ conversationId, currentMode, onModeChange }) => {
  const { t } = useTranslation();

  const handleToggle = useCallback(
    (mode: ConversationMode) => {
      if (mode === currentMode) return;
      // Persist mode to conversation extra
      ipcBridge.conversation.update.invoke({
        id: conversationId,
        updates: { extra: { currentMode: mode } } as never,
        mergeExtra: true,
      });
      onModeChange(mode);
    },
    [conversationId, currentMode, onModeChange]
  );

  const buttonClass = (active: boolean) =>
    classNames(
      'flex items-center gap-4px px-8px py-2px rd-6px text-12px cursor-pointer transition-all duration-200 select-none',
      active ? 'bg-fill-2 text-t-primary font-medium' : 'text-t-secondary hover:text-t-primary'
    );

  return (
    <div className='flex items-center gap-2px bg-fill-1 rd-8px p-2px'>
      <div className={buttonClass(currentMode === 'acp')} onClick={() => handleToggle('acp')}>
        <CommentOne theme='outline' size='12' />
        <span>{t('settings.terminalWrapper.richUI')}</span>
      </div>
      <div className={buttonClass(currentMode === 'terminal')} onClick={() => handleToggle('terminal')}>
        <TerminalIcon theme='outline' size='12' />
        <span>{t('settings.terminalWrapper.terminal')}</span>
      </div>
    </div>
  );
};

export default ModeToggle;
