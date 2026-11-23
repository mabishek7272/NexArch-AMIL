/**
 * The dashboard tenant administration UI (interpretation engine, P6b) driven in a real headless Chromium against the built SPA
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

describe.skipIf(!URL_ || !fs.existsSync(path.join(SPA, 'index.html')))('dashboard tenant administration UI in a real browser (real PostgreSQL)', () => {
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
    const dashRouter = express.Router(); (await import('./routes/anukla-admin')).mountAnuklaAdmin(dashRouter); ui.use(dashRouter);
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
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 7)]);
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
    await p.waitForTimeout(450); // let button colour transitions finish before measuring contrast
    const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const out = r.violations.filter((v: any) => v.impact === 'serious' || v.impact === 'critical').map((v: any) => `${v.id}: ${v.nodes.slice(0, 2).map((n: any) => `${n.target.join(' ')} [${(n.any[0]?.message ?? n.failureSummary ?? '').slice(0, 160)}]`).join(' | ')}`);
    if (out.length) console.log('AXE', JSON.stringify(out));
    return out;
  };
  let tenantId = ''; let tenantKey = '';
  const prefixOf = async (key: string) => ((await q('SELECT key_prefix FROM tenant_api_keys WHERE tenant_id = $1', [tenantId])) as any[]).map((r) => r.key_prefix as string).find((x) => key.startsWith(x.replace(/…$/, '')))!;

  it('setup: users, a real browser and the accessibility scanner', async () => {
    await mkUser('admin', 'admin'); await mkUser('auditor', 'auditor'); await mkUser('operator', 'operator');
    browser = await (await import('playwright-core')).chromium.launch({ headless: true });
    const { createRequire } = await import('module'); const req = createRequire(path.resolve(__dirname, '../../../dashboard/package.json'));
    const mod = req('@axe-core/playwright'); AxeBuilder = mod.AxeBuilder ?? mod.default;
  }, 60_000);
  afterAll(async () => { await browser?.close().catch(() => {}); });

  it('create a tenant: the key is shown once, cannot be dismissed unacknowledged, works, and is never shown again', async () => {
    const { ctx, p } = await page('admin');
    try {
      await p.goto(`${uiBase}/nexarch/anukla/tenants`); await p.getByRole('heading', { name: 'Tenants' }).waitFor();
      expect(await axe(p)).toEqual([]);
      await p.getByRole('button', { name: 'New tenant…' }).click();
      const dlg = p.locator('.nx-dialog'); await dlg.waitFor();
      await dlg.getByLabel('COMPANY NAME').fill('Browser Created Ltd'); await dlg.getByLabel('CONTACT EMAIL').fill('ops@browser-created.invalid'); await dlg.getByLabel('PLAN').selectOption('enterprise');
      expect(await axe(p)).toEqual([]);
      await dlg.getByRole('button', { name: 'Create' }).click();
      const keyBox = p.getByTestId('api-key'); await keyBox.waitFor(); tenantKey = (await keyBox.textContent())!.trim();
      expect(tenantKey).toMatch(/^amgi_live_/);
      const done = p.locator('.nx-dialog').getByRole('button', { name: 'Done' }); expect(await done.isDisabled()).toBe(true);
      await p.keyboard.press('Escape'); expect(await keyBox.count()).toBe(1); // cannot be dismissed
      await p.locator('.nx-dialog').getByRole('checkbox').check(); await done.click(); await keyBox.waitFor({ state: 'detached' });
      expect((await as(tenantKey, 'GET', '/v1/interpretations')).status).toBe(200);
      const row = p.getByRole('row').filter({ hasText: 'Browser Created Ltd' }); await row.waitFor();
      tenantId = (await q(`SELECT tenant_id FROM tenants WHERE company_name = 'Browser Created Ltd'`))[0].tenant_id;
      await p.reload(); await row.waitFor(); expect(await p.content()).not.toContain(tenantKey);
    } finally { await ctx.close(); }
  }, 60_000);

  it('keys: create, rotate and revoke (with a reason) from the tenant page', async () => {
    const { ctx, p } = await page('admin');
    try {
      await p.goto(`${uiBase}/nexarch/anukla/tenants/${tenantId}`); await p.getByRole('heading', { name: 'Browser Created Ltd' }).waitFor();
      await p.getByRole('tab', { name: 'API keys' }).click();
      await p.getByLabel('LABEL (OPTIONAL)').fill('second'); await p.getByRole('button', { name: 'Create key' }).click();
      const k2 = (await p.getByTestId('api-key').textContent())!.trim(); await p.locator('.nx-dialog').getByRole('checkbox').check(); await p.locator('.nx-dialog').getByRole('button', { name: 'Done' }).click();
      expect((await as(k2, 'GET', '/v1/interpretations')).status).toBe(200);
      expect(await axe(p)).toEqual([]);
      await p.getByRole('button', { name: `Rotate key ${await prefixOf(k2)}` }).click();
      const k3 = (await p.getByTestId('api-key').textContent())!.trim(); expect(k3).not.toBe(k2); await p.locator('.nx-dialog').getByRole('checkbox').check(); await p.locator('.nx-dialog').getByRole('button', { name: 'Done' }).click();
      expect((await as(k3, 'GET', '/v1/interpretations')).status).toBe(200);
      await p.getByRole('button', { name: `Revoke key ${await prefixOf(k3)}` }).click();
      const dlg = p.locator('.nx-dialog'); const go = dlg.getByRole('button', { name: 'Revoke now' }); expect(await go.isDisabled()).toBe(true);
      await dlg.getByLabel('REASON').fill('browser test'); await go.click(); await p.getByText('Key revoked.').waitFor();
      expect((await as(k3, 'GET', '/v1/interpretations')).status).toBeGreaterThanOrEqual(401);
      expect((await as(tenantKey, 'GET', '/v1/interpretations')).status).toBe(200); // the first key is untouched
    } finally { await ctx.close(); }
  }, 60_000);

  it('skills: assign one, then turn the explanation model on and back off; the allow-list is all that is offered', async () => {
    const { ctx, p } = await page('admin');
    try {
      await p.goto(`${uiBase}/nexarch/anukla/tenants/${tenantId}`); await p.getByRole('tab', { name: 'Skills and narrative' }).click();
      const assign = p.getByRole('button', { name: /^Assign .*[Pp]hysiological|^Assign Physiological/ }).first();
      await p.getByRole('button', { name: /^Assign / }).first().waitFor();
      const card = p.locator('[data-skill="physiological-signal-interpretation"]');
      await card.getByRole('button', { name: /^Assign / }).click(); await p.getByText('Skill assigned.').waitFor(); void assign;
      expect((await q(`SELECT enabled FROM tenant_skills WHERE tenant_id = $1 AND skill_id = 'physiological-signal-interpretation'`, [tenantId]))[0].enabled).toBe(true);
      const card2 = p.locator('[data-skill="physiological-signal-interpretation"]');
      const options = await card2.locator('select option').allTextContents(); expect(options).toContain('google/gemini-4-hydrogen'); expect(options.join(' ')).not.toMatch(/neon|carbon/);
      expect(await axe(p)).toEqual([]);
      await card2.getByLabel('Use a language model for the explanation text').check(); await card2.getByRole('button', { name: 'Save' }).click(); await p.getByText('Explanation text will use the selected model.').waitFor();
      expect(JSON.parse((await q(`SELECT config_json FROM tenant_skills WHERE tenant_id = $1 AND skill_id = 'physiological-signal-interpretation'`, [tenantId]))[0].config_json).narrative).toEqual({ enabled: true, model: options[0] });
      await p.locator('[data-skill="physiological-signal-interpretation"]').getByLabel('Use a language model for the explanation text').uncheck();
      await p.locator('[data-skill="physiological-signal-interpretation"]').getByRole('button', { name: 'Save' }).click(); await p.getByText('Explanation text uses fixed templates.').waitFor();
      expect(JSON.parse((await q(`SELECT config_json FROM tenant_skills WHERE tenant_id = $1 AND skill_id = 'physiological-signal-interpretation'`, [tenantId]))[0].config_json).narrative).toEqual({ enabled: false });
    } finally { await ctx.close(); }
  }, 60_000);

  it('branding: name and logo are saved and shown on a real report; markup in the name is refused', async () => {
    const { ctx, p } = await page('admin');
    try {
      await p.goto(`${uiBase}/nexarch/anukla/tenants/${tenantId}`); await p.getByRole('tab', { name: 'Report branding' }).click();
      await p.getByLabel(/^PRODUCT NAME/).fill('<b>Bad</b>'); await p.getByRole('button', { name: 'Save branding' }).click(); await p.getByRole('alert').waitFor();
      await p.getByLabel(/^PRODUCT NAME/).fill('Browser Health (UK)');
      fs.writeFileSync('/tmp/anukla-logo.png', PNG); await p.getByLabel(/^LOGO/).setInputFiles('/tmp/anukla-logo.png');
      expect(await axe(p)).toEqual([]);
      await p.getByRole('button', { name: 'Save branding' }).click(); await p.getByText('Branding saved.').waitFor();
      expect((await q('SELECT product_name, logo_mime FROM tenant_branding WHERE tenant_id = $1', [tenantId]))[0]).toEqual({ product_name: 'Browser Health (UK)', logo_mime: 'image/png' });
      await p.getByText(/Current: Browser Health \(UK\); logo \(image\/png\)/).waitFor();
    } finally { await ctx.close(); }
  }, 60_000);

  it('audit trail: the chain verifies and shows who acted; suspend and reactivate take effect', async () => {
    const { ctx, p } = await page('admin');
    try {
      await p.goto(`${uiBase}/nexarch/anukla/tenants/${tenantId}`); await p.getByRole('tab', { name: 'Audit trail' }).click();
      await p.getByText(/CHAIN VERIFIED/).waitFor();
      expect(await p.getByRole('cell', { name: `dashboard:${uid.admin}` }).count()).toBeGreaterThan(3);
      expect(await axe(p)).toEqual([]);
      await p.getByRole('tab', { name: 'Overview' }).click();
      await p.getByRole('button', { name: 'Suspend tenant…' }).click(); await p.locator('.nx-dialog').getByRole('button', { name: 'Suspend', exact: true }).click(); await p.getByText('Tenant suspended.').waitFor();
      expect((await as(tenantKey, 'GET', '/v1/interpretations')).status).toBeGreaterThanOrEqual(401);
      await p.getByRole('button', { name: 'Reactivate tenant' }).click(); await p.getByText('Tenant reactivated.').waitFor();
      expect((await as(tenantKey, 'GET', '/v1/interpretations')).status).toBe(200);
    } finally { await ctx.close(); }
  }, 60_000);

  it('skill registry page: lists skills and adapters; an administrator can switch a skill off and on', async () => {
    const { ctx, p } = await page('admin');
    try {
      await p.goto(`${uiBase}/nexarch/anukla/skills`); await p.getByRole('heading', { name: 'Skill registry' }).waitFor();
      await p.getByText('physiological-signal-interpretation').first().waitFor(); expect(await axe(p)).toEqual([]);
      const off = p.getByRole('button', { name: /^Switch off .*[Pp]hysiological/ }).first();
      await off.click(); await p.getByRole('button', { name: /^Switch on .*[Pp]hysiological/ }).first().waitFor();
      expect((await q(`SELECT enabled FROM skills WHERE skill_id = 'physiological-signal-interpretation'`))[0].enabled).toBe(false);
      await p.getByRole('button', { name: /^Switch on .*[Pp]hysiological/ }).first().click(); await p.getByRole('button', { name: /^Switch off .*[Pp]hysiological/ }).first().waitFor();
      expect((await q(`SELECT enabled FROM skills WHERE skill_id = 'physiological-signal-interpretation'`))[0].enabled).toBe(true);
    } finally { await ctx.close(); }
  }, 60_000);

  it('an auditor can read everything and change nothing; an operator is refused', async () => {
    const a = await page('auditor');
    try {
      await a.p.goto(`${uiBase}/nexarch/anukla/tenants`); await a.p.getByRole('heading', { name: 'Tenants' }).waitFor();
      expect(await a.p.getByRole('button', { name: 'New tenant…' }).count()).toBe(0);
      await a.p.goto(`${uiBase}/nexarch/anukla/tenants/${tenantId}`); await a.p.getByText(/Read-only: changes need an administrator account/).waitFor();
      await a.p.getByRole('tab', { name: 'API keys' }).click(); await a.p.getByRole('table').waitFor();
      expect(await a.p.getByRole('button', { name: 'Create key' }).count()).toBe(0); expect(await a.p.getByRole('button', { name: /^Rotate key/ }).count()).toBe(0);
      await a.p.getByRole('tab', { name: 'Skills and narrative' }).click(); await a.p.getByText('Skills and explanation text').waitFor();
      expect(await a.p.getByRole('button', { name: /^Assign |^Remove /i }).count()).toBe(0);
      await a.p.getByRole('tab', { name: 'Report branding' }).click(); expect(await a.p.getByRole('button', { name: 'Save branding' }).count()).toBe(0);
      expect(await axe(a.p)).toEqual([]);
    } finally { await a.ctx.close(); }
    const o = await page('operator');
    try {
      await o.p.goto(`${uiBase}/nexarch/anukla/tenants`); await o.p.getByRole('alert').waitFor();
      expect(await o.p.getByRole('alert').textContent()).toMatch(/Insufficient permissions/); expect(await o.p.getByRole('row').count()).toBeLessThanOrEqual(1);
    } finally { await o.ctx.close(); }
  }, 60_000);

  it('phone width: no horizontal page scroll on the tenant pages', async () => {
    const { ctx, p } = await page('admin', { width: 390, height: 800 });
    try {
      for (const u of ['/nexarch/anukla/tenants', `/nexarch/anukla/tenants/${tenantId}`, '/nexarch/anukla/skills']) {
        await p.goto(`${uiBase}${u}`); await p.locator('h1').first().waitFor();
        expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), u).toBe(true);
      }
    } finally { await ctx.close(); }
  }, 60_000);
});
