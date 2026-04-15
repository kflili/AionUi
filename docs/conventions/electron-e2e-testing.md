---
name: electron-e2e-testing
description: Techniques for automated E2E testing of Electron apps using Playwright, including dialog mocking, screenshot verification, and agent round-trip testing
type: reference
---

# Electron App E2E Testing — Techniques Reference

Proven patterns for automated testing of Electron desktop apps from CLI agents.
Developed and validated on AionUi (Electron + React + Arco Design).

---

## Core Stack

| Tool                                | Role                                    | Why                                                |
| ----------------------------------- | --------------------------------------- | -------------------------------------------------- |
| **Playwright** (`@playwright/test`) | App launch, DOM interaction, assertions | Native Electron support via `_electron` namespace  |
| **electronApp.evaluate()**          | Main process access (mock native APIs)  | Runs code in Electron's main process context       |
| **page.screenshot()**               | Visual verification                     | Claude Code can read PNG files as a multimodal LLM |
| **Vitest + jsdom**                  | Component/hook unit tests               | Fast, no app launch needed                         |

---

## Technique 1: Native Dialog Mocking

**Problem:** Electron's `dialog.showOpenDialog()` opens a native OS file picker that Playwright can't drive.

**Solution:** Replace the dialog function at the Electron module level before triggering the UI action.

```typescript
// Mock dialog to return specific file/folder paths
await electronApp.evaluate(
  async ({ dialog }, paths) => {
    (dialog as any).showOpenDialog = async () => ({
      canceled: false,
      filePaths: paths,
    });
  },
  ['/path/to/file.txt', '/path/to/folder']
);

// Mock a canceled dialog
await electronApp.evaluate(async ({ dialog }) => {
  (dialog as any).showOpenDialog = async () => ({
    canceled: true,
    filePaths: [],
  });
});
```

**Why it works:** `dialogBridge.ts` imports `dialog` from `electron` and calls `dialog.showOpenDialog()` on each invocation. The mock replaces the function on the module object, so the next call gets the mock. No native dialog opens.

**Gotcha:** The mock persists for the entire app session. Reset it between tests if needed:

```typescript
// Restore original dialog (save reference first)
await electronApp.evaluate(async ({ dialog }) => {
  if ((dialog as any)._originalShowOpenDialog) {
    (dialog as any).showOpenDialog = (dialog as any)._originalShowOpenDialog;
  }
});
```

**Industry validation:** Used by lameta, Clubhouse, Mojang/minecraft-creator-tools, Automattic/studio, and others on GitHub.

---

## Technique 2: Screenshot-Based Visual Verification

**Problem:** Need to verify visual state (icons, colors, layout) that DOM assertions can't capture.

**Solution:** Take screenshots at each step, then read them with Claude Code's multimodal vision.

```typescript
// In E2E test
await page.screenshot({ path: 'tests/e2e/screenshots/step-name.png' });
```

```
// In Claude Code session — read the screenshot
Read tool → file_path: "tests/e2e/screenshots/step-name.png"
// Claude sees the image and can verify: "folder icon is visible", "text is dimmed", etc.
```

**When to use:**

- Verifying icon type (folder vs file icon)
- Checking visual states (dimmed, strikethrough, loading)
- Debugging test failures ("what does the page actually look like?")
- Confirming layout and positioning

**When NOT to use:**

- Text content (use `page.getByText()` instead — faster, deterministic)
- Element presence (use `expect(locator).toBeVisible()`)
- CSS classes (use `element.evaluate(el => el.classList)`)

---

## Technique 3: Full Agent Round-Trip Testing

**Problem:** Need to verify that an attached file/folder is actually received and processed by a live AI agent.

**Solution:** Combine dialog mocking with real message sending, then poll for the agent's response.

