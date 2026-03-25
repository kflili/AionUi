# Plan: Fix File Attach UX + Chat History Timeline Bug

## Context

Two bugs to fix:

**Issue 1** — The `+` button in the existing chat sendbox (Electron) shows no dropdown and only opens a file picker that excludes folders. Files are then copied into the workspace directory, causing size limitations. The user wants: (a) a dropdown even on Electron for clear intent, (b) file AND folder selection, (c) paths passed directly to the agent without copying.

**Issue 2** — When a new chat is created inside a workspace folder (e.g., "AionUi"), ALL conversations from that workspace — including old ones — move to the "Today" section in the sidebar. Root cause: the timeline section for a workspace group is determined by its _most recent_ conversation, so creating a new chat today promotes the entire group to Today.

---

## Issue 1: File/Folder Attach Dropdown

### What changes

#### 1. `src/renderer/hooks/file/useOpenFileSelector.ts` (line 25)

Add `'openDirectory'` to the native dialog properties so folders can be selected alongside files:

```ts
// before
{
  properties: ['openFile', 'multiSelections'];
}
// after
{
  properties: ['openFile', 'openDirectory', 'multiSelections'];
}
```

#### 2. `src/renderer/components/media/FileAttachButton.tsx`

- **Remove** the `isElectronDesktop()` early return (lines 66–68) that bypasses the dropdown for Electron.
- Make the **dropdown render for all platforms** (Electron included).
- Electron dropdown has **one item**: "Attach Files or Folders" → calls `openFileSelector()`.
- WebUI dropdown retains its existing two items ("Host Machine Files" / "My Device").
- Remove `onLocalFilesAdded` prop and all local-upload logic from the Electron path (not needed; paths are stable locals).
- Clean up unused `uploading` state for Electron branch.

#### 3. `src/process/bridge/conversationBridge.ts` (line 421)

Skip the copy step — pass raw paths directly to the agent:

```ts
// before
const workspaceFiles = await copyFilesToDirectory(task.workspace, files, false);
// ...
files: workspaceFiles,

// after
// No copy step. Agent receives absolute paths and handles them via tool calls.
files: files ?? [],
```

The CLI/LLM receives absolute paths and uses its own read/list tools to access contents — no size limit, no unnecessary I/O.

#### 4. i18n locale files (6 files in `src/renderer/services/i18n/locales/*/common.json`)

Add one new key under `fileAttach`:

- `en-US`: `"fileAttach.attachFilesOrFolders": "Attach Files or Folders"`
- Other locales: translated equivalents (`zh-CN`, `zh-TW`, `tr-TR`, `ko-KR`, `ja-JP`)

---

## Issue 2: Chat History Timeline Grouping Bug

### Root cause

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

### Fix

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

**File**: `src/renderer/pages/conversation/GroupedHistory/utils/groupingHelpers.ts` — replace lines 56–70 only. No other logic changes.

---

## Critical Files

| File                                                                      | Change                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------ |
| `src/renderer/hooks/file/useOpenFileSelector.ts`                          | Add `openDirectory` to dialog properties               |
| `src/renderer/components/media/FileAttachButton.tsx`                      | Show dropdown on Electron; single option for Electron  |
| `src/process/bridge/conversationBridge.ts`                                | Remove `copyFilesToDirectory`, pass raw paths          |
| `src/renderer/services/i18n/locales/*/common.json` (6 files)              | Add `fileAttach.attachFilesOrFolders` key              |
| `src/renderer/pages/conversation/GroupedHistory/utils/groupingHelpers.ts` | Fix per-conversation timeline assignment (lines 56–70) |

---

## Verification

### Issue 1

1. Open an existing chat in Electron desktop
2. Click `+` → dropdown appears with "Attach Files or Folders"
3. Select a folder → folder path appears as a chip in the sendbox
4. Select multiple files → file paths appear as chips
5. Send a message — verify agent receives the raw paths (not workspace-copied paths) in its context

### Issue 2

1. Have chats in a folder (e.g., "AionUi") spread across Today, Last 7 days, Earlier
2. Create a new chat in "AionUi"
3. Sidebar should show: new chat under Today → AionUi, old chats stay in their original sections (Last 7 days / Earlier) under AionUi
4. Confirm no old chat moves to Today just because a new one was created
