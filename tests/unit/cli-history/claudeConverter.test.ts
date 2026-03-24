/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { convertClaudeJsonl } from '@process/cli-history/converters/claude';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal user JSONL line. */
function userLine(content: string | unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    uuid: 'user-' + Math.random().toString(36).slice(2, 10),
    timestamp: '2026-03-20T10:00:00.000Z',
    message: { role: 'user', content },
    ...extra,
  });
}

/** Build a minimal assistant JSONL line with content blocks. */
function assistantLine(contentBlocks: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'asst-' + Math.random().toString(36).slice(2, 10),
    timestamp: '2026-03-20T10:00:01.000Z',
    message: {
      role: 'assistant',
      content: contentBlocks,
      model: 'claude-opus-4-6',
      id: 'msg_test',
      type: 'message',
      stop_reason: 'end_turn',
    },
    ...extra,
  });
}

/** Build a file-history-snapshot line (should be skipped). */
function snapshotLine(): string {
  return JSON.stringify({
    type: 'file-history-snapshot',
    messageId: 'snap-1',
    snapshot: { trackedFileBackups: {} },
  });
}

/** Build a progress line (should be skipped). */
function progressLine(): string {
  return JSON.stringify({
    type: 'progress',
    data: { type: 'hook_progress', hookEvent: 'PreToolUse' },
    toolUseID: 'toolu_test',
  });
}

/** Build a last-prompt line (should be skipped). */
function lastPromptLine(): string {
  return JSON.stringify({
    type: 'last-prompt',
    lastPrompt: 'hello',
    sessionId: 'sess-1',
  });
}

