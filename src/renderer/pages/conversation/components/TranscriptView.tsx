/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { AcpBackend } from '@/common/types/acpTypes';
import type { ConversationMode, TChatConversation } from '@/common/config/storage';
import FlexFullContainer from '@renderer/components/layout/FlexFullContainer';
import MessageList from '@renderer/pages/conversation/Messages/MessageList';
import { MessageListProvider, useUpdateMessageList } from '@renderer/pages/conversation/Messages/hooks';
import { ConversationProvider } from '@/renderer/hooks/context/ConversationContext';
import HOC from '@renderer/utils/ui/HOC';
import { Alert, Button, Skeleton, Tooltip } from '@arco-design/web-react';
import { Play } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type HydrationPhase = 'loading' | 'ready' | 'cached_warning' | 'unavailable' | 'error';

type HydrationState = {
  phase: HydrationPhase;
  errorMessage?: string;
};

/**
 * Predicate used by ChatConversation to route imported CLI-history sessions
 * into the read-only transcript surface. `extra.sourceFilePath` is the
 * importer-owned marker (item 1) that distinguishes an imported row from a
 * native ACP row. Defensive guards: `extra` may be `null` or a non-object on
 * legacy rows, and `sourceFilePath` must be a non-empty string.
 */
export const isImportedAcpConversation = (conversation: TChatConversation | undefined | null): boolean => {
  if (!conversation || conversation.type !== 'acp') return false;
  const extra =
    conversation.extra && typeof conversation.extra === 'object'
      ? (conversation.extra as Record<string, unknown>)
      : null;
  if (!extra) return false;
  const path = extra.sourceFilePath;
  return typeof path === 'string' && path.length > 0;
};

/**
 * Read `extra.hydratedAt` defensively. Older rows may carry a string mtime or
 * `undefined`. We treat anything non-numeric as "needs hydration."
 */
export const hasHydratedAt = (conversation: TChatConversation | undefined | null): boolean => {
  if (!conversation) return false;
  const extra =
    conversation.extra && typeof conversation.extra === 'object'
      ? (conversation.extra as Record<string, unknown>)
      : null;
  return typeof extra?.hydratedAt === 'number';
};

/**
 * Tracks whether an imported session has been resumed at least once. Item 8
 * stamps `extra.resumedAt` (Date.now) when the user clicks "Resume this session"
 * AND pre-flight validation passes — flipping the row from read-only transcript
 * mode into the live ACP/terminal route on subsequent renders / opens.
 *
 * Keeping `extra.sourceFilePath` intact preserves the importer's dedup invariant
 * (`${source}::id:${acpSessionId}`) and the CC/CP source badge, so the row is
 * still recognized as imported from CLI history — it just no longer routes
 * through TranscriptView.
 */
export const isResumedImportedSession = (conversation: TChatConversation | undefined | null): boolean => {
  if (!conversation || conversation.type !== 'acp') return false;
  const extra =
    conversation.extra && typeof conversation.extra === 'object'
      ? (conversation.extra as Record<string, unknown>)
      : null;
  if (!extra) return false;
  return typeof extra.resumedAt === 'number';
};

/**
 * Pre-flight validation for a "Resume this session" click on an imported CLI
 * history row. Pure function so the parent component's `useCallback` handler
 * stays small and the branches are unit-testable without rendering the DOM.
 *
 * On success returns the `extra` patch that `ipcBridge.conversation.update`
 * should merge (callers pass `mergeExtra: true`). On failure returns the i18n
 * key suffix the parent shows via `Message.error(t(...))` while leaving the
 * transcript surface mounted and read-only (plan line 465).
 */
export type ResumeErrorKey = 'unsupportedBackend' | 'sessionMissing' | 'cwdMissing' | 'sourceMissing';

export type ResumeValidationResult =
  | { ok: true; updates: { extra: { resumedAt: number; currentMode: ConversationMode; terminalSwitchedAt?: number } } }
  | { ok: false; errorKey: ResumeErrorKey };

