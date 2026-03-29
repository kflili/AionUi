/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { ConversationMode } from '@/common/config/storage';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { Message, Radio, Tooltip } from '@arco-design/web-react';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { mutate } from 'swr';

const ModeToggle: React.FC<{
  conversationId: string;
  currentMode: ConversationMode;
  backend: string;
  onModeChange: (mode: ConversationMode) => void;
}> = ({ conversationId, currentMode, backend, onModeChange }) => {
  const { t } = useTranslation();
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;

  const handleToggle = useCallback(
    async (mode: ConversationMode) => {
      if (mode === currentMode) return;

      // 1. Switch UI immediately (optimistic)
      onModeChange(mode);

      // 2. Persist mode
      const extraUpdate: Record<string, unknown> = { currentMode: mode };
      if (mode === 'terminal') {
        extraUpdate.terminalSwitchedAt = Date.now();
      }

      try {
        await ipcBridge.conversation.update.invoke({
          id: conversationId,
          updates: { extra: extraUpdate } as never,
          mergeExtra: true,
        });
        await mutate(`conversation/${conversationId}`);
      } catch (err) {
        console.error('[ModeToggle] Failed to persist mode:', err);
        Message.error(t('settings.terminalWrapper.switchModeFailed'));
        onModeChange(currentMode); // Revert on failure
        return;
      }

      // 3. Background cleanup (terminal → acp): kill PTY + convert JSONL
      //    Failures are logged but don't block the UI
      if (currentMode === 'terminal' && mode === 'acp') {
        void (async () => {
          try {
            await ipcBridge.pty.kill.invoke({ conversationId });
          } catch {
            // PTY may not exist — not an error
          }

          try {
            const conversation = await ipcBridge.conversation.get.invoke({ id: conversationId });
            const extra = conversation?.type === 'acp' ? conversation.extra : undefined;
            const sessionId = extra?.acpSessionId;
            const terminalSwitchedAt = extra?.terminalSwitchedAt ?? 0;

            if (sessionId) {
              const result = await ipcBridge.cliHistory.convertSessionToMessages.invoke({
                conversationId,
                sessionId,
                backend,
                terminalSwitchedAt,
              });
              if (result && !result.success) {
                console.warn('[ModeToggle] JSONL conversion failed:', result.msg);
              }
              // Refresh messages after conversion
              await mutate(`conversation/${conversationId}`);
            }
          } catch (err) {
            console.warn('[ModeToggle] Background cleanup failed:', err);
          }
        })();
      }
    },
    [conversationId, currentMode, backend, onModeChange]
  );

  return (
    <Tooltip position='bottom' content={t('settings.terminalWrapper.modeTooltip')} disabled={isMobile}>
      <span>
        <Radio.Group
          type='button'
          size='mini'
          value={currentMode}
          onChange={(val) => handleToggle(val as ConversationMode)}
        >
          <Radio value='acp'>{t('settings.terminalWrapper.richUI')}</Radio>
          <Radio value='terminal'>{t('settings.terminalWrapper.terminal')}</Radio>
        </Radio.Group>
      </span>
    </Tooltip>
  );
};

export default ModeToggle;
