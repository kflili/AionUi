import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn(() => '/tmp') } }));

const handlers: Record<string, (...args: any[]) => any> = {};
function makeChannel(name: string) {
  return {
    provider: vi.fn((fn: (...args: any[]) => any) => {
      handlers[name] = fn;
    }),
    emit: vi.fn(),
    invoke: vi.fn(),
  };
}

vi.mock('../../src/common', () => ({
  ipcBridge: {
    conversation: {
      create: makeChannel('create'),
      createWithConversation: makeChannel('createWithConversation'),
      get: makeChannel('get'),
      getAssociateConversation: makeChannel('getAssociateConversation'),
      remove: makeChannel('remove'),
      update: makeChannel('update'),
      reset: makeChannel('reset'),
      stop: makeChannel('stop'),
      sendMessage: makeChannel('sendMessage'),
      getSlashCommands: makeChannel('getSlashCommands'),
      reloadContext: makeChannel('reloadContext'),
      getWorkspace: makeChannel('getWorkspace'),
      responseSearchWorkSpace: makeChannel('responseSearchWorkSpace'),
      confirmation: {
        confirm: makeChannel('confirmation.confirm'),
        list: makeChannel('confirmation.list'),
      },
      approval: {
        check: makeChannel('approval.check'),
      },
      listChanged: { emit: vi.fn() },
    },
    openclawConversation: {
      getRuntime: makeChannel('openclawConversation.getRuntime'),
    },
  },
}));

vi.mock('../../src/process/utils/initStorage', () => ({
  ProcessChat: { get: vi.fn(async () => []) },
  getSkillsDir: vi.fn(() => '/skills'),
}));

vi.mock('../../src/process/bridge/migrationUtils', () => ({
  migrateConversationToDatabase: vi.fn(async () => {}),
}));

vi.mock('../../src/agent/gemini', () => ({
  GeminiAgent: { buildFileServer: vi.fn(() => ({})) },
  GeminiApprovalStore: { createKeysFromConfirmation: vi.fn(() => []) },
}));

vi.mock('../../src/process/utils', () => ({
  copyFilesToDirectory: vi.fn(async () => []),
  readDirectoryRecursive: vi.fn(async () => null),
}));

vi.mock('../../src/process/utils/openclawUtils', () => ({
  computeOpenClawIdentityHash: vi.fn(async () => 'hash'),
}));

vi.mock('../../src/process/task/agentUtils', () => ({
  prepareFirstMessage: vi.fn(async (msg: string) => msg),
}));

vi.mock('../../src/process/bridge/cliHistoryBridge', () => ({
  isSessionIdle: vi.fn(async () => false),
}));

vi.mock('../../src/process/utils/mainLogger', () => ({
  mainLog: vi.fn(),
  mainWarn: vi.fn(),
  mainError: vi.fn(),
}));

import { initConversationBridge } from '../../src/process/bridge/conversationBridge';
import type { IConversationService } from '../../src/process/services/IConversationService';
import type { IWorkerTaskManager } from '../../src/process/task/IWorkerTaskManager';
import type { TChatConversation } from '../../src/common/config/storage';
import { isSessionIdle } from '../../src/process/bridge/cliHistoryBridge';
import { ProcessChat } from '../../src/process/utils/initStorage';

function makeService(overrides?: Partial<IConversationService>): IConversationService {
  return {
    createConversation: vi.fn(),
    deleteConversation: vi.fn(),
    updateConversation: vi.fn(),
    getConversation: vi.fn(async () => undefined),
    createWithMigration: vi.fn(),
    listAllConversations: vi.fn(async () => []),
    ...overrides,
  };
}

function makeTaskManager(overrides?: Partial<IWorkerTaskManager>): IWorkerTaskManager {
  return {
    getTask: vi.fn(() => undefined),
    getOrBuildTask: vi.fn(async () => {
      throw new Error('not found');
    }),
    addTask: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    listTasks: vi.fn(() => []),
    ...overrides,
  };
}

function makeConversation(id: string, extra?: Record<string, unknown>): TChatConversation {
  return { id, type: 'acp', name: 'test', extra: { workspace: '/ws', ...extra } } as unknown as TChatConversation;
}