export const validateResumeRequest = (
  conversation: TChatConversation | undefined | null,
  defaultMode: ConversationMode | undefined,
  phase: HydrationPhase,
  now: number
): ResumeValidationResult => {
  // `phase === 'unavailable'` means the importer reported `status: 'unavailable'`
  // — source JSONL is gone AND nothing is cached. Even if `acpSessionId` is
  // present, the live backend cannot resume from a session whose record is
  // missing on disk, so we surface the dedicated `sourceMissing` error rather
  // than let the live launch fail opaquely after the gate flips.
  if (phase === 'unavailable') return { ok: false, errorKey: 'sourceMissing' };
  const extra =
    conversation?.extra && typeof conversation.extra === 'object'
      ? (conversation.extra as Record<string, unknown>)
      : {};
  const backend = typeof extra.backend === 'string' ? extra.backend : undefined;
  // Codex resume is V2-deferred (plan line 357). `undefined` backend is also
  // unsupported — a row without a backend tag can't be routed to AcpChat or
  // TerminalChat. Both fail with the same user-visible message.
  if (backend !== 'claude' && backend !== 'copilot') return { ok: false, errorKey: 'unsupportedBackend' };
  const acpSessionId = typeof extra.acpSessionId === 'string' ? extra.acpSessionId : '';
  if (!acpSessionId) return { ok: false, errorKey: 'sessionMissing' };
  const workspace = typeof extra.workspace === 'string' ? extra.workspace : '';
  if (!workspace) return { ok: false, errorKey: 'cwdMissing' };
  const currentMode: ConversationMode = defaultMode === 'terminal' ? 'terminal' : 'acp';
  if (currentMode === 'terminal') {
    return { ok: true, updates: { extra: { resumedAt: now, currentMode, terminalSwitchedAt: now } } };
  }
  return { ok: true, updates: { extra: { resumedAt: now, currentMode } } };
};

/**
 * Returns `true` only when the row's hydration cache is current along ALL three
 * keys the importer uses to gate cache validity (`importer.ts §hydrateSession`):
 *
 * 1. `hydratedAt` is a number (anything else → stale / never hydrated).
 * 2. `hydratedSourceFilePath` matches the row's current `sourceFilePath`. If the
 *    importer's incremental scan moved the row's source pointer (renamed /
 *    relocated JSONL), the cached messages belong to the old file and the
 *    transcript must re-hydrate.
 * 3. `hydratedShowThinking` matches the current global `showThinking`. The
 *    bridge keys its coalescing on the option; "Show Thinking" toggling at the
 *    header must re-convert the transcript. `undefined` / missing
 *    `hydratedShowThinking` is treated as `false` (the converter's default).
 */
export const isHydrationFresh = (
  conversation: TChatConversation | undefined | null,
  showThinking: boolean
): boolean => {
  if (!conversation) return false;
  const extra =
    conversation.extra && typeof conversation.extra === 'object'
      ? (conversation.extra as Record<string, unknown>)
      : null;
  if (!extra) return false;
  if (typeof extra.hydratedAt !== 'number') return false;
  if (typeof extra.sourceFilePath !== 'string') return false;
  if (extra.hydratedSourceFilePath !== extra.sourceFilePath) return false;
  const cachedShowThinking = extra.hydratedShowThinking === true;
  return cachedShowThinking === showThinking;
};

export type TranscriptViewProps = {
  conversation_id: string;
  workspace?: string;
  backend: AcpBackend;
  /**
   * Current `extra.sourceFilePath`. Threaded as an explicit prop (not just
   * read from `conversation.extra`) so a path refresh from item 1's
   * incremental scan — which can move the row's source pointer while the
   * transcript is already mounted — forces the hydrate effect to re-fire
   * even though `conversation_id` stays the same.
   */
  sourceFilePath: string;
  /**
   * `true` when `extra.hydratedAt`, `extra.hydratedSourceFilePath`, AND
   * `extra.hydratedShowThinking` are all current. Parent computes via
   * `isHydrationFresh(conversation, showThinking)` so this surface is purely
   * presentational — the source-of-truth for staleness lives on the row.
   */
  isHydrated: boolean;
  /**
   * Current global "Show Thinking" toggle, OR `undefined` while
   * `useAgentCliConfig` is still loading. Forwarded to `cliHistory.hydrate`
   * so the importer can re-convert the transcript into the requested variant
   * (`hydrateSession` keys its cache on `(conversationId, normalizedShowThinking)`).
   * The hydrate effect waits for this to become defined before invoking the
   * IPC — otherwise a fast-open right after app start could rewrite the
   * SQLite cache with the default `false` variant while the user's saved
   * preference is `true`, and a navigation away before the re-hydrate would
   * leave the cache wrong until the next open.
   */
  showThinking: boolean | undefined;
  /**
   * Item 8 wires this to the live ACP / terminal launch. The button stays
   * visible + clickable regardless of hydration phase so the user can always
   * retry; the handler decides what to do. The current `phase` is threaded so
   * the parent's pre-flight check can short-circuit on `phase === 'unavailable'`
   * (source JSONL gone AND nothing cached) and show the dedicated
   * `transcript.resumeError.sourceMissing` message rather than letting the live
   * backend fail opaquely after the route gate flips.
   */
  onResume?: (phase: HydrationPhase) => void;
};

