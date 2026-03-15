/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const releaseConversationMessageCache = vi.fn(() => Promise.resolve());
const getConversation = vi.fn();
const removeBusyState = vi.fn();
const forgetSession = vi.fn();

vi.mock('../../src/process/initStorage', () => ({
  ProcessChat: {
    get: vi.fn(async () => []),
  },
}));

vi.mock('../../src/process/database/export', () => ({
  getDatabase: vi.fn(() => ({
    getConversation,
  })),
}));

vi.mock('../../src/process/message', () => ({
  releaseConversationMessageCache,
}));

vi.mock('../../src/process/services/cron/CronBusyGuard', () => ({
  cronBusyGuard: {
    isProcessing: vi.fn(() => false),
    remove: removeBusyState,
  },
}));

vi.mock('../../src/process/services/ConversationTurnCompletionService', () => ({
  ConversationTurnCompletionService: {
    getInstance: () => ({
      forgetSession,
    }),
  },
}));

vi.mock('../../src/process/task/AcpAgentManager', () => ({
  default: class AcpAgentManager {},
}));

vi.mock('../../src/process/task/GeminiAgentManager', () => ({
  GeminiAgentManager: class GeminiAgentManager {},
}));

vi.mock('../../src/process/task/NanoBotAgentManager', () => ({
  default: class NanoBotAgentManager {},
}));

vi.mock('../../src/process/task/OpenClawAgentManager', () => ({
  default: class OpenClawAgentManager {},
}));

vi.mock('../../src/agent/codex', () => ({
  CodexAgentManager: class CodexAgentManager {},
}));

describe('WorkerManage.kill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T00:00:00.000Z'));
    releaseConversationMessageCache.mockReset();
    releaseConversationMessageCache.mockResolvedValue(undefined);
    removeBusyState.mockReset();
    forgetSession.mockReset();
    getConversation.mockReset();
    getConversation.mockImplementation((id: string) => {
      if (id === 'finished-1') {
        return {
          success: true,
          data: {
            id,
            source: 'api',
            extra: {},
          },
        };
      }

      if (id === 'running-1') {
        return {
          success: true,
          data: {
            id,
            source: 'api',
            extra: {},
          },
        };
      }

      return {
        success: true,
        data: {
          id,
          source: 'aionui',
          extra: {},
        },
      };
    });
    vi.resetModules();
  });

  afterEach(async () => {
    const { default: WorkerManage } = await import('../../src/process/WorkerManage');
    WorkerManage.clear();
    vi.useRealTimers();
  });

  it('destroys runtime state and clears related caches explicitly on kill', async () => {
    const { default: WorkerManage } = await import('../../src/process/WorkerManage');

    const finishedTask = {
      type: 'gemini',
      status: 'finished',
      getConfirmations: () => [],
      kill: vi.fn(),
    } as unknown as {
      type: 'gemini';
      status: 'finished';
      getConfirmations: () => [];
      kill: () => void;
    };
    WorkerManage.addTask('finished-1', finishedTask);
    WorkerManage.kill('finished-1');

    expect(finishedTask.kill).toHaveBeenCalledTimes(1);
    expect(WorkerManage.getTaskById('finished-1')).toBeUndefined();
    expect(releaseConversationMessageCache).toHaveBeenCalledWith('finished-1', {
      persistPending: true,
    });
    expect(removeBusyState).toHaveBeenCalledWith('finished-1');
    expect(forgetSession).toHaveBeenCalledWith('finished-1');
  });
});
