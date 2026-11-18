import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Shared accessibility assertions for this app's overlay `Drawer` component
 * (dashboard/src/nexarch/ui.tsx) — used identically by the NexArchShell responsive nav
 * overlay and the Research Studio provenance drawer, since both are the same underlying
 * component. Keeping one implementation here means a regression in either caller is caught
 * the same way, and the checks can't drift between the two call sites' test files.
 *
 * Asserts, in order: the trigger opens the drawer, focus moves inside it, the background
 * (#root) is inert, Tab/Shift+Tab never escape the drawer, the close control has a real
 * accessible name, Escape closes it, and focus returns to the exact trigger element.
 */
export async function assertDrawerAccessibility(
  page: Page,
  trigger: Locator,
  options: { expectedCloseNameContains?: string; tabCount?: number } = {},
): Promise<void> {
  const triggerHandle = await trigger.elementHandle();
  if (!triggerHandle) throw new Error('assertDrawerAccessibility: trigger locator did not resolve to an element.');

  await trigger.focus();
  await trigger.click();
  await expect(page.locator('.nx-drawer')).toBeVisible();

  const focusInsideDrawer = await page.evaluate(() => {
    const drawer = document.querySelector('.nx-drawer');
    return !!drawer && drawer.contains(document.activeElement);
  });
  expect(focusInsideDrawer, 'focus should move inside the drawer the moment it opens').toBe(true);

  const backgroundInert = await page.evaluate(() => {
    const root = document.getElementById('root');
    return !!root && (root.hasAttribute('inert') || root.getAttribute('aria-hidden') === 'true');
  });
  expect(backgroundInert, 'the background (#root) should be inert while the drawer is open').toBe(true);

  const tabCount = options.tabCount ?? 20;
  for (let i = 0; i < tabCount; i++) {
    await page.keyboard.press('Tab');
    const stillInside = await page.evaluate(() => {
      const drawer = document.querySelector('.nx-drawer');
      return !!drawer && drawer.contains(document.activeElement);
    });
    expect(stillInside, `focus escaped the drawer after ${i + 1} Tab presses`).toBe(true);
  }

  const closeAccessibleName = await page.evaluate(() => {
    const drawer = document.querySelector('.nx-drawer');
    const btn = drawer?.querySelector<HTMLButtonElement>('button[aria-label], button');
    return btn?.getAttribute('aria-label') || btn?.textContent?.trim() || null;
  });
  expect(closeAccessibleName, 'the close control must have a real accessible name').toBeTruthy();
  if (options.expectedCloseNameContains) {
    expect(closeAccessibleName).toContain(options.expectedCloseNameContains);
  }

  await page.keyboard.press('Escape');
  await expect(page.locator('.nx-drawer')).toHaveCount(0);

  const focusReturned = await page.evaluate((trig) => document.activeElement === trig, triggerHandle);
  expect(focusReturned, 'focus should return to the exact element that opened the drawer').toBe(true);
}
