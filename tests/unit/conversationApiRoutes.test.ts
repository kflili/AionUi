/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type MinimalConversation = {
  id: string;
  name: string;
  type: 'gemini' | 'acp' | 'codex';
  source: string;
  status: 'pending' | 'running' | 'finished';
  createTime: number;
  modifyTime: number;
  extra: Record<string, unknown>;
  model?: {
    id: string;
    platform: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    useModel: string;
  };
};

const workerManageGetTaskById = vi.fn(() => undefined);
const workerManageListTasks = vi.fn(() => []);
const workerManageKillAndDrain = vi.fn(async () => undefined);
const dbGetUserConversations = vi.fn(() => ({ data: [] }));
const dbGetUserConversationsByStatuses = vi.fn(() => ({ success: true, data: [] }));
const dbGetConversation = vi.fn(() => ({ success: false, data: undefined }));
const cronBusyGuardGetAllStates = vi.fn(() => new Map());

vi.mock('../../src/webserver/middleware/apiAuthMiddleware', () => ({
  validateApiToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../src/webserver/middleware/security', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('@process/services/conversationService', () => ({
  ConversationService: {},
}));

vi.mock('@process/WorkerManage', () => ({
  default: {
    getTaskById: workerManageGetTaskById,
    listTasks: workerManageListTasks,
    killAndDrain: workerManageKillAndDrain,
  },
}));

vi.mock('@process/database', () => ({
  getDatabase: vi.fn(() => ({
    getUserConversations: dbGetUserConversations,
    getUserConversationsByStatuses: dbGetUserConversationsByStatuses,
    getConversation: dbGetConversation,
  })),
}));

vi.mock('@process/services/cron/CronBusyGuard', () => ({
  cronBusyGuard: {
    isProcessing: vi.fn(() => false),
    getAllStates: cronBusyGuardGetAllStates,
  },
}));

vi.mock('@process/services/ApiDiagnosticsService', () => ({
  apiDiagnosticsService: {
    isEnabled: vi.fn(() => false),
    getConfig: vi.fn(() => ({
      enabled: false,
      outputDir: 'E:/tmp',
      sampleIntervalMs: 60000,
    })),
    captureRouteSample: vi.fn(() => ({
      enabled: false,
      recorded: false,
    })),
  },
}));

vi.mock('@process/services/ConversationTurnCompletionService', () => ({
  getConversationStatusSnapshot: vi.fn(),
  getReadOnlyConversationStatusSnapshot: vi.fn(),
  formatStatusLastMessage: vi.fn((message) =>
    message
      ? {
          id: message.id,
          type: message.type,
          content: message.content,
          status: message.status ?? null,
          createdAt: message.createdAt ?? 0,
        }
      : undefined
  ),
}));

vi.mock('@/common', () => ({
  ipcBridge: {},
}));

vi.mock('@/common/utils', () => ({
  uuid: vi.fn(() => 'uuid-1'),
}));

vi.mock('@/common/utils/conversationTitle', () => ({
  buildConversationTitleFromMessage: vi.fn(() => 'title'),
}));

