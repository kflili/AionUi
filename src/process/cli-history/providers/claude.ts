/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import readline from 'readline';
import type { SessionMetadata } from '../types';
import { BaseSessionSourceProvider } from './base';

/**
 * Shape of a single entry in Claude Code's sessions-index.json file.
 * Matches the native format written by Claude Code CLI.
 */
type ClaudeSessionIndexEntry = {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
};

/**
 * Shape of Claude Code's sessions-index.json file.
 */
type ClaudeSessionIndex = {
  version: number;
  entries: ClaudeSessionIndexEntry[];
  originalPath: string;
};

/** Canonical UUID v4-ish pattern used by Claude Code session ids. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the base directory for Claude Code session storage.
 * - macOS/Linux: ~/.claude/projects/
 * - Windows: %USERPROFILE%\.claude\projects\
 */
function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Convert a ClaudeSessionIndexEntry to the normalized SessionMetadata format.
 */
function entryToMetadata(entry: ClaudeSessionIndexEntry): SessionMetadata {
  return {
    id: entry.sessionId,
    title: entry.summary,
    firstPrompt: entry.firstPrompt,
    createdAt: entry.created,
    updatedAt: entry.modified,
    messageCount: entry.messageCount,
    filePath: entry.fullPath,
    workspace: entry.projectPath,
    source: 'claude_code',
  };
}

/**
 * Decode a Claude Code project-dir basename back into a workspace path.
 *
 * Claude Code names per-project directories under `~/.claude/projects/` using a
 * leading `-` plus a path with `/` substituted by `-`, e.g.
 * `-Users-lili-Projects-claude-toolkit` ↔ `/Users/lili/Projects/claude-toolkit`.
 *
 * Limitation: the encoding is lossy when the original path contains literal `-`
 * characters (e.g. `claude-toolkit` collapses with `claude/toolkit`) or
 * whitespace (which Claude Code currently appears to drop or substitute).
 * This decoder produces a slash-separated approximation; if a user-facing
 * display needs the exact original, prefer the `cwd` field stored inside
 * the JSONL itself.
 */
export function decodeProjectPath(dirBasename: string): string {
  if (!dirBasename) return '';
  const trimmed = dirBasename.startsWith('-') ? dirBasename.slice(1) : dirBasename;
  return '/' + trimmed.replace(/-/g, '/');
}

/**
 * Pick the canonical .jsonl transcript inside a session directory.
 *
 * Claude Code's newer dir layout stores per-session transcripts under
 * `<sessionDir>/subagents/agent-*.jsonl` (and may add other subdirs later).
 * The "main" transcript is conventionally the largest .jsonl in the tree;
 * if multiple .jsonls have the same size we prefer one outside `subagents/`
 * (the main session usually outweighs sub-agent transcripts).
 *
 * Returns the absolute path of the chosen file, or `null` if no .jsonl exists.
 */
export async function pickCanonicalJsonlInDir(sessionDir: string): Promise<string | null> {
  type Candidate = { filePath: string; size: number; underSubagents: boolean };

  // First walk the tree synchronously to enumerate `.jsonl` paths, then stat
  // them in parallel. Splitting these two phases keeps the recursion simple
  // while still parallelizing the per-file fs calls.
  const jsonlPaths: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subWalks: Array<Promise<void>> = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        subWalks.push(walk(fullPath));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        jsonlPaths.push(fullPath);
      }
    }
    await Promise.all(subWalks);
  }

  await walk(sessionDir);
  if (jsonlPaths.length === 0) return null;

  const candidates: Candidate[] = (
    await Promise.all(
      jsonlPaths.map(async (filePath): Promise<Candidate | null> => {
        try {
          const stat = await fsPromises.stat(filePath);
          // Use path.relative + segment check rather than substring `includes`
          // so an unrelated `subagents` ancestor in the absolute path can't
          // mis-tag a file (e.g. `/Users/x/subagents-archive/...`).
          const relSegments = path.relative(sessionDir, filePath).split(path.sep);
          return { filePath, size: stat.size, underSubagents: relSegments.includes('subagents') };
        } catch {
          // Skip unreadable files
          return null;
        }
      })
    )
  ).filter((c): c is Candidate => c !== null);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.size !== b.size) return b.size - a.size;
    if (a.underSubagents !== b.underSubagents) return a.underSubagents ? 1 : -1;
    return a.filePath.localeCompare(b.filePath);
  });
  return candidates[0].filePath;
}

