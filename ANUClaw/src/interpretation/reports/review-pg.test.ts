/**
 * Review states, the admin review queue and the clinician sign-off service (interpretation engine, P4d) against REAL
 * PostgreSQL (disposable database; opt-in via ANUCLAW_TEST_PG_URL) over the real HTTP layer. Synthetic data only. No model is called.
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

describe.skipIf(!URL_)('clinician review: queue, sign-off, rejection (real PostgreSQL)', () => {
  const dbName = `anuclaw_rpt_${crypto.randomBytes(6).toString('hex')}`;
  const ADMIN = crypto.randomBytes(24).toString('hex');
  let admin: Client; let server: Server; let base: string;
  let mainPool: { end(): Promise<void> } | undefined;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let signoff: typeof import('./signoff'); let jobs: typeof import('../jobs/worker'); let reports: typeof import('./worker'); let rqueue: typeof import('./queue');
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
    jobs = await import('../jobs/worker'); reports = await import('./worker'); rqueue = await import('./queue'); signoff = await import('./signoff'); validate = await import('../contracts/validate');

    const express = (await import('express')).default;
    const app = express(); app.use(express.json({ limit: '2mb' }));
    app.use((await import('../tenancy/admin-routes')).createTenantAdminRouter({ adminKey: ADMIN }));
    app.use((await import('../skills/admin-routes')).createSkillAdminRouter({ adminKey: ADMIN }));
    app.use((await import('../jobs/routes')).default);
    app.use((await import('./routes')).default);
    app.use((await import('./review-routes')).createReviewQueueRouter({ adminKey: ADMIN }));
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

  const mkUser = async (role: string, name: string | null, credential: 'active' | 'revoked' | 'none') => {
    const id = `u-${crypto.randomBytes(5).toString('hex')}`;
    await q(`INSERT INTO dash_users (id, email, name, role, created_at) VALUES ($1,$2,$3,$4,$5)`, [id, `${id}@clinic-synthetic.invalid`, name, role, Date.now()]);
    if (credential !== 'none') await q(`INSERT INTO clinician_credentials (user_id, license_number, jurisdiction, licensing_body, verification_note, status, provisioned_by, provisioned_at) VALUES ($1,'SYN-1','Nowhere','Synthetic Board','synthetic',$2,'admin-x',$3)`, [id, credential, Date.now()]);
    return id;
  };
  let doc1: string; let doc2: string; let docRevoked: string; let adminUser: string; let viewer: string;
  const hookTenant = async () => { await q(`INSERT INTO tenant_webhooks (tenant_id, url, secret_kid, secret_sealed, enabled, created_at, updated_at, secret_rotated_at) VALUES ($1,'https://hooks.example.test/h','k','s',TRUE,1,1,1) ON CONFLICT DO NOTHING`, [tenant.id]); };
  const contentOf = async (jobId: string) => (await (await as(tenant.key, 'GET', `/v1/interpretations/${jobId}/report?layer=clinical`)).json()).contentSha256 as string;
  const ready = async (body: unknown = vitals()) => { await clean(); const id = await submit(body); await drainJobs(); await drainReports(); return { id, report: await reportOf(id) }; };
  const queue = async (qs = '') => (await adm('GET', `/api/v1/admin/review-queue${qs}`)).json();

  it('setup: clinicians and non-clinicians', async () => {
    doc1 = await mkUser('clinician', 'Dr Synthetic One', 'active'); doc2 = await mkUser('clinician', 'Dr Synthetic Two', 'active'); docRevoked = await mkUser('clinician', 'Dr Revoked', 'revoked');
    adminUser = await mkUser('admin', 'Admin Person', 'none'); viewer = await mkUser('viewer', 'Viewer', 'none');
    await hookTenant();
  });

  // ── review queue ───────────────────────────────────────────────────────────────────────────

  it('the queue needs the admin key, is read-only, and carries identifiers, hashes and reason codes only', async () => {
    const aw = await ready(posture('unsigned')); const fu = await ready(vitals());
    expect((await fetch(`${base}/api/v1/admin/review-queue`)).status).toBeGreaterThanOrEqual(401);
    expect((await as(tenant.key, 'GET', '/api/v1/admin/review-queue')).status).toBeGreaterThanOrEqual(401);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await adm(m, '/api/v1/admin/review-queue', {})).status, m).toBe(404);
    const all = await queue('?limit=100'); const byId = new Map(all.items.map((i: any) => [i.jobId, i]));
    expect(byId.get(aw.id)).toMatchObject({ kind: 'awaiting_clinician', reviewState: 'awaiting_clinician', tenantId: tenant.id, version: 1, failedChecks: ['no_blocking_flags'], contentSha256: aw.report.content_sha256 });
    expect((byId.get(aw.id) as any).routeReasons.length).toBeGreaterThan(0);
    expect(byId.get(fu.id)).toMatchObject({ kind: 'follow_up', reviewState: 'ai_reviewed', failedChecks: [] });
    expect((byId.get(fu.id) as any).referralReasonCodes.length).toBeGreaterThan(0);
    expect(JSON.stringify(all)).not.toMatch(/mmHg|SUBJ-|label|"value"|sections/);
    // awaiting first, then follow-ups
    const kinds = all.items.map((i: any) => i.kind); expect(kinds.indexOf('follow_up')).toBeGreaterThan(kinds.lastIndexOf('awaiting_clinician'));
    expect((await queue('?kind=awaiting')).items.every((i: any) => i.kind === 'awaiting_clinician')).toBe(true);
    expect((await queue('?kind=follow_up')).items.every((i: any) => i.kind === 'follow_up')).toBe(true);
    expect((await adm('GET', '/api/v1/admin/review-queue?kind=nope')).status).toBe(400);
    // follow_up mirrors governance (a referral advisory or an attention flag); an ai_reviewed report without it is in neither queue
    const clean2 = await ready(posture('signed')); expect(clean2.report.follow_up).toBe(JSON.parse(clean2.report.governance_json).route.followUp);
    await q('UPDATE interpretation_reports SET follow_up = FALSE WHERE id = $1', [clean2.report.id]);
    expect((await queue('?limit=100')).items.some((i: any) => i.jobId === clean2.id)).toBe(false);
  });

  // ── sign-off ───────────────────────────────────────────────────────────────────────────────

  it('a provisioned clinician signs: a NEW version carries the same content, the old one is superseded, nothing is overwritten', async () => {
    const { id, report: v1 } = await ready(vitals());
    const hash = await contentOf(id); expect(hash).toBe(v1.content_sha256);
    const out = await signoff.signInterpretationReport({ reportId: v1.id, clinicianUserId: doc1, contentSha256: hash });
    expect(out).toMatchObject({ version: 2, reviewState: 'clinician_signed' });
    const rows = await q('SELECT * FROM interpretation_reports WHERE job_id = $1 ORDER BY version', [id]);
    expect(rows).toHaveLength(2);
    const [a, b] = rows;
    expect(a).toMatchObject({ status: 'superseded', review_state: 'ai_reviewed', reviewed_by: null }); expect(a.clinical_json).toBe(v1.clinical_json);
    expect(b).toMatchObject({ id: out.reportId, version: 2, supersedes_id: v1.id, status: 'ready', review_state: 'clinician_signed', reviewed_by: 'Dr Synthetic One', reviewer_user_id: doc1, signed_content_sha256: hash, content_sha256: hash });
    expect(b.clinical_json).toBe(v1.clinical_json); expect(b.layman_json).toBe(v1.layman_json); expect(b.governance_sha256).toBe(v1.governance_sha256); expect(b.findings_sha256).toBe(v1.findings_sha256);
    expect(Number(b.reviewed_at)).toBeGreaterThan(0);
    // the tenant now sees the signed version and the signer's name
    const j = await (await as(tenant.key, 'GET', `/v1/interpretations/${id}/report?layer=layman`)).json();
    expect(j).toMatchObject({ reportId: out.reportId, version: 2, reviewState: 'clinician_signed', contentSha256: hash }); expect(j.statusBanner).toMatch(/^Signed by Dr Synthetic One, \d{4}-\d\d-\d\d\.$/);
    const html = await (await as(tenant.key, 'GET', `/v1/interpretations/${id}/report?layer=clinical&format=html`)).text(); expect(html).toContain('Signed by Dr Synthetic One');
    const list = await (await as(tenant.key, 'GET', `/v1/interpretations/${id}/reports`)).json();
    expect(list.items.map((i: any) => [i.version, i.status, i.reviewState])).toEqual([[2, 'ready', 'clinician_signed'], [1, 'superseded', 'ai_reviewed']]);
    expect(list.items[0]).toMatchObject({ supersedesId: v1.id, reviewedBy: 'Dr Synthetic One' });
    // events: v1 and v2 each notified, v2 as signed; the audit entry names the signer by id and the hash, not the content
    const ev = await q(`SELECT payload_json FROM webhook_deliveries WHERE job_id = $1 AND event_type = 'interpretation.report_ready' ORDER BY created_at, id`, [id]);
    expect(ev.map((e: any) => JSON.parse(e.payload_json).data.reviewState).sort()).toEqual(['ai_reviewed', 'clinician_signed']);
    const audit = await q(`SELECT payload::text AS p FROM cds_audit_log_mt WHERE tenant_id = $1 AND event_type = 'interpretation.report_signed' AND payload::text LIKE $2`, [tenant.id, `%${out.reportId}%`]);
    expect(audit).toHaveLength(1); expect(audit[0].p).toContain(doc1); expect(audit[0].p).toContain(hash); expect(audit[0].p).not.toMatch(/mmHg|Dr Synthetic/);
    // out of the queue
    expect((await queue('?limit=100')).items.some((i: any) => i.jobId === id)).toBe(false);
    // a signed version cannot be altered, in the database
    await expect(q(`UPDATE interpretation_reports SET review_state = 'ai_reviewed' WHERE id = $1`, [out.reportId])).rejects.toThrow(/sign-off cannot be changed/);
    await expect(q(`DELETE FROM interpretation_reports WHERE id = $1 AND FALSE`, [out.reportId])).resolves.toBeDefined();
  });

  it('an awaiting_clinician report (blocking flag) can be signed by a clinician, and only then is it signed', async () => {
    const { id, report } = await ready(posture('unsigned')); expect(report.review_state).toBe('awaiting_clinician');
    const out = await signoff.signInterpretationReport({ reportId: report.id, clinicianUserId: doc2, contentSha256: await contentOf(id) });
    expect(out.reviewState).toBe('clinician_signed');
    expect((await q('SELECT review_state FROM interpretation_reports WHERE id = $1', [report.id]))[0].review_state).toBe('awaiting_clinician'); // the old row's review state is history, status is superseded
    expect((await q('SELECT status FROM interpretation_reports WHERE id = $1', [report.id]))[0].status).toBe('superseded');
  });

  it('only a provisioned clinician can sign: an admin, a viewer, a revoked clinician, an unknown or empty user are all refused and nothing changes', async () => {
    const { id, report } = await ready(vitals()); const hash = await contentOf(id);
    for (const who of [adminUser, viewer, docRevoked, 'no-such-user', '', undefined as any, `${doc1}' OR '1'='1`]) {
      await expect(signoff.signInterpretationReport({ reportId: report.id, clinicianUserId: who, contentSha256: hash }), String(who)).rejects.toMatchObject({ status: 403, code: 'clinician_required' });
    }
    expect(await q('SELECT 1 FROM interpretation_reports WHERE job_id = $1', [id])).toHaveLength(1);
    expect((await reportOf(id)).review_state).toBe('ai_reviewed');
    // revoking AFTER provisioning takes effect immediately (re-verified in the database on every call)
    const tmp = await mkUser('clinician', 'Dr Soon Revoked', 'active');
    await q(`UPDATE clinician_credentials SET status = 'revoked' WHERE user_id = $1`, [tmp]);
    await expect(signoff.signInterpretationReport({ reportId: report.id, clinicianUserId: tmp, contentSha256: hash })).rejects.toMatchObject({ code: 'clinician_required' });
    // and a role change away from clinician does too
    await q(`UPDATE dash_users SET role = 'viewer' WHERE id = $1`, [doc2]);
    try { await expect(signoff.signInterpretationReport({ reportId: report.id, clinicianUserId: doc2, contentSha256: hash })).rejects.toMatchObject({ code: 'clinician_required' }); } finally { await q(`UPDATE dash_users SET role = 'clinician' WHERE id = $1`, [doc2]); }
  });

  it('a clinician signs exactly what they saw: a wrong, missing or malformed content hash is refused', async () => {
    const { id, report } = await ready(vitals());
    for (const h of ['a'.repeat(64), '', 'nope', undefined as any]) await expect(signoff.signInterpretationReport({ reportId: report.id, clinicianUserId: doc1, contentSha256: h })).rejects.toMatchObject({ status: h === 'a'.repeat(64) ? 409 : 400 });
    expect(await q('SELECT 1 FROM interpretation_reports WHERE job_id = $1', [id])).toHaveLength(1);
    // stored layers altered behind the service's back (trigger disabled): the hash no longer matches what was reviewed
    const hash = await contentOf(id);
    await q('ALTER TABLE interpretation_reports DISABLE TRIGGER trg_interpretation_reports_content_immutable');
    try { await q(`UPDATE interpretation_reports SET layman_json = replace(layman_json, 'Please', 'Do not') WHERE id = $1`, [report.id]); } finally { await q('ALTER TABLE interpretation_reports ENABLE TRIGGER trg_interpretation_reports_content_immutable'); }
    await expect(signoff.signInterpretationReport({ reportId: report.id, clinicianUserId: doc1, contentSha256: hash })).rejects.toMatchObject({ status: 409, code: 'content_changed' });
  });

  it('refuses reports that are not reviewable: unknown, not ready, already signed, superseded, rejected, findings gone', async () => {
    const sign = (reportId: string, hash: string) => signoff.signInterpretationReport({ reportId, clinicianUserId: doc1, contentSha256: hash });
    await expect(sign('rpt_nope', 'a'.repeat(64))).rejects.toMatchObject({ status: 404 });
    await clean(); const queued = await submit(vitals()); await drainJobs(); const qr = await reportOf(queued);
    await expect(sign(qr.id, 'a'.repeat(64))).rejects.toMatchObject({ status: 409, code: 'not_reviewable' }); // queued
    await drainReports();
    const hash = await contentOf(queued); const v1 = await reportOf(queued);
    const out = await sign(v1.id, hash);
    await expect(sign(out.reportId, hash)).rejects.toMatchObject({ status: 409, code: 'already_reviewed' }); // already signed
    await expect(sign(v1.id, hash)).rejects.toMatchObject({ status: 409, code: 'not_reviewable' }); // superseded
    const r2 = await ready(vitals()); const h2 = await contentOf(r2.id);
    await signoff.rejectInterpretationReport({ reportId: r2.report.id, clinicianUserId: doc1, reason: 'not acceptable', contentSha256: h2 });
    await expect(sign(r2.report.id, h2)).rejects.toMatchObject({ status: 409, code: 'already_reviewed' }); // rejected stays rejected
    // findings removed (e.g. erased out of band): integrity failure, nothing signed
    const r3 = await ready(vitals()); const h3 = await contentOf(r3.id);
    await q('DELETE FROM normalized_findings WHERE job_id = $1', [r3.id]);
    await expect(sign(r3.report.id, h3)).rejects.toMatchObject({ status: 409, code: 'report_integrity' });
    expect(await q('SELECT 1 FROM interpretation_reports WHERE job_id = $1', [r3.id])).toHaveLength(1);
  });

  it('two clinicians signing at the same moment: exactly one version is created', async () => {
    const { id, report } = await ready(vitals()); const hash = await contentOf(id);
    const res = await Promise.allSettled([doc1, doc2].map((u) => signoff.signInterpretationReport({ reportId: report.id, clinicianUserId: u, contentSha256: hash })));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1); expect(res.filter((r) => r.status === 'rejected')).toHaveLength(1);
    // the loser is refused cleanly (the row lock serialised them), not by a database uniqueness error
    expect((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: expect.stringMatching(/^(already_reviewed|not_reviewable)$/) });
    expect(await q(`SELECT 1 FROM interpretation_reports WHERE job_id = $1 AND review_state = 'clinician_signed'`, [id])).toHaveLength(1);
    expect(await q('SELECT 1 FROM interpretation_reports WHERE job_id = $1', [id])).toHaveLength(2);
  });

  it('a version that is not the newest cannot be signed (a newer version exists)', async () => {
    const { id, report } = await ready(vitals()); const hash = await contentOf(id);
    await q(`INSERT INTO interpretation_reports (id, job_id, tenant_id, version, supersedes_id, status, run_after, findings_sha256, created_at, updated_at) VALUES ($1,$2,$3,2,$4,'queued',0,$5,1,1)`, [`rpt_${crypto.randomBytes(8).toString('hex')}`, id, tenant.id, report.id, report.findings_sha256]);
    await expect(signoff.signInterpretationReport({ reportId: report.id, clinicianUserId: doc1, contentSha256: hash })).rejects.toMatchObject({ status: 409, code: 'not_latest_version' });
    await expect(signoff.rejectInterpretationReport({ reportId: report.id, clinicianUserId: doc1, reason: 'x', contentSha256: hash })).rejects.toMatchObject({ code: 'not_latest_version' });
    await q('DELETE FROM interpretation_reports WHERE job_id = $1 AND version = 2', [id]);
  });

  // ── rejection ──────────────────────────────────────────────────────────────────────────────

  it('a clinician rejects: the reason is recorded, the tenant sees a rejected banner and an event, the audit entry holds no reason text', async () => {
    const { id, report } = await ready(vitals()); const hash = await contentOf(id);
    for (const reason of ['', '   ', 'x'.repeat(501), undefined as any]) await expect(signoff.rejectInterpretationReport({ reportId: report.id, clinicianUserId: doc1, reason, contentSha256: hash })).rejects.toMatchObject({ status: 400 });
    await expect(signoff.rejectInterpretationReport({ reportId: report.id, clinicianUserId: adminUser, reason: 'x', contentSha256: hash })).rejects.toMatchObject({ code: 'clinician_required' });
    const out = await signoff.rejectInterpretationReport({ reportId: report.id, clinicianUserId: doc2, reason: 'Wrong reference range for patient SECRET-CASE-ZQ', contentSha256: hash });
    expect(out).toEqual({ reportId: report.id, version: 1, reviewState: 'rejected' });
    expect(await reportOf(id)).toMatchObject({ status: 'ready', review_state: 'rejected', reviewed_by: 'Dr Synthetic Two', reviewer_user_id: doc2, rejection_reason: 'Wrong reference range for patient SECRET-CASE-ZQ' });
    expect((await reportOf(id)).clinical_json).toBe(report.clinical_json);
    const j = await (await as(tenant.key, 'GET', `/v1/interpretations/${id}/report?layer=layman`)).json();
    expect(j.reviewState).toBe('rejected'); expect(j.statusBanner).toMatch(/rejected this version/); expect(JSON.stringify(j)).not.toContain('SECRET-CASE-ZQ');
    const ev = await q(`SELECT payload_json FROM webhook_deliveries WHERE job_id = $1 AND event_type = 'interpretation.report_rejected'`, [id]);
    expect(ev).toHaveLength(1); expect(JSON.parse(ev[0].payload_json).data).toMatchObject({ status: 'rejected', reviewState: 'rejected' }); expect(ev[0].payload_json).not.toContain('SECRET-CASE-ZQ');
    const audit = await q(`SELECT payload::text AS p FROM cds_audit_log_mt WHERE tenant_id = $1 AND event_type = 'interpretation.report_rejected' AND payload::text LIKE $2`, [tenant.id, `%${report.id}%`]);
    expect(audit).toHaveLength(1); expect(audit[0].p).not.toContain('SECRET-CASE-ZQ'); expect(audit[0].p).toContain('reason_length');
    expect((await queue('?limit=100')).items.some((i: any) => i.jobId === id)).toBe(false);
    // the reason is not exposed to the tenant through the list either
    expect(JSON.stringify(await (await as(tenant.key, 'GET', `/v1/interpretations/${id}/reports`)).json())).not.toContain('SECRET-CASE-ZQ');
  });

  // ── nothing but the service can sign ───────────────────────────────────────────────────────

  it('no tenant or admin route can sign or reject, and the only caller of the service is the clinician-gated dashboard route', async () => {
    const { id, report } = await ready(vitals());
    for (const [m, p] of [['POST', `/v1/interpretations/${id}/report`], ['PUT', `/v1/interpretations/${id}/report`], ['PATCH', `/v1/interpretations/${id}/report`], ['POST', `/v1/interpretations/${id}/report/sign`], ['POST', `/v1/interpretations/${id}/reports`], ['POST', `/v1/interpretations/${id}/review`], ['DELETE', `/v1/interpretations/${id}/report`]]) {
      expect((await as(tenant.key, m, p, { reviewState: 'clinician_signed' })).status, `${m} ${p}`).toBe(404);
    }
    for (const p of [`/api/v1/admin/reports/${report.id}/sign`, `/api/v1/admin/review-queue/${report.id}`, `/api/v1/admin/review-queue/${report.id}/sign`]) for (const m of ['POST', 'PUT', 'PATCH']) expect((await adm(m, p, { clinicianUserId: doc1 })).status, `${m} ${p}`).toBe(404);
    expect((await reportOf(id)).review_state).toBe('ai_reviewed');
    const root = path.join(__dirname, '../..'); const hits: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); } else if (/\.(ts|js|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !f.endsWith(path.join('reports', 'signoff.ts'))) { if (/signInterpretationReport|rejectInterpretationReport/.test(fs.readFileSync(f, 'utf8'))) hits.push(path.relative(root, f)); } } };
    walk(root); const dashboardRoute = path.join('dashboard', 'server', 'routes', 'anukla-review.ts');
    expect(hits.filter((h) => h !== dashboardRoute)).toEqual([]); // nothing else may call it (the dashboard route exists from P6 on)
    if (hits.length) {
    // ...and in that route, each caller is gated on an ACTIVE clinician and a password re-check BEFORE the service is called
    const src = fs.readFileSync(path.join(root, 'dashboard/server/routes/anukla-review.ts'), 'utf8');
    for (const fn of ['signInterpretationReport', 'rejectInterpretationReport']) {
      const at = src.indexOf(`${fn}({`); const handlerStart = src.lastIndexOf('router.post(', at);
      const body = src.slice(handlerStart, at);
      expect(body, fn).toContain('await requireClinician(req)'); expect(body, fn).toContain('await confirmPassword(req');
    }
    }
    // the automatic pipeline can never leave a report signed
    expect(await q(`SELECT 1 FROM interpretation_reports WHERE review_state = 'clinician_signed' AND reviewer_user_id IS NULL`)).toHaveLength(0);
  });

  // ── erasure ────────────────────────────────────────────────────────────────────────────────

  it('erasing the subject removes every version of the report, signed or not', async () => {
    const { id, report } = await ready(vitals((r) => { r.subject.externalRef = 'SUBJ-ERASE-4D'; }));
    await signoff.signInterpretationReport({ reportId: report.id, clinicianUserId: doc1, contentSha256: await contentOf(id) });
    expect(await q('SELECT 1 FROM interpretation_reports WHERE job_id = $1', [id])).toHaveLength(2);
    const er = await as(tenant.key, 'POST', '/v1/subject-erasures', { externalRef: 'SUBJ-ERASE-4D', confirm: true });
    expect((await er.json()).reportsDeleted).toBe(2);
    expect(await q('SELECT 1 FROM interpretation_reports WHERE job_id = $1', [id])).toHaveLength(0);
    expect((await as(tenant.key, 'GET', `/v1/interpretations/${id}/report?layer=clinical`)).status).toBe(410);
    expect((await queue('?limit=100')).items.some((i: any) => i.jobId === id)).toBe(false);
  });
});
