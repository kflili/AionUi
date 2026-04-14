# Plan: File Attach E2E & Unit Tests

**Date:** 2026-04-13
**Status:** Implemented

---

## Context

The file-attach feature was implemented in `fix/file-attach-raw-paths` (4 commits). Changes span 3 layers: renderer (dropdown, FilePreview, path display), main process (raw paths, folder expansion), and i18n. The project already has:

- **Vitest** for unit tests (node + jsdom environments)
- **Playwright + Electron** E2E infrastructure (`tests/e2e/`) with fixtures, helpers, bridge utils
- No existing tests for file-attach components

This plan adds targeted tests for the file-attach changes using the existing infrastructure — no new frameworks needed.

---

## Objectives

- Test FileAttachButton dropdown behavior on Electron vs WebUI
- Test FilePreview rendering for files, folders, and missing files
- Test `buildDisplayMessage` raw path storage (already done, extend)
- Test MessageText copy-button path shortening behavior
- Test ACP folder expansion logic
- Test `useOpenFileSelector` platform-conditional properties
- Identify tests that require manual verification

---

## Approach

Two categories:

1. **Vitest unit/dom tests** — for pure logic and React component rendering (fast, no app launch)
2. **Manual test checklist** — for flows requiring native OS dialogs, real agent interaction, or visual verification

**Update:** Playwright E2E tests were added after the initial plan — dialog mocking via `electronApp.evaluate` proved feasible. See `tests/e2e/specs/file-attach.e2e.ts` (8 tests). Steps 3 (FilePreview dom) and 4 (FileAttachButton dom) were replaced by the E2E tests which cover the same UI behavior. Step 7 (fsBridge test) was removed as a false-positive test.

### Testing Strategy Notes

- **Locator strategy:** File-attach components have no `data-testid` attributes (confirmed: `tests/e2e/helpers/selectors.ts:3-7` documents this as a codebase-wide limitation). Vitest dom tests use `@testing-library/react` queries (text, role, testId) which work with the component tree directly.
- **i18n approach:** Dom tests must use a real i18n provider with the `en-US` locale loaded, not a key-echo mock. This ensures translated labels are verified against actual locale files.

---

## Implementation Steps

### Step 1: Extract `shortenPath` and unit test it

**File:** `src/renderer/utils/file/messageFiles.ts` (extract to), `tests/unit/messageFiles.test.ts` (extend)
**Environment:** node

Extract `shortenPath` from `MessagetText.tsx` into `messageFiles.ts` (co-located with `buildDisplayMessage`). It's a pure function with no React dependency. Test:

- Absolute path inside workspace → relative
- Absolute path outside workspace → `.../last/two`
- Short absolute path (≤3 segments) → unchanged
- Relative path (legacy) → unchanged
- Windows-style paths (`C:\Users\...`) → correctly detected as absolute
- Empty/undefined workspace → falls back to abbreviation

Note: `shortenPath` is used in the copy-button handler (`handleCopy` in `MessagetText.tsx`), not in the rendered UI. The extraction makes it independently testable and available for reuse.

### Step 2: Unit test — `buildDisplayMessage` extensions

**File:** `tests/unit/messageFiles.test.ts` (extend existing)
**Environment:** node

Add cases for:

- Multiple files → all paths preserved as-is
- Mix of absolute + relative paths → no workspace prefix added
- `workspacePath` parameter is unused → verify no workspace injection regardless of value

### Step 3: Dom test — FilePreview component

**File:** `tests/unit/FilePreview.dom.test.tsx`
**Environment:** jsdom

Mock `ipcBridge.fs.getFileMetadata` to return controlled metadata. Use a real i18n provider with `en-US` locale. Test:

- **File rendering:** shows filename, extension, file size
- **Folder rendering:** `isDirectory: true` → shows "Folder" label (from `common.folder` i18n key)
- **Missing file:** `size: -1` → shows dimmed state with strikethrough, shows "missing" label (from `common.filePreview.missing`)
- **Image file:** `.jpg` path → renders Image component
- **Remove button:** `readonly=false` → remove button visible; `readonly=true` → hidden

Mock strategy: mock `ipcBridge.fs.getFileMetadata.invoke` and `ipcBridge.fs.getImageBase64.invoke` via `vi.mock('@/common')`.

### Step 4: Dom test — FileAttachButton dropdown

**File:** `tests/unit/FileAttachButton.dom.test.tsx`
**Environment:** jsdom

Mock `isElectronDesktop()` to test both branches. Use real i18n provider with `en-US` locale.

- **Electron mode:** renders Dropdown with single menu item "Attach Files or Folders"
- **WebUI mode:** renders Dropdown with two menu items (Host Machine Files, My Device)
- **Electron click:** clicking menu item calls `openFileSelector`
- **WebUI click:** clicking 'host' calls `openFileSelector`, clicking 'device' opens file input

### Step 5: Dom test — `useOpenFileSelector` platform branching

**File:** `tests/unit/useOpenFileSelector.dom.test.ts`
**Environment:** jsdom (needs React hooks)

Mock `isElectronDesktop()` and `ipcBridge.dialog.showOpen.invoke`:

