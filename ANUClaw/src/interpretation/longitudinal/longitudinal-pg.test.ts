/**
 * Longitudinal timeline and compare (interpretation engine, P5) against REAL PostgreSQL (disposable database; opt-in via
 * ANUCLAW_TEST_PG_URL) over the real HTTP layer. Synthetic data only. No model is called.
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

describe.skipIf(!URL_)('longitudinal timeline and compare (real PostgreSQL)', () => {
  const dbName = `anuclaw_rpt_${crypto.randomBytes(6).toString('hex')}`;
  const ADMIN = crypto.randomBytes(24).toString('hex');
  let admin: Client; let server: Server; let base: string;
  let mainPool: { end(): Promise<void> } | undefined;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let jobs: typeof import('../jobs/worker'); let reports: typeof import('../reports/worker'); let rqueue: typeof import('../reports/queue');
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
    jobs = await import('../jobs/worker'); reports = await import('../reports/worker'); rqueue = await import('../reports/queue'); validate = await import('../contracts/validate');

    const express = (await import('express')).default;
    const app = express(); app.use(express.json({ limit: '2mb' }));
    app.use((await import('../tenancy/admin-routes')).createTenantAdminRouter({ adminKey: ADMIN }));
    app.use((await import('../skills/admin-routes')).createSkillAdminRouter({ adminKey: ADMIN }));
    app.use((await import('../jobs/routes')).default);
    app.use((await import('../longitudinal/routes')).default);
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
  const drainReports = async () => { for (let i = 0; i < 500; i++) if ((await reports.runOnce()) === null) return; };
  const reportOf = async (jobId: string) => (await q('SELECT * FROM interpretation_reports WHERE job_id = $1 ORDER BY version', [jobId]))[0];
  const clean = async () => { await drainJobs(); await drainReports(); };


  // ── helpers ────────────────────────────────────────────────────────────────────────────────

  /** A scan of `subject` captured at `capturedAt`, with hr/spo2 uncertainty so the numeric rule applies. */
  const scanBody = (subject: string, capturedAt: string, hr: number, over: (r: any) => void = () => {}) => vitals((r) => {
    r.subject.externalRef = subject; r.acquisition.capturedAt = capturedAt;
    for (const f of r.findings) { if (f.key === 'hr') { f.value = hr; f.uncertainty = { plusMinus: 3 }; } if (f.key === 'spo2') f.uncertainty = { plusMinus: 1 }; }
    over(r);
  });
  const mk = async (b: unknown, key = tenant.key) => { const id = (await (await as(key, 'POST', '/v1/interpretations', b)).json()).id as string; await drainJobs(); return id; };
  const cmp = (key: string, a: string, b: string) => as(key, 'GET', `/v1/interpretations/${a}/compare?with=${b}`);
  const tl = (key: string, id: string, qs = '') => as(key, 'GET', `/v1/interpretations/${id}/timeline${qs}`);
  const HR = 'hr_bpm';
  let hrKey = 'hr';

  it('setup: find the finding key the adapter gives heart rate', async () => {
    const id = await mk(scanBody('SUBJ-SETUP', '2026-08-01T08:00:00Z', 70));
    const doc = JSON.parse((await q('SELECT document_json FROM normalized_findings WHERE job_id = $1', [id]))[0].document_json);
    hrKey = doc.findings.find((f: any) => f.sourceKey === 'hr')?.findingKey ?? doc.findings.find((f: any) => /hr|heart/i.test(f.findingKey)).findingKey;
    expect(typeof hrKey).toBe('string'); void HR;
  });

  // ── compare ────────────────────────────────────────────────────────────────────────────────

  it('compares two scans of the same subject: ordered by capture time whichever way round they are asked, neutral, valid, no identity', async () => {
    const subject = 'SUBJ-CMP-ZQ-1';
    const later = await mk(scanBody(subject, '2026-08-10T08:00:00Z', 95));   // submitted FIRST but captured later
    const earlier = await mk(scanBody(subject, '2026-08-03T08:00:00Z', 70));
    const r1 = await cmp(tenant.key, earlier, later); const r2 = await cmp(tenant.key, later, earlier);
    expect(r1.status).toBe(200); const a = await r1.json(); const b = await (r2).json();
    expect(a.earlier.jobId).toBe(earlier); expect(a.later.jobId).toBe(later); expect(b.earlier.jobId).toBe(earlier);
    expect(a.comparisonSha256).toBe(b.comparisonSha256);
    expect(a.intervalSeconds).toBe(7 * 86400);
    const hr = a.comparisons.find((c: any) => c.findingKey === hrKey);
    expect(hr).toMatchObject({ status: 'beyond_uncertainty', delta: 25, laterIs: 'higher', combinedUncertainty: expect.closeTo(Math.sqrt(18), 6) });
    expect(a.flags).toEqual([]); expect(validate.validateLongitudinalComparison(a)).toEqual({ ok: true });
    expect(JSON.stringify(a)).not.toContain(subject); expect(JSON.stringify(a)).not.toContain(tenant.id);
    expect(a.comparisons.find((c: any) => c.reason === 'no_uncertainty')).toBeDefined(); // findings without a reported uncertainty are not compared
    expect(r1.headers.get('cache-control')).toBe('no-store');
  });

  it('two scans minutes apart that disagree: a discrepancy flag, not a trend', async () => {
    const s = 'SUBJ-CMP-ZQ-2';
    const a = await mk(scanBody(s, '2026-08-10T08:00:00Z', 70)); const b = await mk(scanBody(s, '2026-08-10T08:07:00Z', 100));
    const r = await (await cmp(tenant.key, a, b)).json();
    expect(r.flags).toEqual([expect.objectContaining({ type: 'short_interval_discrepancy', severity: 'attention', findingKeys: [hrKey] })]);
    expect(r.comparisons.find((c: any) => c.findingKey === hrKey)).toMatchObject({ status: 'beyond_uncertainty', shortInterval: true });
  });

  it('a change of source model makes the numeric findings not comparable', async () => {
    const s = 'SUBJ-CMP-ZQ-3';
    const a = await mk(scanBody(s, '2026-08-01T08:00:00Z', 70)); const b = await mk(scanBody(s, '2026-08-05T08:00:00Z', 90, (r) => { r.source.modelVersion = 'synthetic-fixture-v2'; }));
    const r = await (await cmp(tenant.key, a, b)).json();
    expect(r.comparisons.find((c: any) => c.findingKey === hrKey)).toMatchObject({ status: 'not_comparable', reason: 'source_model_changed' });
    expect(r.flags.map((f: any) => f.type)).toEqual(['source_model_changed']);
  });

  it('refusals: itself, another subject, another skill, not completed, unknown, another tenant, bad input', async () => {
    const other = await mk(scanBody('SUBJ-CMP-ZQ-5', '2026-08-02T08:00:00Z', 70));
    const ppBody = posture('signed') as any; const ppSubject = ppBody.subject.externalRef as string;
    const a = await mk(scanBody(ppSubject, '2026-08-01T08:00:00Z', 70)); const pp = await mk(ppBody);
    const pending = (await (await as(tenant.key, 'POST', '/v1/interpretations', scanBody(ppSubject, '2026-08-03T08:00:00Z', 71))).json()).id as string; // not processed yet
    const err = async (r: Response, status: number, code: string) => { expect(r.status).toBe(status); expect((await r.json()).error.code).toBe(code); };
    await err(await cmp(tenant.key, a, a), 400, 'validation_failed');
    await err(await cmp(tenant.key, a, other), 409, 'different_subjects');
    await err(await cmp(tenant.key, a, pp), 409, 'different_skills');
    await err(await cmp(tenant.key, a, pending), 409, 'findings_not_ready');
    await err(await cmp(tenant.key, a, 'job_000000000000000000000000'), 404, 'not_found');
    await err(await cmp(tenant.key, a, 'nope'), 404, 'not_found');
    await err(await as(tenant.key, 'GET', `/v1/interpretations/${a}/compare`), 400, 'validation_failed');
    const t2 = await newTenant('Synthetic Other Tenant'); await adm('PUT', `/api/v1/admin/tenants/${t2.id}/skills/${VITALS}`, {});
    await err(await cmp(t2.key, a, a), 400, 'validation_failed');
    await err(await cmp(t2.key, a, other), 404, 'not_found'); // another tenant's jobs do not exist for it
    const mine = await mk(scanBody(ppSubject, '2026-08-04T08:00:00Z', 70), t2.key);
    await err(await cmp(t2.key, mine, a), 404, 'not_found'); // and a pair cannot straddle tenants
    expect((await fetch(`${base}/v1/interpretations/${a}/compare?with=${other}`)).status).toBe(401);
    await drainJobs();
  });

  it('two tenants using the SAME subject reference never see each other: identical refs are separate subjects', async () => {
    const t2 = await newTenant('Synthetic Same Ref'); await adm('PUT', `/api/v1/admin/tenants/${t2.id}/skills/${VITALS}`, {});
    const mine = await mk(scanBody('SUBJ-SHARED-REF', '2026-08-01T08:00:00Z', 70)); const theirs = await mk(scanBody('SUBJ-SHARED-REF', '2026-08-02T08:00:00Z', 70), t2.key);
    const t = await (await tl(tenant.key, mine)).json();
    expect(t.items.map((i: any) => i.jobId)).toContain(mine); expect(t.items.map((i: any) => i.jobId)).not.toContain(theirs);
    expect((await cmp(tenant.key, mine, theirs)).status).toBe(404);
  });

  // ── timeline ───────────────────────────────────────────────────────────────────────────────

  it('timeline: the same subject and skill only, oldest first, no subject reference, with the report state', async () => {
    const ppBody = posture('signed') as any; const s = ppBody.subject.externalRef as string;
    const c = await mk(scanBody(s, '2026-09-03T08:00:00Z', 80)); const a = await mk(scanBody(s, '2026-09-01T08:00:00Z', 70)); const b = await mk(scanBody(s, '2026-09-02T08:00:00Z', 75));
    await mk(scanBody('SUBJ-TL-ZQ-OTHER', '2026-09-02T09:00:00Z', 75)); await mk(ppBody);
    await drainReports();
    const res = await tl(tenant.key, b); const t = await res.json();
    expect(res.status).toBe(200); const mine3 = t.items.filter((i: any) => [a, b, c].includes(i.jobId));
    expect(mine3.map((i: any) => i.jobId)).toEqual([a, b, c]); expect(mine3.map((i: any) => i.self)).toEqual([false, true, false]);
    expect(t.items.every((i: any) => i.skillId === VITALS)).toBe(true); // the signed posture scan of the same subject is another skill
    expect(t.items.map((i: any) => Date.parse(i.capturedAt))).toEqual([...t.items.map((i: any) => Date.parse(i.capturedAt))].sort((x: number, y: number) => x - y));
    expect(t).toMatchObject({ skillId: VITALS, truncated: false });
    expect(t.items.find((i: any) => i.jobId === a)).toMatchObject({ status: 'completed', capturedAt: '2026-09-01T08:00:00Z', report: { version: 1, reviewState: 'ai_reviewed' } });
    expect(JSON.stringify(t)).not.toContain(s); expect(JSON.stringify(t)).not.toContain('SUBJ-TL-ZQ-OTHER');
    expect(t.series).toBeUndefined();
    // another skill's scans of the same subject are available on request
    const pp = (await (await tl(tenant.key, b, `?skillId=${POSTURE}`)).json()).items; expect(pp.length).toBeGreaterThanOrEqual(1); expect(pp.every((i: any) => i.skillId === POSTURE)).toBe(true);
  });

  it('timeline with findingKey: the series and neutral steps; absent and uncertainty-less points are not invented', async () => {
    const s = 'SUBJ-TL-ZQ-2';
    const ids = [await mk(scanBody(s, '2026-09-01T08:00:00Z', 70)), await mk(scanBody(s, '2026-09-02T08:00:00Z', 71)), await mk(scanBody(s, '2026-09-03T08:00:00Z', 90))];
    const tr = await tl(tenant.key, ids[0], `?findingKey=${hrKey}`); const t = await tr.json();
    expect(t.series.findingKey).toBe(hrKey); expect(t.series.points.map((p: any) => p.value)).toEqual([70, 71, 90]);
    expect(t.series.steps.map((x: any) => [x.status, x.laterIs ?? null])).toEqual([['within_uncertainty', null], ['beyond_uncertainty', 'higher']]);
    const none = await (await tl(tenant.key, ids[0], "?findingKey=does_not_exist")).json();
    expect(none.series.points.every((p: any) => p.status === 'absent' && p.value === null)).toBe(true); expect(none.series.steps.every((x: any) => x.status === 'not_comparable')).toBe(true);
  });

  it('timeline limits: keeps the most recent scans, flags truncation, validates input', async () => {
    const s = 'SUBJ-TL-ZQ-3';
    const ids: string[] = []; for (let i = 1; i <= 4; i++) ids.push(await mk(scanBody(s, `2026-10-0${i}T08:00:00Z`, 70 + i)));
    const t = await (await tl(tenant.key, ids[3], '?limit=2')).json();
    expect(t.items.map((i: any) => i.jobId)).toEqual(ids.slice(2)); expect(t).toMatchObject({ count: 2, truncated: true });
    for (const qs of ['?limit=0', '?limit=abc', '?findingKey=a%20b', '?skillId=BAD%20ID']) expect((await tl(tenant.key, ids[0], qs)).status, qs).toBe(400);
    expect((await tl(tenant.key, 'job_nope')).status).toBe(404);
  });

  // ── erasure ────────────────────────────────────────────────────────────────────────────────

  it('after erasure the scans vanish from timelines and comparisons (410 when addressed directly), and nothing leaks into the others', async () => {
    const s = 'SUBJ-ERASE-P5'; const keep = 'SUBJ-KEEP-P5';
    const a = await mk(scanBody(s, '2026-11-01T08:00:00Z', 70)); const b = await mk(scanBody(s, '2026-11-02T08:00:00Z', 71)); const k = await mk(scanBody(keep, '2026-11-02T08:00:00Z', 71));
    expect((await (await tl(tenant.key, a)).json()).items).toHaveLength(2);
    expect((await as(tenant.key, 'POST', '/v1/subject-erasures', { externalRef: s, confirm: true })).status).toBe(200);
    for (const r of [await cmp(tenant.key, a, b), await tl(tenant.key, a), await tl(tenant.key, b, `?findingKey=${hrKey}`)]) { expect(r.status).toBe(410); expect((await r.json()).error.code).toBe('subject_erased'); }
    expect((await cmp(tenant.key, k, a)).status).toBe(410);
    expect((await (await tl(tenant.key, k)).json()).items.map((i: any) => i.jobId)).toEqual([k]);
  });

  it('tampered stored findings are refused, not compared', async () => {
    const s = 'SUBJ-TAMPER-P5';
    const a = await mk(scanBody(s, '2026-11-01T08:00:00Z', 70)); const b = await mk(scanBody(s, '2026-11-02T08:00:00Z', 71));
    await q(`UPDATE normalized_findings SET document_json = replace(document_json, '"value":71', '"value":99') WHERE job_id = $1`, [b]);
    const r = await cmp(tenant.key, a, b); expect(r.status).toBe(409);
    const code = (await r.json()).error.code; expect(code).toBe('integrity_error');
  });
});
