/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadata, SessionSourceProvider } from '@process/cli-history/types';
import type { TChatConversation } from '@/common/config/storage';

// ---------------------------------------------------------------------------
// Mock setup — `vi.hoisted` is required because `vi.mock()` is hoisted to the
// top of the file by Vitest; the factory functions reference these objects, so
// the objects must be hoisted too. Declaring them with plain `const` would
// trigger a `Cannot access 'X' before initialization` ReferenceError.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  const uuidState = { counter: 0 };

  const mockClaude: SessionSourceProvider = {
    id: 'claude_code',
    discoverSessions: vi.fn(async () => []),
    readTranscript: vi.fn(async () => []),
    canResume: vi.fn(() => false),
    buildReference: vi.fn(() => ''),
  };
  const mockCopilot: SessionSourceProvider = {
    id: 'copilot',
    discoverSessions: vi.fn(async () => []),
    readTranscript: vi.fn(async () => []),
    canResume: vi.fn(() => false),
    buildReference: vi.fn(() => ''),
  };

  const dbStore = new Map<string, TChatConversation>();
  const messageStore = new Map<string, unknown[]>();
  const writeFailures = new Set<string>();
  const createSpy = vi.fn();
  const updateSpy = vi.fn();
  const insertMessagesSpy = vi.fn();

  // Switches the mockDatabase methods can read to simulate error returns
  // from the underlying SQLite helpers without throwing.
  const dbFailureSwitches = {
    countFails: false,
    getConvFails: false,
    insertMessagesFails: false,
    updateFailsAfterInsert: false,
  };

  const mockDatabase = {
    createConversation: (conv: TChatConversation) => {
      createSpy(conv);
      if (writeFailures.has(conv.id)) {
        return { success: false, error: 'forced DB write failure' };
      }
      dbStore.set(conv.id, structuredClone(conv));
      return { success: true, data: conv };
    },
    updateImportedConversation: (conv: TChatConversation) => {
      updateSpy(conv);
      if (writeFailures.has(conv.id)) {
        return { success: false, error: 'forced DB update failure' };
      }
      if (dbFailureSwitches.updateFailsAfterInsert) {
        return { success: false, error: 'simulated update failure after insert' };
      }
      if (!dbStore.has(conv.id)) {
        return { success: false, error: 'Conversation not found' };
      }
      dbStore.set(conv.id, structuredClone(conv));
      return { success: true, data: conv };
    },
    getImportedConversationsIncludingHidden: (sources: string[]) => {
      const data = Array.from(dbStore.values()).filter((c) => sources.includes(c.source ?? ''));
      return { success: true, data };
    },
    getConversation: (id: string) => {
      if (dbFailureSwitches.getConvFails) {
        return { success: false, error: 'simulated getConversation failure' };
      }
      const row = dbStore.get(id);
      if (!row) return { success: false, error: 'Conversation not found' };
      return { success: true, data: structuredClone(row) };
    },
    getMessageCountForConversation: (conversationId: string) => {
      if (dbFailureSwitches.countFails) {
        return { success: false, error: 'simulated count failure' };
      }
      const count = messageStore.get(conversationId)?.length ?? 0;
      return { success: true, data: count };
    },
    insertImportedMessages: (conversationId: string, messages: unknown[]) => {
      insertMessagesSpy(conversationId, messages);
      if (dbFailureSwitches.insertMessagesFails) {
        return { success: false, error: 'simulated insert failure' };
      }
      messageStore.set(conversationId, [...messages]);
      return { success: true, data: messages.length };
    },
  };

  const emitSpy = vi.fn();
  const processConfigGet = vi.fn(async () => ({}) as Record<string, unknown>);

  return {
    uuidState,
    mockClaude,
    mockCopilot,
    dbStore,
    messageStore,
    writeFailures,
    createSpy,
    updateSpy,
    insertMessagesSpy,
    dbFailureSwitches,
    mockDatabase,
    emitSpy,
    processConfigGet,
  };
});

vi.mock('@/common/utils', async () => {
  const actual = await vi.importActual<typeof import('@/common/utils')>('@/common/utils');
  return {
    ...actual,
    uuid: () => `uuid-${++hoisted.uuidState.counter}`,
  };
});

vi.mock('@process/cli-history/providers/claude', () => ({
  ClaudeCodeProvider: function MockClaudeCodeProvider() {
    return hoisted.mockClaude;
  },
}));
vi.mock('@process/cli-history/providers/copilot', () => ({
  CopilotProvider: function MockCopilotProvider() {
    return hoisted.mockCopilot;
  },
}));

vi.mock('@process/services/database/export', () => ({
  getDatabase: () => hoisted.mockDatabase,
}));

vi.mock('@process/bridge/conversationEvents', () => ({
  emitConversationListChanged: (...args: unknown[]) => hoisted.emitSpy(...args),
}));

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: {
    get: (...args: unknown[]) => hoisted.processConfigGet(...args),
    set: vi.fn(async () => undefined),
  },
}));

// Convenient local aliases for the hoisted handles.
const mockClaude = hoisted.mockClaude;
const mockCopilot = hoisted.mockCopilot;
const dbStore = hoisted.dbStore;
const messageStore = hoisted.messageStore;
const writeFailures = hoisted.writeFailures;
const createSpy = hoisted.createSpy;
const updateSpy = hoisted.updateSpy;
const insertMessagesSpy = hoisted.insertMessagesSpy;
const dbFailureSwitches = hoisted.dbFailureSwitches;
const mockDatabase = hoisted.mockDatabase;
const emitSpy = hoisted.emitSpy;
const processConfigGet = hoisted.processConfigGet;

// Import AFTER mocks are set up.
import {
  __resetInFlightForTests,
  __setFileIoForTests,
  buildAutoName,
  buildConversationRow,
  dedupKey,
  disableSource,
  discoverAndImport,
  discoverAndImportAll,
  hydrateSession,
  initCliHistoryImporter,
  reenableSource,
} from '@process/cli-history/importer';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ISO = '2026-05-10T12:00:00.000Z';
const ISO_LATER = '2026-05-10T13:00:00.000Z';

