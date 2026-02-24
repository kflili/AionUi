/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron';
import { spawnSync } from 'child_process';
import http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';

// Configure Chromium command-line flags for WebUI and CLI modes
// 为 WebUI 和 CLI 模式配置 Chromium 命令行参数

// Check if X display is actually connectable (auth + socket test via xdpyinfo).
// Returns true if X is usable; if xdpyinfo is not installed, assumes accessible.
// This catches xrdp + Wayland sessions where DISPLAY points to XWayland but
// the auth cookie (MIT-MAGIC-COOKIE) is inaccessible from the xrdp session.
function isXDisplayConnectable(): boolean {
  if (!process.env.DISPLAY) return false;
  const result = spawnSync('xdpyinfo', { timeout: 2000, stdio: 'pipe', env: process.env });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') return true;
  return result.status === 0;
}

// All Linux: prevent GPU sandbox init failure (error_code=1002) on VMs, containers, and
// systems with restricted namespaces — applies regardless of display server availability
// --no-zygote: disable Zygote PID namespace to fix ESRCH shared memory errors
//   (Zygote uses clone(CLONE_NEWPID) which causes cross-namespace /tmp IPC failures)
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
  app.commandLine.appendSwitch('no-zygote');
}

const isLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

// No usable display if DISPLAY is absent or X connection fails (auth error, broken socket, etc.)
// Covers: headless server (no DISPLAY), xrdp with broken XWayland auth (DISPLAY set but xcb fails),
// and xrdp+Wayland sessions that don't expose WAYLAND_DISPLAY to the xrdp client.
export const isLinuxNoDisplay = process.platform === 'linux' && (!process.env.DISPLAY || !isXDisplayConnectable());

// Linux no-display: enable headless mode to prevent segfault when no display server is present
// Linux 无显示时启用 headless 防止段错误崩溃
if (isLinuxNoDisplay) {
  app.commandLine.appendSwitch('headless');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

// Linux with usable X display: disable hardware GPU to prevent EGL/VkXcb failures
// on remote sessions (xrdp, VNC, SSH X forwarding) — software rendering is adequate for chat UI
if (process.platform === 'linux' && !isLinuxNoDisplay) {
  if (isLinuxWayland) {
    // Force X11 backend when Wayland is detected (avoids Electron-Wayland compatibility issues)
    app.commandLine.appendSwitch('ozone-platform', 'x11');
  }
  app.commandLine.appendSwitch('disable-gpu');
}

// For WebUI and --resetpass modes: disable sandbox for root user
// 仅 WebUI 和重置密码模式：root 用户禁用沙箱
const isWebUI = process.argv.some((arg) => arg === '--webui');
const isResetPassword = process.argv.includes('--resetpass');
if (isWebUI || isResetPassword) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    app.commandLine.appendSwitch('no-sandbox');
  }
}

// ---------------------------------------------------------------------------
// Chrome DevTools Protocol (CDP) — enable remote debugging in dev mode
// so chrome-devtools-mcp and other CDP clients can connect to this Electron app.
//
// Default port: 9223 (avoids conflict with common CDP port 9222).
// Override via AIONUI_CDP_PORT env variable. Set to "0" to disable.
//
// Multi-instance support: a file-based registry tracks all active instances
// so each one gets a unique port and MCP tools can discover them all.
// Registry file: ~/.aionui-cdp-registry.json
// ---------------------------------------------------------------------------
const DEFAULT_CDP_PORT = 9223;
const CDP_PORT_RANGE_START = 9223;
const CDP_PORT_RANGE_END = 9230;
const CDP_REGISTRY_FILE = path.join(os.homedir(), '.aionui-cdp-registry.json');

interface CdpRegistryEntry {
  pid: number;
  port: number;
  cwd: string;
  startTime: number;
}

/** Read the CDP registry file, returning an empty array on any error. */
function readRegistry(): CdpRegistryEntry[] {
  try {
    if (!fs.existsSync(CDP_REGISTRY_FILE)) return [];
    const raw = fs.readFileSync(CDP_REGISTRY_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Write the CDP registry file atomically. */
function writeRegistry(entries: CdpRegistryEntry[]): void {
  try {
    fs.writeFileSync(CDP_REGISTRY_FILE, JSON.stringify(entries, null, 2), 'utf-8');
  } catch {
    // Non-critical — log but don't crash
    console.warn('[DevTools MCP] Failed to write CDP registry file');
  }
}

/** Check if a process is still alive by sending signal 0. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Remove dead-process entries from the registry and return live ones. */
function pruneRegistry(): CdpRegistryEntry[] {
  const entries = readRegistry();
  const alive = entries.filter((e) => isProcessAlive(e.pid));
  if (alive.length !== entries.length) {
    writeRegistry(alive);
  }
  return alive;
}

/** Find the first available port not occupied by a live registry entry. */
function findAvailablePort(preferredPort: number): number {
  const liveEntries = pruneRegistry();
  const usedPorts = new Set(liveEntries.map((e) => e.port));

  // Try the preferred port first
  if (!usedPorts.has(preferredPort)) return preferredPort;

  // Scan the port range for an available one
  for (let p = CDP_PORT_RANGE_START; p <= CDP_PORT_RANGE_END; p++) {
    if (!usedPorts.has(p)) return p;
  }

  // All ports in range occupied — fall back to preferred and let Electron handle the conflict
  return preferredPort;
}

/** Register the current process in the CDP registry. */
function registerInstance(port: number): void {
  const entries = pruneRegistry();
  // Remove any stale entry for our own PID (e.g. from a previous crash)
  const filtered = entries.filter((e) => e.pid !== process.pid);
  filtered.push({
    pid: process.pid,
    port,
    cwd: process.cwd(),
    startTime: Date.now(),
  });
  writeRegistry(filtered);
}

/** Remove the current process from the CDP registry. */
export function unregisterInstance(): void {
  try {
    const entries = readRegistry();
    const filtered = entries.filter((e) => e.pid !== process.pid);
    writeRegistry(filtered);
  } catch {
    // Best-effort cleanup
  }
}

function resolveCdpPort(): number | null {
  const envVal = process.env.AIONUI_CDP_PORT;
  if (envVal === '0' || envVal === 'false') return null;
  if (envVal) {
    const parsed = Number(envVal);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return DEFAULT_CDP_PORT;
}

/** The active CDP port, or null if remote debugging is disabled. */
export let cdpPort: number | null = null;

if (!app.isPackaged) {
  const preferredPort = resolveCdpPort();
  if (preferredPort) {
    const port = findAvailablePort(preferredPort);
    app.commandLine.appendSwitch('remote-debugging-port', String(port));
    cdpPort = port;
    registerInstance(port);

    // Clean up registry on exit
    process.on('exit', () => unregisterInstance());
  }
}

/**
 * Verify CDP remote debugging is actually accessible after app starts.
 * Retries several times with delay to account for startup time.
 */
export async function verifyCdpReady(port: number, maxRetries = 5, retryDelay = 800): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, { timeout: 2000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(res.statusCode === 200 && data.length > 0));
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    if (i < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, retryDelay));
    }
  }
  return false;
}

/**
 * Get all live CDP instances from the registry.
 * Prunes dead entries automatically.
 */
export function getActiveCdpInstances(): CdpRegistryEntry[] {
  return pruneRegistry();
}
