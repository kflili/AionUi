/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  ClaudeCodeProvider,
  decodeProjectPath,
  pickCanonicalJsonlInDir,
  synthesizeFromJsonl,
} from '@process/cli-history/providers/claude';

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

const UUID_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const UUID_C = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';

function userLine(content: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}

function summaryLine(summary: string): string {
  return JSON.stringify({ type: 'summary', summary });
}

function assistantLine(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

/**
 * Create an isolated `~/.claude/projects/<encoded>/` tree by overriding
 * os.homedir() for the duration of one test. Returns the temp home path
 * and the project-dir absolute path so tests can drop fixtures into it.
 */
async function withTempHome(): Promise<{ home: string; projectDir: string; restore: () => void }> {
  const home = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'aionui-test-claude-'));
  const projectDir = path.join(home, '.claude', 'projects', '-Users-test-Projects-demo');
  await fsPromises.mkdir(projectDir, { recursive: true });
  const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  return {
    home,
    projectDir,
    restore: () => {
      spy.mockRestore();
      // Best-effort cleanup; ignore failures (other tests may already have torn down).
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// decodeProjectPath
// ---------------------------------------------------------------------------

describe('decodeProjectPath', () => {
  it('decodes a typical Claude Code project dir basename', () => {
    expect(decodeProjectPath('-Users-lili-Projects-claude-toolkit')).toBe('/Users/lili/Projects/claude/toolkit');
  });

  it('lossy collapse on literal hyphens is documented behavior, not a regression', () => {
    // Original `claude-toolkit` becomes `claude/toolkit`; encoding cannot disambiguate.
    expect(decodeProjectPath('-Volumes-Extreme-SSD-IOSApp-CitizenReady')).toBe(
      '/Volumes/Extreme/SSD/IOSApp/CitizenReady'
    );
  });

  it('handles missing leading dash gracefully', () => {
    expect(decodeProjectPath('Users-lili')).toBe('/Users/lili');
  });

  it('returns empty string for empty input', () => {
    expect(decodeProjectPath('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// synthesizeFromJsonl
// ---------------------------------------------------------------------------

describe('synthesizeFromJsonl', () => {
  let tmp: { home: string; projectDir: string; restore: () => void };
  beforeEach(async () => {
    tmp = await withTempHome();
  });
  afterEach(() => tmp.restore());

  it('extracts firstPrompt from the first user line and summary from the latest summary line', async () => {
    const jsonlPath = path.join(tmp.projectDir, `${UUID_A}.jsonl`);
    await fsPromises.writeFile(
      jsonlPath,
      [summaryLine('initial summary'), userLine('hello world'), assistantLine('hi'), summaryLine('newer summary')].join(
        '\n'
      ) + '\n'
    );

    const meta = await synthesizeFromJsonl(jsonlPath, UUID_A, tmp.projectDir);
    expect(meta).not.toBeNull();
    expect(meta!.firstPrompt).toBe('hello world');
    expect(meta!.title).toBe('newer summary');
    expect(meta!.messageCount).toBe(4);
    expect(meta!.workspace).toBe('/Users/test/Projects/demo');
    expect(meta!.source).toBe('claude_code');
  });

  it('falls back to firstPrompt slice when no summary line present', async () => {
    const jsonlPath = path.join(tmp.projectDir, `${UUID_A}.jsonl`);
    const longPrompt = 'a'.repeat(120);
    await fsPromises.writeFile(jsonlPath, [userLine(longPrompt), assistantLine('reply')].join('\n') + '\n');

    const meta = await synthesizeFromJsonl(jsonlPath, UUID_A, tmp.projectDir);
    expect(meta).not.toBeNull();
    expect(meta!.title.length).toBe(80);
    expect(meta!.firstPrompt).toBe(longPrompt);
  });

  it('returns null on empty file', async () => {
    const jsonlPath = path.join(tmp.projectDir, `${UUID_A}.jsonl`);
    await fsPromises.writeFile(jsonlPath, '');
    const meta = await synthesizeFromJsonl(jsonlPath, UUID_A, tmp.projectDir);
    expect(meta).toBeNull();
  });

  it('returns null when no JSON line is parseable', async () => {
    const jsonlPath = path.join(tmp.projectDir, `${UUID_A}.jsonl`);
    await fsPromises.writeFile(jsonlPath, 'not json\nmore garbage\n');
    const meta = await synthesizeFromJsonl(jsonlPath, UUID_A, tmp.projectDir);
    expect(meta).toBeNull();
  });

  it('returns null when file does not exist', async () => {
    const meta = await synthesizeFromJsonl(path.join(tmp.projectDir, 'missing.jsonl'), UUID_A, tmp.projectDir);
    expect(meta).toBeNull();
  });

  it('falls back to sessionId for title when neither summary nor firstPrompt present', async () => {
    const jsonlPath = path.join(tmp.projectDir, `${UUID_A}.jsonl`);
    // Only assistant + system-style lines; no user line.
    await fsPromises.writeFile(
      jsonlPath,
      [assistantLine('greeting'), JSON.stringify({ type: 'system', subtype: 'init' })].join('\n') + '\n'
    );
    const meta = await synthesizeFromJsonl(jsonlPath, UUID_A, tmp.projectDir);
    expect(meta).not.toBeNull();
    expect(meta!.firstPrompt).toBe('');
    expect(meta!.title).toBe(UUID_A);
  });
});

// ---------------------------------------------------------------------------
// pickCanonicalJsonlInDir
// ---------------------------------------------------------------------------

describe('pickCanonicalJsonlInDir', () => {
  let tmp: { home: string; projectDir: string; restore: () => void };
  beforeEach(async () => {
    tmp = await withTempHome();
  });
  afterEach(() => tmp.restore());

  it('returns null for an empty directory', async () => {
    const sessionDir = path.join(tmp.projectDir, UUID_A);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    expect(await pickCanonicalJsonlInDir(sessionDir)).toBeNull();
  });

  it('returns the lone .jsonl when only one exists', async () => {
    const sessionDir = path.join(tmp.projectDir, UUID_A);
    const subagents = path.join(sessionDir, 'subagents');
    await fsPromises.mkdir(subagents, { recursive: true });
    const file = path.join(subagents, 'agent-only.jsonl');
    await fsPromises.writeFile(file, userLine('hello'));
    expect(await pickCanonicalJsonlInDir(sessionDir)).toBe(file);
  });

  it('picks the largest .jsonl across nested dirs', async () => {
    const sessionDir = path.join(tmp.projectDir, UUID_A);
    const subagents = path.join(sessionDir, 'subagents');
    await fsPromises.mkdir(subagents, { recursive: true });
    const small = path.join(subagents, 'agent-small.jsonl');
    const large = path.join(subagents, 'agent-large.jsonl');
    await fsPromises.writeFile(small, 'a'.repeat(100));
    await fsPromises.writeFile(large, 'a'.repeat(500));
    expect(await pickCanonicalJsonlInDir(sessionDir)).toBe(large);
  });

  it('on tied size, prefers a .jsonl outside subagents/', async () => {
    const sessionDir = path.join(tmp.projectDir, UUID_A);
    const subagents = path.join(sessionDir, 'subagents');
    await fsPromises.mkdir(subagents, { recursive: true });
    const inSub = path.join(subagents, 'agent-tied.jsonl');
    const outside = path.join(sessionDir, 'top.jsonl');
    await fsPromises.writeFile(inSub, 'a'.repeat(100));
    await fsPromises.writeFile(outside, 'a'.repeat(100));
    expect(await pickCanonicalJsonlInDir(sessionDir)).toBe(outside);
  });
});

// ---------------------------------------------------------------------------
// ClaudeCodeProvider.discoverSessions — JSONL fallback path
// ---------------------------------------------------------------------------

describe('ClaudeCodeProvider.discoverSessions JSONL fallback', () => {
  let tmp: { home: string; projectDir: string; restore: () => void };
  beforeEach(async () => {
    tmp = await withTempHome();
  });
  afterEach(() => tmp.restore());

  it('discovers sessions from .jsonl files when sessions-index.json is absent', async () => {
    await fsPromises.writeFile(path.join(tmp.projectDir, `${UUID_A}.jsonl`), userLine('first session'));
    await fsPromises.writeFile(path.join(tmp.projectDir, `${UUID_B}.jsonl`), userLine('second session'));

    const provider = new ClaudeCodeProvider();
    const sessions = await provider.discoverSessions();

    const ids = sessions.map((s) => s.id).toSorted();
    expect(ids).toEqual([UUID_A, UUID_B].toSorted());
    const a = sessions.find((s) => s.id === UUID_A)!;
    expect(a.firstPrompt).toBe('first session');
    expect(a.workspace).toBe('/Users/test/Projects/demo');
  });

  it('combines stale sessions-index.json with newer fallback-discovered jsonls (deduped by id)', async () => {
    // Index lists only UUID_A (and points at a path that no longer exists on disk —
    // the importer's job is to surface what the index claims plus what's actually there).
    const stalePath = path.join(tmp.projectDir, `${UUID_A}.jsonl`);
    const indexedEntry = {
      sessionId: UUID_A,
      fullPath: stalePath,
      fileMtime: 1,
      firstPrompt: 'indexed',
      summary: 'from-index',
      messageCount: 1,
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      gitBranch: '',
      projectPath: '/Users/test/Projects/demo',
      isSidechain: false,
    };
    await fsPromises.writeFile(
      path.join(tmp.projectDir, 'sessions-index.json'),
      JSON.stringify({ version: 1, entries: [indexedEntry], originalPath: '/Users/test/Projects/demo' })
    );
    await fsPromises.writeFile(stalePath, userLine('indexed body'));
    // UUID_B is on disk but NOT in the index → must be discovered via fallback.
    await fsPromises.writeFile(path.join(tmp.projectDir, `${UUID_B}.jsonl`), userLine('only on disk'));

    const provider = new ClaudeCodeProvider();
    const sessions = await provider.discoverSessions();

    const ids = sessions.map((s) => s.id).toSorted();
    expect(ids).toEqual([UUID_A, UUID_B].toSorted());
    // UUID_A still came from the index (its title is the index summary, not the synthesized one).
    expect(sessions.find((s) => s.id === UUID_A)!.title).toBe('from-index');
    // UUID_B came from fallback (synthesized title falls back to firstPrompt).
    expect(sessions.find((s) => s.id === UUID_B)!.firstPrompt).toBe('only on disk');
    // Even when both passes touch the same id, no duplicate row appears.
    expect(sessions.length).toBe(2);
  });

  it('skips empty .jsonl files in the fallback pass', async () => {
    await fsPromises.writeFile(path.join(tmp.projectDir, `${UUID_A}.jsonl`), '');
    await fsPromises.writeFile(path.join(tmp.projectDir, `${UUID_B}.jsonl`), userLine('valid session'));

    const provider = new ClaudeCodeProvider();
    const sessions = await provider.discoverSessions();
    expect(sessions.map((s) => s.id)).toEqual([UUID_B]);
  });

  it('skips files with non-UUID basenames', async () => {
    await fsPromises.writeFile(path.join(tmp.projectDir, 'not-a-uuid.jsonl'), userLine('garbage'));
    await fsPromises.writeFile(path.join(tmp.projectDir, `${UUID_A}.jsonl`), userLine('valid'));

    const provider = new ClaudeCodeProvider();
    const sessions = await provider.discoverSessions();
    expect(sessions.map((s) => s.id)).toEqual([UUID_A]);
  });

  it('discovers sessions stored in the newer <UUID>/subagents/agent-*.jsonl directory layout', async () => {
    const sessionDir = path.join(tmp.projectDir, UUID_C);
    const subagents = path.join(sessionDir, 'subagents');
    await fsPromises.mkdir(subagents, { recursive: true });
    const small = path.join(subagents, 'agent-small.jsonl');
    const large = path.join(subagents, 'agent-large.jsonl');
    await fsPromises.writeFile(small, userLine('short'));
    await fsPromises.writeFile(
      large,
      [userLine('the canonical one'), assistantLine('reply'), summaryLine('main')].join('\n')
    );

    const provider = new ClaudeCodeProvider();
    const sessions = await provider.discoverSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe(UUID_C);
    expect(sessions[0].title).toBe('main');
    expect(sessions[0].firstPrompt).toBe('the canonical one');
    expect(provider.canResume(UUID_C)).toBe(true);
    expect(provider.buildReference(UUID_C)).toBe(large);
  });

  it('returns an empty list when ~/.claude/projects/ does not exist', async () => {
    // Tear down the temp tree so the projects dir is missing.
    tmp.restore();
    const home = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'aionui-test-claude-empty-'));
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const provider = new ClaudeCodeProvider();
      const sessions = await provider.discoverSessions();
      expect(sessions).toEqual([]);
    } finally {
      spy.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
      // Reinstate a fresh tmp for afterEach to tear down without error.
      tmp = await withTempHome();
    }
  });
});
