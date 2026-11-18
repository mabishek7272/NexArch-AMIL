import { request as playwrightRequest } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { requireNexArchQaEnv } from './env';

export const AUTH_STATE_PATH = path.join(__dirname, '.auth-state.json');

/**
 * Runs once before the suite. Two things happen here, deliberately kept separate:
 *
 * 1. A real login against NEXARCH_QA_API_URL via plain fetch, to create one ephemeral,
 *    unambiguously-SYNTHETIC-labeled Research Studio project (+ one placeholder source) for
 *    the suite to inspect — so tests never depend on, or assert against, data left over from
 *    manual testing. The title is timestamped so repeated runs don't collide; there is no
 *    delete-project endpoint in this API today (checked `research-studio.ts`), so fixture
 *    projects accumulate in whatever Postgres the suite points at — acceptable for a
 *    disposable dev/test database, not something this suite attempts to work around. The
 *    created project id is exported via process.env so spec files (spawned as worker
 *    processes after this completes) can read it.
 *
 * 2. A real login against NEXARCH_QA_BASE_URL (the app origin the browser will actually use —
 *    note this is deliberately NOT the same request as (1): the dev stack's Vite proxy means
 *    cookies set via a login through BASE_URL land on BASE_URL's origin, which is what a real
 *    browser page needs; a login against API_URL directly would not attach correctly to pages
 *    loaded from BASE_URL) via Playwright's own request context, saving the resulting
 *    cookie jar as Playwright `storageState` so every test project starts already
 *    authenticated without each spec re-implementing login.
 */
export default async function globalSetup(): Promise<void> {
  const env = requireNexArchQaEnv();

  // --- 1. Node-side fixture creation (no browser involved) ---
  const apiLogin = await fetch(`${env.API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: env.EMAIL, password: env.PASSWORD }),
  });
  if (!apiLogin.ok) {
    throw new Error(`NexArch QA fixture setup: login to ${env.API_URL} failed with ${apiLogin.status}. Check NEXARCH_QA_EMAIL/NEXARCH_QA_PASSWORD and that the dev stack is running.`);
  }
  const setCookie = apiLogin.headers.get('set-cookie');
  if (!setCookie) throw new Error('NexArch QA fixture setup: login succeeded but no session cookie was returned.');
  // Node's fetch may fold multiple Set-Cookie headers into one string; split defensively.
  const cookieHeader = setCookie.split(/,(?=[^;]+?=)/).map((c) => c.split(';')[0]).join('; ');

  const title = `SYNTHETIC — NexArch e2e fixture ${Date.now()}`;
  const createProject = await fetch(`${env.API_URL}/api/research-studio/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({
      mode: 'systematic_review',
      title,
      brief: {
        topic: 'SYNTHETIC placeholder topic — not real research (NexArch e2e fixture only)',
        question: 'SYNTHETIC placeholder question used only to populate the stage rail and provenance inspector for automated review.',
        searchMethod: 'SYNTHETIC placeholder search method — no real database is queried.',
        screeningMethod: 'SYNTHETIC placeholder screening method — no real records are screened.',
        searchStrategy: { databases: ['SYNTHETIC-TEST-DB'], queries: ['synthetic e2e query'] },
      },
    }),
  });
  if (!createProject.ok) {
    throw new Error(`NexArch QA fixture setup: creating the SYNTHETIC project failed with ${createProject.status}: ${await createProject.text()}`);
  }
  const { project } = await createProject.json();

  const createSource = await fetch(`${env.API_URL}/api/research-studio/projects/${project.id}/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({
      title: 'SYNTHETIC placeholder source — NexArch e2e fixture, not a real publication',
      sourceType: 'journal_article',
      year: 2026,
      venue: 'Synthetic QA fixture',
      authors: ['QA Fixture'],
    }),
  });
  if (!createSource.ok) {
    throw new Error(`NexArch QA fixture setup: creating the placeholder source failed with ${createSource.status}: ${await createSource.text()}`);
  }

  process.env.NEXARCH_QA_PROJECT_ID = project.id;
  process.env.NEXARCH_QA_PROJECT_TITLE = title;

  // --- 2. Browser-origin login, saved as storageState for every test project ---
  const apiCtx = await playwrightRequest.newContext({ baseURL: env.BASE_URL });
  const browserLogin = await apiCtx.post('/auth/login', {
    data: { email: env.EMAIL, password: env.PASSWORD },
    headers: { 'content-type': 'application/json' },
  });
  if (!browserLogin.ok()) {
    throw new Error(`NexArch QA fixture setup: login to ${env.BASE_URL} (via the app's own origin, for the browser cookie jar) failed with ${browserLogin.status()}.`);
  }
  await apiCtx.storageState({ path: AUTH_STATE_PATH });
  await apiCtx.dispose();

  fs.writeFileSync(
    path.join(__dirname, '.fixture.json'),
    JSON.stringify({ projectId: project.id, projectTitle: title }, null, 2),
  );
}
