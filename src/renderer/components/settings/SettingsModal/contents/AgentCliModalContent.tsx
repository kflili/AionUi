/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfigStorage } from '@/common/config/storage';
import { InputNumber, Radio, Switch } from '@arco-design/web-react';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import { useSettingsViewMode } from '../settingsViewContext';

type AgentCliConfig = {
  defaultMode?: 'acp' | 'terminal';
  fontSize?: number;
  showThinking?: boolean;
  maxTerminalSessions?: number;
};

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
  const [config, setConfig] = useState<AgentCliConfig>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    ConfigStorage.get('agentCli.config').then((c) => {
      setConfig(c || {});
      setLoaded(true);
    });
  }, []);

  const saveConfig = useCallback(async (updates: Partial<AgentCliConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...updates };
      ConfigStorage.set('agentCli.config', next);
      return next;
    });
  }, []);

  if (!loaded) return null;

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
                <Radio.Group
                  type='button'
                  size='small'
                  value={config.defaultMode || 'acp'}
                  onChange={(val) => saveConfig({ defaultMode: val })}
                >
                  <Radio value='acp'>{t('settings.terminalWrapper.richUI')}</Radio>
                  <Radio value='terminal'>{t('settings.terminalWrapper.terminal')}</Radio>
                </Radio.Group>
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
