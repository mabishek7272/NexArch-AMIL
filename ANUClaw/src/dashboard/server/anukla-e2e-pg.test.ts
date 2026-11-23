/**
 * End-to-end test of the whole Anukla stack as a person would use it (P6d). It boots the REAL composition against a disposable
 * PostgreSQL database: the real API app (tenant endpoints), the real dashboard server (login, sessions, roles, every Anukla module
 * and the built SPA), and the real job, report and webhook workers. A real headless Chromium then logs in through the real login
 * page (no cookie injection) and walks every module, while the test creates data through the real HTTP APIs and reads the
 * database to check what actually happened. Synthetic data only. No language model is called (narratives stay off).
 *
 * Opt-in: ANUCLAW_TEST_PG_URL. Needs `dashboard/dist` (npm run dashboard:build) and Chromium; skipped otherwise.
 * Set ANUCLAW_E2E_SHOTS=<dir> to save a screenshot of every page for visual review.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bundlePayloadOf, syntheticPosture } from '../../integrations/posturepulse/fixtures';
import { signBundle } from '../../integrations/posturepulse/upstream';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
const SPA = path.resolve(__dirname, '../../../dashboard/dist');
const SHOTS = process.env.ANUCLAW_E2E_SHOTS;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../container-runner', () => ({ runAgent: vi.fn(async () => ({ text: 'unused', artifacts: [] })) }));

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '../../interpretation/contracts/examples/beaive-vitals.request.json'), 'utf8'));
const VITALS = 'physiological-signal-interpretation';
const POSTURE = 'posture-analysis-interpretation';
const PP_SECRET = 'import-secret-'.padEnd(40, 'z');
const PW = 'Correct-Horse-Battery-1!';

const freePort = () => new Promise<number>((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });

describe.skipIf(!URL_ || !fs.existsSync(path.join(SPA, 'index.html')))('Anukla full stack in a real browser (real PostgreSQL)', () => {
  const dbName = `anuclaw_e2e_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let apiServer: Server; let api: string; let ui: string; let dashPort: number;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let workers: Array<{ stop(): Promise<void> }> = [];
  let browser: import('playwright-core').Browser; let AxeBuilder: any;
  const users: Record<string, { id: string; email: string; role: string }> = {};
  let tenant = { id: '', key: '', name: 'E2E Clinic Ltd' };
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    dashPort = await freePort();
    Object.assign(process.env, {
      PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName,
      ANUCLAW_JWT_SECRET: crypto.randomBytes(32).toString('hex'), DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex'), ANUCLAW_IDENTITY_VAULT_KEY: crypto.randomBytes(32).toString('hex'),
      ANUCLAW_WEBHOOK_SECRET_KEY: crypto.randomBytes(32).toString('hex'), ANUCLAW_POSTUREPULSE_IMPORT_SECRET: PP_SECRET, CDS_ENABLED: 'false', DASHBOARD_PORT: String(dashPort), ADMIN_API_KEY: crypto.randomBytes(24).toString('hex'),
    });
    delete process.env.ANUCLAW_RATE_STORE; delete process.env.ANUCLAW_SELF_REGISTRATION; delete process.env.ANUCLAW_NARRATIVE_MODELS;
    vi.resetModules();
    await (await import('../../db/connection')).ensureDbReady();
    q = (await import('../../db')).db.query as any;
    // The real API app and the real dashboard server.
    const { createApiApp } = await import('../../api/server');
    const built = createApiApp(); apiServer = await new Promise<Server>((r) => { const s = built.app.listen(0, '127.0.0.1', () => r(s)); });
    api = `http://127.0.0.1:${(apiServer.address() as net.AddressInfo).port}`;
    (await import('../server/index')).mountDashboard(); ui = `http://127.0.0.1:${dashPort}`;
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`${ui}/auth/me`)).status) break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    // The real workers.
    (await import('../../interpretation/adapters')).registerBuiltinAdapters();
    workers = [(await import('../../interpretation/jobs/worker')).startInterpretationWorker({ intervalMs: 100 }), (await import('../../interpretation/reports/worker')).startReportWorker({ intervalMs: 100 })];
    browser = await (await import('playwright-core')).chromium.launch({ headless: true });
    const { createRequire } = await import('module'); const mod = createRequire(path.resolve(__dirname, '../../../dashboard/package.json'))('@axe-core/playwright'); AxeBuilder = mod.AxeBuilder ?? mod.default;
    // Accounts. Passwords are real scrypt hashes; the admin has not accepted the terms yet (the first-login flow is tested).
    const pw = await import('../../security/password'); const hash = await pw.hashPassword(PW);
    for (const [k, role] of [['admin', 'admin'], ['operator', 'operator'], ['auditor', 'auditor'], ['compliance', 'compliance'], ['viewer', 'viewer'], ['doc', 'viewer']]) {
      const id = `u-${k}-${crypto.randomBytes(3).toString('hex')}`; users[k] = { id, email: `${k}@e2e-synthetic.invalid`, role };
      await q(`INSERT INTO dash_users (id, email, name, role, password_hash, created_at, terms_accepted_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, users[k].email, k === 'doc' ? 'Dr E2E Clinician' : k, role, hash, Date.now(), k === 'admin' ? null : Date.now()]);
    }
  }, 120_000);

  afterAll(async () => {
    for (const w of workers) await w.stop().catch(() => {});
    await browser?.close().catch(() => {});
    if (apiServer) await new Promise<void>((r) => apiServer.close(() => r()));
    try { (await import('../../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  // ── helpers ────────────────────────────────────────────────────────────────────────────────

  const states: Record<string, any> = {};
  const shot = async (p: import('playwright-core').Page, name: string) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); } };
  const axe = async (p: import('playwright-core').Page, where: string) => {
    await p.waitForTimeout(450);
    const r = await new AxeBuilder({ page: p }).exclude('iframe').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const out = r.violations.filter((v: any) => v.impact === 'serious' || v.impact === 'critical').map((v: any) => `${where} ${v.id}: ${v.nodes.slice(0, 2).map((n: any) => `${n.target.join(' ')} ${String(n.html).slice(0, 140)}`).join(' | ')}`);
    return out;
  };
  /** A fresh browser context signed in AS this person through the real login page (state is kept so later tests reuse the session). */
  async function open(role: string, viewport = { width: 1280, height: 900 }) {
    if (!states[role]) {
      const ctx = await browser.newContext({ viewport }); const p = await ctx.newPage();
      await p.goto(`${ui}/login`); await p.locator('#email').fill(users[role].email); await p.locator('#password').fill(PW); await p.getByRole('button', { name: 'Sign in' }).click();
      await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
      states[role] = await ctx.storageState(); await ctx.close();
    }
    const ctx = await browser.newContext({ viewport, storageState: states[role] }); return { ctx, p: await ctx.newPage() };
  }
  const cookieOf = (role: string) => (states[role].cookies as Array<{ name: string; value: string }>).map((c) => `${c.name}=${c.value}`).join('; ');
  const dash = async (role: string, method: string, p: string, body?: unknown) => { const r = await fetch(`${ui}${p}`, { method, headers: { cookie: cookieOf(role), 'content-type': 'application/json' }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) }); let j: any = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j, res: r }; };
  const tapi = (method: string, p: string, body?: unknown, extra: Record<string, string> = {}, key = tenant.key) => fetch(`${api}${p}`, { method, headers: { 'x-api-key': key, 'content-type': 'application/json', ...extra }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
  const vitalsBody = (subject: string, capturedAt: string, hr: number, extra: (r: any) => void = () => {}) => {
    const r = JSON.parse(JSON.stringify(EXAMPLE)); r.tenantRequestId = `e2e-${crypto.randomBytes(4).toString('hex')}`; r.subject.externalRef = subject; r.acquisition.capturedAt = capturedAt;
    for (const f of r.findings) { if (f.key === 'hr') { f.value = hr; f.uncertainty = { plusMinus: 3 }; } if (f.key === 'spo2') f.uncertainty = { plusMinus: 1 }; }
    extra(r); return r;
  };
  const postureBody = (mode: 'signed' | 'unsigned') => {
    const f = syntheticPosture();
    return { schemaVersion: 'interpretation-request/v1', skillId: POSTURE, analysisType: 'posture_landmark', subject: { externalRef: f.session.subjectPseudoId }, acquisition: { capturedAt: new Date().toISOString() }, source: { application: 'PosturePulse', modelName: 'synthetic-pose', modelVersion: '0' },
      nativePayload: mode === 'signed' ? { format: 'posturepulse-assessment/v0', bundle: signBundle(bundlePayloadOf(f) as any, PP_SECRET) } : { format: 'posturepulse-assessment/v0', unsigned: { consentRecord: f.consentRecord, session: f.session, report: f.report, symptomReports: f.symptomReports } } };
  };
  const submit = async (body: unknown, headers: Record<string, string> = {}) => { const r = await tapi('POST', '/v1/interpretations', body, headers); const j = await r.json(); if (r.status >= 300) throw new Error(`submit ${r.status} ${JSON.stringify(j)}`); return j.id as string; };
  const until = async (fn: () => Promise<boolean>, what: string, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timed out waiting for ${what}`); };
  const reportReady = (jobId: string) => until(async () => (await q(`SELECT 1 FROM interpretation_reports WHERE job_id = $1 AND status = 'ready'`, [jobId])).length > 0, `report for ${jobId}`);
  const reportOf = async (jobId: string, version = 0) => (await q(`SELECT * FROM interpretation_reports WHERE job_id = $1 ${version ? 'AND version = $2' : ''} ORDER BY version DESC LIMIT 1`, version ? [jobId, version] : [jobId]))[0];

  // ── 1. sign in, for real ───────────────────────────────────────────────────────────────────

  it('the login page refuses a wrong password and an unknown account without saying which was wrong', async () => {
    const ctx = await browser.newContext(); const p = await ctx.newPage();
    try {
      await p.goto(`${ui}/login`); await p.getByRole('heading', { name: 'ANUClaw' }).waitFor(); await shot(p, '01-login');
      expect(await axe(p, 'login')).toEqual([]);
      await p.locator('#email').fill(users.admin.email); await p.locator('#password').fill('not-the-password'); await p.getByRole('button', { name: 'Sign in' }).click();
      await p.getByRole('alert').waitFor(); const wrong = await p.getByRole('alert').textContent();
      await p.locator('#email').fill('nobody@e2e-synthetic.invalid'); await p.getByRole('button', { name: 'Sign in' }).click(); await p.waitForTimeout(400);
      expect(await p.getByRole('alert').textContent()).toBe(wrong); expect(p.url()).toContain('/login');
    } finally { await ctx.close(); }
  }, 60_000);

  it('first sign-in: the administrator is taken through the terms before anything else, then lands in the dashboard', async () => {
    const ctx = await browser.newContext(); const p = await ctx.newPage();
    try {
      await p.goto(`${ui}/nexarch/anukla/tenants`); await p.waitForURL(/\/login/);
      await p.locator('#email').fill(users.admin.email); await p.locator('#password').fill(PW); await p.getByRole('button', { name: 'Sign in' }).click();
      await p.waitForURL(/\/welcome/); await p.getByRole('button', { name: /Continue to Terms/ }).click();
      await p.locator('.overflow-y-auto').first().evaluate((el) => { el.scrollTop = el.scrollHeight; }); await p.getByText('I have read and understand').click();
      await shot(p, '02-terms'); await p.getByRole('button', { name: /Accept & Enter Dashboard/ }).click(); await p.waitForURL((u) => !u.pathname.startsWith('/welcome'), { timeout: 15000 });
      expect((await q('SELECT terms_accepted_at FROM dash_users WHERE id = $1', [users.admin.id]))[0].terms_accepted_at).not.toBeNull();
      states.admin = await ctx.storageState();
    } finally { await ctx.close(); }
    for (const r of ['operator', 'auditor', 'compliance', 'viewer', 'doc']) { const x = await open(r); await x.ctx.close(); } // each signs in through the real form
    expect(Object.keys(states).sort()).toEqual(['admin', 'auditor', 'compliance', 'doc', 'operator', 'viewer']);
  }, 120_000);

  it('the administrator provisions the clinician (the only way to become one), who then signs in with the new role', async () => {
    const r = await dash('admin', 'POST', `/api/users/${users.doc.id}/clinician-provisioning`, { license_number: 'SYN-E2E-1', jurisdiction: 'Synthetic', licensing_body: 'Synthetic Board', verification_note: 'checked the synthetic register' });
    expect(r.status).toBeLessThan(300);
    expect((await q('SELECT role FROM dash_users WHERE id = $1', [users.doc.id]))[0].role).toBe('clinician'); users.doc.role = 'clinician';
    delete states.doc; const x = await open('doc'); await x.ctx.close();
    expect((await dash('doc', 'GET', '/auth/me')).body.user.role).toBe('clinician');
  }, 60_000);

  // ── 2. the administrator sets a tenant up, in the browser ───────────────────────────────────

  it('administrator: creates a tenant, assigns both skills, brands its reports and manages keys, all through the UI', async () => {
    const { ctx, p } = await open('admin');
    try {
      await p.goto(`${ui}/nexarch/anukla/tenants`); await p.getByRole('heading', { name: 'Tenants' }).waitFor(); await shot(p, '10-tenants-empty');
      await p.getByRole('button', { name: 'New tenant…' }).click(); const dlg = p.locator('.nx-dialog'); await dlg.waitFor();
      await dlg.getByLabel('COMPANY NAME').fill(tenant.name); await dlg.getByLabel('CONTACT EMAIL').fill('ops@e2e-clinic.invalid'); await dlg.getByLabel('PLAN').selectOption('enterprise');
      await dlg.getByRole('button', { name: 'Create' }).click(); tenant.key = ((await p.getByTestId('api-key').textContent()) ?? '').trim(); expect(tenant.key).toMatch(/^amgi_live_/);
      await p.locator('.nx-dialog').getByRole('checkbox').check(); await p.locator('.nx-dialog').getByRole('button', { name: 'Done' }).click();
      tenant.id = (await q(`SELECT tenant_id FROM tenants WHERE company_name = $1`, [tenant.name]))[0].tenant_id;
      await p.getByRole('row').filter({ hasText: tenant.name }).getByRole('link').click(); await p.getByRole('heading', { name: tenant.name }).waitFor(); await shot(p, '11-tenant-overview');
      expect(await axe(p, 'tenant overview')).toEqual([]);

      // skills: nothing assigned yet, so the tenant cannot submit; then assign both
      expect((await tapi('POST', '/v1/interpretations', vitalsBody('E2E-NOSKILL', '2026-09-01T08:00:00Z', 70))).status).toBe(403);
      await p.getByRole('tab', { name: 'Skills and narrative' }).click();
      for (const sk of [VITALS, POSTURE]) { const card = p.locator(`[data-skill="${sk}"]`); await card.getByRole('button', { name: /^Assign / }).click(); await card.getByText('ASSIGNED', { exact: true }).waitFor(); }
      await shot(p, '12-tenant-skills'); expect(await axe(p, 'tenant skills')).toEqual([]);
      expect((await q(`SELECT skill_id FROM tenant_skills WHERE tenant_id = $1 ORDER BY 1`, [tenant.id])).map((r: any) => r.skill_id)).toEqual([VITALS, POSTURE]);
      // the model for explanation text stays OFF unless an administrator turns it on
      expect(JSON.parse((await q(`SELECT config_json FROM tenant_skills WHERE tenant_id = $1 AND skill_id = $2`, [tenant.id, VITALS]))[0].config_json).narrative).toBeUndefined();

      // branding
      await p.getByRole('tab', { name: 'Report branding' }).click();
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 9)]); const f = path.join('/tmp', `e2e-logo-${crypto.randomBytes(3).toString('hex')}.png`); fs.writeFileSync(f, png);
      await p.getByLabel(/^PRODUCT NAME/).fill('E2E Health'); await p.getByLabel(/^LOGO/).setInputFiles(f); await p.getByRole('button', { name: 'Save branding' }).click(); await p.getByText('Branding saved.').waitFor(); await shot(p, '13-tenant-branding');

      // keys: create, rotate, revoke
      await p.getByRole('tab', { name: 'API keys' }).click(); await p.getByLabel('LABEL (OPTIONAL)').fill('integration'); await p.getByRole('button', { name: 'Create key' }).click();
      const k2 = ((await p.getByTestId('api-key').textContent()) ?? '').trim(); await p.locator('.nx-dialog').getByRole('checkbox').check(); await p.locator('.nx-dialog').getByRole('button', { name: 'Done' }).click();
      expect((await tapi('GET', '/v1/interpretations', undefined, {}, k2)).status).toBe(200); await shot(p, '14-tenant-keys');
      await p.getByRole('button', { name: new RegExp(`^Revoke key ${(await q('SELECT key_prefix FROM tenant_api_keys WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1', [tenant.id]))[0].key_prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).click();
      await p.locator('.nx-dialog').getByLabel('REASON').fill('e2e done'); await p.locator('.nx-dialog').getByRole('button', { name: 'Revoke now' }).click(); await p.getByText('Key revoked.').waitFor();
      expect((await tapi('GET', '/v1/interpretations', undefined, {}, k2)).status).toBeGreaterThanOrEqual(401); expect((await tapi('GET', '/v1/interpretations')).status).toBe(200);
      await p.getByRole('tab', { name: 'Audit trail' }).click(); await p.getByText(/CHAIN VERIFIED/).waitFor(); await shot(p, '15-tenant-audit');
    } finally { await ctx.close(); }
  }, 180_000);

  // ── 3. the tenant app sends data, through the real API ──────────────────────────────────────

  it('tenant API: sends scans of several kinds; every one is processed to a finished report by the real workers', async () => {
    const S1 = 'E2E-SUBJ-ONE';
    ids.v1 = await submit(vitalsBody(S1, '2026-09-01T08:00:00Z', 70), { 'Idempotency-Key': 'e2e-key-1' });
    ids.v2 = await submit(vitalsBody(S1, '2026-09-08T08:00:00Z', 72));
    ids.v3 = await submit(vitalsBody(S1, '2026-09-15T08:00:00Z', 95));
    ids.v4 = await submit(vitalsBody(S1, '2026-09-15T08:10:00Z', 125)); // minutes after v3 and very different: a discrepancy
    ids.other = await submit(vitalsBody('E2E-SUBJ-TWO', '2026-09-05T08:00:00Z', 80, (r) => { r.subject.identity = { name: 'Identity Zq', email: 'zq@e2e-synthetic.invalid' }; }));
    ids.pSigned = await submit(postureBody('signed')); ids.pUnsigned = await submit(postureBody('unsigned'));
    for (const id of Object.values(ids)) await reportReady(id);
    // idempotent replay: same key and body = the same job, flagged as a replay
    const replay = await tapi('POST', '/v1/interpretations', JSON.parse((await q(`SELECT payload_json FROM source_payloads WHERE job_id = $1`, [ids.v1]))[0].payload_json), { 'Idempotency-Key': 'e2e-key-1' });
    expect([200, 409]).toContain(replay.status);
    expect((await q('SELECT status FROM interpretation_jobs WHERE tenant_id = $1', [tenant.id])).every((r: any) => r.status === 'completed')).toBe(true);
    expect((await reportOf(ids.pUnsigned)).review_state).toBe('awaiting_clinician'); expect((await reportOf(ids.v1)).review_state).toBe('ai_reviewed');
    // identity went to the vault and nowhere else
    expect(JSON.stringify(await q('SELECT * FROM normalized_findings WHERE tenant_id = $1', [tenant.id]))).not.toContain('Identity Zq');
    expect((await q('SELECT 1 FROM identity_vault WHERE job_id = $1', [ids.other])).length).toBe(1);
  }, 120_000);

  it('tenant API: status, findings, both report layers in every format, the report list, timeline and comparison all answer correctly', async () => {
    const job = await (await tapi('GET', `/v1/interpretations/${ids.v1}`)).json(); expect(job).toMatchObject({ id: ids.v1, status: 'completed', skillId: VITALS });
    expect((await (await tapi('GET', `/v1/interpretations/${ids.v1}/findings`)).json()).schemaVersion).toBe('normalized-findings/v1');
    for (const layer of ['clinical', 'layman']) {
      const j = await (await tapi('GET', `/v1/interpretations/${ids.v1}/report?layer=${layer}`)).json(); expect(j).toMatchObject({ layer, version: 1, reviewState: 'ai_reviewed' });
      const h = await tapi('GET', `/v1/interpretations/${ids.v1}/report?layer=${layer}&format=html`); const html = await h.text(); expect(h.status).toBe(200); expect(html).toContain('E2E Health'); expect(html).toContain('AI-reviewed, not reviewed by a clinician'); expect(html).not.toMatch(/<script/i);
      const pdf = await tapi('GET', `/v1/interpretations/${ids.v1}/report?layer=${layer}&format=pdf`); expect(pdf.status).toBe(200); expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    }
    expect((await (await tapi('GET', `/v1/interpretations/${ids.v1}/reports`)).json()).items).toHaveLength(1);
    const tl = await (await tapi('GET', `/v1/interpretations/${ids.v3}/timeline?findingKey=hr_bpm`)).json(); expect(tl.items.map((i: any) => i.jobId)).toEqual([ids.v1, ids.v2, ids.v3, ids.v4]);
    const cmp = await (await tapi('GET', `/v1/interpretations/${ids.v2}/compare?with=${ids.v3}`)).json(); expect(cmp.schemaVersion).toBe('longitudinal-comparison/v1'); expect(JSON.stringify(cmp)).not.toContain('E2E-SUBJ-ONE');
    const disc = await (await tapi('GET', `/v1/interpretations/${ids.v3}/compare?with=${ids.v4}`)).json(); expect(disc.flags.map((f: any) => f.type)).toContain('short_interval_discrepancy');
    // isolation: another tenant's key cannot see any of it
    const other = await dash('admin', 'POST', '/api/v1/admin/tenants', { company_name: 'E2E Other Org', email: 'o@e2e.invalid', plan: 'enterprise' }); expect(other.status).toBe(201);
    await dash('admin', 'PUT', `/api/v1/admin/tenants/${other.body.tenant_id}/skills/${VITALS}`, {});
    for (const pth of [`/v1/interpretations/${ids.v1}`, `/v1/interpretations/${ids.v1}/findings`, `/v1/interpretations/${ids.v1}/report?layer=clinical`, `/v1/interpretations/${ids.v1}/timeline`]) expect((await tapi('GET', pth, undefined, {}, other.body.api_key)).status, pth).toBe(404);
    // the tenant cannot sign, review or reach any dashboard route
    expect((await tapi('POST', `/v1/interpretations/${ids.v1}/report`, { reviewState: 'clinician_signed' })).status).toBe(404);
    expect((await fetch(`${ui}/api/anukla/review/queue`, { headers: { 'x-api-key': tenant.key } })).status).toBe(401);
  }, 120_000);

  // ── 4. the clinician, in the browser ───────────────────────────────────────────────────────

  const optionByText = async (sel: import('playwright-core').Locator, text: RegExp) => { const opts = await sel.locator('option').evaluateAll((os) => os.map((o: any) => ({ v: o.value, t: o.textContent }))); const hit = opts.find((o: any) => text.test(o.t)); if (!hit) throw new Error(`no option ${text}`); return hit.v as string; };

  it('clinician: the queue shows what needs review, in plain words, with the tenant, and nothing identifying', async () => {
    const { ctx, p } = await open('doc');
    try {
      await p.goto(`${ui}/nexarch/anukla/review`); await p.getByRole('heading', { name: 'Clinical review' }).waitFor();
      const awaiting = p.getByRole('row').filter({ hasText: 'AWAITING CLINICIAN' }); await awaiting.first().waitFor(); expect(await awaiting.count()).toBe(1);
      expect(await awaiting.first().textContent()).toContain(tenant.name); expect(await awaiting.first().textContent()).toMatch(/blocking|unverified|data-quality/i);
      expect(await p.getByRole('row').filter({ hasText: 'FOLLOW-UP' }).count()).toBeGreaterThanOrEqual(5);
      expect(await p.content()).not.toMatch(/E2E-SUBJ|Identity Zq|mmHg/); await shot(p, '20-review-queue'); expect(await axe(p, 'review queue')).toEqual([]);
      await p.getByRole('button', { name: 'Awaiting a clinician' }).click(); await p.waitForTimeout(400); expect(await p.getByRole('row').filter({ hasText: 'FOLLOW-UP' }).count()).toBe(0);
    } finally { await ctx.close(); }
  }, 90_000);

  it('clinician: scans over time and a neutral comparison, including the short-interval discrepancy', async () => {
    const r3 = await reportOf(ids.v3); const { ctx, p } = await open('doc');
    try {
      await p.goto(`${ui}/nexarch/anukla/review/${r3.id}`); await p.getByRole('heading', { name: 'Report review' }).waitFor();
      await p.getByRole('link', { name: 'Scans over time' }).click(); await p.getByRole('heading', { name: 'Scans over time' }).waitFor();
      expect(await p.getByRole('row').filter({ hasText: 'THIS SCAN' }).count()).toBe(1); expect(await p.getByRole('row').count()).toBeGreaterThanOrEqual(5); // header + 4 scans of this subject
      expect(await p.content()).not.toMatch(/E2E-SUBJ/);
      const fsel = p.getByLabel('FINDING'); await fsel.selectOption(await optionByText(fsel, /Heart Rate/)); await p.getByText('Step from the previous scan').waitFor();
      const table = p.getByRole('table').filter({ hasText: 'Step from the previous scan' });
      expect(await table.getByRole('row').count()).toBe(5); expect(await table.textContent()).toMatch(/WITHIN UNCERTAINTY/); expect(await table.textContent()).toMatch(/the later value is higher/);
      expect(await p.getByRole('img', { name: /across 4 scans/ }).count()).toBe(1);
      const csel = p.getByLabel('COMPARE THIS SCAN WITH'); const from = (await q('SELECT captured_at FROM interpretation_jobs WHERE id = $1', [ids.v1]))[0].captured_at;
      await csel.selectOption(await optionByText(csel, new RegExp(new Date(from).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))); await p.getByRole('button', { name: 'Compare' }).click();
      await p.getByText(/beyond uncertainty,/).waitFor(); await shot(p, '21-timeline-compare');
      expect(await p.getByRole('row').filter({ hasText: 'Heart Rate' }).textContent()).toMatch(/BEYOND UNCERTAINTY[\s\S]*later value is higher/);
      expect(await p.getByText(/does not say whether a change is an improvement or a deterioration/).count()).toBe(1);
      expect((await p.content()).toLowerCase()).not.toMatch(/improved|worsened|deteriorat(?!ion\b)/);
      expect(await axe(p, 'timeline')).toEqual([]);
      // the 10-minute pair is a discrepancy, not a trend
      await csel.selectOption(await optionByText(csel, new RegExp(new Date((await q('SELECT captured_at FROM interpretation_jobs WHERE id = $1', [ids.v4]))[0].captured_at).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))); await p.getByRole('button', { name: 'Compare' }).click();
      await p.getByRole('note').filter({ hasText: /very close together/ }).waitFor();
      // views are audited (ids only)
      const audit = await q(`SELECT payload::text AS p FROM cds_audit_log_mt WHERE tenant_id = $1 AND event_type IN ('interpretation.timeline_viewed','interpretation.compare_viewed')`, [tenant.id]);
      expect(audit.length).toBeGreaterThanOrEqual(3); expect(audit.every((a: any) => a.p.includes(users.doc.id) && !/Heart|E2E-SUBJ/.test(a.p))).toBe(true);
    } finally { await ctx.close(); }
    // a clinician cannot compare across subjects or tenants; an admin cannot see these values at all
    expect((await dash('doc', 'GET', `/api/anukla/longitudinal/compare?a=${ids.v1}&b=${ids.other}`)).body.code).toBe('different_subjects');
    expect((await dash('doc', 'GET', `/api/anukla/longitudinal/compare?a=${ids.v1}&b=${ids.pSigned}`)).status).toBe(409);
    for (const role of ['admin', 'operator', 'auditor', 'compliance', 'viewer']) expect((await dash(role, 'GET', `/api/anukla/longitudinal/scans/${ids.v1}`)).status, role).toBe(403);
  }, 120_000);

  it('clinician: signs a report in the browser with their password; the tenant sees the signature; the signed version is final', async () => {
    const r1 = await reportOf(ids.v1); const { ctx, p } = await open('doc');
    try {
      await p.goto(`${ui}/nexarch/anukla/review/${r1.id}`); await p.getByRole('heading', { name: 'Report review' }).waitFor();
      await p.locator('iframe[title^="clinical report"]').waitFor(); await p.frameLocator('iframe[title^="clinical report"]').getByRole('heading', { name: 'Referral advisory' }).waitFor();
      await p.getByRole('tab', { name: 'Layman layer' }).click(); await p.frameLocator('iframe[title^="layman report"]').getByText('Please see a doctor').waitFor(); await shot(p, '22-report-review');
      await p.getByRole('button', { name: /Sign this version/ }).click(); const dlg = p.locator('.nx-dialog'); await dlg.getByRole('checkbox').check();
      await dlg.getByLabel('YOUR PASSWORD').fill('wrong'); await dlg.getByRole('button', { name: 'Sign', exact: true }).click(); await dlg.getByText('The password is incorrect.').waitFor();
      expect((await q('SELECT 1 FROM interpretation_reports WHERE job_id = $1', [ids.v1])).length).toBe(1);
      await dlg.getByLabel('YOUR PASSWORD').fill(PW); await dlg.getByRole('button', { name: 'Sign', exact: true }).click(); await p.getByText(/Signed\. A new version \(v2\)/).waitFor();
    } finally { await ctx.close(); }
    const j = await (await tapi('GET', `/v1/interpretations/${ids.v1}/report?layer=layman`)).json(); expect(j).toMatchObject({ version: 2, reviewState: 'clinician_signed' }); expect(j.statusBanner).toMatch(/^Signed by Dr E2E Clinician, \d{4}-\d\d-\d\d\.$/);
    expect((await tapi('GET', `/v1/interpretations/${ids.v1}/report?layer=clinical&format=html`).then((r) => r.text()))).toContain('Signed by Dr E2E Clinician');
    const again = await dash('doc', 'POST', `/api/anukla/review/reports/${(await reportOf(ids.v1)).id}/sign`, { contentSha256: j.contentSha256, attested: true, password: PW }); expect(again.status).toBe(409);
  }, 120_000);

  it('clinician: rejects a report, asks for a replacement, and the real workers produce it; the tenant never sees a gap', async () => {
    const r2 = await reportOf(ids.v2); const { ctx, p } = await open('doc');
    try {
      await p.goto(`${ui}/nexarch/anukla/review/${r2.id}`); await p.getByRole('heading', { name: 'Report review' }).waitFor();
      await p.getByRole('button', { name: /Reject/ }).click(); const dlg = p.locator('.nx-dialog'); await dlg.getByLabel('REASON (1-500 CHARACTERS)').fill('Re-run with current settings'); await dlg.getByLabel('YOUR PASSWORD').fill(PW);
      await dlg.getByRole('button', { name: 'Reject', exact: true }).click(); await p.getByText(/Rejected\. The tenant now sees/).waitFor();
      expect((await (await tapi('GET', `/v1/interpretations/${ids.v2}/report?layer=layman`)).json()).statusBanner).toMatch(/rejected this version/);
      await p.getByRole('button', { name: /Request a replacement version/ }).click(); await p.locator('.nx-dialog').getByRole('button', { name: 'Request', exact: true }).click(); await p.getByText(/A replacement version \(v2\) was queued/).waitFor();
    } finally { await ctx.close(); }
    await until(async () => (await q(`SELECT 1 FROM interpretation_reports WHERE job_id = $1 AND version = 2 AND status = 'ready'`, [ids.v2])).length > 0, 'replacement report');
    expect((await q('SELECT version, status, review_state FROM interpretation_reports WHERE job_id = $1 ORDER BY version', [ids.v2]))).toEqual([{ version: 1, status: 'superseded', review_state: 'rejected' }, { version: 2, status: 'ready', review_state: 'ai_reviewed' }]);
    expect(await (await tapi('GET', `/v1/interpretations/${ids.v2}/report?layer=clinical`)).json()).toMatchObject({ version: 2, reviewState: 'ai_reviewed' });
    const { ctx: c2, p: p2 } = await open('doc');
    try { await p2.goto(`${ui}/nexarch/anukla/review/${(await reportOf(ids.v2)).id}`); await p2.getByRole('heading', { name: 'Report review' }).waitFor(); await p2.getByText(/v1 — superseded, rejected/).waitFor(); await shot(p2, '23-report-versions'); } finally { await c2.close(); }
  }, 120_000);

  // ── 5. the landing page tiles, by role ─────────────────────────────────────────────────────

  it('landing page: each role sees exactly the interpretation tiles it may see, with the real numbers', async () => {
    const count = async (sql: string) => Number((await q(sql))[0].n);
    const queued = await count(`SELECT COUNT(*)::int AS n FROM interpretation_jobs WHERE status = 'queued'`); const failed = await count(`SELECT COUNT(*)::int AS n FROM interpretation_jobs WHERE status = 'failed'`);
    const awaitingClinician = await count(`SELECT COUNT(*)::int AS n FROM interpretation_reports WHERE status = 'ready' AND review_state = 'awaiting_clinician'`);
    const expectTiles: Record<string, { ops: boolean; review: boolean }> = { admin: { ops: true, review: true }, operator: { ops: true, review: false }, auditor: { ops: true, review: false }, compliance: { ops: true, review: false }, doc: { ops: false, review: true }, viewer: { ops: false, review: false } };
    for (const [role, want] of Object.entries(expectTiles)) {
      const { ctx, p } = await open(role);
      try {
        await p.goto(`${ui}/nexarch`); await p.getByRole('heading', { name: 'Overview', level: 1 }).waitFor({ state: 'attached' }); await p.waitForTimeout(1200);
        const sec = p.getByRole('region', { name: 'Interpretation' });
        if (!want.ops && !want.review) { expect(await sec.count(), role).toBe(0); continue; }
        await sec.waitFor();
        expect(await sec.getByRole('link', { name: /^Jobs queued/ }).count(), `${role} ops`).toBe(want.ops ? 1 : 0);
        expect(await sec.getByRole('link', { name: /^Reports awaiting a clinician/ }).count(), `${role} review`).toBe(want.review ? 1 : 0);
        if (want.ops) { expect(await sec.getByRole('link', { name: /^Jobs queued/ }).getAttribute('aria-label')).toBe(`Jobs queued: ${queued}`); expect(await sec.getByRole('link', { name: /^Jobs failed/ }).getAttribute('aria-label')).toBe(`Jobs failed: ${failed}`); }
        if (want.review) expect(await sec.getByRole('link', { name: /^Reports awaiting a clinician/ }).getAttribute('aria-label')).toBe(`Reports awaiting a clinician: ${awaitingClinician}`);
        if (role === 'admin') { await shot(p, '30-landing-admin'); await sec.getByRole('link', { name: /^Jobs failed/ }).click(); await p.getByRole('heading', { name: 'Operations' }).waitFor(); }
        if (role === 'doc') { await sec.getByRole('link', { name: /^Reports awaiting a clinician/ }).click(); await p.getByRole('heading', { name: 'Clinical review' }).waitFor(); }
      } finally { await ctx.close(); }
    }
  }, 180_000);

  // ── 6. operations ──────────────────────────────────────────────────────────────────────────

  it('operations: failures, retries, the webhook log, spend and the audit check, with the real workers finishing the retried work', async () => {
    await q(`INSERT INTO tenant_webhooks (tenant_id, url, secret_kid, secret_sealed, enabled, created_at, updated_at, secret_rotated_at) VALUES ($1,'https://hooks.e2e-synthetic.invalid/h?t=SECRET-ZQ','k','sealed-zq',TRUE,1,1,2) ON CONFLICT DO NOTHING`, [tenant.id]);
    ids.f1 = await submit(vitalsBody('E2E-SUBJ-OPS', '2026-10-01T08:00:00Z', 70)); ids.f2 = await submit(vitalsBody('E2E-SUBJ-OPS', '2026-10-02T08:00:00Z', 71));
    await reportReady(ids.f1); await reportReady(ids.f2);
    // A job that really failed never reached completion: no findings, no report, no events. Reproduce that state, then fail it.
    await q('DELETE FROM interpretation_reports WHERE job_id = $1', [ids.f1]); await q('DELETE FROM normalized_findings WHERE job_id = $1', [ids.f1]); await q('DELETE FROM webhook_deliveries WHERE job_id = $1', [ids.f1]);
    await q(`UPDATE interpretation_jobs SET status = 'failed', error_code = 'adapter_error', attempts = 5, findings_sha256 = NULL, completed_at = NULL, adapter_id = NULL, adapter_version = NULL WHERE id = $1`, [ids.f1]);
    ids.f3 = await submit(vitalsBody('E2E-SUBJ-OPS', '2026-10-03T08:00:00Z', 72)); await until(async () => (await q(`SELECT 1 FROM interpretation_jobs WHERE id = $1 AND status = 'completed'`, [ids.f3])).length > 0, 'job f3');
    const dead = (await q(`SELECT id FROM webhook_deliveries WHERE job_id = $1 LIMIT 1`, [ids.f2]))[0]?.id ?? (await q(`SELECT id FROM webhook_deliveries WHERE tenant_id = $1 LIMIT 1`, [tenant.id]))[0].id;
    await q(`UPDATE webhook_deliveries SET status = 'dead', attempts = 6, last_error = 'http_500', dead_at = 5 WHERE id = $1`, [dead]);
    await q(`INSERT INTO model_spend_ledger (id, scope_kind, scope_id, period, role, model, data_class, state, reserved_usd, actual_usd, attempts, created_at) VALUES ($1,'tenant',$2,$3,'review','google/gemini-4-hydrogen','synthetic_test','unknown_cost',0.02,NULL,1,$4)`, [`sp-${crypto.randomBytes(5).toString('hex')}`, tenant.id, new Date().toISOString().slice(0, 10), Date.now()]);
    const OPS = `${ui}/nexarch/anukla/operations`;
    const { ctx, p } = await open('operator');
    try {
      await p.goto(OPS); await p.getByRole('heading', { name: 'Operations' }).waitFor(); await p.getByText('adapter_error').waitFor(); await shot(p, '40-ops-overview'); expect(await axe(p, 'ops overview')).toEqual([]);
      await p.getByRole('tab', { name: 'Processing history' }).click(); await p.getByRole('combobox', { name: 'STATUS' }).selectOption('failed');
      await p.getByRole('button', { name: `Details for job ${ids.f1}` }).click(); const dr = p.locator('aside.nx-drawer'); await dr.getByRole('button', { name: 'Retry this job' }).click(); await dr.getByText('Job re-queued.').waitFor(); await shot(p, '41-ops-job-drawer');
      await until(async () => (await q(`SELECT 1 FROM interpretation_jobs WHERE id = $1 AND status = 'completed'`, [ids.f1])).length > 0, 'retried job completes'); await p.keyboard.press('Escape');
      await p.getByRole('tab', { name: 'Webhook log' }).click(); await p.getByText('https://hooks.e2e-synthetic.invalid', { exact: true }).waitFor(); expect(await p.content()).not.toMatch(/SECRET-ZQ|sealed-zq/);
      await p.getByRole('combobox', { name: 'STATUS' }).selectOption('dead'); await p.getByRole('button', { name: `Send again: delivery ${dead}` }).click(); await p.getByText('Delivery queued again.').waitFor(); await shot(p, '42-ops-webhooks');
      expect((await q('SELECT status FROM webhook_deliveries WHERE id = $1', [dead]))[0].status).toBe('pending');
      await p.getByRole('tab', { name: 'Usage and spend' }).click(); await p.getByRole('row').filter({ hasText: tenant.name }).waitFor(); await p.getByText(/a lower bound/).waitFor(); await shot(p, '43-ops-usage');
      expect(await p.getByRole('tab', { name: 'Audit check' }).count()).toBe(0);
    } finally { await ctx.close(); }
    const a = await open('auditor');
    try {
      await a.p.goto(OPS); await a.p.getByRole('tab', { name: 'Audit check' }).click(); await a.p.getByRole('button', { name: 'Verify all tenants' }).click(); await a.p.getByText(/CHAINS INTACT/).waitFor(); await shot(a.p, '44-ops-audit');
      await a.p.getByRole('tab', { name: 'Processing history' }).click(); await a.p.getByRole('button', { name: /^Details for job/ }).first().click(); expect(await a.p.locator('aside.nx-drawer').getByRole('button', { name: /^Retry/ }).count()).toBe(0);
    } finally { await a.ctx.close(); }
  }, 180_000);

  // ── 7. skill registry, gating and suspension ───────────────────────────────────────────────

  it('administrator: switching a skill off stops the tenant using it, on restores it; suspending a tenant stops every key', async () => {
    const { ctx, p } = await open('admin');
    try {
      await p.goto(`${ui}/nexarch/anukla/skills`); await p.getByRole('heading', { name: 'Skill registry' }).waitFor(); await shot(p, '50-skill-registry'); expect(await axe(p, 'skill registry')).toEqual([]);
      await p.getByRole('button', { name: 'Switch off Physiological Signal Interpretation' }).click(); await p.getByRole('button', { name: 'Switch on Physiological Signal Interpretation' }).waitFor();
      const off = await tapi('POST', '/v1/interpretations', vitalsBody('E2E-GATE', '2026-10-05T08:00:00Z', 70)); expect(off.status).toBe(403);
      await p.getByRole('button', { name: 'Switch on Physiological Signal Interpretation' }).click(); await p.getByRole('button', { name: 'Switch off Physiological Signal Interpretation' }).waitFor();
      expect((await tapi('POST', '/v1/interpretations', vitalsBody('E2E-GATE', '2026-10-05T08:00:00Z', 70))).status).toBe(202);
      await p.goto(`${ui}/nexarch/anukla/tenants/${tenant.id}`); await p.getByRole('heading', { name: tenant.name }).waitFor();
      await p.getByRole('button', { name: 'Suspend tenant…' }).click(); await p.locator('.nx-dialog').getByRole('button', { name: 'Suspend', exact: true }).click(); await p.getByText('Tenant suspended.').waitFor();
      expect((await tapi('GET', '/v1/interpretations')).status).toBeGreaterThanOrEqual(401); expect((await tapi('POST', '/v1/interpretations', vitalsBody('E2E-GATE2', '2026-10-06T08:00:00Z', 70))).status).toBeGreaterThanOrEqual(401);
      await p.getByRole('button', { name: 'Reactivate tenant' }).click(); await p.getByText('Tenant reactivated.').waitFor(); expect((await tapi('GET', '/v1/interpretations')).status).toBe(200);
      // every one of those changes is in the tenant's audit chain, under this administrator
      const audit = await (await fetch(`${api}/api/v1/admin/tenants/${tenant.id}/audit`, { headers: { 'x-admin-key': process.env.ADMIN_API_KEY! } })).json();
      expect(audit.chain.valid).toBe(true); const types = audit.entries.map((e: any) => e.event_type);
      for (const t of ['tenant.created', 'tenant.key.created', 'tenant.key.revoked', 'tenant.branding_updated', 'tenant.suspended', 'tenant.reactivated']) expect(types.some((x: string) => x.startsWith(t.replace('tenant.suspended', 'tenant.status')) || x === t), t).toBe(true);
      expect(audit.entries.filter((e: any) => /^tenant\./.test(e.event_type)).every((e: any) => e.actor === `dashboard:${users.admin.id}`)).toBe(true);
    } finally { await ctx.close(); }
  }, 120_000);

  it('clinician: a comparison or timeline never crosses tenants, in either direction, even for the same subject reference', async () => {
    const t2 = await dash('admin', 'POST', '/api/v1/admin/tenants', { company_name: 'E2E Third Org', email: 't@e2e.invalid', plan: 'enterprise' }); expect(t2.status).toBe(201);
    await dash('admin', 'PUT', `/api/v1/admin/tenants/${t2.body.tenant_id}/skills/${VITALS}`, {});
    const jid = await submit(vitalsBody('E2E-SUBJ-ONE', '2026-09-20T08:00:00Z', 70), {}).catch(() => ''); void jid; // (own tenant, same subject reference)
    const r = await fetch(`${api}/v1/interpretations`, { method: 'POST', headers: { 'x-api-key': t2.body.api_key, 'content-type': 'application/json' }, body: JSON.stringify(vitalsBody('E2E-SUBJ-ONE', '2026-09-20T08:00:00Z', 70)) }); const theirs = (await r.json()).id as string;
    await until(async () => (await q(`SELECT 1 FROM interpretation_jobs WHERE id = $1 AND status = 'completed'`, [theirs])).length > 0, 'other tenant job');
    expect((await dash('doc', 'GET', `/api/anukla/longitudinal/compare?a=${ids.v1}&b=${theirs}`)).status).toBe(404);
    expect((await dash('doc', 'GET', `/api/anukla/longitudinal/compare?a=${theirs}&b=${ids.v1}`)).status).toBe(404);
    const tl = (await dash('doc', 'GET', `/api/anukla/longitudinal/scans/${theirs}`)).body; expect(tl.items.map((i: any) => i.jobId)).toEqual([theirs]);
    expect((await dash('doc', 'GET', `/api/anukla/longitudinal/scans/${ids.v1}`)).body.items.map((i: any) => i.jobId)).not.toContain(theirs);
  }, 120_000);

  // ── 8. every API, by every role ────────────────────────────────────────────────────────────

  it('access control: every dashboard API answers each role exactly as designed (and nobody anonymous)', async () => {
    const reportId = (await reportOf(ids.v3)).id; const dlv = (await q('SELECT id FROM webhook_deliveries LIMIT 1'))[0].id;
    const ALL = ['admin', 'operator', 'auditor', 'compliance', 'doc', 'viewer'];
    const rows: Array<[string, string, string[], unknown?]> = [
      ['GET', '/api/v1/admin/tenants', ['admin', 'auditor', 'compliance']], ['GET', `/api/v1/admin/tenants/${tenant.id}`, ['admin', 'auditor', 'compliance']], ['GET', `/api/v1/admin/tenants/${tenant.id}/keys`, ['admin', 'auditor', 'compliance']],
      ['GET', `/api/v1/admin/tenants/${tenant.id}/skills`, ['admin', 'auditor', 'compliance']], ['GET', `/api/v1/admin/tenants/${tenant.id}/branding`, ['admin', 'auditor', 'compliance']], ['GET', `/api/v1/admin/tenants/${tenant.id}/audit`, ['admin', 'auditor', 'compliance']],
      ['GET', '/api/v1/admin/skills', ['admin', 'auditor', 'compliance']], ['GET', '/api/v1/admin/adapters', ['admin', 'auditor', 'compliance']], ['GET', '/api/v1/admin/narrative-models', ['admin', 'auditor', 'compliance']],
      ['GET', '/api/anukla/ops/overview', ['admin', 'operator', 'auditor', 'compliance']], ['GET', '/api/anukla/ops/jobs', ['admin', 'operator', 'auditor', 'compliance']], ['GET', `/api/anukla/ops/jobs/${ids.v3}`, ['admin', 'operator', 'auditor', 'compliance']],
      ['GET', '/api/anukla/ops/webhooks/deliveries', ['admin', 'operator', 'auditor', 'compliance']], ['GET', '/api/anukla/ops/webhooks/endpoints', ['admin', 'operator', 'auditor', 'compliance']], ['GET', '/api/anukla/ops/usage', ['admin', 'operator', 'auditor', 'compliance']],
      ['GET', '/api/anukla/ops/audit/verify', ['admin', 'auditor', 'compliance']],
      ['GET', '/api/anukla/review/queue', ['admin', 'doc']], ['GET', `/api/anukla/review/reports/${reportId}`, ['doc']], ['GET', `/api/anukla/review/reports/${reportId}/html?layer=clinical`, ['doc']],
      ['GET', `/api/anukla/longitudinal/scans/${ids.v3}`, ['doc']], ['GET', `/api/anukla/longitudinal/compare?a=${ids.v2}&b=${ids.v3}`, ['doc']],
    ];
    for (const [m, pth, allowed] of rows) {
      expect((await fetch(`${ui}${pth}`, { method: m })).status, `anonymous ${m} ${pth}`).toBe(401);
      for (const role of ALL) { const st = (await dash(role, m, pth)).status; expect(allowed.includes(role) ? st < 300 || st === 409 : st === 403, `${role} ${m} ${pth} -> ${st}`).toBe(true); }
    }
    // changes: only the roles meant to make them get past the gate (a harmless or invalid body is used: the gate is what is tested)
    const writes: Array<[string, string, string[], unknown]> = [
      ['PUT', `/api/v1/admin/tenants/${tenant.id}/plan`, ['admin'], { plan: 'bogus' }], ['POST', `/api/v1/admin/tenants/${tenant.id}/keys/nope-nope/revoke`, ['admin'], { reason: 'x' }],
      ['POST', `/api/anukla/ops/jobs/${ids.v3}/retry`, ['admin', 'operator'], {}], ['POST', `/api/anukla/ops/reports/rpt_${'0'.repeat(24)}/retry`, ['admin', 'operator'], {}], ['POST', `/api/anukla/ops/webhooks/deliveries/${dlv}/redeliver`, ['admin', 'operator'], {}],
      ['POST', `/api/anukla/review/reports/${reportId}/sign`, ['doc'], {}], ['POST', `/api/anukla/review/reports/${reportId}/reject`, ['doc'], {}], ['POST', `/api/anukla/review/reports/${reportId}/regenerate`, ['admin', 'doc'], {}],
    ];
    for (const [m, pth, allowed, body] of writes) for (const role of ALL) { const st = (await dash(role, m, pth, body)).status; expect(allowed.includes(role) ? st !== 403 && st !== 401 : st === 403, `${role} ${m} ${pth} -> ${st}`).toBe(true); }
    expect((await q(`SELECT 1 FROM interpretation_reports WHERE job_id = $1 AND review_state = 'clinician_signed'`, [ids.v3])).length).toBe(0); // none of that signed anything
  }, 180_000);

  it('tenant API: validation, limits and abuse controls refuse bad input with clear errors and never a stack trace', async () => {
    const bad = async (r: Response, status: number, code?: string) => { expect(r.status).toBe(status); const t = await r.text(); expect(t).not.toMatch(/at \S+ \(|node_modules|stack/i); if (code) expect(JSON.parse(t).error.code ?? JSON.parse(t).error).toBe(code); };
    await bad(await fetch(`${api}/v1/interpretations`, { method: 'POST', headers: { 'x-api-key': tenant.key, 'content-type': 'application/json' }, body: '{not json' }), 400, 'invalid_json');
    await bad(await tapi('POST', '/v1/interpretations', {}), 400); await bad(await tapi('POST', '/v1/interpretations', { ...vitalsBody('E2E-X', '2026-10-09T08:00:00Z', 70), skillId: 'no-such-skill' }), 403);
    await bad(await tapi('POST', '/v1/interpretations', { ...vitalsBody('E2E-X', '2026-10-09T08:00:00Z', 70), extraneous: 1 }), 400);
    await bad(await tapi('POST', '/v1/interpretations', vitalsBody('E2E-X', '2026-10-09T08:00:00Z', 70), { 'Idempotency-Key': 'bad key with spaces' }), 400);
    const k = `e2e-${crypto.randomBytes(4).toString('hex')}`; const first = await tapi('POST', '/v1/interpretations', vitalsBody('E2E-IDEM', '2026-10-09T08:00:00Z', 70), { 'Idempotency-Key': k }); expect(first.status).toBe(202);
    await bad(await tapi('POST', '/v1/interpretations', vitalsBody('E2E-IDEM', '2026-10-09T08:00:00Z', 99), { 'Idempotency-Key': k }), 409); // same key, different body
    await bad(await fetch(`${api}/v1/interpretations`, { method: 'POST', headers: { 'x-api-key': tenant.key, 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024) }) }), 413);
    for (const pth of ['/v1/interpretations/job_nope', '/v1/interpretations/job_000000000000000000000000/findings']) await bad(await tapi('GET', pth), 404);
    await bad(await tapi('GET', `/v1/interpretations/${ids.v1}/report`), 400); await bad(await tapi('GET', `/v1/interpretations/${ids.v1}/report?layer=clinical&format=docx`), 400);
    await bad(await tapi('GET', `/v1/interpretations/${ids.v1}/compare`), 400); await bad(await tapi('GET', `/v1/interpretations/${ids.v1}/compare?with=${ids.v1}`), 400); await bad(await tapi('GET', `/v1/interpretations/${ids.v1}/compare?with=${ids.pSigned}`), 409);
    await bad(await tapi('POST', '/v1/subject-erasures', { externalRef: 'x' }), 400, 'confirmation_required');
    for (const url of ['http://hooks.example.com/h', 'https://127.0.0.1/h', 'https://localhost/h', 'https://user:pw@hooks.example.com/h', 'https://169.254.169.254/latest']) { const r = await tapi('PUT', '/api/v1/account/webhook', { url }); expect(r.status, url).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500); }
    expect((await tapi('GET', '/api/v1/account')).status).toBe(200); expect((await tapi('GET', '/v1/interpretations?limit=2')).status).toBe(200);
    expect((await (await tapi('GET', '/v1/interpretations?limit=2')).json()).items).toHaveLength(2);
    expect((await fetch(`${api}/v1/interpretations`, { headers: { 'x-api-key': 'amgi_live_' + 'f'.repeat(56) } })).status).toBe(401);
  }, 120_000);

  // ── 9. every page: access, accessibility, small screens, no console errors ──────────────────

  it('every page: viewers are refused politely; permitted pages have no accessibility problems, no console errors and no sideways scrolling on a phone', async () => {
    const reportId = (await reportOf(ids.v3)).id;
    const pages: Array<{ role: string; name: string; url: string; ready: string; tabs?: string[] }> = [
      { role: 'admin', name: 'tenants', url: '/nexarch/anukla/tenants', ready: 'Tenants' },
      { role: 'admin', name: 'tenant', url: `/nexarch/anukla/tenants/${tenant.id}`, ready: tenant.name, tabs: ['API keys', 'Skills and narrative', 'Report branding', 'Audit trail'] },
      { role: 'admin', name: 'skills', url: '/nexarch/anukla/skills', ready: 'Skill registry' },
      { role: 'operator', name: 'operations', url: '/nexarch/anukla/operations', ready: 'Operations', tabs: ['Processing history', 'Webhook log', 'Usage and spend'] },
      { role: 'auditor', name: 'audit', url: '/nexarch/anukla/operations', ready: 'Operations', tabs: ['Audit check'] },
      { role: 'doc', name: 'queue', url: '/nexarch/anukla/review', ready: 'Clinical review' },
      { role: 'doc', name: 'report', url: `/nexarch/anukla/review/${reportId}`, ready: 'Report review' },
      { role: 'doc', name: 'timeline', url: `/nexarch/anukla/timeline/${ids.v3}`, ready: 'Scans over time' },
    ];
    const problems: string[] = [];
    for (const width of [1280, 390]) for (const pg of pages) {
      const { ctx, p } = await open(pg.role, { width, height: width > 600 ? 900 : 800 });
      const errs: string[] = []; p.on('pageerror', (e) => errs.push(`pageerror ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error') errs.push(`console ${m.text()}`); });
      try {
        await p.goto(`${ui}${pg.url}`); await p.getByRole('heading', { name: pg.ready, level: 1 }).waitFor({ timeout: 15000 });
        for (const t of [undefined, ...(pg.tabs ?? [])]) {
          if (t) await p.getByRole('tab', { name: t }).click(); await p.waitForTimeout(500);
          if (!(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))) problems.push(`${pg.name}/${t ?? 'main'} @${width}: sideways scroll`);
          problems.push(...(await axe(p, `${pg.name}/${t ?? 'main'} @${width}`)));
          await shot(p, `60-${pg.name}${t ? `-${t.replace(/\W+/g, '-').toLowerCase()}` : ''}-${width}`);
        }
        problems.push(...errs.map((e) => `${pg.name} @${width}: ${e}`));
      } finally { await ctx.close(); }
    }
    expect(problems).toEqual([]);
    // a viewer reaches none of these: no navigation entries, and a clear message instead of data
    const v = await open('viewer');
    try {
      await v.p.goto(`${ui}/nexarch`); await v.p.getByRole('navigation', { name: 'Primary' }).waitFor();
      expect(await v.p.getByRole('link', { name: /Clinical review|Tenants|Operations|Skill registry/ }).count()).toBe(0);
      for (const pg of pages) { await v.p.goto(`${ui}${pg.url}`); await v.p.waitForTimeout(900); expect(await v.p.getByRole('alert').first().textContent().catch(() => ''), pg.name).toMatch(/Insufficient permissions|clinician is required/); expect(await v.p.locator('iframe').count()).toBe(0); }
    } finally { await v.ctx.close(); }
  }, 600_000);

  // ── 10. erasure, end to end ────────────────────────────────────────────────────────────────

  it('erasure: the subject disappears from the API, the database and every screen; the audit trail keeps only ids and hashes', async () => {
    const rid = (await reportOf(ids.other)).id; const OPS = `${ui}/nexarch/anukla/operations`;
    expect((await dash('doc', 'GET', `/api/anukla/review/reports/${rid}`)).status).toBe(200);
    const er = await tapi('POST', '/v1/subject-erasures', { externalRef: 'E2E-SUBJ-TWO', confirm: true, reason: 'subject_request' }); expect(er.status).toBe(200); expect(await er.json()).toMatchObject({ jobsErased: 1, identitiesDeleted: 1, findingsDeleted: 1, reportsDeleted: 1 });
    for (const pth of [`/v1/interpretations/${ids.other}/findings`, `/v1/interpretations/${ids.other}/report?layer=clinical`, `/v1/interpretations/${ids.other}/timeline`]) expect((await tapi('GET', pth)).status, pth).toBe(410);
    expect((await dash('doc', 'GET', `/api/anukla/review/reports/${rid}`)).status).toBe(404); expect((await dash('doc', 'GET', `/api/anukla/longitudinal/scans/${ids.other}`)).status).toBe(410);
    expect((await dash('doc', 'GET', '/api/anukla/review/queue?limit=100')).body.items.some((i: any) => i.jobId === ids.other)).toBe(false);
    const tables = (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).map((r: any) => r.table_name as string);
    for (const marker of ['Identity Zq', 'zq@e2e-synthetic.invalid', 'E2E-SUBJ-TWO']) for (const t of tables) expect((await q(`SELECT 1 FROM "${t}" x WHERE x::text LIKE $1 LIMIT 1`, [`%${marker}%`])).length, `${marker} in ${t}`).toBe(0);
    const { ctx, p } = await open('operator');
    try {
      await p.goto(OPS); await p.getByRole('tab', { name: 'Processing history' }).click(); await p.getByRole('combobox', { name: 'STATUS' }).selectOption('erased'); await p.getByRole('button', { name: `Details for job ${ids.other}` }).click();
      await p.locator('aside.nx-drawer').getByText('ERASED').first().waitFor(); expect(await p.content()).not.toMatch(/E2E-SUBJ-TWO|Identity Zq/);
    } finally { await ctx.close(); }
    const chain = (await (await fetch(`${api}/api/v1/admin/tenants/${tenant.id}/audit`, { headers: { 'x-admin-key': process.env.ADMIN_API_KEY! } })).json()); expect(chain.chain.valid).toBe(true);
    expect(JSON.stringify(chain.entries.filter((e: any) => e.event_type === 'subject.erased'))).not.toMatch(/E2E-SUBJ-TWO|Identity Zq/);
  }, 180_000);

  // ── 11. tampering is caught ────────────────────────────────────────────────────────────────

  it('tamper evidence: altering one audit entry is reported by the audit check, naming the tenant and the entry', async () => {
    const seq = (await q(`SELECT seq FROM cds_audit_log_mt WHERE tenant_id = $1 ORDER BY seq LIMIT 1 OFFSET 3`, [tenant.id]))[0].seq;
    await q('ALTER TABLE cds_audit_log_mt DISABLE TRIGGER USER');
    try {
      await q(`UPDATE cds_audit_log_mt SET actor = 'attacker' WHERE tenant_id = $1 AND seq = $2`, [tenant.id, seq]);
      const { ctx, p } = await open('compliance');
      try {
        await p.goto(`${ui}/nexarch/anukla/operations`); await p.getByRole('tab', { name: 'Audit check' }).click(); await p.getByRole('button', { name: 'Verify all tenants' }).click();
        await p.getByText('BROKEN CHAIN FOUND').waitFor(); await p.getByText(new RegExp(`BROKEN AT ENTRY ${seq}`)).waitFor(); await shot(p, '70-audit-broken');
        expect(await p.getByRole('row').filter({ hasText: tenant.name }).textContent()).toMatch(/BROKEN/); expect(await axe(p, 'audit broken')).toEqual([]);
        await p.goto(`${ui}/nexarch/anukla/tenants/${tenant.id}`); await p.getByRole('tab', { name: 'Audit trail' }).click(); await p.getByText(/CHAIN BROKEN AT ENTRY/).waitFor();
      } finally { await ctx.close(); }
    } finally { await q('ALTER TABLE cds_audit_log_mt ENABLE TRIGGER USER'); }
  }, 120_000);
});
