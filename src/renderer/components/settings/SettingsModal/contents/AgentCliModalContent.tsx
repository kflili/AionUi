/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfigStorage } from '@/common/config/storage';
import { useAgentCliConfig, type AgentCliConfig } from '@/renderer/hooks/agent/useAgentCliConfig';
import { InputNumber, Message, Switch } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import { useSettingsViewMode } from '../settingsViewContext';

type ImportSource = 'claude_code' | 'copilot';

const PreferenceRow: React.FC<{
  label: string;
  description?: string;
  children: React.ReactNode;
}> = ({ label, description, children }) => (
  <div className='flex flex-col items-stretch gap-10px py-12px md:flex-row md:items-center md:justify-between md:gap-24px'>
    <div className='flex flex-col'>
      <div className='text-14px text-t-primary leading-22px'>{label}</div>
      {description && <div className='text-12px text-t-secondary leading-18px'>{description}</div>}
    </div>
    <div className='w-full flex md:flex-1 md:justify-end'>{children}</div>
  </div>
);

const AgentCliModalContent: React.FC = () => {
  const { t } = useTranslation();
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const config = useAgentCliConfig();

  // Mirror the latest known config in a ref so two rapid handlers (e.g. user
  // changes fontSize then immediately toggles Show Thinking before the hook
  // has re-rendered) merge against the freshest snapshot synchronously rather
  // than against the stale closure value. This restores the pre-refactor
  // `setConfig(prev => ...)` semantic without re-introducing local state.
  const configRef = useRef<AgentCliConfig | undefined>(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const saveConfig = useCallback((updates: Partial<AgentCliConfig>) => {
    const previous = configRef.current;
    const next = { ...previous, ...updates };
    configRef.current = next;
    // Attach a .catch so a transient storage failure doesn't bubble up as an
    // unhandled promise rejection. On failure, roll back the optimistic ref —
    // but only if no newer save has updated it in the meantime — so future
    // saves merge against the canonical persisted value rather than a stale
    // optimistic delta.
    ConfigStorage.set('agentCli.config', next).catch((error: unknown) => {
      console.error('[AgentCliModalContent] Failed to persist agentCli.config', error);
      if (configRef.current === next) {
        configRef.current = previous;
      }
    });
  }, []);

  /**
   * Awaitable sibling of `saveConfig` used by the CLI-history import toggles. Unlike
   * the fire-and-forget `saveConfig`, this variant surfaces persistence errors so the
   * toggle handler can roll back and show a user-visible error before the IPC fires.
   * Kept separate from `saveConfig` because other handlers (font size, max sessions)
   * intentionally don't need the await + rollback path.
   */
  const saveConfigAwaitable = useCallback(async (updates: Partial<AgentCliConfig>) => {
    const previous = configRef.current;
    const next = { ...previous, ...updates };
    configRef.current = next;
    try {
      await ConfigStorage.set('agentCli.config', next);
    } catch (error) {
      if (configRef.current === next) {
        configRef.current = previous;
      }
      throw error;
    }
  }, []);

  // Per-source pending state: disables the corresponding switch while a
  // persist → IPC → rollback sequence is in flight so rapid toggles cannot
  // interleave their writes.
  const [pending, setPending] = useState<Record<ImportSource, boolean>>({
    claude_code: false,
    copilot: false,
  });

  const handleImportToggle = useCallback(
    async (source: ImportSource, enabled: boolean) => {
      const configKey: keyof AgentCliConfig = source === 'claude_code' ? 'importClaudeCode' : 'importCopilot';
      const previousEnabled = configRef.current?.[configKey] ?? false;
      setPending((prev) => ({ ...prev, [source]: true }));
      try {
        try {
          await saveConfigAwaitable({ [configKey]: enabled } as Partial<AgentCliConfig>);
        } catch (error) {
          console.error('[AgentCliModalContent] Failed to persist import toggle', error);
          Message.error(
            t(
              enabled
                ? 'settings.terminalWrapper.cliHistoryEnableFailed'
                : 'settings.terminalWrapper.cliHistoryDisableFailed'
            )
          );
          return;
        }

        const ipcResult = enabled
          ? await ipcBridge.cliHistory.reenableSource.invoke({ source })
          : await ipcBridge.cliHistory.disableSource.invoke({ source });

        if (!ipcResult.success) {
          try {
            await saveConfigAwaitable({ [configKey]: previousEnabled } as Partial<AgentCliConfig>);
          } catch (rollbackError) {
            console.error('[AgentCliModalContent] Failed to roll back import toggle', rollbackError);
          }
          Message.error(
            ipcResult.msg ||
              t(
                enabled
                  ? 'settings.terminalWrapper.cliHistoryEnableFailed'
                  : 'settings.terminalWrapper.cliHistoryDisableFailed'
              )
          );
        }
      } finally {
        setPending((prev) => ({ ...prev, [source]: false }));
      }
    },
    [saveConfigAwaitable, t]
  );

  if (config === undefined) return null;

  return (
    <div className='flex flex-col h-full w-full'>
      <AionScrollArea className='flex-1 min-h-0 pb-16px' disableOverflow={isPageMode}>
        <div className='space-y-16px'>
          <div className='px-16px md:px-24px lg:px-28px py-14px md:py-16px bg-2 rd-16px space-y-10px md:space-y-12px'>
            <div className='w-full flex flex-col divide-y divide-border-2'>
              {/* Default Mode */}
              <PreferenceRow
                label={t('settings.terminalWrapper.defaultMode')}
                description={t('settings.terminalWrapper.defaultModeDesc')}
              >
                <span className='inline-flex items-center gap-8px'>
                  <span
                    className='text-14px cursor-pointer select-none'
                    style={{
                      color: config.defaultMode !== 'terminal' ? 'rgb(var(--primary-6))' : 'var(--color-text-3)',
                    }}
                    onClick={() => saveConfig({ defaultMode: 'acp' })}
                  >
                    {t('settings.terminalWrapper.richUI')}
                  </span>
                  <Switch
                    checked={config.defaultMode === 'terminal'}
                    onChange={(checked) => saveConfig({ defaultMode: checked ? 'terminal' : 'acp' })}
                  />
                  <span
                    className='text-14px cursor-pointer select-none'
                    style={{
                      color: config.defaultMode === 'terminal' ? 'rgb(var(--primary-6))' : 'var(--color-text-3)',
                    }}
                    onClick={() => saveConfig({ defaultMode: 'terminal' })}
                  >
                    {t('settings.terminalWrapper.terminal')}
                  </span>
                </span>
              </PreferenceRow>

              {/* Show Thinking */}
              <PreferenceRow
                label={t('settings.terminalWrapper.showThinking')}
                description={t('settings.terminalWrapper.showThinkingDesc')}
              >
                <Switch checked={config.showThinking ?? false} onChange={(val) => saveConfig({ showThinking: val })} />
              </PreferenceRow>

              {/* Max Terminal Sessions */}
              <PreferenceRow
                label={t('settings.terminalWrapper.maxSessions')}
                description={t('settings.terminalWrapper.maxSessionsDesc')}
              >
                <InputNumber
                  className='max-w-120px'
                  min={1}
                  max={20}
                  step={1}
                  value={config.maxTerminalSessions ?? 10}
                  onChange={(val) => saveConfig({ maxTerminalSessions: val || 10 })}
                />
              </PreferenceRow>

              {/* Font Size */}
              <PreferenceRow label={t('settings.terminalWrapper.fontSize')}>
                <InputNumber
                  className='max-w-120px'
                  min={8}
                  max={32}
                  step={1}
                  value={config.fontSize || 14}
                  onChange={(val) => saveConfig({ fontSize: val || 14 })}
                />
              </PreferenceRow>

              {/* Copilot Gateway */}
              <PreferenceRow
                label={t('settings.terminalWrapper.copilotGateway')}
                description={t('settings.terminalWrapper.copilotGatewayDesc')}
              >
                <Switch
                  checked={config.copilotGateway ?? true}
                  onChange={(val) => saveConfig({ copilotGateway: val })}
                />
              </PreferenceRow>

              {/* CLI History Import — Claude Code */}
              <PreferenceRow
                label={t('settings.terminalWrapper.cliHistoryClaudeCodeLabel')}
                description={t('settings.terminalWrapper.cliHistoryClaudeCodeDesc')}
              >
                <Switch
                  checked={config.importClaudeCode ?? false}
                  disabled={pending.claude_code}
                  onChange={(val) => {
                    void handleImportToggle('claude_code', val);
                  }}
                />
              </PreferenceRow>

              {/* CLI History Import — Copilot */}
              <PreferenceRow
                label={t('settings.terminalWrapper.cliHistoryCopilotLabel')}
                description={t('settings.terminalWrapper.cliHistoryCopilotDesc')}
              >
                <Switch
                  checked={config.importCopilot ?? false}
                  disabled={pending.copilot}
                  onChange={(val) => {
                    void handleImportToggle('copilot', val);
                  }}
                />
              </PreferenceRow>
            </div>
          </div>

          {/* Note */}
          <div className='px-16px md:px-24px lg:px-28px text-12px text-t-secondary'>
            {t('settings.terminalWrapper.note')}
          </div>
        </div>
      </AionScrollArea>
    </div>
  );
};

export default AgentCliModalContent;
