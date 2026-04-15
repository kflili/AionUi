import { AIONUI_FILES_MARKER, AIONUI_TIMESTAMP_REGEX } from '@/common/config/constants';
import type { FileOrFolderItem } from '@/renderer/utils/file/fileTypes';

export const collectSelectedFiles = (uploadFile: string[], atPath: Array<string | FileOrFolderItem>): string[] => {
  const atPathFiles = atPath.map((item) => (typeof item === 'string' ? item : item.path)).filter(Boolean);
  return Array.from(new Set([...uploadFile, ...atPathFiles]));
};

// workspacePath kept for API compatibility — callers pass it but raw paths are now stored as-is
export const buildDisplayMessage = (input: string, files: string[], _workspacePath: string): string => {
  if (!files.length) return input;
  // Store original paths as-is, only strip AionUI timestamp suffix
  const displayPaths = files.map((filePath) => filePath.replace(AIONUI_TIMESTAMP_REGEX, '$1'));
  return `${input}\n\n${AIONUI_FILES_MARKER}\n${displayPaths.join('\n')}`;
};

/**
 * Shorten a file path for display.
 * - Absolute path inside workspace → relative (e.g., "src/utils/parser.ts")
 * - Absolute path outside workspace with >3 segments → last 2 segments (e.g., ".../Documents/file.txt")
 * - Short absolute path (≤3 segments like "/tmp/file.txt") → returned as-is
 * - Relative path (legacy) → as-is
 */
export const shortenPath = (filePath: string, workspace?: string): string => {
  const isAbsolute = filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath);
  if (!isAbsolute) return filePath; // legacy relative path

  if (workspace) {
    const normalizedFile = filePath.replace(/\\/g, '/');
    const normalizedWorkspace = workspace.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    if (normalizedFile.startsWith(normalizedWorkspace + '/')) {
      return normalizedFile.slice(normalizedWorkspace.length + 1);
    }
  }

  // External absolute path: show abbreviated with last 2 segments
  const segments = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length <= 3) return filePath;
  return `.../${segments.slice(-2).join('/')}`;
};
