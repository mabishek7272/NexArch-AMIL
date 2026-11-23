/**
 * The dashboard operations UI (interpretation engine, P6c) driven in a real headless Chromium against the built SPA
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

describe.skipIf(!URL_ || !fs.existsSync(path.join(SPA, 'index.html')))('dashboard operations UI in a real browser (real PostgreSQL)', () => {
  const dbName = `anuclaw_rpt_${crypto.randomBytes(6).toString('hex')}`;
  const ADMIN = crypto.randomBytes(24).toString('hex');
  let admin: Client; let server: Server; let base: string; let uiServer: Server; let uiBase: string;
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
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The dashboard is its own server (as in production): its administrator routes share paths with the shared-key ones above, so they cannot sit in one app.
    const ui = express(); ui.use(express.json({ limit: '2mb' })); ui.use((await import('cookie-parser')).default());
    ui.use('/auth', (await import('./routes/users')).default);
    ui.use('/api/anukla/ops', (await import('./routes/anukla-ops')).default);
    ui.use(express.static(SPA)); ui.get('*', (_q, s2) => s2.sendFile(path.join(SPA, 'index.html')));
    uiServer = await new Promise<Server>((r) => { const s2 = ui.listen(0, '127.0.0.1', () => r(s2)); });
    uiBase = `http://127.0.0.1:${(uiServer.address() as AddressInfo).port}`;
    tenant = await newTenant('Synthetic Reporter');
    for (const sk of [VITALS, POSTURE]) expect((await adm('PUT', `/api/v1/admin/tenants/${tenant.id}/skills/${sk}`, {})).status).toBe(201);
  }, 60_000);

  afterAll(async () => {
    if (uiServer) await new Promise<void>((r) => uiServer.close(() => r()));
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
  const mkUser = async (k: string, role: string) => {
    const auth = await import('./auth'); const pw = await import('../../security/password');
    uid[k] = `u-${crypto.randomBytes(5).toString('hex')}`;
    await q(`INSERT INTO dash_users (id, email, name, role, password_hash, created_at, terms_accepted_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`, [uid[k], `${uid[k]}@clinic-synthetic.invalid`, k, role, await pw.hashPassword(PW), Date.now()]);
    cookie[k] = (await auth.issueTokens(uid[k])).accessToken;
  };
  const page = async (who: string, viewport = { width: 1280, height: 900 }) => {
    const ctx = await browser.newContext({ viewport }); await ctx.addCookies([{ name: 'dash_token', value: cookie[who], domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    return { ctx, p: await ctx.newPage() };
  };
  const axe = async (p: import('playwright-core').Page) => {
    await p.waitForTimeout(450);
    const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const out = r.violations.filter((v: any) => v.impact === 'serious' || v.impact === 'critical').map((v: any) => `${v.id}: ${v.nodes.slice(0, 2).map((n: any) => `${n.target.join(' ')} ${String(n.html).slice(0, 160)}`).join(' | ')}`);
    if (out.length) console.log('AXE', JSON.stringify(out));
    return out;
  };
  const run = async (n = 500) => { for (let i = 0; i < n; i++) if ((await reports.runOnce()) === null && (await jobs.runOnce()) === null) return; };
  let failedJob = ''; let failedReportJob = ''; let deadDelivery = '';
  const OPS = () => `${uiBase}/nexarch/anukla/operations`;

  it('setup: users, data in each state, a real browser', async () => {
    for (const [k, r] of [['operator', 'operator'], ['auditor', 'auditor'], ['viewer', 'viewer']]) await mkUser(k, r);
    await q(`INSERT INTO tenant_webhooks (tenant_id, url, secret_kid, secret_sealed, enabled, created_at, updated_at, secret_rotated_at) VALUES ($1,'https://hooks.example.test/h','k','s',TRUE,1,1,2) ON CONFLICT DO NOTHING`, [tenant.id]);
    await clean(); failedJob = await submit(vitals()); await q(`UPDATE interpretation_jobs SET status = 'failed', error_code = 'adapter_error', attempts = 5 WHERE id = $1`, [failedJob]);
    failedReportJob = await submit(vitals()); await jobs.runOnce(); await jobs.runOnce(); await reports.runOnce();
    await q(`UPDATE interpretation_reports SET status = 'failed', error_code = 'governance_invalid' WHERE job_id = $1`, [failedReportJob]);
    const okJob = await submit(vitals()); await jobs.runOnce(); void okJob;
    deadDelivery = (await q(`SELECT id FROM webhook_deliveries WHERE tenant_id = $1 LIMIT 1`, [tenant.id]))[0].id; await q(`UPDATE webhook_deliveries SET status = 'dead', attempts = 6, last_error = 'http_500', dead_at = 5 WHERE id = $1`, [deadDelivery]);
    browser = await (await import('playwright-core')).chromium.launch({ headless: true });
    const { createRequire } = await import('module'); const mod = createRequire(path.resolve(__dirname, '../../../dashboard/package.json'))('@axe-core/playwright'); AxeBuilder = mod.AxeBuilder ?? mod.default;
  }, 90_000);
  afterAll(async () => { await browser?.close().catch(() => {}); });

  it('overview: the queue and failure facts are visible, without patient data, and accessible at desktop and phone width', async () => {
    const { ctx, p } = await page('operator');
    try {
      await p.goto(OPS()); await p.getByRole('heading', { name: 'Operations' }).waitFor();
      await p.getByText('JOBS FAILED').waitFor(); await p.getByText('adapter_error').waitFor();
      expect(await p.content()).not.toMatch(/SUBJ-|mmHg/); expect(await axe(p)).toEqual([]);
      expect(await p.getByRole('tab', { name: 'Audit check' }).count()).toBe(0); // operators do not run the chain check
      await p.setViewportSize({ width: 390, height: 800 }); await p.reload(); await p.getByRole('heading', { name: 'Operations' }).waitFor();
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); expect(await axe(p)).toEqual([]);
    } finally { await ctx.close(); }
  }, 90_000);

  it('processing history: filter to failures, open the job, retry it, and retry a failed report at its stage', async () => {
    const { ctx, p } = await page('operator');
    try {
      await p.goto(OPS()); await p.getByRole('tab', { name: 'Processing history' }).click();
      await p.getByRole('combobox', { name: 'STATUS' }).selectOption('failed'); await p.getByRole('button', { name: `Details for job ${failedJob}` }).waitFor();
      expect(await axe(p)).toEqual([]);
      await p.getByRole('button', { name: `Details for job ${failedJob}` }).click();
      const dr = p.locator('aside.nx-drawer'); await dr.getByText('Job details', { exact: false }).first().waitFor(); await dr.getByRole('button', { name: 'Retry this job' }).waitFor();
      expect(await axe(p)).toEqual([]);
      await dr.getByRole('button', { name: 'Retry this job' }).click(); await dr.getByText('Job re-queued.').waitFor();
      expect((await q('SELECT status, attempts, error_code FROM interpretation_jobs WHERE id = $1', [failedJob]))[0]).toEqual({ status: 'queued', attempts: 0, error_code: null });
      await dr.getByRole('button', { name: 'Retry this job' }).waitFor({ state: 'detached' }); // gone once the job is no longer failed
      await p.keyboard.press('Escape');
      // the failed report
      await p.getByRole('combobox', { name: 'STATUS' }).selectOption(''); await p.getByRole('button', { name: `Details for job ${failedReportJob}` }).click();
      await p.locator('aside.nx-drawer').getByRole('button', { name: /^Retry report version 1/ }).click(); await p.locator('aside.nx-drawer').getByText('Report re-queued at the stage that failed.').waitFor();
      expect((await q('SELECT status, error_code FROM interpretation_reports WHERE job_id = $1', [failedReportJob]))[0]).toEqual({ status: 'governed', error_code: null });
      await p.keyboard.press('Escape'); await run();
      expect((await q('SELECT status FROM interpretation_reports WHERE job_id = $1', [failedReportJob]))[0].status).toBe('ready');
      expect((await q('SELECT status FROM interpretation_jobs WHERE id = $1', [failedJob]))[0].status).toBe('completed');
    } finally { await ctx.close(); }
  }, 90_000);

  it('webhook log: endpoints show host only; a dead delivery can be sent again', async () => {
    const { ctx, p } = await page('operator');
    try {
      await p.goto(OPS()); await p.getByRole('tab', { name: 'Webhook log' }).click();
      await p.getByText('https://hooks.example.test', { exact: true }).waitFor(); expect(await p.content()).not.toMatch(/sealed|token=/i);
      await p.getByRole('combobox', { name: 'STATUS' }).selectOption('dead'); await p.getByRole('button', { name: `Send again: delivery ${deadDelivery}` }).waitFor();
      expect(await axe(p)).toEqual([]);
      await p.getByRole('button', { name: `Send again: delivery ${deadDelivery}` }).click(); await p.getByText('Delivery queued again.').waitFor();
      expect((await q('SELECT status, attempts FROM webhook_deliveries WHERE id = $1', [deadDelivery]))[0]).toEqual({ status: 'pending', attempts: 0 });
    } finally { await ctx.close(); }
  }, 90_000);

  it('usage and spend: per-tenant figures with unknown costs marked, and the budget stated', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await q(`INSERT INTO model_spend_ledger (id, scope_kind, scope_id, period, role, model, data_class, state, reserved_usd, actual_usd, attempts, created_at) VALUES ($1,'tenant',$2,$3,'review','google/gemini-4-hydrogen','synthetic_test','unknown_cost',0.02,NULL,1,$4)`, [`sp-${crypto.randomBytes(5).toString('hex')}`, tenant.id, today, Date.now()]);
    const { ctx, p } = await page('auditor');
    try {
      await p.goto(OPS()); await p.getByRole('tab', { name: 'Usage and spend' }).click();
      await p.getByRole('row').filter({ hasText: 'Synthetic Reporter' }).waitFor();
      await p.getByText(/a lower bound/).waitFor(); expect(await p.getByRole('row').filter({ hasText: 'Synthetic Reporter' }).textContent()).toMatch(/unknown/);
      expect(await axe(p)).toEqual([]);
    } finally { await ctx.close(); }
  }, 90_000);

  it('audit check: an auditor can verify every chain; an auditor cannot re-queue anything', async () => {
    const { ctx, p } = await page('auditor');
    try {
      await p.goto(OPS()); await p.getByRole('tab', { name: 'Audit check' }).click();
      await p.getByRole('button', { name: 'Verify all tenants' }).click(); await p.getByText(/CHAINS INTACT/).waitFor();
      expect(await axe(p)).toEqual([]);
      await p.getByRole('tab', { name: 'Webhook log' }).click(); await p.getByRole('combobox', { name: 'STATUS' }).selectOption('pending'); await p.getByRole('table').last().waitFor();
      expect(await p.getByRole('button', { name: /^Send again/ }).count()).toBe(0);
      await p.getByRole('tab', { name: 'Processing history' }).click(); await p.getByRole('button', { name: /^Details for job/ }).first().click();
      await p.locator('aside.nx-drawer').getByText('Job details', { exact: false }).first().waitFor();
      expect(await p.locator('aside.nx-drawer').getByRole('button', { name: /^Retry/ }).count()).toBe(0);
    } finally { await ctx.close(); }
  }, 90_000);

  it('a viewer is refused', async () => {
    const { ctx, p } = await page('viewer');
    try { await p.goto(OPS()); await p.getByRole('alert').first().waitFor(); expect(await p.getByRole('alert').first().textContent()).toMatch(/Insufficient permissions/); } finally { await ctx.close(); }
  }, 60_000);
});