function meta(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: 'sess-1',
    title: 'Provider Title',
    firstPrompt: 'Provider First Prompt',
    createdAt: ISO,
    updatedAt: ISO,
    messageCount: 3,
    filePath: '/tmp/sessions/sess-1.jsonl',
    workspace: '/Users/x/projects/demo-project',
    source: 'claude_code',
    ...overrides,
  };
}

function resetState(): void {
  hoisted.uuidState.counter = 0;
  dbStore.clear();
  messageStore.clear();
  writeFailures.clear();
  createSpy.mockClear();
  updateSpy.mockClear();
  insertMessagesSpy.mockClear();
  dbFailureSwitches.countFails = false;
  dbFailureSwitches.getConvFails = false;
  dbFailureSwitches.insertMessagesFails = false;
  dbFailureSwitches.updateFailsAfterInsert = false;
  emitSpy.mockClear();
  processConfigGet.mockReset();
  processConfigGet.mockResolvedValue({});
  (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockReset();
  (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (mockCopilot.discoverSessions as ReturnType<typeof vi.fn>).mockReset();
  (mockCopilot.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  __resetInFlightForTests();
}

beforeEach(resetState);

// ---------------------------------------------------------------------------
// Pure helpers: dedupKey
// ---------------------------------------------------------------------------

describe('dedupKey', () => {
  it('uses acpSessionId when present', () => {
    expect(dedupKey('claude_code', 'sess-1', '/tmp/foo.jsonl')).toBe('claude_code::id:sess-1');
  });
  it('falls back to sourceFilePath when acpSessionId is missing', () => {
    expect(dedupKey('copilot', undefined, '/tmp/foo.jsonl')).toBe('copilot::path:/tmp/foo.jsonl');
  });
  it('returns a non-equal placeholder when both inputs are missing', () => {
    const a = dedupKey('copilot', undefined, undefined);
    const b = dedupKey('copilot', undefined, undefined);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers: buildAutoName
// ---------------------------------------------------------------------------

describe('buildAutoName', () => {
  const NOW = Date.parse('2026-05-12T12:00:00.000Z');

  it('uses Claude Code firstPrompt when present', () => {
    const name = buildAutoName(meta({ source: 'claude_code', firstPrompt: 'fix bug', title: 'summary' }), NOW);
    expect(name).toBe('fix bug · demo-project');
  });

  it('uses Copilot title when present', () => {
    const name = buildAutoName(meta({ source: 'copilot', firstPrompt: 'fp', title: 'copilot summary' }), NOW);
    expect(name).toBe('copilot summary · demo-project');
  });

  it('treats "(untitled)" as missing for Copilot and falls back to relative time', () => {
    const name = buildAutoName(meta({ source: 'copilot', firstPrompt: '', title: '(untitled)', updatedAt: ISO }), NOW);
    expect(name).toMatch(/ago · demo-project$/);
  });

  it('treats UUID-like and raw-filename titles as missing', () => {
    const uuidName = buildAutoName(
      meta({
        source: 'copilot',
        firstPrompt: '',
        title: '550e8400-e29b-41d4-a716-446655440000',
      }),
      NOW
    );
    expect(uuidName).not.toContain('550e8400');
    const fileName = buildAutoName(
      meta({
        source: 'claude_code',
        firstPrompt: '',
        title: 'claude_session_2026_05_10_143022',
      }),
      NOW
    );
    expect(fileName).not.toContain('claude_session_2026');
  });

  it('falls back to "<relative-time> · workspace" when both provider titles are empty', () => {
    const name = buildAutoName(meta({ firstPrompt: '', title: '', updatedAt: ISO }), NOW);
    expect(name).toMatch(/ago · demo-project$/);
  });

  it('truncates titles longer than 60 chars before appending workspace', () => {
    const longTitle = 'a'.repeat(120);
    const name = buildAutoName(meta({ firstPrompt: longTitle }), NOW);
    const [titlePart] = name.split(' · ');
    expect(titlePart.length).toBeLessThanOrEqual(61); // 60 chars + ellipsis
    expect(titlePart.endsWith('…')).toBe(true);
  });

  it('appends workspace basename to the title for disambiguation', () => {
    const name = buildAutoName(meta({ firstPrompt: 'short', workspace: '/Users/x/projects/my-project' }), NOW);
    expect(name).toBe('short · my-project');
  });
});

// ---------------------------------------------------------------------------
// buildConversationRow (pure)
// ---------------------------------------------------------------------------

describe('buildConversationRow', () => {
  it('builds a fresh row with autoNamed=true and a generatedName snapshot', () => {
    const row = buildConversationRow(meta({ id: 'sess-A', firstPrompt: 'hello' }), undefined);
    expect(row.type).toBe('acp');
    expect(row.source).toBe('claude_code');
    expect(row.name).toBe('hello · demo-project');
    const extra = row.extra as { importMeta: { autoNamed: boolean; generatedName?: string; hidden?: boolean } };
    expect(extra.importMeta.autoNamed).toBe(true);
    expect(extra.importMeta.generatedName).toBe('hello · demo-project');
    expect(extra.importMeta.hidden).toBe(false);
  });

  it('refreshes name when existing row was auto-named (generatedName matches)', () => {
    const existing = buildConversationRow(meta({ firstPrompt: 'old prompt' }), undefined);
    const refreshed = buildConversationRow(meta({ firstPrompt: 'new prompt' }), existing);
    expect(refreshed.name).toBe('new prompt · demo-project');
    const extra = refreshed.extra as { importMeta: { autoNamed: boolean; generatedName?: string } };
    expect(extra.importMeta.autoNamed).toBe(true);
    expect(extra.importMeta.generatedName).toBe('new prompt · demo-project');
  });

  it('preserves user rename and flips autoNamed=false when generatedName diverges from name', () => {
    const existing = buildConversationRow(meta({ firstPrompt: 'old prompt' }), undefined);
    // Simulate user rename
    (existing as { name: string }).name = 'My favourite session';
    const refreshed = buildConversationRow(meta({ firstPrompt: 'new prompt' }), existing);
    expect(refreshed.name).toBe('My favourite session');
    const extra = refreshed.extra as { importMeta: { autoNamed: boolean; generatedName?: string } };
    expect(extra.importMeta.autoNamed).toBe(false);
    expect(extra.importMeta.generatedName).toBe('old prompt · demo-project'); // not advanced
  });
});

// ---------------------------------------------------------------------------
// Phase 1: discoverAndImport
// ---------------------------------------------------------------------------

describe('discoverAndImport', () => {
  it('imports Claude Code sessions with firstPrompt as title', async () => {
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'c-1', firstPrompt: 'wire auth' }),
    ]);
    const result = await discoverAndImport('claude_code');
    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(0);
    const stored = Array.from(dbStore.values())[0];
    expect(stored.name).toBe('wire auth · demo-project');
    expect(stored.type).toBe('acp');
    expect(stored.source).toBe('claude_code');
    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({ id: stored.id }), 'created');
  });

  it('imports Copilot sessions with summary (title) as the conversation name', async () => {
    (mockCopilot.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'p-1', source: 'copilot', firstPrompt: '', title: 'compile errors' }),
    ]);
    const result = await discoverAndImport('copilot');
    expect(result.imported).toBe(1);
    const stored = Array.from(dbStore.values())[0];
    expect(stored.name).toBe('compile errors · demo-project');
    expect(stored.source).toBe('copilot');
  });

  it('skips a session already imported (dedup by source + acpSessionId)', async () => {
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'c-1', firstPrompt: 'first scan' }),
    ]);
    await discoverAndImport('claude_code');
    expect(dbStore.size).toBe(1);

    // Second scan returns the same session with identical metadata.
    const second = await discoverAndImport('claude_code');
    expect(second.imported).toBe(0);
    expect(second.updated + second.skipped).toBe(1);
    expect(dbStore.size).toBe(1);
  });

  it('refreshes provider-owned metadata on incremental sync but preserves user rename', async () => {
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'c-1', firstPrompt: 'old prompt', updatedAt: ISO }),
    ]);
    await discoverAndImport('claude_code');
    const id = Array.from(dbStore.keys())[0];

    // Simulate user rename
    const renamed = dbStore.get(id)!;
    (renamed as { name: string }).name = 'My renamed session';
    dbStore.set(id, renamed);

    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({
        id: 'c-1',
        firstPrompt: 'new prompt',
        filePath: '/tmp/moved/c-1.jsonl',
        updatedAt: ISO_LATER,
      }),
    ]);
    const result = await discoverAndImport('claude_code');
    expect(result.updated).toBe(1);

    const after = dbStore.get(id)!;
    expect(after.name).toBe('My renamed session');
    const extra = after.extra as {
      sourceFilePath?: string;
      acpSessionUpdatedAt?: number;
      importMeta?: { autoNamed: boolean };
    };
    expect(extra.sourceFilePath).toBe('/tmp/moved/c-1.jsonl');
    expect(extra.acpSessionUpdatedAt).toBe(Date.parse(ISO_LATER));
    expect(extra.importMeta?.autoNamed).toBe(false);
  });

  it('preserves pin state across re-sync', async () => {
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'c-1', firstPrompt: 'pinned session' }),
    ]);
    await discoverAndImport('claude_code');
    const id = Array.from(dbStore.keys())[0];
    const stored = dbStore.get(id)!;
    (stored.extra as { pinned?: boolean; pinnedAt?: number }).pinned = true;
    (stored.extra as { pinned?: boolean; pinnedAt?: number }).pinnedAt = 1234567;
    dbStore.set(id, stored);

    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'c-1', firstPrompt: 'pinned session', updatedAt: ISO_LATER }),
    ]);
    await discoverAndImport('claude_code');
    const after = dbStore.get(id)!.extra as { pinned?: boolean; pinnedAt?: number };
    expect(after.pinned).toBe(true);
    expect(after.pinnedAt).toBe(1234567);
  });

  it('concurrent calls do not duplicate rows (coalesces in-flight scans)', async () => {
    let resolveDiscover: (value: SessionMetadata[]) => void;
    const slowPromise = new Promise<SessionMetadata[]>((resolve) => {
      resolveDiscover = resolve;
    });
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockReturnValueOnce(slowPromise);
    const p1 = discoverAndImport('claude_code');
    const p2 = discoverAndImport('claude_code');
    expect(p1).toBe(p2); // exact same promise — coalesced
    resolveDiscover!([meta({ id: 'c-1', firstPrompt: 'race' })]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    expect(dbStore.size).toBe(1);
    expect(mockClaude.discoverSessions).toHaveBeenCalledTimes(1);
  });

  it('handles a provider that returns an empty session list', async () => {
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const result = await discoverAndImport('claude_code');
    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(dbStore.size).toBe(0);
  });

  it('records but does not throw when a provider rejects', async () => {
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk read fail'));
    const result = await discoverAndImport('claude_code');
    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('disk read fail');
  });

  it('captures per-session DB write failures without aborting the scan', async () => {
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'c-1', firstPrompt: 'one' }),
      meta({ id: 'c-2', firstPrompt: 'two', filePath: '/tmp/c-2.jsonl' }),
    ]);
    // First createConversation call captured uuid-1 / uuid-2 from the deterministic uuid mock.
    // We don't know the row id deterministically because uuid runs inside buildConversationRow;
    // simplest approach: force the FIRST create to fail by intercepting via createSpy callback.
    let count = 0;
    const originalCreate = mockDatabase.createConversation;
    const trackedCreate = (conv: TChatConversation) => {
      count++;
      if (count === 1) return { success: false, error: 'simulated failure' };
      return originalCreate(conv);
    };
    Object.defineProperty(mockDatabase, 'createConversation', { value: trackedCreate, configurable: true });
    try {
      const result = await discoverAndImport('claude_code');
      expect(result.imported).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(dbStore.size).toBe(1);
    } finally {
      Object.defineProperty(mockDatabase, 'createConversation', { value: originalCreate, configurable: true });
    }
  });
});