```typescript
test('agent reads attached folder', async ({ page, electronApp }) => {
  test.setTimeout(90_000); // Agent responses take time

  // 1. Create temp fixtures
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
  fs.writeFileSync(path.join(dir, 'test.txt'), 'content');

  // 2. Mock dialog
  await electronApp.evaluate(async ({ dialog }, folderPath) => {
    (dialog as any).showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folderPath],
    });
  }, dir);

  // 3. Attach (click + → menu item)
  await page.locator('button.arco-btn-shape-circle').first().click();
  await page.locator('.arco-dropdown-menu-item').first().click();

  // 4. Type question
  await page.locator('textarea').first().fill('What files are in the folder?');

  // 5. Send (Cmd+Enter)
  await page.keyboard.press('Meta+Enter');

  // 6. Poll for response — wait for "Processing..." to disappear
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2_000);
    const isProcessing = await page
      .locator('text=Processing')
      .isVisible()
      .catch(() => false);
    const hasConversation = (await page.evaluate(() => window.location.hash)).includes('/conversation/');
    if (hasConversation && !isProcessing && i > 2) {
      await page.waitForTimeout(1_000); // Extra settle time
      break;
    }
  }

  // 7. Screenshot for verification
  await page.screenshot({ path: 'screenshots/agent-response.png' });
  // Read this screenshot to verify the response content
});
```

**Key learnings:**

- Agent responses can take 10-60+ seconds — use generous timeouts
- **Don't poll for content keywords** — poll for "Processing..." spinner to disappear instead. Content-based polling triggers too early (before rendering finishes)
- The guid page auto-redirects to `#/conversation/{id}` after sending
- `Cmd+Enter` (Meta+Enter) is the universal send shortcut in AionUi
- Add `i > 2` guard to skip the first few polls (page may not have redirected yet)
- Always take a final screenshot — even if polling times out, the screenshot shows what happened
- Screenshots taken during "Processing..." state are useless for verification — wait for completion

---

## Technique 4: IPC Bridge Calls from Tests

**Problem:** Need to create conversations, query state, or trigger actions without clicking UI.

**Solution:** Use the bridge helper to invoke IPC providers directly from the renderer context.

```typescript
import { invokeBridge } from '../helpers/bridge';

// Create a conversation programmatically
const conversation = await invokeBridge(page, 'create-conversation', {
  type: 'acp',
  model: { provider: 'claude', model: 'claude-sonnet-4-5-20241022' },
  extra: { workspace: '/tmp/test-workspace' },
});

// Navigate to it
await page.evaluate((hash) => window.location.assign(hash), `#/conversation/${conversation.id}`);
```

**Available bridge keys (found in ipcBridge.ts):**

- `create-conversation` — create conversation
- `get-conversation` — read conversation state
- `get-file-metadata` — check file existence
- `show-open` — trigger dialog (but prefer mocking instead)

---

## Technique 5: Platform-Conditional Testing

**Problem:** Some features behave differently on Electron vs WebUI, or Mac vs Windows.

**Solution for unit tests:** Mock the platform detection function.

```typescript
let mockIsElectron = false;
vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => mockIsElectron,
}));

it('Electron: includes openDirectory', async () => {
  mockIsElectron = true;
  // ... test Electron behavior
});

it('WebUI: excludes openDirectory', async () => {
  mockIsElectron = false;
  // ... test WebUI behavior
});
```

**Solution for E2E tests:** E2E always runs in Electron, so platform branching is inherently tested for the Electron path. WebUI-specific behavior requires a separate test harness.

---

## Technique 6: Arco Design Component Interaction

**Problem:** Arco Design components have complex DOM structures with generated class names.

**Selectors that work:**

```typescript
// Dropdown menu (rendered in portal, not inside the button)
page.locator('.arco-dropdown, .arco-dropdown-menu');
page.locator('.arco-dropdown-menu-item, .arco-menu-item');

// Circle buttons (like the + attach button)
page.locator('button.arco-btn-shape-circle');

