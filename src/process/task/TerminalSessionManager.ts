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
import { ConfigStorage } from '@/common/config/storage';
import { getSystemDir } from '@process/utils/initStorage';

const DEFAULT_MAX_SESSIONS = 10;

const TAG = '[TerminalSessionManager]';

/** Max buffer size in bytes when detached (~100KB) */
const MAX_BUFFER_BYTES = 100 * 1024;

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
    process.kill(-pid, 'SIGTERM');
    console.log(`${TAG} Killed process group for PID ${pid}`);
  } catch {
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
  /** Whether the renderer is currently listening (false = navigated away) */
  attached: boolean;
  /** Timestamp when session was last detached (for LRU eviction) */
  detachedAt?: number;
  /** Buffered output while renderer is detached */
  outputBuffer: string[];
  /** Current buffer size in bytes (for cap enforcement) */
  outputBufferBytes: number;
  /** Rolling buffer of ALL output for replay on reattach (xterm.js is destroyed on navigate) */
  scrollbackBuffer: string[];
  /** Current scrollback buffer size in bytes */
  scrollbackBufferBytes: number;
  /** Whether the PTY process has exited (session preserved for buffer replay) */
  exited: boolean;
}

/**
 * Manages PTY terminal sessions in the main process.
 * Separate from BaseAgentManager — PTY needs resize events, raw I/O,
 * and shell exit detection which ForkTask does not provide.
 *
 * Sessions persist when the user navigates away (detach) and resume
 * when they navigate back (reattach). The PTY is only killed when
 * the user explicitly switches to Rich UI mode or deletes the conversation.
 */
export class TerminalSessionManager {
  private sessions = new Map<string, TerminalSession>();
  private pidFilePath: string;

  constructor() {
    const dataDir = this.getDataDir();
    this.pidFilePath = path.join(dataDir, 'terminal-pids.json');
    this.refreshMaxSessions();
  }

  /** Clean up orphaned PTY processes from previous crashes. Call on app launch. */
  cleanupOrphans(): void {
    try {
      if (!fs.existsSync(this.pidFilePath)) return;
      const raw = fs.readFileSync(this.pidFilePath, 'utf-8');
      const entries: Array<{ pid: number; startedAt: number }> = JSON.parse(raw);
      for (const entry of entries) {
        try {
          process.kill(entry.pid, 0);
          const ageMs = Date.now() - entry.startedAt;
          if (ageMs < 7 * 24 * 60 * 60 * 1000) {
            killProcessTree(entry.pid);
            console.log(`${TAG} Killed orphaned PTY process: ${entry.pid}`);
          }
        } catch {
          // Process already dead
        }
      }
    } catch (err) {
      console.error(`${TAG} Failed to cleanup orphans:`, err);
    } finally {
      this.savePids();
    }
  }

