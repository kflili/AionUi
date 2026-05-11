/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Tag, Tooltip } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { I18nKey } from '@renderer/services/i18n/i18n-keys';

type SourceBadgeEntry = {
  chip: 'CC' | 'CP';
  color: 'orange' | 'arcoblue';
  i18nKey: I18nKey;
};

export const SOURCE_MAP = {
  claude_code: {
    chip: 'CC',
    color: 'orange',
    i18nKey: 'conversation.history.source.claudeCode',
  },
  copilot: {
    chip: 'CP',
    color: 'arcoblue',
    i18nKey: 'conversation.history.source.copilot',
  },
} as const satisfies Record<string, SourceBadgeEntry>;

export function pickEntry(source: unknown): SourceBadgeEntry | null {
  if (typeof source !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(SOURCE_MAP, source)) return null;
  return SOURCE_MAP[source as keyof typeof SOURCE_MAP];
}

type SourceBadgeProps = {
  source: unknown;
  className?: string;
};

const SourceBadge: React.FC<SourceBadgeProps> = ({ source, className }) => {
  const { t } = useTranslation();
  const entry = pickEntry(source);
  if (!entry) return null;
  const label = t(entry.i18nKey);
  return (
    <Tooltip content={label} position='top'>
      <Tag size='small' color={entry.color} aria-label={label} className={className}>
        {entry.chip}
      </Tag>
    </Tooltip>
  );
};

export default SourceBadge;
