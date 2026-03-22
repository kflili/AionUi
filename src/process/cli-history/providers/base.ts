/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import type { SessionMetadata, SessionSourceProvider } from '../types';

/**
 * Abstract base class for session source providers.
 *
 * Implements the four methods that are identical across all providers:
 * readTranscript, canResume, buildReference, and resolveSessionPath.
 * Subclasses only need to implement discoverSessions() and set the `id` field.
 */
export abstract class BaseSessionSourceProvider implements SessionSourceProvider {
  abstract readonly id: SessionSourceProvider['id'];

  /**
   * In-memory lookup from session ID to its absolute JSONL file path.
   * Populated during discoverSessions() and used by readTranscript/canResume/buildReference.
   */
  protected sessionPaths = new Map<string, string>();

  /** Scan native session indexes and return metadata for all discoverable sessions. */
  abstract discoverSessions(): Promise<SessionMetadata[]>;

  /**
   * Read the JSONL transcript for a session and return individual lines.
   * Requires discoverSessions() to have been called first to populate the path lookup.
   */
  async readTranscript(sessionId: string): Promise<string[]> {
    const filePath = this.resolveSessionPath(sessionId);
    const content = await fsPromises.readFile(filePath, 'utf-8');
    return content.split('\n').filter((line) => line.trim().length > 0);
  }

  /**
   * Check whether the session's transcript file exists on disk.
   */
  canResume(sessionId: string): boolean {
    const filePath = this.sessionPaths.get(sessionId);
    if (!filePath) return false;

    try {
      fs.accessSync(filePath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Return the absolute file path to the session's JSONL transcript.
   * Used by the Copy Chat Reference feature.
   */
  buildReference(sessionId: string): string {
    return this.resolveSessionPath(sessionId);
  }

  /**
   * Look up the absolute JSONL path for a session ID.
   * Throws if the session has not been discovered yet.
   */
  protected resolveSessionPath(sessionId: string): string {
    const filePath = this.sessionPaths.get(sessionId);
    if (!filePath) {
      throw new Error(`Session not found: ${sessionId}. Call discoverSessions() first.`);
    }
    return filePath;
  }
}
