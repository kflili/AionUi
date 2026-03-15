/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const emitSpy = vi.fn();
let flushed = false;
const getTaskById = vi.fn(() => undefined);
const peekTaskById = vi.fn(() => undefined);

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      turnCompleted: {
        emit: emitSpy,
      },
    },
  },
}));

vi.mock('@process/message', () => ({
  flushConversationMessages: vi.fn(async () => {
    flushed = true;
  }),
}));

vi.mock('@process/WorkerManage', () => ({
  default: {
    getTaskById,
    peekTaskById,
  },
}));

vi.mock('@process/services/cron/CronBusyGuard', () => ({
  cronBusyGuard: {
    isProcessing: vi.fn(() => false),
  },
}));

vi.mock('@process/database', () => ({
  getDatabase: () => ({
    getConversation: vi.fn(() => ({
      success: true,
      data: {
        id: 'session-1',
        type: 'gemini',
        status: 'finished',
        extra: {
          workspace: 'E:/workspace',
        },
        model: {
          platform: 'openai',
          name: 'OpenAI',
          useModel: 'gpt-4o-mini',
        },
      },
    })),
    getConversationMessages: vi.fn(() => ({
      data: [
        flushed
          ? {
              id: 'assistant-1',
              type: 'text',
              position: 'left',
              content: { content: 'done' },
              createdAt: 1,
            }
          : {
              id: 'user-1',
              type: 'text',
              position: 'right',
              content: { content: 'hello' },
              createdAt: 0,
            },
      ],
    })),
  }),
}));

describe('ConversationTurnCompletionService', () => {
  beforeEach(() => {
    flushed = false;
    emitSpy.mockReset();
    getTaskById.mockReset();
    getTaskById.mockReturnValue(undefined);
    peekTaskById.mockReset();
    peekTaskById.mockReturnValue(undefined);
    vi.resetModules();
  });

  it('flushes pending messages before emitting turn completion', async () => {
    const { ConversationTurnCompletionService } = await import('../../src/process/services/ConversationTurnCompletionService');

    await ConversationTurnCompletionService.getInstance().notifyPotentialCompletion('session-1');

    expect(flushed).toBe(true);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        state: 'stopped',
        lastMessage: expect.objectContaining({
          id: 'assistant-1',
        }),
      })
    );
  });

  it('supports read-only status snapshots without touching task liveness', async () => {
    const task = {
      status: 'finished',
      getConfirmations: () => [],
    };
    peekTaskById.mockReturnValue(task);

    const { getConversationStatusSnapshot } = await import('../../src/process/services/ConversationTurnCompletionService');

    const snapshot = getConversationStatusSnapshot('session-1', {
      touchTask: false,
    });

    expect(snapshot).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        status: 'finished',
        state: 'ai_waiting_input',
      })
    );
    expect(getTaskById).not.toHaveBeenCalled();
    expect(peekTaskById).toHaveBeenCalledWith('session-1');
  });
});
