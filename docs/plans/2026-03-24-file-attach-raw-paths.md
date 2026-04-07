# Plan: File Attach UX + Raw Path Display

**Date:** 2026-03-24 (updated 2026-03-29)
**Status:** Ready to implement
**Branch:** `fix/file-attach-raw-paths`

---

## Context

Two coupled issues:

**Issue 1 (Attach UX)** — The `+` button in the existing chat sendbox (Electron) shows no dropdown and only opens a file picker that excludes folders. Files are then copied into the workspace directory, causing size limitations. The user wants: (a) a dropdown even on Electron for clear intent, (b) file AND folder selection, (c) paths passed directly to the agent without copying.

**Issue 2 (Path Display)** — When Issue 1 removes file copying, the existing file display pipeline breaks: `buildDisplayMessage()` fabricates fake workspace paths that no longer exist, and `FilePreview` can't handle folder paths. The display layer needs to work with raw absolute paths and support directories.

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

#### 4. `src/process/bridge/conversationBridge.ts` — Temp-file cleanup

`copyFilesToDirectory` currently auto-deletes temp files created by paste/drag-drop (files in `cache/temp/`). Removing the copy step orphans these temps. Add inline cleanup right after passing paths to the agent:

```ts
// After sending to agent, clean up temp files (replaces copyFilesToDirectory's cleanup)
const tempDir = path.join(cacheDir, 'temp');
files?.filter((f) => f.startsWith(tempDir)).forEach((f) => fs.unlink(f).catch(() => {}));
```

> **Platform note:** `openFile + openDirectory` combined in Electron gives mixed file-and-folder selection on Mac only. On Windows/Linux it becomes directory-only. This app is Mac-first, so acceptable — but document this limitation in the code comment.

#### 5. i18n locale files (6 files in `src/renderer/services/i18n/locales/*/common.json`)

Add one new key under `fileAttach`:

- `en-US`: `"fileAttach.attachFilesOrFolders": "Attach Files or Folders"`
- Other locales: translated equivalents (`zh-CN`, `zh-TW`, `tr-TR`, `ko-KR`, `ja-JP`)

---

## Issue 2: Fix File Path Display for Raw Paths + Folder Support

### Background

File attachments are **already rendered** in Rich UI messages. The existing mechanism:

1. `buildDisplayMessage()` (`messageFiles.ts`) appends file paths after a `[[AION_FILES]]` marker in the message `content` string
2. `parseFileMarker()` (`MessagetText.tsx`) extracts them at render time
3. `FilePreview` renders each as an image thumbnail or file card with name/size

There is **no** `message.files` field — files are embedded in the content string via the marker.

### Problem

Issue 1 removes the copy step, but the existing display pipeline assumes copied files:

- `buildDisplayMessage()` rewrites external paths to fake `workspace/...` paths (the copy destination). Without copying, these paths point to nothing.
- `FilePreview.tsx` is file-centric — no directory detection, no folder icon, no folder metadata handling.

### What changes

#### 1. `src/renderer/utils/file/messageFiles.ts` — `buildDisplayMessage()`

Stop fabricating workspace-relative paths. Store the **original absolute paths** as-is:

```ts
// before: external files get fake workspace path
return `${workspacePath}/${fileName}`;

// after: pass through original path, only strip timestamp suffix
return filePath.replace(AIONUI_TIMESTAMP_REGEX, '$1');
```

For readability in the UI, path shortening belongs in the **rendering layer** (MessagetText/FilePreview), not in storage.

#### 2. `src/renderer/components/media/FilePreview.tsx` — Folder support

- Add directory detection: check if path is a directory (via `ipcBridge.fs.getFileMetadata` or a new `isDirectory` check)
- Use a folder icon (from `@icon-park/react`) when path is a directory
- Show directory name + "Folder" label instead of extension + file size
- Gracefully handle missing files (path no longer exists) — show dimmed state instead of error

#### 3. `src/renderer/pages/conversation/Messages/components/MessagetText.tsx` — Path shortening

When rendering file paths from the marker, shorten for readability:

- If path is under current workspace: show relative path (e.g., `src/utils/parser.ts`)
- If path is external: show `~/...` abbreviated path or last 2-3 segments
- Absolute paths still stored in message content — shortening is display-only

**Workspace context:** Verify that `MessagetText` has access to the current workspace path (needed to compute relative paths). If not available, thread it through as a prop from the parent message list component.

**Backward compatibility:** Old messages store workspace-relative paths (e.g., `workspace/uploads/photo.jpg`), new messages will store absolute paths (e.g., `/Users/lili/Desktop/photo.jpg`). Detect which format by checking if the path starts with `/` (absolute) or not (legacy relative). Handle both:

- Absolute → shorten using workspace prefix
- Relative (legacy) → display as-is (already short)

#### 4. `tests/unit/messageFiles.test.ts` — Update existing tests

The test file has comprehensive coverage of `buildDisplayMessage` including workspace paths, external files, nested subdirectories, and timestamp stripping. Changing path logic in `messageFiles.ts` will break these tests. Update them to expect raw absolute paths instead of fabricated workspace-relative paths.

---

## Critical Files

| File                                                                   | Change                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------- |
| `src/renderer/hooks/file/useOpenFileSelector.ts`                       | Add `openDirectory` to dialog properties                 |
| `src/renderer/components/media/FileAttachButton.tsx`                   | Show dropdown on Electron; single option for Electron    |
| `src/process/bridge/conversationBridge.ts`                             | Remove `copyFilesToDirectory`, pass raw paths + cleanup  |
| `src/renderer/services/i18n/locales/*/common.json` (6 files)           | Add `fileAttach.attachFilesOrFolders` key                |
| `src/renderer/utils/file/messageFiles.ts`                              | Store raw absolute paths instead of fake workspace paths |
| `src/renderer/components/media/FilePreview.tsx`                        | Add folder detection, folder icon, missing-file state    |
| `src/renderer/pages/conversation/Messages/components/MessagetText.tsx` | Display-only path shortening + backward compat           |
| `tests/unit/messageFiles.test.ts`                                      | Update tests for raw absolute paths                      |

---

## Verification

### Issue 1

1. Open an existing chat in Electron desktop
2. Click `+` → dropdown appears with "Attach Files or Folders"
3. Select a folder → folder path appears as a chip in the sendbox
4. Select multiple files → file paths appear as chips
5. Send a message — verify agent receives the raw paths (not workspace-copied paths) in its context

### Issue 2

1. Attach files from **within** workspace → paths display as relative (`src/foo.ts`)
2. Attach files from **outside** workspace → paths display abbreviated, not fake workspace paths
3. Attach a **folder** → shows folder icon + directory name
4. Old messages with workspace-relative paths → still render correctly (backward compatible)
5. File that no longer exists → dimmed state, no crash

---

## GPT Review

**Reviewed:** 2026-03-29 via GPT-5.4

Key findings incorporated:
- Confirmed `buildDisplayMessage()` fabricates fake workspace paths for external files
- Confirmed `FilePreview.tsx` has no directory handling
- Confirmed temp-file cleanup gap when removing `copyFilesToDirectory`
- Platform note: `openFile + openDirectory` is Mac-only mixed selection
- Backward compatibility strategy added for old vs new path formats
