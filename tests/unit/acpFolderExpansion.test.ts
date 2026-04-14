/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Mock fs before importing the module
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      stat: vi.fn(),
      readdir: vi.fn(),
    },
  };
});

import { expandFilePaths } from '@process/agent/acp/utils/fileExpansion';
import { promises as fs } from 'fs';

const mockStat = vi.mocked(fs.stat);
const mockReaddir = vi.mocked(fs.readdir);

describe('expandFilePaths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps regular file paths as-is', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => false } as ReturnType<typeof fs.stat> extends Promise<infer T>
      ? T
      : never);

    const result = await expandFilePaths(['/Users/lili/file.txt']);
    expect(result.expandedPaths).toEqual(['/Users/lili/file.txt']);
    expect(result.folderAnnotations).toEqual([]);
  });

  it('expands directory to individual file entries (skips subdirectories)', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true } as ReturnType<typeof fs.stat> extends Promise<infer T>
      ? T
      : never);
    mockReaddir.mockResolvedValue([
      { name: 'a.txt', isFile: () => true, isDirectory: () => false },
      { name: 'b.ts', isFile: () => true, isDirectory: () => false },
      { name: 'subdir', isFile: () => false, isDirectory: () => true },
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    const result = await expandFilePaths(['/Users/lili/project']);
    // Subdirectories should be excluded — CLI's @ notation doesn't support directory paths
    expect(result.expandedPaths).toEqual([
      path.join('/Users/lili/project', 'a.txt'),
      path.join('/Users/lili/project', 'b.ts'),
    ]);
    expect(result.folderAnnotations).toEqual(['[Attached folder: /Users/lili/project]']);
  });

  it('handles mixed files and directories', async () => {
    mockStat
      .mockResolvedValueOnce({ isDirectory: () => false } as ReturnType<typeof fs.stat> extends Promise<infer T>
        ? T
        : never)
      .mockResolvedValueOnce({ isDirectory: () => true } as ReturnType<typeof fs.stat> extends Promise<infer T>
        ? T
        : never);
    mockReaddir.mockResolvedValue([
      { name: 'child.txt', isFile: () => true, isDirectory: () => false },
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    const result = await expandFilePaths(['/Users/lili/file.txt', '/Users/lili/folder']);
    expect(result.expandedPaths).toEqual(['/Users/lili/file.txt', path.join('/Users/lili/folder', 'child.txt')]);
    expect(result.folderAnnotations).toEqual(['[Attached folder: /Users/lili/folder]']);
  });

  it('handles empty directory with annotation only', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true } as ReturnType<typeof fs.stat> extends Promise<infer T>
      ? T
      : never);
    mockReaddir.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    const result = await expandFilePaths(['/Users/lili/empty-dir']);
    expect(result.expandedPaths).toEqual([]);
    expect(result.folderAnnotations).toEqual(['[Attached folder: /Users/lili/empty-dir]']);
  });

  it('passes through non-existent paths as-is', async () => {
    mockStat.mockRejectedValue(new Error('ENOENT'));

    const result = await expandFilePaths(['/nonexistent/path.txt']);
    expect(result.expandedPaths).toEqual(['/nonexistent/path.txt']);
    expect(result.folderAnnotations).toEqual([]);
  });

  it('preserves paths with spaces correctly', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true } as ReturnType<typeof fs.stat> extends Promise<infer T>
      ? T
      : never);
    mockReaddir.mockResolvedValue([
      { name: 'my file.txt', isFile: () => true, isDirectory: () => false },
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    const result = await expandFilePaths(['/Users/lili/My Documents']);
    expect(result.expandedPaths).toEqual([path.join('/Users/lili/My Documents', 'my file.txt')]);
    expect(result.folderAnnotations).toEqual(['[Attached folder: /Users/lili/My Documents]']);
  });
});
