/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSyncExternalStore } from 'react';
import { ConfigStorage, type IConfigStorageRefer } from '@/common/config/storage';

export type AgentCliConfig = NonNullable<IConfigStorageRefer['agentCli.config']>;

const CONFIG_KEY = 'agentCli.config' as const;
const EMPTY_CONFIG: AgentCliConfig = {};

// undefined === "initial fetch still in flight". After the first ConfigStorage.get
// resolves, the snapshot is always defined — missing storage is normalized to {}
// so consumers can distinguish "loading" from "loaded but empty" via the same
// `config === undefined` check (matches the pre-refactor `setConfig(c || {})` pattern).
let cachedSnapshot: AgentCliConfig | undefined;
let hasInitialized = false;
let initPromise: Promise<void> | null = null;
const pendingNotifiers: Set<() => void> = new Set();

const ensureInitialized = (notify: () => void): void => {
  if (hasInitialized) return;
  pendingNotifiers.add(notify);
  if (initPromise) return;
  initPromise = (async () => {
    try {
      const value = await ConfigStorage.get(CONFIG_KEY);
      cachedSnapshot = value ?? EMPTY_CONFIG;
    } catch (error) {
      // If the initial read fails, mark as loaded with an empty config so
      // consumers don't hang forever in their loading gates. Future
      // ConfigStorage.set calls will still update the snapshot via the
      // change-emitter, so a transient failure recovers naturally.
      console.error('[useAgentCliConfig] Failed to load agentCli.config; falling back to empty config', error);
      cachedSnapshot = EMPTY_CONFIG;
    } finally {
      hasInitialized = true;
      const notifiers = Array.from(pendingNotifiers);
      pendingNotifiers.clear();
      notifiers.forEach((fn) => fn());
    }
  })();
};

const subscribe = (listener: () => void): (() => void) => {
  ensureInitialized(listener);
  const unsubscribe = ConfigStorage.subscribe(CONFIG_KEY, (value) => {
    cachedSnapshot = value ?? EMPTY_CONFIG;
    listener();
  });
  return () => {
    pendingNotifiers.delete(listener);
    unsubscribe();
  };
};

const getSnapshot = (): AgentCliConfig | undefined => cachedSnapshot;

/**
 * Shared hook for reading agentCli.config with cross-component sync.
 *
 * Return value:
 * - `undefined` — the initial ConfigStorage.get is still in flight.
 * - `{}` (empty object) — loaded; nothing stored under `agentCli.config`.
 * - `{...}` — loaded with stored values.
 *
 * All consumers re-render when any component calls ConfigStorage.set('agentCli.config', ...).
 * The hook owns a single module-level cache: regardless of how many components mount
 * simultaneously, only one ConfigStorage.get('agentCli.config') is dispatched.
 */
export const useAgentCliConfig = (): AgentCliConfig | undefined =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

/**
 * @internal Exported for unit tests only. Resets module-level cache so each test
 * starts from a clean state without leaking across runs.
 */
export const __resetAgentCliConfigCacheForTests = (): void => {
  cachedSnapshot = undefined;
  hasInitialized = false;
  initPromise = null;
  pendingNotifiers.clear();
};
