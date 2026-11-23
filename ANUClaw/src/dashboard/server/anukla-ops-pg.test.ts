/**
 * The dashboard operations module (interpretation engine, P6c): processing history, retries, webhook log, usage and spend,
 * audit-chain check, against REAL PostgreSQL (disposable database; opt-in via ANUCLAW_TEST_PG_URL) over the real HTTP layer
 * with real cookie sessions. Synthetic data only. No model is called.
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

describe.skipIf(!URL_)('dashboard operations module (real PostgreSQL)', () => {
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
    app.use('/dash', (await import('cookie-parser')).default(), (await import('./routes/anukla-ops')).default);
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
  const ROLES = ['admin', 'operator', 'auditor', 'compliance', 'viewer', 'clinician'];
  const dash = (who: string | null, method: string, p: string, body?: unknown) => fetch(`${base}/dash${p}`, { method, headers: { ...(who ? { cookie: cookie[who] } : {}), 'content-type': 'application/json' }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
  const get = async (who: string, p: string) => { const r = await dash(who, 'GET', p); return { status: r.status, body: await r.json() as any }; };
  const run = async (n = 500) => { for (let i = 0; i < n; i++) if ((await reports.runOnce()) === null && (await jobs.runOnce()) === null) return; };
  const hook = async () => { await q(`INSERT INTO tenant_webhooks (tenant_id, url, secret_kid, secret_sealed, enabled, created_at, updated_at, secret_rotated_at) VALUES ($1,'https://hooks.example.test/h?token=SECRET-TOKEN-ZQ','k','sealed-secret-zq',TRUE,1,1,2) ON CONFLICT DO NOTHING`, [tenant.id]); };

  it('setup: one dashboard user per role; the tenant has a webhook endpoint', async () => {
    const auth = await import('./auth'); const pw = await import('../../security/password');
    for (const role of ROLES) {
      uid[role] = `u-${crypto.randomBytes(5).toString('hex')}`;
      await q(`INSERT INTO dash_users (id, email, name, role, password_hash, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [uid[role], `${uid[role]}@clinic-synthetic.invalid`, role, role, await pw.hashPassword(PW), Date.now()]);
      cookie[role] = `dash_token=${(await auth.issueTokens(uid[role])).accessToken}`;
    }
    await hook();
  });

  // ── access ─────────────────────────────────────────────────────────────────────────────────

  it('every route needs a dashboard session; a tenant key is not one', async () => {
    const id = await submit(vitals()); await run();
    for (const [m, p] of [['GET', '/overview'], ['GET', '/jobs'], ['GET', `/jobs/${id}`], ['POST', `/jobs/${id}/retry`], ['POST', '/reports/rpt_000000000000000000000000/retry'], ['GET', '/webhooks/deliveries'], ['GET', '/webhooks/endpoints'], ['POST', '/webhooks/deliveries/dlv_000000000000000000000000/redeliver'], ['GET', '/usage'], ['GET', '/audit/verify']]) {
      expect((await dash(null, m, p, {})).status, `${m} ${p}`).toBe(401);
      expect((await fetch(`${base}/dash${p}`, { method: m, headers: { 'x-api-key': tenant.key, 'content-type': 'application/json' }, body: m === 'POST' ? '{}' : undefined })).status, `key ${m} ${p}`).toBe(401);
    }
  });

  it('roles: admin, operator, auditor and compliance read; only admin and operator re-queue; the chain check is not for operators; viewers and clinicians are refused', async () => {
    const reads = ['/overview', '/jobs', '/webhooks/deliveries', '/webhooks/endpoints', '/usage'];
    for (const role of ['admin', 'operator', 'auditor', 'compliance']) for (const p of reads) expect((await get(role, p)).status, `${role} ${p}`).toBe(200);
    for (const role of ['viewer', 'clinician']) for (const p of [...reads, '/audit/verify']) expect((await get(role, p)).status, `${role} ${p}`).toBe(403);
    for (const role of ['admin', 'auditor', 'compliance']) expect((await get(role, '/audit/verify')).status).toBe(200);
    expect((await get('operator', '/audit/verify')).status).toBe(403);
    for (const role of ['auditor', 'compliance', 'viewer', 'clinician']) for (const [m, p] of [['POST', '/jobs/job_000000000000000000000000/retry'], ['POST', '/reports/rpt_000000000000000000000000/retry'], ['POST', '/webhooks/deliveries/dlv_000000000000000000000000/redeliver']]) expect((await dash(role, m, p, {})).status, `${role} ${p}`).toBe(403);
    for (const role of ['admin', 'operator']) expect((await dash(role, 'POST', '/jobs/job_000000000000000000000000/retry', {})).status).toBe(404); // allowed, but nothing there
  });

  // ── overview ───────────────────────────────────────────────────────────────────────────────

  it('overview: counts by status, queue age, failure rate and the most common error codes, with no patient data', async () => {
    await clean();
    const ok = await submit(vitals()); const bad = await submit(vitals()); await jobs.runOnce(); await jobs.runOnce();
    await q(`UPDATE interpretation_jobs SET status = 'failed', error_code = 'adapter_error', completed_at = NULL WHERE id = $1`, [bad]);
    const queued = await submit(vitals());
    const o = (await get('auditor', '/overview')).body;
    expect(o.jobs.queued).toBeGreaterThanOrEqual(1); expect(o.jobs.failed).toBeGreaterThanOrEqual(1); expect(o.jobs.completed).toBeGreaterThanOrEqual(1);
    expect(o.oldestQueuedJobAgeSeconds).toBeGreaterThanOrEqual(0); expect(o.failureRateLast24h).toBeGreaterThan(0); expect(o.failureRateLast24h).toBeLessThanOrEqual(1);
    expect(o.topErrorCodesLast7d.find((e: any) => e.code === 'adapter_error')).toMatchObject({ source: 'job' });
    expect(Object.keys(o.webhookDeliveries).length).toBeGreaterThan(0); expect(o.reviewStates).toBeDefined();
    expect(JSON.stringify(o)).not.toMatch(/SUBJ-|mmHg|"label"/);
    void ok; void queued;
  });

  // ── processing history ─────────────────────────────────────────────────────────────────────

  it('job list: filterable and paged, shows the latest report, and never a subject reference or identity', async () => {
    await clean();
    const other = await newTenant('Synthetic Ops Other'); await adm('PUT', `/api/v1/admin/tenants/${other.id}/skills/${VITALS}`, {});
    const a = await submit(vitals((r) => { r.subject.externalRef = 'SUBJ-OPS-LEAK-ZQ'; r.subject.identity = { name: 'Identity Leak Zq' }; })); const b = await submit(posture('signed'));
    const c = (await (await as(other.key, 'POST', '/v1/interpretations', vitals())).json()).id as string;
    await run();
    const all = (await get('operator', '/jobs?limit=100')).body; const byId = new Map(all.items.map((i: any) => [i.jobId, i]));
    expect(byId.get(a)).toMatchObject({ tenantId: tenant.id, tenantName: 'Synthetic Reporter', skillId: VITALS, status: 'completed', errorCode: null, report: { version: 1, status: 'ready' } });
    expect((byId.get(a) as any).adapter).toMatch(/^beaive/); expect(byId.get(b)).toMatchObject({ skillId: POSTURE });
    expect(JSON.stringify(all)).not.toMatch(/SUBJ-OPS-LEAK-ZQ|Identity Leak Zq|ErasureLabel/);
    const mine = (await get('operator', `/jobs?tenantId=${other.id}`)).body.items; expect(mine.map((i: any) => i.jobId)).toEqual([c]);
    expect((await get('operator', `/jobs?skillId=${POSTURE}&tenantId=${tenant.id}&limit=100`)).body.items.every((i: any) => i.skillId === POSTURE)).toBe(true);
    await q(`UPDATE interpretation_jobs SET status = 'failed', error_code = 'adapter_error' WHERE id = $1`, [a]);
    expect((await get('operator', '/jobs?status=failed&errorCode=adapter_error')).body.items.map((i: any) => i.jobId)).toContain(a);
    await submit(vitals()); // left queued
    for (const st of ['queued', 'completed']) { const items = (await get('operator', `/jobs?status=${st}&limit=100`)).body.items; expect(items.length, st).toBeGreaterThan(0); expect(items.every((i: any) => i.status === st), st).toBe(true); }
    const p1 = (await get('operator', '/jobs?limit=2&offset=0')).body, p2 = (await get('operator', '/jobs?limit=2&offset=2')).body;
    expect(p1.items).toHaveLength(2); expect(p1.items.map((i: any) => i.jobId)).not.toEqual(p2.items.map((i: any) => i.jobId));
    const now = Date.now(); expect((await get('operator', `/jobs?from=${now + 60_000}`)).body.items).toEqual([]); expect((await get('operator', `/jobs?to=${now + 60_000}&limit=1`)).body.items).toHaveLength(1);
    await q(`UPDATE interpretation_jobs SET status = 'completed', error_code = NULL WHERE id = $1`, [a]);
  });

  it('job list: bad filters are refused', async () => {
    for (const qs of ['status=nope', 'tenantId=a%20b', 'skillId=BAD', 'errorCode=x%20y', 'from=abc', 'to=nope']) expect((await get('operator', `/jobs?${qs}`)).status, qs).toBe(400);
  });

  it('job detail of an erased subject: a tombstone with no events, no hashes and no deliveries content', async () => {
    await clean(); const id = await submit(vitals((r) => { r.subject.externalRef = 'SUBJ-DETAIL-ERASED'; })); await run();
    await as(tenant.key, 'POST', '/v1/subject-erasures', { externalRef: 'SUBJ-DETAIL-ERASED', confirm: true });
    const d = (await get('auditor', `/jobs/${id}`)).body;
    expect(d.job).toMatchObject({ status: 'erased', findingsSha256: null, originalPayloadSha256: null }); expect(d.reports).toEqual([]); expect(d.events).toEqual([]); expect(JSON.stringify(d)).not.toContain('SUBJ-DETAIL-ERASED');
  });

  it('job detail: reports, deliveries and the audit events about this job, without payloads or identifiers', async () => {
    await clean(); const id = await submit(vitals((r) => { r.subject.externalRef = 'SUBJ-DETAIL-ZQ'; })); await run();
    const d = (await get('auditor', `/jobs/${id}`)).body;
    expect(d.job).toMatchObject({ jobId: id, status: 'completed', tenantName: 'Synthetic Reporter' }); expect(d.job.findingsSha256).toMatch(/^[0-9a-f]{64}$/); expect(d.job.originalPayloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.reports[0]).toMatchObject({ version: 1, status: 'ready', reviewState: 'ai_reviewed', narrativeMode: 'deterministic' });
    expect(d.deliveries.map((x: any) => x.eventType).sort()).toEqual(['interpretation.completed', 'interpretation.report_ready']);
    expect(d.events.map((e: any) => e.eventType)).toEqual(expect.arrayContaining(['interpretation.completed', 'interpretation.governed', 'interpretation.report_ready'])); expect(d.events.every((e: any) => e.actor && e.timestamp)).toBe(true);
    expect(JSON.stringify(d)).not.toMatch(/SUBJ-DETAIL-ZQ|payload|mmHg/);
    expect((await get('auditor', '/jobs/job_000000000000000000000000')).status).toBe(404); expect((await get('auditor', '/jobs/nope')).status).toBe(404);
  });

  // ── retries ────────────────────────────────────────────────────────────────────────────────

  it('retrying a failed job re-queues it; the worker completes it; it is audited under the person; nothing else can be retried', async () => {
    await clean(); const id = await submit(vitals()); await q(`UPDATE interpretation_jobs SET status = 'failed', error_code = 'adapter_error', attempts = 5 WHERE id = $1`, [id]);
    const res = await dash('operator', 'POST', `/jobs/${id}/retry`, {}); expect(res.status).toBe(202); expect(await res.json()).toEqual({ jobId: id, status: 'queued' });
    expect((await q('SELECT status, attempts, error_code, claim_token FROM interpretation_jobs WHERE id = $1', [id]))[0]).toEqual({ status: 'queued', attempts: 0, error_code: null, claim_token: null });
    await run(); expect((await q('SELECT status FROM interpretation_jobs WHERE id = $1', [id]))[0].status).toBe('completed');
    const t = await (await adm('GET', `/api/v1/admin/tenants/${tenant.id}/audit`)).json();
    const e = t.entries.find((x: any) => x.event_type === 'interpretation.job_retried' && JSON.stringify(x).includes(id)); expect(e).toBeDefined(); expect(JSON.stringify(e)).toContain(`dashboard:${uid.operator}`); expect(JSON.stringify(e)).toContain('adapter_error');
    for (const status of ['completed', 'queued', 'processing']) { await q('UPDATE interpretation_jobs SET status = $2 WHERE id = $1', [id, status]); const r = await dash('admin', 'POST', `/jobs/${id}/retry`, {}); expect(r.status, status).toBe(409); expect((await r.json()).code).toBe('not_retryable'); }
    await q(`UPDATE interpretation_jobs SET status = 'completed' WHERE id = $1`, [id]);
  });

  it('a job whose source was erased cannot be retried', async () => {
    await clean(); const id = await submit(vitals((r) => { r.subject.externalRef = 'SUBJ-RETRY-ERASED'; })); await run();
    await as(tenant.key, 'POST', '/v1/subject-erasures', { externalRef: 'SUBJ-RETRY-ERASED', confirm: true });
    expect((await dash('admin', 'POST', `/jobs/${id}/retry`, {})).status).toBe(409);
    await q(`UPDATE interpretation_jobs SET status = 'failed' WHERE id = $1`, [id]); // even forced to failed, the payload is gone
    expect((await dash('admin', 'POST', `/jobs/${id}/retry`, {})).status).toBe(409);
  });

  it('retrying a failed report resumes at the stage that failed (what a stage stored is kept) and the worker finishes it', async () => {
    const resume = async (upTo: number, expected: string) => {
      await clean(); const id = await submit(vitals()); await jobs.runOnce();
      for (let i = 0; i < upTo; i++) await reports.runOnce(); // 0: queued, 1: governed, 2: narrated
      const before = await reportOf(id);
      await q(`UPDATE interpretation_reports SET status = 'failed', error_code = 'forced' WHERE id = $1`, [before.id]);
      const res = await dash('operator', 'POST', `/reports/${before.id}/retry`, {}); expect(res.status).toBe(202); expect((await res.json()).resumesAt).toBe(expected);
      const mid = await reportOf(id); expect(mid).toMatchObject({ status: expected, attempts: 0, error_code: null, claim_token: null }); expect(mid.governance_json).toBe(before.governance_json); expect(mid.narrative_json).toBe(before.narrative_json);
      await run(); expect(await reportOf(id)).toMatchObject({ status: 'ready', review_state: 'ai_reviewed' });
    };
    await resume(0, 'queued'); await resume(1, 'governed'); await resume(2, 'narrated');
  });

  it('report retry refusals: not failed, a newer version exists, the interpretation is gone', async () => {
    await clean(); const id = await submit(vitals()); await run(); const r = await reportOf(id);
    let res = await dash('admin', 'POST', `/reports/${r.id}/retry`, {}); expect(res.status).toBe(409); expect((await res.json()).code).toBe('not_retryable');
    await q(`UPDATE interpretation_reports SET status = 'failed' WHERE id = $1`, [r.id]);
    await q(`INSERT INTO interpretation_reports (id, job_id, tenant_id, version, supersedes_id, status, run_after, findings_sha256, created_at, updated_at) VALUES ($1,$2,$3,2,$4,'queued',0,$5,1,1)`, [`rpt_${crypto.randomBytes(12).toString('hex')}`, id, tenant.id, r.id, r.findings_sha256]);
    expect((await dash('admin', 'POST', `/reports/${r.id}/retry`, {})).status).toBe(409);
    await q('DELETE FROM interpretation_reports WHERE job_id = $1 AND version = 2', [id]);
    await q(`UPDATE interpretation_jobs SET status = 'failed' WHERE id = $1`, [id]);
    expect((await dash('admin', 'POST', `/reports/${r.id}/retry`, {})).status).toBe(409);
    await q(`UPDATE interpretation_jobs SET status = 'completed' WHERE id = $1`, [id]);
    expect((await dash('admin', 'POST', `/reports/rpt_${'0'.repeat(24)}/retry`, {})).status).toBe(404); expect((await dash('admin', 'POST', '/reports/nope/retry', {})).status).toBe(404);
  });

  // ── webhooks ───────────────────────────────────────────────────────────────────────────────

  it('the delivery log is filterable and carries no payload; a dead delivery can be sent again, once, with the same event id', async () => {
    await clean(); const id = await submit(vitals()); await run();
    const all = (await get('operator', `/webhooks/deliveries?tenantId=${tenant.id}&limit=100`)).body;
    const mine = all.items.filter((d: any) => d.jobId === id); expect(mine).toHaveLength(2); expect(JSON.stringify(all)).not.toMatch(/payload|findingsSha256|mmHg/);
    expect((await get('operator', '/webhooks/deliveries?status=pending&eventType=interpretation.completed&limit=100')).body.items.every((d: any) => d.status === 'pending' && d.eventType === 'interpretation.completed')).toBe(true);
    for (const qs of ['status=nope', 'eventType=A%20B', 'tenantId=a%20b']) expect((await get('operator', `/webhooks/deliveries?${qs}`)).status, qs).toBe(400);
    const d = mine[0];
    let r = await dash('operator', 'POST', `/webhooks/deliveries/${d.deliveryId}/redeliver`, {}); expect(r.status).toBe(409); expect((await r.json()).code).toBe('not_redeliverable'); // pending
    await q(`UPDATE webhook_deliveries SET status = 'dead', attempts = 6, dead_at = 5, last_error = 'http_500', first_attempt_at = 1 WHERE id = $1`, [d.deliveryId]);
    const before = (await q('SELECT event_id, payload_json FROM webhook_deliveries WHERE id = $1', [d.deliveryId]))[0];
    r = await dash('operator', 'POST', `/webhooks/deliveries/${d.deliveryId}/redeliver`, {}); expect(r.status).toBe(202);
    const after = (await q('SELECT * FROM webhook_deliveries WHERE id = $1', [d.deliveryId]))[0];
    expect(after).toMatchObject({ status: 'pending', attempts: 0, dead_at: null, last_error: null, first_attempt_at: null, claim_token: null }); expect(after.event_id).toBe(before.event_id); expect(after.payload_json).toBe(before.payload_json);
    expect((await dash('operator', 'POST', `/webhooks/deliveries/${d.deliveryId}/redeliver`, {})).status).toBe(409); // already pending again
    const audit = await (await adm('GET', `/api/v1/admin/tenants/${tenant.id}/audit`)).json(); const e = audit.entries.find((x: any) => x.event_type === 'webhook.redelivery_requested' && JSON.stringify(x).includes(d.deliveryId));
    expect(JSON.stringify(e)).toContain(`dashboard:${uid.operator}`);
    expect((await dash('operator', 'POST', `/webhooks/deliveries/dlv_${'0'.repeat(24)}/redeliver`, {})).status).toBe(404);
  });

  it('a delivery whose data was erased cannot be sent again', async () => {
    await clean(); const id = await submit(vitals((r) => { r.subject.externalRef = 'SUBJ-REDELIVER-ERASED'; })); await run();
    await as(tenant.key, 'POST', '/v1/subject-erasures', { externalRef: 'SUBJ-REDELIVER-ERASED', confirm: true });
    const d = (await q(`SELECT id, status FROM webhook_deliveries WHERE job_id = $1 LIMIT 1`, [id]))[0]; expect(d.status).toBe('dead');
    const r = await dash('admin', 'POST', `/webhooks/deliveries/${d.id}/redeliver`, {}); expect(r.status).toBe(409); expect((await r.json()).error).toMatch(/erased/);
  });

  it('endpoints: scheme and host only (a path or query can carry a token), never the secret', async () => {
    const ep = (await get('auditor', '/webhooks/endpoints')).body.endpoints.find((e: any) => e.tenantId === tenant.id);
    expect(ep).toMatchObject({ endpoint: 'https://hooks.example.test', enabled: true, secretRotatedAt: 2 }); expect(JSON.stringify(ep)).not.toMatch(/SECRET-TOKEN-ZQ|sealed-secret-zq|\/h\b/);
  });

  // ── usage and spend ────────────────────────────────────────────────────────────────────────

  it('usage: jobs and model spend per tenant, unknown costs counted as such, the budget stated, a bad range refused', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const ins = (id: string, state: string, actual: number | null, reserved: number) => q(`INSERT INTO model_spend_ledger (id, scope_kind, scope_id, period, role, model, data_class, state, reserved_usd, actual_usd, attempts, created_at) VALUES ($1,'tenant',$2,$3,'review','google/gemini-4-hydrogen','synthetic_test',$4,$5,$6,1,$7)`, [id, tenant.id, today, state, reserved, actual, Date.now()]);
    await ins(`sp-${crypto.randomBytes(5).toString('hex')}`, 'settled', 0.0123, 0.02); await ins(`sp-${crypto.randomBytes(5).toString('hex')}`, 'settled', 0.0077, 0.02); await ins(`sp-${crypto.randomBytes(5).toString('hex')}`, 'unknown_cost', null, 0.02);
    const u = (await get('auditor', '/usage')).body; const t = u.tenants.find((x: any) => x.tenantId === tenant.id);
    expect(t.modelCalls).toBeGreaterThanOrEqual(3); expect(t.modelSpendKnownUsd).toBeCloseTo(0.02, 6); expect(t.modelCallsWithUnknownCost).toBeGreaterThanOrEqual(1); expect(t.modelSpendCountedUsd).toBeGreaterThan(t.modelSpendKnownUsd);
    expect(Object.values(t.jobs as Record<string, number>).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(u.modelSpend.totalIsLowerBound).toBe(true); expect(u.modelSpend.budget).toHaveProperty('enforced'); expect(u.modelSpend.note).toMatch(/lower|unknown/i);
    expect(JSON.stringify(u)).not.toMatch(/SUBJ-|amgi_live_/);
    const none = (await get('auditor', '/usage?from=2000-01-01&to=2000-01-31')).body; expect(none.tenants.find((x: any) => x.tenantId === tenant.id)).toMatchObject({ modelCalls: 0, jobs: {} });
    for (const qs of ['from=nope', 'to=2026-13-01x', 'from=2026-02-01&to=2026-01-01']) expect((await get('auditor', `/usage?${qs}`)).status, qs).toBe(400);
  });

  // ── audit chain check ──────────────────────────────────────────────────────────────────────

  it('the chain check verifies every tenant and reports exactly where a tampered chain breaks', async () => {
    const ok = (await get('auditor', '/audit/verify')).body;
    expect(ok.allValid).toBe(true); expect(ok.tenantsChecked).toBeGreaterThan(1); expect(ok.results.every((r: any) => r.valid && r.headHash)).toBe(true); expect(ok.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const one = (await get('compliance', `/audit/verify?tenantId=${tenant.id}`)).body; expect(one.tenantsChecked).toBe(1); expect(one.results[0]).toMatchObject({ tenantId: tenant.id, valid: true });
    const seq = (await q(`SELECT seq FROM cds_audit_log_mt WHERE tenant_id = $1 ORDER BY seq LIMIT 1 OFFSET 2`, [tenant.id]))[0].seq;
    await q('ALTER TABLE cds_audit_log_mt DISABLE TRIGGER USER');
    try {
      await q(`UPDATE cds_audit_log_mt SET actor = 'attacker' WHERE tenant_id = $1 AND seq = $2`, [tenant.id, seq]);
      const bad = (await get('auditor', '/audit/verify')).body;
      expect(bad.allValid).toBe(false); const r = bad.results.find((x: any) => x.tenantId === tenant.id); expect(r).toMatchObject({ valid: false, brokenAt: Number(seq) }); expect(r.reason).toMatch(/tamper|mismatch/);
      expect(bad.results.filter((x: any) => x.valid).length).toBe(bad.results.length - 1); // only that tenant is affected
    } finally { await q(`UPDATE cds_audit_log_mt SET actor = (SELECT actor FROM cds_audit_log_mt WHERE tenant_id = $1 AND seq = 1) WHERE tenant_id = $1 AND seq = $2`, [tenant.id, seq]).catch(() => {}); await q('ALTER TABLE cds_audit_log_mt ENABLE TRIGGER USER'); }
    expect((await get('auditor', '/audit/verify?tenantId=nope-nope')).status).toBe(404); expect((await get('auditor', '/audit/verify?tenantId=a%20b')).status).toBe(400);
  });
});
