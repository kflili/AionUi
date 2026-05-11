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
import { MessageListProvider, useMessageLstCache } from '@renderer/pages/conversation/Messages/hooks';
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

export type TranscriptViewProps = {
  conversation_id: string;
  workspace?: string;
  backend: AcpBackend;
  /** Whether `extra.hydratedAt` is already set on the conversation row. */
  isHydrated: boolean;
  /**
   * Item 8 will swap this stub for the live ACP / terminal launch. The button
   * stays visible + clickable regardless of hydration phase so the user can
   * always retry; the handler decides what to do.
   */
  onResume?: () => void;
};

const initialPhase = (isHydrated: boolean): HydrationPhase => (isHydrated ? 'ready' : 'loading');

const TranscriptView: React.FC<TranscriptViewProps> = ({
  conversation_id,
  workspace,
  backend,
  isHydrated,
  onResume,
}) => {
  const { t } = useTranslation();
  const [state, setState] = useState<HydrationState>({ phase: initialPhase(isHydrated) });
  // Track whether we've already triggered hydrate-on-mount for this conversation,
  // so SWR re-renders that swap the same boolean back in don't re-fire it.
  const hydrateTriggeredRef = useRef<string | null>(null);

  useMessageLstCache(conversation_id);

  useEffect(() => {
    if (isHydrated) {
      // Source-already-hydrated path. Item 1's incremental sync may later mark the
      // row stale via mtime, but the in-component check `mtime > hydratedAt` is the
      // importer's job — we just render what SQLite has.
      setState({ phase: 'ready' });
      hydrateTriggeredRef.current = null;
      return;
    }
    const triggerKey = conversation_id;
    if (hydrateTriggeredRef.current === triggerKey) {
      return;
    }
    hydrateTriggeredRef.current = triggerKey;
    let cancelled = false;
    setState({ phase: 'loading' });
    ipcBridge.cliHistory.hydrate
      .invoke({ conversationId: conversation_id })
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
          // status was 'cached' — show the cached transcript with a warning banner.
          setState({ phase: 'cached_warning' });
          return;
        }
        setState({ phase: 'ready' });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ phase: 'error', errorMessage: message });
      });
    return () => {
      cancelled = true;
    };
  }, [conversation_id, isHydrated]);

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
