/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSyncExternalStore } from 'react';
import { ConfigStorage, type IConfigStorageRefer } from '@/common/config/storage';

export type AgentCliConfig = NonNullable<IConfigStorageRefer['agentCli.config']>;

const CONFIG_KEY = 'agentCli.config' as const;

let cachedSnapshot: AgentCliConfig | undefined;
let hasInitialized = false;
let initPromise: Promise<void> | null = null;
const pendingNotifiers: Set<() => void> = new Set();

const ensureInitialized = (notify: () => void): void => {
  if (hasInitialized) return;
  pendingNotifiers.add(notify);
  if (initPromise) return;
  initPromise = ConfigStorage.get(CONFIG_KEY).then((value) => {
    cachedSnapshot = value ?? undefined;
    hasInitialized = true;
    const notifiers = Array.from(pendingNotifiers);
    pendingNotifiers.clear();
    notifiers.forEach((fn) => fn());
  });
};

const subscribe = (listener: () => void): (() => void) => {
  ensureInitialized(listener);
  const unsubscribe = ConfigStorage.subscribe(CONFIG_KEY, (value) => {
    cachedSnapshot = value ?? undefined;
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
 * Returns the current snapshot (or undefined while the initial load is in flight).
 * All consumers re-render when any component calls ConfigStorage.set('agentCli.config', ...).
 *
 * The hook owns a single module-level cache: regardless of how many components mount
 * the hook simultaneously, only one ConfigStorage.get('agentCli.config') is dispatched.
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
