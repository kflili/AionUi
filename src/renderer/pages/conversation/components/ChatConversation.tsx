/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { ConversationMode, IProvider, TChatConversation, TProviderWithModel } from '@/common/config/storage';
import { ConfigStorage } from '@/common/config/storage';
import { uuid } from '@/common/utils';
import addChatIcon from '@/renderer/assets/icons/add-chat.svg';
import { CronJobManager } from '@/renderer/pages/cron';
import { useAgentCliConfig } from '@/renderer/hooks/agent/useAgentCliConfig';
import { usePresetAssistantInfo } from '@/renderer/hooks/agent/usePresetAssistantInfo';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { iconColors } from '@/renderer/styles/colors';
import { Button, Dropdown, Menu, Message, Tooltip, Typography } from '@arco-design/web-react';
import { Brain, History } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import useSWR, { mutate } from 'swr';
import { emitter } from '../../../utils/emitter';
import AcpChat from '../platforms/acp/AcpChat';
import ChatLayout from './ChatLayout';
import ChatSider from './ChatSider';
import TranscriptView, {
  isHydrationFresh,
  isImportedAcpConversation,
  isResumedImportedSession,
  validateResumeRequest,
  type HydrationPhase,
} from './TranscriptView';
import CodexChat from '../platforms/codex/CodexChat';
import NanobotChat from '../platforms/nanobot/NanobotChat';
import OpenClawChat from '../platforms/openclaw/OpenClawChat';
import GeminiChat from '../platforms/gemini/GeminiChat';
import TerminalChat from '../platforms/terminal/TerminalChat';
import ModeToggle from '../platforms/terminal/ModeToggle';
import AcpModelSelector from '@/renderer/components/agent/AcpModelSelector';
import GeminiModelSelector from '../platforms/gemini/GeminiModelSelector';
import { useGeminiModelSelection } from '../platforms/gemini/useGeminiModelSelection';
import { usePreviewContext } from '../Preview';
import StarOfficeMonitorCard from '../platforms/openclaw/StarOfficeMonitorCard.tsx';

const _AssociatedConversation: React.FC<{ conversation_id: string }> = ({ conversation_id }) => {
  const { data } = useSWR(['getAssociateConversation', conversation_id], () =>
    ipcBridge.conversation.getAssociateConversation.invoke({ conversation_id })
  );
  const navigate = useNavigate();
  const list = useMemo(() => {
    if (!data?.length) return [];
    return data.filter((conversation) => conversation.id !== conversation_id);
  }, [data]);
  if (!list.length) return null;
  return (
    <Dropdown
      droplist={
        <Menu
          onClickMenuItem={(key) => {
            Promise.resolve(navigate(`/conversation/${key}`)).catch((error) => {
              console.error('Navigation failed:', error);
            });
          }}
        >
          {list.map((conversation) => {
            return (
              <Menu.Item key={conversation.id}>
                <Typography.Ellipsis className={'max-w-300px'}>{conversation.name}</Typography.Ellipsis>
              </Menu.Item>
            );
          })}
        </Menu>
      }
      trigger={['click']}
    >
      <Button
        size='mini'
        icon={
          <History
            theme='filled'
            size='14'
            fill={iconColors.primary}
            strokeWidth={2}
            strokeLinejoin='miter'
            strokeLinecap='square'
          />
        }
      ></Button>
    </Dropdown>
  );
};