// ---------------------------------------------------------------------------
// discoverAndImportAll
// ---------------------------------------------------------------------------

describe('discoverAndImportAll', () => {
  it('one provider throwing does not crash another', async () => {
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('claude broke'));
    (mockCopilot.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'p-1', source: 'copilot', firstPrompt: '', title: 'works' }),
    ]);
    const results = await discoverAndImportAll(['claude_code', 'copilot']);
    expect(results.claude_code?.errors[0].message).toContain('claude broke');
    expect(results.copilot?.imported).toBe(1);
    expect(dbStore.size).toBe(1);
  });

  it('returns only the requested subset of sources', async () => {
    (mockCopilot.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const results = await discoverAndImportAll(['copilot']);
    expect(Object.keys(results)).toEqual(['copilot']);
    expect(results.claude_code).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Disable / re-enable
// ---------------------------------------------------------------------------

describe('disableSource / reenableSource', () => {
  it('disable flips hidden=true on existing rows without deleting them', async () => {
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'c-1', firstPrompt: 'one' }),
      meta({ id: 'c-2', firstPrompt: 'two', filePath: '/tmp/c-2.jsonl' }),
    ]);
    await discoverAndImport('claude_code');
    expect(dbStore.size).toBe(2);

    const result = await disableSource('claude_code');
    expect(result.hidden).toBe(2);
    expect(dbStore.size).toBe(2); // not deleted
    for (const row of dbStore.values()) {
      const extra = row.extra as { importMeta?: { hidden?: boolean } };
      expect(extra.importMeta?.hidden).toBe(true);
    }
  });

  it('re-enable flips hidden=false and runs an incremental scan', async () => {
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'c-1', firstPrompt: 'one' }),
    ]);
    await discoverAndImport('claude_code');
    await disableSource('claude_code');

    // Add a new session that wasn't present at disable time.
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'c-1', firstPrompt: 'one' }),
      meta({ id: 'c-2', firstPrompt: 'two', filePath: '/tmp/c-2.jsonl' }),
    ]);
    const result = await reenableSource('claude_code');
    expect(result.imported).toBe(1); // c-2 new
    expect(dbStore.size).toBe(2);
    for (const row of dbStore.values()) {
      const extra = row.extra as { importMeta?: { hidden?: boolean } };
      expect(extra.importMeta?.hidden).toBe(false);
    }
  });

  it('re-enable preserves user customizations (rename)', async () => {
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'c-1', firstPrompt: 'one' }),
    ]);
    await discoverAndImport('claude_code');
    const id = Array.from(dbStore.keys())[0];
    const row = dbStore.get(id)!;
    (row as { name: string }).name = 'Renamed';
    dbStore.set(id, row);

    await disableSource('claude_code');
    await reenableSource('claude_code');
    expect(dbStore.get(id)!.name).toBe('Renamed');
  });
});

