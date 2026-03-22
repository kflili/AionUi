/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { convertCopilotJsonl } from '@process/cli-history/converters/copilot';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal user.message event line. */
function userMessageLine(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user.message',
    id: 'user-' + Math.random().toString(36).slice(2, 10),
    timestamp: '2026-03-20T10:00:00.000Z',
    parentId: null,
    data: { content, attachments: [], ...extra },
  });
}

/** Build a minimal assistant.message event line. */
function assistantMessageLine(data: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant.message',
    id: 'asst-' + Math.random().toString(36).slice(2, 10),
    timestamp: '2026-03-20T10:00:01.000Z',
    parentId: null,
    data: { content: '', toolRequests: [], ...data },
    ...extra,
  });
}

/** Build a tool.execution_complete event line. */
function toolCompleteLine(
  toolCallId: string,
  success: boolean,
  resultContent: string,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    type: 'tool.execution_complete',
    id: 'tool-' + Math.random().toString(36).slice(2, 10),
    timestamp: '2026-03-20T10:00:02.000Z',
    parentId: null,
    data: {
      toolCallId,
      success,
      result: { content: resultContent, detailedContent: resultContent },
      ...extra,
    },
  });
}

/** Build a session.start event line (should be skipped). */
function sessionStartLine(): string {
  return JSON.stringify({
    type: 'session.start',
    id: 'sess-start',
    timestamp: '2026-03-20T10:00:00.000Z',
    parentId: null,
    data: { sessionId: 'test-session' },
  });
}

/** Build an assistant.turn_start event line (should be skipped). */
function turnStartLine(): string {
  return JSON.stringify({
    type: 'assistant.turn_start',
    id: 'turn-start-1',
    timestamp: '2026-03-20T10:00:00.500Z',
    parentId: null,
    data: { turnId: 'turn-1', interactionId: 'interaction-1' },
  });
}

/** Build an assistant.turn_end event line (should be skipped). */
function turnEndLine(): string {
  return JSON.stringify({
    type: 'assistant.turn_end',
    id: 'turn-end-1',
    timestamp: '2026-03-20T10:00:03.000Z',
    parentId: null,
    data: { turnId: 'turn-1' },
  });
}

/** Build a tool.execution_start event line (should be skipped). */
function toolStartLine(): string {
  return JSON.stringify({
    type: 'tool.execution_start',
    id: 'tool-start-1',
    timestamp: '2026-03-20T10:00:01.500Z',
    parentId: null,
    data: { toolCallId: 'tc-1', toolName: 'bash', arguments: { command: 'ls' } },
  });
}

