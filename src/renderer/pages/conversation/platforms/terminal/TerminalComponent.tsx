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

/**
 * Detect touch device (mobile/tablet) to skip WebGL and handle layout timing.
 * Intentionally simpler than detectMobileViewportOrTouch — WebGL should be
 * skipped on ANY touch device (including touch laptops) since WebGL rendering
 * issues are tied to touch capability, not viewport size.
 */
const isTouchDevice = (): boolean => 'ontouchstart' in window || navigator.maxTouchPoints > 0;

/** Ensure dimensions are at least 1 to prevent 0x0 PTY spawn on mobile */
const clampDimensions = (cols: number, rows: number): { cols: number; rows: number } => ({
  cols: Math.max(cols, 1),
  rows: Math.max(rows, 1),
});

const TerminalComponent: React.FC<{
  conversationId: string;
  command: string;
  args: string[];
  cwd?: string;
}> = ({ conversationId, command, args, cwd }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const handleResize = useCallback(() => {
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    if (!fitAddon || !terminal) return;

    try {
      fitAddon.fit();
      const { cols, rows } = clampDimensions(terminal.cols, terminal.rows);
      ipcBridge.pty.resize.invoke({ conversationId, cols, rows });
    } catch {
      // Ignore resize errors during teardown
    }
  }, [conversationId]);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let unsubOutput: (() => void) | undefined;
    let unsubExit: (() => void) | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let terminal: Terminal | undefined;

    const initTerminal = async () => {
      try {
        // Load font size from settings
        const config = await ConfigStorage.get('agentCli.config');
        if (disposed || !containerRef.current) return;

        const fontSize = config?.fontSize || 14;

        terminal = new Terminal({
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

        terminal.open(containerRef.current);

        // Skip WebGL on touch devices (mobile/tablet over remote HTTP)
        // to avoid rendering failures; canvas renderer is sufficient
        if (!isTouchDevice()) {
          try {
            const webglAddon = new WebglAddon();
            webglAddon.onContextLoss(() => {
              webglAddon.dispose();
            });
            terminal.loadAddon(webglAddon);
          } catch {
            // WebGL not available, canvas renderer will be used
          }
        }

        // Wait a frame for layout to stabilize before fitting
        // (prevents 0x0 dimensions on mobile where layout isn't ready yet)
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (disposed || !containerRef.current) return;

        fitAddon.fit();

        if (disposed) {
          terminal.dispose();
          return;
        }

        // Listen for PTY output
        unsubOutput = ipcBridge.pty.output.on((event) => {
          if (event.conversationId === conversationId && event.data) {
            terminal!.write(event.data);
          }
        });

        // Listen for PTY exit
        unsubExit = ipcBridge.pty.exit.on((event) => {
          if (event.conversationId === conversationId) {
            terminal!.write(`\r\n\x1b[90m[Process exited with code ${event.exitCode}]\x1b[0m\r\n`);
          }
        });

        // Forward keyboard input to PTY
        terminal.onData((data: string) => {
          ipcBridge.pty.write.invoke({ conversationId, data });
        });

        // Handle resize
        resizeObserver = new ResizeObserver(() => {
          handleResize();
        });
        resizeObserver.observe(containerRef.current);

        // Try to reattach to an existing session first (user navigated back)
        const reattachResult = await ipcBridge.pty.reattach.invoke({ conversationId });
        if (disposed) return;

        if (reattachResult?.success && reattachResult.data?.exists) {
          // Session exists — replay buffered output
          if (reattachResult.data.buffer) {
            terminal.write(reattachResult.data.buffer);
          }
          // Resize to current dimensions
          handleResize();
          terminal.focus();
          return;
        }

        // No existing session — spawn a new PTY
        const dims = clampDimensions(terminal.cols, terminal.rows);
        const result = await ipcBridge.pty.spawn.invoke({
          conversationId,
          command,
          args,
          cwd,
          cols: dims.cols,
          rows: dims.rows,
        });

        if (disposed) return;

        if (!result?.success) {
          terminal.write(`\r\n\x1b[31mFailed to start terminal: ${result?.msg || 'Unknown error'}\x1b[0m\r\n`);
          return;
        }

        terminal.focus();
      } catch (err) {
        if (!disposed && terminal) {
          terminal.write(`\r\n\x1b[31mTerminal error: ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`);
        }
      }
    };

    initTerminal();

    return () => {
      disposed = true;
      unsubOutput?.();
      unsubExit?.();
      resizeObserver?.disconnect();
      if (terminal) {
        terminal.dispose();
        // Detach instead of kill — PTY keeps running in background
        ipcBridge.pty.detach.invoke({ conversationId });
      }
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [conversationId, command, args, cwd, handleResize]);

  return <div ref={containerRef} className='size-full' />;
};

export default TerminalComponent;
