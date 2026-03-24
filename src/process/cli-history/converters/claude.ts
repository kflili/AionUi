/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { uuid } from '@/common/utils';
import type { TMessage, IMessageText, IMessageAcpToolCall } from '@/common/chat/chatLib';
import type { ToolCallContentItem } from '@/common/types/acpTypes';

// ---------------------------------------------------------------------------
// Claude Code JSONL line types (Anthropic API + CLI metadata)
// ---------------------------------------------------------------------------

/** A single content block inside an assistant message. */
type AssistantContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      caller?: { type: string };
    }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'server_tool_use'; id: string; name: string; input: Record<string, unknown> };

/** User message content can be a plain string or an array of content blocks. */
type UserContentBlock =
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | Array<{ type: string; text?: string }>;
      is_error: boolean;
    }
  | { type: 'text'; text: string };

/**
 * The parsed shape of a single JSONL line from a Claude Code session file.
 * Not every field is present on every line — the `type` discriminator controls
 * which subset of fields is meaningful.
 */
type ClaudeJsonlLine = {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;

  // User messages
  message?: {
    role: 'user' | 'assistant';
    content: string | UserContentBlock[] | AssistantContentBlock[];
    model?: string;
    id?: string;
    type?: string;
    stop_reason?: string | null;
    usage?: Record<string, unknown>;
  };

  // Progress events
  data?: Record<string, unknown>;
  toolUseID?: string;

  // tool_result helper (present on user lines that carry a tool result)
  toolUseResult?: {
    stdout?: string;
    stderr?: string;
    interrupted?: boolean;
    isImage?: boolean;
  };
  sourceToolAssistantUUID?: string;

  // file-history-snapshot / last-prompt / system / subtype markers
  subtype?: string;
  snapshot?: unknown;
  lastPrompt?: string;
};

// ---------------------------------------------------------------------------
// Internal bookkeeping
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** JSONL line types that carry no renderable content and should be skipped. */
const SKIP_LINE_TYPES = new Set(['file-history-snapshot', 'last-prompt', 'progress', 'system', 'summary']);

/** Placeholder conversation ID for converted messages (not tied to a real conversation). */
const CONVERTED_CONVERSATION_ID = 'cli-history-import';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely parse a JSON line and return the parsed object, or `null` if the
 * line is empty or malformed.
 */
function safeParseLine(line: string): ClaudeJsonlLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  try {
    return JSON.parse(trimmed) as ClaudeJsonlLine;
  } catch {
    console.warn('[convertClaudeJsonl] Skipping malformed JSONL line:', trimmed.slice(0, 120));
    return null;
  }
}

/**
 * Extract a millisecond timestamp from a JSONL line's timestamp field.
 * Falls back to `Date.now()` when the field is missing or unparseable.
 */
function extractTimestamp(line: ClaudeJsonlLine): number {
  if (!line.timestamp) return Date.now();
  const ms = new Date(line.timestamp).getTime();
  return Number.isNaN(ms) ? Date.now() : ms;
}

/**
 * Determine the `kind` field for an ACP tool call based on the Claude Code
 * tool name. Read-oriented tools map to "read", write-oriented ones to "edit",
 * and everything else (especially Bash) to "execute".
 */
function toolNameToKind(name: string): 'read' | 'edit' | 'execute' {
  switch (name) {
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'ToolSearch':
      return 'read';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit';
    default:
      return 'execute';
  }
}

/**
 * Build a human-readable title for a tool call based on its name and input.
 * Mirrors how the ACP renderer presents tool calls.
 */
function buildToolTitle(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return `Bash: ${truncate(String(input.command ?? ''), 80)}`;
    case 'Read':
      return `Read: ${String(input.file_path ?? '')}`;
    case 'Write':
      return `Write: ${String(input.file_path ?? '')}`;
    case 'Edit':
      return `Edit: ${String(input.file_path ?? '')}`;
    case 'Glob':
      return `Glob: ${String(input.pattern ?? '')}`;
    case 'Grep':
      return `Grep: ${String(input.pattern ?? '')}`;
    case 'WebSearch':
      return `WebSearch: ${truncate(String(input.query ?? ''), 60)}`;
    case 'WebFetch':
      return `WebFetch: ${truncate(String(input.url ?? ''), 60)}`;
    default:
      return name;
  }
}

