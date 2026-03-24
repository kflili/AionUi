/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { getTerminalSessionManager } from '@process/task/TerminalSessionManager';

export function initPtyBridge(): void {
  const manager = getTerminalSessionManager();

  // Clean up orphaned PTY processes from previous crashes
  manager.cleanupOrphans();

  ipcBridge.pty.spawn.provider(async ({ conversationId, command, args, cwd, cols, rows }) => {
    try {
      const result = manager.spawn({ conversationId, command, args, cwd, cols, rows });
      return { success: true, data: { pid: result.pid } };
    } catch (err) {
      return { success: false, msg: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcBridge.pty.write.provider(async ({ conversationId, data }) => {
    const ok = manager.write(conversationId, data);
    return ok ? { success: true } : { success: false, msg: 'No active terminal session' };
  });

  ipcBridge.pty.resize.provider(async ({ conversationId, cols, rows }) => {
    const ok = manager.resize(conversationId, cols, rows);
    return ok ? { success: true } : { success: false, msg: 'No active terminal session' };
  });

  ipcBridge.pty.kill.provider(async ({ conversationId }) => {
    const ok = manager.kill(conversationId);
    return ok ? { success: true } : { success: false, msg: 'No active terminal session' };
  });
}
