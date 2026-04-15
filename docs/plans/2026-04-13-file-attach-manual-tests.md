# File Attach — Manual Test Checklist

**Branch:** `fix/file-attach-raw-paths`
**Date:** 2026-04-13

Relaunch the app (`bun start`) before testing. All tests assume the Electron desktop app on Mac.

---

## Issue 1: Attach UX

### 1. Electron dropdown appears

- Open an **existing chat** (not new chat page)
- Click the `+` button in the sendbox
- **Expected:** A dropdown menu appears with one item: "Attach Files or Folders"
- **Not expected:** Direct file picker opening without dropdown

### 2. Select multiple files

- Click `+` → "Attach Files or Folders"
- In the native dialog, select 2-3 files
- **Expected:** File chips appear in the sendbox (each showing filename)
- Send a message referencing the files
- **Expected:** Agent can read and describe the file contents

### 3. Select a folder with files

- Click `+` → "Attach Files or Folders"
- Select a folder that contains files (e.g., a project directory)
- **Expected:** A folder chip appears in sendbox with a folder icon (not a file icon)
- Send "what's inside this folder?"
- **Expected:** Agent lists the folder contents and can read the files

### 4. Select an empty folder

- Create an empty folder on Desktop
- Attach it via `+` → "Attach Files or Folders"
- Send "what's in this folder?"
- **Expected:** Agent reports the folder is empty (no crash, no error)

### 5. Mixed file + folder selection (Mac only)

- Click `+` → "Attach Files or Folders"
- In the native dialog, select both a file AND a folder (Cmd+click)
- **Expected:** Both appear as chips — file with file icon, folder with folder icon
- Send message → agent can read both

### 6. Paste an image

- Copy a screenshot to clipboard (Cmd+Shift+4, then Cmd+C on the file)
- Paste into the sendbox (Cmd+V)
- **Expected:** Image preview thumbnail appears in sendbox
- Send message
- **Expected:** Agent receives and can describe the image

### 7. `/open` slash command

- Type `/open` in the sendbox and press Enter
- **Expected:** Native file picker opens (same as clicking `+`)

---

## Issue 2: Path Display

### 8. File inside workspace shows relative path

- In a chat with a workspace set (e.g., AionUi project)
- Attach a file from **within** that workspace (e.g., `src/index.ts`)
- Send message
- **Expected:** In the message bubble, the file path shows as relative: `src/index.ts`
- **Not expected:** Full absolute path like `/Users/lili/Projects/AionUi/src/index.ts`

### 9. File outside workspace shows abbreviated path

- Attach a file from Desktop or Downloads (outside the workspace)
- Send message
- **Expected:** Path shows abbreviated: `.../Downloads/file.txt` or similar
- **Not expected:** Full `/Users/lili/Downloads/file.txt`

### 10. Folder preview shows folder icon and label

- Attach a folder
- **Expected (in sendbox):** Chip shows folder icon (filled folder) + folder name
- **Expected (in sendbox):** Below the name, label says "Folder" (localized)
- **Not expected:** Generic file icon or file extension label

### 11. Missing file shows dimmed state

- Attach a file and send the message
- Delete the original file from Finder
- Close and reopen the conversation (or scroll away and back)
- **Expected:** The file preview in the message shows:
  - Dimmed/faded appearance (opacity reduced)
  - Filename with ~~strikethrough~~
  - Label says "missing" instead of file size
- **Not expected:** Crash, error toast, or blank preview

### 12. Old messages backward compatibility

- Open a conversation that had files attached **before** this change (old workspace-relative paths)
- **Expected:** Old file previews still render correctly with filename and size
- **Not expected:** Broken paths, missing previews, or errors

---

## Edge Cases

### 13. Path with spaces

- Attach a file or folder from a path containing spaces (e.g., `/Users/lili/My Documents/report.pdf`)
- Send message
- **Expected:** Agent receives the file and can read it
- **Expected:** File preview shows correctly in the message

### 14. Large folder (many files)

- Attach a folder with 20+ files
- Send "list the files"
- **Expected:** Agent lists files (may take a moment). No timeout or crash.

---

## Test Results

| #   | Test                     | Pass/Fail        | Notes                                                  |
| --- | ------------------------ | ---------------- | ------------------------------------------------------ |
| 1   | Electron dropdown        | PASS (E2E)       | Automated: `file-attach.e2e.ts`                        |
| 2   | Select multiple files    | PASS (E2E)       | Automated: dialog mock + chip verification             |
| 3   | Folder with files        | PASS (E2E+agent) | Automated: agent listed all 3 files                    |
| 4   | Empty folder             | PASS (agent)     | Agent: "folder is completely empty"                    |
| 5   | Mixed file + folder      | Not tested       | Needs Mac native dialog multi-select                   |
| 6   | Paste image              | Not tested       | Needs clipboard + agent round-trip                     |
| 7   | `/open` command          | Not tested       | Only works in ACP sendbox, not guid page               |
| 8   | Relative path display    | N/A for ACP      | ACP uses separate files array, not buildDisplayMessage |
| 9   | Abbreviated path display | N/A for ACP      | shortenPath only in copy handler, unit-tested          |
| 10  | Folder icon + label      | PASS (E2E)       | Automated: folder icon + "Folder" text verified        |
| 11  | Missing file dimmed      | PASS (visual)    | Verified via screenshot: "PDF: missing" label rendered |
| 12  | Old messages compat      | N/A              | No legacy ACP file attachments exist                   |
| 13  | Path with spaces         | PASS (E2E+agent) | Automated: agent read "$1.2M" from spaced path         |
| 14  | Large folder             | PASS (agent)     | Agent listed all 25 files correctly                    |