/** Build a system line (should be skipped). */
function systemLine(): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'stop_hook_summary',
    hookCount: 1,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('convertClaudeJsonl', () => {
  // -----------------------------------------------------------------------
  // Empty / edge cases
  // -----------------------------------------------------------------------

  it('returns empty array for empty input', () => {
    expect(convertClaudeJsonl([])).toEqual([]);
  });

  it('returns empty array when all lines are empty strings', () => {
    expect(convertClaudeJsonl(['', '  ', '\n'])).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Malformed lines
  // -----------------------------------------------------------------------

  it('skips malformed JSON lines gracefully', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const lines = ['{ this is not valid json', userLine('hello')];

    const result = convertClaudeJsonl(lines);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('text');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('skips lines that are just whitespace or newlines', () => {
    const result = convertClaudeJsonl(['   ', '\t', '']);
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Non-renderable line types (skipped)
  // -----------------------------------------------------------------------

  it('skips file-history-snapshot lines', () => {
    expect(convertClaudeJsonl([snapshotLine()])).toEqual([]);
  });

  it('skips progress lines', () => {
    expect(convertClaudeJsonl([progressLine()])).toEqual([]);
  });

  it('skips last-prompt lines', () => {
    expect(convertClaudeJsonl([lastPromptLine()])).toEqual([]);
  });

  it('skips system lines', () => {
    expect(convertClaudeJsonl([systemLine()])).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Simple user / assistant conversation
  // -----------------------------------------------------------------------

  it('converts a simple user message to right-aligned text', () => {
    const result = convertClaudeJsonl([userLine('Hello, Claude!')]);

    expect(result).toHaveLength(1);
    const msg = result[0];
    expect(msg.type).toBe('text');
    expect(msg.position).toBe('right');
    if (msg.type === 'text') {
      expect(msg.content.content).toBe('Hello, Claude!');
    }
  });

  it('converts an assistant text response to left-aligned text', () => {
    const lines = [assistantLine([{ type: 'text', text: 'Hello! How can I help?' }])];

    const result = convertClaudeJsonl(lines);
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
      userLine('What is TypeScript?'),
      assistantLine([{ type: 'text', text: 'TypeScript is a typed superset of JavaScript.' }]),
      userLine('Thanks!'),
      assistantLine([{ type: 'text', text: "You're welcome!" }]),
    ];

    const result = convertClaudeJsonl(lines);
    expect(result).toHaveLength(4);
    expect(result[0].position).toBe('right');
    expect(result[1].position).toBe('left');
    expect(result[2].position).toBe('right');
    expect(result[3].position).toBe('left');
  });

  it('assigns unique IDs to each message', () => {
    const lines = [userLine('msg1'), userLine('msg2')];

    const result = convertClaudeJsonl(lines);
    expect(result[0].id).not.toBe(result[1].id);
  });

  it('sets timestamps from JSONL entries', () => {
    const lines = [userLine('hello')];

    const result = convertClaudeJsonl(lines);
    expect(result[0].createdAt).toBe(new Date('2026-03-20T10:00:00.000Z').getTime());
  });

  it('uses provided conversationId', () => {
    const result = convertClaudeJsonl([userLine('hi')], 'my-conv-123');
    expect(result[0].conversation_id).toBe('my-conv-123');
  });

  it('uses default conversationId when not provided', () => {
    const result = convertClaudeJsonl([userLine('hi')]);
    expect(result[0].conversation_id).toBe('cli-history-import');
  });

  // -----------------------------------------------------------------------
  // Consecutive text blocks in a single assistant message
  // -----------------------------------------------------------------------

  it('combines consecutive text blocks into a single message', () => {
    const lines = [
      assistantLine([
        { type: 'text', text: 'Part 1. ' },
        { type: 'text', text: 'Part 2.' },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    expect(result).toHaveLength(1);
    if (result[0].type === 'text') {
      expect(result[0].content.content).toBe('Part 1. Part 2.');
    }
  });

  // -----------------------------------------------------------------------
  // Thinking blocks
  // -----------------------------------------------------------------------

  it('converts thinking blocks to collapsible text messages', () => {
    const lines = [
      assistantLine([
        { type: 'thinking', thinking: 'Let me analyze this problem...' },
        { type: 'text', text: 'Here is my answer.' },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
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

  it('skips empty thinking blocks', () => {
    const lines = [
      assistantLine([
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Answer.' },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    expect(result).toHaveLength(1);
    if (result[0].type === 'text') {
      expect(result[0].content.content).toBe('Answer.');
    }
  });

  it('skips whitespace-only thinking blocks', () => {
    const lines = [
      assistantLine([
        { type: 'thinking', thinking: '   \n  ' },
        { type: 'text', text: 'Answer.' },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    expect(result).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Tool calls
  // -----------------------------------------------------------------------

  it('converts a single tool_use to an acp_tool_call message', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_001',
          name: 'Bash',
          input: { command: 'ls -la', description: 'List files' },
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    expect(result).toHaveLength(1);

    const msg = result[0];
    expect(msg.type).toBe('acp_tool_call');
    if (msg.type === 'acp_tool_call') {
      expect(msg.content.update.toolCallId).toBe('toolu_001');
      expect(msg.content.update.title).toContain('Bash');
      expect(msg.content.update.kind).toBe('execute');
      expect(msg.content.update.rawInput).toEqual({ command: 'ls -la', description: 'List files' });
      expect(msg.content.update.status).toBe('in_progress');
    }
  });

  it('maps Read tool to kind "read"', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_002',
          name: 'Read',
          input: { file_path: '/tmp/test.txt' },
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.kind).toBe('read');
      expect(result[0].content.update.title).toContain('/tmp/test.txt');
    }
  });

  it('maps Edit tool to kind "edit"', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_003',
          name: 'Edit',
          input: { file_path: '/tmp/test.txt', old_string: 'a', new_string: 'b' },
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.kind).toBe('edit');
    }
  });

  it('maps Write tool to kind "edit"', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_004',
          name: 'Write',
          input: { file_path: '/tmp/test.txt', content: 'hello' },
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.kind).toBe('edit');
    }
  });

  it('maps Glob tool to kind "read"', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_005',
          name: 'Glob',
          input: { pattern: '**/*.ts' },
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.kind).toBe('read');
    }
  });

  it('maps Grep tool to kind "read"', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_006',
          name: 'Grep',
          input: { pattern: 'TODO' },
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.kind).toBe('read');
    }
  });

  it('maps unknown tool name to kind "execute"', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_007',
          name: 'SomeCustomTool',
          input: { foo: 'bar' },
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.kind).toBe('execute');
    }
  });

  // -----------------------------------------------------------------------
  // Tool results merging
  // -----------------------------------------------------------------------

  it('merges tool_result into the corresponding tool_use message', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_merge_1',
          name: 'Bash',
          input: { command: 'echo hello' },
        },
      ]),
      userLine([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_merge_1',
          content: 'hello\n',
          is_error: false,
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    // Should still be 1 message (tool_use with result merged)
    expect(result).toHaveLength(1);

    const msg = result[0];
    expect(msg.type).toBe('acp_tool_call');
    if (msg.type === 'acp_tool_call') {
      expect(msg.content.update.status).toBe('completed');
      expect(msg.content.update.content).toHaveLength(1);
      expect(msg.content.update.content![0].content?.text).toBe('hello\n');
    }
  });

  it('marks tool call as failed when tool_result has is_error=true', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_err_1',
          name: 'Bash',
          input: { command: 'nonexistent_cmd' },
        },
      ]),
      userLine([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_err_1',
          content: 'command not found: nonexistent_cmd',
          is_error: true,
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.status).toBe('failed');
    }
  });

  it('handles missing tool_result gracefully (tool stays in_progress)', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_no_result',
          name: 'Bash',
          input: { command: 'sleep 100' },
        },
      ]),
      // No tool_result line follows
    ];

    const result = convertClaudeJsonl(lines);
    expect(result).toHaveLength(1);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.status).toBe('in_progress');
    }
  });

  it('handles orphaned tool_result (no matching tool_use) gracefully', () => {
    const lines = [
      userLine([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_nonexistent',
          content: 'some output',
          is_error: false,
        },
      ]),
    ];

    // Should not crash, just skip the orphaned result
    const result = convertClaudeJsonl(lines);
    expect(result).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Multiple tool calls in a single assistant turn
  // -----------------------------------------------------------------------

  it('handles multiple tool_use blocks in a single assistant message', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_multi_1',
          name: 'Bash',
          input: { command: 'pwd' },
        },
        {
          type: 'tool_use',
          id: 'toolu_multi_2',
          name: 'Read',
          input: { file_path: '/tmp/test.txt' },
        },
      ]),
      userLine([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_multi_1',
          content: '/home/user',
          is_error: false,
        },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_multi_2',
          content: 'file contents here',
          is_error: false,
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
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
      expect(result[0].content.update.toolCallId).toBe('toolu_multi_1');
      expect(result[0].content.update.content![0].content?.text).toBe('/home/user');
    }
    if (result[1].type === 'acp_tool_call') {
      expect(result[1].content.update.toolCallId).toBe('toolu_multi_2');
      expect(result[1].content.update.content![0].content?.text).toBe('file contents here');
    }
  });

  // -----------------------------------------------------------------------
  // Mixed content: text + tool calls in same assistant message
  // -----------------------------------------------------------------------

  it('handles text followed by tool_use in same assistant message', () => {
    const lines = [
      assistantLine([
        { type: 'text', text: 'Let me check that for you.' },
        {
          type: 'tool_use',
          id: 'toolu_mixed_1',
          name: 'Bash',
          input: { command: 'ls' },
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('text');
    expect(result[1].type).toBe('acp_tool_call');
  });

  it('handles thinking + text + tool_use in same assistant message', () => {
    const lines = [
      assistantLine([
        { type: 'thinking', thinking: 'I need to check the file system.' },
        { type: 'text', text: 'Let me look at the files.' },
        {
          type: 'tool_use',
          id: 'toolu_mixed_2',
          name: 'Bash',
          input: { command: 'ls' },
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    expect(result).toHaveLength(3);
    // thinking (collapsible text)
    expect(result[0].type).toBe('text');
    if (result[0].type === 'text') {
      expect(result[0].content.content).toContain('<details>');
    }
    // text
    expect(result[1].type).toBe('text');
    // tool_use
    expect(result[2].type).toBe('acp_tool_call');
  });

  // -----------------------------------------------------------------------
  // server_tool_use blocks
  // -----------------------------------------------------------------------

  it('handles server_tool_use blocks like tool_use', () => {
    const lines = [
      assistantLine([
        {
          type: 'server_tool_use',
          id: 'toolu_server_1',
          name: 'WebSearch',
          input: { query: 'vitest documentation' },
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('acp_tool_call');
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.toolCallId).toBe('toolu_server_1');
      expect(result[0].content.update.title).toContain('WebSearch');
    }
  });

  // -----------------------------------------------------------------------
  // User interruption text blocks
  // -----------------------------------------------------------------------

  it('converts user text blocks (interruptions) to right-aligned messages', () => {
    const lines = [userLine([{ type: 'text', text: '[Request interrupted by user]' }])];

    const result = convertClaudeJsonl(lines);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('text');
    expect(result[0].position).toBe('right');
    if (result[0].type === 'text') {
      expect(result[0].content.content).toBe('[Request interrupted by user]');
    }
  });

  // -----------------------------------------------------------------------
  // Full conversation flow (realistic scenario)
  // -----------------------------------------------------------------------

  it('handles a realistic full conversation with all message types', () => {
    const lines = [
      snapshotLine(),
      snapshotLine(),
      userLine('List the files in the current directory'),
      assistantLine([
        { type: 'thinking', thinking: 'The user wants to see the files.' },
        {
          type: 'tool_use',
          id: 'toolu_real_1',
          name: 'Bash',
          input: { command: 'ls -la' },
        },
      ]),
      progressLine(),
      userLine([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_real_1',
          content: 'file1.txt\nfile2.txt\nREADME.md',
          is_error: false,
        },
      ]),
      assistantLine([
        {
          type: 'text',
          text: 'Here are the files in the current directory:\n- file1.txt\n- file2.txt\n- README.md',
        },
      ]),
      systemLine(),
      lastPromptLine(),
    ];

    const result = convertClaudeJsonl(lines);

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

  it('generates descriptive titles for Bash tool calls', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_title_1',
          name: 'Bash',
          input: { command: 'echo "Hello World"' },
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.title).toBe('Bash: echo "Hello World"');
    }
  });

  it('truncates long Bash commands in titles', () => {
    const longCommand = 'a'.repeat(100);
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_title_2',
          name: 'Bash',
          input: { command: longCommand },
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.title.length).toBeLessThanOrEqual(90);
      expect(result[0].content.update.title).toContain('...');
    }
  });

  it('generates titles for Grep and Glob tools', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_title_3',
          name: 'Grep',
          input: { pattern: 'TODO|FIXME' },
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.title).toBe('Grep: TODO|FIXME');
    }
  });

  it('uses tool name as fallback title for unknown tools', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_title_4',
          name: 'CustomTool',
          input: { key: 'value' },
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.title).toBe('CustomTool');
    }
  });

  // -----------------------------------------------------------------------
  // Null / undefined edge cases in message content
  // -----------------------------------------------------------------------

  it('handles user message with null content gracefully', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'user-null',
      timestamp: '2026-03-20T10:00:00.000Z',
      message: { role: 'user', content: null },
    });

    const result = convertClaudeJsonl([line]);
    expect(result).toEqual([]);
  });

  it('handles assistant message with non-array content gracefully', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'asst-str',
      timestamp: '2026-03-20T10:00:00.000Z',
      message: { role: 'assistant', content: 'just a string' },
    });

    const result = convertClaudeJsonl([line]);
    expect(result).toEqual([]);
  });

  it('handles assistant message with no message field', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'asst-no-msg',
      timestamp: '2026-03-20T10:00:00.000Z',
    });

    const result = convertClaudeJsonl([line]);
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Whitespace-only text is not emitted
  // -----------------------------------------------------------------------

  it('does not emit text messages with only whitespace', () => {
    const lines = [assistantLine([{ type: 'text', text: '   \n  ' }])];

    const result = convertClaudeJsonl(lines);
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Multiple tool results arriving in separate user messages
  // -----------------------------------------------------------------------

  it('handles tool results arriving in separate user messages', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_sep_1',
          name: 'Bash',
          input: { command: 'echo a' },
        },
        {
          type: 'tool_use',
          id: 'toolu_sep_2',
          name: 'Bash',
          input: { command: 'echo b' },
        },
      ]),
      // First result in its own user message
      userLine([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_sep_1',
          content: 'a',
          is_error: false,
        },
      ]),
      // Second result in another user message
      userLine([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_sep_2',
          content: 'b',
          is_error: false,
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    expect(result).toHaveLength(2);

    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.toolCallId).toBe('toolu_sep_1');
      expect(result[0].content.update.status).toBe('completed');
    }
    if (result[1].type === 'acp_tool_call') {
      expect(result[1].content.update.toolCallId).toBe('toolu_sep_2');
      expect(result[1].content.update.status).toBe('completed');
    }
  });

  // -----------------------------------------------------------------------
  // Timestamp fallback
  // -----------------------------------------------------------------------

  it('falls back to Date.now() for missing timestamps', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'user-no-ts',
      message: { role: 'user', content: 'hello' },
    });

    const before = Date.now();
    const result = convertClaudeJsonl([line]);
    const after = Date.now();

    expect(result[0].createdAt).toBeGreaterThanOrEqual(before);
    expect(result[0].createdAt).toBeLessThanOrEqual(after);
  });

  it('falls back to Date.now() for invalid timestamps', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'user-bad-ts',
      timestamp: 'not-a-date',
      message: { role: 'user', content: 'hello' },
    });

    const before = Date.now();
    const result = convertClaudeJsonl([line]);
    const after = Date.now();

    expect(result[0].createdAt).toBeGreaterThanOrEqual(before);
    expect(result[0].createdAt).toBeLessThanOrEqual(after);
  });

  // -----------------------------------------------------------------------
  // Tool call interleaved with non-renderable lines
  // -----------------------------------------------------------------------

  it('correctly merges tool results even with progress lines between them', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_interleave',
          name: 'Bash',
          input: { command: 'ls' },
        },
      ]),
      progressLine(),
      progressLine(),
      userLine([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_interleave',
          content: 'file1.txt',
          is_error: false,
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    expect(result).toHaveLength(1);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.status).toBe('completed');
      expect(result[0].content.update.content![0].content?.text).toBe('file1.txt');
    }
  });

  // -----------------------------------------------------------------------
  // WebSearch / WebFetch tool title generation
  // -----------------------------------------------------------------------

  it('generates titles for WebSearch and WebFetch tools', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_ws',
          name: 'WebSearch',
          input: { query: 'vitest documentation' },
        },
      ]),
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_wf',
          name: 'WebFetch',
          input: { url: 'https://example.com/api' },
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.title).toBe('WebSearch: vitest documentation');
    }
    if (result[1].type === 'acp_tool_call') {
      expect(result[1].content.update.title).toBe('WebFetch: https://example.com/api');
    }
  });

  // -----------------------------------------------------------------------
  // ToolSearch and NotebookEdit kind mapping
  // -----------------------------------------------------------------------

  it('maps ToolSearch to kind "read" and NotebookEdit to kind "edit"', () => {
    const lines = [
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_ts',
          name: 'ToolSearch',
          input: { query: 'notebook' },
        },
      ]),
      assistantLine([
        {
          type: 'tool_use',
          id: 'toolu_ne',
          name: 'NotebookEdit',
          input: { notebook: 'test.ipynb' },
        },
      ]),
    ];

    const result = convertClaudeJsonl(lines);
    if (result[0].type === 'acp_tool_call') {
      expect(result[0].content.update.kind).toBe('read');
    }
    if (result[1].type === 'acp_tool_call') {
      expect(result[1].content.update.kind).toBe('edit');
    }
  });

  // -----------------------------------------------------------------------
  // Type safety: every returned message matches TMessage
  // -----------------------------------------------------------------------

  it('all returned messages conform to TMessage type', () => {
    const lines = [
      userLine('Hello'),
      assistantLine([
        { type: 'thinking', thinking: 'Hmm...' },
        { type: 'text', text: 'Hi there!' },
        { type: 'tool_use', id: 'toolu_type', name: 'Bash', input: { command: 'echo hi' } },
      ]),
      userLine([{ type: 'tool_result', tool_use_id: 'toolu_type', content: 'hi', is_error: false }]),
    ];

    const result = convertClaudeJsonl(lines);

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
});