/** Truncate a string to `max` characters, appending "..." if trimmed. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

// ---------------------------------------------------------------------------
// Core converter
// ---------------------------------------------------------------------------

/**
 * Convert Claude Code CLI JSONL session lines into AionUI's `TMessage[]` format.
 *
 * Each JSONL line represents one event in the session: user messages, assistant
 * responses (text, thinking, tool_use), tool results, progress events, file
 * history snapshots, etc. This function filters to renderable events and maps
 * them to the `TMessage` union type used by AionUI's conversation renderer.
 *
 * @param lines - Raw JSONL lines from a Claude Code session file.
 * @param conversationId - Optional conversation ID to assign to all messages.
 *   Defaults to `'cli-history-import'`.
 * @returns An ordered array of `TMessage` objects ready for rendering.
 */
export function convertClaudeJsonl(lines: string[], conversationId?: string): TMessage[] {
  const convId = conversationId ?? CONVERTED_CONVERSATION_ID;
  const messages: TMessage[] = [];

  // Map from tool_use ID → index in `messages` array (for result merging)
  const toolMessageIndex = new Map<string, number>();

  for (const rawLine of lines) {
    const parsed = safeParseLine(rawLine);
    if (!parsed) continue;

    // Skip non-renderable event types
    if (SKIP_LINE_TYPES.has(parsed.type)) continue;

    const timestamp = extractTimestamp(parsed);

    // --- User message ---
    if (parsed.type === 'user' && parsed.message) {
      processUserMessage(parsed, timestamp, convId, messages, toolMessageIndex);
      continue;
    }

    // --- Assistant message ---
    if (parsed.type === 'assistant' && parsed.message) {
      processAssistantMessage(parsed, timestamp, convId, messages, toolMessageIndex);
      continue;
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Message processors
// ---------------------------------------------------------------------------

/**
 * Process a user-type JSONL line. User messages can contain:
 * - Plain text (a simple user prompt)
 * - An array with tool_result blocks (responses to tool_use calls)
 * - An array with text blocks (e.g., "[Request interrupted by user]")
 */
function processUserMessage(
  parsed: ClaudeJsonlLine,
  timestamp: number,
  convId: string,
  messages: TMessage[],
  toolMessageIndex: Map<string, number>
): void {
  const content = parsed.message?.content;
  if (content === undefined || content === null) return;

  // Simple string content → user text message (skip empty/whitespace)
  if (typeof content === 'string') {
    if (content.trim().length === 0) return;
    messages.push(createTextMessage(content, 'right', convId, timestamp));
    return;
  }

  // Array content — iterate blocks
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;

    const typedBlock = block as UserContentBlock;

    if (typedBlock.type === 'tool_result') {
      mergeToolResult(typedBlock.tool_use_id, typedBlock.content, typedBlock.is_error, messages, toolMessageIndex);
    } else if (typedBlock.type === 'text') {
      // Text blocks in user arrays are typically interruption notices (skip empty/malformed)
      if (typeof typedBlock.text === 'string' && typedBlock.text.trim().length > 0) {
        messages.push(createTextMessage(typedBlock.text, 'right', convId, timestamp));
      }
    }
  }
}

/**
 * Process an assistant-type JSONL line. Assistant messages can contain:
 * - text blocks (the assistant's response)
 * - thinking blocks (chain-of-thought reasoning)
 * - tool_use blocks (tool call requests)
 * - server_tool_use blocks (server-side tool calls, treated like tool_use)
 *
 * Note: A single JSONL line may contain MULTIPLE content blocks (e.g., a
 * thinking block followed by several tool_use blocks). Each block is mapped
 * to its own TMessage.
 */
function processAssistantMessage(
  parsed: ClaudeJsonlLine,
  timestamp: number,
  convId: string,
  messages: TMessage[],
  toolMessageIndex: Map<string, number>
): void {
  const msgContent = parsed.message?.content;
  if (!Array.isArray(msgContent)) return;

  // Collect consecutive text blocks into a single message
  let pendingTextParts: string[] = [];

  const flushText = () => {
    if (pendingTextParts.length > 0) {
      const combinedText = pendingTextParts.join('');
      if (combinedText.trim().length > 0) {
        messages.push(createTextMessage(combinedText, 'left', convId, timestamp));
      }
      pendingTextParts = [];
    }
  };

  for (const block of msgContent) {
    if (typeof block !== 'object' || block === null) continue;

    const typedBlock = block as AssistantContentBlock;

    switch (typedBlock.type) {
      case 'text': {
        pendingTextParts.push(typedBlock.text);
        break;
      }

      case 'thinking': {
        // Flush any accumulated text before the thinking block
        flushText();

        // Skip empty thinking blocks
        if (!typedBlock.thinking || typedBlock.thinking.trim().length === 0) break;

        // Render thinking as a left-aligned text message wrapped in
        // a <details> block so the UI can present it as collapsible.
        const thinkingContent = '<details><summary>Thinking</summary>\n\n' + typedBlock.thinking + '\n\n</details>';
        messages.push(createTextMessage(thinkingContent, 'left', convId, timestamp));
        break;
      }

      case 'tool_use':
      case 'server_tool_use': {
        // Flush any accumulated text before the tool call
        flushText();

        const toolId = typedBlock.id;
        const toolName = typedBlock.name;
        const toolInput = typedBlock.input;
        const messageId = uuid();

        const toolMessage = createToolCallMessage(toolId, toolName, toolInput, convId, timestamp, messageId);

        const index = messages.length;
        messages.push(toolMessage);
        toolMessageIndex.set(toolId, index);

        break;
      }

      default:
        // Unknown block types are silently ignored
        break;
    }
  }

  // Flush any remaining text
  flushText();
}

/**
 * Merge a tool_result into its corresponding tool_use message.
 *
 * Claude Code JSONL stores tool results as user messages with
 * `content: [{type: "tool_result", tool_use_id: "...", content: "..."}]`.
 * This function finds the matching tool_use TMessage and appends the
 * result text to its `content` array.
 */
function mergeToolResult(
  toolUseId: string,
  resultContent: string | Array<{ type: string; text?: string }>,
  isError: boolean,
  messages: TMessage[],
  toolMessageIndex: Map<string, number>
): void {
  const index = toolMessageIndex.get(toolUseId);

  if (index === undefined || index >= messages.length) {
    // No matching tool_use found — this can happen with truncated sessions
    // or if the JSONL file is incomplete. Skip silently.
    return;
  }

  const existing = messages[index];
  if (existing.type !== 'acp_tool_call') return;

  // Normalize content: Anthropic API allows string or array of content blocks
  const normalizedContent = Array.isArray(resultContent)
    ? resultContent.map((block) => block.text ?? '').join('\n')
    : resultContent;

  // Build the result content item
  const resultItem: ToolCallContentItem = {
    type: 'content',
    content: {
      type: 'text',
      text: normalizedContent,
    },
  };

  // Determine final status based on whether the result is an error
  const finalStatus = isError ? 'failed' : 'completed';

  // Create updated message with result merged in
  const updatedContent = [...(existing.content.update.content ?? []), resultItem];
  messages[index] = {
    ...existing,
    content: {
      ...existing.content,
      update: {
        ...existing.content.update,
        status: finalStatus,
        content: updatedContent,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Message factories
// ---------------------------------------------------------------------------

/** Create a text message (user or assistant). */
function createTextMessage(
  text: string,
  position: 'left' | 'right',
  conversationId: string,
  createdAt: number
): IMessageText {
  return {
    id: uuid(),
    type: 'text',
    position,
    conversation_id: conversationId,
    createdAt,
    content: { content: text },
  };
}

/** Create an ACP tool call message from a Claude Code tool_use block. */
function createToolCallMessage(
  toolCallId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  conversationId: string,
  createdAt: number,
  messageId: string
): IMessageAcpToolCall {
  return {
    id: messageId,
    type: 'acp_tool_call',
    position: 'left',
    conversation_id: conversationId,
    createdAt,
    content: {
      sessionId: conversationId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        status: 'in_progress',
        title: buildToolTitle(toolName, toolInput),
        kind: toolNameToKind(toolName),
        rawInput: toolInput,
        content: [],
        locations: [],
      },
    },
  };
}