// Switch toggle
page.locator('.arco-switch');

// By text content (most reliable, works across themes)
page.getByText('Attach Files or Folders');
page.locator('text=Folder');
```

**Gotchas:**

- Dropdowns render in a portal (`document.body`), not inside the trigger element
- Use `.first()` when multiple matches are possible
- Arco class names are stable across versions (`.arco-dropdown-menu-item`)
- No `data-testid` in most AionUi components — rely on text/class selectors

---

## Technique 7: Test Fixture Management

```typescript
// Create temp files/folders for testing
function createTempFixtures(fileNames: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-'));
  const files = fileNames.map((name) => {
    const fp = path.join(dir, name);
    fs.writeFileSync(fp, `test content for ${name}`);
    return fp;
  });
  return { dir, files };
}

// Always clean up in afterAll (not afterEach — avoid cleanup between shared tests)
test.afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
```

---

## Anti-Patterns (What Doesn't Work)

| Approach                                          | Why it fails                                                                                                                                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **osascript/AppleScript** for Electron UI         | Electron's web content isn't exposed to macOS Accessibility API — can see the window but not buttons/inputs                                                                                                             |
| **`page.on('filechooser')`** for Electron dialogs | Only works for web `<input type="file">`, not Electron's native `dialog.showOpenDialog`                                                                                                                                 |
| **`bun run` for Playwright Electron tests**       | Electron launch requires the Playwright test runner's process management; `bun run script.ts` times out                                                                                                                 |
| **Fixed `sleep` for agent responses**             | Agent response time varies wildly — always poll with a check condition                                                                                                                                                  |
| **Checking element count for "nothing added"**    | Other UI elements may match — count before AND after, compare delta                                                                                                                                                     |
| **Navigate away/back for state refresh**          | React preserves component instances — `useEffect` with same `[path]` dep won't re-fire. Must restart the app or reload the page for fresh component mounts. FilePreview's missing state only triggers on initial mount. |
| **`page.on('console')` for renderer logs**        | Playwright's Electron integration doesn't reliably capture renderer `console.log`/`console.debug`. Use `electronApp.evaluate(({ clipboard }) => clipboard.readText())` to read clipboard instead of console capture.    |

---

## Test Organization Pattern

```
tests/
  e2e/
    fixtures.ts          # Shared Playwright + Electron app launch
    helpers/
      bridge.ts          # IPC bridge calls from renderer
      navigation.ts      # Route navigation helpers
      selectors.ts       # Reusable CSS selectors
      screenshots.ts     # Screenshot capture utility
    specs/
      app-launch.e2e.ts  # Smoke tests
      navigation.e2e.ts  # Route transitions
      file-attach.e2e.ts # Feature-specific tests (dialog mock + DOM)
    screenshots/         # Captured screenshots (gitignored)
  unit/
    *.test.ts            # Node environment (pure logic)
    *.dom.test.ts        # jsdom environment (React components/hooks)
    *.dom.test.tsx       # jsdom environment (JSX components)
```

---

## Running Tests

```bash
# Unit tests (fast, no app)
bun run test

# E2E tests (launches Electron app)
E2E_DEV=1 bun run test:e2e

# Single E2E spec
E2E_DEV=1 bun run test:e2e -- tests/e2e/specs/file-attach.e2e.ts

# With screenshots
E2E_DEV=1 E2E_SCREENSHOTS=1 bun run test:e2e

# Grep specific test
E2E_DEV=1 bun run test:e2e -- --grep "dropdown"
```

---

## Future Improvements

- [ ] Add `data-testid` attributes to file-attach components for more stable selectors
- [ ] Build a conversation-seeding helper for E2E tests that need existing conversation context
- [ ] Add IPC mock layer in fixtures to stub bridge providers without real backend
- [ ] Increase agent response polling timeout and add retry logic for flaky CI
- [ ] Explore Playwright's `page.video()` for recording full test sessions
