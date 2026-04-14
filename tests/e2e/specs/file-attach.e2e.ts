/**
 * File Attach — E2E tests for file/folder attachment UX.
 *
 * Tests the file-attach dropdown, file/folder selection via mocked dialogs,
 * FilePreview rendering (file, folder, missing), and edge cases (spaces, /open).
 *
 * Dialog mocking: uses electronApp.evaluate to replace dialog.showOpenDialog
 * at the Electron module level, avoiding native OS file pickers.
 */
import { test, expect } from '../fixtures';
import { goToGuid, waitForSettle, takeScreenshot } from '../helpers';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Replace Electron's native dialog with a mock that returns given paths. */
async function mockDialog(
  electronApp: import('@playwright/test').ElectronApplication,
  filePaths: string[]
): Promise<void> {
  await electronApp.evaluate(async ({ dialog }, paths) => {
    (dialog as any).showOpenDialog = async () => ({
      canceled: false,
      filePaths: paths,
    });
  }, filePaths);
}

/** Replace Electron's native dialog with a canceled mock. */
async function mockDialogCanceled(electronApp: import('@playwright/test').ElectronApplication): Promise<void> {
  await electronApp.evaluate(async ({ dialog }) => {
    (dialog as any).showOpenDialog = async () => ({
      canceled: true,
      filePaths: [],
    });
  });
}

/** Create a temporary directory with optional test files inside it. */
function createTempFixtures(fileNames: string[] = []): { dir: string; files: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-attach-'));
  const files: string[] = [];
  for (const name of fileNames) {
    const fp = path.join(dir, name);
    fs.writeFileSync(fp, `test content for ${name}`);
    files.push(fp);
  }
  return { dir, files };
}

/** Navigate to the guid page and wait for the sendbox to be ready. */
async function goToGuidWithSendbox(page: import('@playwright/test').Page): Promise<void> {
  await goToGuid(page);
  // Wait for the sendbox area to be visible (textarea or contenteditable)
  await page
    .locator('textarea, [contenteditable="true"], [role="textbox"]')
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 });
}

/** Click the + (attach) button in the sendbox area. */
async function clickAttachButton(page: import('@playwright/test').Page): Promise<void> {
  // The + button is a circle button with a Plus icon inside the sendbox area
  const plusButton = page.locator('button.arco-btn-shape-circle').first();
  await plusButton.waitFor({ state: 'visible', timeout: 5_000 });
  await plusButton.click();
}

// ── Temp fixtures lifecycle ─────────────────────────────────────────────────

let tempFixture: { dir: string; files: string[] } | null = null;