- **Electron:** invoked with `['openFile', 'openDirectory', 'multiSelections']`
- **WebUI:** invoked with `['openFile', 'multiSelections']` (no `openDirectory`)
- **Callback:** `onFilesSelected` called with returned paths
- **Empty result:** `onFilesSelected` NOT called when dialog returns empty

### Step 6: Unit test — ACP folder expansion (extracted pure function)

**File:** `src/process/agent/acp/fileExpansion.ts` (new), `tests/unit/acpFolderExpansion.test.ts`
**Environment:** node

The folder expansion logic lives inside `AcpAgent.sendMessage` (lines 549-584 of `acp/index.ts`), which has heavy dependencies (`AcpConnection`, `AcpAdapter`, etc.). Testing `processAtFileReferences` does NOT cover folder expansion — it's a separate concern.

**Approach:** Extract the expansion loop into a pure async function `expandFilePaths(files: string[]): Promise<{ expandedPaths: string[]; folderAnnotations: string[] }>` that takes file paths and returns expanded paths + folder annotation strings. Mock `fs.stat` and `fs.readdir` for the unit test. Then call this function from `sendMessage`.

**Test cases:**

- File path → kept as-is in expanded paths
- Directory path → expanded to individual entries, folder annotation generated
- Mixed files + directories → files kept, directories expanded
- Empty directory → only folder annotation, no expanded paths from it
- Non-existent path → passed through as-is (catch block)
- Path with spaces → preserved correctly in output

### Step 7: Unit test — fsBridge isDirectory

**File:** `tests/unit/fsBridge.test.ts` (extend existing if it exists, or create)
**Environment:** node

Test that `getFileMetadata` provider returns `isDirectory: true` for directories and `isDirectory: false` (or undefined) for files. May already be partially covered.

---

## Manual Test Checklist

These tests **cannot be automated** with the current infrastructure and require human verification:

| #   | Test                                                                                               | Why manual                                                                            |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | **Electron dropdown appears** — Click `+` in existing chat → dropdown shows                        | Requires running app, navigating to existing conversation (no E2E mechanism for this) |
| 2   | **Folder selection via native dialog** — Pick folder → chip appears in sendbox                     | Native OS file dialog cannot be intercepted by Playwright                             |
| 3   | **Mixed file+folder selection** (Mac) — Select both in one dialog                                  | macOS-specific native dialog behavior                                                 |
| 4   | **Paste image** — Paste screenshot → preview appears → agent receives                              | Clipboard interaction + agent round-trip                                              |
| 5   | **Agent reads folder contents** — Attach non-empty folder → agent lists contents                   | Requires live ACP agent connection                                                    |
| 6   | **Empty folder** — Attach empty folder → agent reports empty                                       | Requires live agent                                                                   |
| 7   | **Path with spaces** — Attach from path with spaces → agent receives                               | Native dialog + agent round-trip                                                      |
| 8   | **Old messages backward compat** — Open old conversation with file attachments → renders correctly | Requires existing conversation data                                                   |
| 9   | **Missing file visual** — Delete a previously-attached file → dimmed + strikethrough on reopen     | Visual verification of CSS opacity/strikethrough                                      |
| 10  | **`/open` command** — Type `/open` in sendbox → file picker opens                                  | Requires running app with slash command integration                                   |

---

## Success Criteria

- All new Vitest tests pass (`bun run test`)
- `shortenPath` extracted to `messageFiles.ts` and tested with ≥6 cases
- FilePreview dom tests cover file/folder/missing/image/readonly states
- FileAttachButton dom tests cover Electron vs WebUI dropdown
- `useOpenFileSelector` tests verify platform-conditional properties
- ACP folder expansion extracted and tested with ≥5 cases
- TypeScript compiles (`tsc --noEmit`)
- Lint passes (`bun run lint:fix` — 0 errors)
- Production code changes limited to: extracting `shortenPath` and `expandFilePaths`

---

## Risks & Mitigations

| Risk                                                    | Mitigation                                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| jsdom mocking of Arco components may be fragile         | Use `@testing-library/react` with real Arco components where possible; mock only when Arco depends on browser APIs unavailable in jsdom |
| `ipcBridge` mocking may be complex                      | Use `vi.mock('@/common')` pattern already used in codebase (see `tests/unit/conversationBridge.test.ts`)                                |
| FilePreview uses `useEffect` for async metadata         | Use `waitFor` from `@testing-library/react` to wait for state updates                                                                   |
| No `data-testid` attributes on file-attach components   | Use text content and role-based queries for dom tests; add `data-testid` only if queries prove unstable                                 |
| i18n key-echo mocks could weaken translation assertions | Use real i18n provider with `en-US` locale loaded in dom test setup                                                                     |

---

## Dependencies

- Existing `@testing-library/react` (already in devDeps)
- Existing `vitest` jsdom environment (already configured)
- No new packages needed

---

## Open Questions / Deferred Decisions

- **Future E2E coverage:** When the E2E framework gains conversation-page navigation and IPC stubbing, the file-attach dropdown and preview tests can be promoted to Playwright specs. For now, Vitest dom tests are sufficient.
