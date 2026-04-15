/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildDisplayMessage, shortenPath } from '@/renderer/utils/file/messageFiles';

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

  it('preserves multiple files as-is', () => {
    const files = ['/Users/lili/a.txt', '/Users/lili/b.txt', '/other/c.txt'];
    const result = buildDisplayMessage('hello', files, workspace);
    expect(result).toContain('/Users/lili/a.txt');
    expect(result).toContain('/Users/lili/b.txt');
    expect(result).toContain('/other/c.txt');
  });

  it('does not inject workspace path regardless of workspacePath value', () => {
    const files = ['/external/file.txt', 'relative/file.txt'];
    const result = buildDisplayMessage('hello', files, workspace);
    // External file should NOT be prefixed with workspace
    expect(result).not.toContain(`${workspace}/file.txt`);
    expect(result).not.toContain(`${workspace}/relative`);
  });
});

describe('shortenPath', () => {
  const workspace = '/Users/lili/Projects/AionUi';

  it('converts absolute path inside workspace to relative', () => {
    const result = shortenPath('/Users/lili/Projects/AionUi/src/utils/parser.ts', workspace);
    expect(result).toBe('src/utils/parser.ts');
  });

  it('abbreviates absolute path outside workspace to last 2 segments', () => {
    const result = shortenPath('/Users/lili/Documents/reports/quarterly/report.pdf', workspace);
    expect(result).toBe('.../quarterly/report.pdf');
  });

  it('keeps short absolute paths unchanged (≤3 segments)', () => {
    expect(shortenPath('/tmp/file.txt', workspace)).toBe('/tmp/file.txt');
    expect(shortenPath('/a/b/c', workspace)).toBe('/a/b/c');
  });

  it('returns relative paths unchanged (legacy)', () => {
    expect(shortenPath('relative/file.txt', workspace)).toBe('relative/file.txt');
    expect(shortenPath('file.txt', workspace)).toBe('file.txt');
  });

  it('detects Windows-style absolute paths', () => {
    const result = shortenPath('C:\\Users\\lili\\Documents\\deep\\nested\\file.txt', workspace);
    expect(result).toBe('.../nested/file.txt');
  });

  it('falls back to abbreviation when workspace is undefined', () => {
    const result = shortenPath('/Users/lili/Documents/reports/file.txt', undefined);
    expect(result).toBe('.../reports/file.txt');
  });

  it('falls back to abbreviation when workspace is empty string', () => {
    const result = shortenPath('/Users/lili/Documents/reports/file.txt', '');
    expect(result).toBe('.../reports/file.txt');
  });
});
