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
      // Best-effort cleanup; ignore failures (e.g. Windows permission/EBUSY when
      // a still-open file handle blocks the rmtree).
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        // Intentionally swallowed — teardown is non-critical.
      }
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

  it('handles CRLF line endings correctly (newline normalization in stream reader)', async () => {
    const jsonlPath = path.join(tmp.projectDir, `${UUID_A}.jsonl`);
    // Write with explicit CRLF — Windows-written transcripts use this, and the
    // readline interface must collapse `\r\n` into a single line event so the
    // JSON.parse on each line doesn't see a trailing `\r`.
    await fsPromises.writeFile(
      jsonlPath,
      [userLine('hello'), assistantLine('hi'), summaryLine('done')].join('\r\n') + '\r\n'
    );
    const meta = await synthesizeFromJsonl(jsonlPath, UUID_A, tmp.projectDir);
    expect(meta).not.toBeNull();
    expect(meta!.firstPrompt).toBe('hello');
    expect(meta!.title).toBe('done');
    expect(meta!.messageCount).toBe(3);
  });

  it('extracts firstPrompt from an array of content blocks (text block wins, tool_result ignored)', async () => {
    const jsonlPath = path.join(tmp.projectDir, `${UUID_A}.jsonl`);
    // Claude Code uses the array form when prior assistant turns produced
    // tool calls — the user line then carries tool_result blocks alongside
    // any inline text the user typed.
    const userArrayLine = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'output', is_error: false },
          { type: 'text', text: 'continue please' },
        ],
      },
    });
    await fsPromises.writeFile(jsonlPath, userArrayLine + '\n');
    const meta = await synthesizeFromJsonl(jsonlPath, UUID_A, tmp.projectDir);
    expect(meta).not.toBeNull();
    expect(meta!.firstPrompt).toBe('continue please');
  });

  it('returns empty firstPrompt when content array has only tool_result blocks (no text)', async () => {
    const jsonlPath = path.join(tmp.projectDir, `${UUID_A}.jsonl`);
    const toolOnlyLine = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output', is_error: false }],
      },
    });
    await fsPromises.writeFile(jsonlPath, toolOnlyLine + '\n');
    const meta = await synthesizeFromJsonl(jsonlPath, UUID_A, tmp.projectDir);
    expect(meta).not.toBeNull();
    expect(meta!.firstPrompt).toBe('');
    // Title falls back to sessionId (no summary, no prompt).
    expect(meta!.title).toBe(UUID_A);
  });

  it('prefers JSONL `cwd` over the lossy decoded project-dir basename for workspace', async () => {
    // The dir basename `-Users-test-Projects-demo` decodes to
    // `/Users/test/Projects/demo`, but if the JSONL records the original
    // workspace exactly (e.g. with literal hyphens that the encoding lost),
    // we should prefer that.
    const jsonlPath = path.join(tmp.projectDir, `${UUID_A}.jsonl`);
    const lineWithCwd = JSON.stringify({
      type: 'user',
      cwd: '/Users/lili/Projects/claude-toolkit',
      message: { role: 'user', content: 'hi' },
    });
    await fsPromises.writeFile(jsonlPath, lineWithCwd + '\n');
    const meta = await synthesizeFromJsonl(jsonlPath, UUID_A, tmp.projectDir);
    expect(meta).not.toBeNull();
    expect(meta!.workspace).toBe('/Users/lili/Projects/claude-toolkit');
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

  it('does NOT mis-classify as "underSubagents" when an unrelated ancestor dir contains "subagents" in its name', async () => {
    // Real-world scenario: the user has a subagents-archive parent, or any ancestor
    // path component that contains the literal string "subagents". The previous
    // `fullPath.includes('${sep}subagents${sep}')` substring check would mis-tag
    // every file inside such a parent as `underSubagents=true` and incorrectly
    // demote it on a tied size. The fix uses `path.relative(sessionDir, fullPath)`
    // which only considers segments under the session dir.
    const sessionDir = path.join(tmp.home, 'subagents-archive', 'projects', UUID_A);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const a = path.join(sessionDir, 'a.jsonl');
    const b = path.join(sessionDir, 'b.jsonl');
    await fsPromises.writeFile(a, 'a'.repeat(100));
    await fsPromises.writeFile(b, 'a'.repeat(100));
    // Both files have tied size and neither is under a `subagents/` SEGMENT
    // relative to sessionDir, so the deterministic localeCompare tie-break wins.
    expect(await pickCanonicalJsonlInDir(sessionDir)).toBe(a);
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

  it('drops index entries whose fullPath no longer exists, allowing fallback to re-discover at new dir-layout location', async () => {
    // The index claims UUID_C lives at `<projectDir>/UUID_C.jsonl`, but the
    // file was moved (Claude Code reorganized to dir layout) and the actual
    // transcript now lives at `<projectDir>/UUID_C/subagents/agent.jsonl`.
    // Pre-fix behavior: the stale-index entry would block fallback discovery
    // and the importer would keep pointing at the missing file. Post-fix:
    // index pre-validates `fullPath`, drops the dead entry, and fallback
    // re-discovers the session at its real location.
    const ghostPath = path.join(tmp.projectDir, `${UUID_C}.jsonl`); // never written
    const indexedEntry = {
      sessionId: UUID_C,
      fullPath: ghostPath,
      fileMtime: 1,
      firstPrompt: 'old',
      summary: 'stale-index-summary',
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
    // The session actually lives in the newer dir layout.
    const realDir = path.join(tmp.projectDir, UUID_C, 'subagents');
    await fsPromises.mkdir(realDir, { recursive: true });
    const realPath = path.join(realDir, 'agent.jsonl');
    await fsPromises.writeFile(realPath, [userLine('the real prompt'), summaryLine('real-summary')].join('\n') + '\n');

    const provider = new ClaudeCodeProvider();
    const sessions = await provider.discoverSessions();

    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe(UUID_C);
    // The session's metadata must come from the FALLBACK-synthesized record,
    // not the dropped stale index entry.
    expect(sessions[0].title).toBe('real-summary');
    expect(sessions[0].firstPrompt).toBe('the real prompt');
    expect(provider.buildReference(UUID_C)).toBe(realPath);
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

  it('caps in-flight stream reads so a project dir with thousands of session files cannot exhaust file descriptors', async () => {
    // Generate 200 distinct UUID sessions in a single project dir. The
    // FS_CONCURRENCY limiter is hard-coded at 32, so we should never observe
    // more than 32 concurrent in-flight reads regardless of how many sessions
    // we throw at the discovery pass.
    const writes: Array<Promise<void>> = [];
    for (let i = 0; i < 200; i++) {
      const uuid = `${i.toString(16).padStart(8, '0')}-aaaa-4aaa-aaaa-aaaaaaaaaaaa`;
      writes.push(fsPromises.writeFile(path.join(tmp.projectDir, `${uuid}.jsonl`), userLine(`session-${i}`)));
    }
    await Promise.all(writes);

    // Wrap fs.createReadStream so we can observe the in-flight count. The
    // limiter contract: at most FS_CONCURRENCY (= 32) streams open at once.
    const realCreate = fs.createReadStream;
    let inFlight = 0;
    let peak = 0;
    const spy = vi.spyOn(fs, 'createReadStream').mockImplementation(((path: fs.PathLike, options?: unknown) => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      const stream = realCreate(path, options as Parameters<typeof realCreate>[1]);
      const decrement = (): void => {
        inFlight--;
      };
      stream.once('end', decrement);
      stream.once('error', decrement);
      stream.once('close', decrement);
      return stream;
    }) as unknown as typeof fs.createReadStream);

    try {
      const provider = new ClaudeCodeProvider();
      const sessions = await provider.discoverSessions();
      expect(sessions.length).toBe(200);
      // Headroom: should be tightly bounded by the limiter (32). Allow a
      // small slop for the close-event timing race (the decrement fires
      // after the next stream has already incremented).
      expect(peak).toBeLessThanOrEqual(40);
    } finally {
      spy.mockRestore();
    }
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
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
      // Reinstate a fresh tmp for afterEach to tear down without error.
      tmp = await withTempHome();
    }
  });
});
