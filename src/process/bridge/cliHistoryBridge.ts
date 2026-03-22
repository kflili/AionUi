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
 * Scan ~/.claude/projects/ to find a JSONL file matching the given session ID.
 * Returns the absolute path if found, null otherwise.
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
 * Initialize IPC handlers for CLI history utilities.
 */
export function initCliHistoryBridge(): void {
  ipcBridge.cliHistory.resolveClaudeSessionFilePath.provider(async ({ sessionId }) => {
    return resolveClaudeSessionPath(sessionId);
  });

  ipcBridge.cliHistory.getDbPath.provider(async () => {
    return path.join(getDataPath(), 'aionui.db');
  });
}
