/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { ipcBridge } from '@/common';
import { getDataPath } from '@process/utils/utils';

/**
 * Resolve a Claude Code session ID to its JSONL file path.
 * Scans ~/.claude/projects/{hash}/{sessionId}.jsonl
 */
async function resolveClaudeSessionPath(sessionId: string): Promise<string | null> {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    const projectDirs = entries.filter((entry) => entry.isDirectory());

    for (const dir of projectDirs) {
      const candidate = path.join(projectsDir, dir.name, `${sessionId}.jsonl`);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // File doesn't exist in this project dir, continue scanning
      }
    }
  } catch {
    // ~/.claude/projects/ doesn't exist or isn't readable
  }

  return null;
}

/**
 * Resolve a Copilot CLI session ID to its JSONL file path.
 * Path: ~/.copilot/session-state/{sessionId}/events.jsonl
 */
async function resolveCopilotSessionPath(sessionId: string): Promise<string | null> {
  const candidate = path.join(os.homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');

  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Resolve a Codex CLI session ID to its JSONL file path.
 * Scans ~/.codex/sessions/ recursively for rollout-*-{sessionId}.jsonl
 */
async function resolveCodexSessionPath(sessionId: string): Promise<string | null> {
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');

  try {
    // Codex uses: YYYY/MM/DD/rollout-{date}-{sessionId}.jsonl
    // We need to scan the date hierarchy
    const years = await fs.readdir(sessionsDir, { withFileTypes: true });

    for (const year of years.filter((e) => e.isDirectory())) {
      const months = await fs.readdir(path.join(sessionsDir, year.name), { withFileTypes: true });

      for (const month of months.filter((e) => e.isDirectory())) {
        const days = await fs.readdir(path.join(sessionsDir, year.name, month.name), { withFileTypes: true });

        for (const day of days.filter((e) => e.isDirectory())) {
          const dayDir = path.join(sessionsDir, year.name, month.name, day.name);
          const files = await fs.readdir(dayDir);

          const match = files.find((f) => f.endsWith(`-${sessionId}.jsonl`));
          if (match) {
            return path.join(dayDir, match);
          }
        }
      }
    }
  } catch {
    // ~/.codex/sessions/ doesn't exist or isn't readable
  }

  return null;
}

/**
 * Resolve a session ID to its JSONL file path based on the backend type.
 */
async function resolveSessionPath(sessionId: string, backend: string): Promise<string | null> {
  switch (backend) {
    case 'claude':
      return resolveClaudeSessionPath(sessionId);
    case 'copilot':
      return resolveCopilotSessionPath(sessionId);
    case 'codex':
      return resolveCodexSessionPath(sessionId);
    default:
      // Unknown backend — try Claude as default (most common ACP backend)
      return resolveClaudeSessionPath(sessionId);
  }
}

/**
 * Initialize IPC handlers for CLI history utilities.
 */
export function initCliHistoryBridge(): void {
  ipcBridge.cliHistory.resolveSessionFilePath.provider(async ({ sessionId, backend }) => {
    return resolveSessionPath(sessionId, backend);
  });

  ipcBridge.cliHistory.getDbPath.provider(async () => {
    return path.join(getDataPath(), 'aionui.db');
  });
}
