/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { ConversationMode } from '@/common/config/storage';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { Message, Switch, Tooltip } from '@arco-design/web-react';
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

      // 3. Background cleanup (terminal → acp): kill PTY.
      //    JSONL → DB sync is handled by ChatConversation's auto-sync effect.
      if (currentMode === 'terminal' && mode === 'acp') {
        void ipcBridge.pty.kill.invoke({ conversationId }).catch(() => {
          // PTY may not exist — not an error
        });
      }
    },
    [conversationId, currentMode, backend, onModeChange]
  );

  return (
    <Tooltip position='bottom' content={t('settings.terminalWrapper.modeTooltip')} disabled={isMobile}>
      <span className='inline-flex items-center gap-6px'>
        <span
          role='button'
          tabIndex={0}
          className='text-13px cursor-pointer select-none'
          style={{ color: currentMode === 'acp' ? 'rgb(var(--primary-6))' : 'var(--color-text-3)' }}
          onClick={() => handleToggle('acp')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleToggle('acp');
            }
          }}
        >
          {t('settings.terminalWrapper.richUI')}
        </span>
        <Switch
          size='small'
          checked={currentMode === 'terminal'}
          onChange={(checked) => handleToggle(checked ? 'terminal' : 'acp')}
        />
        <span
          role='button'
          tabIndex={0}
          className='text-13px cursor-pointer select-none'
          style={{ color: currentMode === 'terminal' ? 'rgb(var(--primary-6))' : 'var(--color-text-3)' }}
          onClick={() => handleToggle('terminal')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleToggle('terminal');
            }
          }}
        >
          {t('settings.terminalWrapper.terminal')}
        </span>
      </span>
    </Tooltip>
  );
};

export default ModeToggle;
