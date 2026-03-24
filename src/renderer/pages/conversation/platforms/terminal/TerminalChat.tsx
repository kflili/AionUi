/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { AcpBackend } from '@/common/types/acpTypes';
import React, { useEffect, useState } from 'react';
import TerminalComponent from './TerminalComponent';

/** Build the CLI resume command and args for terminal mode. */
function getTerminalResumeCommand(
  backend: AcpBackend,
  sessionId: string | undefined,
  cliPath: string | undefined
): { command: string; args: string[] } {
  const cmd = cliPath || backend;

  switch (backend) {
    case 'claude':
      return sessionId ? { command: cmd, args: ['--resume', sessionId] } : { command: cmd, args: [] };
    case 'copilot':
      return sessionId ? { command: cmd, args: [`--resume=${sessionId}`] } : { command: cmd, args: [] };
    case 'codex':
      return sessionId ? { command: cmd, args: ['resume', '--session-id', sessionId] } : { command: cmd, args: [] };
    default:
      // Generic fallback: try --resume flag
      return sessionId ? { command: cmd, args: ['--resume', sessionId] } : { command: cmd, args: [] };
  }
}

const TerminalChat: React.FC<{
  conversationId: string;
  workspace?: string;
  backend: AcpBackend;
  acpSessionId?: string;
  cliPath?: string;
}> = ({ conversationId, workspace, backend, acpSessionId: propSessionId, cliPath }) => {
  // Fetch the latest conversation from DB to get a fresh acpSessionId,
  // since the prop may come from stale SWR cache
  const [resolved, setResolved] = useState<{ command: string; args: string[] } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const resolve = async () => {
      // Fetch fresh conversation data to get the latest acpSessionId
      const fresh = await ipcBridge.conversation.get.invoke({ id: conversationId }).catch((): null => null);
      if (cancelled) return;

      const freshExtra = fresh?.type === 'acp' ? fresh.extra : undefined;
      const sessionId = freshExtra?.acpSessionId || propSessionId;
      const resolvedCliPath = freshExtra?.cliPath || cliPath;

      setResolved(getTerminalResumeCommand(backend, sessionId, resolvedCliPath));
    };

    resolve();
    return () => {
      cancelled = true;
    };
  }, [conversationId, backend, propSessionId, cliPath]);

  if (!resolved) return null;

  return (
    <div className='flex-1 flex flex-col min-h-0 bg-[#1e1e1e]'>
      <TerminalComponent
        conversationId={conversationId}
        command={resolved.command}
        args={resolved.args}
        cwd={workspace}
      />
    </div>
  );
};

export default TerminalChat;
