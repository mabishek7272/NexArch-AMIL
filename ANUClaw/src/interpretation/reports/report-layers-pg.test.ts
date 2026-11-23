/**
 * Stage 3 (assemble), the report endpoints and tenant branding (interpretation engine, P4c) against REAL PostgreSQL
 * (disposable database; opt-in via ANUCLAW_TEST_PG_URL) over the real HTTP layer. Synthetic data only. No model is called.
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

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/examples/beaive-vitals.request.json'), 'utf8'));
const VITALS = 'physiological-signal-interpretation';
const POSTURE = 'posture-analysis-interpretation';
const PP_SECRET = 'import-secret-'.padEnd(40, 'z');

describe.skipIf(!URL_)('report layers, endpoints and branding (real PostgreSQL)', () => {
  const dbName = `anuclaw_rpt_${crypto.randomBytes(6).toString('hex')}`;
  const ADMIN = crypto.randomBytes(24).toString('hex');
  let admin: Client; let server: Server; let base: string;
  let mainPool: { end(): Promise<void> } | undefined;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let jobs: typeof import('../jobs/worker'); let reports: typeof import('./worker'); let rqueue: typeof import('./queue');
  let validate: typeof import('../contracts/validate');
  let tenant: { id: string; key: string };

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, {
      PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName,
      ANUCLAW_JWT_SECRET: crypto.randomBytes(32).toString('hex'), ANUCLAW_IDENTITY_VAULT_KEY: crypto.randomBytes(32).toString('hex'),
      ANUCLAW_POSTUREPULSE_IMPORT_SECRET: PP_SECRET,
    });
    delete process.env.ANUCLAW_RATE_STORE; delete process.env.ANUCLAW_SELF_REGISTRATION;
    vi.resetModules();
    await (await import('../../db/connection')).ensureDbReady();
    mainPool = (await import('../../db/connection')).getDb();
    q = (await import('../../db')).db.query as any;
    jobs = await import('../jobs/worker'); reports = await import('./worker'); rqueue = await import('./queue'); validate = await import('../contracts/validate');

    const express = (await import('express')).default;
    const app = express(); app.use(express.json({ limit: '2mb' }));
    app.use((await import('../tenancy/admin-routes')).createTenantAdminRouter({ adminKey: ADMIN }));
    app.use((await import('../skills/admin-routes')).createSkillAdminRouter({ adminKey: ADMIN }));
    app.use((await import('../jobs/routes')).default);
    app.use((await import('./routes')).default);
    app.use((await import('./admin-routes')).createBrandingAdminRouter({ adminKey: ADMIN }));
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


  const PNG_B64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]).toString('base64');
  const get = (key: string, id: string, qs: string) => as(key, 'GET', `/v1/interpretations/${id}/report${qs}`);

  // ── stage 3 ────────────────────────────────────────────────────────────────────────────────

  it('the pipeline ends in ready: both layers stored, bound to the findings hash, the automatic review recorded', async () => {
    await clean();
    const id = await submit(vitals()); await drainJobs();
    expect(await reports.runOnce()).toBe('governed'); expect(await reports.runOnce()).toBe('narrated');
    expect(await reportOf(id)).toMatchObject({ status: 'narrated', clinical_json: null, layman_json: null });
    expect(await reports.runOnce()).toBe('ready');
    const r = await reportOf(id); const job = (await q('SELECT findings_sha256 FROM interpretation_jobs WHERE id = $1', [id]))[0];
    expect(r).toMatchObject({ status: 'ready', claim_token: null, attempts: 0, review_state: 'ai_reviewed', reviewed_by: null, reviewer_user_id: null, follow_up: true });
    expect(Number(r.ready_at)).toBeGreaterThan(0);
    const c = JSON.parse(r.clinical_json); const l = JSON.parse(r.layman_json);
    expect(c.schemaVersion).toBe('report-layer/v1'); expect(c.layer).toBe('clinical'); expect(l.layer).toBe('layman');
    expect(c.traceability.findingsSha256).toBe(job.findings_sha256); expect(l.traceability.findingsSha256).toBe(job.findings_sha256);
    expect(c.traceability.governanceSha256).toBe(r.governance_sha256);
    expect(c.findings).toEqual(l.findings);
    expect(c.referral.text).not.toBe(l.referral.text);
    expect(await reports.runOnce()).toBeNull();
  });

  it('a blocking flag routes to awaiting_clinician; a clean report is ai_reviewed (never signed)', async () => {
    await clean();
    const id = await submit(posture('unsigned')); await drainJobs(); await drainReports();
    expect(await reportOf(id)).toMatchObject({ status: 'ready', review_state: 'awaiting_clinician' });
    const ok = await submit(posture('signed')); await drainJobs(); await drainReports();
    expect((await reportOf(ok)).review_state).toBe('ai_reviewed');
  });

  it('the stored layers are immutable once ready', async () => {
    await clean();
    const id = await submit(vitals()); await drainJobs(); await drainReports();
    await expect(q(`UPDATE interpretation_reports SET clinical_json = '{}' WHERE job_id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(q(`UPDATE interpretation_reports SET layman_json = '{}' WHERE job_id = $1`, [id])).rejects.toThrow(/immutable/);
  });

  it('the assemble commit is fenced: a claim stolen after the layers were built leaves nothing stored and queues no event', async () => {
    await clean();
    const id = await submit(vitals()); await drainJobs();
    expect(await reports.runOnce()).toBe('governed'); expect(await reports.runOnce()).toBe('narrated');
    const stale = (await rqueue.claimNextReport(Date.now(), 1000))!; expect(stale).toMatchObject({ job_id: id, stage: 'assembling' });
    let fresh: Awaited<ReturnType<typeof rqueue.claimNextReport>> = null;
    const out = await reports.processReport(stale, () => Date.now(), { beforeCommit: async () => { fresh = await rqueue.claimNextReport(Date.now() + 900_000, 300_000); } });
    expect(fresh).toMatchObject({ stage: 'assembling' }); expect(out).toBe('lost');
    expect(await reportOf(id)).toMatchObject({ status: 'assembling', clinical_json: null, layman_json: null, claim_token: fresh!.claim_token });
    expect(await rqueue.failReport(stale, 'late', true)).toBe('lost');
    expect(await reports.processReport(fresh!)).toBe('ready');
    expect((await q(`SELECT count(*)::int AS n FROM cds_audit_log_mt WHERE tenant_id = $1 AND event_type = 'interpretation.report_ready' AND payload::text LIKE $2`, [tenant.id, `%${id}%`]))[0].n).toBe(1);
  });

  it('a transient failure of the assemble stage returns the report to narrated (only that stage repeats); a permanent one fails it', async () => {
    await clean();
    const id = await submit(vitals()); await drainJobs();
    await reports.runOnce(); await reports.runOnce();
    const c1 = (await rqueue.claimNextReport())!; expect(c1.stage).toBe('assembling');
    expect(await rqueue.failReport(c1, 'transient', false)).toBe('retry');
    const r = await reportOf(id); expect(r).toMatchObject({ status: 'narrated', error_code: 'transient', claim_token: null }); expect(r.narrative_json).not.toBeNull();
    await q('UPDATE interpretation_reports SET run_after = 0 WHERE job_id = $1', [id]);
    expect(await reports.runOnce()).toBe('ready');
    const id2 = await submit(vitals()); await drainJobs(); await reports.runOnce(); await reports.runOnce();
    await q(`UPDATE normalized_findings SET findings_sha256 = $2 WHERE job_id = $1`, [id2, 'c'.repeat(64)]).catch(() => {});
    const bad = (await rqueue.claimNextReport())!; expect(await rqueue.failReport(bad, 'broken', true)).toBe('failed');
    expect(await reportOf(id2)).toMatchObject({ status: 'failed', error_code: 'broken' });
  });

  it('assembly refuses a stage whose inputs were tampered with (governance hash) and fails permanently', async () => {
    await clean();
    const id = await submit(vitals()); await drainJobs(); await reports.runOnce(); await reports.runOnce();
    await q('ALTER TABLE interpretation_reports DISABLE TRIGGER trg_interpretation_reports_content_immutable');
    try { await q(`UPDATE interpretation_reports SET governance_json = replace(governance_json, 'see_clinician_soon', 'something_else') WHERE job_id = $1`, [id]); } finally { await q('ALTER TABLE interpretation_reports ENABLE TRIGGER trg_interpretation_reports_content_immutable'); }
    expect(await reports.runOnce()).toBe('failed');
    expect(await reportOf(id)).toMatchObject({ status: 'failed', error_code: 'governance_integrity', clinical_json: null });
  });

  // ── endpoints ──────────────────────────────────────────────────────────────────────────────

  it('serves the current report as json for each layer, with the banner text and a content hash', async () => {
    await clean();
    const id = await submit(vitals()); await drainJobs(); await drainReports();
    const c = await (await get(tenant.key, id, '?layer=clinical')).json(); const l = await (await get(tenant.key, id, '?layer=layman&format=json')).json();
    expect(c).toMatchObject({ layer: 'clinical', version: 1, reviewState: 'ai_reviewed' }); expect(c.statusBanner).toMatch(/AI-reviewed, not reviewed by a clinician/);
    expect(l.layer).toBe('layman'); expect(l.contentSha256).toBe(c.contentSha256); expect(c.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.report.traceability.findingsSha256).toBe(l.report.traceability.findingsSha256);
    const list = await (await as(tenant.key, 'GET', `/v1/interpretations/${id}/reports`)).json();
    expect(list.items).toHaveLength(1); expect(list.items[0]).toMatchObject({ version: 1, status: 'ready', reviewState: 'ai_reviewed', narrativeMode: 'deterministic' });
    expect(JSON.stringify(list)).not.toMatch(/"report"|"sections"|"findings"/); // the list carries no content
  });

  it('html: locked-down headers, a self-contained page, the advisory and the governance block', async () => {
    await clean();
    const id = await submit(vitals()); await drainJobs(); await drainReports();
    const res = await get(tenant.key, id, '?layer=layman&format=html'); const html = await res.text();
    expect(res.status).toBe(200); expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'"); expect(res.headers.get('x-content-type-options')).toBe('nosniff'); expect(res.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain('Please see a doctor'); expect(html).toContain('Governance'); expect(html).not.toMatch(/<script|https?:\/\//i);
  });

  it('validation and scoping: layer required, format checked, another tenant gets 404, a bad id 404, not ready 409, no report 404', async () => {
    await clean();
    const other = await newTenant('Synthetic Other'); await adm('PUT', `/api/v1/admin/tenants/${other.id}/skills/${VITALS}`, {});
    const id = await submit(vitals());
    expect((await get(tenant.key, id, '?layer=clinical')).status).toBe(409);
    expect((await (await get(tenant.key, id, '?layer=clinical')).json()).error.code).toBe('report_not_ready');
    await drainJobs();
    expect((await get(tenant.key, id, '?layer=clinical')).status).toBe(409);
    await drainReports();
    expect((await get(tenant.key, id, '')).status).toBe(400); expect((await get(tenant.key, id, '?layer=both')).status).toBe(400); expect((await get(tenant.key, id, '?layer=clinical&format=docx')).status).toBe(400);
    expect((await get(other.key, id, '?layer=clinical')).status).toBe(404); expect((await as(other.key, 'GET', `/v1/interpretations/${id}/reports`)).status).toBe(404);
    expect((await as(tenant.key, 'GET', '/v1/interpretations/job_nope/report?layer=clinical')).status).toBe(404);
    expect((await fetch(`${base}/v1/interpretations/${id}/report?layer=clinical`)).status).toBe(401);
    expect((await get(tenant.key, id, '?layer=clinical')).status).toBe(200);
  });

  it('pdf: a real PDF with the banner on every page; if Chromium cannot start the answer is 503 pdf_renderer_unavailable and html still works', async () => {
    await clean();
    const id = await submit(vitals()); await drainJobs(); await drainReports();
    const res = await get(tenant.key, id, '?layer=clinical&format=pdf');
    if (res.status === 503) { expect((await res.json()).error.code).toBe('pdf_renderer_unavailable'); expect((await get(tenant.key, id, '?layer=clinical&format=html')).status).toBe(200); return; }
    expect(res.status).toBe(200); expect(res.headers.get('content-type')).toBe('application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const { PDFDocument } = await import('pdf-lib');
    expect((await PDFDocument.load(buf)).getPageCount()).toBeGreaterThanOrEqual(1);
  }, 60_000);

  // ── branding ───────────────────────────────────────────────────────────────────────────────

  it('branding: admin sets a name and logo; the report shows them; the logo bytes are never returned; the governance block is unchanged', async () => {
    await clean();
    const t = await newTenant('Synthetic Branded'); await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/${VITALS}`, {});
    const submitT = async () => (await (await as(t.key, 'POST', '/v1/interpretations', vitals())).json()).id as string;
    const id = await submitT(); await drainJobs(); await drainReports();
    const before = await (await get(t.key, id, '?layer=layman&format=html')).text();
    const put = await adm('PUT', `/api/v1/admin/tenants/${t.id}/branding`, { productName: 'Acme <Health> & Co', logoBase64: PNG_B64 });
    expect(put.status).toBe(400); // markup is refused
    const ok = await adm('PUT', `/api/v1/admin/tenants/${t.id}/branding`, { productName: 'Acme Health (UK)', logoBase64: PNG_B64 });
    expect(ok.status).toBe(200); const view = await ok.json();
    expect(view.branding).toEqual({ productName: 'Acme Health (UK)', hasLogo: true, logoMime: 'image/png' }); expect(JSON.stringify(view)).not.toContain(PNG_B64);
    expect(JSON.stringify(await (await adm('GET', `/api/v1/admin/tenants/${t.id}/branding`)).json())).not.toContain(PNG_B64);
    const after = await (await get(t.key, id, '?layer=layman&format=html')).text();
    expect(after).toContain('Acme Health (UK)'); expect(after).toContain(`data:image/png;base64,${PNG_B64}`);
    const strip = (h: string) => h.replace(/<header class="brand">[\s\S]*?<\/header>/, '');
    expect(strip(after)).toBe(strip(before));
    // another tenant is unaffected
    const other = await submit(vitals()); await drainJobs(); await drainReports();
    expect(await (await get(tenant.key, other, '?layer=layman&format=html')).text()).not.toContain('Acme');
    expect((await adm('DELETE', `/api/v1/admin/tenants/${t.id}/branding`)).status).toBe(204);
    expect(await (await get(t.key, id, '?layer=layman&format=html')).text()).not.toContain('Acme');
    // every change is audited, with no name or logo in the entry
    const audit = await q(`SELECT payload::text AS p FROM cds_audit_log_mt WHERE tenant_id = $1 AND event_type LIKE 'tenant.branding%'`, [t.id]);
    expect(audit.length).toBe(2); expect(audit.some((a: any) => a.p.includes('Acme') || a.p.includes(PNG_B64))).toBe(false);
  });

  it('branding admin: refuses SVG and unknown fields, needs the admin key, 404 for an unknown tenant', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    expect((await adm('PUT', `/api/v1/admin/tenants/${tenant.id}/branding`, { logoBase64: svg })).status).toBe(400);
    expect((await adm('PUT', `/api/v1/admin/tenants/${tenant.id}/branding`, { productName: 'A', footer: 'x' })).status).toBe(400);
    expect((await fetch(`${base}/api/v1/admin/tenants/${tenant.id}/branding`)).status).toBeGreaterThanOrEqual(401);
    expect((await adm('GET', `/api/v1/admin/tenants/no-such-tenant/branding`)).status).toBe(404);
    expect((await as(tenant.key, 'PUT', `/api/v1/admin/tenants/${tenant.id}/branding`, { productName: 'A' })).status).toBeGreaterThanOrEqual(401);
  });

  // ── webhook events ─────────────────────────────────────────────────────────────────────────

  it('report_ready and report_failed events are queued with the state change: ids, hashes and review state only', async () => {
    await clean();
    const t = await newTenant('Synthetic Hooked'); await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/${VITALS}`, {});
    await q(`INSERT INTO tenant_webhooks (tenant_id, url, secret_kid, secret_sealed, enabled, created_at, updated_at, secret_rotated_at) VALUES ($1,'https://hooks.example.test/h','k','s',TRUE,1,1,1)`, [t.id]);
    const mk = async () => (await (await as(t.key, 'POST', '/v1/interpretations', vitals())).json()).id as string;
    const id = await mk(); await drainJobs(); await drainReports();
    const ev = (await q(`SELECT payload_json, status FROM webhook_deliveries WHERE job_id = $1 AND event_type = 'interpretation.report_ready'`, [id]))[0];
    const body = JSON.parse(ev.payload_json);
    expect(ev.status).toBe('pending');
    expect(body.data).toMatchObject({ jobId: id, status: 'ready', version: 1, reviewState: 'ai_reviewed', links: { report: `/v1/interpretations/${id}/report` } });
    expect(body.data.findingsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.payload_json).not.toMatch(/mmHg|BP|label|SUBJ-/i);
    // a permanent failure queues report_failed in the same transaction
    const id2 = await mk(); await drainJobs(); await reports.runOnce();
    const c = (await rqueue.claimNextReport())!; expect(await rqueue.failReport(c, 'forced', true)).toBe('failed');
    const f = JSON.parse((await q(`SELECT payload_json FROM webhook_deliveries WHERE job_id = $1 AND event_type = 'interpretation.report_failed'`, [id2]))[0].payload_json);
    expect(f.data).toMatchObject({ jobId: id2, status: 'failed', errorCode: 'forced' }); expect(f.data.links.report).toBeUndefined();
    // no webhook registered: no event, no error
    const id3 = await submit(vitals()); await drainJobs(); await drainReports();
    expect(await q(`SELECT 1 FROM webhook_deliveries WHERE job_id = $1 AND event_type = 'interpretation.report_ready'`, [id3])).toHaveLength(0);
  });

  // ── erasure ────────────────────────────────────────────────────────────────────────────────

  it('after subject erasure the report is gone: 410 on every report route and no report rows remain', async () => {
    await clean();
    const body = vitals((r) => { r.subject.externalRef = 'SUBJ-ERASE-ME-4C'; });
    const id = (await (await as(tenant.key, 'POST', '/v1/interpretations', body)).json()).id as string; await drainJobs(); await drainReports();
    expect((await get(tenant.key, id, '?layer=clinical')).status).toBe(200);
    const er = await as(tenant.key, 'POST', '/v1/subject-erasures', { externalRef: 'SUBJ-ERASE-ME-4C', confirm: true });
    expect(er.status).toBe(200); expect((await er.json()).reportsDeleted).toBe(1);
    for (const qs of ['?layer=clinical', '?layer=layman&format=html', '?layer=clinical&format=pdf']) { const r = await get(tenant.key, id, qs); expect(r.status).toBe(410); expect((await r.json()).error.code).toBe('subject_erased'); }
    expect((await as(tenant.key, 'GET', `/v1/interpretations/${id}/reports`)).status).toBe(410);
    expect(await q('SELECT 1 FROM interpretation_reports WHERE job_id = $1', [id])).toHaveLength(0);
  });
});
