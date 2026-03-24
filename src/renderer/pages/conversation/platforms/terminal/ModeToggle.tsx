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
        // Fetch fresh conversation to get the latest acpSessionId
        const conversation = await ipcBridge.conversation.get.invoke({ id: conversationId }).catch((): null => null);
        const sessionId = conversation?.type === 'acp' ? conversation.extra?.acpSessionId : undefined;

        if (sessionId) {
          await ipcBridge.cliHistory.convertSessionToMessages
            .invoke({ conversationId, sessionId, backend })
            .catch((err: unknown) => {
              console.warn('[ModeToggle] JSONL conversion failed:', err);
            });
        }
      }

      // Persist mode to conversation extra and invalidate SWR cache
      ipcBridge.conversation.update.invoke({
        id: conversationId,
        updates: { extra: { currentMode: mode } } as never,
        mergeExtra: true,
      });
      // Revalidate SWR cache so navigating away/back gets fresh data immediately
      mutate(`conversation/${conversationId}`);
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
