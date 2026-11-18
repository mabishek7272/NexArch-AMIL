import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROUTES = [
  '/nexarch/bioinformatics',
  '/nexarch/bioinformatics/structural-biology/alphafold',
  '/nexarch/structural-biology/alphafold',
  '/nexarch/evidence-library',
  '/nexarch/evidence-library/alphafold',
  '/nexarch/dry-lab',
  '/nexarch/dry-lab/alphafold',
];
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];
const routeChecks: Array<Record<string, unknown>> = [];
const stateChecks: Array<Record<string, unknown>> = [];
const expectedResponseChecks: Array<Record<string, unknown>> = [];
const responsiveNavigation: Array<Record<string, unknown>> = [];
let unresolvedRoleNavigation: Record<string, unknown> | null = null;
const evidencePath = path.resolve(process.cwd(), '../docs/evidence/alphafold-ui/route-accessibility-matrix.json');

async function auditAxe(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations, `${label}: axe violations`).toEqual([]);
  return result.violations.length;
}

async function assertSingleMainAndHeadingOrder(page: Page) {
  await expect(page.locator('main')).toHaveCount(1);
  const ranks = await page.locator('h1,h2,h3,h4,h5,h6').evaluateAll((nodes) =>
    nodes.map((node) => Number(node.tagName.slice(1))),
  );
  expect(ranks[0], 'the page begins with an h1').toBe(1);
  expect(ranks.filter((rank) => rank === 1), 'exactly one h1 is visible').toHaveLength(1);
  for (let i = 1; i < ranks.length; i++)
    expect(ranks[i], `heading order ${ranks.slice(0, i + 1).join(' → ')}`).toBeLessThanOrEqual(ranks[i - 1] + 1);
}

async function recordState(page: Page, state: string, viewport: {width:number;height:number}) {
  await assertSingleMainAndHeadingOrder(page);
  const axeViolations = await auditAxe(page, `${state} ${viewport.width}x${viewport.height}`);
  stateChecks.push({ state, viewport, mainLandmarks: 1, headingHierarchy: 'valid', axeViolations });
}

test.afterAll(() => {
  if (routeChecks.length !== ROUTES.length * VIEWPORTS.length ||
      stateChecks.length !== VIEWPORTS.length * 6 ||
      expectedResponseChecks.length !== VIEWPORTS.length ||
      responsiveNavigation.length !== 3 || !unresolvedRoleNavigation) return;
  fs.writeFileSync(evidencePath, `${JSON.stringify({
    schema: 'anuclaw-alphafold-ui-accessibility/v1',
    viewportMatrix: VIEWPORTS,
    routes: ROUTES,
    routeChecks,
    stateChecks,
    expectedResponseChecks,
    responsiveNavigation,
    unresolvedRoleNavigation,
    totals: {
      routeViewportPairs: routeChecks.length,
      routeStateViewportChecks: stateChecks.length,
      axeViolations: 0,
      browserErrors: 0,
    },
  }, null, 2)}\n`);
});

