/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { getTerminalSessionManager } from '@process/task/TerminalSessionManager';

const TAG = '[ptyBridge]';

export function initPtyBridge(): void {
  const manager = getTerminalSessionManager();

  // Clean up orphaned PTY processes from previous crashes
  manager.cleanupOrphans();

  ipcBridge.pty.spawn.provider(async ({ conversationId, command, args, cwd, cols, rows }) => {
    console.log(`${TAG} spawn: conv=${conversationId}, cmd=${command}, args=${JSON.stringify(args)}`);
    try {
      const result = manager.spawn({ conversationId, command, args, cwd, cols, rows });
      console.log(`${TAG} spawn success: conv=${conversationId}, pid=${result.pid}`);
      return { success: true, data: { pid: result.pid } };
    } catch (err) {
      console.error(`${TAG} spawn failed: conv=${conversationId}`, err);
      return { success: false, msg: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcBridge.pty.write.provider(async ({ conversationId, data }) => {
    const ok = manager.write(conversationId, data);
    if (!ok) {
      console.warn(`${TAG} write failed: no session for conv=${conversationId}`);
    }
    return ok ? { success: true } : { success: false, msg: 'No active terminal session' };
  });

  ipcBridge.pty.resize.provider(async ({ conversationId, cols, rows }) => {
    const ok = manager.resize(conversationId, cols, rows);
    return ok ? { success: true } : { success: false, msg: 'No active terminal session' };
  });

  ipcBridge.pty.kill.provider(async ({ conversationId }) => {
    console.log(`${TAG} kill: conv=${conversationId}`);
    const ok = manager.kill(conversationId);
    console.log(`${TAG} kill result: conv=${conversationId}, ok=${ok}`);
    return ok ? { success: true } : { success: false, msg: 'No active terminal session' };
  });

  ipcBridge.pty.detach.provider(async ({ conversationId }) => {
    console.log(`${TAG} detach: conv=${conversationId}`);
    const ok = manager.detach(conversationId);
    return ok ? { success: true } : { success: false, msg: 'No active terminal session' };
  });

  ipcBridge.pty.reattach.provider(async ({ conversationId }) => {
    console.log(`${TAG} reattach: conv=${conversationId}`);
    const result = manager.reattach(conversationId);
    return { success: true, data: result };
  });
}
