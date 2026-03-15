/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getReadOnlyConversationStatusSnapshot = vi.fn(() => null);

vi.mock('@process/WorkerManage', () => ({
  default: {
    getDebugInfo: vi.fn(() => ({
      totalTasks: 0,
      tasks: [],
    })),
  },
}));

vi.mock('@process/services/cron/CronBusyGuard', () => ({
  cronBusyGuard: {
    getAllStates: vi.fn(() => new Map()),
  },
}));

vi.mock('@process/services/ConversationTurnCompletionService', () => ({
  ConversationTurnCompletionService: {
    getInstance: () => ({
      getDebugState: () => ({
        emittedKeyCount: 0,
        inFlightCount: 0,
        emittedKeys: [],
        inFlightSessionIds: [],
      }),
    }),
  },
  formatStatusLastMessage: vi.fn((message) => message),
  getConversationStatusSnapshot: vi.fn(() => null),
  getReadOnlyConversationStatusSnapshot,
}));

vi.mock('@process/message', () => ({
  getConversationMessageCacheStats: vi.fn(() => ({
    size: 0,
    conversations: [],
  })),
}));

vi.mock('@process/database', () => ({
  getDatabase: vi.fn(() => ({
    getUserConversations: vi.fn(() => ({
      total: 0,
    })),
  })),
}));

describe('ApiDiagnosticsService', () => {
  beforeEach(() => {
    getReadOnlyConversationStatusSnapshot.mockReset();
    getReadOnlyConversationStatusSnapshot.mockReturnValue(null);
  });

  it('applies runtime config updates and normalizes values', async () => {
    const { ApiDiagnosticsService } = await import('../../src/process/services/ApiDiagnosticsService');

    const service = new ApiDiagnosticsService({
      enabled: false,
      outputDir: 'logs/diagnostics',
      sampleIntervalMs: 3000,
    });

    expect(service.getConfig()).toEqual({
      enabled: false,
      outputDir: path.resolve('logs/diagnostics'),
      sampleIntervalMs: 3000,
    });

    service.updateConfig({
      enabled: true,
      outputDir: '',
      sampleIntervalMs: 20,
    });

    expect(service.getConfig().enabled).toBe(true);
    expect(service.getConfig().sampleIntervalMs).toBe(1000);
    expect(path.isAbsolute(service.getConfig().outputDir)).toBe(true);
  });

  it('captures only when enabled and respects sample throttling', async () => {
    const { ApiDiagnosticsService } = await import('../../src/process/services/ApiDiagnosticsService');

    const service = new ApiDiagnosticsService({
      enabled: false,
      outputDir: 'logs/diagnostics',
      sampleIntervalMs: 60000,
    });

    expect(
      service.captureRouteSample({
        route: '/status',
        reason: 'poll',
        persist: false,
      })
    ).toEqual({
      enabled: false,
      recorded: false,
    });

    service.updateConfig({ enabled: true });
    vi.spyOn(service, 'createSnapshot').mockReturnValue({
      timestamp: '2026-03-14T00:00:00.000Z',
      route: '/status',
      reason: 'poll',
      sessionId: null,
      process: {
        pid: 1,
      },
    } as never);

    const first = service.captureRouteSample({
      route: '/status',
      reason: 'poll',
      persist: false,
    });

    const second = service.captureRouteSample({
      route: '/status',
      reason: 'poll',
      persist: false,
    });

    expect(first.enabled).toBe(true);
    expect(first.recorded).toBe(true);
    expect(first.snapshot).toBeTruthy();
    expect(service.getRecentCaptures()).toHaveLength(1);
    expect(service.getRecentCaptures()[0]?.snapshot).toEqual(first.snapshot);
    expect(second).toEqual({
      enabled: true,
      recorded: false,
    });
  });

  it('allows manual capture when automatic sampling is disabled', async () => {
    const { ApiDiagnosticsService } = await import('../../src/process/services/ApiDiagnosticsService');

    const service = new ApiDiagnosticsService({
      enabled: false,
      outputDir: 'logs/diagnostics',
      sampleIntervalMs: 60000,
    });

    vi.spyOn(service, 'createSnapshot').mockReturnValue({
      timestamp: '2026-03-14T00:00:00.000Z',
      route: '/status',
      reason: 'manual',
      sessionId: null,
      process: {
        pid: 1,
      },
    } as never);

    const capture = service.captureRouteSample({
      route: '/status',
      reason: 'manual',
      persist: false,
      force: true,
      allowWhenDisabled: true,
    });

    expect(capture.enabled).toBe(false);
    expect(capture.recorded).toBe(true);
    expect(capture.snapshot).toBeTruthy();
    expect(service.getRecentCaptures()).toHaveLength(1);
  });

  it('persists diagnostics config to a JSON file', async () => {
    const { ApiDiagnosticsService } = await import('../../src/process/services/ApiDiagnosticsService');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-api-diagnostics-'));
    const configFilePath = path.join(tempDir, 'api-diagnostics-config.json');

    const service = new ApiDiagnosticsService({
      configFilePath,
      enabled: false,
      outputDir: 'logs/diagnostics',
      sampleIntervalMs: 60000,
    });

    service.updateConfig({
      enabled: true,
      outputDir: 'logs/persisted',
      sampleIntervalMs: 15000,
    });

    await vi.waitFor(() => {
      const reloaded = new ApiDiagnosticsService({
        configFilePath,
      });

      expect(reloaded.getConfig()).toEqual({
        enabled: true,
        outputDir: path.resolve('logs/persisted'),
        sampleIntervalMs: 15000,
      });
    });
  });

  it('summarizes large last-message payloads in diagnostics snapshots', async () => {
    const { ApiDiagnosticsService } = await import('../../src/process/services/ApiDiagnosticsService');

    getReadOnlyConversationStatusSnapshot.mockReturnValue({
      sessionId: 'session-1',
      conversation: {
        id: 'session-1',
        name: 'Memory repro',
        type: 'acp',
        source: 'api',
        status: 'finished',
        modifyTime: 1,
        extra: {
          workspace: 'E:/workspace',
        },
      },
      status: 'finished',
      state: 'ai_waiting_input',
      detail: 'AI is waiting for input',
      canSendMessage: true,
      runtime: {
        hasTask: true,
        taskStatus: 'finished',
        isProcessing: false,
        pendingConfirmations: 0,
        dbStatus: 'finished',
      },
      lastMessage: {
        id: 'msg-1',
        type: 'text',
        position: 'left',
        content: {
          content: 'x'.repeat(512),
          patch: 'y'.repeat(512),
        },
        createdAt: 1,
      },
    });

    const service = new ApiDiagnosticsService({
      enabled: true,
      outputDir: 'logs/diagnostics',
      sampleIntervalMs: 60000,
    });

    const snapshot = service.createSnapshot({
      route: '/status',
      reason: 'poll',
      sessionId: 'session-1',
    });

    expect(snapshot.session?.lastMessage?.content).toContain('x');
    expect(snapshot.session?.lastMessage?.content?.length).toBeLessThanOrEqual(243);
    expect(snapshot.session?.lastMessage?.contentSummary).toEqual(
      expect.objectContaining({
        kind: 'object',
        serializedLength: expect.any(Number),
        truncated: true,
      })
    );
  });
});
