/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenClaw Config Reader
 *
 * Reads OpenClaw configuration from ~/.openclaw/openclaw.json
 * to get gateway auth settings.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Config file paths
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.openclaw');
const CONFIG_FILENAME = 'openclaw.json';
const LEGACY_CONFIG_FILENAMES = ['clawdbot.json', 'moltbot.json', 'moldbot.json'];

interface OpenClawGatewayAuth {
  mode?: 'none' | 'token' | 'password';
  token?: string;
  password?: string;
}

interface OpenClawGatewayRemote {
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  sshTarget?: string;
  sshIdentity?: string;
}

interface OpenClawGatewaySection {
  port?: number;
  mode?: 'local' | 'remote';
  bind?: string;
  auth?: OpenClawGatewayAuth;
  remote?: OpenClawGatewayRemote;
  // Legacy fields (pre-mode era) for backward compatibility
  host?: string;
  url?: string;
}

interface OpenClawConfig {
  gateway?: OpenClawGatewaySection;
}

/**
 * Resolved gateway config from the config file, normalized by mode.
 */
export interface ResolvedFileGatewayConfig {
  mode: 'local' | 'remote';
  url?: string;
  token?: string;
  password?: string;
  port: number;
}

/**
 * Resolve the state directory (default: ~/.openclaw)
 */
function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override);
  }

  const newDir = DEFAULT_STATE_DIR;
  const legacyDirs = ['.clawdbot', '.moltbot', '.moldbot'].map((dir) => path.join(os.homedir(), dir));

  if (fs.existsSync(newDir)) {
    return newDir;
  }

  const existingLegacy = legacyDirs.find((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });

  if (existingLegacy) {
    return existingLegacy;
  }

  return newDir;
}

/**
 * Resolve user path (expand ~ to home directory)
 */
function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith('~')) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

/**
 * Find the config file path
 */
function findConfigPath(): string | null {
  const override = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override);
  }

  const stateDir = resolveStateDir();
  const candidates = [CONFIG_FILENAME, ...LEGACY_CONFIG_FILENAMES].map((name) => path.join(stateDir, name));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Read OpenClaw config from file
 */
export function readOpenClawConfig(): OpenClawConfig | null {
  const configPath = findConfigPath();
  if (!configPath) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    try {
      return JSON.parse(content) as OpenClawConfig;
    } catch {
      // If standard parse fails, try removing comments (JSONC style)
      // Use a string-aware approach: skip // and /* */ only outside quoted strings
      const cleanContent = content.replace(/"(?:[^"\\]|\\.)*"|\/\/.*$|\/\*[\s\S]*?\*\//gm, (match) => (match.startsWith('"') ? match : match.startsWith('/*') ? '' : ''));
      return JSON.parse(cleanContent) as OpenClawConfig;
    }
  } catch (error) {
    console.warn('[OpenClawConfig] Failed to read config:', error);
    return null;
  }
}

/**
 * Resolve gateway config from the config file based on `gateway.mode`.
 *
 * - `gateway.mode` is the authoritative indicator; defaults to `'local'` when absent
 * - `remote` mode reads token/password from `gateway.remote.*`, url from `gateway.url`
 * - `local` mode reads auth from `gateway.auth.*`
 */
export function resolveGatewayConfigFromFile(): ResolvedFileGatewayConfig {
  const config = readOpenClawConfig();
  const gw = config?.gateway;
  const defaultPort = 18789;

  const port = typeof gw?.port === 'number' && Number.isFinite(gw.port) && gw.port > 0 ? gw.port : defaultPort;
  const effectiveMode: 'local' | 'remote' = gw?.mode === 'remote' ? 'remote' : 'local';

  if (effectiveMode === 'remote') {
    const remote = gw?.remote;
    return {
      mode: 'remote',
      url: gw?.url || undefined,
      token: remote?.token || (gw?.auth?.mode === 'token' ? gw.auth.token : undefined),
      password: remote?.password || (gw?.auth?.mode === 'password' ? gw.auth.password : undefined),
      port,
    };
  }

  // Local mode: auth from gateway.auth.*
  const auth = gw?.auth;
  return {
    mode: 'local',
    token: auth?.mode === 'token' ? auth.token : undefined,
    password: auth?.mode === 'password' ? auth.password : undefined,
    port,
  };
}

/**
 * Get gateway auth settings from config (local mode)
 */
export function getGatewayAuthFromConfig(): OpenClawGatewayAuth | null {
  const config = readOpenClawConfig();
  return config?.gateway?.auth ?? null;
}

/**
 * Get gateway port from config
 */
export function getGatewayPort(): number {
  const config = readOpenClawConfig();
  const port = config?.gateway?.port;
  if (typeof port === 'number' && Number.isFinite(port) && port > 0) {
    return port;
  }
  return 18789; // Default port
}

/**
 * Get gateway full URL from config (e.g., ws://192.168.1.100:18789 or wss://remote.example.com)
 */
export function getGatewayUrl(): string | null {
  const config = readOpenClawConfig();
  return config?.gateway?.url ?? null;
}