const initialPhase = (isHydrated: boolean): HydrationPhase => (isHydrated ? 'ready' : 'loading');

const MAX_PAGE_SIZE = 10_000;

const TranscriptView: React.FC<TranscriptViewProps> = ({
  conversation_id,
  workspace,
  backend,
  sourceFilePath,
  isHydrated,
  showThinking,
  onResume,
}) => {
  const { t } = useTranslation();
  const [state, setState] = useState<HydrationState>({ phase: initialPhase(isHydrated) });
  // Bumped after a fresh hydrate inserts new messages into SQLite (status === 'hydrated'
  // post-mtime-advance). Drives the message-list re-fetch effect below — without
  // this counter, an already-hydrated open whose source JSONL mtime moved forward
  // would keep displaying the stale in-memory list because state.phase stays 'ready'.
  const [messagesRev, setMessagesRev] = useState(0);
  // Track the (conversation, sourceFilePath, showThinking) tuple we've already
  // requested hydration for, so React StrictMode double-mounts and SWR re-renders
  // don't fire the IPC twice. `sourceFilePath` is included so that an importer
  // scan that moves the row's source pointer mid-mount re-triggers hydration.
  const hydrateTriggeredRef = useRef<string | null>(null);
  const updateMessageList = useUpdateMessageList();

  useEffect(() => {
    // Wait for `useAgentCliConfig` to load before invoking hydrate. Without
    // this gate, a fast open right after app start could call the IPC with
    // the fallback `showThinking=false` while the user's saved preference is
    // `true`, rewriting the cache with the wrong variant. The re-hydrate
    // would normally land once config resolves, but a navigation away in
    // between would leave SQLite in the wrong state until next open.
    if (showThinking === undefined) {
      return;
    }
    const triggerKey = `${conversation_id}|${sourceFilePath}|${showThinking ? '1' : '0'}`;
    if (hydrateTriggeredRef.current === triggerKey) {
      return;
    }
    hydrateTriggeredRef.current = triggerKey;
    let cancelled = false;
    // Skeleton appears only when nothing is cached. For already-hydrated rows the
    // cached transcript renders immediately; the hydrate IPC runs in the background
    // to do the plan's "mtime check on open" / source-missing detection
    // (importer.ts hydrateSession) without flashing a loading state.
    if (!isHydrated) {
      setState({ phase: 'loading' });
    }
    ipcBridge.cliHistory.hydrate
      .invoke({ conversationId: conversation_id, showThinking })
      .then((result) => {
        if (cancelled) return;
        if (!result?.success || !result.data) {
          setState({ phase: 'error', errorMessage: result?.msg });
          return;
        }
        const { status, warning } = result.data;
        if (status === 'unavailable') {
          setState({ phase: 'unavailable' });
          return;
        }
        if (warning === 'source_missing') {
          // status was 'cached' — show the cached transcript with the warning banner.
          setState({ phase: 'cached_warning' });
          return;
        }
        setState({ phase: 'ready' });
        if (status === 'hydrated') {
          // Either first-hydration OR mtime advanced past `hydratedAt` and the
          // importer re-converted. Bump rev so the message-load effect re-fetches.
          setMessagesRev((v) => v + 1);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ phase: 'error', errorMessage: message });
      });
    return () => {
      cancelled = true;
    };
  }, [conversation_id, sourceFilePath, isHydrated, showThinking]);

  // Load DB messages once hydration has settled into a renderable phase, and
  // again whenever `messagesRev` bumps (re-hydrate after mtime advance). This
  // replaces a direct `useMessageLstCache` call so the mount-time race
  // (codex P1 / copilot dup) where the DB read returns empty before the
  // importer's insert lands cannot leave the transcript blank — `state.phase`
  // is the gate.
  useEffect(() => {
    if (state.phase === 'loading') return;
    let cancelled = false;
    void ipcBridge.database.getConversationMessages
      .invoke({ conversation_id, page: 0, pageSize: MAX_PAGE_SIZE })
      .then((messages) => {
        if (cancelled) return;
        if (Array.isArray(messages)) {
          updateMessageList(() => messages);
        }
      })
      .catch((err: unknown) => {
        console.warn('[TranscriptView] failed to load messages from database:', err);
      });
    return () => {
      cancelled = true;
    };
    // updateMessageList is a stable callback emitted by createContext factory in hooks.ts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation_id, state.phase, messagesRev]);

  const handleResume = useCallback(() => {
    // Pass the current hydration phase up so the parent can detect
    // `phase === 'unavailable'` (source gone + no cache) and surface the
    // dedicated `sourceMissing` error before mutating the route.
    onResume?.(state.phase);
  }, [onResume, state.phase]);

  const isLoading = state.phase === 'loading';
  const showCachedBanner = state.phase === 'cached_warning';
  const showUnavailable = state.phase === 'unavailable';
  const showError = state.phase === 'error';
  // The cached-warning path still shows the transcript (cached messages remain in
  // SQLite). Same treatment for the error path WHEN there was cached content to
  // show: a failed mtime/source-missing recheck shouldn't blank a transcript the
  // user could already see — it should be banner-only. We rely on `isHydrated` as
  // a mount-time hint that the cache exists; the importer never deletes messages
  // on a failed recheck, so falling back to "still render the list" is safe.
  const showMessages =
    state.phase === 'ready' || state.phase === 'cached_warning' || (state.phase === 'error' && isHydrated);

  return (
    <ConversationProvider value={{ conversationId: conversation_id, workspace, type: 'acp' }}>
      <div
        className='flex-1 flex flex-col px-20px min-h-0'
        data-testid='transcript-view'
        data-backend={backend}
        data-phase={state.phase}
      >
        {showCachedBanner ? (
          <Alert
            type='warning'
            className='mb-12px'
            content={t('conversation.transcript.cachedWarning')}
            data-testid='transcript-cached-warning'
          />
        ) : null}
        {showError ? (
          <Alert
            type='error'
            className='mb-12px'
            content={t('conversation.transcript.error')}
            data-testid='transcript-error'
          />
        ) : null}
        <FlexFullContainer>
          {isLoading ? (
            <div
              className='flex flex-col gap-12px p-16px'
              role='status'
              aria-live='polite'
              aria-label={t('conversation.transcript.skeleton.loading')}
              data-testid='transcript-skeleton'
            >
              <Skeleton animation text={{ rows: 4, width: ['100%', '90%', '80%', '60%'] }} />
              <Skeleton animation text={{ rows: 3, width: ['100%', '95%', '70%'] }} />
              <Skeleton animation text={{ rows: 3, width: ['100%', '85%', '50%'] }} />
            </div>
          ) : showUnavailable ? (
            <div
              className='h-full flex items-center justify-center text-t-secondary text-14px px-16px text-center'
              data-testid='transcript-unavailable'
            >
              {t('conversation.transcript.unavailable')}
            </div>
          ) : showMessages ? (
            <MessageList className='flex-1' />
          ) : null}
        </FlexFullContainer>
        <div className='flex justify-center py-12px border-t border-border-2' data-testid='transcript-resume-bar'>
          <Tooltip content={t('conversation.transcript.resumeTooltip')}>
            <Button
              type='primary'
              size='large'
              data-testid='transcript-resume-button'
              icon={
                <Play
                  theme='outline'
                  size='14'
                  fill='currentColor'
                  strokeWidth={2}
                  strokeLinejoin='miter'
                  strokeLinecap='square'
                />
              }
              onClick={handleResume}
            >
              {t('conversation.transcript.resumeSession')}
            </Button>
          </Tooltip>
        </div>
      </div>
    </ConversationProvider>
  );
};

export default HOC(MessageListProvider)(TranscriptView);
