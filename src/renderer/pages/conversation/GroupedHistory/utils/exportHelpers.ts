/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TMessage } from '@/common/chat/chatLib';
import type { IDirOrFile } from '@/common/adapter/ipcBridge';
import type { TChatConversation } from '@/common/config/storage';

import type { ExportZipFile } from '../types';

export const INVALID_FILENAME_CHARS_RE = /[<>:"/\\|?*]/g;
export const EXPORT_IO_TIMEOUT_MS = 15000;

export const sanitizeFileName = (name: string): string => {
  const cleaned = name.replace(INVALID_FILENAME_CHARS_RE, '_').trim();
  return (cleaned || 'conversation').slice(0, 80);
};

export const joinFilePath = (dir: string, fileName: string): string => {
  const separator = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${fileName}` : `${dir}${separator}${fileName}`;
};

export const formatTimestamp = (time = Date.now()): string => {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

export const normalizeZipPath = (value: string): string => value.replace(/\\/g, '/').replace(/^\/+/, '');

export const buildTopicFolderName = (conversation: TChatConversation): string => {
  const safeName = sanitizeFileName(conversation.name || conversation.id);
  return `${safeName}__${conversation.id}`;
};

export const appendWorkspaceFilesToZip = (
  files: ExportZipFile[],
  root: IDirOrFile | undefined,
  prefix: string
): void => {
  if (!root?.children || root.children.length === 0) {
    return;
  }

  const walk = (node: IDirOrFile) => {
    if (node.isFile) {
      const relativePath = normalizeZipPath(node.relativePath || node.name);
      if (relativePath) {
        files.push({
          name: `${prefix}/workspace/${relativePath}`,
          sourcePath: node.fullPath,
        });
      }
      return;
    }
    node.children?.forEach((child) => walk(child));
  };

  root.children.forEach((child) => walk(child));
};

export const getBackendKeyFromConversation = (conversation: TChatConversation): string | undefined => {
  if (conversation.type === 'acp') {
    return conversation.extra?.backend;
  }
  if (conversation.type === 'openclaw-gateway') {
    return conversation.extra?.backend || 'openclaw-gateway';
  }
  return conversation.type;
};

export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timeout`));
      }, timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

export const readMessageContent = (message: TMessage): string => {
  const content = message.content as Record<string, unknown> | string | undefined;

  if (typeof content === 'string') {
    return content;
  }

  if (content && typeof content === 'object' && typeof content.content === 'string') {
    return content.content;
  }

  try {
    return JSON.stringify(content ?? {}, null, 2);
  } catch {
    return String(content ?? '');
  }
};

export const getMessageRoleLabel = (message: TMessage): string => {
  if (message.position === 'right') return 'User';
  if (message.position === 'left') return 'Assistant';
  return 'System';
};

export const buildConversationMarkdown = (conversation: TChatConversation, messages: TMessage[]): string => {
  const lines: string[] = [];
  lines.push(`# ${conversation.name || 'Conversation'}`);
  lines.push('');
  lines.push(`- Conversation ID: ${conversation.id}`);
  lines.push(`- Exported At: ${new Date().toISOString()}`);
  lines.push(`- Type: ${conversation.type}`);
  lines.push('');
  lines.push('## Messages');
  lines.push('');

  messages.forEach((message, index) => {
    lines.push(`### ${index + 1}. ${getMessageRoleLabel(message)} (${message.type})`);
    lines.push('');
    lines.push('```text');
    lines.push(readMessageContent(message));
    lines.push('```');
    lines.push('');
  });

  return lines.join('\n');
};

export const buildConversationJson = (conversation: TChatConversation, messages: TMessage[]): string => {
  return JSON.stringify(
    {
      version: 1,
      exportedAt: new Date().toISOString(),
      conversation,
      messages,
    },
    null,
    2
  );
};

// ---------------------------------------------------------------------------
// Export auto-hydration
// ---------------------------------------------------------------------------
//
// Imported CLI-history conversations defer message hydration until first use
// (plan.md §"Two-Phase Import"). Export must transparently auto-hydrate so a
// user can export a sidebar row that has only Phase-1 metadata. Wraps the
// `cliHistory.hydrate` IPC contract from item 2 — the importer's coalescing
// + mtime-check primitive — never adds a parallel hydration code path.
//
// Cached-and-source-present conversations (`extra.hydratedAt` already set)
// skip the IPC to avoid the JSONL re-read on the export hot path. The mtime
// check / cached-but-source-missing detection only runs for rows that were
// never hydrated.

type HydrateResponseData = {
  status: 'hydrated' | 'cached' | 'unavailable';
  warning?: 'source_missing';
  warningCount?: number;
};

type HydrateResponse = {
  success: boolean;
  data?: HydrateResponseData;
  msg?: string;
};

export type HydrateInvoker = (args: { conversationId: string }) => Promise<HydrateResponse>;

export type EnsureHydratedOutcome =
  | { status: 'skipped' } // native conversation, or already hydrated — IPC not called
  | { status: 'hydrated' } // freshly hydrated; export proceeds
  | { status: 'cached_warning' } // hydrate returned cached + source_missing; export proceeds with warning
  | { status: 'unavailable'; message?: string } // never hydrated and source file missing; abort
  | { status: 'failed'; message?: string }; // IPC error or success=false; abort

export const ensureHydratedForExport = async (
  conversation: TChatConversation,
  invokeHydrate: HydrateInvoker
): Promise<EnsureHydratedOutcome> => {
  const extra = conversation.extra as Record<string, unknown> | undefined;
  const sourceFilePath = typeof extra?.sourceFilePath === 'string' ? extra.sourceFilePath : '';
  if (!sourceFilePath) {
    return { status: 'skipped' };
  }
  const hydratedAt = typeof extra?.hydratedAt === 'number' ? extra.hydratedAt : 0;
  if (hydratedAt > 0) {
    return { status: 'skipped' };
  }

  let response: HydrateResponse | undefined;
  try {
    response = await invokeHydrate({ conversationId: conversation.id });
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
  if (!response?.success || !response.data) {
    return { status: 'failed', message: response?.msg };
  }

  const { status, warning } = response.data;
  if (status === 'unavailable') {
    return { status: 'unavailable', message: response.msg };
  }
  if (status === 'cached' && warning === 'source_missing') {
    return { status: 'cached_warning' };
  }
  if (status === 'hydrated') {
    return { status: 'hydrated' };
  }
  // status === 'cached' with no warning — source is fine, treat as already-cached.
  return { status: 'skipped' };
};