describe('ACP stale running state recovery', () => {
  let service: IConversationService;
  let taskManager: IWorkerTaskManager;

  beforeEach(() => {
    vi.clearAllMocks();
    service = makeService();
    taskManager = makeTaskManager();
    initConversationBridge(service, taskManager);
  });

  describe('conversationBridge.get — liveness check', () => {
    it('returns finished when task is running but agent is disconnected', async () => {
      const conv = makeConversation('c1');
      vi.mocked(service.getConversation).mockResolvedValue(conv);

      const disconnectedTask = {
        status: 'running' as const,
        agent: { isConnected: false },
      };
      vi.mocked(taskManager.getTask).mockReturnValue(disconnectedTask as any);

      const result = await handlers['get']({ id: 'c1' });

      expect(result.status).toBe('finished');
      expect(taskManager.kill).toHaveBeenCalledWith('c1');
    });

    it('returns running when task is running and agent is connected', async () => {
      const conv = makeConversation('c1');
      vi.mocked(service.getConversation).mockResolvedValue(conv);

      const connectedTask = {
        status: 'running' as const,
        agent: { isConnected: true },
      };
      vi.mocked(taskManager.getTask).mockReturnValue(connectedTask as any);

      const result = await handlers['get']({ id: 'c1' });

      expect(result.status).toBe('running');
      expect(taskManager.kill).not.toHaveBeenCalled();
    });

    it('returns finished when task is running, agent connected, but JSONL shows idle', async () => {
      const conv = makeConversation('c1', { acpSessionId: 'session-123', backend: 'claude' });
      vi.mocked(service.getConversation).mockResolvedValue(conv);

      const connectedTask = {
        status: 'running' as const,
        agent: { isConnected: true },
      };
      vi.mocked(taskManager.getTask).mockReturnValue(connectedTask as any);
      vi.mocked(isSessionIdle).mockResolvedValue(true);

      const result = await handlers['get']({ id: 'c1' });

      expect(result.status).toBe('finished');
      expect(taskManager.kill).toHaveBeenCalledWith('c1');
      expect(isSessionIdle).toHaveBeenCalledWith('session-123', 'claude');
    });

    it('returns running when JSONL does not show idle', async () => {
      const conv = makeConversation('c1', { acpSessionId: 'session-123', backend: 'claude' });
      vi.mocked(service.getConversation).mockResolvedValue(conv);

      const connectedTask = {
        status: 'running' as const,
        agent: { isConnected: true },
      };
      vi.mocked(taskManager.getTask).mockReturnValue(connectedTask as any);
      vi.mocked(isSessionIdle).mockResolvedValue(false);

      const result = await handlers['get']({ id: 'c1' });

      expect(result.status).toBe('running');
      expect(taskManager.kill).not.toHaveBeenCalled();
    });

    it('returns finished when no task exists', async () => {
      const conv = makeConversation('c1');
      vi.mocked(service.getConversation).mockResolvedValue(conv);
      vi.mocked(taskManager.getTask).mockReturnValue(undefined);

      const result = await handlers['get']({ id: 'c1' });

      expect(result.status).toBe('finished');
    });
  });

  describe('conversationBridge.sendMessage — failure propagation', () => {
    it('propagates agent failure when task.sendMessage returns { success: false }', async () => {
      const failingTask = {
        type: 'acp' as const,
        status: 'running' as const,
        workspace: '/ws',
        conversation_id: 'c1',
        sendMessage: vi.fn(async () => ({ success: false, msg: 'LLM request timed out' })),
        stop: vi.fn(),
        kill: vi.fn(),
        confirm: vi.fn(),
        getConfirmations: vi.fn(() => []),
      };
      vi.mocked(taskManager.getOrBuildTask).mockResolvedValue(failingTask as any);

      const result = await handlers['sendMessage']({
        conversation_id: 'c1',
        input: 'hello',
      });

      expect(result.success).toBe(false);
      expect(result.msg).toBe('LLM request timed out');
    });

    it('returns success when task.sendMessage succeeds', async () => {
      const successTask = {
        type: 'acp' as const,
        status: 'running' as const,
        workspace: '/ws',
        conversation_id: 'c1',
        sendMessage: vi.fn(async () => ({ success: true })),
        stop: vi.fn(),
        kill: vi.fn(),
        confirm: vi.fn(),
        getConfirmations: vi.fn(() => []),
      };
      vi.mocked(taskManager.getOrBuildTask).mockResolvedValue(successTask as any);

      const result = await handlers['sendMessage']({
        conversation_id: 'c1',
        input: 'hello',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('conversationBridge.get — file-history fallback path', () => {
    it('recovers stale running task from file-history when agent is disconnected', async () => {
      // Simulate: not in DB, found in file storage
      vi.mocked(service.getConversation).mockResolvedValue(undefined);
      const fileConv = makeConversation('c1');
      vi.mocked(ProcessChat.get).mockResolvedValue([fileConv] as any);

      const disconnectedTask = {
        status: 'running' as const,
        agent: { isConnected: false },
      };
      vi.mocked(taskManager.getTask).mockReturnValue(disconnectedTask as any);

      const result = await handlers['get']({ id: 'c1' });

      expect(result.status).toBe('finished');
      expect(taskManager.kill).toHaveBeenCalledWith('c1');
    });

    it('recovers stale running task from file-history when JSONL shows idle', async () => {
      vi.mocked(service.getConversation).mockResolvedValue(undefined);
      const fileConv = makeConversation('c1', { acpSessionId: 'session-456', backend: 'claude' });
      vi.mocked(ProcessChat.get).mockResolvedValue([fileConv] as any);

      const connectedTask = {
        status: 'running' as const,
        agent: { isConnected: true },
      };
      vi.mocked(taskManager.getTask).mockReturnValue(connectedTask as any);
      vi.mocked(isSessionIdle).mockResolvedValue(true);

      const result = await handlers['get']({ id: 'c1' });

      expect(result.status).toBe('finished');
      expect(taskManager.kill).toHaveBeenCalledWith('c1');
      expect(isSessionIdle).toHaveBeenCalledWith('session-456', 'claude');
    });
  });
});
