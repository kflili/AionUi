/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { Radio } from '@arco-design/web-react';
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

  return (
    <Radio.Group
      type='button'
      size='mini'
      value={currentMode}
      onChange={(val) => handleToggle(val as ConversationMode)}
    >
      <Radio value='acp'>{t('settings.terminalWrapper.richUI')}</Radio>
      <Radio value='terminal'>{t('settings.terminalWrapper.terminal')}</Radio>
    </Radio.Group>
  );
};

export default ModeToggle;
