import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { nexArchRoutes } from './helpers/routes';

for (const route of nexArchRoutes()) {
  test.describe(`/nexarch route: ${route.name}`, () => {
    test(`${route.name} — direct refresh renders real content, no console/page errors, zero axe violations`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
      page.on('pageerror', (err) => consoleErrors.push(String(err)));

      // Direct navigation (not SPA client-side nav) — this is the refresh/deep-link case.
      const response = await page.goto(route.path, { waitUntil: 'networkidle' });
      expect(response?.status(), `direct refresh of ${route.path} should return 200`).toBe(200);

      const bodyText = await page.evaluate(() => document.body.innerText.trim());
      expect(bodyText.length, `${route.path} should render real content on direct refresh, not a blank page`).toBeGreaterThan(0);

      expect(consoleErrors, `no console/page errors on ${route.path}`).toEqual([]);

      const axeResults = await new AxeBuilder({ page }).analyze();
      expect(
        axeResults.violations,
        `zero axe violations of any severity on ${route.path}; if this fails, the test output above lists each offending selector and failure summary`,
      ).toEqual([]);
    });
  });
}

test.describe('no fabricated portfolio or clinical values', () => {
  test('Overview shows the real SYNTHETIC fixture, not invented numbers, and "unavailable" cards are plain-language with no fabricated data', async ({ page }) => {
    await page.goto('/nexarch', { waitUntil: 'networkidle' });

    // The fixture project this suite created itself must be the one actually rendered —
    // proves the page is showing real API data, not a hardcoded mock.
    const projectTitle = process.env.NEXARCH_QA_PROJECT_TITLE!;
    await expect(page.getByText(projectTitle, { exact: false }).first()).toBeVisible();

    // "Unavailable" cards must never claim a specific fabricated count (e.g. a mockup's old
    // "31 sources" / "RUN-7C1F 68%" / "48,112 entries" style placeholder numbers) — they
    // should read as plain-language explanations instead. This can't prove a negative for
    // every possible fake number, but it does assert the known prior offenders are gone and
    // that genuine "isn't shown/available yet" messaging is present, which is the structural
    // pattern NotAvailableYet (ui.tsx) is supposed to always produce.
    const bodyText = await page.evaluate(() => document.body.innerText);
    for (const fabricated of ['31 sources', 'RUN-7C1F', '48,112', '1,100+', '1100+']) {
      expect(bodyText, `Overview must not contain the known-fabricated placeholder "${fabricated}"`).not.toContain(fabricated);
    }
    expect(bodyText).toMatch(/isn't (shown|ready|available) (here )?yet/i);
  });

  test('Research Studio shows the real fixture source, not a mock row', async ({ page }) => {
    const projectId = process.env.NEXARCH_QA_PROJECT_ID!;
    await page.goto(`/nexarch/research-studio?project=${projectId}`, { waitUntil: 'networkidle' });
    await expect(page.getByText('SYNTHETIC placeholder source', { exact: false })).toBeVisible();
  });
});
