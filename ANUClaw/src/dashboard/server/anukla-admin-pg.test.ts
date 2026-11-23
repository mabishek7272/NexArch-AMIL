/**
 * Dashboard administration of tenants, keys, skills, narrative settings and branding (interpretation engine, P6b) against REAL
 * PostgreSQL (disposable database; opt-in via ANUCLAW_TEST_PG_URL) over the real HTTP layer with real cookie sessions.
 * Synthetic data only. No model is called.
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
const PP_SECRET = 'import-secret-'.padEnd(40, 'z');

describe.skipIf(!URL_)('dashboard administration of the interpretation engine (real PostgreSQL)', () => {
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
    const dashRouter = express.Router(); (await import('./routes/anukla-admin')).mountAnuklaAdmin(dashRouter);
    app.use('/dash', (await import('cookie-parser')).default(), dashRouter);
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
  const ROLES = ['admin', 'auditor', 'compliance', 'operator', 'viewer', 'clinician'];
  const dash = (who: string | null, method: string, p: string, body?: unknown, extra: Record<string, string> = {}) => fetch(`${base}/dash${p}`, { method, headers: { ...(who ? { cookie: cookie[who] } : {}), 'content-type': 'application/json', ...extra }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
  let T: { id: string; key: string };

  it('setup: one dashboard user per role, with real sessions', async () => {
    const auth = await import('./auth'); const pw = await import('../../security/password');
    for (const role of ROLES) {
      uid[role] = `u-${crypto.randomBytes(5).toString('hex')}`;
      await q(`INSERT INTO dash_users (id, email, name, role, password_hash, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [uid[role], `${uid[role]}@clinic-synthetic.invalid`, role, role, await pw.hashPassword(PW), Date.now()]);
      cookie[role] = `dash_token=${(await auth.issueTokens(uid[role])).accessToken}`;
    }
    expect(Object.keys(cookie)).toHaveLength(6);
    expect(process.env.ADMIN_API_KEY).toBeUndefined(); // the dashboard never needs the shared key
  });

  // ── access ─────────────────────────────────────────────────────────────────────────────────

  it('every route needs a dashboard session; a tenant API key or the admin key header is not one', async () => {
    for (const [m, p] of [['GET', '/api/v1/admin/tenants'], ['POST', '/api/v1/admin/tenants'], ['GET', `/api/v1/admin/tenants/${tenant.id}`], ['PUT', `/api/v1/admin/tenants/${tenant.id}/plan`], ['GET', `/api/v1/admin/tenants/${tenant.id}/keys`], ['GET', '/api/v1/admin/skills'], ['GET', '/api/v1/admin/narrative-models'], ['PUT', `/api/v1/admin/tenants/${tenant.id}/branding`], ['GET', `/api/v1/admin/tenants/${tenant.id}/audit`]]) {
      expect((await dash(null, m, p, {})).status, `${m} ${p}`).toBe(401);
      expect((await dash(null, m, p, {}, { 'x-api-key': tenant.key })).status, `key ${m} ${p}`).toBe(401);
      expect((await dash(null, m, p, {}, { 'x-admin-key': ADMIN })).status, `admin key ${m} ${p}`).toBe(401);
    }
  });

  it('roles: admin may change things; auditor and compliance may only read; operator, viewer and clinician may not even read', async () => {
    const reads = ['/api/v1/admin/tenants', `/api/v1/admin/tenants/${tenant.id}`, `/api/v1/admin/tenants/${tenant.id}/keys`, '/api/v1/admin/skills', `/api/v1/admin/tenants/${tenant.id}/skills`, `/api/v1/admin/tenants/${tenant.id}/branding`, `/api/v1/admin/tenants/${tenant.id}/audit`, '/api/v1/admin/narrative-models'];
    const writes: Array<[string, string, unknown]> = [['POST', '/api/v1/admin/tenants', { company_name: 'X Ltd', email: 'x@synthetic.invalid' }], ['POST', `/api/v1/admin/tenants/${tenant.id}/suspend`, {}], ['PUT', `/api/v1/admin/tenants/${tenant.id}/plan`, { plan: 'enterprise' }],
      ['POST', `/api/v1/admin/tenants/${tenant.id}/keys`, { label: 'x' }], ['PUT', `/api/v1/admin/tenants/${tenant.id}/skills/${VITALS}`, {}], ['DELETE', `/api/v1/admin/tenants/${tenant.id}/skills/${VITALS}`], ['PUT', `/api/v1/admin/tenants/${tenant.id}/branding`, { productName: 'X' }], ['DELETE', `/api/v1/admin/tenants/${tenant.id}/branding`]];
    for (const role of ['auditor', 'compliance', 'admin']) for (const p of reads) expect((await dash(role, 'GET', p)).status, `${role} GET ${p}`).toBe(200);
    for (const role of ['operator', 'viewer', 'clinician']) for (const p of reads) { const r = await dash(role, 'GET', p); expect(r.status, `${role} GET ${p}`).toBe(403); expect((await r.json()).code).toBe('forbidden'); }
    for (const role of ['auditor', 'compliance', 'operator', 'viewer', 'clinician']) for (const [m, p, b] of writes) expect((await dash(role, m, p, b)).status, `${role} ${m} ${p}`).toBe(403);
    // nothing changed
    expect((await q('SELECT status, plan FROM tenants WHERE tenant_id = $1', [tenant.id]))[0]).toMatchObject({ status: 'active', plan: 'enterprise' });
    expect(await q(`SELECT 1 FROM tenants WHERE company_name = 'X Ltd'`)).toHaveLength(0);
  });

  // ── tenants and keys ───────────────────────────────────────────────────────────────────────

  it('an administrator creates a tenant: the key is shown once, never listed again, and the audit entry names the verified person', async () => {
    const res = await dash('admin', 'POST', '/api/v1/admin/tenants', { company_name: 'Dash Created Ltd', email: 'ops@dash-created.invalid', plan: 'enterprise' }, { 'x-admin-actor': 'someone-else', 'x-admin-key': 'ignored' });
    const t = await res.json(); expect(res.status).toBe(201); expect(t.api_key).toMatch(/^amgi_live_/); expect(res.headers.get('cache-control')).toBe('no-store');
    T = { id: t.tenant_id, key: t.api_key };
    const list = await (await dash('admin', 'GET', '/api/v1/admin/tenants')).json();
    expect(list.tenants.find((x: any) => x.tenant_id === T.id)).toMatchObject({ company_name: 'Dash Created Ltd', plan: 'enterprise', status: 'active', active_keys: 1 });
    const one = await (await dash('auditor', 'GET', `/api/v1/admin/tenants/${T.id}`)).json(); expect(one.tenant).toMatchObject({ tenant_id: T.id, active_keys: 1 });
    expect((await dash('admin', 'GET', '/api/v1/admin/tenants/nope-nope')).status).toBe(404);
    const keysRes = await dash('admin', 'GET', `/api/v1/admin/tenants/${T.id}/keys`); expect(keysRes.headers.get('cache-control')).toBe('no-store'); // administrative data is never cached
    expect(JSON.stringify(await keysRes.json())).not.toContain(T.key);
    const audit = await (await dash('auditor', 'GET', `/api/v1/admin/tenants/${T.id}/audit`)).json();
    expect(audit.chain.valid ?? audit.chain.ok ?? true).toBe(true);
    const created = audit.entries.find((e: any) => /tenant\.created/.test(e.event_type ?? e.eventType));
    expect(JSON.stringify(created)).toContain(`dashboard:${uid.admin}`); expect(JSON.stringify(created)).not.toContain('someone-else');
    // the new key works against the tenant API
    expect((await as(T.key, 'GET', '/v1/interpretations')).status).toBe(200);
  });

  it('suspend, reactivate and plan changes take effect and are audited under the person', async () => {
    expect((await dash('admin', 'POST', `/api/v1/admin/tenants/${T.id}/suspend`, {})).status).toBe(200);
    expect((await as(T.key, 'GET', '/v1/interpretations')).status).toBeGreaterThanOrEqual(401);
    expect((await dash('admin', 'POST', `/api/v1/admin/tenants/${T.id}/reactivate`, {})).status).toBe(200);
    expect((await as(T.key, 'GET', '/v1/interpretations')).status).toBe(200);
    expect((await dash('admin', 'PUT', `/api/v1/admin/tenants/${T.id}/plan`, { plan: 'bogus' })).status).toBe(400);
    expect((await dash('admin', 'PUT', `/api/v1/admin/tenants/${T.id}/plan`, { plan: 'free' })).status).toBe(200);
    expect((await dash('admin', 'PUT', `/api/v1/admin/tenants/${T.id}/plan`, { plan: 'enterprise' })).status).toBe(200);
    const audit = await (await dash('auditor', 'GET', `/api/v1/admin/tenants/${T.id}/audit`)).json();
    const changes = audit.entries.filter((e: any) => /suspend|reactivat|plan/.test(JSON.stringify(e.event_type ?? e.eventType ?? e)));
    expect(changes.length).toBeGreaterThanOrEqual(4); expect(changes.every((e: any) => JSON.stringify(e).includes(`dashboard:${uid.admin}`))).toBe(true);
  });

  it('keys: create, rotate and revoke from the dashboard; key material is shown once', async () => {
    const made = await (await dash('admin', 'POST', `/api/v1/admin/tenants/${T.id}/keys`, { label: 'second key' })).json();
    expect(made.api_key).toMatch(/^amgi_live_/); expect(made.key).toMatchObject({ label: 'second key' });
    expect((await as(made.api_key, 'GET', '/v1/interpretations')).status).toBe(200);
    const rot = await (await dash('admin', 'POST', `/api/v1/admin/tenants/${T.id}/keys/${made.key.key_id}/rotate`, { grace_seconds: 0 })).json();
    expect(rot.api_key).toMatch(/^amgi_live_/); expect(rot.api_key).not.toBe(made.api_key);
    const rev = await dash('admin', 'POST', `/api/v1/admin/tenants/${T.id}/keys/${rot.key.key_id}/revoke`, { reason: 'test' }); expect(rev.status).toBe(200);
    expect((await as(rot.api_key, 'GET', '/v1/interpretations')).status).toBeGreaterThanOrEqual(401);
    const keys = JSON.stringify(await (await dash('auditor', 'GET', `/api/v1/admin/tenants/${T.id}/keys`)).json());
    for (const k of [made.api_key, rot.api_key, T.key]) expect(keys).not.toContain(k);
  });

  // ── skills and narrative settings ──────────────────────────────────────────────────────────

  it('skill assignment with the narrative setting: validated against the allow-list, listed back, removable', async () => {
    const models = (await (await dash('admin', 'GET', '/api/v1/admin/narrative-models')).json()).models as string[];
    expect(models.length).toBeGreaterThan(0); expect(models).toContain('google/gemini-4-hydrogen'); expect(models).not.toContain('google/gemini-4-neon');
    const skills = (await (await dash('auditor', 'GET', '/api/v1/admin/skills')).json()).skills as any[]; expect(skills.map((s) => s.skill_id)).toContain(VITALS);
    const put = (config: unknown) => dash('admin', 'PUT', `/api/v1/admin/tenants/${T.id}/skills/${VITALS}`, { config });
    expect((await put({ narrative: { enabled: true, model: 'google/gemini-4-neon' } })).status).toBe(400); // off the allow-list
    expect((await put({ narrative: { enabled: true } })).status).toBe(400); // no model
    const ok = await put({ narrative: { enabled: true, model: models[0] } }); expect([200, 201]).toContain(ok.status);
    const list = await (await dash('auditor', 'GET', `/api/v1/admin/tenants/${T.id}/skills`)).json();
    expect(list.skills.find((s: any) => s.skill.skill_id === VITALS)?.assignment?.config?.narrative).toEqual({ enabled: true, model: models[0] });
    expect((await dash('admin', 'DELETE', `/api/v1/admin/tenants/${T.id}/skills/${VITALS}`)).status).toBe(204);
    expect((await dash('admin', 'DELETE', `/api/v1/admin/tenants/${T.id}/skills/${VITALS}`)).status).toBe(404);
    expect((await dash('admin', 'PUT', `/api/v1/admin/tenants/${T.id}/skills/not-a-skill`, {})).status).toBeGreaterThanOrEqual(400);
  });

  // ── branding ───────────────────────────────────────────────────────────────────────────────

  it('branding from the dashboard: name and logo only, markup and SVG refused, bytes never returned, audited under the person', async () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]).toString('base64');
    expect((await dash('admin', 'PUT', `/api/v1/admin/tenants/${T.id}/branding`, { productName: '<b>X</b>' })).status).toBe(400);
    expect((await dash('admin', 'PUT', `/api/v1/admin/tenants/${T.id}/branding`, { logoBase64: Buffer.from('<svg/>').toString('base64') })).status).toBe(400);
    const ok = await dash('admin', 'PUT', `/api/v1/admin/tenants/${T.id}/branding`, { productName: 'Acme Health', logoBase64: PNG }); expect(ok.status).toBe(200);
    const view = JSON.stringify(await (await dash('auditor', 'GET', `/api/v1/admin/tenants/${T.id}/branding`)).json());
    expect(view).toContain('Acme Health'); expect(view).not.toContain(PNG);
    expect((await dash('admin', 'DELETE', `/api/v1/admin/tenants/${T.id}/branding`)).status).toBe(204);
    const audit = await (await dash('auditor', 'GET', `/api/v1/admin/tenants/${T.id}/audit`)).json();
    const br = audit.entries.filter((e: any) => /branding/.test(JSON.stringify(e.event_type ?? e.eventType ?? '')));
    expect(br.length).toBe(2); expect(JSON.stringify(br)).toContain(`dashboard:${uid.admin}`); expect(JSON.stringify(br)).not.toContain('Acme')
  });

  it('the shared-key administrator API still works exactly as before, alongside', async () => {
    expect((await adm('GET', '/api/v1/admin/tenants')).status).toBe(200);
    expect((await fetch(`${base}/api/v1/admin/tenants`)).status).toBeGreaterThanOrEqual(401);
  });
});
