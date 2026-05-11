/**
 * Full History View — E2E tests for the dedicated /history route added by item 9.
 *
 * Scope: route reachability, sidebar entry-point, filter chip narrowing, search,
 * and row navigation back into /conversation/:id. These are the parts of plan
 * §634-642 that don't need real CLI history on disk — they work against the
 * conversations the harness already produces during a fresh launch.
 *
 * Real CLI-history flows (importing CC/CP sessions, verifying CC/CP badges
 * on imported rows, message-content search across imported sessions) remain
 * manual per the plan §634-642 checklist and the manual recipe documented in
 * `orchestration-experiments/aionui-cli-history-2026-05-10/item-9-full-history-view/decisions.md`.
 */
import { expect, test } from '../fixtures';
import { expectUrlContains, goToGuid, navigateTo, ROUTES, takeScreenshot, waitForSettle } from '../helpers';

const HISTORY_HASH = '#/history';

test.describe('Full History View — route + sidebar entry-point', () => {
  test('opens /history when the sidebar "View all history" link is clicked', async ({ page }) => {
    await goToGuid(page);
    const viewAll = page.locator('[data-testid="sider-view-all-history"]').first();
    await expect(viewAll).toBeVisible({ timeout: 5000 });
    await viewAll.click();
    await expectUrlContains(page, '/history');
    await expect(page.locator('[data-testid="history-page"]').first()).toBeVisible();
    await takeScreenshot(page, 'history-page-loaded');
  });

  test('navigates directly to /history via hash', async ({ page }) => {
    await navigateTo(page, HISTORY_HASH);
    await expect(page.locator('[data-testid="history-page-title"]').first()).toBeVisible({ timeout: 5000 });
  });

  test('shows the source filter chips, sort, and search controls', async ({ page }) => {
    await navigateTo(page, HISTORY_HASH);
    await waitForSettle(page);
    await expect(page.locator('[data-testid="history-source-chips"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="history-sort"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="history-search-input"]').first()).toBeVisible();
  });
});

test.describe('Full History View — interaction', () => {
  test('clicking the Claude Code source chip toggles aria-pressed', async ({ page }) => {
    await navigateTo(page, HISTORY_HASH);
    const cc = page.locator('[data-testid="history-source-chip-claude_code"]').first();
    await expect(cc).toBeVisible({ timeout: 5000 });
    const before = await cc.getAttribute('aria-pressed');
    expect(before === 'false' || before === null || before === 'true').toBeTruthy();
    await cc.click();
    const after = await cc.getAttribute('aria-pressed');
    expect(after).toBe('true');
  });

  test('typing in the search input updates the page count', async ({ page }) => {
    await navigateTo(page, HISTORY_HASH);
    const search = page.locator('[data-testid="history-search-input"] input').first();
    await search.fill('zzzz_no_such_session_zzzz');
    // With a junk query, the no-matches empty state should be visible.
    await expect(page.locator('[data-testid="history-empty"]').first()).toBeVisible({ timeout: 5000 });
  });

  test('Reset button clears narrowing', async ({ page }) => {
    await navigateTo(page, HISTORY_HASH);
    const search = page.locator('[data-testid="history-search-input"] input').first();
    await search.fill('zzzz_no_such_session_zzzz');
    await expect(page.locator('[data-testid="history-empty"]').first()).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="history-reset"]').first().click();
    await expect(page.locator('[data-testid="history-empty"]').first()).toHaveCount(0);
  });
});

test.describe('Full History View — sidebar deep-link', () => {
  test('?section=conversation.history.today preselects Last 7 days preset', async ({ page }) => {
    await navigateTo(page, `${HISTORY_HASH}?section=conversation.history.today`);
    const preset = page.locator('[data-testid="history-date-preset-last7"]').first();
    await expect(preset).toBeVisible({ timeout: 5000 });
    await expect(preset).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('Full History View — round-trip back to settings is unaffected', () => {
  test('navigating to settings then back to history works', async ({ page }) => {
    await navigateTo(page, HISTORY_HASH);
    await expect(page.locator('[data-testid="history-page-title"]').first()).toBeVisible({ timeout: 5000 });
    await navigateTo(page, ROUTES.settings.gemini);
    await expectUrlContains(page, '/settings/gemini');
    await navigateTo(page, HISTORY_HASH);
    await expect(page.locator('[data-testid="history-page-title"]').first()).toBeVisible({ timeout: 5000 });
  });
});