/**
 * Synthesize SessionMetadata from a JSONL transcript file when the project
 * has no `sessions-index.json` (or the index is stale).
 *
 * Streams the file line-by-line via a `readline` interface so memory stays
 * bounded by the longest line (not the file size — Claude Code session files
 * commonly run to many MB once they include verbose tool outputs). Extracts:
 *  - `firstPrompt`: first line where `type === 'user'` and `message.role === 'user'`
 *    with a string `content`
 *  - `summary`: latest line where `type === 'summary'` carries a string `summary`
 *    (we walk to EOF because newer summary lines override older ones)
 *  - `messageCount`: count of non-empty lines
 *  - `createdAt` / `updatedAt`: file `birthtime` / `mtime` ISO strings
 *
 * Returns `null` on read error, empty file, or no parseable line — caller skips.
 */
export async function synthesizeFromJsonl(
  filePath: string,
  sessionId: string,
  projectDir: string
): Promise<SessionMetadata | null> {
  let stat: import('fs').Stats;
  try {
    stat = await fsPromises.stat(filePath);
  } catch {
    return null;
  }
  if (stat.size === 0) return null;

  let firstPrompt = '';
  let summary = '';
  let parsedAny = false;
  let messageCount = 0;

  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  } catch {
    return null;
  }
  // `crlfDelay: Infinity` so `\r\n`-terminated lines (Windows-written transcripts)
  // are emitted as a single line event instead of two.
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      messageCount += 1;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      parsedAny = true;
      const obj = parsed as Record<string, unknown>;

      if (!firstPrompt && obj.type === 'user') {
        const msg = obj.message as { role?: string; content?: unknown } | undefined;
        if (msg && msg.role === 'user' && typeof msg.content === 'string') {
          firstPrompt = msg.content;
        }
      }
      // Latest summary wins — keep overwriting as we walk forward.
      if (obj.type === 'summary' && typeof obj.summary === 'string') {
        summary = obj.summary;
      }
    }
  } catch {
    // Mid-stream read error — fall through with whatever we managed to parse.
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!parsedAny) return null;

  // Title fallback chain: explicit summary line → first 80 chars of
  // firstPrompt → file's session UUID (least useful, but never empty).
  const titleSource = summary || firstPrompt || sessionId;
  const title = titleSource.length > 80 ? titleSource.slice(0, 80) : titleSource;

  return {
    id: sessionId,
    title,
    firstPrompt,
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    messageCount,
    filePath,
    workspace: decodeProjectPath(path.basename(projectDir)),
    source: 'claude_code',
  };
}

/**
 * SessionSourceProvider implementation for Claude Code CLI.
 *
 * Discovers sessions in two passes per project directory:
 *   1. Read `sessions-index.json` if present (Claude Code's native index format).
 *   2. Fallback: scan the directory for `<UUID>.jsonl` files and `<UUID>/`
 *      subdirectories (newer dir layout) whose UUIDs are NOT already covered
 *      by the index. Synthesizes metadata from the JSONL contents directly.
 *
 * The fallback is required because newer Claude Code CLI builds no longer
 * write `sessions-index.json` for fresh project dirs, leaving any importer
 * that relies on it alone with a stale snapshot of the user's history.
 */
export class ClaudeCodeProvider extends BaseSessionSourceProvider {
  readonly id = 'claude_code' as const;

