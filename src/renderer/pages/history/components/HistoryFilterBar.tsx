/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Checkbox, DatePicker, Input, Select } from '@arco-design/web-react';
import { Search } from '@icon-park/react';
import classNames from 'classnames';
import type { I18nKey } from '@renderer/services/i18n/i18n-keys';
import type { SidebarFilterSource } from '@/renderer/pages/conversation/GroupedHistory/utils/sidebarFilterHelpers';
import {
  NO_WORKSPACE_TOKEN,
  type HistoryDatePreset,
  type HistoryFilterCriteria,
  type HistorySortKey,
} from '../utils/historyFilterHelpers';

const Option = Select.Option;
const RangePicker = DatePicker.RangePicker;

type SourceChip = {
  value: Exclude<SidebarFilterSource, 'all'>;
  i18nKey: Extract<
    I18nKey,
    | 'conversation.fullHistory.filter.claudeCode'
    | 'conversation.fullHistory.filter.copilot'
    | 'conversation.fullHistory.filter.native'
  >;
};

const SOURCE_CHIPS: readonly SourceChip[] = [
  { value: 'claude_code', i18nKey: 'conversation.fullHistory.filter.claudeCode' },
  { value: 'copilot', i18nKey: 'conversation.fullHistory.filter.copilot' },
  { value: 'native', i18nKey: 'conversation.fullHistory.filter.native' },
] as const;

type PresetChip = {
  value: HistoryDatePreset;
  i18nKey: Extract<
    I18nKey,
    | 'conversation.fullHistory.filter.datePreset.last7'
    | 'conversation.fullHistory.filter.datePreset.last30'
    | 'conversation.fullHistory.filter.datePreset.all'
    | 'conversation.fullHistory.filter.datePreset.custom'
  >;
};

const PRESET_CHIPS: readonly PresetChip[] = [
  { value: 'all', i18nKey: 'conversation.fullHistory.filter.datePreset.all' },
  { value: 'last7', i18nKey: 'conversation.fullHistory.filter.datePreset.last7' },
  { value: 'last30', i18nKey: 'conversation.fullHistory.filter.datePreset.last30' },
  { value: 'custom', i18nKey: 'conversation.fullHistory.filter.datePreset.custom' },
] as const;

type SourceChipButtonProps = {
  value: Exclude<SidebarFilterSource, 'all'>;
  label: string;
  selected: boolean;
  onToggle: (value: SidebarFilterSource) => void;
};

const SourceChipButton: React.FC<SourceChipButtonProps> = ({ value, label, selected, onToggle }) => {
  const handleClick = useCallback(() => onToggle(value), [onToggle, value]);
  return (
    <Button
      size='small'
      shape='round'
      type={selected ? 'primary' : 'secondary'}
      onClick={handleClick}
      aria-pressed={selected}
      data-testid={`history-source-chip-${value}`}
    >
      {label}
    </Button>
  );
};

type PresetChipButtonProps = {
  value: HistoryDatePreset;
  label: string;
  selected: boolean;
  onSelect: (preset: HistoryDatePreset) => void;
};

const PresetChipButton: React.FC<PresetChipButtonProps> = ({ value, label, selected, onSelect }) => {
  const handleClick = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Button
      size='small'
      shape='round'
      type={selected ? 'primary' : 'secondary'}
      onClick={handleClick}
      aria-pressed={selected}
      data-testid={`history-date-preset-${value}`}
    >
      {label}
    </Button>
  );
};

export type HistoryFilterBarProps = {
  criteria: HistoryFilterCriteria;
  isActive: boolean;
  workspaceOptions: string[];
  showMessageIndexNotice: boolean;
  onToggleSource: (value: SidebarFilterSource) => void;
  onClearSources: () => void;
  onWorkspacesChange: (next: ReadonlySet<string>) => void;
  onPresetChange: (preset: HistoryDatePreset) => void;
  onCustomRangeChange: (range: { from: number | null; to: number | null }) => void;
  onSearchChange: (search: string) => void;
  onIncludeMessageContentChange: (value: boolean) => void;
  onSortChange: (sort: HistorySortKey) => void;
  onReset: () => void;
};

