/**
 * Unit tests for useResizablePixelWidth — pixel-mode resizable hook
 * used by the global left sider in Layout.tsx.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Provide a working localStorage mock if the environment lacks one.
function ensureLocalStorage() {
  if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.getItem !== 'function') {
    const store = new Map<string, string>();
    const mock = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
    };
    Object.defineProperty(globalThis, 'localStorage', { value: mock, writable: true });
    if (typeof window !== 'undefined') {
      Object.defineProperty(window, 'localStorage', { value: mock, writable: true });
    }
  }
}
ensureLocalStorage();

import { useResizablePixelWidth } from '../../src/renderer/hooks/ui/useResizablePixelWidth';

const STORAGE_KEY = 'aionui_global_sider_width';

describe('useResizablePixelWidth', () => {
  beforeEach(() => {
    globalThis.localStorage.removeItem(STORAGE_KEY);
  });

  afterEach(() => {
    globalThis.localStorage.removeItem(STORAGE_KEY);
  });

  it('initial width equals defaultWidth when localStorage is empty', () => {
    const { result } = renderHook(() =>
      useResizablePixelWidth({
        defaultWidth: 250,
        minWidth: 200,
        maxWidth: 400,
        storageKey: STORAGE_KEY,
      })
    );

    expect(result.current.width).toBe(250);
  });

  it('reads persisted width from localStorage on mount', () => {
    globalThis.localStorage.setItem(STORAGE_KEY, '320');

    const { result } = renderHook(() =>
      useResizablePixelWidth({
        defaultWidth: 250,
        minWidth: 200,
        maxWidth: 400,
        storageKey: STORAGE_KEY,
      })
    );

    expect(result.current.width).toBe(320);
  });

  it('ignores persisted values outside [minWidth, maxWidth] (below)', () => {
    globalThis.localStorage.setItem(STORAGE_KEY, '50');

    const { result } = renderHook(() =>
      useResizablePixelWidth({
        defaultWidth: 250,
        minWidth: 200,
        maxWidth: 400,
        storageKey: STORAGE_KEY,
      })
    );

    expect(result.current.width).toBe(250);
  });

  it('ignores persisted values outside [minWidth, maxWidth] (above)', () => {
    globalThis.localStorage.setItem(STORAGE_KEY, '9999');

    const { result } = renderHook(() =>
      useResizablePixelWidth({
        defaultWidth: 250,
        minWidth: 200,
        maxWidth: 400,
        storageKey: STORAGE_KEY,
      })
    );

    expect(result.current.width).toBe(250);
  });

  it('ignores non-numeric persisted values', () => {
    globalThis.localStorage.setItem(STORAGE_KEY, 'not-a-number');

    const { result } = renderHook(() =>
      useResizablePixelWidth({
        defaultWidth: 250,
        minWidth: 200,
        maxWidth: 400,
        storageKey: STORAGE_KEY,
      })
    );

    expect(result.current.width).toBe(250);
  });

  it('setWidth persists to localStorage', () => {
    const { result } = renderHook(() =>
      useResizablePixelWidth({
        defaultWidth: 250,
        minWidth: 200,
        maxWidth: 400,
        storageKey: STORAGE_KEY,
      })
    );

    act(() => {
      result.current.setWidth(310);
    });

    expect(result.current.width).toBe(310);
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBe('310');
  });

  it('setWidth clamps to minWidth', () => {
    const { result } = renderHook(() =>
      useResizablePixelWidth({
        defaultWidth: 250,
        minWidth: 200,
        maxWidth: 400,
        storageKey: STORAGE_KEY,
      })
    );

    act(() => {
      result.current.setWidth(50);
    });

    expect(result.current.width).toBe(200);
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBe('200');
  });

  it('setWidth clamps to maxWidth', () => {
    const { result } = renderHook(() =>
      useResizablePixelWidth({
        defaultWidth: 250,
        minWidth: 200,
        maxWidth: 400,
        storageKey: STORAGE_KEY,
      })
    );

    act(() => {
      result.current.setWidth(9999);
    });

    expect(result.current.width).toBe(400);
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBe('400');
  });

  it('width survives unmount/remount via localStorage', () => {
    // First mount: set a width.
    const first = renderHook(() =>
      useResizablePixelWidth({
        defaultWidth: 250,
        minWidth: 200,
        maxWidth: 400,
        storageKey: STORAGE_KEY,
      })
    );

    act(() => {
      first.result.current.setWidth(285);
    });

    first.unmount();

    // Second mount: reads back the same value.
    const second = renderHook(() =>
      useResizablePixelWidth({
        defaultWidth: 250,
        minWidth: 200,
        maxWidth: 400,
        storageKey: STORAGE_KEY,
      })
    );

    expect(second.result.current.width).toBe(285);
  });

  it('exposes a dragHandle React element with col-resize affordance', () => {
    const { result } = renderHook(() =>
      useResizablePixelWidth({
        defaultWidth: 250,
        minWidth: 200,
        maxWidth: 400,
        storageKey: STORAGE_KEY,
      })
    );

    const handle = result.current.dragHandle;
    expect(handle).toBeTruthy();
    // The handle is a React element whose className includes cursor-col-resize.
    const props = (handle as { props: { className?: string; 'data-testid'?: string } }).props;
    expect(props.className).toContain('cursor-col-resize');
    expect(props['data-testid']).toBe('global-sider-resize-handle');
  });

  it('works without a storageKey (no persistence)', () => {
    const { result } = renderHook(() =>
      useResizablePixelWidth({
        defaultWidth: 250,
        minWidth: 200,
        maxWidth: 400,
      })
    );

    expect(result.current.width).toBe(250);

    act(() => {
      result.current.setWidth(310);
    });

    expect(result.current.width).toBe(310);
    // Nothing written under STORAGE_KEY since no key given.
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
