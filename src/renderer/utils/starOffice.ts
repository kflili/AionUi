/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type StarOfficeState = 'idle' | 'writing' | 'researching' | 'executing' | 'syncing' | 'error';
export type StarOfficeSource = 'acp' | 'openclaw-gateway';

export interface StarOfficeSyncResult {
  conversationId: string;
  source: StarOfficeSource;
  state: StarOfficeState;
  detail: string;
  ok: boolean;
  statusCode?: number;
  error?: string;
  ts: number;
}

export const DEFAULT_STAR_OFFICE_URL = 'http://127.0.0.1:19000';
export const STAR_OFFICE_FALLBACK_URLS = ['http://127.0.0.1:19000', 'http://127.0.0.1:18791'] as const;
export const STAR_OFFICE_URL_KEY = 'aionui.starOffice.url';
export const STAR_OFFICE_SYNC_ENABLED_KEY = 'aionui.starOffice.syncEnabled';
export const STAR_OFFICE_EMBED_ENABLED_KEY = 'aionui.starOffice.embedEnabled';
export const STAR_OFFICE_SYNC_LOGS_KEY = 'aionui.starOffice.syncLogs';

export const mapAcpAgentStatusToStarOfficeState = (status?: string): StarOfficeState | null => {
  switch (status) {
    case 'connecting':
    case 'connected':
    case 'authenticated':
      return 'syncing';
    case 'session_active':
      return 'idle';
    case 'error':
    case 'disconnected':
      return 'error';
    default:
      return null;
  }
};

export const toStarOfficeSetStateUrl = (baseUrl: string): string => {
  const normalizedBase = (baseUrl || DEFAULT_STAR_OFFICE_URL).trim().replace(/\/+$/, '');
  return `${normalizedBase}/set_state`;
};

export const readStarOfficeUrl = () => {
  try {
    return localStorage.getItem(STAR_OFFICE_URL_KEY)?.trim() || DEFAULT_STAR_OFFICE_URL;
  } catch {
    return DEFAULT_STAR_OFFICE_URL;
  }
};

export const readStarOfficeBool = (key: string, defaultValue: boolean) => {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return defaultValue;
    return raw === 'true';
  } catch {
    return defaultValue;
  }
};

export const appendStarOfficeSyncLog = (entry: StarOfficeSyncResult) => {
  try {
    const currentRaw = localStorage.getItem(STAR_OFFICE_SYNC_LOGS_KEY);
    const current = currentRaw ? (JSON.parse(currentRaw) as StarOfficeSyncResult[]) : [];
    const next = [entry, ...current].slice(0, 20);
    localStorage.setItem(STAR_OFFICE_SYNC_LOGS_KEY, JSON.stringify(next));
  } catch {
    // ignore storage failures
  }
};

export const readStarOfficeSyncLogs = (): StarOfficeSyncResult[] => {
  try {
    const raw = localStorage.getItem(STAR_OFFICE_SYNC_LOGS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StarOfficeSyncResult[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const checkStarOfficeHealth = async (baseUrl: string, timeoutMs = 1200): Promise<boolean> => {
  const normalizedBase = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!normalizedBase) return false;

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizedBase}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
};

export const detectReachableStarOfficeUrl = async (preferredUrl?: string): Promise<string | null> => {
  const candidates = [preferredUrl, ...STAR_OFFICE_FALLBACK_URLS]
    .filter((item): item is string => Boolean(item && item.trim()))
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter((item, index, arr) => arr.indexOf(item) === index);

  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await checkStarOfficeHealth(candidate);
    if (ok) return candidate;
  }
  return null;
};