const _AddNewConversation: React.FC<{ conversation: TChatConversation }> = ({ conversation }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (!conversation.extra?.workspace) return null;
  return (
    <Tooltip content={t('conversation.workspace.createNewConversation')}>
      <Button
        size='mini'
        icon={<img src={addChatIcon} alt='Add chat' className='w-14px h-14px block m-auto' />}
        onClick={async () => {
          const id = uuid();
          // Fetch latest conversation from DB to ensure sessionMode is current
          const latest = await ipcBridge.conversation.get.invoke({ id: conversation.id }).catch((): null => null);
          const source = latest || conversation;
          // When cloning an ACP row, strip CLI-history-import-only fields so the new
          // user-owned conversation is not later hidden by `disableSource('claude_code')`
          // or matched by the importer's `source + sourceFilePath` dedup. Native ACP
          // rows never carry these fields, so this is a no-op for non-imported sources.
          const nextExtra =
            source.type === 'acp'
              ? (() => {
                  const baseExtra =
                    source.extra && typeof source.extra === 'object' ? (source.extra as Record<string, unknown>) : {};
                  const {
                    acpSessionId: _acpSessionId,
                    acpSessionUpdatedAt: _acpSessionUpdatedAt,
                    sourceFilePath: _sourceFilePath,
                    messageCount: _messageCount,
                    importMeta: _importMeta,
                    hydratedAt: _hydratedAt,
                    hydratedSourceFilePath: _hydratedSourceFilePath,
                    hydratedShowThinking: _hydratedShowThinking,
                    ...rest
                  } = baseExtra;
                  return rest;
                })()
              : source.extra;
          const isImportedClone = source.type === 'acp' && source.source !== 'aionui';
          ipcBridge.conversation.createWithConversation
            .invoke({
              conversation: {
                ...source,
                id,
                createTime: Date.now(),
                modifyTime: Date.now(),
                // Reset source to 'aionui' so the clone is treated as a native chat,
                // not as an imported CLI session. This prevents disable/re-enable
                // semantics from sweeping it up alongside the original imported rows.
                source: isImportedClone ? 'aionui' : source.source,
                extra: nextExtra,
              } as TChatConversation,
            })
            .then(() => {
              Promise.resolve(navigate(`/conversation/${id}`)).catch((error) => {
                console.error('Navigation failed:', error);
              });
              emitter.emit('chat.history.refresh');
            })
            .catch((error) => {
              console.error('Failed to create conversation:', error);
            });
        }}
      />
    </Tooltip>
  );
};

// 仅抽取 Gemini 会话，确保包含模型信息
// Narrow to Gemini conversations so model field is always available
type GeminiConversation = Extract<TChatConversation, { type: 'gemini' }>;

const GeminiConversationPanel: React.FC<{ conversation: GeminiConversation; sliderTitle: React.ReactNode }> = ({
  conversation,
  sliderTitle,
}) => {
  // Save model selection to conversation via IPC
  const onSelectModel = useCallback(
    async (_provider: IProvider, modelName: string) => {
      const selected = { ..._provider, useModel: modelName } as TProviderWithModel;
      const ok = await ipcBridge.conversation.update.invoke({ id: conversation.id, updates: { model: selected } });
      return Boolean(ok);
    },
    [conversation.id]
  );

  // Share model selection state between header and send box
  const modelSelection = useGeminiModelSelection({ initialModel: conversation.model, onSelectModel });
  const workspaceEnabled = Boolean(conversation.extra?.workspace);

  // 使用统一的 Hook 获取预设助手信息 / Use unified hook for preset assistant info
  const { info: presetAssistantInfo } = usePresetAssistantInfo(conversation);

  const chatLayoutProps = {
    title: conversation.name,
    siderTitle: sliderTitle,
    sider: <ChatSider conversation={conversation} />,
    headerLeft: <GeminiModelSelector selection={modelSelection} />,
    headerExtra: <CronJobManager conversationId={conversation.id} />,
    workspaceEnabled,
    backend: 'gemini' as const,
    // 传递预设助手信息 / Pass preset assistant info
    agentName: presetAssistantInfo?.name,
    agentLogo: presetAssistantInfo?.logo,
    agentLogoIsEmoji: presetAssistantInfo?.isEmoji,
  };

  return (
    <ChatLayout {...chatLayoutProps} conversationId={conversation.id}>
      <GeminiChat
        conversation_id={conversation.id}
        workspace={conversation.extra.workspace}
        modelSelection={modelSelection}
      />
    </ChatLayout>
  );
};

