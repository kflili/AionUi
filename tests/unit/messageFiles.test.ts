/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildDisplayMessage } from '@/renderer/utils/file/messageFiles';

describe('buildDisplayMessage', () => {
  const workspace = '/tmp/aion/workspace-1';

  it('preserves absolute paths as-is for files inside workspace', () => {
    const files = [`${workspace}/uploads/photo.jpg`];
    const result = buildDisplayMessage('hello', files, workspace);
    expect(result).toContain(`${workspace}/uploads/photo.jpg`);
  });

  it('preserves absolute paths for files outside workspace', () => {
    const files = ['/other/path/external.txt'];
    const result = buildDisplayMessage('hello', files, workspace);
    expect(result).toContain('/other/path/external.txt');
  });

  it('passes relative paths through unchanged', () => {
    const files = ['relative/file.txt'];
    const result = buildDisplayMessage('hello', files, workspace);
    expect(result).toContain('relative/file.txt');
    // Should NOT prepend workspace
    expect(result).not.toContain(`${workspace}/relative/file.txt`);
  });

  it('returns input unchanged when no files', () => {
    const result = buildDisplayMessage('hello', [], workspace);
    expect(result).toBe('hello');
  });

  it('strips AIONUI timestamp separators from filenames', () => {
    const files = [`${workspace}/uploads/photo_aionui_1234567890123.jpg`];
    const result = buildDisplayMessage('hello', files, workspace);
    expect(result).toContain(`${workspace}/uploads/photo.jpg`);
  });

  it('preserves folder paths as-is', () => {
    const files = ['/Users/lili/Documents/project'];
    const result = buildDisplayMessage('hello', files, workspace);
    expect(result).toContain('/Users/lili/Documents/project');
  });
});
