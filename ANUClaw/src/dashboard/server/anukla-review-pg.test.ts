/**
 * The dashboard clinician review module (interpretation engine, P6a) against REAL PostgreSQL (disposable database; opt-in via
 * ANUCLAW_TEST_PG_URL) over the real HTTP layer with real cookie sessions. Synthetic data only. No model is called.
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

describe.skipIf(!URL_)('dashboard clinician review module (real PostgreSQL)', () => {
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
    app.use('/dash', (await import('cookie-parser')).default(), (await import('./routes/anukla-review')).default);
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
  let auth: typeof import('./auth'); let pw: typeof import('../../security/password'); let route: typeof import('./routes/anukla-review');
  const mkUser = async (k: string, role: string, name: string | null, cred: 'active' | 'revoked' | 'none') => {
    uid[k] = `u-${crypto.randomBytes(5).toString('hex')}`;
    await q(`INSERT INTO dash_users (id, email, name, role, password_hash, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [uid[k], `${uid[k]}@clinic-synthetic.invalid`, name, role, await pw.hashPassword(PW), Date.now()]);
    if (cred !== 'none') await q(`INSERT INTO clinician_credentials (user_id, license_number, jurisdiction, licensing_body, verification_note, status, provisioned_by, provisioned_at) VALUES ($1,'SYN-1','Nowhere','Synthetic Board','synthetic',$2,'admin-x',$3)`, [uid[k], cred, Date.now()]);
    cookie[k] = `dash_token=${(await auth.issueTokens(uid[k])).accessToken}`;
  };
  const dash = (who: string | null, method: string, p: string, body?: unknown) => fetch(`${base}/dash${p}`, { method, headers: { ...(who ? { cookie: cookie[who] } : {}), 'content-type': 'application/json' }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
  const ready = async (body: unknown = vitals()) => { await clean(); const id = await submit(body); await drainJobs(); await drainReports(); return { id, report: await reportOf(id) }; };
  const hashOf = async (rid: string) => (await (await dash('doc', 'GET', `/reports/${rid}`)).json()).report.contentSha256 as string;

  it('setup: users with real password hashes and sessions; the pipeline is wired', async () => {
    auth = await import('./auth'); pw = await import('../../security/password'); route = await import('./routes/anukla-review');
    await mkUser('doc', 'clinician', 'Dr Dash One', 'active'); await mkUser('doc2', 'clinician', 'Dr Dash Two', 'active'); await mkUser('revoked', 'clinician', 'Dr Revoked', 'revoked');
    await mkUser('nocred', 'clinician', 'Dr No Credential', 'none'); await mkUser('admin', 'admin', 'Admin', 'none'); await mkUser('viewer', 'viewer', 'Viewer', 'none'); await mkUser('op', 'operator', 'Operator', 'none');
    expect(Object.keys(cookie)).toHaveLength(7);
    await q(`INSERT INTO tenant_webhooks (tenant_id, url, secret_kid, secret_sealed, enabled, created_at, updated_at, secret_rotated_at) VALUES ($1,'https://hooks.example.test/h','k','s',TRUE,1,1,1) ON CONFLICT DO NOTHING`, [tenant.id]);
  });

  // ── access ─────────────────────────────────────────────────────────────────────────────────

  it('every route needs a dashboard session; a tenant API key is not one', async () => {
    const { report } = await ready(posture('unsigned'));
    for (const [m, p] of [['GET', '/queue'], ['GET', `/reports/${report.id}`], ['GET', `/reports/${report.id}/html?layer=clinical`], ['POST', `/reports/${report.id}/sign`], ['POST', `/reports/${report.id}/reject`], ['POST', `/reports/${report.id}/regenerate`]]) {
      expect((await dash(null, m, p, {})).status, `${m} ${p}`).toBe(401);
      expect((await fetch(`${base}/dash${p}`, { method: m, headers: { 'x-api-key': tenant.key, 'content-type': 'application/json' }, body: m === 'POST' ? '{}' : undefined })).status, `key ${m} ${p}`).toBe(401);
    }
  });

  it('patient content needs an ACTIVE clinician: admin, operator, viewer, no-credential and revoked clinicians are refused', async () => {
    const { report } = await ready(vitals());
    for (const who of ['admin', 'op', 'viewer', 'nocred', 'revoked']) {
      for (const [m, p] of [['GET', `/reports/${report.id}`], ['GET', `/reports/${report.id}/html?layer=layman`], ['POST', `/reports/${report.id}/sign`], ['POST', `/reports/${report.id}/reject`]]) {
        const r = await dash(who, m, p, { contentSha256: 'a'.repeat(64), attested: true, password: PW, reason: 'x' });
        expect(r.status, `${who} ${m} ${p}`).toBe(403); expect((await r.json()).code).toBe('clinician_required');
      }
    }
    expect((await dash('viewer', 'GET', '/queue')).status).toBe(403); expect((await dash('op', 'GET', '/queue')).status).toBe(403); expect((await dash('nocred', 'GET', '/queue')).status).toBe(403);
    expect((await dash('admin', 'GET', '/queue')).status).toBe(200); expect((await dash('doc', 'GET', '/queue')).status).toBe(200);
    expect((await reportOf((await q('SELECT job_id FROM interpretation_reports WHERE id = $1', [report.id]))[0].job_id)).review_state).toBe('ai_reviewed');
  });

  // ── queue and viewing ──────────────────────────────────────────────────────────────────────

  it('the queue names the tenant and carries no patient content', async () => {
    const aw = await ready(posture('unsigned'));
    const r = await (await dash('doc', 'GET', '/queue?limit=100')).json();
    const item = r.items.find((i: any) => i.jobId === aw.id);
    expect(item).toMatchObject({ reportId: aw.report.id, kind: 'awaiting_clinician', tenantName: 'Synthetic Reporter', failedChecks: ['no_blocking_flags'] });
    expect(JSON.stringify(r)).not.toMatch(/mmHg|SUBJ-|"label"|"value"/);
    expect((await dash('doc', 'GET', '/queue?kind=nope')).status).toBe(400);
  });

  it('viewing a report returns both layers, the review facts and the history, is not cached, and is audited without content', async () => {
    const { id, report } = await ready(vitals());
    const res = await dash('doc', 'GET', `/reports/${report.id}`); const j = await res.json();
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
    expect(j.report).toMatchObject({ id: report.id, jobId: id, version: 1, status: 'ready', reviewState: 'ai_reviewed', contentSha256: report.content_sha256, tenantName: 'Synthetic Reporter' });
    expect(j.clinical.layer).toBe('clinical'); expect(j.layman.layer).toBe('layman'); expect(j.clinical.findings).toEqual(j.layman.findings);
    expect(j.governance).toMatchObject({ routeState: 'eligible_for_ai_review' }); expect(j.governance.referralReasonCodes.length).toBeGreaterThan(0);
    expect(j.aiReview).toMatchObject({ ok: true, state: 'ai_reviewed' }); expect(j.history).toHaveLength(1);
    expect(j.actions).toEqual({ canSign: true, canReject: true, canRegenerate: false });
    expect(j.report.banner).toMatch(/AI-reviewed/);
    const audit = await q(`SELECT payload::text AS p FROM cds_audit_log_mt WHERE tenant_id = $1 AND event_type = 'interpretation.report_viewed' AND payload::text LIKE $2`, [tenant.id, `%${report.id}%`]);
    expect(audit.length).toBeGreaterThanOrEqual(1); expect(audit[0].p).toContain(uid.doc); expect(audit[0].p).not.toMatch(/mmHg|Systolic/i);
    expect((await dash('doc', 'GET', '/reports/rpt_nope')).status).toBe(404); expect((await dash('doc', 'GET', `/reports/rpt_${'0'.repeat(24)}`)).status).toBe(404);
  });

  it('a report that is not ready cannot be opened', async () => {
    await clean(); const id = await submit(vitals()); await drainJobs(); const r = await reportOf(id);
    const res = await dash('doc', 'GET', `/reports/${r.id}`); expect(res.status).toBe(409); expect((await res.json()).code).toBe('not_ready');
    await drainReports();
  });

  it('the rendered page is served with a sandbox-friendly policy, the status banner and the advisory', async () => {
    const { report } = await ready(vitals());
    const res = await dash('doc', 'GET', `/reports/${report.id}/html?layer=layman`); const html = await res.text();
    expect(res.status).toBe(200); expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const csp = res.headers.get('content-security-policy')!; expect(csp).toContain("default-src 'none'"); expect(csp).toContain("frame-ancestors 'self'"); expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(html).toContain('AI-reviewed, not reviewed by a clinician'); expect(html).toContain('Please see a doctor'); expect(html).not.toMatch(/<script|https?:\/\//i);
    expect((await dash('doc', 'GET', `/reports/${report.id}/html?layer=both`)).status).toBe(400); expect((await dash('doc', 'GET', `/reports/${report.id}/html`)).status).toBe(400);
  });

  // ── signing ────────────────────────────────────────────────────────────────────────────────

  const err = async (r: Response, status: number, code: string) => { expect(r.status).toBe(status); expect((await r.json()).code).toBe(code); };

  it("signing needs the attestation, the clinician's own password and the hash that was viewed; then it signs a new version", async () => {
    const { id, report } = await ready(vitals()); const hash = await hashOf(report.id); route.signoffPasswordFailures.reset(`signoff|${uid.doc}`);
    const sign = (body: any, who = 'doc') => dash(who, 'POST', `/reports/${report.id}/sign`, body);
    await err(await sign({ contentSha256: hash, password: PW }), 400, 'attestation_required');
    await err(await sign({ contentSha256: hash, attested: 'yes', password: PW }), 400, 'attestation_required');
    await err(await sign({ contentSha256: hash, attested: true }), 400, 'validation_failed');
    await err(await sign({ contentSha256: hash, attested: true, password: 123 }), 400, 'validation_failed');
    await err(await sign({ contentSha256: hash, attested: true, password: 'wrong-password' }), 403, 'password_incorrect');
    await err(await sign({ attested: true, password: PW }), 400, 'validation_failed'); // no hash
    await err(await sign({ contentSha256: 'a'.repeat(64), attested: true, password: PW }), 409, 'content_changed'); // not what was viewed
    expect(await q(`SELECT 1 FROM interpretation_reports WHERE job_id = $1`, [id])).toHaveLength(1);
    const ok = await sign({ contentSha256: hash, attested: true, password: PW }); expect(ok.status).toBe(200);
    const out = await ok.json(); expect(out).toMatchObject({ version: 2, reviewState: 'clinician_signed' });
    expect(await q(`SELECT reviewer_user_id, reviewed_by, status, signed_content_sha256 FROM interpretation_reports WHERE id = $1`, [out.reportId])).toEqual([{ reviewer_user_id: uid.doc, reviewed_by: 'Dr Dash One', status: 'ready', signed_content_sha256: hash }]);
    // the tenant sees the signature
    const t = await (await as(tenant.key, 'GET', `/v1/interpretations/${id}/report?layer=layman`)).json(); expect(t.statusBanner).toMatch(/^Signed by Dr Dash One, /);
    // and it cannot be signed twice, or rejected afterwards
    await err(await sign({ contentSha256: hash, attested: true, password: PW }), 409, 'not_reviewable');
    const v2 = await (await dash('doc', 'GET', `/reports/${out.reportId}`)).json(); expect(v2.actions).toEqual({ canSign: false, canReject: false, canRegenerate: false }); expect(v2.history.map((h: any) => [h.version, h.status])).toEqual([[2, 'ready'], [1, 'superseded']]);
  });

  it('the password check is throttled per account, counted only on failures, and cleared by a success', async () => {
    const { report } = await ready(vitals()); const hash = await hashOf(report.id); const k = `signoff|${uid.doc2}`; route.signoffPasswordFailures.reset(k);
    const bad = () => dash('doc2', 'POST', `/reports/${report.id}/sign`, { contentSha256: hash, attested: true, password: 'nope' });
    for (let i = 0; i < 5; i++) await err(await bad(), 403, 'password_incorrect');
    await err(await bad(), 429, 'rate_limited');
    await err(await dash('doc2', 'POST', `/reports/${report.id}/sign`, { contentSha256: hash, attested: true, password: PW }), 429, 'rate_limited'); // even the right one, while locked
    expect(await q(`SELECT 1 FROM interpretation_reports WHERE id = $1 AND review_state = 'clinician_signed'`, [report.id])).toHaveLength(0);
    await err(await dash('doc', 'POST', `/reports/${report.id}/reject`, { contentSha256: 'a'.repeat(64), reason: 'x', password: 'nope' }), 403, 'password_incorrect'); // another clinician is not locked out
    route.signoffPasswordFailures.reset(k);
    await err(await bad(), 403, 'password_incorrect');
    expect((await dash('doc2', 'POST', `/reports/${report.id}/sign`, { contentSha256: hash, attested: true, password: PW })).status).toBe(200);
    expect(route.signoffPasswordFailures.peek(k)).toBe(0);
  });

  it("another user's password does not confirm a sign-off", async () => {
    const { report } = await ready(vitals()); const hash = await hashOf(report.id); route.signoffPasswordFailures.reset(`signoff|${uid.doc}`);
    await q(`UPDATE dash_users SET password_hash = $2 WHERE id = $1`, [uid.doc2, await pw.hashPassword('Doc-Two-Own-Password-9!')]);
    try {
      await err(await dash('doc2', 'POST', `/reports/${report.id}/sign`, { contentSha256: hash, attested: true, password: PW }), 403, 'password_incorrect');
      expect((await dash('doc2', 'POST', `/reports/${report.id}/sign`, { contentSha256: hash, attested: true, password: 'Doc-Two-Own-Password-9!' })).status).toBe(200);
    } finally { await q(`UPDATE dash_users SET password_hash = $2 WHERE id = $1`, [uid.doc2, await pw.hashPassword(PW)]); route.signoffPasswordFailures.reset(`signoff|${uid.doc2}`); }
  });

  // ── rejection and regeneration ─────────────────────────────────────────────────────────────

  it('rejecting records the reason, shows the rejected banner to the tenant and offers regeneration', async () => {
    const { id, report } = await ready(vitals()); const hash = await hashOf(report.id); route.signoffPasswordFailures.reset(`signoff|${uid.doc}`);
    const rej = (body: any) => dash('doc', 'POST', `/reports/${report.id}/reject`, body);
    await err(await rej({ contentSha256: hash, password: PW }), 400, 'validation_failed'); // no reason
    await err(await rej({ contentSha256: hash, reason: 'Wrong range', password: 'bad' }), 403, 'password_incorrect');
    expect((await rej({ contentSha256: hash, reason: 'Wrong reference range', password: PW })).status).toBe(200);
    expect(await reportOf(id)).toMatchObject({ review_state: 'rejected', reviewer_user_id: uid.doc, rejection_reason: 'Wrong reference range', status: 'ready' });
    const v = await (await dash('doc', 'GET', `/reports/${report.id}`)).json();
    expect(v.report).toMatchObject({ reviewState: 'rejected', rejectionReason: 'Wrong reference range' }); expect(v.actions).toEqual({ canSign: false, canReject: false, canRegenerate: true });
    expect((await (await as(tenant.key, 'GET', `/v1/interpretations/${id}/report?layer=layman`)).json()).statusBanner).toMatch(/rejected this version/);
  });

  it('regeneration after a rejection: a new version over the same findings; the rejected one stays visible until the replacement is ready', async () => {
    const { id, report: v1 } = await ready(vitals()); const hash = await hashOf(v1.id); route.signoffPasswordFailures.reset(`signoff|${uid.doc}`);
    await err(await dash('doc', 'POST', `/reports/${v1.id}/regenerate`), 409, 'not_regenerable'); // not rejected
    expect((await dash('doc', 'POST', `/reports/${v1.id}/reject`, { contentSha256: hash, reason: 'Re-run please', password: PW })).status).toBe(200);
    for (const who of ['viewer', 'op', 'nocred', 'revoked']) await err(await dash(who, 'POST', `/reports/${v1.id}/regenerate`), 403, who === 'viewer' || who === 'op' ? 'clinician_required' : 'clinician_required');
    const res = await dash('admin', 'POST', `/reports/${v1.id}/regenerate`); expect(res.status).toBe(202);
    const out = await res.json(); expect(out.version).toBe(2);
    const v2q = (await q('SELECT * FROM interpretation_reports WHERE id = $1', [out.reportId]))[0];
    expect(v2q).toMatchObject({ status: 'queued', supersedes_id: v1.id, findings_sha256: v1.findings_sha256, version: 2, review_state: null });
    // the tenant still sees the rejected version, not a gap
    const mid = await (await as(tenant.key, 'GET', `/v1/interpretations/${id}/report?layer=clinical`)).json(); expect(mid).toMatchObject({ version: 1, reviewState: 'rejected' });
    await err(await dash('doc', 'POST', `/reports/${v1.id}/regenerate`), 409, 'regeneration_in_progress');
    await drainReports();
    const rows = await q('SELECT version, status, review_state FROM interpretation_reports WHERE job_id = $1 ORDER BY version', [id]);
    expect(rows).toEqual([{ version: 1, status: 'superseded', review_state: 'rejected' }, { version: 2, status: 'ready', review_state: 'ai_reviewed' }]);
    const now = await (await as(tenant.key, 'GET', `/v1/interpretations/${id}/report?layer=clinical`)).json(); expect(now).toMatchObject({ version: 2, reviewState: 'ai_reviewed' });
    const ev = await q(`SELECT payload_json FROM webhook_deliveries WHERE job_id = $1 AND event_type = 'interpretation.report_ready' ORDER BY created_at`, [id]); expect(ev.length).toBeGreaterThanOrEqual(2);
    const audit = await q(`SELECT payload::text AS p FROM cds_audit_log_mt WHERE tenant_id = $1 AND event_type = 'interpretation.report_regenerated' AND payload::text LIKE $2`, [tenant.id, `%${out.reportId}%`]);
    expect(audit).toHaveLength(1); expect(audit[0].p).toContain(uid.admin);
    // the replacement is reviewed like any report
    expect((await dash('doc', 'POST', `/reports/${out.reportId}/sign`, { contentSha256: await hashOf(out.reportId), attested: true, password: PW })).status).toBe(200);
  });

  it('a failed replacement leaves the rejected version in place and allows another attempt', async () => {
    const { id, report: v1 } = await ready(vitals()); const hash = await hashOf(v1.id); route.signoffPasswordFailures.reset(`signoff|${uid.doc}`);
    await dash('doc', 'POST', `/reports/${v1.id}/reject`, { contentSha256: hash, reason: 'Again', password: PW });
    const a = await (await dash('doc', 'POST', `/reports/${v1.id}/regenerate`)).json();
    await q(`UPDATE interpretation_reports SET status = 'failed', error_code = 'forced' WHERE id = $1`, [a.reportId]);
    expect((await (await as(tenant.key, 'GET', `/v1/interpretations/${id}/report?layer=clinical`)).json()).reviewState).toBe('rejected');
    const b = await (await dash('doc', 'POST', `/reports/${v1.id}/regenerate`)).json(); expect(b.version).toBe(3);
    await drainReports();
    expect((await q('SELECT version, status FROM interpretation_reports WHERE job_id = $1 ORDER BY version', [id])).map((r: any) => [r.version, r.status])).toEqual([[1, 'superseded'], [2, 'failed'], [3, 'ready']]);
  });

  it('regeneration uses the tenant\'s current narrative settings and the same stored findings; it cannot revive erased data', async () => {
    const { id, report: v1 } = await ready(vitals((r) => { r.subject.externalRef = 'SUBJ-REGEN-ERASE'; })); const hash = await hashOf(v1.id); route.signoffPasswordFailures.reset(`signoff|${uid.doc}`);
    await dash('doc', 'POST', `/reports/${v1.id}/reject`, { contentSha256: hash, reason: 'Erase test', password: PW });
    expect((await as(tenant.key, 'POST', '/v1/subject-erasures', { externalRef: 'SUBJ-REGEN-ERASE', confirm: true })).status).toBe(200);
    await err(await dash('doc', 'POST', `/reports/${v1.id}/regenerate`), 404, 'not_found');
    expect(await q('SELECT 1 FROM interpretation_reports WHERE job_id = $1', [id])).toHaveLength(0);
    // and tampered findings are refused rather than regenerated
    const { id: id2, report: r2 } = await ready(vitals()); const h2 = await hashOf(r2.id);
    await dash('doc', 'POST', `/reports/${r2.id}/reject`, { contentSha256: h2, reason: 'Tamper test', password: PW });
    await q(`UPDATE normalized_findings SET document_json = replace(document_json, '"value":154', '"value":99') WHERE job_id = $1`, [id2]);
    await err(await dash('doc', 'POST', `/reports/${r2.id}/regenerate`), 409, 'report_integrity');
    // an interpretation that is no longer completed cannot be regenerated
    await q(`UPDATE normalized_findings SET document_json = replace(document_json, '"value":99', '"value":154') WHERE job_id = $1`, [id2]);
    await q(`UPDATE interpretation_jobs SET status = 'failed' WHERE id = $1`, [id2]);
    try { await err(await dash('doc', 'POST', `/reports/${r2.id}/regenerate`), 409, 'not_regenerable'); } finally { await q(`UPDATE interpretation_jobs SET status = 'completed' WHERE id = $1`, [id2]); }
  });
});
