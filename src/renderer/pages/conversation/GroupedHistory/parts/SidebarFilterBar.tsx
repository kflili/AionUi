/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Drawer, Input, Select } from '@arco-design/web-react';
import { Filter, Search } from '@icon-park/react';
import classNames from 'classnames';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';

import type { SidebarFilterSource } from '../utils/sidebarFilterHelpers';

const Option = Select.Option;

type SourceOption = {
  value: SidebarFilterSource;
  i18nKey:
    | 'conversation.history.filter.allSources'
    | 'conversation.history.filter.claudeCode'
    | 'conversation.history.filter.copilot'
    | 'conversation.history.filter.native';
};

const SOURCE_OPTIONS: readonly SourceOption[] = [
  { value: 'all', i18nKey: 'conversation.history.filter.allSources' },
  { value: 'claude_code', i18nKey: 'conversation.history.filter.claudeCode' },
  { value: 'copilot', i18nKey: 'conversation.history.filter.copilot' },
  { value: 'native', i18nKey: 'conversation.history.filter.native' },
] as const;

export type SidebarFilterBarProps = {
  visible: boolean;
  source: SidebarFilterSource;
  search: string;
  isActive: boolean;
  collapsed?: boolean;
  onSourceChange: (source: SidebarFilterSource) => void;
  onSearchChange: (search: string) => void;
  onReset: () => void;
};

const SidebarFilterBar: React.FC<SidebarFilterBarProps> = ({
  visible,
  source,
  search,
  isActive,
  collapsed = false,
  onSourceChange,
  onSearchChange,
  onReset,
}) => {
  const { t } = useTranslation();
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

  const sourceOptions = useMemo(
    () =>
      SOURCE_OPTIONS.map((opt) => (
        <Option key={opt.value} value={opt.value}>
          {t(opt.i18nKey)}
        </Option>
      )),
    [t]
  );

  if (!visible || collapsed) return null;

  if (isMobile) {
    return (
      <>
        <div className='px-12px py-8px flex items-center justify-between gap-8px'>
          <Button
            size='small'
            type={isActive ? 'primary' : 'secondary'}
            shape='round'
            className='!flex items-center !gap-6px'
            aria-label={t('conversation.history.filter.openMobileSheet')}
            onClick={() => setMobileSheetOpen(true)}
            icon={<Filter theme='outline' size={14} fill='currentColor' />}
          >
            {t('conversation.history.filter.openMobileSheet')}
          </Button>
          {isActive && (
            <Button size='mini' type='text' className='!text-12px !text-t-secondary' onClick={onReset}>
              {t('conversation.history.filter.reset')}
            </Button>
          )}
        </div>
        <Drawer
          placement='bottom'
          height='min(60vh, 480px)'
          visible={mobileSheetOpen}
          onCancel={() => setMobileSheetOpen(false)}
          title={
            <div className='inline-flex items-center gap-8px'>
              <Filter theme='outline' size={16} fill='currentColor' />
              <span className='leading-none'>{t('conversation.history.filter.sheetTitle')}</span>
            </div>
          }
          footer={
            <div className='flex justify-between'>
              <Button shape='round' onClick={onReset} disabled={!isActive}>
                {t('conversation.history.filter.reset')}
              </Button>
              <Button type='primary' shape='round' onClick={() => setMobileSheetOpen(false)}>
                {t('conversation.history.filter.applyDone')}
              </Button>
            </div>
          }
          bodyStyle={{ overflowY: 'auto', padding: '14px' }}
        >
          <div className='flex flex-col gap-16px'>
            <div className='flex flex-col gap-6px'>
              <span className='text-12px text-t-secondary'>{t('conversation.history.filter.sourceLabel')}</span>
              <Select value={source} onChange={onSourceChange} className='w-full'>
                {sourceOptions}
              </Select>
            </div>
            <div className='flex flex-col gap-6px'>
              <span className='text-12px text-t-secondary'>{t('conversation.history.filter.searchLabel')}</span>
              <Input
                allowClear
                prefix={<Search theme='outline' size={14} fill='currentColor' />}
                placeholder={t('conversation.history.filter.searchPlaceholder')}
                value={search}
                onChange={onSearchChange}
              />
            </div>
          </div>
        </Drawer>
      </>
    );
  }

  return (
    <div className={classNames('px-12px py-8px flex items-center gap-6px min-w-0')}>
      <Select
        value={source}
        onChange={onSourceChange}
        size='small'
        aria-label={t('conversation.history.filter.sourceLabel')}
        triggerProps={{ autoAlignPopupWidth: false }}
        className='!w-92px flex-shrink-0'
      >
        {sourceOptions}
      </Select>
      <Input
        size='small'
        allowClear
        prefix={<Search theme='outline' size={12} fill='currentColor' />}
        placeholder={t('conversation.history.filter.searchPlaceholder')}
        value={search}
        onChange={onSearchChange}
        aria-label={t('conversation.history.filter.searchLabel')}
        className='flex-1 min-w-0'
      />
    </div>
  );
};

export default SidebarFilterBar;
