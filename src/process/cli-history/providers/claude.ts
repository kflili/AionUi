/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
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
 * SessionSourceProvider implementation for Claude Code CLI.
 *
 * Discovers sessions by scanning all project directories under ~/.claude/projects/
 * for sessions-index.json files, then reading individual .jsonl transcript files.
 */
export class ClaudeCodeProvider extends BaseSessionSourceProvider {
  readonly id = 'claude_code' as const;

  /**
   * Scan all Claude Code project directories for sessions-index.json files
   * and return normalized metadata for every discovered session.
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

    return allSessions;
  }
}
