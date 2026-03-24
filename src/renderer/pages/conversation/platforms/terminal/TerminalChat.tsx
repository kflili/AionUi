/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { ConfigStorage } from '@/common/config/storage';
import type { AcpBackend } from '@/common/types/acpTypes';
import React, { useMemo } from 'react';
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
}> = ({ conversationId, workspace, backend, acpSessionId, cliPath }) => {
  const { command, args } = useMemo(() => {
    // Try to get stored CLI path from config if not provided
    const resolvedCliPath = cliPath;
    return getTerminalResumeCommand(backend, acpSessionId, resolvedCliPath);
  }, [backend, acpSessionId, cliPath]);

  return (
    <div className='flex-1 flex flex-col min-h-0 bg-[#1e1e1e]'>
      <TerminalComponent conversationId={conversationId} command={command} args={args} cwd={workspace} />
    </div>
  );
};

export default TerminalChat;
