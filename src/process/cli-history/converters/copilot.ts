/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { uuid } from '@/common/utils';
import type { TMessage, IMessageText, IMessageAcpToolCall } from '@/common/chat/chatLib';
import type { ToolCallContentItem } from '@/common/types/acpTypes';

// ---------------------------------------------------------------------------
// Copilot CLI JSONL event types
// ---------------------------------------------------------------------------

/** A tool request inside an assistant.message event. */
type CopilotToolRequest = {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  type?: string;
};

/**
 * The parsed shape of a single JSONL line from a Copilot CLI events.jsonl file.
 * Each line is an event envelope with `type`, `data`, `id`, `timestamp`, and
 * optional `parentId`.
 */
type CopilotJsonlEvent = {
  type: string;
  data: Record<string, unknown>;
  id: string;
  timestamp: string;
  parentId?: string | null;
};

// ---------------------------------------------------------------------------
// Internal bookkeeping
// ---------------------------------------------------------------------------

/** Pending tool call waiting for its execution_complete event. */
type PendingToolCall = {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  timestamp: number;
  messageId: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Event types that should not produce any renderable messages. */
const SKIP_EVENT_TYPES = new Set([
  'session.start',
  'session.resume',
  'session.shutdown',
  'session.model_change',
  'session.context_changed',
  'session.info',
  'hook.start',
  'hook.end',
  'subagent.started',
  'subagent.completed',
  'skill.invoked',
  'abort',
  'system.notification',
  'assistant.turn_start',
  'assistant.turn_end',
  'tool.execution_start',
]);

/** Placeholder conversation ID for converted messages. */
const CONVERTED_CONVERSATION_ID = 'cli-history-import';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely parse a JSON line and return the parsed object, or `null` if the
 * line is empty or malformed.
 */
function safeParseLine(line: string): CopilotJsonlEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  try {
    return JSON.parse(trimmed) as CopilotJsonlEvent;
  } catch {
    console.warn('[convertCopilotJsonl] Skipping malformed JSONL line:', trimmed.slice(0, 120));
    return null;
  }
}

/**
 * Extract a millisecond timestamp from an event's timestamp field.
 * Falls back to `Date.now()` when the field is missing or unparseable.
 */
function extractTimestamp(event: CopilotJsonlEvent): number {
  if (!event.timestamp) return Date.now();
  const ms = new Date(event.timestamp).getTime();
  return Number.isNaN(ms) ? Date.now() : ms;
}

/**
 * Determine the `kind` field for an ACP tool call based on the Copilot CLI
 * tool name. Read-oriented tools map to "read", write-oriented ones to "edit",
 * and everything else to "execute".
 */
function toolNameToKind(name: string): 'read' | 'edit' | 'execute' {
  switch (name) {
    case 'view':
    case 'glob':
    case 'rg':
    case 'grep':
    case 'read_agent':
      return 'read';
    case 'edit':
    case 'create':
    case 'write_bash':
      return 'edit';
    default:
      return 'execute';
  }
}

/**
 * Build a human-readable title for a tool call based on its name and arguments.
 */
