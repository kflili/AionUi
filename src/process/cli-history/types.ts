/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Supported CLI session source identifiers.
 * Each value corresponds to a concrete SessionSourceProvider implementation.
 */
export type SessionSourceId = 'claude_code' | 'copilot' | 'codex';

/**
 * Metadata for a single CLI session discovered by a SessionSourceProvider.
 * Mirrors the fields found in native session index files (e.g. Claude Code's sessions-index.json).
 */
export type SessionMetadata = {
  /** Unique session identifier (usually a UUID) */
  id: string;
  /** Human-readable session title or summary */
  title: string;
  /** The first user prompt that started the session */
  firstPrompt: string;
  /** Session creation timestamp (ISO 8601 string) */
  createdAt: string;
  /** Session last-modified timestamp (ISO 8601 string) */
  updatedAt: string;
  /** Total number of messages in the session */
  messageCount: number;
  /** Absolute path to the JSONL transcript file */
  filePath: string;
  /** Project/workspace path the session was associated with */
  workspace: string;
  /** Which provider discovered this session */
  source: SessionSourceId;
};

/**
 * A pluggable provider that discovers and reads CLI sessions from a specific tool's
 * native storage format. Implementations exist for Claude Code, Copilot, Codex, etc.
 */
export type SessionSourceProvider = {
  /** Provider identifier matching one of the SessionSourceId values */
  id: SessionSourceId;

  /** Scan native session indexes and return metadata for all discoverable sessions. */
  discoverSessions(): Promise<SessionMetadata[]>;

  /** Read a session's JSONL transcript and return individual lines. */
  readTranscript(sessionId: string): Promise<string[]>;

  /** Check whether the session's transcript file still exists on disk. */
  canResume(sessionId: string): boolean;

  /** Build a reference string (absolute file path) for the Copy Chat Reference feature. */
  buildReference(sessionId: string): string;
};