describe('conversationApiRoutes helpers', () => {
  beforeEach(() => {
    workerManageGetTaskById.mockReset();
    workerManageGetTaskById.mockReturnValue(undefined);
    workerManageListTasks.mockReset();
    workerManageListTasks.mockReturnValue([]);
    workerManageKillAndDrain.mockReset();
    workerManageKillAndDrain.mockResolvedValue(undefined);
    dbGetUserConversations.mockReset();
    dbGetUserConversations.mockReturnValue({ data: [] });
    dbGetUserConversationsByStatuses.mockReset();
    dbGetUserConversationsByStatuses.mockReturnValue({ success: true, data: [] });
    dbGetConversation.mockReset();
    dbGetConversation.mockReturnValue({ success: false, data: undefined });
    cronBusyGuardGetAllStates.mockReset();
    cronBusyGuardGetAllStates.mockReturnValue(new Map());
  });

  it('recognizes active snapshots from runtime and non-stopped states', async () => {
    const { isConversationStatusActive } = await import('../../src/webserver/routes/conversationApiRoutes');

    expect(
      isConversationStatusActive({
        status: 'finished',
        state: 'ai_waiting_input',
        runtime: {
          hasTask: true,
          taskStatus: 'finished',
          isProcessing: false,
          pendingConfirmations: 0,
        },
      })
    ).toBe(false);

    expect(
      isConversationStatusActive({
        status: 'running',
        state: 'ai_generating',
        runtime: {
          hasTask: true,
          taskStatus: 'running',
          isProcessing: true,
          pendingConfirmations: 0,
        },
      })
    ).toBe(true);

    expect(
      isConversationStatusActive({
        status: 'finished',
        state: 'stopped',
        runtime: {
          hasTask: false,
          taskStatus: 'finished',
          isProcessing: false,
          pendingConfirmations: 0,
        },
      })
    ).toBe(false);
  });

  it('builds a sorted generating conversation status list by default', async () => {
    const { buildConversationStatusList } = await import('../../src/webserver/routes/conversationApiRoutes');

    const conversations: MinimalConversation[] = [
      {
        id: 'conv-stopped',
        name: 'Stopped',
        type: 'codex',
        source: 'api',
        status: 'finished',
        createTime: 10,
        modifyTime: 10,
        extra: {},
      },
      {
        id: 'conv-waiting',
        name: 'Waiting',
        type: 'gemini',
        source: 'api',
        status: 'finished',
        createTime: 20,
        modifyTime: 20,
        extra: { workspace: 'E:/workspace' },
        model: {
          id: 'model-1',
          platform: 'openai',
          name: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: '***',
          useModel: 'gpt-4o-mini',
        },
      },
      {
        id: 'conv-running',
        name: 'Running',
        type: 'acp',
        source: 'api',
        status: 'running',
        createTime: 30,
        modifyTime: 30,
        extra: { backend: 'codex' },
      },
    ];

    const getSnapshot = vi.fn((sessionId: string) => {
      if (sessionId === 'conv-stopped') {
        return {
          sessionId,
          conversation: conversations[0],
          status: 'finished',
          state: 'stopped',
          detail: 'Conversation is stopped',
          canSendMessage: true,
          runtime: {
            hasTask: false,
            isProcessing: false,
            pendingConfirmations: 0,
            dbStatus: 'finished',
          },
          lastMessage: null,
        };
      }

      if (sessionId === 'conv-waiting') {
        return {
          sessionId,
          conversation: conversations[1],
          status: 'finished',
          state: 'ai_waiting_input',
          detail: 'AI is waiting for input',
          canSendMessage: true,
          runtime: {
            hasTask: true,
            isProcessing: false,
            pendingConfirmations: 0,
            dbStatus: 'finished',
          },
          lastMessage: {
            id: 'msg-1',
            type: 'text',
            content: { content: 'done' },
            createdAt: 100,
          },
        };
      }

      return {
        sessionId,
        conversation: conversations[2],
        status: 'running',
        state: 'ai_generating',
        detail: 'AI is generating response',
        canSendMessage: false,
        runtime: {
          hasTask: true,
          isProcessing: true,
          pendingConfirmations: 0,
          dbStatus: 'running',
        },
        lastMessage: {
          id: 'msg-2',
          type: 'text',
          content: { content: 'working' },
          createdAt: 200,
        },
      };
    });

    const result = buildConversationStatusList(conversations as never, undefined, getSnapshot);

    expect(result).toHaveLength(1);
    expect(result.map((item) => item.sessionId)).toEqual(['conv-running']);
    expect(result[0]).toEqual(
      expect.objectContaining({
        sessionId: 'conv-running',
        cli: 'codex',
        status: 'running',
        state: 'ai_generating',
        updatedAt: 30,
      })
    );
  });

  it('supports scope and field filters for status list queries', async () => {
    const { buildConversationStatusList } = await import('../../src/webserver/routes/conversationApiRoutes');

    const conversations: MinimalConversation[] = [
      {
        id: 'conv-active',
        name: 'Active',
        type: 'gemini',
        source: 'api',
        status: 'finished',
        createTime: 10,
        modifyTime: 10,
        extra: { workspace: 'E:/workspace' },
        model: {
          id: 'model-1',
          platform: 'openai',
          name: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: '***',
          useModel: 'gpt-4o-mini',
        },
      },
      {
        id: 'conv-running',
        name: 'Running',
        type: 'acp',
        source: 'api',
        status: 'running',
        createTime: 30,
        modifyTime: 30,
        extra: { backend: 'codex' },
      },
      {
        id: 'conv-other-source',
        name: 'Other Source',
        type: 'codex',
        source: 'aionui',
        status: 'running',
        createTime: 40,
        modifyTime: 40,
        extra: {},
      },
    ];

    const getSnapshot = vi.fn((sessionId: string) => {
      if (sessionId === 'conv-active') {
        return {
          sessionId,
          conversation: conversations[0],
          status: 'finished',
          state: 'ai_waiting_input',
          detail: 'AI is waiting for input',
          canSendMessage: true,
          runtime: {
            hasTask: true,
            isProcessing: false,
            pendingConfirmations: 0,
            dbStatus: 'finished',
          },
          lastMessage: {
            id: 'msg-1',
            type: 'text',
            content: { content: 'done' },
            createdAt: 100,
          },
        };
      }

      if (sessionId === 'conv-running') {
        return {
          sessionId,
          conversation: conversations[1],
          status: 'running',
          state: 'ai_generating',
          detail: 'AI is generating response',
          canSendMessage: false,
          runtime: {
            hasTask: true,
            isProcessing: true,
            pendingConfirmations: 0,
            dbStatus: 'running',
          },
          lastMessage: {
            id: 'msg-2',
            type: 'text',
            content: { content: 'working' },
            createdAt: 200,
          },
        };
      }

      return {
        sessionId,
        conversation: conversations[2],
        status: 'running',
        state: 'ai_waiting_confirmation',
        detail: 'Waiting for tool confirmation',
        canSendMessage: false,
        runtime: {
          hasTask: true,
          isProcessing: false,
          pendingConfirmations: 1,
          dbStatus: 'running',
        },
        lastMessage: {
          id: 'msg-3',
          type: 'text',
          content: { content: 'confirm' },
          createdAt: 300,
        },
      };
    });

    const activeOnly = buildConversationStatusList(conversations as never, { scope: 'active' }, getSnapshot);
    expect(activeOnly.map((item) => item.sessionId)).toEqual(['conv-other-source', 'conv-running']);

    const apiGenerating = buildConversationStatusList(
      conversations as never,
      {
        scope: 'generating',
        source: ['api'],
        canSendMessage: false,
        type: ['acp'],
      },
      getSnapshot
    );

    expect(apiGenerating).toHaveLength(1);
    expect(apiGenerating[0]).toEqual(
      expect.objectContaining({
        sessionId: 'conv-running',
        cli: 'codex',
        source: 'api',
        type: 'acp',
        canSendMessage: false,
      })
    );

    const cliFiltered = buildConversationStatusList(
      conversations as never,
      {
        scope: 'active',
        cli: ['codex'],
      },
      getSnapshot
    );

    expect(cliFiltered.map((item) => item.sessionId)).toEqual(['conv-running']);
  });

  it('collects runtime candidate ids without including idle busy-guard entries', async () => {
    const { collectConversationStatusCandidateIds } = await import('../../src/webserver/routes/conversationApiRoutes');

    const result = collectConversationStatusCandidateIds(
      [{ id: 'task-1' }, { id: 'task-2' }],
      new Map([
        ['busy-1', { isProcessing: true }],
        ['idle-1', { isProcessing: false }],
      ])
    );

    expect(result).toEqual(['task-1', 'task-2', 'busy-1']);
  });

  it('resolves active status list conversations from runtime candidates instead of scanning full history', async () => {
    const { getConversationStatusListConversations } = await import('../../src/webserver/routes/conversationApiRoutes');

    const db = {
      getConversation: vi.fn((conversationId: string) => {
        if (conversationId === 'conv-runtime') {
          return {
            success: true,
            data: {
              id: 'conv-runtime',
              name: 'Runtime',
              type: 'codex',
              source: 'api',
              status: 'finished',
              createTime: 100,
              modifyTime: 300,
              extra: {},
            },
          };
        }

        return {
          success: false,
          data: undefined,
        };
      }),
      getUserConversations: vi.fn(() => {
        throw new Error('full history scan should not be used for active scope');
      }),
      getUserConversationsByStatuses: vi.fn(() => ({
        success: true,
        data: [
          {
            id: 'conv-running',
            name: 'Running',
            type: 'gemini',
            source: 'api',
            status: 'running',
            createTime: 50,
            modifyTime: 200,
            extra: {},
          },
        ],
      })),
    };

    const result = getConversationStatusListConversations('active', {
      db: db as never,
      runtimeCandidateIds: ['conv-runtime'],
    });

    expect(db.getUserConversationsByStatuses).toHaveBeenCalledWith(['pending', 'running'], undefined, 1000);
    expect(db.getUserConversations).not.toHaveBeenCalled();
    expect(result.map((conversation) => conversation.id)).toEqual(['conv-runtime', 'conv-running']);
  });

  it('builds conversation usage payload with summary and paginated replies', async () => {
    const { buildConversationUsageResponse } = await import('../../src/webserver/routes/conversationApiRoutes');

    const conversation: MinimalConversation = {
      id: 'conv-usage',
      name: 'Usage',
      type: 'acp',
      source: 'api',
      status: 'finished',
      createTime: 100,
      modifyTime: 200,
      extra: { backend: 'claude' },
    };

    const result = buildConversationUsageResponse('conv-usage', conversation as never, {
      summary: {
        conversationId: 'conv-usage',
        backend: 'claude',
        replyCount: 2,
        totalInputTokens: 1200,
        totalOutputTokens: 300,
        totalCachedReadTokens: 0,
        totalCachedWriteTokens: 0,
        totalThoughtTokens: 50,
        totalTokens: 1500,
        latestContextUsed: 8000,
        latestContextSize: 200000,
        latestSessionCostAmount: 0.23,
        latestSessionCostCurrency: 'USD',
        lastReplyIndex: 2,
        lastRecordedAt: 500,
      },
      usagePage: {
        data: [
          {
            id: 'usage-2',
            conversationId: 'conv-usage',
            backend: 'claude',
            replyIndex: 2,
            assistantMessageId: 'msg-2',
            inputTokens: 700,
            outputTokens: 180,
            cachedReadTokens: 0,
            cachedWriteTokens: 0,
            thoughtTokens: 20,
            totalTokens: 880,
            contextUsed: 8000,
            contextSize: 200000,
            sessionCostAmount: 0.23,
            sessionCostCurrency: 'USD',
            createdAt: 500,
            updatedAt: 500,
          },
        ],
        total: 2,
        page: 0,
        pageSize: 1,
        hasMore: true,
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        sessionId: 'conv-usage',
        conversationType: 'acp',
        backend: 'claude',
        range: {},
        total: 2,
        page: 0,
        pageSize: 1,
        hasMore: true,
      })
    );
    expect(result.summary.totalTokens).toBe(1500);
    expect(result.replies[0].replyIndex).toBe(2);
  });

  it('builds batch conversation usage summary payload', async () => {
    const { buildConversationUsageSummaryListResponse } = await import('../../src/webserver/routes/conversationApiRoutes');

    const result = buildConversationUsageSummaryListResponse(
      [
        {
          sessionId: 'conv-usage-1',
          conversationType: 'acp',
          backend: 'claude',
          summary: {
            conversationId: 'conv-usage-1',
            backend: 'claude',
            replyCount: 1,
            totalInputTokens: 100,
            totalOutputTokens: 50,
            totalCachedReadTokens: 0,
            totalCachedWriteTokens: 0,
            totalThoughtTokens: 10,
            totalTokens: 150,
          },
        },
      ],
      ['conv-missing']
    );

    expect(result).toEqual({
      success: true,
      range: {},
      total: 1,
      items: [
        expect.objectContaining({
          sessionId: 'conv-usage-1',
          conversationType: 'acp',
          backend: 'claude',
        }),
      ],
      notFoundSessionIds: ['conv-missing'],
    });
  });

  it('builds usage monitor payload with overall and grouped aggregates', async () => {
    const { buildConversationUsageMonitorResponse } = await import('../../src/webserver/routes/conversationApiRoutes');

    const result = buildConversationUsageMonitorResponse({
      range: {
        startTime: 1741824000000,
        endTime: 1741910400000,
      },
      summary: {
        conversationCount: 3,
        replyCount: 6,
        totalInputTokens: 1800,
        totalOutputTokens: 700,
        totalCachedReadTokens: 100,
        totalCachedWriteTokens: 0,
        totalThoughtTokens: 50,
        totalTokens: 2650,
        firstRecordedAt: 1741824001000,
        lastRecordedAt: 1741910399000,
      },
      groups: {
        byAgent: [
          {
            agent: 'acp',
            summary: {
              conversationCount: 2,
              replyCount: 4,
              totalInputTokens: 1200,
              totalOutputTokens: 500,
              totalCachedReadTokens: 100,
              totalCachedWriteTokens: 0,
              totalThoughtTokens: 50,
              totalTokens: 1850,
              firstRecordedAt: 1741824001000,
              lastRecordedAt: 1741910399000,
            },
          },
        ],
        byBackend: [
          {
            backend: 'claude',
            summary: {
              conversationCount: 2,
              replyCount: 4,
              totalInputTokens: 1200,
              totalOutputTokens: 500,
              totalCachedReadTokens: 100,
              totalCachedWriteTokens: 0,
              totalThoughtTokens: 50,
              totalTokens: 1850,
              firstRecordedAt: 1741824001000,
              lastRecordedAt: 1741910399000,
            },
          },
        ],
        byAgentBackend: [
          {
            agent: 'acp',
            backend: 'claude',
            summary: {
              conversationCount: 2,
              replyCount: 4,
              totalInputTokens: 1200,
              totalOutputTokens: 500,
              totalCachedReadTokens: 100,
              totalCachedWriteTokens: 0,
              totalThoughtTokens: 50,
              totalTokens: 1850,
              firstRecordedAt: 1741824001000,
              lastRecordedAt: 1741910399000,
            },
          },
        ],
      },
    });

    expect(result).toEqual({
      success: true,
      range: {
        startTime: 1741824000000,
        endTime: 1741910400000,
      },
      summary: expect.objectContaining({
        conversationCount: 3,
        totalTokens: 2650,
      }),
      groups: {
        byAgent: [
          expect.objectContaining({
            agent: 'acp',
          }),
        ],
        byBackend: [
          expect.objectContaining({
            backend: 'claude',
          }),
        ],
        byAgentBackend: [
          expect.objectContaining({
            agent: 'acp',
            backend: 'claude',
          }),
        ],
      },
    });
  });
});