// ---------------------------------------------------------------------------
// Deduplication & sync (§7)
// ---------------------------------------------------------------------------

describe('deduplication & sync (plan §7)', () => {
  it('same session imported twice produces only one row', async () => {
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'c-1', firstPrompt: 'first' }),
    ]);
    await discoverAndImport('claude_code');
    await discoverAndImport('claude_code');
    expect(dbStore.size).toBe(1);
  });

  it('session whose sourceFilePath changed updates the path without duplicating', async () => {
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'c-1', firstPrompt: 'one', filePath: '/old/path/c-1.jsonl' }),
    ]);
    await discoverAndImport('claude_code');
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'c-1', firstPrompt: 'one', filePath: '/new/path/c-1.jsonl', updatedAt: ISO_LATER }),
    ]);
    await discoverAndImport('claude_code');
    expect(dbStore.size).toBe(1);
    const row = Array.from(dbStore.values())[0];
    expect((row.extra as { sourceFilePath?: string }).sourceFilePath).toBe('/new/path/c-1.jsonl');
  });

  it('same UUID across different sources creates two separate rows', async () => {
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'shared-uuid', firstPrompt: 'from claude' }),
    ]);
    (mockCopilot.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'shared-uuid', source: 'copilot', firstPrompt: '', title: 'from copilot' }),
    ]);
    await discoverAndImportAll(['claude_code', 'copilot']);
    expect(dbStore.size).toBe(2);
    const sources = Array.from(dbStore.values()).map((c) => c.source);
    expect(sources.toSorted()).toEqual(['claude_code', 'copilot']);
  });

  it('dedup falls back to source + sourceFilePath when acpSessionId is missing', async () => {
    // Pre-populate a row whose extra carries sourceFilePath but no acpSessionId, simulating
    // a session imported by a previous version that didn't have ID information.
    const existing: TChatConversation = {
      id: 'pre-existing',
      type: 'acp',
      name: 'pre-existing name · demo-project',
      createTime: 1,
      modifyTime: 1,
      source: 'claude_code',
      extra: {
        backend: 'claude',
        workspace: '/Users/x/projects/demo-project',
        sourceFilePath: '/legacy/path/c-x.jsonl',
        importMeta: {
          autoNamed: true,
          generatedName: 'pre-existing name · demo-project',
          hidden: false,
        },
      },
    } as unknown as TChatConversation;
    dbStore.set(existing.id, existing);

    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'c-X', firstPrompt: 'new title', filePath: '/legacy/path/c-x.jsonl' }),
    ]);
    const result = await discoverAndImport('claude_code');
    // Matched via path, so updated rather than imported.
    expect(result.imported).toBe(0);
    expect(result.updated + result.skipped).toBe(1);
    expect(dbStore.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: on-demand message hydration
// ---------------------------------------------------------------------------

type AcpExtra = {
  backend: 'claude' | 'copilot';
  workspace: string;
  acpSessionId: string;
  acpSessionUpdatedAt: number;
  sourceFilePath: string;
  hydratedAt?: number;
  hydratedSourceFilePath?: string;
  importMeta: { autoNamed: boolean; generatedName?: string; hidden?: boolean };
};

/**
 * Build a Phase-1-shaped imported conversation row directly in the
 * test DB. Mirrors what `buildConversationRow` produces but lets each
 * test pin specific fields (autoNamed, generatedName, hydratedAt, ...)
 * without having to round-trip through `discoverAndImport`.
 */
function seedImportedRow(
  overrides: Partial<{
    id: string;
    source: 'claude_code' | 'copilot';
    name: string;
    generatedName: string;
    autoNamed: boolean;
    workspace: string;
    sourceFilePath: string;
    hydratedAt: number | undefined;
    hydratedSourceFilePath: string | undefined;
    hidden: boolean;
    extraOverrides: Partial<AcpExtra>;
  }> = {}
): TChatConversation {
  const id = overrides.id ?? 'conv-1';
  const source = overrides.source ?? 'claude_code';
  const generatedName = overrides.generatedName ?? '5 min ago · demo-project';
  const name = overrides.name ?? generatedName;
  const workspace = overrides.workspace ?? '/Users/x/projects/demo-project';
  const sourceFilePath = overrides.sourceFilePath ?? '/tmp/sessions/sess-1.jsonl';

  const extra: AcpExtra = {
    backend: source === 'claude_code' ? 'claude' : 'copilot',
    workspace,
    acpSessionId: id,
    acpSessionUpdatedAt: 1000,
    sourceFilePath,
    hydratedAt: overrides.hydratedAt,
    hydratedSourceFilePath: overrides.hydratedSourceFilePath,
    importMeta: {
      autoNamed: overrides.autoNamed ?? true,
      generatedName,
      hidden: overrides.hidden ?? false,
    },
    ...overrides.extraOverrides,
  };

  const row = {
    id,
    type: 'acp' as const,
    name,
    createTime: 1,
    modifyTime: 2,
    source,
    extra,
  } as unknown as TChatConversation;
  dbStore.set(id, row);
  return row;
}

/**
 * Minimal `TMessage`-shaped objects produced by `convertClaudeJsonl` / `convertCopilotJsonl`
 * for the hydration flow. Tests don't need to round-trip through real converters — they
 * stub the converters' input (JSONL lines) so `splitJsonlByValidity` + the converters'
 * happy path produce the messages we want to inspect.
 */
const CLAUDE_USER_LINE = (text: string) =>
  JSON.stringify({
    type: 'user',
    timestamp: '2026-05-10T10:00:00.000Z',
    message: { role: 'user', content: text },
  });
const CLAUDE_ASSISTANT_LINE = (text: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-10T10:00:30.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });

