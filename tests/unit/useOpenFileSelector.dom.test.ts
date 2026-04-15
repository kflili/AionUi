/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock window.matchMedia for Arco Design responsive observer
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const mockShowOpen = vi.fn();

vi.mock('@/common', () => ({
  ipcBridge: {
    dialog: {
      showOpen: { invoke: (...args: unknown[]) => mockShowOpen(...args) },
    },
  },
}));

// We need to control the return value of isElectronDesktop per test
let mockIsElectron = false;
vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => mockIsElectron,
}));

import { useOpenFileSelector } from '@/renderer/hooks/file/useOpenFileSelector';

describe('useOpenFileSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsElectron = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes openDirectory property on Electron', async () => {
    mockIsElectron = true;
    mockShowOpen.mockResolvedValue(['/some/folder']);

    const onFilesSelected = vi.fn();
    const { result } = renderHook(() => useOpenFileSelector({ onFilesSelected }));

    await act(async () => {
      result.current.openFileSelector();
    });

    expect(mockShowOpen).toHaveBeenCalledWith({
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    });
  });

  it('does NOT pass openDirectory property on WebUI', async () => {
    mockIsElectron = false;
    mockShowOpen.mockResolvedValue(['/some/file.txt']);

    const onFilesSelected = vi.fn();
    const { result } = renderHook(() => useOpenFileSelector({ onFilesSelected }));

    await act(async () => {
      result.current.openFileSelector();
    });

    expect(mockShowOpen).toHaveBeenCalledWith({
      properties: ['openFile', 'multiSelections'],
    });
  });

  it('calls onFilesSelected with returned paths', async () => {
    mockIsElectron = false;
    mockShowOpen.mockResolvedValue(['/path/a.txt', '/path/b.txt']);

    const onFilesSelected = vi.fn();
    const { result } = renderHook(() => useOpenFileSelector({ onFilesSelected }));

    await act(async () => {
      result.current.openFileSelector();
    });

    await waitFor(() => {
      expect(onFilesSelected).toHaveBeenCalledWith(['/path/a.txt', '/path/b.txt']);
    });
  });

  it('does NOT call onFilesSelected when dialog returns empty', async () => {
    mockIsElectron = false;
    mockShowOpen.mockResolvedValue([]);

    const onFilesSelected = vi.fn();
    const { result } = renderHook(() => useOpenFileSelector({ onFilesSelected }));

    await act(async () => {
      result.current.openFileSelector();
    });

    await waitFor(() => {
      expect(mockShowOpen).toHaveBeenCalled();
    });
    expect(onFilesSelected).not.toHaveBeenCalled();
  });

  it('does NOT call onFilesSelected when dialog returns null', async () => {
    mockIsElectron = false;
    mockShowOpen.mockResolvedValue(null);

    const onFilesSelected = vi.fn();
    const { result } = renderHook(() => useOpenFileSelector({ onFilesSelected }));

    await act(async () => {
      result.current.openFileSelector();
    });

    await waitFor(() => {
      expect(mockShowOpen).toHaveBeenCalled();
    });
    expect(onFilesSelected).not.toHaveBeenCalled();
  });

  it('triggers openFileSelector via /open slash command', async () => {
    mockIsElectron = false;
    mockShowOpen.mockResolvedValue(['/test/file.txt']);

    const onFilesSelected = vi.fn();
    const { result } = renderHook(() => useOpenFileSelector({ onFilesSelected }));

    await act(async () => {
      result.current.onSlashBuiltinCommand('open');
    });

    await waitFor(() => {
      expect(onFilesSelected).toHaveBeenCalledWith(['/test/file.txt']);
    });
  });
});
