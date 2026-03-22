/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import type { SessionMetadata, SessionSourceProvider } from '../types';

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
export class ClaudeCodeProvider implements SessionSourceProvider {
  readonly id = 'claude_code' as const;

  /**
   * In-memory lookup from session ID to its absolute JSONL file path.
   * Populated during discoverSessions() and used by readTranscript/canResume/buildReference.
   */
  private sessionPaths = new Map<string, string>();

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

  /**
   * Read the JSONL transcript for a session and return individual lines.
   * Requires discoverSessions() to have been called first to populate the path lookup.
   */
  async readTranscript(sessionId: string): Promise<string[]> {
    const filePath = this.resolveSessionPath(sessionId);
    const content = await fsPromises.readFile(filePath, 'utf-8');
    return content.split('\n').filter((line) => line.trim().length > 0);
  }

  /**
   * Check whether the session's JSONL transcript file exists on disk.
   */
  canResume(sessionId: string): boolean {
    const filePath = this.sessionPaths.get(sessionId);
    if (!filePath) return false;

    try {
      fs.accessSync(filePath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Return the absolute file path to the session's JSONL transcript.
   * Used by the Copy Chat Reference feature.
   */
  buildReference(sessionId: string): string {
    return this.resolveSessionPath(sessionId);
  }

  /**
   * Look up the absolute JSONL path for a session ID.
   * Throws if the session has not been discovered yet.
   */
  private resolveSessionPath(sessionId: string): string {
    const filePath = this.sessionPaths.get(sessionId);
    if (!filePath) {
      throw new Error(`Session not found: ${sessionId}. Call discoverSessions() first.`);
    }
    return filePath;
  }
}
