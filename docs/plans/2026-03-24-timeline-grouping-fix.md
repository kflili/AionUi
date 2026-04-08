# Plan: Chat History Timeline Grouping Bug

**Date:** 2026-03-24 (updated 2026-03-29)
**Status:** Implemented
**Branch:** `fix/timeline-grouping`

---

## Context

When a new chat is created inside a workspace folder (e.g., "AionUi"), ALL conversations from that workspace — including old ones — move to the "Today" section in the sidebar. Root cause: the timeline section for a workspace group is determined by its _most recent_ conversation, so creating a new chat today promotes the entire group to Today.

---

## Root cause

In `groupConversationsByTimelineAndWorkspace` (`groupingHelpers.ts` lines 56–70):

```ts
// CURRENT (buggy): entire workspace placed in ONE timeline based on its latest chat
allWorkspaceGroups.forEach((convList, workspace) => {
  const latestConv = sortedConvs[0];
  const timeline = getConversationTimelineLabel(latestConv, t); // ← uses latest
  workspaceGroupsByTimeline.get(timeline)!.push({
    workspace,
    conversations: sortedConvs, // ← ALL old chats bundled here
  });
});
```

---

## Fix 1: Per-conversation timeline assignment (lines 56–70)

Replace lines 56–70 with per-conversation timeline assignment. Each conversation is individually routed to its correct timeline section; the workspace group is created/merged within that section:

```ts
// FIXED: each conversation gets its own timeline
allWorkspaceGroups.forEach((convList, workspace) => {
  convList.forEach((conv) => {
    const timeline = getConversationTimelineLabel(conv, t); // ← each conv's own timeline

    if (!workspaceGroupsByTimeline.has(timeline)) {
      workspaceGroupsByTimeline.set(timeline, []);
    }

    const timelineGroups = workspaceGroupsByTimeline.get(timeline)!;
    let group = timelineGroups.find((g) => g.workspace === workspace);
    if (!group) {
      group = {
        workspace,
        displayName: getWorkspaceDisplayName(workspace),
        conversations: [],
      };
      timelineGroups.push(group);
    }
    group.conversations.push(conv);
  });
});

// Sort conversations within each group after all are assigned
workspaceGroupsByTimeline.forEach((groups) => {
  groups.forEach((group) => {
    group.conversations.sort((a, b) => getActivityTime(b) - getActivityTime(a));
  });
});
```

---

## Fix 2: Workspace group sort key (lines 99-107)

After the per-conversation split, workspace groups appear in multiple timeline sections. The existing sort on lines 99-107 uses `getWorkspaceUpdateTime(group.workspace)` — a workspace-level timestamp that would make older split groups sort artificially high. Replace with per-group latest conversation time:

```ts
// before: workspace-level timestamp (wrong after split)
const updateTime = getWorkspaceUpdateTime(group.workspace);
const time = updateTime > 0 ? updateTime : getActivityTime(group.conversations[0]);

// after: use latest conversation within this split group
const time = Math.max(...group.conversations.map((c) => getActivityTime(c)));
```

---

## Fix 3: Dedup workspace expansion state

After the per-conversation split, the same workspace can appear in multiple timeline sections. The `useConversations` hook's auto-expand logic pushed raw workspace IDs into an array, creating duplicates.

- Use `Set<string>` for auto-expand collection (no duplicates on new writes)
- Dedup + type-filter on localStorage read (heals old dirty data)
- Extract `collectWorkspaceNames()` helper shared by auto-expand and stale-cleanup effects

---

## Critical Files

| File                                                                       | Change                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------- |
| `src/renderer/pages/conversation/GroupedHistory/utils/groupingHelpers.ts`  | Per-conversation timeline assignment + sort key fix |
| `src/renderer/pages/conversation/GroupedHistory/hooks/useConversations.ts` | Dedup expansion state + shared workspace collector  |

---

## Verification

1. Have chats in a folder (e.g., "AionUi") spread across Today, Last 7 days, Earlier
2. Create a new chat in "AionUi"
3. Sidebar should show: new chat under Today → AionUi, old chats stay in their original sections (Last 7 days / Earlier) under AionUi
4. Confirm no old chat moves to Today just because a new one was created

---

## GPT Review

**Reviewed:** 2026-03-29 via GPT-5.4

Key finding incorporated:

- Lines 99-107 sort key uses `getWorkspaceUpdateTime()` which would make older split groups sort artificially high — fixed by using per-group `Math.max(getActivityTime(...))` instead
