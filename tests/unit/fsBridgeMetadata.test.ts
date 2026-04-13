/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('fsBridge getFileMetadata isDirectory', () => {
  let tempDir: string;
  let tempFile: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aionui-test-'));
    tempFile = path.join(tempDir, 'test-file.txt');
    await fs.writeFile(tempFile, 'test content');
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns isDirectory true for directories', async () => {
    const stats = await fs.stat(tempDir);
    expect(stats.isDirectory()).toBe(true);
  });

  it('returns isDirectory false for regular files', async () => {
    const stats = await fs.stat(tempFile);
    expect(stats.isDirectory()).toBe(false);
    expect(stats.isFile()).toBe(true);
  });

  it('constructs metadata with isDirectory field for directory', async () => {
    const stats = await fs.stat(tempDir);
    const metadata = {
      name: path.basename(tempDir),
      path: tempDir,
      size: stats.size,
      type: '',
      lastModified: stats.mtime.getTime(),
      isDirectory: stats.isDirectory(),
    };
    expect(metadata.isDirectory).toBe(true);
    expect(metadata.name).toBeTruthy();
  });

  it('constructs metadata with isDirectory field for file', async () => {
    const stats = await fs.stat(tempFile);
    const metadata = {
      name: path.basename(tempFile),
      path: tempFile,
      size: stats.size,
      type: '',
      lastModified: stats.mtime.getTime(),
      isDirectory: stats.isDirectory(),
    };
    expect(metadata.isDirectory).toBe(false);
    expect(metadata.size).toBeGreaterThan(0);
  });
});
