/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { Radio, Tooltip } from '@arco-design/web-react';
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

      if (currentMode === 'terminal' && mode === 'acp') {
        // Switching Terminal → Rich UI: convert JSONL to TMessages
        const conversation = await ipcBridge.conversation.get.invoke({ id: conversationId }).catch((): null => null);
        const extra = conversation?.type === 'acp' ? conversation.extra : undefined;
        const sessionId = extra?.acpSessionId;
        const terminalSwitchedAt = extra?.terminalSwitchedAt ?? 0;

        if (sessionId) {
          const result = await ipcBridge.cliHistory.convertSessionToMessages
            .invoke({ conversationId, sessionId, backend, terminalSwitchedAt })
            .catch((): null => null);

          if (result && !result.success) {
            console.warn('[ModeToggle] JSONL conversion failed:', result.msg);
          }
        }
      }

      // Build extra update — include terminalSwitchedAt when switching to terminal
      const extraUpdate: Record<string, unknown> = { currentMode: mode };
      if (mode === 'terminal') {
        extraUpdate.terminalSwitchedAt = Date.now();
      }

      // Persist mode and wait for it to complete before revalidating cache
      await ipcBridge.conversation.update.invoke({
        id: conversationId,
        updates: { extra: extraUpdate } as never,
        mergeExtra: true,
      });
      await mutate(`conversation/${conversationId}`);
      onModeChange(mode);
    },
    [conversationId, currentMode, backend, onModeChange]
  );

  return (
    <Tooltip position='bottom' content={t('settings.terminalWrapper.modeTooltip')}>
      <Radio.Group
        type='button'
        size='mini'
        value={currentMode}
        onChange={(val) => handleToggle(val as ConversationMode)}
      >
        <Radio value='acp'>{t('settings.terminalWrapper.richUI')}</Radio>
        <Radio value='terminal'>{t('settings.terminalWrapper.terminal')}</Radio>
      </Radio.Group>
    </Tooltip>
  );
};

export default ModeToggle;
