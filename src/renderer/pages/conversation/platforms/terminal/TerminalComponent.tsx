/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { ConfigStorage } from '@/common/config/storage';
import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

const TerminalComponent: React.FC<{
  conversationId: string;
  command: string;
  args: string[];
  cwd?: string;
}> = ({ conversationId, command, args, cwd }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const mountedRef = useRef(false);

  const handleResize = useCallback(() => {
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    if (!fitAddon || !terminal) return;

    try {
      fitAddon.fit();
      ipcBridge.pty.resize.invoke({
        conversationId,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    } catch {
      // Ignore resize errors during teardown
    }
  }, [conversationId]);

  useEffect(() => {
    if (!containerRef.current || mountedRef.current) return;
    mountedRef.current = true;

    const initTerminal = async () => {
      // Load font size from settings
      const config = await ConfigStorage.get('agentCli.config');
      const fontSize = config?.fontSize || 14;

      const terminal = new Terminal({
        fontSize,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: {
          background: '#1e1e1e',
          foreground: '#d4d4d4',
          cursor: '#d4d4d4',
          cursorAccent: '#1e1e1e',
          selectionBackground: 'rgba(255, 255, 255, 0.3)',
        },
        cursorBlink: true,
        scrollback: 10000,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      terminal.open(containerRef.current!);

      // Try loading WebGL addon for better performance
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
        });
        terminal.loadAddon(webglAddon);
      } catch {
        // WebGL not available, canvas renderer will be used
      }

      fitAddon.fit();

      // Listen for PTY output
      const unsubOutput = ipcBridge.pty.output.on((event) => {
        if (event.conversationId === conversationId && event.data) {
          terminal.write(event.data);
        }
      });

      // Listen for PTY exit
      const unsubExit = ipcBridge.pty.exit.on((event) => {
        if (event.conversationId === conversationId) {
          terminal.write(`\r\n\x1b[90m[Process exited with code ${event.exitCode}]\x1b[0m\r\n`);
        }
      });

      // Forward keyboard input to PTY
      terminal.onData((data: string) => {
        ipcBridge.pty.write.invoke({ conversationId, data });
      });

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        handleResize();
      });
      resizeObserver.observe(containerRef.current!);

      // Spawn PTY process
      await ipcBridge.pty.spawn.invoke({
        conversationId,
        command,
        args,
        cwd,
        cols: terminal.cols,
        rows: terminal.rows,
      });

      terminal.focus();

      // Store cleanup references
      (containerRef.current as HTMLDivElement & { _cleanup?: () => void })._cleanup = () => {
        unsubOutput();
        unsubExit();
        resizeObserver.disconnect();
        terminal.dispose();
        ipcBridge.pty.kill.invoke({ conversationId });
      };
    };

    initTerminal();

    return () => {
      const el = containerRef.current as (HTMLDivElement & { _cleanup?: () => void }) | null;
      el?._cleanup?.();
      mountedRef.current = false;
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [conversationId, command, args, cwd, handleResize]);

  return <div ref={containerRef} className='size-full' />;
};

export default TerminalComponent;
