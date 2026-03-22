/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import type { SessionMetadata } from '../types';
import { BaseSessionSourceProvider } from './base';

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
export class CopilotProvider extends BaseSessionSourceProvider {
  readonly id = 'copilot' as const;

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
}
