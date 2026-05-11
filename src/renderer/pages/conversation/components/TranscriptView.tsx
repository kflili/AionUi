/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { AcpBackend } from '@/common/types/acpTypes';
import type { TChatConversation } from '@/common/config/storage';
import FlexFullContainer from '@renderer/components/layout/FlexFullContainer';
import MessageList from '@renderer/pages/conversation/Messages/MessageList';
import { MessageListProvider, useUpdateMessageList } from '@renderer/pages/conversation/Messages/hooks';
import { ConversationProvider } from '@/renderer/hooks/context/ConversationContext';
import HOC from '@renderer/utils/ui/HOC';
import { Alert, Button, Skeleton, Tooltip } from '@arco-design/web-react';
import { Play } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type HydrationPhase = 'loading' | 'ready' | 'cached_warning' | 'unavailable' | 'error';

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
 * Returns `true` only when the row has a numeric `hydratedAt` AND the persisted
 * `hydratedShowThinking` matches the current global `showThinking` option. The
 * importer keys its hydration cache on `(conversationId, normalizedShowThinking)`
 * — a row hydrated under "thinking hidden" must re-hydrate when the user enables
 * "Show Thinking" from the header so SQLite reflects the requested variant
 * (`hydrateSession` semantics in `importer.ts`). `undefined` / missing
 * `hydratedShowThinking` is treated as `false` (the converter's default) to
 * match the bridge's normalization rule.
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
  const cachedShowThinking = extra.hydratedShowThinking === true;
  return cachedShowThinking === showThinking;
};

export type TranscriptViewProps = {
  conversation_id: string;
  workspace?: string;
  backend: AcpBackend;
  /**
   * `true` when `extra.hydratedAt` is set AND `extra.hydratedShowThinking`
   * matches the current global `showThinking`. Parent computes this via
   * `isHydrationFresh(conversation, showThinking)` so this surface is purely
   * presentational — the source-of-truth for staleness lives on the row.
   */
  isHydrated: boolean;
  /**
   * Current global "Show Thinking" toggle. Forwarded to `cliHistory.hydrate`
   * so the importer can re-convert the transcript into the requested variant
   * (`hydrateSession` keys its cache on `(conversationId, normalizedShowThinking)`).
   * Including this in the effect's deps means toggling Show Thinking while a
   * transcript is open triggers a fresh hydrate, replacing the cached
   * messages with the new variant.
   */
  showThinking: boolean;
  /**
   * Item 8 will swap this stub for the live ACP / terminal launch. The button
   * stays visible + clickable regardless of hydration phase so the user can
   * always retry; the handler decides what to do.
   */
  onResume?: () => void;
};

const initialPhase = (isHydrated: boolean): HydrationPhase => (isHydrated ? 'ready' : 'loading');

const MAX_PAGE_SIZE = 10_000;

const TranscriptView: React.FC<TranscriptViewProps> = ({
  conversation_id,
  workspace,
  backend,
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
  // Track the (conversation, showThinking) pair we've already requested hydration for,
  // so React StrictMode double-mounts and SWR re-renders don't fire the IPC twice.
  const hydrateTriggeredRef = useRef<string | null>(null);
  const updateMessageList = useUpdateMessageList();

  useEffect(() => {
    const triggerKey = `${conversation_id}:${showThinking ? '1' : '0'}`;
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
  }, [conversation_id, isHydrated, showThinking]);

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
    // TODO(item 8): wire this to the live ACP / terminal launch chosen by the
    // Step 1 default-mode toggle. Until then the gate is intentionally
    // user-driven — the button is visible + clickable, but no live surface
    // mounts as a side-effect of opening a transcript.
    onResume?.();
  }, [onResume]);

  const isLoading = state.phase === 'loading';
  const showCachedBanner = state.phase === 'cached_warning';
  const showUnavailable = state.phase === 'unavailable';
  const showError = state.phase === 'error';
  // The cached-warning path still shows the transcript (cached messages remain in SQLite).
  const showMessages = state.phase === 'ready' || state.phase === 'cached_warning';

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