const HistoryFilterBar: React.FC<HistoryFilterBarProps> = ({
  criteria,
  isActive,
  workspaceOptions,
  showMessageIndexNotice,
  onToggleSource,
  onClearSources,
  onWorkspacesChange,
  onPresetChange,
  onCustomRangeChange,
  onSearchChange,
  onIncludeMessageContentChange,
  onSortChange,
  onReset,
}) => {
  const { t } = useTranslation();

  const workspaceSelectValue = useMemo(() => [...criteria.workspaces], [criteria.workspaces]);

  const workspaceOptionsRendered = useMemo(
    () =>
      workspaceOptions.map((value) => (
        <Option key={value} value={value}>
          {value === NO_WORKSPACE_TOKEN ? t('conversation.fullHistory.filter.noneWorkspace') : value}
        </Option>
      )),
    [workspaceOptions, t]
  );

  const handleWorkspacesChange = useCallback(
    (next: string[]) => onWorkspacesChange(new Set(next)),
    [onWorkspacesChange]
  );

  const handleRangePickerChange = useCallback(
    (dateStrings: string[]) => {
      if (!dateStrings || dateStrings.length !== 2) {
        onCustomRangeChange({ from: null, to: null });
        return;
      }
      // Parse "YYYY-MM-DD" strings in **local** time. `new Date('2026-05-11')`
      // would parse as UTC midnight, which silently shifts the day by the
      // user's tz offset (e.g. May 10 evening to May 11 evening in PDT).
      // Manual y/m/d construction uses the local calendar instead.
      const parseStartOfDay = (s: string): number | null => {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
        if (!m) return null;
        const [, y, mo, d] = m;
        const dt = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0);
        return dt.getTime();
      };
      const parseEndOfDay = (s: string): number | null => {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
        if (!m) return null;
        const [, y, mo, d] = m;
        const dt = new Date(Number(y), Number(mo) - 1, Number(d), 23, 59, 59, 999);
        return dt.getTime();
      };
      const fromMs = dateStrings[0] ? parseStartOfDay(dateStrings[0]) : null;
      const toMs = dateStrings[1] ? parseEndOfDay(dateStrings[1]) : null;
      onCustomRangeChange({ from: fromMs, to: toMs });
    },
    [onCustomRangeChange]
  );

  const customRangePickerValue: [number, number] | undefined =
    criteria.preset === 'custom' && criteria.customRange.from !== null && criteria.customRange.to !== null
      ? [criteria.customRange.from, criteria.customRange.to]
      : undefined;

  return (
    <div className='flex flex-col gap-12px px-24px pt-16px pb-12px border-b border-solid border-[var(--color-border-2)]'>
      <div className='flex items-center justify-between gap-12px flex-wrap'>
        <div className='flex items-center gap-8px flex-wrap' data-testid='history-source-chips'>
          <span className='text-t-secondary text-12px'>{t('conversation.fullHistory.filter.sourceLabel')}</span>
          <Button
            size='small'
            shape='round'
            type={criteria.sources.size === 0 ? 'primary' : 'secondary'}
            onClick={onClearSources}
            aria-pressed={criteria.sources.size === 0}
          >
            {t('conversation.fullHistory.filter.allSources')}
          </Button>
          {SOURCE_CHIPS.map((chip) => (
            <SourceChipButton
              key={chip.value}
              value={chip.value}
              label={t(chip.i18nKey)}
              selected={criteria.sources.has(chip.value)}
              onToggle={onToggleSource}
            />
          ))}
        </div>
        <div className='flex items-center gap-8px'>
          <span className='text-t-secondary text-12px'>{t('conversation.fullHistory.filter.sortLabel')}</span>
          <Select
            size='small'
            value={criteria.sort}
            onChange={onSortChange}
            style={{ minWidth: 160 }}
            data-testid='history-sort'
          >
            <Option value='date'>{t('conversation.fullHistory.sort.date')}</Option>
            <Option value='name'>{t('conversation.fullHistory.sort.name')}</Option>
          </Select>
        </div>
      </div>
      <div className='flex items-center gap-12px flex-wrap'>
        <div className='flex items-center gap-8px flex-1 min-w-280px'>
          <span className='text-t-secondary text-12px'>{t('conversation.fullHistory.filter.workspaceLabel')}</span>
          <Select
            mode='multiple'
            size='small'
            allowClear
            placeholder={t('conversation.fullHistory.filter.workspacesPlaceholder')}
            value={workspaceSelectValue}
            onChange={handleWorkspacesChange}
            style={{ flex: 1 }}
            maxTagCount={3}
            data-testid='history-workspace-select'
          >
            {workspaceOptionsRendered}
          </Select>
        </div>
        <div className='flex items-center gap-8px flex-wrap' data-testid='history-date-presets'>
          <span className='text-t-secondary text-12px'>{t('conversation.fullHistory.filter.dateLabel')}</span>
          {PRESET_CHIPS.map((chip) => (
            <PresetChipButton
              key={chip.value}
              value={chip.value}
              label={t(chip.i18nKey)}
              selected={criteria.preset === chip.value}
              onSelect={onPresetChange}
            />
          ))}
          {criteria.preset === 'custom' && (
            <RangePicker
              size='small'
              value={customRangePickerValue}
              onChange={handleRangePickerChange}
              data-testid='history-date-custom-range'
            />
          )}
        </div>
      </div>
      <div className='flex items-center gap-12px flex-wrap'>
        <Input
          allowClear
          size='default'
          prefix={<Search size='16' />}
          value={criteria.search}
          onChange={onSearchChange}
          placeholder={t('conversation.fullHistory.filter.search')}
          style={{ flex: 1, minWidth: 240 }}
          data-testid='history-search-input'
        />
        <Checkbox
          checked={criteria.includeMessageContent}
          onChange={(checked: boolean) => onIncludeMessageContentChange(checked)}
          data-testid='history-include-message-content'
        >
          {t('conversation.fullHistory.filter.includeMessageContent')}
        </Checkbox>
        <Button size='small' type='secondary' disabled={!isActive} onClick={onReset} data-testid='history-reset'>
          {t('conversation.fullHistory.filter.reset')}
        </Button>
      </div>
      {showMessageIndexNotice && (
        <div
          className={classNames(
            'text-12px text-t-secondary px-12px py-8px rd-0.25rem bg-fill-1 border border-solid border-[var(--color-border-2)]'
          )}
          data-testid='history-message-index-notice'
        >
          {t('conversation.fullHistory.filter.messageIndexNotice')}
        </div>
      )}
    </div>
  );
};

export default HistoryFilterBar;