for (const viewport of VIEWPORTS) {
  test(`all AlphaFold routes at ${viewport.width}x${viewport.height}: direct refresh and success axe`, async ({ page, request }) => {
    test.setTimeout(300_000);
    const browserErrors: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') browserErrors.push(msg.text()); });
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await request.post('/__fixture', { data: { mode: '' } });
    await page.setViewportSize(viewport);
    for (const route of ROUTES) {
      const errorsBeforeRoute = browserErrors.length;
      const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
      expect(response?.status(), `direct refresh ${route}`).toBe(200);
      await expect(page.getByRole('heading', { name: 'AlphaFold DB', exact: true })).toBeVisible();
      await page.getByLabel('UniProt accession or AlphaFold model ID').fill('P69905');
      await page.getByRole('button', { name: 'Look up', exact: true }).click();
      await expect(page.getByText('PREDICTED MODEL', { exact: true })).toBeVisible();
      await expect(page.getByText(/Synthetic fixture provider — not live AlphaFold DB data/)).toBeVisible();
      await expect(page.getByText(/high confidence is not experimental validation/i)).toBeVisible();
      await expect(page.getByText(/Predictions do not establish binding, mechanism, efficacy or safety/i)).toBeVisible();
      await expect(page.getByRole('link', { name: 'CC BY 4.0' })).toBeVisible();
      await expect(page.getByText(/NexArch retrieves these predictions; it does not own or generate them/i)).toBeVisible();
      const visibleText = await page.locator('body').innerText();
      expect(visibleText).not.toMatch(/clinically validated|clinically actionable|clinical confidence|safe for clinical use/i);
      await assertSingleMainAndHeadingOrder(page);
      const axeViolations = await auditAxe(page, `${route} ${viewport.width}x${viewport.height}`);
      if (viewport.width === 390)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${route} has no horizontal page overflow`).toBe(true);

      const refresh = await page.reload({ waitUntil: 'domcontentloaded' });
      expect(refresh?.status(), `browser refresh ${route}`).toBe(200);
      await expect(page.getByRole('heading', { name: 'AlphaFold DB', exact: true })).toBeVisible();
      expect(browserErrors.length - errorsBeforeRoute, `${route} has no console/page errors`).toBe(0);
      routeChecks.push({ route, viewport, directStatus: response?.status(), refreshStatus: refresh?.status(), mainLandmarks: 1, headingHierarchy: 'valid', axeViolations, browserErrors: browserErrors.length - errorsBeforeRoute });
    }
  });
}

test('AlphaFold UI empty, success, unavailable, malformed, rate-limited and loading states at every viewport', async ({ page, request }) => {
  test.setTimeout(300_000);
  const browserErrors: string[] = [];
  let expectedHttpErrorState = false;
  let expectedProviderResponseConsoleMessages = 0;
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (expectedHttpErrorState && msg.text().startsWith('Failed to load resource:')) {
      expectedProviderResponseConsoleMessages++;
      return;
    }
    if (!(expectedHttpErrorState && msg.text().startsWith('Failed to load resource:'))) browserErrors.push(msg.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  const route = '/nexarch/bioinformatics/structural-biology/alphafold';
  for (const viewport of VIEWPORTS) {
    const errorsBeforeViewport = browserErrors.length;
    const expectedResponsesBeforeViewport = expectedProviderResponseConsoleMessages;
    await page.setViewportSize(viewport);
    await request.post('/__fixture', { data: { mode: '' } });
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'AlphaFold DB', exact: true })).toBeVisible();
    await recordState(page, 'empty', viewport);

    await page.getByLabel('UniProt accession or AlphaFold model ID').fill('P69905');
    await page.getByRole('button', { name: 'Look up', exact: true }).click();
    await expect(page.getByText('PREDICTED MODEL', { exact: true })).toBeVisible();
    await recordState(page, 'success', viewport);

    await page.getByLabel('UniProt accession or AlphaFold model ID').fill('P00000');
    expectedHttpErrorState = true;
    await page.getByRole('button', { name: 'Look up', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Model unavailable' })).toBeVisible();
    await recordState(page, 'unavailable', viewport);

    await request.post('/__fixture', { data: { mode: 'badjson' } });
    await page.getByLabel('UniProt accession or AlphaFold model ID').fill('P69905');
    await page.getByRole('button', { name: 'Refresh from provider', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Request unavailable' })).toBeVisible();
    await recordState(page, 'malformed', viewport);

    await request.post('/__fixture', { data: { mode: 'ratelimit' } });
    await page.getByRole('button', { name: 'Refresh from provider', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Rate limit or download budget reached' })).toBeVisible({ timeout: 15000 });
    await recordState(page, 'rate-limited', viewport);
    expectedHttpErrorState = false;

    await request.post('/__fixture', { data: { mode: '' } });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/science/alphafold/lookup', async (browserRoute) => { await held; await browserRoute.continue(); });
    await page.getByRole('button', { name: 'Refresh from provider', exact: true }).click();
    await expect(page.getByText('Requesting bounded public provider data…')).toBeVisible();
    await recordState(page, 'loading', viewport);
    release();
    await expect(page.getByText('Requesting bounded public provider data…')).toHaveCount(0);
    await page.unrouteAll();
    expect(browserErrors.length - errorsBeforeViewport, `states at ${viewport.width}x${viewport.height} have no console/page errors`).toBe(0);
    expect(expectedProviderResponseConsoleMessages - expectedResponsesBeforeViewport, `expected provider HTTP-error response messages at ${viewport.width}x${viewport.height}`).toBeGreaterThan(0);
    expectedResponseChecks.push({ viewport, expectedProviderResponseConsoleMessages: expectedProviderResponseConsoleMessages - expectedResponsesBeforeViewport, applicationConsoleErrors: 0, pageErrors: 0 });
  }
});

for (const viewport of VIEWPORTS.filter((v) => v.width < 1180)) {
  test(`AlphaFold responsive navigation at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/nexarch/bioinformatics/structural-biology/alphafold', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'AlphaFold DB', exact: true })).toBeVisible();
    const menu = page.getByRole('button', { name: 'Open navigation' });
    await expect(menu).toBeVisible();
    await menu.click();
    await expect(page.locator('.nx-drawer')).toBeVisible();
    await page.locator('.nx-drawer').getByRole('link', { name: 'Dry Lab' }).click();
    await expect(page).toHaveURL(/\/nexarch\/dry-lab$/);
    await expect(page.locator('.nx-drawer')).toHaveCount(0);
    responsiveNavigation.push({ viewport, opens: true, navigatesAndCloses: true });
  });
}

test('unresolved dashboard role shows no protected NexArch navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let authCalls = 0;
  let markPending: () => void = () => {};
  const rolePending = new Promise<void>((resolve) => { markPending = resolve; });
  let releaseRole: () => void = () => {};
  const roleHold = new Promise<void>((resolve) => { releaseRole = resolve; });
  await page.route('**/auth/me', async (route) => {
    authCalls++;
    if (authCalls === 2) { markPending(); await roleHold; }
    await route.continue();
  });
  await page.goto('/nexarch', { waitUntil: 'domcontentloaded' });
  await rolePending;
  await expect(page.locator('.nx-nav-item')).toHaveCount(0);
  releaseRole();
  await expect(page.locator('.nx-nav-item').filter({ hasText: 'Research Studio' })).toBeVisible();
  unresolvedRoleNavigation = { protectedItemsBeforeRoleResolution: 0, visibleAfterRoleResolution: true };
  await page.unrouteAll();
});
