import { describe, expect, it, vi } from 'vitest';

import { groupConversationsByTimelineAndWorkspace } from '../../src/renderer/pages/conversation/GroupedHistory/utils/groupingHelpers';

vi.mock('@/renderer/utils/workspace/workspace', () => ({
  getWorkspaceDisplayName: (ws: string) => ws.split('/').pop() || ws,
}));

const DAY_MS = 86_400_000;

const makeConv = (id: string, modifyTime: number, workspace?: string, customWorkspace?: boolean) =>
  ({
    id,
    createTime: modifyTime,
    modifyTime,
    extra: workspace ? { workspace, customWorkspace: customWorkspace ?? true } : {},
  }) as Parameters<typeof groupConversationsByTimelineAndWorkspace>[0][0];

// Identity translator — returns the key as-is so assertions match timeline keys
const t = (key: string) => key;

describe('groupConversationsByTimelineAndWorkspace', () => {
  it('splits a workspace across multiple timeline sections', () => {
    const now = Date.now();
    const todayConv = makeConv('c1', now, '/ws/project', true);
    const earlierConv = makeConv('c2', now - 10 * DAY_MS, '/ws/project', true);

    const sections = groupConversationsByTimelineAndWorkspace([todayConv, earlierConv], t);

    // Same workspace should appear in two different sections
    const todaySection = sections.find((s) => s.timeline === 'conversation.history.today');
    const earlierSection = sections.find((s) => s.timeline === 'conversation.history.earlier');

    expect(todaySection).toBeDefined();
    expect(earlierSection).toBeDefined();

    const todayWsItems = todaySection!.items.filter((i) => i.type === 'workspace');
    const earlierWsItems = earlierSection!.items.filter((i) => i.type === 'workspace');

    expect(todayWsItems).toHaveLength(1);
    expect(earlierWsItems).toHaveLength(1);

    expect(todayWsItems[0].workspaceGroup!.workspace).toBe('/ws/project');
    expect(todayWsItems[0].workspaceGroup!.conversations).toHaveLength(1);
    expect(todayWsItems[0].workspaceGroup!.conversations[0].id).toBe('c1');

    expect(earlierWsItems[0].workspaceGroup!.workspace).toBe('/ws/project');
    expect(earlierWsItems[0].workspaceGroup!.conversations).toHaveLength(1);
    expect(earlierWsItems[0].workspaceGroup!.conversations[0].id).toBe('c2');
  });

  it('sorts workspace groups by max activity time within each section', () => {
    const now = Date.now();
    // Two workspaces in "today", wsB has more recent conversation
    const wsA = makeConv('a1', now - 3600_000, '/ws/a', true); // 1 hour ago
    const wsB = makeConv('b1', now - 60_000, '/ws/b', true); // 1 minute ago

    const sections = groupConversationsByTimelineAndWorkspace([wsA, wsB], t);

    const todaySection = sections.find((s) => s.timeline === 'conversation.history.today');
    expect(todaySection).toBeDefined();
    expect(todaySection!.items).toHaveLength(2);

    // wsB should come first (more recent)
    expect(todaySection!.items[0].workspaceGroup!.workspace).toBe('/ws/b');
    expect(todaySection!.items[1].workspaceGroup!.workspace).toBe('/ws/a');
  });

  it('keeps conversations without workspace in their own timeline sections', () => {
    const now = Date.now();
    const wsConv = makeConv('c1', now, '/ws/project', true);
    const standaloneConv = makeConv('c2', now - 2 * DAY_MS); // no workspace, 2 days ago

    const sections = groupConversationsByTimelineAndWorkspace([wsConv, standaloneConv], t);

    const todaySection = sections.find((s) => s.timeline === 'conversation.history.today');
    const recentSection = sections.find((s) => s.timeline === 'conversation.history.recent7Days');

    expect(todaySection).toBeDefined();
    expect(recentSection).toBeDefined();

    expect(todaySection!.items[0].type).toBe('workspace');
    expect(recentSection!.items[0].type).toBe('conversation');
    expect(recentSection!.items[0].conversation!.id).toBe('c2');
  });

  it('sorts conversations within a split workspace group by activity time desc', () => {
    const now = Date.now();
    // Two conversations in same workspace, same timeline section
    const older = makeConv('c1', now - 3600_000, '/ws/project', true);
    const newer = makeConv('c2', now - 60_000, '/ws/project', true);

    const sections = groupConversationsByTimelineAndWorkspace([older, newer], t);

    const todaySection = sections.find((s) => s.timeline === 'conversation.history.today');
    const group = todaySection!.items[0].workspaceGroup!;

    expect(group.conversations).toHaveLength(2);
    // Newer conversation should be first
    expect(group.conversations[0].id).toBe('c2');
    expect(group.conversations[1].id).toBe('c1');
  });

  it('returns empty sections array when no conversations provided', () => {
    const sections = groupConversationsByTimelineAndWorkspace([], t);
    expect(sections).toEqual([]);
  });
});
