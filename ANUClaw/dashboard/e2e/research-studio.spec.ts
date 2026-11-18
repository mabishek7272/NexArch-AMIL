import { test, expect, type Page } from '@playwright/test';
import { assertDrawerAccessibility } from './helpers/drawer';

async function isNarrow(page: Page): Promise<boolean> {
  const size = page.viewportSize();
  return !!size && size.width < 1180;
}

test.describe('Research Studio — provenance panel', () => {
  test('narrow viewports: the provenance inspector opens as an accessible overlay drawer', async ({ page }) => {
    test.skip(!(await isNarrow(page)), 'at >=1180px the inspector is a fixed right-hand aside, not a drawer — see the next test');
    const projectId = process.env.NEXARCH_QA_PROJECT_ID!;
    await page.goto(`/nexarch/research-studio?project=${projectId}`, { waitUntil: 'networkidle' });

    const sourceRow = page.getByRole('button', { name: /Inspect provenance/ }).first();
    await expect(sourceRow).toBeVisible();

    await assertDrawerAccessibility(page, sourceRow, { expectedCloseNameContains: 'Provenance' });
  });

  test('>=1180px: the provenance inspector is a fixed panel, not an overlay drawer', async ({ page }) => {
    test.skip(await isNarrow(page), 'narrow-viewport behavior is covered above');
    const projectId = process.env.NEXARCH_QA_PROJECT_ID!;
    await page.goto(`/nexarch/research-studio?project=${projectId}`, { waitUntil: 'networkidle' });

    const sourceRow = page.getByRole('button', { name: /Inspect provenance/ }).first();
    await sourceRow.click();

    await expect(page.locator('.nx-drawer'), 'the wide-layout inspector must not use the overlay drawer').toHaveCount(0);
    await expect(page.getByRole('complementary')).toBeVisible();
  });
});
