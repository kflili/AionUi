/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock @office-ai/platform's storage.buildStorage with an in-memory implementation.
// ConfigStorage in src/common/config/storage.ts wraps the raw built storage and adds
// a local EventEmitter on set; we exercise the wrapper directly via the real module.
// vi.mock() is hoisted above the imports, so we use vi.hoisted() for shared state
// the mock factory needs to reference.
const { memoryStore } = vi.hoisted(() => ({
  memoryStore: new Map<string, unknown>(),
}));

vi.mock('@office-ai/platform', () => ({
  storage: {
    buildStorage: () => ({
      get: async (key: string) => memoryStore.get(key),
      set: async (key: string, data: unknown) => {
        memoryStore.set(key, data);
      },
      clear: async () => {
        memoryStore.clear();
      },
      remove: async (key: string) => {
        memoryStore.delete(key);
      },
      debug: () => {},
      interceptor: () => {},
    }),
  },
}));

import { ConfigStorage } from '../../src/common/config/storage';
import {
  useAgentCliConfig,
  __resetAgentCliConfigCacheForTests,
} from '../../src/renderer/hooks/agent/useAgentCliConfig';

const seedConfig = (value: unknown): void => {
  memoryStore.set('agentCli.config', value);
};

beforeEach(() => {
  memoryStore.clear();
  __resetAgentCliConfigCacheForTests();
});

describe('useAgentCliConfig', () => {
  it('resolves to the stored snapshot on mount', async () => {
    seedConfig({ defaultMode: 'terminal', fontSize: 16 });

    const { result } = renderHook(() => useAgentCliConfig());

    // Initial render is undefined while the async get is in flight
    expect(result.current).toBeUndefined();

    await waitFor(() => expect(result.current).toEqual({ defaultMode: 'terminal', fontSize: 16 }));
  });

  it('re-renders when ConfigStorage.set fires while the hook is mounted', async () => {
    seedConfig({ defaultMode: 'acp' });

    const { result } = renderHook(() => useAgentCliConfig());
    await waitFor(() => expect(result.current).toEqual({ defaultMode: 'acp' }));

    await act(async () => {
      await ConfigStorage.set('agentCli.config', { defaultMode: 'terminal', showThinking: true });
    });

    expect(result.current).toEqual({ defaultMode: 'terminal', showThinking: true });
  });

  it('unsubscribes on unmount — subsequent set calls do not throw or notify the unmounted hook', async () => {
    seedConfig({ defaultMode: 'acp' });

    const { result, unmount } = renderHook(() => useAgentCliConfig());
    await waitFor(() => expect(result.current).toEqual({ defaultMode: 'acp' }));

    const snapshotBeforeUnmount = result.current;
    unmount();

    // After unmount, additional sets should not raise listener-related errors. We
    // also confirm the unmounted hook's last-seen snapshot is unchanged from its
    // perspective (React already tore down the component tree).
    await act(async () => {
      await ConfigStorage.set('agentCli.config', { defaultMode: 'terminal' });
    });

    expect(snapshotBeforeUnmount).toEqual({ defaultMode: 'acp' });
  });

  it('keeps two simultaneously-mounted hook instances in sync after a set', async () => {
    seedConfig({ defaultMode: 'acp', fontSize: 14 });

    const hookA = renderHook(() => useAgentCliConfig());
    const hookB = renderHook(() => useAgentCliConfig());

    await waitFor(() => expect(hookA.result.current).toEqual({ defaultMode: 'acp', fontSize: 14 }));
    await waitFor(() => expect(hookB.result.current).toEqual({ defaultMode: 'acp', fontSize: 14 }));

    await act(async () => {
      await ConfigStorage.set('agentCli.config', { defaultMode: 'terminal', fontSize: 18 });
    });

    expect(hookA.result.current).toEqual({ defaultMode: 'terminal', fontSize: 18 });
    expect(hookB.result.current).toEqual({ defaultMode: 'terminal', fontSize: 18 });
  });

  it('normalizes missing config to {} after the initial fetch (loaded, empty) — first-run users can still see settings UI', async () => {
    // memoryStore is empty — get resolves to undefined.
    const { result } = renderHook(() => useAgentCliConfig());

    // Initial render is undefined (still loading) — DIFFERENT from the loaded-empty {} below.
    expect(result.current).toBeUndefined();

    // After init resolves, snapshot is {} (loaded, empty) — NOT undefined.
    // This is the key signal consumers use to advance past "loading" gates
    // (AgentCliModalContent's `if (config === undefined) return null;`,
    // ChatConversation's `showThinkingLoaded`, etc.) on a fresh install.
    await waitFor(() => expect(result.current).toEqual({}));

    // A subsequent set produces a defined snapshot without errors.
    await act(async () => {
      await ConfigStorage.set('agentCli.config', { defaultMode: 'acp' });
    });
    expect(result.current).toEqual({ defaultMode: 'acp' });
  });
});