test.afterAll(() => {
  if (tempFixture) {
    try {
      fs.rmSync(tempFixture.dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    tempFixture = null;
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe('File Attach', () => {
  test.beforeAll(() => {
    // Create test fixtures once for all tests in this describe block
    tempFixture = createTempFixtures(['test-file-1.txt', 'test-file-2.ts', 'image.jpg']);
    // Also create a subdirectory inside the temp dir
    const subdir = path.join(tempFixture.dir, 'subfolder');
    fs.mkdirSync(subdir);
    fs.writeFileSync(path.join(subdir, 'nested.txt'), 'nested content');
  });

  test('attach button is visible on guid page', async ({ page }) => {
    await goToGuidWithSendbox(page);
    const plusButton = page.locator('button.arco-btn-shape-circle').first();
    await expect(plusButton).toBeVisible({ timeout: 5_000 });
  });

  test('clicking + shows dropdown menu', async ({ page, electronApp }) => {
    await goToGuidWithSendbox(page);
    await mockDialog(electronApp, []);
    await clickAttachButton(page);

    // Wait for the dropdown to appear — look for Arco dropdown menu
    const dropdown = page.locator('.arco-dropdown, .arco-dropdown-menu').first();
    await expect(dropdown).toBeVisible({ timeout: 3_000 });
  });

  test('dropdown has correct menu items', async ({ page, electronApp }) => {
    await goToGuidWithSendbox(page);
    await mockDialog(electronApp, []);
    await clickAttachButton(page);

    // Verify the dropdown has menu items (at least one)
    const menuItems = page.locator('.arco-dropdown-menu-item, .arco-menu-item');
    await expect(menuItems.first()).toBeVisible({ timeout: 3_000 });
    const count = await menuItems.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('selecting files via dialog creates file chips', async ({ page, electronApp }) => {
    if (!tempFixture) throw new Error('tempFixture not initialized');
    await goToGuidWithSendbox(page);

    // Mock dialog to return two test files
    await mockDialog(electronApp, [tempFixture.files[0], tempFixture.files[1]]);

    // Click + and select from dropdown
    await clickAttachButton(page);
    const menuItem = page.locator('.arco-dropdown-menu-item, .arco-menu-item').first();
    await menuItem.click();

    // Verify file preview chips appear in the sendbox area
    // FilePreview renders with file name text
    await expect(page.getByText('test-file-1.txt')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('test-file-2.ts')).toBeVisible({ timeout: 5_000 });
  });

  test('selecting a folder shows folder icon and label', async ({ page, electronApp }) => {
    if (!tempFixture) throw new Error('tempFixture not initialized');
    await goToGuidWithSendbox(page);

    // Mock dialog to return the folder path
    await mockDialog(electronApp, [tempFixture.dir]);

    await clickAttachButton(page);
    const menuItem = page.locator('.arco-dropdown-menu-item, .arco-menu-item').first();
    await menuItem.click();

    // Verify folder name appears
    const dirName = path.basename(tempFixture.dir);
    await expect(page.getByText(dirName)).toBeVisible({ timeout: 5_000 });

    // Verify "Folder" label appears (rendered after async getFileMetadata IPC call)
    // Use a broader locator since the text may be inside nested spans
    await expect(page.locator('text=Folder').first()).toBeVisible({ timeout: 5_000 });
  });

  test('selecting a non-existent file still shows preview chip', async ({ page, electronApp }) => {
    await goToGuidWithSendbox(page);

    // Mock dialog to return a path that doesn't exist
    await mockDialog(electronApp, ['/tmp/nonexistent-file-e2e-test-12345.txt']);

    await clickAttachButton(page);
    const menuItem = page.locator('.arco-dropdown-menu-item, .arco-menu-item').first();
    await menuItem.click();

    // Verify the filename appears — the preview chip renders even for missing files
    await expect(page.getByText('nonexistent-file-e2e-test-12345.txt')).toBeVisible({ timeout: 5_000 });
    // Note: Missing file visual state (dimmed + strikethrough) is verified
    // in the sent message view, not in the sendbox preview
  });

  test('canceling dialog does not add files', async ({ page, electronApp }) => {
    await goToGuidWithSendbox(page);

    // Count existing text elements before dialog
    const beforeCount = await page.locator('.h-60px').count();

    await mockDialogCanceled(electronApp);
    await clickAttachButton(page);
    const menuItem = page.locator('.arco-dropdown-menu-item, .arco-menu-item').first();
    await menuItem.click();

    // Wait a moment and verify no new file chips appeared
    await waitForSettle(page, 1_000);
    const afterCount = await page.locator('.h-60px').count();
    expect(afterCount).toBe(beforeCount);
  });

  test('path with spaces works correctly', async ({ page, electronApp }) => {
    // Create a file with a space in the directory name
    const spacedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui e2e spaced-'));
    const spacedFile = path.join(spacedDir, 'my file.txt');
    fs.writeFileSync(spacedFile, 'content with spaces');

    try {
      await goToGuidWithSendbox(page);
      await mockDialog(electronApp, [spacedFile]);

      await clickAttachButton(page);
      const menuItem = page.locator('.arco-dropdown-menu-item, .arco-menu-item').first();
      await menuItem.click();

      // Verify the filename appears correctly
      await expect(page.getByText('my file.txt')).toBeVisible({ timeout: 5_000 });
    } finally {
      fs.rmSync(spacedDir, { recursive: true, force: true });
    }
  });

  test('/open command triggers file selector', async ({ page, electronApp }) => {
    // /open slash command only works inside an active ACP conversation sendbox,
    // not on the guid (new chat) page. Skip until conversation page E2E is available.
    test.skip(true, '/open requires ACP conversation sendbox, not available on guid page');
  });

  test('screenshot: file attach dropdown', async ({ page, electronApp }) => {
    test.skip(!process.env.E2E_SCREENSHOTS, 'screenshots disabled');
    await goToGuidWithSendbox(page);
    await mockDialog(electronApp, []);
    await clickAttachButton(page);
    // Wait for dropdown
    await page.locator('.arco-dropdown, .arco-dropdown-menu').first().waitFor({ state: 'visible', timeout: 3_000 });
    await takeScreenshot(page, 'file-attach-dropdown');
  });

  test('screenshot: folder preview chip', async ({ page, electronApp }) => {
    test.skip(!process.env.E2E_SCREENSHOTS, 'screenshots disabled');
    if (!tempFixture) throw new Error('tempFixture not initialized');
    await goToGuidWithSendbox(page);
    await mockDialog(electronApp, [tempFixture.dir]);
    await clickAttachButton(page);
    const menuItem = page.locator('.arco-dropdown-menu-item, .arco-menu-item').first();
    await menuItem.click();
    await waitForSettle(page, 2_000);
    await takeScreenshot(page, 'file-attach-folder-preview');
  });
});
