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
  const writeFailures = new Set<string>();
  const createSpy = vi.fn();
  const updateSpy = vi.fn();

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
  };

  const emitSpy = vi.fn();
  const processConfigGet = vi.fn(async () => ({}) as Record<string, unknown>);

  return {
    uuidState,
    mockClaude,
    mockCopilot,
    dbStore,
    writeFailures,
    createSpy,
    updateSpy,
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
const writeFailures = hoisted.writeFailures;
const createSpy = hoisted.createSpy;
const updateSpy = hoisted.updateSpy;
const mockDatabase = hoisted.mockDatabase;
const emitSpy = hoisted.emitSpy;
const processConfigGet = hoisted.processConfigGet;

// Import AFTER mocks are set up.
import {
  __resetInFlightForTests,
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
  writeFailures.clear();
  createSpy.mockClear();
  updateSpy.mockClear();
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
    const name = buildAutoName(
      meta({ source: 'copilot', firstPrompt: '', title: '(untitled)', updatedAt: ISO }),
      NOW
    );
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
// hydrateSession is a stub
// ---------------------------------------------------------------------------

describe('hydrateSession', () => {
  it('throws "not implemented in Phase 1"', async () => {
    await expect(hydrateSession('any-id')).rejects.toThrow(/not implemented in Phase 1/);
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
