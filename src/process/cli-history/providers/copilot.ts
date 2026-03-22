/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import type { SessionMetadata, SessionSourceProvider } from '../types';

/**
 * Shape of a single row in Copilot CLI's session-store.db `sessions` table.
 */
type CopilotSessionRow = {
  id: string;
  cwd: string;
  repository: string;
  branch: string;
  summary: string;
  created_at: string;
  updated_at: string;
  host_type: string;
};

/**
 * Resolve the base directory for Copilot CLI session storage.
 * - macOS/Linux: ~/.copilot/
 * - Windows: %USERPROFILE%\.copilot\
 */
function getCopilotBaseDir(): string {
  return path.join(os.homedir(), '.copilot');
}

/**
 * Resolve the path to a session's events.jsonl file.
 */
function getSessionEventsPath(sessionId: string): string {
  return path.join(getCopilotBaseDir(), 'session-state', sessionId, 'events.jsonl');
}

/**
 * Convert a CopilotSessionRow to the normalized SessionMetadata format.
 */
function rowToMetadata(row: CopilotSessionRow): SessionMetadata {
  return {
    id: row.id,
    title: row.summary || '(untitled)',
    firstPrompt: row.summary || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: 0,
    filePath: getSessionEventsPath(row.id),
    workspace: row.cwd || '',
    source: 'copilot',
  };
}

/**
 * SessionSourceProvider implementation for GitHub Copilot CLI.
 *
 * Discovers sessions by reading the SQLite database at ~/.copilot/session-store.db,
 * then reading individual events.jsonl files under ~/.copilot/session-state/{sessionId}/.
 */
export class CopilotProvider implements SessionSourceProvider {
  readonly id = 'copilot' as const;

  /**
   * In-memory lookup from session ID to its absolute events.jsonl file path.
   * Populated during discoverSessions() and used by readTranscript/canResume/buildReference.
   */
  private sessionPaths = new Map<string, string>();

  /**
   * Scan Copilot CLI's session-store.db for all sessions
   * and return normalized metadata for every discovered session.
   */
  async discoverSessions(): Promise<SessionMetadata[]> {
    const dbPath = path.join(getCopilotBaseDir(), 'session-store.db');

    let db: Database.Database | null = null;
    try {
      // Open in read-only mode — we never modify Copilot's database
      db = new BetterSqlite3(dbPath, { readonly: true });

      const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as CopilotSessionRow[];

      const allSessions: SessionMetadata[] = [];
      for (const row of rows) {
        const eventsPath = getSessionEventsPath(row.id);
        this.sessionPaths.set(row.id, eventsPath);
        allSessions.push(rowToMetadata(row));
      }

      return allSessions;
    } catch {
      // ~/.copilot/session-store.db doesn't exist or is unreadable — Copilot CLI not installed
      return [];
    } finally {
      db?.close();
    }
  }

  /**
   * Read the events.jsonl transcript for a session and return individual lines.
   * Requires discoverSessions() to have been called first to populate the path lookup.
   */
  async readTranscript(sessionId: string): Promise<string[]> {
    const filePath = this.resolveSessionPath(sessionId);
    const content = await fsPromises.readFile(filePath, 'utf-8');
    return content.split('\n').filter((line) => line.trim().length > 0);
  }

  /**
   * Check whether the session's events.jsonl file exists on disk.
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
   * Return the absolute file path to the session's events.jsonl file.
   * Used by the Copy Chat Reference feature.
   */
  buildReference(sessionId: string): string {
    return this.resolveSessionPath(sessionId);
  }

  /**
   * Look up the absolute events.jsonl path for a session ID.
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