describe('hydrateSession (Phase 2)', () => {
  it('first open hydrates: returns hydrated, inserts messages, stamps mtimeMs as hydratedAt', async () => {
    seedImportedRow({ id: 'conv-1', sourceFilePath: '/tmp/s.jsonl', generatedName: '5 min ago · demo-project' });
    const lines = [CLAUDE_USER_LINE('hello world'), CLAUDE_ASSISTANT_LINE('hi there')].join('\n');
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: async () => lines,
    });

    const result = await hydrateSession('conv-1');
    expect(result.status).toBe('hydrated');
    expect(result.warningCount).toBe(0);
    expect(result.warning).toBeUndefined();

    expect(insertMessagesSpy).toHaveBeenCalledTimes(1);
    const [convId, msgs] = insertMessagesSpy.mock.calls[0];
    expect(convId).toBe('conv-1');
    expect((msgs as unknown[]).length).toBeGreaterThan(0);

    const row = dbStore.get('conv-1')!;
    const extra = row.extra as AcpExtra;
    expect(extra.hydratedAt).toBe(5000);
    expect(extra.hydratedSourceFilePath).toBe('/tmp/s.jsonl');
    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'conv-1' }), 'updated');
  });

  it('second open with unchanged mtime returns cached without re-reading', async () => {
    seedImportedRow({ id: 'conv-1' });
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: async () => CLAUDE_USER_LINE('first prompt'),
    });
    await hydrateSession('conv-1');
    expect(insertMessagesSpy).toHaveBeenCalledTimes(1);

    const readSpy = vi.fn(async () => CLAUDE_USER_LINE('first prompt'));
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: readSpy,
    });
    const second = await hydrateSession('conv-1');
    expect(second.status).toBe('cached');
    expect(second.warning).toBeUndefined();
    expect(readSpy).not.toHaveBeenCalled();
    expect(insertMessagesSpy).toHaveBeenCalledTimes(1);
  });

  it('re-hydrates when mtime is newer than hydratedAt (replaces messages)', async () => {
    seedImportedRow({ id: 'conv-1' });
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: async () => CLAUDE_USER_LINE('old'),
    });
    await hydrateSession('conv-1');
    expect(insertMessagesSpy).toHaveBeenCalledTimes(1);

    __setFileIoForTests({
      statMtimeMs: async () => 6000,
      readJsonl: async () => [CLAUDE_USER_LINE('old'), CLAUDE_USER_LINE('new')].join('\n'),
    });
    const result = await hydrateSession('conv-1');
    expect(result.status).toBe('hydrated');
    expect(insertMessagesSpy).toHaveBeenCalledTimes(2);
    const extra = dbStore.get('conv-1')!.extra as AcpExtra;
    expect(extra.hydratedAt).toBe(6000);
  });

  it('treats hydratedAt > 0 as prior hydration even with zero messages (caches)', async () => {
    seedImportedRow({
      id: 'conv-1',
      hydratedAt: 5000,
      hydratedSourceFilePath: '/tmp/s.jsonl',
      sourceFilePath: '/tmp/s.jsonl',
    });
    __setFileIoForTests({
      statMtimeMs: async () => 5000, // unchanged
      readJsonl: async () => '',
    });
    const result = await hydrateSession('conv-1');
    expect(result.status).toBe('cached');
    expect(insertMessagesSpy).not.toHaveBeenCalled();
  });

  it('missing source for a never-hydrated session returns unavailable + source_missing', async () => {
    seedImportedRow({ id: 'conv-1' });
    __setFileIoForTests({
      statMtimeMs: async () => null,
      readJsonl: async () => null,
    });
    const result = await hydrateSession('conv-1');
    expect(result.status).toBe('unavailable');
    expect(result.warning).toBe('source_missing');
    expect(insertMessagesSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('missing source for a previously-hydrated session returns cached + source_missing', async () => {
    seedImportedRow({
      id: 'conv-1',
      hydratedAt: 5000,
      hydratedSourceFilePath: '/tmp/s.jsonl',
      sourceFilePath: '/tmp/s.jsonl',
    });
    messageStore.set('conv-1', [{ id: 'm-1' }]);
    __setFileIoForTests({
      statMtimeMs: async () => null,
      readJsonl: async () => null,
    });
    const result = await hydrateSession('conv-1');
    expect(result.status).toBe('cached');
    expect(result.warning).toBe('source_missing');
    expect(result.warningCount).toBe(0);
    expect(insertMessagesSpy).not.toHaveBeenCalled();
  });

  it('post-stat read failure maps to the same source_missing branch', async () => {
    seedImportedRow({ id: 'conv-1' });
    __setFileIoForTests({
      statMtimeMs: async () => 5000, // stat succeeds
      readJsonl: async () => null, // read races out
    });
    const result = await hydrateSession('conv-1');
    expect(result.status).toBe('unavailable');
    expect(result.warning).toBe('source_missing');

    // With prior hydration on the same path it should return cached instead.
    seedImportedRow({
      id: 'conv-2',
      sourceFilePath: '/tmp/s2.jsonl',
      hydratedAt: 4000,
      hydratedSourceFilePath: '/tmp/s2.jsonl',
    });
    messageStore.set('conv-2', [{ id: 'm-1' }]);
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: async () => null,
    });
    const result2 = await hydrateSession('conv-2');
    expect(result2.status).toBe('cached');
    expect(result2.warning).toBe('source_missing');
  });

  it('corrupted JSONL skips bad lines and reports warningCount', async () => {
    seedImportedRow({ id: 'conv-1' });
    const lines = [CLAUDE_USER_LINE('valid'), '{ not json', CLAUDE_ASSISTANT_LINE('also valid'), '{"oops": '].join(
      '\n'
    );
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: async () => lines,
    });
    const result = await hydrateSession('conv-1');
    expect(result.status).toBe('hydrated');
    expect(result.warningCount).toBe(2);
    expect(insertMessagesSpy).toHaveBeenCalledTimes(1);
  });

  it('coalesces two concurrent hydration calls into one read+parse+insert pass', async () => {
    seedImportedRow({ id: 'conv-1' });
    let readCalls = 0;
    let resolveRead: ((value: string | null) => void) | undefined;
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: () =>
        new Promise<string | null>((resolve) => {
          readCalls++;
          resolveRead = resolve;
        }),
    });

    const p1 = hydrateSession('conv-1');
    const p2 = hydrateSession('conv-1');
    expect(p1).toBe(p2);
    // Let the first microtask of runHydrate run so readJsonl is awaited.
    await new Promise((resolve) => setImmediate(resolve));
    expect(readCalls).toBe(1);

    resolveRead!(CLAUDE_USER_LINE('only-one-read'));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe('hydrated');
    expect(r2).toBe(r1);
    expect(insertMessagesSpy).toHaveBeenCalledTimes(1);
  });

  it('coalescing key is per-conversation: two different conversationIds run in parallel', async () => {
    seedImportedRow({ id: 'conv-A', sourceFilePath: '/tmp/a.jsonl' });
    seedImportedRow({ id: 'conv-B', sourceFilePath: '/tmp/b.jsonl' });
    const reads: string[] = [];
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: async (filePath: string) => {
        reads.push(filePath);
        return CLAUDE_USER_LINE('hi');
      },
    });
    await Promise.all([hydrateSession('conv-A'), hydrateSession('conv-B')]);
    expect(reads.toSorted()).toEqual(['/tmp/a.jsonl', '/tmp/b.jsonl']);
    expect(insertMessagesSpy).toHaveBeenCalledTimes(2);
  });

  it('throws on unknown conversationId', async () => {
    await expect(hydrateSession('does-not-exist')).rejects.toThrow(/Conversation not found/);
    expect(insertMessagesSpy).not.toHaveBeenCalled();
  });

  it('throws on a row missing extra.sourceFilePath (not an imported session)', async () => {
    const native = {
      id: 'native-1',
      type: 'acp',
      name: 'native',
      createTime: 1,
      modifyTime: 1,
      source: 'claude_code',
      extra: { backend: 'claude', workspace: '/w', acpSessionId: 'native-1' },
    } as unknown as TChatConversation;
    dbStore.set(native.id, native);
    await expect(hydrateSession('native-1')).rejects.toThrow(/not an imported CLI session/);
  });

  it('throws on hidden imported session', async () => {
    seedImportedRow({ id: 'conv-1', hidden: true });
    await expect(hydrateSession('conv-1')).rejects.toThrow(/hidden imported session/);
  });

  it('throws on unsupported source (coding bug — surfaces before file I/O)', async () => {
    const row = seedImportedRow({ id: 'conv-1' });
    (row as unknown as { source: string }).source = 'codex'; // not in CONVERTER_FOR_SOURCE
    dbStore.set('conv-1', row);
    let statCalls = 0;
    __setFileIoForTests({
      statMtimeMs: async () => {
        statCalls++;
        return 5000;
      },
      readJsonl: async () => CLAUDE_USER_LINE('never read'),
    });
    await expect(hydrateSession('conv-1')).rejects.toThrow(/Unsupported CLI history source/);
    expect(statCalls).toBe(0); // converter lookup happens BEFORE any file I/O
  });

  it('throws when DB count read fails', async () => {
    seedImportedRow({ id: 'conv-1' });
    dbFailureSwitches.countFails = true;
    __setFileIoForTests({ statMtimeMs: async () => 5000, readJsonl: async () => CLAUDE_USER_LINE('x') });
    await expect(hydrateSession('conv-1')).rejects.toThrow(/Failed to count imported messages|simulated count failure/);
  });

  it('throws when DB insertImportedMessages fails (no metadata write side-effect)', async () => {
    seedImportedRow({ id: 'conv-1' });
    dbFailureSwitches.insertMessagesFails = true;
    __setFileIoForTests({ statMtimeMs: async () => 5000, readJsonl: async () => CLAUDE_USER_LINE('x') });
    await expect(hydrateSession('conv-1')).rejects.toThrow(
      /Failed to insert imported messages|simulated insert failure/
    );
    expect(updateSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('throws when update after insert fails', async () => {
    seedImportedRow({ id: 'conv-1' });
    dbFailureSwitches.updateFailsAfterInsert = true;
    __setFileIoForTests({ statMtimeMs: async () => 5000, readJsonl: async () => CLAUDE_USER_LINE('x') });
    await expect(hydrateSession('conv-1')).rejects.toThrow(
      /Failed to update imported conversation after hydration|simulated update failure/
    );
    expect(insertMessagesSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('re-hydrates when sourceFilePath was refreshed by a scan, even if mtime matches', async () => {
    // Prior hydration was against /old/path; Phase-1 moved-file dedup refreshed
    // sourceFilePath to /new/path. Cache must NOT be reused even with mtime
    // matching the prior `hydratedAt` value.
    seedImportedRow({
      id: 'conv-1',
      sourceFilePath: '/new/path.jsonl',
      hydratedAt: 5000,
      hydratedSourceFilePath: '/old/path.jsonl',
    });
    messageStore.set('conv-1', [{ id: 'm-1' }]);
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: async () => CLAUDE_USER_LINE('fresh content'),
    });
    const result = await hydrateSession('conv-1');
    expect(result.status).toBe('hydrated');
    expect(insertMessagesSpy).toHaveBeenCalledTimes(1);
    const extra = dbStore.get('conv-1')!.extra as AcpExtra;
    expect(extra.hydratedSourceFilePath).toBe('/new/path.jsonl');
  });

  it('pre-Phase-2 row with existing messages but no hydratedSourceFilePath: re-hydrates (cannot trust source)', async () => {
    // A row imported by Phase 1 before this PR — `existingCount > 0` is possible
    // if another code path inserted messages, but there's no `hydratedSourceFilePath`
    // to confirm those messages came from the current `sourceFilePath`. The cache
    // check must err on the side of re-hydration to avoid serving stale-from-a-
    // different-file messages.
    seedImportedRow({
      id: 'conv-1',
      sourceFilePath: '/tmp/s.jsonl',
      hydratedAt: undefined,
      hydratedSourceFilePath: undefined,
    });
    messageStore.set('conv-1', [{ id: 'm-old' }]);
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: async () => CLAUDE_USER_LINE('current content'),
    });
    const result = await hydrateSession('conv-1');
    expect(result.status).toBe('hydrated');
    expect(insertMessagesSpy).toHaveBeenCalledTimes(1);
    const extra = dbStore.get('conv-1')!.extra as AcpExtra;
    expect(extra.hydratedSourceFilePath).toBe('/tmp/s.jsonl');
  });

  it('forwards showThinking to the converter so thinking blocks appear in the hydrated transcript', async () => {
    seedImportedRow({ id: 'conv-1' });
    const lines = [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-10T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'reasoning step', signature: 'sig' },
            { type: 'text', text: 'visible response' },
          ],
        },
      }),
    ].join('\n');
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: async () => lines,
    });

    await hydrateSession('conv-1', { showThinking: true });
    const [, msgsWithThinking] = insertMessagesSpy.mock.calls[0];
    const texts = (msgsWithThinking as Array<{ type: string; content: { content: string } }>)
      .filter((m) => m.type === 'text')
      .map((m) => m.content.content);
    expect(texts.some((t) => t.includes('reasoning step'))).toBe(true);
    expect(texts.some((t) => t.includes('visible response'))).toBe(true);

    // Default (no option) drops thinking blocks.
    insertMessagesSpy.mockClear();
    seedImportedRow({ id: 'conv-2', sourceFilePath: '/tmp/s2.jsonl' });
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: async () => lines,
    });
    await hydrateSession('conv-2');
    const [, msgsNoThinking] = insertMessagesSpy.mock.calls[0];
    const texts2 = (msgsNoThinking as Array<{ type: string; content: { content: string } }>)
      .filter((m) => m.type === 'text')
      .map((m) => m.content.content);
    expect(texts2.some((t) => t.includes('reasoning step'))).toBe(false);
    expect(texts2.some((t) => t.includes('visible response'))).toBe(true);
  });

  it('invalidates cache when showThinking flips between calls (even with unchanged mtime)', async () => {
    // First hydration stores messages without thinking blocks.
    seedImportedRow({ id: 'conv-1', sourceFilePath: '/tmp/s.jsonl' });
    const lines = [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-10T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'reasoning step', signature: 'sig' },
            { type: 'text', text: 'visible response' },
          ],
        },
      }),
    ].join('\n');
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: async () => lines,
    });

    const first = await hydrateSession('conv-1', { showThinking: false });
    expect(first.status).toBe('hydrated');
    const extraAfterFirst = dbStore.get('conv-1')!.extra as AcpExtra & { hydratedShowThinking?: boolean };
    expect(extraAfterFirst.hydratedShowThinking).toBe(false);
    expect(insertMessagesSpy).toHaveBeenCalledTimes(1);

    // Second call with showThinking=true and unchanged mtime: must NOT serve cache.
    insertMessagesSpy.mockClear();
    const second = await hydrateSession('conv-1', { showThinking: true });
    expect(second.status).toBe('hydrated');
    expect(insertMessagesSpy).toHaveBeenCalledTimes(1);
    const extraAfterSecond = dbStore.get('conv-1')!.extra as AcpExtra & { hydratedShowThinking?: boolean };
    expect(extraAfterSecond.hydratedShowThinking).toBe(true);

    // Third call with the same showThinking=true and unchanged mtime: cache hit.
    insertMessagesSpy.mockClear();
    const third = await hydrateSession('conv-1', { showThinking: true });
    expect(third.status).toBe('cached');
    expect(insertMessagesSpy).not.toHaveBeenCalled();

    // Fourth call with showThinking omitted (default): treated equivalent to false → invalidates again.
    insertMessagesSpy.mockClear();
    const fourth = await hydrateSession('conv-1');
    expect(fourth.status).toBe('hydrated');
    expect(insertMessagesSpy).toHaveBeenCalledTimes(1);
    const extraAfterFourth = dbStore.get('conv-1')!.extra as AcpExtra & { hydratedShowThinking?: boolean };
    expect(extraAfterFourth.hydratedShowThinking).toBe(false);

    // Fifth call with showThinking=false explicit: cache hit (equivalent to undefined).
    insertMessagesSpy.mockClear();
    const fifth = await hydrateSession('conv-1', { showThinking: false });
    expect(fifth.status).toBe('cached');
    expect(insertMessagesSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Auto-Naming upgrade
// ---------------------------------------------------------------------------

describe('hydrateSession Phase-2 title upgrade', () => {
  it('upgrades a relative-time fallback title using the first user message', async () => {
    seedImportedRow({
      id: 'conv-1',
      generatedName: '5 min ago · demo-project',
      name: '5 min ago · demo-project',
      autoNamed: true,
    });
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: async () =>
        [
          CLAUDE_USER_LINE('Fix the auth bug in the login flow'),
          CLAUDE_ASSISTANT_LINE('Sure, let me look at it.'),
        ].join('\n'),
    });
    const result = await hydrateSession('conv-1');
    expect(result.status).toBe('hydrated');
    const row = dbStore.get('conv-1')!;
    expect(row.name).toBe('Fix the auth bug in the login flow · demo-project');
    const extra = row.extra as AcpExtra;
    expect(extra.importMeta.autoNamed).toBe(true);
    expect(extra.importMeta.generatedName).toBe('Fix the auth bug in the login flow · demo-project');
  });

  it('truncates the candidate to 60 codepoints', async () => {
    seedImportedRow({ id: 'conv-1', generatedName: '5 min ago · demo-project', autoNamed: true });
    const longPrompt = 'a'.repeat(120);
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: async () => CLAUDE_USER_LINE(longPrompt),
    });
    await hydrateSession('conv-1');
    const row = dbStore.get('conv-1')!;
    expect(row.name).toBe(`${'a'.repeat(60)}… · demo-project`);
  });

  it('preserves a meaningful provider title (does not downgrade)', async () => {
    seedImportedRow({
      id: 'conv-1',
      generatedName: 'Refactor the auth middleware · demo-project',
      name: 'Refactor the auth middleware · demo-project',
      autoNamed: true,
    });
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: async () => CLAUDE_USER_LINE('something totally different'),
    });
    await hydrateSession('conv-1');
    const row = dbStore.get('conv-1')!;
    expect(row.name).toBe('Refactor the auth middleware · demo-project');
  });

  it('does not upgrade if user has renamed (autoNamed=false)', async () => {
    seedImportedRow({
      id: 'conv-1',
      generatedName: '5 min ago · demo-project',
      name: 'My manual rename',
      autoNamed: false,
    });
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: async () => CLAUDE_USER_LINE('first user prompt'),
    });
    await hydrateSession('conv-1');
    const row = dbStore.get('conv-1')!;
    expect(row.name).toBe('My manual rename');
    const extra = row.extra as AcpExtra;
    expect(extra.importMeta.autoNamed).toBe(false);
  });

  it('does not upgrade when the JSONL has no user-role text messages', async () => {
    seedImportedRow({ id: 'conv-1', generatedName: '5 min ago · demo-project', autoNamed: true });
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      // Only assistant lines, no user-role text.
      readJsonl: async () => CLAUDE_ASSISTANT_LINE('hello from the assistant'),
    });
    await hydrateSession('conv-1');
    const row = dbStore.get('conv-1')!;
    expect(row.name).toBe('5 min ago · demo-project');
  });

  it('rename racing during hydration: fresh re-read flips autoNamed to false → title upgrade skipped', async () => {
    seedImportedRow({
      id: 'conv-1',
      generatedName: '5 min ago · demo-project',
      name: '5 min ago · demo-project',
      autoNamed: true,
    });
    let readResolve: ((value: string) => void) | undefined;
    __setFileIoForTests({
      statMtimeMs: async () => 5000,
      readJsonl: () =>
        new Promise<string | null>((resolve) => {
          readResolve = (val) => resolve(val);
        }),
    });

    const promise = hydrateSession('conv-1');
    await new Promise((resolve) => setImmediate(resolve));

    // Concurrent rename lands while readJsonl is pending.
    const fresh = structuredClone(dbStore.get('conv-1')!);
    (fresh as { name: string }).name = 'User Renamed';
    const freshExtra = fresh.extra as AcpExtra;
    freshExtra.importMeta = { ...freshExtra.importMeta, autoNamed: false };
    dbStore.set('conv-1', fresh);

    readResolve!(CLAUDE_USER_LINE('would have upgraded'));
    const result = await promise;
    expect(result.status).toBe('hydrated');
    const row = dbStore.get('conv-1')!;
    expect(row.name).toBe('User Renamed');
    expect((row.extra as AcpExtra).importMeta.autoNamed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// initCliHistoryImporter (app-launch sync)
// ---------------------------------------------------------------------------

describe('initCliHistoryImporter', () => {
  it('runs nothing when no source is enabled in agentCli.config', async () => {
    processConfigGet.mockResolvedValue({ importClaudeCode: false, importCopilot: false });
    initCliHistoryImporter();
    // Microtask drain
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mockClaude.discoverSessions).not.toHaveBeenCalled();
    expect(mockCopilot.discoverSessions).not.toHaveBeenCalled();
  });

  it('runs discoverAndImportAll for enabled sources without throwing', async () => {
    processConfigGet.mockResolvedValue({ importClaudeCode: true, importCopilot: false });
    (mockClaude.discoverSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      meta({ id: 'c-1', firstPrompt: 'startup scan' }),
    ]);
    initCliHistoryImporter();
    // Give the fire-and-forget body time to resolve.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockClaude.discoverSessions).toHaveBeenCalledTimes(1);
    expect(mockCopilot.discoverSessions).not.toHaveBeenCalled();
    expect(dbStore.size).toBe(1);
  });
});
