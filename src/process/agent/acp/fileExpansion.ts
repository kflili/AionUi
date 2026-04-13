/**
 * File expansion utilities for ACP agent file attachments.
 *
 * Expands directory paths into individual file references since
 * Claude CLI's @ notation doesn't support directory paths.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

type ExpandResult = {
  /** Individual file paths (directories expanded to their top-level contents) */
  expandedPaths: string[];
  /** Plain-text annotations for attached folders (e.g., "[Attached folder: /path]") */
  folderAnnotations: string[];
};

/**
 * Expand file paths for ACP @ references.
 * - Regular files are passed through as-is.
 * - Directories are expanded to their top-level entries.
 * - Non-existent paths are passed through as-is (graceful degradation).
 */
export async function expandFilePaths(files: string[]): Promise<ExpandResult> {
  const expandedPaths: string[] = [];
  const folderAnnotations: string[] = [];

  for (const filePath of files) {
    try {
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        const entries = await fs.readdir(filePath, { withFileTypes: true });
        for (const entry of entries) {
          expandedPaths.push(path.join(filePath, entry.name));
        }
        folderAnnotations.push(`[Attached folder: ${filePath}]`);
      } else {
        expandedPaths.push(filePath);
      }
    } catch {
      // File may not exist or be inaccessible — pass through as-is
      expandedPaths.push(filePath);
    }
  }

  return { expandedPaths, folderAnnotations };
}
