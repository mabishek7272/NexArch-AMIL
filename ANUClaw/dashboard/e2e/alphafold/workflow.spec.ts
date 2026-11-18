import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
const evidence = '../docs/evidence/alphafold-ui';
test.beforeAll(() => fs.mkdirSync(evidence, { recursive: true }));
test('real NexArch workflow against synthetic provider: lookup, confidence, import, provenance, attachment, receptor handoff, annotations and responsive errors', async ({
  page,
  request,
}) => {
  const project = JSON.parse(
    fs.readFileSync('/tmp/anuclaw-af-browser-project.json', 'utf8'),
  ).projectId;
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.goto('/nexarch/bioinformatics/structural-biology/alphafold');
  await expect(page.getByRole('heading', { name: 'AlphaFold DB', exact: true })).toBeVisible();
  await page.screenshot({ path: `${evidence}/01-lookup.png`, fullPage: true });
  await page.getByLabel('UniProt accession or AlphaFold model ID').fill('P69905');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByText('PREDICTED MODEL', { exact: true })).toBeVisible();
  await expect(page.getByText('98.06', { exact: false })).toHaveCount(0); // fixture uses its own explicit confidence, never a placeholder
  await page.screenshot({ path: `${evidence}/02-results-confidence.png`, fullPage: true });
  await page.getByLabel('Available file format').selectOption('pdb');
  await page.getByRole('button', { name: 'Import artifact', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Imported pdb', exact: true })).toBeVisible();
  await expect(page.getByText('Loading molecular viewer…')).toHaveCount(0, { timeout: 30000 });
  await page.getByRole('heading', { name: 'Imported pdb', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/03-import-viewer.png`, fullPage: true });
  await page.getByRole('button', { name: 'Artifact provenance', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('rawMetadataHash');
  await page.screenshot({ path: `${evidence}/04-provenance.png`, fullPage: true });
  await page.getByRole('button', { name: 'Close AlphaFold provenance' }).click();
  await page.getByLabel('Owned Research Studio project').selectOption(project);
  await page.getByRole('button', { name: 'Attach to project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dry Lab receptor handoff' })).toBeVisible();
  await page.getByLabel('Selected chain').selectOption('A');
  await page.getByLabel('I confirm the selected model').check();
  await page.getByRole('button', { name: 'Record receptor input' }).click();
  await expect(page.getByText(/Receptor input recorded/)).toBeVisible();
  await page.getByRole('heading', { name: 'Dry Lab receptor handoff' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/05-docking-handoff.png`, fullPage: true });
  await page.getByLabel('Available file format').selectOption('plddt');
  await page.getByRole('button', { name: 'Import artifact', exact: true }).click();
  await expect(page.getByText('Per-residue pLDDT', { exact: true })).toBeVisible();
  await page.getByText('Per-residue pLDDT', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/06-residue-confidence.png`, fullPage: true });
  await page.getByLabel('Available file format').selectOption('pae');
  await page.getByRole('button', { name: 'Import artifact', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Predicted aligned error (PAE)' })).toBeVisible();
  await page
    .getByRole('heading', { name: 'Predicted aligned error (PAE)' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/07-pae.png`, fullPage: true });
  await page.getByLabel('Operation', { exact: true }).selectOption('annotations');
  await page.getByLabel('UniProt accession or AlphaFold model ID').fill('P69905');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByText('computational', { exact: true })).toBeVisible();
  await page.getByRole('heading', { name: 'Annotations', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/08-annotations.png`, fullPage: true });
  await page.getByLabel('Operation', { exact: true }).selectOption('prediction');
  await page.getByLabel('UniProt accession or AlphaFold model ID').fill('P00000');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Model unavailable' })).toBeVisible();
  await page.screenshot({ path: `${evidence}/09-not-found.png`, fullPage: true });
  await request.post('/__fixture', { data: { mode: 'ratelimit' } });
  await page.getByLabel('UniProt accession or AlphaFold model ID').fill('P69905');
  await page.getByRole('button', { name: 'Refresh from provider', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Rate limit or download budget reached' }),
  ).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${evidence}/10-rate-limited.png`, fullPage: true });
  await request.post('/__fixture', { data: { mode: 'badjson' } });
  await page.getByRole('button', { name: 'Refresh from provider', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Request unavailable' })).toBeVisible();
  await page.screenshot({ path: `${evidence}/11-error.png`, fullPage: true });
  await request.post('/__fixture', { data: { mode: '' } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByText('PREDICTED MODEL', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: `${evidence}/12-responsive.png`, fullPage: true });
  expect(consoleErrors).toEqual([]);
});

test('empty, loading, multiple fragments, sequence and complex UI states', async ({
  page,
  request,
}) => {
  await request.post('/__fixture', { data: { mode: '' } });
  await page.goto('/nexarch/bioinformatics/structural-biology/alphafold');
  await page.getByLabel('Operation', { exact: true }).selectOption('sequence');
  await page.getByLabel('Amino-acid sequence only').fill('ACDEFGHIKLMNPQRSTVWYA');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByText(/Sequence summary: 142 residues/)).toBeVisible();
  await page.getByLabel('Operation', { exact: true }).selectOption('complex');
  await page.getByLabel('UniProt accession or AlphaFold model ID').fill('AF-0000000203852801');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByText('NVIDIA', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Q9NZD4' })).toBeVisible();
  await page.screenshot({ path: `${evidence}/13-complex.png`, fullPage: true });
  await request.post('/__fixture', { data: { mode: 'fragments' } });
  await page.getByLabel('Operation', { exact: true }).selectOption('prediction');
  await page.getByLabel('UniProt accession or AlphaFold model ID').fill('P69905');
  await page.getByRole('button', { name: 'Refresh from provider', exact: true }).click();
  await expect(page.getByLabel('Selected model').locator('option')).toHaveCount(2);
  await page.getByLabel('Selected model').selectOption('AF-P69905-F2');
  await expect(page.getByText('Coverage: 80–199', { exact: true })).toBeVisible();
  await request.post('/__fixture', { data: { mode: 'empty' } });
  await page.getByRole('button', { name: 'Refresh from provider', exact: true }).click();
  await expect(
    page.getByText('No models returned by the provider. Try another supported identifier.'),
  ).toBeVisible();
  let release: () => void = () => {};
  const hold = new Promise<void>((r) => (release = r));
  await page.route('**/api/science/alphafold/lookup', async (route) => {
    await hold;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByText('Requesting bounded public provider data…')).toBeVisible();
  await page.screenshot({ path: `${evidence}/14-loading.png`, fullPage: true });
  release();
  await expect(page.getByText('Requesting bounded public provider data…')).toHaveCount(0);
  await page.unrouteAll();
  await request.post('/__fixture', { data: { mode: '' } });
});
