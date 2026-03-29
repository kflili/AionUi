import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn(() => '/tmp') } }));

vi.mock('../../src/common', () => ({
  ipcBridge: {
    cliHistory: {
      resolveSessionFilePath: { provider: vi.fn() },
      getDbPath: { provider: vi.fn() },
      convertSessionToMessages: { provider: vi.fn() },
    },
  },
}));

vi.mock('../../src/process/utils/utils', () => ({
  getDataPath: vi.fn(() => '/tmp'),
  getConfigPath: vi.fn(() => '/tmp'),
}));

vi.mock('../../src/process/services/database/export', () => ({
  getDatabase: vi.fn(() => ({
    deleteConversationMessages: vi.fn(),
    insertMessage: vi.fn(() => ({ success: true })),
  })),
}));

vi.mock('../../src/process/cli-history/converters/claude', () => ({
  convertClaudeJsonl: vi.fn(() => []),
}));

vi.mock('../../src/process/cli-history/converters/copilot', () => ({
  convertCopilotJsonl: vi.fn(() => []),
}));

// Mock os.homedir so resolveClaudeSessionPath looks in our temp dir
let mockHomeDir = '/tmp';
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => mockHomeDir };
});

import { isSessionIdle } from '../../src/process/bridge/cliHistoryBridge';

describe('isSessionIdle', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aionui-test-'));
    mockHomeDir = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns true for a stale session whose last assistant event has end_turn', async () => {
    // Create the Claude session directory structure: ~/.claude/projects/{hash}/{sessionId}.jsonl
    const sessionId = 'session-abc123';
    const projectDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
    await fs.mkdir(projectDir, { recursive: true });
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);

    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] },
      }),
    ];
    await fs.writeFile(sessionFile, lines.join('\n') + '\n');

    // Set mtime to 30s ago to pass the staleness guard
    const pastTime = new Date(Date.now() - 30_000);
    await fs.utimes(sessionFile, pastTime, pastTime);

    const result = await isSessionIdle(sessionId, 'claude');
    expect(result).toBe(true);
  });

  it('returns false when file was modified recently (staleness guard)', async () => {
    const sessionId = 'session-fresh';
    const projectDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
    await fs.mkdir(projectDir, { recursive: true });
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);

    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
      }),
    ];
    await fs.writeFile(sessionFile, lines.join('\n') + '\n');
    // Don't change mtime — file is fresh (just written)

    const result = await isSessionIdle(sessionId, 'claude');
    expect(result).toBe(false);
  });

  it('returns false when last entry is a user message (session processing)', async () => {
    const sessionId = 'session-processing';
    const projectDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
    await fs.mkdir(projectDir, { recursive: true });
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);

    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'earlier turn' }] },
      }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'new question' } }),
    ];
    await fs.writeFile(sessionFile, lines.join('\n') + '\n');
    const pastTime = new Date(Date.now() - 30_000);
    await fs.utimes(sessionFile, pastTime, pastTime);

    const result = await isSessionIdle(sessionId, 'claude');
    expect(result).toBe(false);
  });

  it('returns false for non-existent session', async () => {
    const result = await isSessionIdle('nonexistent-session', 'claude');
    expect(result).toBe(false);
  });
});
