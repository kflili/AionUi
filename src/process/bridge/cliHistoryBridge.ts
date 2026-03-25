/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { ipcBridge } from '@/common';
import { ConfigStorage } from '@/common/config/storage';
import { getDataPath } from '@process/utils/utils';
import { getDatabase } from '@process/services/database/export';
import { convertClaudeJsonl } from '@process/cli-history/converters/claude';
import { convertCopilotJsonl } from '@process/cli-history/converters/copilot';

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

  // Codex uses: YYYY/MM/DD/rollout-{date}-{sessionId}.jsonl
  // We need to scan the date hierarchy
  let years;
  try {
    years = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    // ~/.codex/sessions/ doesn't exist or isn't readable
    return null;
  }

  for (const year of years.filter((e) => e.isDirectory())) {
    let months;
    try {
      months = await fs.readdir(path.join(sessionsDir, year.name), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const month of months.filter((e) => e.isDirectory())) {
      let days;
      try {
        days = await fs.readdir(path.join(sessionsDir, year.name, month.name), { withFileTypes: true });
      } catch {
        continue;
      }

      for (const day of days.filter((e) => e.isDirectory())) {
        const dayDir = path.join(sessionsDir, year.name, month.name, day.name);
        let files;
        try {
          files = await fs.readdir(dayDir);
        } catch {
          continue;
        }

        const match = files.find((f) => f.endsWith(`-${sessionId}.jsonl`));
        if (match) {
          return path.join(dayDir, match);
        }
      }
    }
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
 * Check if a CLI session is idle (waiting for user input) by reading the last
 * few lines of the JSONL file. Returns true if the last assistant message has
 * `stop_reason: 'end_turn'`, indicating the turn completed.
 *
 * @param sessionId - The ACP session ID
 * @param backend - The CLI backend type (claude, copilot, codex)
 * @param staleThresholdMs - Only consider idle if last modified > this many ms ago (default 10s)
 */
export async function isSessionIdle(sessionId: string, backend: string, staleThresholdMs = 10_000): Promise<boolean> {
  try {
    const filePath = await resolveSessionPath(sessionId, backend);
    if (!filePath) return false;

    const stat = await fs.stat(filePath);
    // Guard against race: if file was modified very recently, the turn may still be in progress
    if (Date.now() - stat.mtimeMs < staleThresholdMs) return false;

    // Read last 8KB — enough for the final few JSONL entries
    const handle = await fs.open(filePath, 'r');
    try {
      const fileSize = stat.size;
      const readSize = Math.min(8192, fileSize);
      const buffer = Buffer.alloc(readSize);
      const { bytesRead } = await handle.read(buffer, 0, readSize, Math.max(0, fileSize - readSize));
      const tail = buffer.subarray(0, bytesRead).toString('utf-8');
      const lines = tail.split('\n').filter(Boolean);

      // Scan from the end for the last assistant or user message
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'assistant' && entry.message?.stop_reason === 'end_turn') {
            return true;
          }
          if (entry.type === 'user') {
            return false; // Last entry is a user message — session should be processing
          }
        } catch {
          continue; // Malformed line (possibly truncated at read boundary)
        }
      }
    } finally {
      await handle.close();
    }
  } catch {
    // File not found, permission error, etc. — can't determine, assume not idle
  }
  return false;
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

  ipcBridge.cliHistory.convertSessionToMessages.provider(
    async ({ conversationId, sessionId, backend, terminalSwitchedAt }) => {
      try {
        // Only claude and copilot converters are currently implemented
        if (backend !== 'claude' && backend !== 'copilot') {
          return { success: false, msg: `JSONL conversion not supported for backend: ${backend}` };
        }

        // 1. Resolve JSONL file path
        const filePath = await resolveSessionPath(sessionId, backend);
        if (!filePath) {
          return { success: false, msg: `No JSONL file found for session ${sessionId} (backend: ${backend})` };
        }

        // 2. Read JSONL file
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        if (lines.length === 0) {
          return { success: true, data: { count: 0 } };
        }

        // 3. Read showThinking preference
        const agentCliConfig = await ConfigStorage.get('agentCli.config');
        const showThinking = agentCliConfig?.showThinking ?? false;
        const converterOptions = { showThinking };

        // 4. Convert to TMessages using the appropriate converter
        const allMessages =
          backend === 'copilot'
            ? convertCopilotJsonl(lines, conversationId, converterOptions)
            : convertClaudeJsonl(lines, conversationId, converterOptions);

        // 5. Only insert messages from the terminal session period.
        // terminalSwitchedAt marks when the user switched to terminal mode —
        // only import messages newer than this boundary to avoid duplicating
        // ACP-rendered messages.
        const db = getDatabase();

        let inserted = 0;
        for (const msg of allMessages) {
          if ((msg.createdAt ?? 0) > terminalSwitchedAt) {
            const result = db.insertMessage(msg);
            if (result?.success !== false) {
              inserted++;
            }
          }
        }

        return { success: true, data: { count: inserted } };
      } catch (err) {
        return { success: false, msg: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}
