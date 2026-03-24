/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { Radio } from '@arco-design/web-react';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { mutate } from 'swr';

type ConversationMode = 'acp' | 'terminal';

const ModeToggle: React.FC<{
  conversationId: string;
  currentMode: ConversationMode;
  backend: string;
  onModeChange: (mode: ConversationMode) => void;
}> = ({ conversationId, currentMode, backend, onModeChange }) => {
  const { t } = useTranslation();

  const handleToggle = useCallback(
    async (mode: ConversationMode) => {
      if (mode === currentMode) return;

      // When switching Terminal → Rich UI, convert JSONL to TMessages first
      if (currentMode === 'terminal' && mode === 'acp') {
        const conversation = await ipcBridge.conversation.get.invoke({ id: conversationId }).catch((): null => null);
        const sessionId = conversation?.type === 'acp' ? conversation.extra?.acpSessionId : undefined;

        if (sessionId) {
          const result = await ipcBridge.cliHistory.convertSessionToMessages
            .invoke({ conversationId, sessionId, backend })
            .catch((): null => null);

          if (result && !result.success) {
            console.warn('[ModeToggle] JSONL conversion failed:', result.msg);
          }
        }
      }

      // Persist mode and wait for it to complete before revalidating cache
      await ipcBridge.conversation.update.invoke({
        id: conversationId,
        updates: { extra: { currentMode: mode } } as never,
        mergeExtra: true,
      });
      await mutate(`conversation/${conversationId}`);
      onModeChange(mode);
    },
    [conversationId, currentMode, backend, onModeChange]
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
