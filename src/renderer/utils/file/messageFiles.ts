import { AIONUI_FILES_MARKER, AIONUI_TIMESTAMP_REGEX } from '@/common/config/constants';
import type { FileOrFolderItem } from '@/renderer/utils/file/fileTypes';

export const collectSelectedFiles = (uploadFile: string[], atPath: Array<string | FileOrFolderItem>): string[] => {
  const atPathFiles = atPath.map((item) => (typeof item === 'string' ? item : item.path)).filter(Boolean);
  return Array.from(new Set([...uploadFile, ...atPathFiles]));
};

export const buildDisplayMessage = (input: string, files: string[], _workspacePath: string): string => {
  if (!files.length) return input;
  // Store original paths as-is, only strip AionUI timestamp suffix
  const displayPaths = files.map((filePath) => filePath.replace(AIONUI_TIMESTAMP_REGEX, '$1'));
  return `${input}\n\n${AIONUI_FILES_MARKER}\n${displayPaths.join('\n')}`;
};
