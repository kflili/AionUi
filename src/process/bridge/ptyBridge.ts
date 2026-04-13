/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { getTerminalSessionManager, sanitizeProcessEnv } from '@process/task/TerminalSessionManager';
import { ProcessConfig } from '@process/utils/initStorage';
import { injectCopilotGatewayEnv } from '@process/agent/acp/acpConnectors';

const TAG = '[ptyBridge]';

/** Read max terminal sessions from ProcessConfig (direct file read, no IPC). */
async function readMaxSessions(): Promise<number> {
  try {
    const config = await ProcessConfig.get('agentCli.config');
    return config?.maxTerminalSessions ?? 10;
  } catch {
    return 10;
  }
}

export function initPtyBridge(): void {
  const manager = getTerminalSessionManager();

  // Clean up orphaned PTY processes from previous crashes
  manager.cleanupOrphans();

  // Load max session limit at init
  readMaxSessions().then((max) => manager.setMaxSessions(max));

  ipcBridge.pty.spawn.provider(async ({ conversationId, command, args, cwd, cols, rows }) => {
    console.log(`${TAG} spawn: conv=${conversationId}, cmd=${command}, args=${JSON.stringify(args)}`);
    try {
      // Read config before spawn (direct file read, safe to await)
      manager.setMaxSessions(await readMaxSessions());

      // Auto-detect copilot-gateway for Claude terminal sessions
      let env: Record<string, string> | undefined;
      if (command === 'claude') {
        env = sanitizeProcessEnv();
        const config = await ProcessConfig.get('agentCli.config');
        await injectCopilotGatewayEnv(env, config?.copilotGateway ?? true);
      }

      const result = manager.spawn({ conversationId, command, args, cwd, cols, rows, env });
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