function buildToolTitle(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'bash':
    case 'read_bash':
    case 'stop_bash':
      return `bash: ${truncate(String(args.command ?? args.input ?? ''), 80)}`;
    case 'view':
      return `view: ${String(args.file_path ?? args.path ?? '')}`;
    case 'edit':
      return `edit: ${String(args.file_path ?? args.path ?? '')}`;
    case 'create':
      return `create: ${String(args.file_path ?? args.path ?? '')}`;
    case 'glob':
      return `glob: ${String(args.pattern ?? '')}`;
    case 'rg':
      return `rg: ${truncate(String(args.pattern ?? args.query ?? ''), 60)}`;
    case 'grep':
      return `grep: ${truncate(String(args.pattern ?? args.query ?? ''), 60)}`;
    case 'web_search':
      return `web_search: ${truncate(String(args.query ?? ''), 60)}`;
    case 'web_fetch':
      return `web_fetch: ${truncate(String(args.url ?? ''), 60)}`;
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
 * Convert Copilot CLI events.jsonl session lines into AionUI's `TMessage[]` format.
 *
 * Each JSONL line represents one event in the session: user messages, assistant
 * responses, tool call requests, tool execution results, etc. This function
 * filters to renderable events and maps them to the `TMessage` union type used
 * by AionUI's conversation renderer.
 *
 * @param lines - Raw JSONL lines from a Copilot CLI events.jsonl file.
 * @param conversationId - Optional conversation ID to assign to all messages.
 *   Defaults to `'cli-history-import'`.
 * @returns An ordered array of `TMessage` objects ready for rendering.
 */
export function convertCopilotJsonl(lines: string[], conversationId?: string): TMessage[] {
  const convId = conversationId ?? CONVERTED_CONVERSATION_ID;
  const messages: TMessage[] = [];

  // Map from toolCallId → pending tool call info (for result merging)
  const pendingToolCalls = new Map<string, PendingToolCall>();

  // Map from toolCallId → index in `messages` array (for result merging)
  const toolMessageIndex = new Map<string, number>();

  for (const rawLine of lines) {
    const parsed = safeParseLine(rawLine);
    if (!parsed) continue;

    // Skip non-renderable event types
    if (SKIP_EVENT_TYPES.has(parsed.type)) continue;

    const timestamp = extractTimestamp(parsed);

    switch (parsed.type) {
      case 'user.message':
        processUserMessage(parsed, timestamp, convId, messages);
        break;

      case 'assistant.message':
        processAssistantMessage(parsed, timestamp, convId, messages, pendingToolCalls, toolMessageIndex);
        break;

      case 'tool.execution_complete':
        processToolResult(parsed, messages, pendingToolCalls, toolMessageIndex);
        break;

      default:
        // Unknown event types are silently ignored
        break;
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Message processors
// ---------------------------------------------------------------------------

/**
 * Process a user.message event.
 * Uses `data.content` (not `transformedContent` which has system-injected metadata).
 */
function processUserMessage(event: CopilotJsonlEvent, timestamp: number, convId: string, messages: TMessage[]): void {
  const content = event.data.content;
  if (typeof content !== 'string' || content.trim().length === 0) return;

  messages.push(createTextMessage(content, 'right', convId, timestamp));
}

/**
 * Process an assistant.message event. Assistant messages can contain:
 * - `content` (text response, may be empty when only tool calls)
 * - `reasoningText` (chain-of-thought reasoning, rendered as collapsible)
 * - `toolRequests[]` (tool call requests)
 */
function processAssistantMessage(
  event: CopilotJsonlEvent,
  timestamp: number,
  convId: string,
  messages: TMessage[],
  pendingToolCalls: Map<string, PendingToolCall>,
  toolMessageIndex: Map<string, number>
): void {
  const data = event.data;

  // Handle reasoning/thinking text
  const reasoningText = data.reasoningText;
  if (typeof reasoningText === 'string' && reasoningText.trim().length > 0) {
    const thinkingContent = '<details><summary>Thinking</summary>\n\n' + reasoningText + '\n\n</details>';
    messages.push(createTextMessage(thinkingContent, 'left', convId, timestamp));
  }

  // Handle main content text
  const content = data.content;
  if (typeof content === 'string' && content.trim().length > 0) {
    messages.push(createTextMessage(content, 'left', convId, timestamp));
  }

  // Handle tool requests
  const toolRequests = data.toolRequests;
  if (Array.isArray(toolRequests)) {
    for (const request of toolRequests) {
      const req = request as CopilotToolRequest;
      if (!req.toolCallId || !req.name) continue;

      const args = req.arguments ?? {};
      const messageId = uuid();

      const toolMessage = createToolCallMessage(req.toolCallId, req.name, args, convId, timestamp, messageId);

      const index = messages.length;
      messages.push(toolMessage);
      toolMessageIndex.set(req.toolCallId, index);

      pendingToolCalls.set(req.toolCallId, {
        toolCallId: req.toolCallId,
        name: req.name,
        args,
        timestamp,
        messageId,
      });
    }
  }
}

/**
 * Process a tool.execution_complete event. Matches it to the corresponding
 * tool call message by `toolCallId` and merges the result.
 */
function processToolResult(
  event: CopilotJsonlEvent,
  messages: TMessage[],
  pendingToolCalls: Map<string, PendingToolCall>,
  toolMessageIndex: Map<string, number>
): void {
  const data = event.data;
  const toolCallId = data.toolCallId;
  if (typeof toolCallId !== 'string') return;

  const index = toolMessageIndex.get(toolCallId);
  if (index === undefined || index >= messages.length) return;

  const existing = messages[index];
  if (existing.type !== 'acp_tool_call') return;

  // Extract result text — prefer detailedContent, fall back to result.content
  const result = data.result as Record<string, unknown> | undefined;
  const resultText = String(result?.detailedContent ?? result?.content ?? '');
  const success = data.success !== false;

  const resultItem: ToolCallContentItem = {
    type: 'content',
    content: {
      type: 'text',
      text: resultText,
    },
  };

  const finalStatus = success ? 'completed' : 'failed';
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

  pendingToolCalls.delete(toolCallId);
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

/** Create an ACP tool call message from a Copilot CLI tool request. */
function createToolCallMessage(
  toolCallId: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
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
        title: buildToolTitle(toolName, toolArgs),
        kind: toolNameToKind(toolName),
        rawInput: toolArgs,
        content: [],
        locations: [],
      },
    },
  };
}