  /**
   * Scan all Claude Code project directories for sessions, combining
   * index-based and JSONL-fallback discovery.
   */
  async discoverSessions(): Promise<SessionMetadata[]> {
    const projectsDir = getClaudeProjectsDir();

    let projectDirs: string[];
    try {
      const entries = await fsPromises.readdir(projectsDir, { withFileTypes: true });
      projectDirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(projectsDir, e.name));
    } catch {
      // ~/.claude/projects/ doesn't exist — Claude Code not installed or never used
      return [];
    }

    const allSessions: SessionMetadata[] = [];

    // Pass 1: index-based discovery (preserved verbatim from previous behavior).
    for (const dir of projectDirs) {
      const indexPath = path.join(dir, 'sessions-index.json');
      try {
        const raw = await fsPromises.readFile(indexPath, 'utf-8');
        const index: ClaudeSessionIndex = JSON.parse(raw);

        for (const entry of index.entries) {
          this.sessionPaths.set(entry.sessionId, entry.fullPath);
          allSessions.push(entryToMetadata(entry));
        }
      } catch {
        // No index file in this project directory or malformed JSON — skip silently
      }
    }

    // Pass 2: JSONL-fallback discovery for sessions absent from the index.
    // Run per-project-dir scans in parallel — each project dir owns a disjoint
    // set of session UUIDs, so there is no cross-dir mutation hazard. Within
    // a single dir we still walk sub-passes (a) and (b) sequentially because
    // they share the same `dirIndexed` dedup set.
    const indexedIds = new Set(allSessions.map((s) => s.id));

    type FallbackHit = { sessionId: string; canonicalPath: string; meta: SessionMetadata };

    const perDirHits = await Promise.all(
      projectDirs.map(async (dir): Promise<FallbackHit[]> => {
        let entries: import('fs').Dirent[];
        try {
          entries = await fsPromises.readdir(dir, { withFileTypes: true });
        } catch {
          return [];
        }

        const dirIndexed = new Set(indexedIds);
        const hits: FallbackHit[] = [];

        // (a) Top-level `<UUID>.jsonl` files. Synthesize in parallel; the
        //     dedup against `dirIndexed` happens before the await, so a single
        //     UUID is processed at most once per project dir.
        const topLevelTasks: Array<Promise<FallbackHit | null>> = [];
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          const sessionId = path.basename(entry.name, '.jsonl');
          if (!UUID_RE.test(sessionId) || dirIndexed.has(sessionId)) continue;
          dirIndexed.add(sessionId);
          const fullPath = path.join(dir, entry.name);
          topLevelTasks.push(
            synthesizeFromJsonl(fullPath, sessionId, dir).then((meta) =>
              meta ? { sessionId, canonicalPath: fullPath, meta } : null
            )
          );
        }
        for (const hit of await Promise.all(topLevelTasks)) {
          if (hit) hits.push(hit);
        }

        // (b) Newer `<UUID>/...jsonl` directory layout.
        const dirTasks: Array<Promise<FallbackHit | null>> = [];
        for (const entry of entries) {
          if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
          const sessionId = entry.name;
          if (dirIndexed.has(sessionId)) continue;
          dirIndexed.add(sessionId);
          const sessionDir = path.join(dir, sessionId);
          dirTasks.push(
            (async (): Promise<FallbackHit | null> => {
              const canonical = await pickCanonicalJsonlInDir(sessionDir);
              if (!canonical) return null;
              const meta = await synthesizeFromJsonl(canonical, sessionId, dir);
              return meta ? { sessionId, canonicalPath: canonical, meta } : null;
            })()
          );
        }
        for (const hit of await Promise.all(dirTasks)) {
          if (hit) hits.push(hit);
        }

        return hits;
      })
    );

    for (const hits of perDirHits) {
      for (const { sessionId, canonicalPath, meta } of hits) {
        // Guard against cross-dir UUID collisions (vanishingly unlikely with
        // proper UUIDs, but the contract is explicit: index pass wins).
        if (indexedIds.has(sessionId)) continue;
        this.sessionPaths.set(sessionId, canonicalPath);
        allSessions.push(meta);
        indexedIds.add(sessionId);
      }
    }

    return allSessions;
  }
}
