/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PreviewMetadata } from '@/renderer/pages/conversation/preview/context/PreviewContext';
import { Button, Input, Modal, Tooltip } from '@arco-design/web-react';
import { Tv } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { detectReachableStarOfficeUrl, STAR_OFFICE_URL_KEY } from '@/renderer/utils/starOffice';

const MONITOR_URL_STORAGE_KEY = 'aionui.openclaw.monitorUrl';
const DEFAULT_MONITOR_URL = 'http://127.0.0.1:19000';

interface OpenClawMonitorButtonProps {
  onOpenUrl: (url: string, metadata?: PreviewMetadata) => void;
}

const normalizeUrl = (raw: string) => {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
};

const OpenClawMonitorButton: React.FC<OpenClawMonitorButtonProps> = ({ onOpenUrl }) => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectedUrl, setDetectedUrl] = useState<string | null>(null);
  const [url, setUrl] = useState(() => {
    try {
      return localStorage.getItem(MONITOR_URL_STORAGE_KEY)?.trim() || DEFAULT_MONITOR_URL;
    } catch {
      return DEFAULT_MONITOR_URL;
    }
  });

  const runDetect = useCallback(async () => {
    setDetecting(true);
    try {
      const found = await detectReachableStarOfficeUrl(url);
      setDetectedUrl(found);
      if (found) {
        setUrl(found);
        try {
          localStorage.setItem(MONITOR_URL_STORAGE_KEY, found);
          localStorage.setItem(STAR_OFFICE_URL_KEY, found);
        } catch {
          // ignore persistence error
        }
      }
    } finally {
      setDetecting(false);
    }
  }, [url]);

  useEffect(() => {
    void runDetect();
  }, [runDetect]);

  const handleConfirm = useCallback(() => {
    const normalized = normalizeUrl(url);
    if (!normalized) return;

    try {
      const parsed = new URL(normalized);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return;
      }
      try {
        localStorage.setItem(MONITOR_URL_STORAGE_KEY, normalized);
        localStorage.setItem(STAR_OFFICE_URL_KEY, normalized);
      } catch {
        // ignore persistence error
      }
      onOpenUrl(normalized, {
        title: t('conversation.preview.openclawMonitorTitle', { defaultValue: 'OpenClaw Live Monitor' }),
      });
      setVisible(false);
    } catch {
      // keep modal open for correction
    }
  }, [onOpenUrl, t, url]);

  const tooltipText = useMemo(() => {
    if (detectedUrl) {
      return t('conversation.preview.openclawMonitorDetected', {
        defaultValue: 'Open live monitor (detected at {{url}})',
        url: detectedUrl,
      });
    }
    return t('conversation.preview.openclawMonitor', { defaultValue: 'Open live monitor' });
  }, [detectedUrl, t]);

  const handlePrimaryClick = useCallback(() => {
    if (detectedUrl) {
      onOpenUrl(detectedUrl, {
        title: t('conversation.preview.openclawMonitorTitle', { defaultValue: 'OpenClaw Live Monitor' }),
      });
      return;
    }
    setVisible(true);
  }, [detectedUrl, onOpenUrl, t]);

  return (
    <>
      <Tooltip content={tooltipText}>
        <Button
          size='mini'
          type='text'
          loading={detecting}
          onClick={handlePrimaryClick}
          className='!w-26px !h-26px !p-0 flex items-center justify-center text-t-secondary hover:text-t-primary'
          aria-label={t('conversation.preview.openclawMonitor', { defaultValue: 'Open live monitor' })}
        >
          <span className='relative inline-flex items-center justify-center'>
            <Tv theme='outline' size='16' />
            {detectedUrl ? <span className='absolute -right-2px -top-2px w-6px h-6px rounded-full' style={{ backgroundColor: 'rgb(var(--success-6))' }} /> : null}
          </span>
        </Button>
      </Tooltip>

      <Modal title={t('conversation.preview.openclawMonitor', { defaultValue: 'Open live monitor' })} visible={visible} onOk={handleConfirm} onCancel={() => setVisible(false)} okText={t('common.confirm')} cancelText={t('common.cancel')}>
        <div className='text-12px text-t-secondary mb-8px'>{t('conversation.preview.openclawMonitorHint', { defaultValue: 'Input monitor URL, e.g. http://127.0.0.1:19000' })}</div>
        <Input value={url} onChange={setUrl} placeholder='http://127.0.0.1:19000' />
        <div className='mt-8px'>
          <Button size='mini' type='outline' loading={detecting} onClick={() => void runDetect()}>
            {t('conversation.preview.openclawMonitorDetect', { defaultValue: 'Auto detect local Star Office' })}
          </Button>
        </div>
      </Modal>
    </>
  );
};

export default OpenClawMonitorButton;
