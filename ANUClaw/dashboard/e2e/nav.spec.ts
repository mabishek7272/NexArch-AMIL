import { test, expect, type Page } from '@playwright/test';
import { assertDrawerAccessibility } from './helpers/drawer';

/** All 13 nav items + 2 footer items, per dashboard/src/nexarch/nav.ts's `roles` arrays —
 * every one of them includes 'admin', so the disposable admin test account must see all of
 * them. (Non-admin role filtering is NOT covered by this suite — see README.md's
 * "Known limitations" section for why, and what a role-filtering test would need.) */
const ALL_NAV_LABELS = [
  'Overview', 'Research Studio', 'Evidence Library', 'Manuscripts',
  'Dry Lab', 'Bioinformatics', 'Posture Analysis', 'Monitoring',
  'Validation', 'Pipelines', 'AI Connections',
  'Governance', 'Administration',
];

const PREVIEW_LABELS = [
  'Manuscripts', 'Posture Analysis', 'Monitoring', 'Validation', 'Pipelines',
  'Governance', 'Administration',
];

async function isNarrow(page: Page): Promise<boolean> {
  const size = page.viewportSize();
  return !!size && size.width < 1180;
}

test.describe('desktop nav (admin role) — permanent sidebar, 1280px/1440px only', () => {
  test('admin sees every nav item in nav.ts, sidebar is permanent, no menu button', async ({ page }) => {
    test.skip(await isNarrow(page), 'desktop-only assertion; this viewport uses the overlay nav instead');
    await page.goto('/nexarch', { waitUntil: 'networkidle' });

    const sidebar = page.getByRole('navigation', { name: 'Primary' });
    await expect(sidebar).toBeVisible();
    const box = await sidebar.boundingBox();
    expect(box?.width, 'the desktop sidebar must stay a fixed 234px — unchanged by the responsive-nav work').toBe(234);

    await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);

    for (const label of ALL_NAV_LABELS) {
      await expect(sidebar.getByText(label, { exact: true }), `admin should see "${label}"`).toBeVisible();
    }
  });

  test('preview-status items are marked and never navigate', async ({ page }) => {
    test.skip(await isNarrow(page), 'desktop-only; the narrow-viewport equivalent is covered below');
    await page.goto('/nexarch', { waitUntil: 'networkidle' });

    for (const label of PREVIEW_LABELS.slice(0, 3)) { // a sample is enough; all share one NavItem implementation
      const item = page.getByText(label, { exact: true }).locator('xpath=ancestor::div[@role="link"]');
      await expect(item).toHaveAttribute('aria-disabled', 'true');
      await expect(item.getByText('PREVIEW')).toBeVisible();
      await item.click({ force: true });
      await expect(page, `clicking preview item "${label}" must not navigate away from Overview`).toHaveURL(/\/nexarch\/?$/);
    }
  });
});

test.describe('responsive nav overlay — below 1180px (1024x768, 768x1024 projects only)', () => {
  test('sidebar is not permanent; menu button opens an accessible overlay drawer with full keyboard support', async ({ page }) => {
    test.skip(!(await isNarrow(page)), 'narrow-only; desktop keeps the permanent sidebar');
    await page.goto('/nexarch', { waitUntil: 'networkidle' });

    // The sidebar must not be a permanent part of the layout at this width.
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);

    const menuButton = page.getByRole('button', { name: 'Open navigation' });
    await expect(menuButton).toBeVisible();

    // Keyboard reachability: Tab from the top of the page must reach the menu button within
    // a handful of presses (it's the first interactive control in the topbar).
    await page.keyboard.press('Tab');
    let reached = await menuButton.evaluate((el) => el === document.activeElement);
    for (let i = 0; i < 5 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await menuButton.evaluate((el) => el === document.activeElement);
    }
    expect(reached, 'the nav menu button should be reachable via Tab alone from page load').toBe(true);

    await page.keyboard.press('Escape'); // in case focus-trap logic from a prior assertion lingers; drawer isn't open yet so this is a no-op
    await assertDrawerAccessibility(page, menuButton, { expectedCloseNameContains: 'Navigation' });

    // Re-open for the remaining behavioral checks (the helper above closed it).
    await menuButton.click();
    await expect(page.locator('.nx-drawer')).toBeVisible();

    // Role filtering and the full item set render identically inside the overlay.
    for (const label of ALL_NAV_LABELS) {
      await expect(page.locator('.nx-drawer').getByText(label, { exact: true }), `drawer should list "${label}"`).toBeVisible();
    }

    // A preview item inside the drawer must not navigate and must not close the drawer.
    const previewItem = page.locator('.nx-drawer').getByText(PREVIEW_LABELS[0], { exact: true })
      .locator('xpath=ancestor::div[@role="link"]');
    await previewItem.click({ force: true });
    await expect(page.locator('.nx-drawer'), 'a preview item must not close the drawer or navigate').toBeVisible();
    await expect(page).toHaveURL(/\/nexarch\/?$/);

    // A real item navigates AND closes the drawer (NavContent's onNavigate wiring).
    await page.locator('.nx-drawer').getByText('Research Studio', { exact: true }).click();
    await expect(page).toHaveURL(/\/nexarch\/research-studio/);
    await expect(page.locator('.nx-drawer')).toHaveCount(0);
  });
});