  /** Spawn a PTY process for a conversation. Async to read config for session limit. */
  async spawn(params: {
    conversationId: string;
    command: string;
    args: string[];
    cwd?: string;
    cols?: number;
    rows?: number;
  }): Promise<{ pid: number }> {
    const { conversationId, command, args, cwd, cols: rawCols = 80, rows: rawRows = 24 } = params;
    // Clamp to minimum 1 — prevents 0x0 PTY from mobile layout timing issues
    const cols = Math.max(rawCols, 1);
    const rows = Math.max(rawRows, 1);

    if (this.sessions.has(conversationId)) {
      console.log(`${TAG} Killing existing session before respawn: ${conversationId}`);
      this.kill(conversationId);
    }

    // LRU eviction: if at capacity, kill the oldest detached session
    await this.refreshMaxSessions();
    this.evictIfNeeded();

    const shell = command || this.getDefaultShell();
    console.log(`${TAG} Spawning PTY: conv=${conversationId}, cmd=${shell}, args=${JSON.stringify(args)}, cwd=${cwd}`);

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || os.homedir(),
      env: process.env as Record<string, string>,
    });

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
      attached: true,
      outputBuffer: [],
      outputBufferBytes: 0,
      scrollbackBuffer: [],
      scrollbackBufferBytes: 0,
      exited: false,
    };

    this.sessions.set(conversationId, session);
    this.savePids();
    console.log(`${TAG} PTY spawned: conv=${conversationId}, pid=${ptyProcess.pid}`);

    // Stream output — emit to renderer when attached, buffer when detached
    ptyProcess.onData((data: string) => {
      // Always maintain scrollback buffer (xterm.js is destroyed on navigate,
      // so we need full history for replay on reattach)
      session.scrollbackBuffer.push(data);
      session.scrollbackBufferBytes += data.length;
      while (session.scrollbackBufferBytes > MAX_BUFFER_BYTES && session.scrollbackBuffer.length > 1) {
        const removed = session.scrollbackBuffer.shift()!;
        session.scrollbackBufferBytes -= removed.length;
      }

      if (session.attached) {
        ipcBridge.pty.output.emit({ conversationId, data });
      } else {
        // Buffer output while detached (cap at MAX_BUFFER_BYTES)
        if (session.outputBufferBytes < MAX_BUFFER_BYTES) {
          session.outputBuffer.push(data);
          session.outputBufferBytes += data.length;
        }
        // If over cap, drop oldest entries to make room
        while (session.outputBufferBytes > MAX_BUFFER_BYTES && session.outputBuffer.length > 1) {
          const removed = session.outputBuffer.shift()!;
          session.outputBufferBytes -= removed.length;
        }
      }
      // Always write to transcript
      const clean = stripAnsi(data);
      if (clean) {
        transcriptStream.write(clean);
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(
        `${TAG} PTY exited: conv=${conversationId}, pid=${ptyProcess.pid}, code=${exitCode}, signal=${signal}`
      );
      if (session.attached) {
        // Renderer is listening — emit exit and clean up immediately
        ipcBridge.pty.exit.emit({ conversationId, exitCode, signal });
        this.cleanupSession(conversationId);
      } else {
        // Detached — preserve session so reattach can replay buffer + exit message
        session.outputBuffer.push(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
        session.exited = true;
        session.transcriptStream.end();
        console.log(`${TAG} PTY exited while detached, preserving buffer: conv=${conversationId}`);
      }
    });

    return { pid: ptyProcess.pid };
  }

  /**
   * Detach the renderer from a session (user navigated away).
   * PTY keeps running, output is buffered.
   */
  detach(conversationId: string): boolean {
    const session = this.sessions.get(conversationId);
    if (!session) {
      console.log(`${TAG} Detach: no session found for ${conversationId}`);
      return false;
    }
    session.attached = false;
    session.detachedAt = Date.now();
    console.log(`${TAG} Detached: conv=${conversationId}, pid=${session.pid}`);
    return true;
  }

  /**
   * Reattach the renderer to a session (user navigated back).
   * Returns full scrollback buffer so xterm.js (which was destroyed on navigate) can replay history.
   */
  reattach(conversationId: string): { exists: boolean; buffer: string; exited: boolean } {
    const session = this.sessions.get(conversationId);
    if (!session) {
      console.log(`${TAG} Reattach: no session found for ${conversationId}`);
      return { exists: false, buffer: '', exited: false };
    }
    // Return full scrollback (not just detached buffer) — xterm.js was destroyed on navigate
    const buffer = session.scrollbackBuffer.join('');
    const exited = session.exited;
    session.outputBuffer = [];
    session.outputBufferBytes = 0;
    session.attached = true;
    console.log(
      `${TAG} Reattached: conv=${conversationId}, pid=${session.pid}, scrollback=${buffer.length} chars, exited=${exited}`
    );

    // If the PTY exited while detached, clean up now that buffer has been flushed
    if (exited) {
      this.sessions.delete(conversationId);
      this.savePids();
      console.log(`${TAG} Cleaned up exited-while-detached session: ${conversationId}`);
    }

    return { exists: true, buffer, exited };
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
      session.process.kill();
    } catch {
      // Process may have already exited
    }
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

  /** Evict the oldest detached session if at capacity. */
  private evictIfNeeded(): void {
    const maxSessions = this.maxSessions;
    if (this.sessions.size < maxSessions) return;

    // Find the oldest detached session (by detachedAt)
    let oldest: { id: string; detachedAt: number } | undefined;
    for (const [id, session] of this.sessions) {
      if (!session.attached && session.detachedAt) {
        if (!oldest || session.detachedAt < oldest.detachedAt) {
          oldest = { id, detachedAt: session.detachedAt };
        }
      }
    }

    if (!oldest) {
      console.log(`${TAG} At capacity (${this.sessions.size}/${maxSessions}) but no detached sessions to evict`);
      return;
    }

    console.log(
      `${TAG} Evicting oldest detached session: ${oldest.id} (detached ${Date.now() - oldest.detachedAt}ms ago)`
    );
    this.kill(oldest.id);

    // Notify renderer so it can show a toast
    ipcBridge.pty.sessionEvicted.emit({
      conversationId: oldest.id,
      maxSessions,
    });
  }

  /** Cached max sessions value (refreshed on each spawn). */
  private maxSessions = DEFAULT_MAX_SESSIONS;

  /** Refresh max sessions from config. Call before eviction check. */
  async refreshMaxSessions(): Promise<void> {
    try {
      const config = await ConfigStorage.get('agentCli.config');
      this.maxSessions = config?.maxTerminalSessions ?? DEFAULT_MAX_SESSIONS;
    } catch {
      // Use default on error
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
