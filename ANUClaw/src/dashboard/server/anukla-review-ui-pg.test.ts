/**
 * The dashboard clinician review UI (interpretation engine, P6a) driven in a real headless Chromium against the built SPA
 * (`dashboard/dist`), a real server and REAL PostgreSQL (disposable database; opt-in via ANUCLAW_TEST_PG_URL). Includes an
 * accessibility scan (axe). Synthetic data only. No model is called. Skipped when the SPA is not built or Chromium is missing.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { contentHash } from '../../cds/hashing';
import { bundlePayloadOf, syntheticPosture } from '../../integrations/posturepulse/fixtures';
import { signBundle } from '../../integrations/posturepulse/upstream';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../container-runner', () => ({ runAgent: vi.fn(async () => ({ text: 'unused', artifacts: [] })) }));

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '../../interpretation/contracts/examples/beaive-vitals.request.json'), 'utf8'));
const VITALS = 'physiological-signal-interpretation';
const POSTURE = 'posture-analysis-interpretation';
const SPA = path.resolve(__dirname, '../../../dashboard/dist');
const PP_SECRET = 'import-secret-'.padEnd(40, 'z');

describe.skipIf(!URL_ || !fs.existsSync(path.join(SPA, 'index.html')))('dashboard clinician review UI in a real browser (real PostgreSQL)', () => {
  const dbName = `anuclaw_rpt_${crypto.randomBytes(6).toString('hex')}`;
  const ADMIN = crypto.randomBytes(24).toString('hex');
  let admin: Client; let server: Server; let base: string;
  let mainPool: { end(): Promise<void> } | undefined;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let signoff: typeof import('../../interpretation/reports/signoff'); let jobs: typeof import('../../interpretation/jobs/worker'); let reports: typeof import('../../interpretation/reports/worker'); let rqueue: typeof import('../../interpretation/reports/queue');
  let validate: typeof import('../../interpretation/contracts/validate');
  let tenant: { id: string; key: string };

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, {
      PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName,
      ANUCLAW_JWT_SECRET: crypto.randomBytes(32).toString('hex'), ANUCLAW_IDENTITY_VAULT_KEY: crypto.randomBytes(32).toString('hex'),
      ANUCLAW_POSTUREPULSE_IMPORT_SECRET: PP_SECRET, DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    });
    delete process.env.ANUCLAW_RATE_STORE; delete process.env.ANUCLAW_SELF_REGISTRATION;
    vi.resetModules();
    await (await import('../../db/connection')).ensureDbReady();
    mainPool = (await import('../../db/connection')).getDb();
    q = (await import('../../db')).db.query as any;
    jobs = await import('../../interpretation/jobs/worker'); reports = await import('../../interpretation/reports/worker'); rqueue = await import('../../interpretation/reports/queue'); signoff = await import('../../interpretation/reports/signoff'); validate = await import('../../interpretation/contracts/validate');

    const express = (await import('express')).default;
    const app = express(); app.use(express.json({ limit: '2mb' }));
    app.use((await import('../../interpretation/tenancy/admin-routes')).createTenantAdminRouter({ adminKey: ADMIN }));
    app.use((await import('../../interpretation/skills/admin-routes')).createSkillAdminRouter({ adminKey: ADMIN }));
    app.use((await import('../../interpretation/jobs/routes')).default);
    app.use((await import('../../interpretation/reports/routes')).default);
    const cookieParser = (await import('cookie-parser')).default;
    app.use(cookieParser());
    app.use('/auth', (await import('./routes/users')).default);
    app.use('/api/anukla/review', (await import('./routes/anukla-review')).default);
    if (fs.existsSync(path.join(SPA, 'index.html'))) { app.use(express.static(SPA)); app.get('*', (_q, s) => s.sendFile(path.join(SPA, 'index.html'))); }
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    tenant = await newTenant('Synthetic Reporter');
    for (const sk of [VITALS, POSTURE]) expect((await adm('PUT', `/api/v1/admin/tenants/${tenant.id}/skills/${sk}`, {})).status).toBe(201);
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await mainPool?.end().catch(() => { /* already closed */ });
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const adm = (method: string, p: string, body?: unknown) => fetch(base + p, { method, headers: { 'x-admin-key': ADMIN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const as = (key: string, method: string, p: string, body?: unknown) => fetch(base + p, { method, headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  async function newTenant(name: string) {
    const r = await adm('POST', '/api/v1/admin/tenants', { company_name: name, email: `${name.toLowerCase().replace(/\W+/g, '-')}-${crypto.randomBytes(3).toString('hex')}@synthetic.invalid`, plan: 'enterprise' });
    const b = await r.json(); expect(r.status).toBe(201); return { id: b.tenant_id as string, key: b.api_key as string };
  }
  const vitals = (over: (r: any) => void = () => {}) => { const r = JSON.parse(JSON.stringify(EXAMPLE)); r.tenantRequestId = `v-${crypto.randomBytes(4).toString('hex')}`; r.subject.externalRef = `SUBJ-${crypto.randomBytes(3).toString('hex')}`; over(r); return r; };
  const posture = (mode: 'signed' | 'unsigned') => {
    const f = syntheticPosture();
    return { schemaVersion: 'interpretation-request/v1', skillId: POSTURE, analysisType: 'posture_landmark', subject: { externalRef: f.session.subjectPseudoId },
      acquisition: { capturedAt: new Date().toISOString() }, source: { application: 'PosturePulse', modelName: 'synthetic-pose', modelVersion: '0' },
      nativePayload: mode === 'signed' ? { format: 'posturepulse-assessment/v0', bundle: signBundle(bundlePayloadOf(f) as any, PP_SECRET) }
        : { format: 'posturepulse-assessment/v0', unsigned: { consentRecord: f.consentRecord, session: f.session, report: f.report, symptomReports: f.symptomReports } } };
  };
  const submit = async (body: unknown) => (await (await as(tenant.key, 'POST', '/v1/interpretations', body)).json()).id as string;
  const drainJobs = async () => { for (let i = 0; i < 50; i++) if ((await jobs.runOnce()) === null) return; };
  const drainReports = async () => { for (let i = 0; i < 50; i++) if ((await reports.runOnce()) === null) return; };
  const reportOf = async (jobId: string) => (await q('SELECT * FROM interpretation_reports WHERE job_id = $1 ORDER BY version', [jobId]))[0];
  const clean = async () => { await drainJobs(); await drainReports(); };


  // ── fixtures ───────────────────────────────────────────────────────────────────────────────

  const PW = 'Correct-Horse-Battery-1!';
  const cookie: Record<string, string> = {}; const uid: Record<string, string> = {};
  let browser: import('playwright-core').Browser; let AxeBuilder: any;
  const mkUser = async (k: string, role: string, name: string, cred: boolean) => {
    const auth = await import('./auth'); const pw = await import('../../security/password');
    uid[k] = `u-${crypto.randomBytes(5).toString('hex')}`;
    await q(`INSERT INTO dash_users (id, email, name, role, password_hash, created_at, terms_accepted_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`, [uid[k], `${uid[k]}@clinic-synthetic.invalid`, name, role, await pw.hashPassword(PW), Date.now()]);
    if (cred) await q(`INSERT INTO clinician_credentials (user_id, license_number, jurisdiction, licensing_body, verification_note, status, provisioned_by, provisioned_at) VALUES ($1,'SYN-1','Nowhere','Synthetic Board','synthetic','active','admin-x',$2)`, [uid[k], Date.now()]);
    cookie[k] = (await auth.issueTokens(uid[k])).accessToken;
  };
  const page = async (who: string, viewport = { width: 1280, height: 900 }) => {
    const ctx = await browser.newContext({ viewport });
    await ctx.addCookies([{ name: 'dash_token', value: cookie[who], domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    return { ctx, p: await ctx.newPage() };
  };
  const axe = async (p: import('playwright-core').Page) => {
    // A sandboxed iframe (no scripts) cannot run the scanner, so the report pages are scanned on their own, below.
    const r = await new AxeBuilder({ page: p }).exclude('iframe').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    return r.violations.filter((v: any) => v.impact === 'serious' || v.impact === 'critical').map((v: any) => `${v.id}: ${v.nodes.slice(0, 2).map((n: any) => n.target.join(' ')).join(' | ')}`);
  };
  const origin = () => base;

  it('setup: users, a real browser and the accessibility scanner', async () => {
    await mkUser('doc', 'clinician', 'Dr Browser One', true); await mkUser('admin', 'admin', 'Admin Browser', false);
    try { browser = await (await import('playwright-core')).chromium.launch({ headless: true }); } catch { ctxSkip(); }
    const { createRequire } = await import('module');
    AxeBuilder = createRequire(path.resolve(__dirname, '../../../dashboard/package.json'))('@axe-core/playwright').AxeBuilder ?? createRequire(path.resolve(__dirname, '../../../dashboard/package.json'))('@axe-core/playwright').default;
    await q(`INSERT INTO tenant_webhooks (tenant_id, url, secret_kid, secret_sealed, enabled, created_at, updated_at, secret_rotated_at) VALUES ($1,'https://hooks.example.test/h','k','s',TRUE,1,1,1) ON CONFLICT DO NOTHING`, [tenant.id]);
  }, 60_000);
  function ctxSkip(): never { throw new Error('Chromium is not available in this environment'); }
  afterAll(async () => { await browser?.close().catch(() => {}); });

  it('the queue page lists the awaiting report, links to it, and is accessible at desktop and phone width', async () => {
    await clean(); const aw = await submit(posture('unsigned')); await drainJobs(); await drainReports();
    const { ctx, p } = await page('doc');
    try {
      await p.goto(`${origin()}/nexarch/anukla/review`);
      await p.getByRole('heading', { name: 'Clinical review' }).waitFor();
      const row = p.getByRole('row').filter({ hasText: 'AWAITING CLINICIAN' }).first(); await row.waitFor();
      await expect(await row.textContent()).toContain('Synthetic Reporter');
      expect(await axe(p)).toEqual([]);
      await p.setViewportSize({ width: 390, height: 800 });
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(await axe(p)).toEqual([]);
      await p.getByRole('button', { name: 'Follow-ups' }).click(); await p.getByRole('button', { name: 'Follow-ups' }).waitFor();
      expect(await p.getByRole('button', { name: 'Follow-ups' }).getAttribute('aria-pressed')).toBe('true');
      void aw;
    } finally { await ctx.close(); }
  }, 60_000);

  it('opening a report shows the sandboxed pages, the review facts, and no secret text from the layers outside the frame', async () => {
    await clean(); const id = await submit(vitals()); await drainJobs(); await drainReports(); const r = await reportOf(id);
    const { ctx, p } = await page('doc');
    try {
      await p.goto(`${origin()}/nexarch/anukla/review/${r.id}`);
      await p.getByRole('heading', { name: 'Report review' }).waitFor();
      const frame = p.locator('iframe[title^="clinical report"]'); await frame.waitFor();
      expect(await frame.getAttribute('sandbox')).toBe('');
      const inner = p.frameLocator('iframe[title^="clinical report"]');
      await inner.getByText('Governance', { exact: true }).waitFor(); await inner.getByRole('heading', { name: 'Referral advisory' }).waitFor();
      await p.getByRole('tab', { name: 'Layman layer' }).click();
      await p.frameLocator('iframe[title^="layman report"]').getByText('Please see a doctor').waitFor();
      await p.getByText('Automatic review (rules, not a clinician)'.toUpperCase()).waitFor();
      expect(await p.getByText('Both layers are bound to the same findings and governance').count()).toBe(1);
      expect(await p.getByRole('button', { name: /Sign this version/ }).isEnabled()).toBe(true);
      expect(await p.getByRole('button', { name: /Request a replacement/ }).count()).toBe(0);
      expect(await axe(p)).toEqual([]);
      // the rendered report pages themselves (what the iframes show), in both layers
      for (const layer of ['clinical', 'layman']) {
        await p.goto(`${origin()}/api/anukla/review/reports/${r.id}/html?layer=${layer}`);
        await p.getByRole('heading', { level: 1 }).waitFor();
        expect(await axe(p), `${layer} page`).toEqual([]);
      }
    } finally { await ctx.close(); }
  }, 60_000);

  it('signing in the browser: the button waits for the attestation and password, a wrong password is refused, the right one signs a new version', async () => {
    await clean(); const id = await submit(vitals()); await drainJobs(); await drainReports(); const r = await reportOf(id);
    const { ctx, p } = await page('doc');
    try {
      await p.goto(`${origin()}/nexarch/anukla/review/${r.id}`);
      await p.getByRole('button', { name: /Sign this version/ }).click();
      const dlg = p.locator('.nx-dialog'); await dlg.waitFor();
      expect(await axe(p)).toEqual([]);
      const confirm = dlg.getByRole('button', { name: 'Sign', exact: true });
      expect(await confirm.isDisabled()).toBe(true);
      await dlg.getByLabel('YOUR PASSWORD').fill('not-my-password'); expect(await confirm.isDisabled()).toBe(true);
      await dlg.getByRole('checkbox').check(); expect(await confirm.isEnabled()).toBe(true);
      await confirm.click(); await dlg.getByText('The password is incorrect.').waitFor();
      expect(await q('SELECT 1 FROM interpretation_reports WHERE job_id = $1', [id])).toHaveLength(1);
      await dlg.getByLabel('YOUR PASSWORD').fill(PW); await confirm.click();
      await p.getByText(/Signed\. A new version \(v2\)/).waitFor();
      const rows = await q('SELECT version, status, review_state, reviewed_by FROM interpretation_reports WHERE job_id = $1 ORDER BY version', [id]);
      expect(rows).toEqual([{ version: 1, status: 'superseded', review_state: 'ai_reviewed', reviewed_by: null }, { version: 2, status: 'ready', review_state: 'clinician_signed', reviewed_by: 'Dr Browser One' }]);
      // the page now shows the signed version; the sign button is gone for it
      await p.goto(`${origin()}/nexarch/anukla/review/${rows.length && (await q('SELECT id FROM interpretation_reports WHERE job_id = $1 AND version = 2', [id]))[0].id}`);
      await p.getByText(/^Signed by Dr Browser One, /).first().waitFor();
      expect(await p.getByRole('button', { name: /Sign this version/ }).isDisabled()).toBe(true);
    } finally { await ctx.close(); }
  }, 60_000);

  it('rejecting then requesting a replacement in the browser', async () => {
    await clean(); const id = await submit(vitals()); await drainJobs(); await drainReports(); const r = await reportOf(id);
    const { ctx, p } = await page('doc');
    try {
      await p.goto(`${origin()}/nexarch/anukla/review/${r.id}`);
      await p.getByRole('button', { name: /Reject/ }).click();
      const dlg = p.locator('.nx-dialog'); await dlg.waitFor();
      const go = dlg.getByRole('button', { name: 'Reject', exact: true }); expect(await go.isDisabled()).toBe(true);
      await dlg.getByLabel('REASON (1-500 CHARACTERS)').fill('Reference range does not fit this patient'); await dlg.getByLabel('YOUR PASSWORD').fill(PW);
      await go.click(); await p.getByText(/Rejected\. The tenant now sees/).waitFor();
      await p.getByRole('button', { name: /Request a replacement version/ }).click();
      await p.locator('.nx-dialog').getByRole('button', { name: 'Request', exact: true }).click();
      await p.getByText(/A replacement version \(v2\) was queued/).waitFor();
      expect((await q('SELECT version, status FROM interpretation_reports WHERE job_id = $1 ORDER BY version', [id])).map((x: any) => [x.version, x.status])).toEqual([[1, 'ready'], [2, 'queued']]);
      await drainReports();
      expect((await q('SELECT version, status FROM interpretation_reports WHERE job_id = $1 ORDER BY version', [id])).map((x: any) => [x.version, x.status])).toEqual([[1, 'superseded'], [2, 'ready']]);
    } finally { await ctx.close(); }
  }, 60_000);

  it('an administrator sees the queue but cannot open a report', async () => {
    await clean(); const id = await submit(posture('unsigned')); await drainJobs(); await drainReports(); const r = await reportOf(id);
    const { ctx, p } = await page('admin');
    try {
      await p.goto(`${origin()}/nexarch/anukla/review`);
      await p.getByRole('heading', { name: 'Clinical review' }).waitFor();
      await p.getByText(/opening a report needs a provisioned clinician account/).waitFor();
      expect(await p.getByRole('link', { name: /Open report for/ }).count()).toBe(0);
      await p.goto(`${origin()}/nexarch/anukla/review/${r.id}`);
      await p.getByRole('alert').waitFor();
      expect(await p.getByRole('alert').textContent()).toMatch(/provisioned licensed clinician is required/);
      expect(await p.locator('iframe').count()).toBe(0);
    } finally { await ctx.close(); }
  }, 60_000);
});
