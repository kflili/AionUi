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
// Skip-the-IPC fast path: only when the row's cached hydration is current
// along ALL three keys the importer uses to gate cache validity
// (`importer.ts §hydrateSession`) — `hydratedAt`, `hydratedSourceFilePath`,
// and `hydratedShowThinking`. This mirrors `TranscriptView.isHydrationFresh`
// so the two surfaces stay consistent. Anything stale (importer moved the
// source pointer via incremental scan, user toggled Show Thinking, JSONL
// rewritten) goes through hydrate; the IPC's own mtime check then decides
// whether a JSONL re-read is needed.

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

export type HydrateInvokerArgs = { conversationId: string; showThinking: boolean };
export type HydrateInvoker = (args: HydrateInvokerArgs) => Promise<HydrateResponse>;

export type EnsureHydratedOutcome =
  | { status: 'skipped' } // native conversation, or hydration cache is fresh — IPC not called
  | { status: 'hydrated' } // freshly hydrated; export proceeds
  | { status: 'cached_warning' } // hydrate returned cached + source_missing; export proceeds with warning
  | { status: 'unavailable' } // never hydrated and source file missing; abort
  | { status: 'failed'; message?: string }; // IPC error, success=false, missing data, or showThinking undefined; abort

/**
 * Cache-validity predicate for the export auto-hydration fast path.
 *
 * Mirrors `TranscriptView.isHydrationFresh` on the three cache keys the
 * importer (`hydrateSession`) uses to decide whether the SQLite messages
 * are still authoritative:
 *
 *   1. `hydratedAt` is a number — the row has been through Phase 2 at least once.
 *   2. `hydratedSourceFilePath === sourceFilePath` — the importer's incremental
 *      scan hasn't relocated the source JSONL since the last hydration.
 *   3. `hydratedShowThinking === showThinking` — the cached transcript matches
 *      the variant the user wants exported.
 *
 * Intentional deviation: we additionally reject `NaN` / non-finite / non-positive
 * `hydratedAt` values to guard against a corrupted `extra` blob. TranscriptView's
 * version uses the looser `typeof === 'number'` check; for the export path we'd
 * rather take the IPC round-trip than ZIP a transcript whose freshness marker is
 * meaningless. Either version still trips on `hydratedSourceFilePath` /
 * `hydratedShowThinking`, so the two surfaces agree in every realistic state.
 */
const isHydrationFreshForExport = (conversation: TChatConversation, showThinking: boolean): boolean => {
  const extra =
    conversation.extra && typeof conversation.extra === 'object'
      ? (conversation.extra as Record<string, unknown>)
      : null;
  if (!extra) return false;
  if (typeof extra.hydratedAt !== 'number' || !Number.isFinite(extra.hydratedAt) || extra.hydratedAt <= 0) {
    return false;
  }
  if (typeof extra.sourceFilePath !== 'string') return false;
  if (extra.hydratedSourceFilePath !== extra.sourceFilePath) return false;
  const cachedShowThinking = extra.hydratedShowThinking === true;
  return cachedShowThinking === showThinking;
};

export const ensureHydratedForExport = async (
  conversation: TChatConversation,
  showThinking: boolean | undefined,
  invokeHydrate: HydrateInvoker
): Promise<EnsureHydratedOutcome> => {
  const extra = conversation.extra as Record<string, unknown> | undefined;
  const sourceFilePath = typeof extra?.sourceFilePath === 'string' ? extra.sourceFilePath : '';
  if (!sourceFilePath) {
    // Native ACP conversation — nothing to hydrate. `showThinking` is
    // irrelevant since we never touch the importer.
    return { status: 'skipped' };
  }

  if (showThinking === undefined) {
    // `useAgentCliConfig` is still loading. Mirrors `TranscriptView`'s
    // gate — calling hydrate with the fallback `false` could clobber the
    // SQLite cache variant when the user's saved preference is `true`. Bail
    // and let the user retry once the config snapshot resolves (sub-second
    // after app start, so this is an unlikely-but-defensive branch).
    return { status: 'failed', message: 'config_loading' };
  }

  if (isHydrationFreshForExport(conversation, showThinking)) {
    return { status: 'skipped' };
  }

  let response: HydrateResponse | undefined;
  try {
    response = await invokeHydrate({ conversationId: conversation.id, showThinking });
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
  if (!response?.success || !response.data) {
    return { status: 'failed', message: response?.msg };
  }

  const { status, warning } = response.data;
  if (status === 'unavailable') {
    // `response.msg` is only populated on `success=false` paths; the
    // importer signals the unavailable reason via `data.warning`, not `msg`.
    // Surface the status; the caller maps it to a localized error toast.
    return { status: 'unavailable' };
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
