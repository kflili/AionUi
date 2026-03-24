/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pty from 'node-pty';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { ipcBridge } from '@/common';
import { getSystemDir } from '@process/utils/initStorage';

/** Strip ANSI escape sequences from terminal output for plain-text transcripts. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(\x07|\x1b\\)|\x1b[()][AB012]|\x1b[>=<]|\x1b\x37|\x1b\x38/g, '');
}

interface TerminalSession {
  process: pty.IPty;
  conversationId: string;
  pid: number;
  transcriptPath: string;
  transcriptStream: fs.WriteStream;
}

/**
 * Manages PTY terminal sessions in the main process.
 * Separate from BaseAgentManager — PTY needs resize events, raw I/O,
 * and shell exit detection which ForkTask does not provide.
 */
export class TerminalSessionManager {
  private sessions = new Map<string, TerminalSession>();
  private pidFilePath: string;

  constructor() {
    const dataDir = this.getDataDir();
    this.pidFilePath = path.join(dataDir, 'terminal-pids.json');
  }

  /** Clean up orphaned PTY processes from previous crashes. Call on app launch. */
  cleanupOrphans(): void {
    try {
      if (!fs.existsSync(this.pidFilePath)) return;
      const raw = fs.readFileSync(this.pidFilePath, 'utf-8');
      const pids: number[] = JSON.parse(raw);
      for (const pid of pids) {
        try {
          // Check if process is still alive (signal 0 = test only)
          process.kill(pid, 0);
          // Process exists — kill it
          process.kill(pid, 'SIGTERM');
          console.log(`[TerminalSessionManager] Killed orphaned PTY process: ${pid}`);
        } catch {
          // Process already dead — ignore
        }
      }
    } catch (err) {
      console.error('[TerminalSessionManager] Failed to cleanup orphans:', err);
    } finally {
      // Clear PID file
      this.savePids();
    }
  }

  /** Spawn a PTY process for a conversation. */
  spawn(params: {
    conversationId: string;
    command: string;
    args: string[];
    cwd?: string;
    cols?: number;
    rows?: number;
  }): { pid: number } {
    const { conversationId, command, args, cwd, cols = 80, rows = 24 } = params;

    // Kill existing session for this conversation
    if (this.sessions.has(conversationId)) {
      this.kill(conversationId);
    }

    const shell = command || this.getDefaultShell();
    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || os.homedir(),
      env: process.env as Record<string, string>,
    });

    // Set up transcript
    const transcriptDir = this.getTranscriptDir();
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, `${conversationId}.txt`);
    const transcriptStream = fs.createWriteStream(transcriptPath, { flags: 'a' });

    const session: TerminalSession = {
      process: ptyProcess,
      conversationId,
      pid: ptyProcess.pid,
      transcriptPath,
      transcriptStream,
    };

    this.sessions.set(conversationId, session);
    this.savePids();

    // Stream output to renderer and transcript
    ptyProcess.onData((data: string) => {
      ipcBridge.pty.output.emit({ conversationId, data });
      // Append stripped output to transcript
      const clean = stripAnsi(data);
      if (clean) {
        transcriptStream.write(clean);
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      ipcBridge.pty.exit.emit({ conversationId, exitCode, signal });
      this.cleanupSession(conversationId);
    });

    return { pid: ptyProcess.pid };
  }

  /** Write data to PTY stdin. */
  write(conversationId: string, data: string): boolean {
    const session = this.sessions.get(conversationId);
    if (!session) return false;
    session.process.write(data);
    return true;
  }

  /** Resize PTY. */
  resize(conversationId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(conversationId);
    if (!session) return false;
    session.process.resize(cols, rows);
    return true;
  }

  /** Kill PTY process for a conversation. */
  kill(conversationId: string): boolean {
    const session = this.sessions.get(conversationId);
    if (!session) return false;
    try {
      session.process.kill();
    } catch {
      // Process may have already exited
    }
    this.cleanupSession(conversationId);
    return true;
  }

  /** Check if a conversation has an active terminal session. */
  hasSession(conversationId: string): boolean {
    return this.sessions.has(conversationId);
  }

  /** Kill all sessions (for app shutdown). */
  killAll(): void {
    for (const conversationId of this.sessions.keys()) {
      this.kill(conversationId);
    }
  }

  private cleanupSession(conversationId: string): void {
    const session = this.sessions.get(conversationId);
    if (session) {
      session.transcriptStream.end();
      this.sessions.delete(conversationId);
      this.savePids();
    }
  }

  private savePids(): void {
    try {
      const dir = path.dirname(this.pidFilePath);
      fs.mkdirSync(dir, { recursive: true });
      const pids = Array.from(this.sessions.values()).map((s) => s.pid);
      fs.writeFileSync(this.pidFilePath, JSON.stringify(pids));
    } catch (err) {
      console.error('[TerminalSessionManager] Failed to save PIDs:', err);
    }
  }

  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'powershell.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }

  private getDataDir(): string {
    try {
      return getSystemDir().workDir;
    } catch {
      return path.join(os.homedir(), '.aionui');
    }
  }

  private getTranscriptDir(): string {
    return path.join(this.getDataDir(), 'terminal-transcripts');
  }
}

/** Singleton instance */
let instance: TerminalSessionManager | undefined;

export function getTerminalSessionManager(): TerminalSessionManager {
  if (!instance) {
    instance = new TerminalSessionManager();
  }
  return instance;
}
