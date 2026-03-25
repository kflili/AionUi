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

const TAG = '[TerminalSessionManager]';

/** Strip ANSI escape sequences from terminal output for plain-text transcripts. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(\x07|\x1b\\)|\x1b[()][AB012]|\x1b[>=<]|\x1b\x37|\x1b\x38/g, '');
}

/**
 * Kill a process and its entire process group.
 * node-pty's kill() only sends SIGTERM to the PTY process, not to child
 * processes (e.g., `claude --resume`). We need to kill the process group
 * to prevent orphaned CLI processes.
 */
function killProcessTree(pid: number): void {
  try {
    // Kill the process group (negative PID targets the group)
    process.kill(-pid, 'SIGTERM');
    console.log(`${TAG} Killed process group for PID ${pid}`);
  } catch {
    // Process group kill failed — try individual process
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`${TAG} Killed individual PID ${pid} (group kill failed)`);
    } catch {
      // Process already dead
    }
  }
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
      const entries: Array<{ pid: number; startedAt: number }> = JSON.parse(raw);
      for (const entry of entries) {
        try {
          // Check if process is still alive (signal 0 = test only)
          process.kill(entry.pid, 0);
          // Only kill if started less than 7 days ago (avoids PID reuse from stale files)
          const ageMs = Date.now() - entry.startedAt;
          if (ageMs < 7 * 24 * 60 * 60 * 1000) {
            killProcessTree(entry.pid);
            console.log(`${TAG} Killed orphaned PTY process: ${entry.pid}`);
          }
        } catch {
          // Process already dead — ignore
        }
      }
    } catch (err) {
      console.error(`${TAG} Failed to cleanup orphans:`, err);
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
      console.log(`${TAG} Killing existing session before respawn: ${conversationId}`);
      this.kill(conversationId);
    }

    const shell = command || this.getDefaultShell();
    console.log(`${TAG} Spawning PTY: conv=${conversationId}, cmd=${shell}, args=${JSON.stringify(args)}, cwd=${cwd}`);

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
    console.log(`${TAG} PTY spawned: conv=${conversationId}, pid=${ptyProcess.pid}`);

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
      console.log(
        `${TAG} PTY exited: conv=${conversationId}, pid=${ptyProcess.pid}, code=${exitCode}, signal=${signal}`
      );
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
    if (!session) {
      console.log(`${TAG} Kill requested but no session found: ${conversationId}`);
      return false;
    }
    console.log(`${TAG} Killing PTY: conv=${conversationId}, pid=${session.pid}`);
    try {
      // Kill the PTY process via node-pty
      session.process.kill();
    } catch {
      // Process may have already exited
    }
    // Also kill the process tree to catch child processes (e.g., claude --resume)
    killProcessTree(session.pid);
    this.cleanupSession(conversationId);
    return true;
  }

  /** Check if a conversation has an active terminal session. */
  hasSession(conversationId: string): boolean {
    return this.sessions.has(conversationId);
  }

  /** Kill all sessions (for app shutdown). */
  killAll(): void {
    console.log(`${TAG} Killing all sessions (${this.sessions.size} active)`);
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
      console.log(`${TAG} Session cleaned up: ${conversationId}`);
    }
  }

  private savePids(): void {
    try {
      const dir = path.dirname(this.pidFilePath);
      fs.mkdirSync(dir, { recursive: true });
      const entries = Array.from(this.sessions.values()).map((s) => ({
        pid: s.pid,
        startedAt: Date.now(),
      }));
      fs.writeFileSync(this.pidFilePath, JSON.stringify(entries));
    } catch (err) {
      console.error(`${TAG} Failed to save PIDs:`, err);
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