const ChatConversation: React.FC<{
  conversation?: TChatConversation;
}> = ({ conversation }) => {
  const { t } = useTranslation();
  const { openPreview } = usePreviewContext();
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const workspaceEnabled = Boolean(conversation?.extra?.workspace);

  const isGeminiConversation = conversation?.type === 'gemini';

  // Terminal mode state — only for ACP conversations
  const [currentMode, setCurrentMode] = useState<ConversationMode>('acp');
  const isTerminalMode = conversation?.type === 'acp' && currentMode === 'terminal';

  // Show Thinking toggle — global setting, quick-access from header.
  // Header button is disabled until showThinkingLoaded is true so the toggle can never
  // fire before the hook has resolved; the early-return below is defensive belt-and-suspenders.
  const agentCliConfig = useAgentCliConfig();
  const showThinkingLoaded = agentCliConfig !== undefined;
  const showThinking = agentCliConfig?.showThinking ?? false;
  const handleToggleThinking = useCallback(() => {
    if (agentCliConfig === undefined) return;
    const next = !agentCliConfig.showThinking;
    ConfigStorage.set('agentCli.config', { ...agentCliConfig, showThinking: next }).catch((error: unknown) => {
      console.error('[ChatConversation] Failed to persist showThinking toggle', error);
    });
  }, [agentCliConfig]);

  // Wire the "Resume this session" click on imported CLI-history rows to a real
  // live launch. We do NOT spawn ACP / terminal processes directly here — instead
  // we (a) pre-flight the row, then (b) stamp `extra.resumedAt` + `currentMode`
  // (and `terminalSwitchedAt` when the Step 1 toggle is Terminal) so the next
  // render falls through `shouldShowTranscript` into the existing AcpChat /
  // TerminalChat branch. Those branches own the actual `--resume <id>` /
  // ACP-connect logic and we deliberately reuse them rather than duplicate.
  //
  // On any pre-flight failure the transcript stays mounted + read-only and the
  // user sees an Arco `Message.error` toast keyed off
  // `conversation.transcript.resumeError.<reason>`.
  const handleResumeImported = useCallback(
    (phase: HydrationPhase) => {
      // Defensive — the button is rendered without a disabled state, but a click
      // before `useAgentCliConfig` resolves should not mutate state with the
      // fallback Rich-UI mode. The hook normally settles long before the user
      // could reach the transcript surface; this guard catches the racy edge.
      if (agentCliConfig === undefined) return;
      if (!conversation || conversation.type !== 'acp') return;

      const result = validateResumeRequest(conversation, agentCliConfig.defaultMode, phase, Date.now());
      if (result.ok === false) {
        Message.error(t(`conversation.transcript.resumeError.${result.errorKey}` as const));
        return;
      }

      // Synchronously align the local `currentMode` with the persisted target
      // BEFORE the IPC. Without this, a row whose stale `extra.currentMode` is
      // 'terminal' but whose Resume picks Rich UI (`defaultMode === 'acp'`)
      // would, in the first render after `mutate`, still see `isTerminalMode`
      // true (driven by the local React state) while `shouldShowTranscript`
      // flips to false (driven by the just-persisted `extra.resumedAt`). That
      // window mounts TerminalChat for a frame and could start a PTY despite
      // the user's choice. The `persistedMode` sync effect would fix it on the
      // next render, but doing the alignment synchronously here prevents the
      // race entirely (codex R2 on PR #25).
      setCurrentMode(result.updates.extra.currentMode);

      void ipcBridge.conversation.update
        .invoke({
          id: conversation.id,
          updates: result.updates as unknown as Partial<TChatConversation>,
          mergeExtra: true,
        })
        .then(() => mutate(`conversation/${conversation.id}`))
        .catch((err: unknown) => {
          // Persist failure — the IPC itself rejected (e.g. DB write error or
          // bridge disconnect), distinct from the pre-flight validation
          // failures above. Use the generic `common.saveFailed` rather than a
          // resume-specific key so the user understands the click didn't take
          // effect for a transport / storage reason. Transcript stays mounted.
          console.error('[ChatConversation] Failed to persist resume state', err);
          Message.error(t('common.saveFailed'));
        });
    },
    [agentCliConfig, conversation, t]
  );

  // Sync mode state when conversation changes or SWR revalidates with fresh extra data
  const persistedMode = conversation?.type === 'acp' ? conversation.extra?.currentMode : undefined;
  useEffect(() => {
    if (conversation?.type === 'acp') {
      setCurrentMode((persistedMode as ConversationMode) || 'acp');
    } else {
      setCurrentMode('acp');
    }
  }, [conversation?.id, conversation?.type, persistedMode]);

  // Auto-sync JSONL → DB when loading an ACP conversation in Rich UI mode,
  // or when switching back from terminal mode. Catches messages produced
  // during terminal sessions that weren't converted to the DB.
  // Only runs for conversations that were previously in terminal mode (have terminalSwitchedAt).
  const acpSessionId = conversation?.type === 'acp' ? conversation.extra?.acpSessionId : undefined;
  const hadTerminalSession = Boolean(conversation?.type === 'acp' && conversation.extra?.terminalSwitchedAt);
  useEffect(() => {
    if (!showThinkingLoaded || !hadTerminalSession) return;
    if (!conversation?.id || conversation.type !== 'acp' || currentMode === 'terminal') return;
    const backend = conversation.extra?.backend || 'claude';
    if (!acpSessionId) return;

    void ipcBridge.cliHistory.convertSessionToMessages
      .invoke({
        conversationId: conversation.id,
        sessionId: acpSessionId,
        backend,
        terminalSwitchedAt: conversation.extra?.terminalSwitchedAt ?? 0,
        showThinking,
      })
      .then((result) => {
        if (result?.success && result.data?.count > 0) {
          emitter.emit('chat.history.refresh');
        }
      })
      .catch((err: unknown) => {
        console.warn('[ChatConversation] JSONL sync failed:', err);
      });
  }, [conversation?.id, currentMode, acpSessionId, showThinkingLoaded, hadTerminalSession]);

  const conversationNode = useMemo(() => {
    if (!conversation || isGeminiConversation) return null;

    // CLI-history-imported ACP sessions (extra.sourceFilePath set) open as a
    // read-only transcript regardless of the mode toggle — the user must
    // explicitly click "Resume this session" to start any live ACP / terminal
    // surface. Once Resume succeeds, `extra.resumedAt` is stamped and the row
    // flips out of transcript mode permanently (subsequent opens go straight to
    // the live route). Checking this BEFORE the terminal-mode early-return
    // prevents a stale `extra.currentMode = 'terminal'` from accidentally
    // launching a live PTY when the user just wants to read.
    const shouldShowTranscript = isImportedAcpConversation(conversation) && !isResumedImportedSession(conversation);

    // Terminal mode rendering for ACP conversations (live, native rows OR
    // resumed-imported rows).
    if (conversation.type === 'acp' && isTerminalMode && !shouldShowTranscript) {
      return (
        <TerminalChat
          key={`terminal-${conversation.id}`}
          conversationId={conversation.id}
          workspace={conversation.extra?.workspace}
          backend={conversation.extra?.backend || 'claude'}
          acpSessionId={conversation.extra?.acpSessionId}
          cliPath={conversation.extra?.cliPath}
          sessionMode={conversation.extra?.sessionMode}
        />
      );
    }

    switch (conversation.type) {
      case 'acp': {
        if (shouldShowTranscript) {
          // `sourceFilePath` is guaranteed non-empty by `isImportedAcpConversation`;
          // assertion is safe here. Threading it explicitly lets TranscriptView re-fire
          // hydration when an incremental scan refreshes the source pointer mid-mount.
          const sourceFilePath = (conversation.extra as { sourceFilePath: string }).sourceFilePath;
          // Gate `showThinking` on `showThinkingLoaded`: while the config is still
          // loading we pass `undefined`, which causes TranscriptView's hydrate effect
          // to wait. Without this, a fast open right after app start could rewrite
          // the SQLite cache with the fallback `false` variant before the user's saved
          // preference (possibly `true`) has loaded. `isHydrated` is also gated so a
          // stale freshness check computed against the fallback can't trick us into
          // skipping the hydrate.
          const showThinkingForTranscript = showThinkingLoaded ? showThinking : undefined;
          const isHydrated = showThinkingLoaded && isHydrationFresh(conversation, showThinking);
          return (
            <TranscriptView
              key={conversation.id}
              conversation_id={conversation.id}
              workspace={conversation.extra?.workspace}
              backend={conversation.extra?.backend || 'claude'}
              sourceFilePath={sourceFilePath}
              isHydrated={isHydrated}
              showThinking={showThinkingForTranscript}
              onResume={handleResumeImported}
            />
          );
        }
        return (
          <AcpChat
            key={conversation.id}
            conversation_id={conversation.id}
            workspace={conversation.extra?.workspace}
            backend={conversation.extra?.backend || 'claude'}
            sessionMode={conversation.extra?.sessionMode}
            agentName={(conversation.extra as { agentName?: string })?.agentName}
          ></AcpChat>
        );
      }
      case 'codex': // Legacy: new Codex conversations use ACP protocol. Kept for existing sessions.
        return (
          <CodexChat
            key={conversation.id}
            conversation_id={conversation.id}
            workspace={conversation.extra?.workspace}
          />
        );
      case 'openclaw-gateway':
        return (
          <OpenClawChat
            key={conversation.id}
            conversation_id={conversation.id}
            workspace={conversation.extra?.workspace}
          />
        );
      case 'nanobot':
        return (
          <NanobotChat
            key={conversation.id}
            conversation_id={conversation.id}
            workspace={conversation.extra?.workspace}
          />
        );
      default:
        return null;
    }
  }, [conversation, isGeminiConversation, isTerminalMode, showThinking, showThinkingLoaded, handleResumeImported]);

  // 使用统一的 Hook 获取预设助手信息（ACP/Codex 会话）
  // Use unified hook for preset assistant info (ACP/Codex conversations)
  const { info: presetAssistantInfo, isLoading: isLoadingPreset } = usePresetAssistantInfo(
    isGeminiConversation ? undefined : conversation
  );

  const sliderTitle = useMemo(() => {
    return (
      <div className='flex items-center justify-between'>
        <span className='text-16px font-bold text-t-primary'>{t('conversation.workspace.title')}</span>
      </div>
    );
  }, [t]);

  // For ACP/Codex conversations, use AcpModelSelector that can show/switch models.
  // For other non-Gemini conversations, show disabled GeminiModelSelector.
  // NOTE: This must be placed before the Gemini early return to maintain consistent hook order.
  const modelSelector = useMemo(() => {
    if (!conversation || isGeminiConversation) return undefined;
    if (conversation.type === 'acp') {
      const extra = conversation.extra as { backend?: string; currentModelId?: string };
      return (
        <AcpModelSelector
          conversationId={conversation.id}
          backend={extra.backend}
          initialModelId={extra.currentModelId}
        />
      );
    }
    if (conversation.type === 'codex') {
      return <AcpModelSelector conversationId={conversation.id} />;
    }
    return <GeminiModelSelector disabled={true} />;
  }, [conversation, isGeminiConversation]);

  if (conversation && conversation.type === 'gemini') {
    // Gemini 会话独立渲染，带右上角模型选择
    // Render Gemini layout with dedicated top-right model selector
    return <GeminiConversationPanel key={conversation.id} conversation={conversation} sliderTitle={sliderTitle} />;
  }

  // 如果有预设助手信息，使用预设助手的 logo 和名称；加载中时不进入 fallback；否则使用 backend 的 logo
  // If preset assistant info exists, use preset logo/name; while loading, avoid fallback; otherwise use backend logo
  const chatLayoutProps = presetAssistantInfo
    ? {
        agentName: presetAssistantInfo.name,
        agentLogo: presetAssistantInfo.logo,
        agentLogoIsEmoji: presetAssistantInfo.isEmoji,
      }
    : isLoadingPreset
      ? {} // Still loading custom agents — avoid showing backend logo prematurely
      : {
          backend:
            conversation?.type === 'acp'
              ? conversation?.extra?.backend
              : conversation?.type === 'codex'
                ? 'codex'
                : conversation?.type === 'openclaw-gateway'
                  ? 'openclaw-gateway'
                  : conversation?.type === 'nanobot'
                    ? 'nanobot'
                    : undefined,
          agentName: (conversation?.extra as { agentName?: string })?.agentName,
        };

  const headerExtraNode = (
    <div className='flex items-center gap-8px'>
      {conversation?.type === 'acp' && (
        <div className='shrink-0 flex items-center gap-4px'>
          <Tooltip
            position='bottom'
            content={t('settings.terminalWrapper.showThinkingHeaderTooltip')}
            disabled={isMobile}
          >
            <Button
              type='text'
              shape='circle'
              size='mini'
              disabled={!showThinkingLoaded}
              aria-label={t('settings.terminalWrapper.showThinking')}
              aria-pressed={showThinking}
              icon={
                <Brain
                  theme={showThinking ? 'filled' : 'outline'}
                  size='14'
                  fill={showThinking ? 'rgb(var(--primary-6))' : iconColors.secondary}
                />
              }
              onClick={handleToggleThinking}
            />
          </Tooltip>
          <ModeToggle conversationId={conversation.id} currentMode={currentMode} onModeChange={setCurrentMode} />
        </div>
      )}
      {conversation?.type === 'openclaw-gateway' && (
        <div className='shrink-0'>
          <StarOfficeMonitorCard
            conversationId={conversation.id}
            onOpenUrl={(url, metadata) => {
              openPreview(url, 'url', metadata);
            }}
          />
        </div>
      )}
      {conversation ? (
        <div className='shrink-0'>
          <CronJobManager conversationId={conversation.id} />
        </div>
      ) : null}
    </div>
  );

  return (
    <ChatLayout
      title={conversation?.name}
      {...chatLayoutProps}
      headerLeft={modelSelector}
      headerExtra={headerExtraNode}
      siderTitle={sliderTitle}
      sider={<ChatSider conversation={conversation} />}
      workspaceEnabled={workspaceEnabled}
      conversationId={conversation?.id}
    >
      {conversationNode}
    </ChatLayout>
  );
};

export default ChatConversation;
