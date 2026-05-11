/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/config/storage';
import { useAgentCliConfig } from '@renderer/hooks/agent/useAgentCliConfig';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { Message } from '@arco-design/web-react';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ExportTask, ExportZipFile } from '../types';
import {
  appendWorkspaceFilesToZip,
  buildConversationJson,
  buildConversationMarkdown,
  buildTopicFolderName,
  ensureHydratedForExport,
  EXPORT_IO_TIMEOUT_MS,
  formatTimestamp,
  joinFilePath,
  sanitizeFileName,
  withTimeout,
} from '../utils/exportHelpers';

type UseExportParams = {
  conversations: TChatConversation[];
  selectedConversationIds: Set<string>;
  setSelectedConversationIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  onBatchModeChange?: (value: boolean) => void;
};

export const useExport = ({
  conversations,
  selectedConversationIds,
  setSelectedConversationIds,
  onBatchModeChange,
}: UseExportParams) => {
  const [exportTask, setExportTask] = useState<ExportTask>(null);
  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [exportTargetPath, setExportTargetPath] = useState('');
  const [exportModalLoading, setExportModalLoading] = useState(false);
  const [showExportDirectorySelector, setShowExportDirectorySelector] = useState(false);
  const [currentExportRequestId, setCurrentExportRequestId] = useState<string | null>(null);
  const exportCanceledRef = useRef(false);
  const { t } = useTranslation();
  // `useAgentCliConfig()` returns `undefined` while the initial ConfigStorage
  // fetch is in flight, and `{}` (an empty config) once loaded with no stored
  // preference. We only treat the in-flight `undefined` as "still loading"
  // (helper bails to avoid clobbering the SQLite cache variant); an empty
  // loaded config means the user has never toggled Show Thinking, in which
  // case we use `false` — the converter's default and the value that
  // matches the importer's `normalizedShowThinking` for unconfigured rows.
  // Mirrors `ChatConversation`'s `agentCliConfig?.showThinking ?? false`
  // pattern (which only resolves the loaded-vs-loading split implicitly
  // because its caller already guards against `undefined`).
  const agentCli = useAgentCliConfig();
  const showThinkingForHydrate = agentCli === undefined ? undefined : (agentCli.showThinking ?? false);

  const fileExists = useCallback(async (filePath: string): Promise<boolean> => {
    try {
      const metadata = await withTimeout(
        ipcBridge.fs.getFileMetadata.invoke({ path: filePath }),
        EXPORT_IO_TIMEOUT_MS,
        `getFileMetadata:${filePath}`
      );
      return metadata.size >= 0;
    } catch {
      return false;
    }
  }, []);

  const createUniqueFilePath = useCallback(
    async (directory: string, fileNameWithoutExt: string, ext: 'json' | 'md' | 'zip') => {
      const safeBaseName = sanitizeFileName(fileNameWithoutExt);
      const candidate = joinFilePath(directory, `${safeBaseName}.${ext}`);
      if (!(await fileExists(candidate))) {
        return candidate;
      }

      for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
        const nextCandidate = joinFilePath(directory, `${safeBaseName}-${Date.now()}-${index}.${ext}`);
        if (!(await fileExists(nextCandidate))) {
          return nextCandidate;
        }
      }

      return candidate;
    },
    [fileExists]
  );

  const getDesktopPath = useCallback(async (): Promise<string> => {
    try {
      const desktopPath = await ipcBridge.application.getPath.invoke({ name: 'desktop' });
      return desktopPath || '';
    } catch {
      return '';
    }
  }, []);

  const closeExportModal = useCallback(() => {
    if (exportModalLoading) {
      exportCanceledRef.current = true;
    }
    if (exportModalLoading && currentExportRequestId) {
      void ipcBridge.fs.cancelZip.invoke({ requestId: currentExportRequestId });
    }
    setExportModalVisible(false);
    setExportTask(null);
    setExportTargetPath('');
    setExportModalLoading(false);
    setCurrentExportRequestId(null);
  }, [currentExportRequestId, exportModalLoading]);

  const openExportModal = useCallback(
    async (task: NonNullable<ExportTask>) => {
      exportCanceledRef.current = false;
      setExportTask(task);
      setExportModalVisible(true);
      const desktopPath = await getDesktopPath();
      setExportTargetPath(desktopPath);
    },
    [getDesktopPath]
  );

  const handleSelectExportDirectoryFromModal = useCallback((paths: string[] | undefined) => {
    setShowExportDirectorySelector(false);
    if (paths && paths.length > 0) {
      setExportTargetPath(paths[0]);
    }
  }, []);

  const handleSelectExportFolder = useCallback(async () => {
    if (exportModalLoading) {
      return;
    }

    if (!isElectronDesktop()) {
      setShowExportDirectorySelector(true);
      return;
    }

    try {
      const desktopPath = exportTargetPath || (await getDesktopPath());
      const folders = await ipcBridge.dialog.showOpen.invoke({
        properties: ['openDirectory'],
        defaultPath: desktopPath || undefined,
      });
      if (folders && folders.length > 0) {
        setExportTargetPath(folders[0]);
      }
    } catch (error) {
      console.error('Failed to open export directory dialog:', error);
      Message.error(t('conversation.history.exportFailed'));
    }
  }, [exportModalLoading, exportTargetPath, getDesktopPath, t]);

  const fetchConversationMessages = useCallback(async (conversationId: string) => {
    try {
      return await withTimeout(
        ipcBridge.database.getConversationMessages.invoke({
          conversation_id: conversationId,
          page: 0,
          pageSize: 10000,
        }),
        EXPORT_IO_TIMEOUT_MS,
        `getConversationMessages:${conversationId}`
      );
    } catch (error) {
      console.warn('[WorkspaceGroupedHistory] Export message fetch timeout/failure:', conversationId, error);
      return [];
    }
  }, []);

  // Imported (CLI-history) conversations may be Phase-1 metadata only at
  // export time — no messages in SQLite yet, or the cached variant doesn't
  // match the current Show Thinking preference / source file path. Auto-
  // hydrate via the existing `cliHistory.hydrate` IPC contract from item 2
  // (mtime check + coalescing are handled inside that primitive — we never
  // add a parallel hydration code path). The helper itself decides whether
  // the IPC actually fires by mirroring `TranscriptView.isHydrationFresh`.
  // The invoke is wrapped in `withTimeout` (same primitive as the other
  // export IPCs) so a stalled hydrate cannot pin the export modal open
  // forever; we give it 8× the regular IO budget because large JSONLs can
  // legitimately take several seconds to convert.
  const ensureHydrationForExport = useCallback(
    async (conversation: TChatConversation): Promise<boolean> => {
      const outcome = await ensureHydratedForExport(conversation, showThinkingForHydrate, (args) =>
        withTimeout(
          ipcBridge.cliHistory.hydrate.invoke(args),
          EXPORT_IO_TIMEOUT_MS * 8,
          `cliHistory.hydrate:${args.conversationId}`
        )
      );
      switch (outcome.status) {
        case 'skipped':
        case 'hydrated':
          return true;
        case 'cached_warning':
          // Source JSONL missing but SQLite has a prior transcript — export
          // the cached messages with a non-blocking warning per plan §"Missing
          // source files" (line 257).
          Message.warning(t('conversation.history.exportSourceMissingWarning'));
          return true;
        case 'unavailable':
          // Never hydrated AND source file is gone — nothing to export.
          Message.error(t('conversation.history.exportSourceUnavailable'));
          return false;
        case 'failed':
        default:
          Message.error(t('conversation.history.exportFailed'));
          return false;
      }
    },
    [showThinkingForHydrate, t]
  );

  const fetchConversationWorkspaceTree = useCallback(async (conversation: TChatConversation) => {
    const workspace = conversation.extra?.workspace;
    if (!workspace) {
      return undefined;
    }

    try {
      const trees = await withTimeout(
        ipcBridge.conversation.getWorkspace.invoke({
          conversation_id: conversation.id,
          workspace,
          path: workspace,
        }),
        EXPORT_IO_TIMEOUT_MS,
        `getWorkspace:${conversation.id}`
      );
      return trees?.[0];
    } catch (error) {
      console.warn('[WorkspaceGroupedHistory] Failed to read workspace for export:', conversation.id, error);
      return undefined;
    }
  }, []);

  const buildConversationExportFiles = useCallback(
    async (conversation: TChatConversation, topicFolderName: string): Promise<ExportZipFile[]> => {
      const [messages, workspaceTree] = await Promise.all([
        fetchConversationMessages(conversation.id),
        fetchConversationWorkspaceTree(conversation),
      ]);
      const files: ExportZipFile[] = [
        {
          name: `${topicFolderName}/conversation/conversation.json`,
          content: buildConversationJson(conversation, messages),
        },
        {
          name: `${topicFolderName}/conversation/conversation.md`,
          content: buildConversationMarkdown(conversation, messages),
        },
      ];

      appendWorkspaceFilesToZip(files, workspaceTree, topicFolderName);
      return files;
    },
    [fetchConversationMessages, fetchConversationWorkspaceTree]
  );

  const runCreateZip = useCallback(
    async (path: string, files: ExportZipFile[], requestId: string): Promise<boolean> => {
      try {
        return await withTimeout(
          ipcBridge.fs.createZip.invoke({ path, files, requestId }),
          EXPORT_IO_TIMEOUT_MS * 8,
          `createZip:${requestId}`
        );
      } catch (error) {
        // Ensure background zip task is stopped when renderer-side timeout/cancel happens.
        void ipcBridge.fs.cancelZip.invoke({ requestId });
        throw error;
      }
    },
    []
  );

  const handleExportConversation = useCallback(
    (conversation: TChatConversation) => {
      void openExportModal({ mode: 'single', conversation });
    },
    [openExportModal]
  );

  const handleBatchExport = useCallback(() => {
    if (selectedConversationIds.size === 0) {
      Message.warning(t('conversation.history.batchNoSelection'));
      return;
    }
    void openExportModal({
      mode: 'batch',
      conversationIds: Array.from(selectedConversationIds),
    });
  }, [openExportModal, selectedConversationIds, t]);

  const handleConfirmExport = useCallback(async () => {
    if (!exportTask) return;

    const directory = exportTargetPath.trim();
    if (!directory) {
      Message.warning(t('conversation.history.exportSelectFolder'));
      return;
    }

    setExportModalLoading(true);
    exportCanceledRef.current = false;
    const requestId = `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setCurrentExportRequestId(requestId);

    const throwIfCanceled = () => {
      if (exportCanceledRef.current) {
        throw new Error('export canceled');
      }
    };

    try {
      if (exportTask.mode === 'single') {
        throwIfCanceled();
        const conversation = exportTask.conversation;
        if (!(await ensureHydrationForExport(conversation))) {
          return;
        }
        throwIfCanceled();
        const shortTopicName = sanitizeFileName(conversation.name || conversation.id).slice(0, 40) || 'topic';
        const zipFileName = `${shortTopicName}-${formatTimestamp()}`;
        const exportPath = await createUniqueFilePath(directory, zipFileName, 'zip');
        throwIfCanceled();
        const topicFolderName = buildTopicFolderName(conversation);
        const files = await buildConversationExportFiles(conversation, topicFolderName);
        throwIfCanceled();
        const success = await runCreateZip(exportPath, files, requestId);
        throwIfCanceled();

        if (success) {
          Message.success(t('conversation.history.exportSuccess'));
          setExportModalVisible(false);
          setExportTask(null);
          setExportTargetPath('');
          setCurrentExportRequestId(null);
        } else {
          Message.error(t('conversation.history.exportFailed'));
        }
        return;
      }

      const selectedConversations = conversations.filter((conversation) =>
        exportTask.conversationIds.includes(conversation.id)
      );
      if (selectedConversations.length === 0) {
        Message.warning(t('conversation.history.batchNoSelection'));
        return;
      }

      const files: ExportZipFile[] = [];
      for (const conversation of selectedConversations) {
        throwIfCanceled();
        if (!(await ensureHydrationForExport(conversation))) {
          return;
        }
        throwIfCanceled();
        const topicFiles = await buildConversationExportFiles(conversation, buildTopicFolderName(conversation));
        throwIfCanceled();
        files.push(...topicFiles);
      }
      const exportPath = await createUniqueFilePath(directory, `batch-export-${formatTimestamp()}`, 'zip');
      throwIfCanceled();
      const success = await runCreateZip(exportPath, files, requestId);
      throwIfCanceled();

      if (success) {
        Message.success(t('conversation.history.exportSuccess'));
        setSelectedConversationIds(new Set());
        onBatchModeChange?.(false);
        setExportModalVisible(false);
        setExportTask(null);
        setExportTargetPath('');
        setCurrentExportRequestId(null);
      } else {
        Message.error(t('conversation.history.exportFailed'));
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('canceled')) {
        Message.warning(t('conversation.history.exportCanceled'));
      } else {
        console.error('Failed to export conversations:', error);
        Message.error(t('conversation.history.exportFailed'));
      }
    } finally {
      setExportModalLoading(false);
      setCurrentExportRequestId(null);
      exportCanceledRef.current = false;
    }
  }, [
    buildConversationExportFiles,
    conversations,
    createUniqueFilePath,
    ensureHydrationForExport,
    exportTargetPath,
    exportTask,
    onBatchModeChange,
    runCreateZip,
    t,
    setSelectedConversationIds,
  ]);

  return {
    exportTask,
    exportModalVisible,
    exportTargetPath,
    exportModalLoading,
    showExportDirectorySelector,
    setShowExportDirectorySelector,
    closeExportModal,
    handleSelectExportDirectoryFromModal,
    handleSelectExportFolder,
    handleExportConversation,
    handleBatchExport,
    handleConfirmExport,
  };
};