/** Build a hook.start event line (should be skipped). */
function hookStartLine(): string {
  return JSON.stringify({
    type: 'hook.start',
    id: 'hook-1',
    timestamp: '2026-03-20T10:00:00.000Z',
    parentId: null,
    data: {},
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('convertCopilotJsonl', () => {
  // -----------------------------------------------------------------------
  // Empty / edge cases
  // -----------------------------------------------------------------------

  it('returns empty array for empty input', () => {
    expect(convertCopilotJsonl([])).toEqual([]);
  });

  it('returns empty array when all lines are empty strings', () => {
    expect(convertCopilotJsonl(['', '  ', '\n'])).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Malformed lines
  // -----------------------------------------------------------------------

  it('skips malformed JSON lines gracefully', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const lines = ['{ this is not valid json', userMessageLine('hello')];

    const result = convertCopilotJsonl(lines);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('text');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('skips lines that are just whitespace or newlines', () => {
    const result = convertCopilotJsonl(['   ', '\t', '']);
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Non-renderable event types (skipped)
  // -----------------------------------------------------------------------

  it('skips session.start events', () => {
    expect(convertCopilotJsonl([sessionStartLine()])).toEqual([]);
  });

  it('skips assistant.turn_start events', () => {
    expect(convertCopilotJsonl([turnStartLine()])).toEqual([]);
  });

  it('skips assistant.turn_end events', () => {
    expect(convertCopilotJsonl([turnEndLine()])).toEqual([]);
  });

  it('skips tool.execution_start events', () => {
    expect(convertCopilotJsonl([toolStartLine()])).toEqual([]);
  });

  it('skips hook.start events', () => {
    expect(convertCopilotJsonl([hookStartLine()])).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Simple user / assistant conversation
  // -----------------------------------------------------------------------

  it('converts a simple user message to right-aligned text', () => {
    const result = convertCopilotJsonl([userMessageLine('Hello, Copilot!')]);

    expect(result).toHaveLength(1);
    const msg = result[0];
    expect(msg.type).toBe('text');
    expect(msg.position).toBe('right');
    if (msg.type === 'text') {
      expect(msg.content.content).toBe('Hello, Copilot!');
    }
  });

  it('converts an assistant text response to left-aligned text', () => {
    const lines = [assistantMessageLine({ content: 'Hello! How can I help?' })];

    const result = convertCopilotJsonl(lines);
    expect(result).toHaveLength(1);
    const msg = result[0];
    expect(msg.type).toBe('text');
    expect(msg.position).toBe('left');
    if (msg.type === 'text') {
      expect(msg.content.content).toBe('Hello! How can I help?');
    }
  });

  it('handles a multi-turn user/assistant conversation', () => {
    const lines = [
      userMessageLine('What is TypeScript?'),
      assistantMessageLine({ content: 'TypeScript is a typed superset of JavaScript.' }),
      userMessageLine('Thanks!'),
      assistantMessageLine({ content: "You're welcome!" }),
    ];

    const result = convertCopilotJsonl(lines);
    expect(result).toHaveLength(4);
    expect(result[0].position).toBe('right');
    expect(result[1].position).toBe('left');
    expect(result[2].position).toBe('right');
    expect(result[3].position).toBe('left');
  });

  it('assigns unique IDs to each message', () => {
    const lines = [userMessageLine('msg1'), userMessageLine('msg2')];

    const result = convertCopilotJsonl(lines);
    expect(result[0].id).not.toBe(result[1].id);
  });

  it('sets timestamps from JSONL entries', () => {
    const lines = [userMessageLine('hello')];

    const result = convertCopilotJsonl(lines);
    expect(result[0].createdAt).toBe(new Date('2026-03-20T10:00:00.000Z').getTime());
  });

  it('uses provided conversationId', () => {
    const result = convertCopilotJsonl([userMessageLine('hi')], 'my-conv-123');
    expect(result[0].conversation_id).toBe('my-conv-123');
  });

  it('uses default conversationId when not provided', () => {
    const result = convertCopilotJsonl([userMessageLine('hi')]);
    expect(result[0].conversation_id).toBe('cli-history-import');
  });

  it('uses content, not transformedContent, for user messages', () => {
    const lines = [userMessageLine('plain prompt', { transformedContent: 'system injected metadata + plain prompt' })];

    const result = convertCopilotJsonl(lines);
    expect(result).toHaveLength(1);
    if (result[0].type === 'text') {
      expect(result[0].content.content).toBe('plain prompt');
    }
  });

  // -----------------------------------------------------------------------
  // Thinking / reasoning blocks
  // -----------------------------------------------------------------------

  it('converts reasoningText to collapsible text messages', () => {
    const lines = [
      assistantMessageLine({
        reasoningText: 'Let me analyze this problem...',
        content: 'Here is my answer.',
      }),
    ];

    const result = convertCopilotJsonl(lines);
    expect(result).toHaveLength(2);

    // Thinking message (collapsible)
    const thinkingMsg = result[0];
    expect(thinkingMsg.type).toBe('text');
    expect(thinkingMsg.position).toBe('left');
    if (thinkingMsg.type === 'text') {
      expect(thinkingMsg.content.content).toContain('<details>');
      expect(thinkingMsg.content.content).toContain('Let me analyze this problem...');
      expect(thinkingMsg.content.content).toContain('</details>');
    }

    // Text message
    if (result[1].type === 'text') {
      expect(result[1].content.content).toBe('Here is my answer.');
    }
  });

  it('skips empty reasoningText', () => {
    const lines = [
      assistantMessageLine({
        reasoningText: '',
        content: 'Answer.',
      }),
    ];

    const result = convertCopilotJsonl(lines);
    expect(result).toHaveLength(1);
    if (result[0].type === 'text') {
      expect(result[0].content.content).toBe('Answer.');
    }
  });

  it('skips whitespace-only reasoningText', () => {
    const lines = [
      assistantMessageLine({
        reasoningText: '   \n  ',
        content: 'Answer.',
      }),
    ];

    const result = convertCopilotJsonl(lines);
    expect(result).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Tool calls
  // -----------------------------------------------------------------------

  it('converts a single tool request to an acp_tool_call message', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [
          {
            toolCallId: 'tc_001',
            name: 'bash',
            arguments: { command: 'ls -la' },
            type: 'function',
          },
        ],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    expect(result).toHaveLength(1);

    const msg = result[0];
    expect(msg.type).toBe('acp_tool_call');
    if (msg.type === 'acp_tool_call') {
      expect(msg.content.update.toolCallId).toBe('tc_001');
      expect(msg.content.update.title).toContain('bash');
      expect(msg.content.update.kind).toBe('execute');
      expect(msg.content.update.rawInput).toEqual({ command: 'ls -la' });
      expect(msg.content.update.status).toBe('in_progress');
    }
  });

  it('maps view tool to kind "read"', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_002', name: 'view', arguments: { file_path: '/tmp/test.txt' } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.kind).toBe('read');
      expect(result[0].content.update.title).toContain('/tmp/test.txt');
    }
  });

  it('maps edit tool to kind "edit"', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_003', name: 'edit', arguments: { file_path: '/tmp/test.txt' } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.kind).toBe('edit');
    }
  });

  it('maps create tool to kind "edit"', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_004', name: 'create', arguments: { file_path: '/tmp/new.txt' } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.kind).toBe('edit');
    }
  });

  it('maps glob tool to kind "read"', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_005', name: 'glob', arguments: { pattern: '**/*.ts' } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.kind).toBe('read');
    }
  });

  it('maps rg tool to kind "read"', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_006', name: 'rg', arguments: { pattern: 'TODO' } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.kind).toBe('read');
    }
  });

  it('maps unknown tool name to kind "execute"', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_007', name: 'some_custom_tool', arguments: { foo: 'bar' } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.kind).toBe('execute');
    }
  });

  // -----------------------------------------------------------------------
  // Tool results merging
  // -----------------------------------------------------------------------

  it('merges tool.execution_complete into the corresponding tool call message', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_merge_1', name: 'bash', arguments: { command: 'echo hello' } }],
      }),
      toolCompleteLine('tc_merge_1', true, 'hello\n'),
    ];

    const result = convertCopilotJsonl(lines);
    // Should still be 1 message (tool call with result merged)
    expect(result).toHaveLength(1);

    const msg = result[0];
    expect(msg.type).toBe('acp_tool_call');
    if (msg.type === 'acp_tool_call') {
      expect(msg.content.update.status).toBe('completed');
      expect(msg.content.update.content).toHaveLength(1);
      expect(msg.content.update.content![0].content?.text).toBe('hello\n');
    }
  });

  it('marks tool call as failed when execution_complete has success=false', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_err_1', name: 'bash', arguments: { command: 'nonexistent_cmd' } }],
      }),
      toolCompleteLine('tc_err_1', false, 'command not found: nonexistent_cmd'),
    ];

    const result = convertCopilotJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.status).toBe('failed');
    }
  });

  it('handles missing tool result gracefully (tool stays in_progress)', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_no_result', name: 'bash', arguments: { command: 'sleep 100' } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    expect(result).toHaveLength(1);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.status).toBe('in_progress');
    }
  });

  it('handles orphaned tool result (no matching tool call) gracefully', () => {
    const lines = [toolCompleteLine('tc_nonexistent', true, 'some output')];

    // Should not crash, just skip the orphaned result
    const result = convertCopilotJsonl(lines);
    expect(result).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Multiple tool calls in a single assistant message
  // -----------------------------------------------------------------------

  it('handles multiple tool requests in a single assistant message', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [
          { toolCallId: 'tc_multi_1', name: 'bash', arguments: { command: 'pwd' } },
          { toolCallId: 'tc_multi_2', name: 'view', arguments: { file_path: '/tmp/test.txt' } },
        ],
      }),
      toolCompleteLine('tc_multi_1', true, '/home/user'),
      toolCompleteLine('tc_multi_2', true, 'file contents here'),
    ];

    const result = convertCopilotJsonl(lines);
    expect(result).toHaveLength(2);

    // Both should be completed with results
    for (const msg of result) {
      expect(msg.type).toBe('acp_tool_call');
      if (msg.type === 'acp_tool_call') {
        expect(msg.content.update.status).toBe('completed');
        expect(msg.content.update.content).toHaveLength(1);
      }
    }

    // Verify correct matching
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.toolCallId).toBe('tc_multi_1');
      expect(result[0].content.update.content![0].content?.text).toBe('/home/user');
    }
    if (result[1].type === 'acp_tool_call') {
      expect(result[1].content.update.toolCallId).toBe('tc_multi_2');
      expect(result[1].content.update.content![0].content?.text).toBe('file contents here');
    }
  });

  // -----------------------------------------------------------------------
  // Mixed content: text + tool calls in same assistant message
  // -----------------------------------------------------------------------

  it('handles text and tool requests in same assistant message', () => {
    const lines = [
      assistantMessageLine({
        content: 'Let me check that for you.',
        toolRequests: [{ toolCallId: 'tc_mixed_1', name: 'bash', arguments: { command: 'ls' } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('text');
    expect(result[1].type).toBe('acp_tool_call');
  });

  it('handles reasoning + text + tool requests in same assistant message', () => {
    const lines = [
      assistantMessageLine({
        reasoningText: 'I need to check the file system.',
        content: 'Let me look at the files.',
        toolRequests: [{ toolCallId: 'tc_mixed_2', name: 'bash', arguments: { command: 'ls' } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    expect(result).toHaveLength(3);
    // thinking (collapsible text)
    expect(result[0].type).toBe('text');
    if (result[0].type === 'text') {
      expect(result[0].content.content).toContain('<details>');
    }
    // text
    expect(result[1].type).toBe('text');
    // tool call
    expect(result[2].type).toBe('acp_tool_call');
  });

  // -----------------------------------------------------------------------
  // Assistant message with only tool calls (no text)
  // -----------------------------------------------------------------------

  it('handles assistant message with empty content but tool requests', () => {
    const lines = [
      assistantMessageLine({
        content: '',
        toolRequests: [{ toolCallId: 'tc_only', name: 'bash', arguments: { command: 'ls' } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('acp_tool_call');
  });

  // -----------------------------------------------------------------------
  // Full conversation flow (realistic scenario)
  // -----------------------------------------------------------------------

  it('handles a realistic full conversation with all event types', () => {
    const lines = [
      sessionStartLine(),
      userMessageLine('List the files in the current directory'),
      turnStartLine(),
      assistantMessageLine({
        reasoningText: 'The user wants to see the files.',
        toolRequests: [{ toolCallId: 'tc_real_1', name: 'bash', arguments: { command: 'ls -la' } }],
      }),
      toolStartLine(),
      toolCompleteLine('tc_real_1', true, 'file1.txt\nfile2.txt\nREADME.md'),
      assistantMessageLine({
        content: 'Here are the files in the current directory:\n- file1.txt\n- file2.txt\n- README.md',
      }),
      turnEndLine(),
      hookStartLine(),
    ];

    const result = convertCopilotJsonl(lines);

    // Expected messages: user text, thinking, tool call (with result merged), assistant text
    expect(result).toHaveLength(4);

    // 1. User message
    expect(result[0].type).toBe('text');
    expect(result[0].position).toBe('right');

    // 2. Thinking block
    expect(result[1].type).toBe('text');
    expect(result[1].position).toBe('left');
    if (result[1].type === 'text') {
      expect(result[1].content.content).toContain('<details>');
    }

    // 3. Tool call with result merged
    expect(result[2].type).toBe('acp_tool_call');
    if (result[2].type === 'acp_tool_call') {
      expect(result[2].content.update.status).toBe('completed');
      expect(result[2].content.update.content).toHaveLength(1);
    }

    // 4. Assistant text response
    expect(result[3].type).toBe('text');
    expect(result[3].position).toBe('left');
  });

  // -----------------------------------------------------------------------
  // Title generation
  // -----------------------------------------------------------------------

  it('generates descriptive titles for bash tool calls', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_title_1', name: 'bash', arguments: { command: 'echo "Hello World"' } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.title).toBe('bash: echo "Hello World"');
    }
  });

  it('truncates long bash commands in titles', () => {
    const longCommand = 'a'.repeat(100);
    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_title_2', name: 'bash', arguments: { command: longCommand } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.title.length).toBeLessThanOrEqual(90);
      expect(result[0].content.update.title).toContain('...');
    }
  });

  it('generates titles for rg and glob tools', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_title_3', name: 'rg', arguments: { pattern: 'TODO|FIXME' } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.title).toBe('rg: TODO|FIXME');
    }
  });

  it('uses tool name as fallback title for unknown tools', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_title_4', name: 'custom_tool', arguments: { key: 'value' } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.title).toBe('custom_tool');
    }
  });

  // -----------------------------------------------------------------------
  // web_search / web_fetch tool title generation
  // -----------------------------------------------------------------------

  it('generates titles for web_search and web_fetch tools', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_ws', name: 'web_search', arguments: { query: 'vitest docs' } }],
      }),
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_wf', name: 'web_fetch', arguments: { url: 'https://example.com/api' } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.title).toBe('web_search: vitest docs');
    }
    if (result[1].type === 'acp_tool_call') {
      expect(result[1].content.update.title).toBe('web_fetch: https://example.com/api');
    }
  });

  // -----------------------------------------------------------------------
  // Null / undefined edge cases
  // -----------------------------------------------------------------------

  it('handles user message with empty content gracefully', () => {
    const lines = [userMessageLine('')];

    const result = convertCopilotJsonl(lines);
    expect(result).toEqual([]);
  });

  it('handles assistant message with no content and no tool requests', () => {
    const lines = [assistantMessageLine({ content: '', toolRequests: [] })];

    const result = convertCopilotJsonl(lines);
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Tool results interleaved with non-renderable events
  // -----------------------------------------------------------------------

  it('correctly merges tool results even with skipped events between them', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_interleave', name: 'bash', arguments: { command: 'ls' } }],
      }),
      toolStartLine(),
      hookStartLine(),
      toolCompleteLine('tc_interleave', true, 'file1.txt'),
    ];

    const result = convertCopilotJsonl(lines);
    expect(result).toHaveLength(1);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.status).toBe('completed');
      expect(result[0].content.update.content![0].content?.text).toBe('file1.txt');
    }
  });

  // -----------------------------------------------------------------------
  // Timestamp fallback
  // -----------------------------------------------------------------------

  it('falls back to Date.now() for missing timestamps', () => {
    const line = JSON.stringify({
      type: 'user.message',
      id: 'user-no-ts',
      parentId: null,
      data: { content: 'hello', attachments: [] },
    });

    const before = Date.now();
    const result = convertCopilotJsonl([line]);
    const after = Date.now();

    expect(result[0].createdAt).toBeGreaterThanOrEqual(before);
    expect(result[0].createdAt).toBeLessThanOrEqual(after);
  });

  it('falls back to Date.now() for invalid timestamps', () => {
    const line = JSON.stringify({
      type: 'user.message',
      id: 'user-bad-ts',
      timestamp: 'not-a-date',
      parentId: null,
      data: { content: 'hello', attachments: [] },
    });

    const before = Date.now();
    const result = convertCopilotJsonl([line]);
    const after = Date.now();

    expect(result[0].createdAt).toBeGreaterThanOrEqual(before);
    expect(result[0].createdAt).toBeLessThanOrEqual(after);
  });

  // -----------------------------------------------------------------------
  // Type safety: every returned message matches TMessage
  // -----------------------------------------------------------------------

  it('all returned messages conform to TMessage type', () => {
    const lines = [
      userMessageLine('Hello'),
      assistantMessageLine({
        reasoningText: 'Hmm...',
        content: 'Hi there!',
        toolRequests: [{ toolCallId: 'tc_type', name: 'bash', arguments: { command: 'echo hi' } }],
      }),
      toolCompleteLine('tc_type', true, 'hi'),
    ];

    const result = convertCopilotJsonl(lines);

    for (const msg of result) {
      // Every message must have these required fields
      expect(msg.id).toBeDefined();
      expect(typeof msg.id).toBe('string');
      expect(msg.type).toBeDefined();
      expect(msg.conversation_id).toBeDefined();
      expect(msg.createdAt).toBeDefined();
      expect(typeof msg.createdAt).toBe('number');

      // type assertion: TMessage union check
      const validTypes = [
        'text',
        'tips',
        'tool_call',
        'tool_group',
        'agent_status',
        'acp_permission',
        'acp_tool_call',
        'codex_permission',
        'codex_tool_call',
        'plan',
        'available_commands',
      ];
      expect(validTypes).toContain(msg.type);
    }
  });

  // -----------------------------------------------------------------------
  // Tool requests with missing fields are skipped
  // -----------------------------------------------------------------------

  it('skips tool requests with missing toolCallId', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [{ name: 'bash', arguments: { command: 'ls' } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    expect(result).toEqual([]);
  });

  it('skips tool requests with missing name', () => {
    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_noname', arguments: { command: 'ls' } }],
      }),
    ];

    const result = convertCopilotJsonl(lines);
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // detailedContent preferred over content in tool results
  // -----------------------------------------------------------------------

  it('prefers detailedContent over content in tool results', () => {
    const line = JSON.stringify({
      type: 'tool.execution_complete',
      id: 'tool-detailed',
      timestamp: '2026-03-20T10:00:02.000Z',
      parentId: null,
      data: {
        toolCallId: 'tc_detailed',
        success: true,
        result: { content: 'short version', detailedContent: 'detailed version with extra info' },
      },
    });

    const lines = [
      assistantMessageLine({
        toolRequests: [{ toolCallId: 'tc_detailed', name: 'bash', arguments: { command: 'ls -la' } }],
      }),
      line,
    ];

    const result = convertCopilotJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.content![0].content?.text).toBe('detailed version with extra info');
    }
  });
});
