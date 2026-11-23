/**
 * Interpretation intake, queue and worker (interpretation engine, P3a) against REAL PostgreSQL (disposable database;
 * opt-in via ANUCLAW_TEST_PG_URL) over the real HTTP layer. Synthetic data only. No model is ever called.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bundlePayloadOf, sealReport, syntheticPosture } from '../../integrations/posturepulse/fixtures';
import { signBundle } from '../../integrations/posturepulse/upstream';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../container-runner', () => ({ runAgent: vi.fn(async () => ({ text: 'unused', artifacts: [] })) }));

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/examples/beaive-vitals.request.json'), 'utf8'));
const SKILL = 'physiological-signal-interpretation';
const POSTURE_SKILL = 'posture-analysis-interpretation';
const PP_SECRET = 'import-secret-'.padEnd(40, 'z');

describe.skipIf(!URL_)('interpretation intake, queue and worker (real PostgreSQL)', () => {
  const dbName = `anuclaw_int_${crypto.randomBytes(6).toString('hex')}`;
  const ADMIN = crypto.randomBytes(24).toString('hex');
  let admin: Client; let server: Server; let base: string;
  let mainPool: { end(): Promise<void> } | undefined;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let queue: typeof import('./queue');
  let worker: typeof import('./worker');
  let tenantA: { id: string; key: string }; let tenantB: { id: string; key: string }; let tenantNoSkill: { id: string; key: string };

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, {
      PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName,
      ANUCLAW_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
      ANUCLAW_IDENTITY_VAULT_KEY: crypto.randomBytes(32).toString('hex'),
      ANUCLAW_POSTUREPULSE_IMPORT_SECRET: PP_SECRET,
    });
    delete process.env.ANUCLAW_RATE_STORE; delete process.env.ANUCLAW_SELF_REGISTRATION;
    vi.resetModules();
    await (await import('../../db/connection')).ensureDbReady();
    mainPool = (await import('../../db/connection')).getDb();
    q = (await import('../../db')).db.query as any;
    queue = await import('./queue'); worker = await import('./worker');

    const express = (await import('express')).default;
    const app = express(); app.use(express.json({ limit: '2mb' }));
    app.use((await import('../tenancy/admin-routes')).createTenantAdminRouter({ adminKey: ADMIN }));
    app.use((await import('../skills/admin-routes')).createSkillAdminRouter({ adminKey: ADMIN }));
    app.use((await import('./routes')).default);
    app.use((await import('../../api/json-errors')).jsonBodyErrors);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    tenantA = await newTenant('Synthetic Alpha'); tenantB = await newTenant('Synthetic Bravo'); tenantNoSkill = await newTenant('Synthetic NoSkill');
    for (const t of [tenantA, tenantB]) for (const sk of [SKILL, POSTURE_SKILL]) expect((await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/${sk}`, {})).status).toBe(201);
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await mainPool?.end().catch(() => { /* already closed */ });
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const adm = (method: string, p: string, body?: unknown) =>
    fetch(base + p, { method, headers: { 'x-admin-key': ADMIN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const as = (key: string, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, { method, headers: { 'x-api-key': key, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  async function newTenant(name: string) {
    const r = await adm('POST', '/api/v1/admin/tenants', { company_name: name, email: `${name.toLowerCase().replace(/\W+/g, '-')}-${crypto.randomBytes(3).toString('hex')}@synthetic.invalid`, plan: 'enterprise' });
    const b = await r.json(); expect(r.status).toBe(201);
    return { id: b.tenant_id as string, key: b.api_key as string };
  }
  const payload = (over: (r: any) => void = () => {}) => {
    const r = JSON.parse(JSON.stringify(EXAMPLE)); r.tenantRequestId = `synthetic-${crypto.randomBytes(4).toString('hex')}`; over(r); return r;
  };
  const submit = (t: { key: string }, body: unknown, idem?: string) => as(t.key, 'POST', '/v1/interpretations', body, idem ? { 'idempotency-key': idem } : {});
  const drain = async () => { for (let i = 0; i < 50; i++) if ((await worker.runOnce()) === null) return; };

  it('accepts a request with 202 and a Location, never echoing identity, and stores identity only sealed', async () => {
    const r = await submit(tenantA, payload());
    expect(r.status).toBe(202);
    const job = await r.json();
    expect(r.headers.get('location')).toBe(`/v1/interpretations/${job.id}`);
    expect(job.status).toBe('queued');
    expect(JSON.stringify(job)).not.toMatch(/Synthetic Test Patient|synthetic@example/);

    const [src] = await q('SELECT payload_json, payload_sha256 FROM source_payloads WHERE job_id = $1', [job.id]);
    expect(src.payload_json).not.toMatch(/Synthetic Test Patient|synthetic@example|\+000000000|"identity"/);
    expect(job.originalPayloadSha256).toBe(src.payload_sha256);
    const [vault] = await q('SELECT sealed, kid FROM identity_vault WHERE job_id = $1', [job.id]);
    expect(Buffer.from(vault.sealed, 'base64').toString('utf8')).not.toContain('Synthetic');
    const row = (await q('SELECT * FROM interpretation_jobs WHERE id = $1', [job.id]))[0];
    expect(JSON.stringify(row)).not.toMatch(/Synthetic Test Patient|synthetic@example/);
  });

  it('the worker normalises the job; findings validate, carry provenance and contain no identifiers', async () => {
    const sub = await (await submit(tenantA, payload())).json();
    await drain();
    const status = await (await as(tenantA.key, 'GET', `/v1/interpretations/${sub.id}`)).json();
    expect(status.status).toBe('completed');
    expect(status.adapter).toEqual({ id: 'beaive-v1', version: '1.0.0' });
    const f = await (await as(tenantA.key, 'GET', `/v1/interpretations/${sub.id}/findings`)).json();
    expect(f.schemaVersion).toBe('normalized-findings/v1');
    expect(f.findingsSha256).toBe(status.findingsSha256);
    expect(f.provenance.originalPayloadSha256).toBe(sub.originalPayloadSha256);
    expect(f.findings.find((x: any) => x.findingKey === 'bp_systolic_mmhg').value).toBe(154);
    expect(JSON.stringify(f)).not.toMatch(/Synthetic Test Patient|synthetic@example|\+000000000/);
    const { validateNormalizedFindings } = await import('../contracts/validate');
    expect(validateNormalizedFindings(f)).toEqual({ ok: true });
  });

  it('reports findings_not_ready (409) before the worker has run', async () => {
    const sub = await (await submit(tenantA, payload())).json();
    const r = await as(tenantA.key, 'GET', `/v1/interpretations/${sub.id}/findings`);
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe('findings_not_ready');
    await drain();
  });

  // ── idempotency ────────────────────────────────────────────────────────────────────────────

  it('a retry with the same Idempotency-Key and body returns the original job (200, replayed)', async () => {
    const body = payload(); const key = `idem-${crypto.randomBytes(6).toString('hex')}`;
    const first = await submit(tenantA, body, key); const a = await first.json();
    const again = await submit(tenantA, body, key);
    expect(first.status).toBe(202); expect(again.status).toBe(200);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect((await again.json()).id).toBe(a.id);
    await drain();
  });

  it('the same key with a different body is 409, and creates nothing', async () => {
    const key = `idem-${crypto.randomBytes(6).toString('hex')}`;
    await submit(tenantA, payload(), key);
    const before = (await q('SELECT count(*)::int AS n FROM interpretation_jobs WHERE tenant_id = $1', [tenantA.id]))[0].n;
    const r = await submit(tenantA, payload(), key);
    expect(r.status).toBe(409); expect((await r.json()).error.code).toBe('idempotency_key_reused');
    expect((await q('SELECT count(*)::int AS n FROM interpretation_jobs WHERE tenant_id = $1', [tenantA.id]))[0].n).toBe(before);
    await drain();
  });

  it('eight simultaneous requests with one key create exactly one job', async () => {
    const body = payload(); const key = `race-${crypto.randomBytes(6).toString('hex')}`;
    const rs = await Promise.all(Array.from({ length: 8 }, () => submit(tenantA, body, key)));
    const ids = new Set<string>();
    for (const r of rs) { expect([200, 202]).toContain(r.status); ids.add((await r.json()).id); }
    expect(ids.size).toBe(1);
    expect(rs.filter((r) => r.status === 202)).toHaveLength(1);
    expect((await q('SELECT count(*)::int AS n FROM interpretation_jobs WHERE tenant_id = $1 AND idempotency_key = $2', [tenantA.id, key]))[0].n).toBe(1);
    await drain();
  });

  it('the same key under two different tenants is two independent jobs', async () => {
    const key = `shared-${crypto.randomBytes(6).toString('hex')}`;
    const a = await (await submit(tenantA, payload(), key)).json(); const b = await (await submit(tenantB, payload(), key)).json();
    expect(a.id).not.toBe(b.id);
    await drain();
  });

  it('refuses a malformed Idempotency-Key', async () => {
    const r = await submit(tenantA, payload(), 'short');
    expect(r.status).toBe(400); expect((await r.json()).error.code).toBe('bad_idempotency_key');
  });

  // ── isolation and gate ─────────────────────────────────────────────────────────────────────

  it("another tenant's job is a 404 on status and findings, and absent from its list", async () => {
    const sub = await (await submit(tenantA, payload())).json(); await drain();
    for (const p of [`/v1/interpretations/${sub.id}`, `/v1/interpretations/${sub.id}/findings`]) expect((await as(tenantB.key, 'GET', p)).status).toBe(404);
    const list = await (await as(tenantB.key, 'GET', '/v1/interpretations?limit=100')).json();
    expect(list.items.some((j: any) => j.id === sub.id)).toBe(false);
    expect((await as(tenantA.key, 'GET', '/v1/interpretations/not-a-job-id')).status).toBe(404);
  });

  it('a tenant without the skill is refused with 403 skill_not_assigned and nothing is stored', async () => {
    const r = await submit(tenantNoSkill, payload());
    expect(r.status).toBe(403); expect((await r.json()).error.code).toBe('skill_not_assigned');
    expect((await q('SELECT count(*)::int AS n FROM interpretation_jobs WHERE tenant_id = $1', [tenantNoSkill.id]))[0].n).toBe(0);
  });

  it('refuses an analysisType the skill does not accept, and unknown skills look like unassigned', async () => {
    expect((await submit(tenantA, payload((r) => { r.analysisType = 'posture_landmark'; }))).status).toBe(400);
    const r = await submit(tenantA, payload((x) => { x.skillId = 'no-such-skill'; }));
    expect(r.status).toBe(403); expect((await r.json()).error.code).toBe('skill_not_assigned');
  });

  // ── validation ─────────────────────────────────────────────────────────────────────────────

  it('rejects an invalid request with paths only (never values), and duplicate finding keys', async () => {
    const r = await submit(tenantA, payload((x) => { x.findings[0].confidence = 7; x.subject.identity.name = 'LeakCheckName'; delete x.source; }));
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.error.code).toBe('validation_failed'); expect(b.error.details.length).toBeGreaterThan(0);
    expect(JSON.stringify(b)).not.toMatch(/LeakCheckName|Synthetic Test Patient/);
    const dup = await submit(tenantA, payload((x) => { x.findings.push({ ...x.findings[0] }); }));
    expect(dup.status).toBe(400);
  });

  it('returns 400 for malformed JSON and 413 for an oversized body (not 500)', async () => {
    const bad = await as(tenantA.key, 'POST', '/v1/interpretations', '{"schemaVersion": ');
    expect(bad.status).toBe(400); expect((await bad.json()).error.code).toBe('invalid_json');
    const big = await as(tenantA.key, 'POST', '/v1/interpretations', JSON.stringify({ pad: 'x'.repeat(2.5 * 1024 * 1024) }));
    expect(big.status).toBe(413);
  });

  it('requires authentication', async () => {
    expect((await fetch(base + '/v1/interpretations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload()) })).status).toBe(401);
    expect((await fetch(base + '/v1/interpretations')).status).toBe(401);
  });

  // ── identity vault ─────────────────────────────────────────────────────────────────────────

  it('fails closed when identity is sent but the vault is not configured, and works without identity', async () => {
    const saved = process.env.ANUCLAW_IDENTITY_VAULT_KEY; delete process.env.ANUCLAW_IDENTITY_VAULT_KEY;
    try {
      const before = (await q('SELECT count(*)::int AS n FROM interpretation_jobs'))[0].n;
      const refused = await submit(tenantA, payload());
      expect(refused.status).toBe(503); expect((await refused.json()).error.code).toBe('identity_storage_unavailable');
      expect((await q('SELECT count(*)::int AS n FROM interpretation_jobs'))[0].n).toBe(before);
      const ok = await submit(tenantA, payload((x) => { delete x.subject.identity; }));
      expect(ok.status).toBe(202);
      expect((await q('SELECT 1 FROM identity_vault WHERE job_id = $1', [(await ok.json()).id]))).toHaveLength(0);
    } finally { process.env.ANUCLAW_IDENTITY_VAULT_KEY = saved; }
    await drain();
  });

  it('source payloads are immutable', async () => {
    const sub = await (await submit(tenantA, payload())).json();
    await expect(q(`UPDATE source_payloads SET payload_json = '{}' WHERE job_id = $1`, [sub.id])).rejects.toThrow(/immutable/);
    await drain();
  });

  // ── queue ──────────────────────────────────────────────────────────────────────────────────

  it('two workers claiming at once never receive the same job', async () => {
    await drain();
    for (let i = 0; i < 6; i++) await submit(tenantA, payload());
    const claims = (await Promise.all(Array.from({ length: 12 }, () => queue.claimNextJob()))).filter(Boolean) as Array<{ id: string }>;
    expect(claims).toHaveLength(6);
    expect(new Set(claims.map((c) => c.id)).size).toBe(6);
    for (const c of claims) await worker.processJob(c as any);
  });

  it('a superseded claim is fenced out: a stale worker cannot complete, fail or extend the job', async () => {
    await drain();
    const sub = await (await submit(tenantA, payload())).json();
    const t0 = Date.now();
    const stale = (await queue.claimNextJob(t0, 1000))!;
    expect(stale.id).toBe(sub.id);
    expect(await queue.claimNextJob(t0 + 500, 1000)).toBeNull(); // lease still valid
    const fresh = (await queue.claimNextJob(t0 + 2000, 60_000))!; // lease expired: reclaimed with a new token
    expect(fresh.id).toBe(sub.id); expect(fresh.attempts).toBe(2); expect(fresh.claim_token).not.toBe(stale.claim_token);

    expect(await queue.heartbeat(stale.id, stale.claim_token)).toBe(false);
    expect(await queue.failAttempt(stale, 'late_failure', true)).toBe('lost');
    expect(await worker.processJob(stale)).toBe('lost');
    expect((await q('SELECT status, claim_token, error_code FROM interpretation_jobs WHERE id = $1', [sub.id]))[0]).toMatchObject({ status: 'processing', claim_token: fresh.claim_token, error_code: null });

    expect(await worker.processJob(fresh)).toBe('completed');
    expect((await q('SELECT count(*)::int AS n FROM normalized_findings WHERE job_id = $1', [sub.id]))[0].n).toBe(1);
  });

  it('the final commit is fenced too: a claim stolen after the adapter ran leaves no findings and no state change', async () => {
    await drain();
    const sub = await (await submit(tenantA, payload())).json();
    const t0 = Date.now();
    const stale = (await queue.claimNextJob(t0, 1000))!;
    let fresh: Awaited<ReturnType<typeof queue.claimNextJob>> = null;
    const outcome = await worker.processJob(stale, () => Date.now(), {
      // The lease expires and another worker reclaims the job after this worker's heartbeat but before its commit.
      beforeCommit: async () => { fresh = await queue.claimNextJob(Date.now() + 120_000, 60_000); },
    });
    expect(fresh).not.toBeNull();
    expect(outcome).toBe('lost');
    expect((await q('SELECT count(*)::int AS n FROM normalized_findings WHERE job_id = $1', [sub.id]))[0].n).toBe(0);
    expect((await q('SELECT status, claim_token FROM interpretation_jobs WHERE id = $1', [sub.id]))[0]).toMatchObject({ status: 'processing', claim_token: fresh!.claim_token });
    expect(await worker.processJob(fresh!)).toBe('completed');
  });

  it('retries with exponential backoff and fails permanently after max attempts', async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(queue.backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000, 1_800_000, 1_800_000]);
    await drain();
    const sub = await (await submit(tenantA, payload())).json();
    await q('UPDATE interpretation_jobs SET max_attempts = 2 WHERE id = $1', [sub.id]);
    const t = Date.now();
    const c1 = (await queue.claimNextJob(t))!;
    expect(await queue.failAttempt(c1, 'adapter_error', false, t)).toBe('retry');
    const [r1] = await q('SELECT status, run_after, claim_token FROM interpretation_jobs WHERE id = $1', [sub.id]);
    expect(r1).toMatchObject({ status: 'queued', claim_token: null }); expect(Number(r1.run_after)).toBe(t + 30_000);
    expect(await queue.claimNextJob(t + 1000)).toBeNull(); // backoff not yet elapsed
    const c2 = (await queue.claimNextJob(t + 30_001))!;
    expect(await queue.failAttempt(c2, 'adapter_error', false, t + 30_001)).toBe('failed');
    expect((await q('SELECT status, error_code FROM interpretation_jobs WHERE id = $1', [sub.id]))[0]).toMatchObject({ status: 'failed', error_code: 'adapter_error' });
  });

  it('a permanent adapter error fails at once; a missing adapter is permanent too', async () => {
    await drain();
    const sub = await (await submit(tenantA, payload())).json();
    await q(`UPDATE interpretation_jobs SET skill_id = 'clinical-report-generation' WHERE id = $1`, [sub.id]); // adapter with no implementation
    expect(await worker.runOnce()).toBe('failed');
    expect((await q('SELECT status, error_code FROM interpretation_jobs WHERE id = $1', [sub.id]))[0]).toMatchObject({ status: 'failed', error_code: 'adapter_unavailable' });
  });


  // ── PosturePulse (native payload) ──────────────────────────────────────────────────────────

  type Posture = ReturnType<typeof syntheticPosture>;
  const posture = (f: Posture, mode: 'signed' | 'unsigned' = 'signed', subject = f.session.subjectPseudoId) => ({
    schemaVersion: 'interpretation-request/v1', tenantRequestId: `pp-${crypto.randomBytes(4).toString('hex')}`, skillId: POSTURE_SKILL, analysisType: 'posture_landmark',
    subject: { externalRef: subject }, acquisition: { capturedAt: new Date().toISOString(), method: 'video_4view' },
    source: { application: 'PosturePulse', modelName: 'synthetic-pose', modelVersion: '0' },
    nativePayload: mode === 'signed'
      ? { format: 'posturepulse-assessment/v0', bundle: signBundle(bundlePayloadOf(f) as any, PP_SECRET) }
      : { format: 'posturepulse-assessment/v0', unsigned: { consentRecord: f.consentRecord, session: f.session, report: f.report, symptomReports: f.symptomReports } },
  });
  const jobCount = async (t: { id: string }) => (await q('SELECT count(*)::int AS n FROM interpretation_jobs WHERE tenant_id = $1', [t.id]))[0].n;

  it('PosturePulse: a signed bundle is verified at intake, normalised, and its signature is not stored', async () => {
    const body = posture(syntheticPosture());
    const r = await submit(tenantA, body); expect(r.status).toBe(202);
    const sub = await r.json(); await drain();
    const f = await (await as(tenantA.key, 'GET', `/v1/interpretations/${sub.id}/findings`)).json();
    expect(f.sourceVerification).toMatchObject({ level: 'signed_bundle_verified', digestStatus: 'upstream_signed_claim_not_recomputable', reportId: 'report-synthetic-001' });
    expect(f.flags.some((x: any) => x.type === 'unverified_source')).toBe(false);
    expect(f.findings[0]).toMatchObject({ findingKey: 'shoulder_height_difference.bilateral', side: 'bilateral', tier: 'proxy', reference: { status: 'draft' } });
    expect(f.notMeasurable).toHaveLength(1);
    expect(f.provenance.adapter).toEqual({ id: 'posturepulse-v1', version: '1.0.0' });
    const [src] = await q('SELECT payload_json FROM source_payloads WHERE job_id = $1', [sub.id]);
    expect(src.payload_json).not.toContain(body.nativePayload.bundle!.signature);
    const { validateNormalizedFindings } = await import('../contracts/validate');
    expect(validateNormalizedFindings(f)).toEqual({ ok: true });
  });

  it('PosturePulse: a retried signed bundle with the same Idempotency-Key replays the original job', async () => {
    const body = posture(syntheticPosture()); const key = `pp-${crypto.randomBytes(6).toString('hex')}`;
    const a = await (await submit(tenantA, body, key)).json(); const again = await submit(tenantA, body, key);
    expect(again.status).toBe(200); expect((await again.json()).id).toBe(a.id);
    await drain();
  });

  it('PosturePulse: an unsigned payload is accepted but stays unverified, with a blocking flag and the excluded row preserved', async () => {
    const sub = await (await submit(tenantA, posture(syntheticPosture(), 'unsigned'))).json(); await drain();
    const f = await (await as(tenantA.key, 'GET', `/v1/interpretations/${sub.id}/findings`)).json();
    expect(f.sourceVerification.level).toBe('unverified_payload');
    expect(f.flags.find((x: any) => x.type === 'unverified_source')).toMatchObject({ severity: 'blocking' });
    expect(f.findings.find((x: any) => x.sourceKey === 'head_forward_offset')).toMatchObject({ excluded: { reason: 'synthetic exclusion' }, valueStatus: 'missing' });
  });

  it('PosturePulse: a tampered bundle, a missing secret and a subject mismatch are refused and store nothing', async () => {
    const before = await jobCount(tenantA);
    const tampered = posture(syntheticPosture()); (tampered.nativePayload.bundle!.payload.report.rows[0].estimate as any).value = 9.9;
    const t = await submit(tenantA, tampered); expect(t.status).toBe(403); expect((await t.json()).error.code).toBe('bad_signature');

    const saved = process.env.ANUCLAW_POSTUREPULSE_IMPORT_SECRET; delete process.env.ANUCLAW_POSTUREPULSE_IMPORT_SECRET;
    try { const n = await submit(tenantA, posture(syntheticPosture())); expect(n.status).toBe(503); expect((await n.json()).error.code).toBe('import_secret_not_configured'); }
    finally { process.env.ANUCLAW_POSTUREPULSE_IMPORT_SECRET = saved; }

    const m = await submit(tenantA, posture(syntheticPosture(), 'signed', 'a-different-subject'));
    expect(m.status).toBe(422); expect((await m.json()).error.code).toBe('subject_mismatch');
    const bad = syntheticPosture(); delete (bad.report as any).provenance; sealReport(bad.report);
    const c = await submit(tenantA, posture(bad, 'unsigned')); expect(c.status).toBe(422); expect((await c.json()).error.code).toBe('contract_violation');
    expect(await jobCount(tenantA)).toBe(before);
  });

  it('each skill reads exactly one input form: generic findings vs native payload', async () => {
    const pp = posture(syntheticPosture());
    const generic = { ...pp, findings: payload().findings }; delete (generic as any).nativePayload;
    const g = await submit(tenantA, generic); expect(g.status).toBe(400); expect((await g.json()).error.code).toBe('input_form_not_accepted');
    const both = await submit(tenantA, { ...pp, findings: payload().findings }); expect(both.status).toBe(400); expect((await both.json()).error.code).toBe('validation_failed');
    const neither = { ...pp }; delete (neither as any).nativePayload; expect((await submit(tenantA, neither)).status).toBe(400);
    const vitalsWithNative = { ...payload(), nativePayload: pp.nativePayload }; delete (vitalsWithNative as any).findings;
    const v = await submit(tenantA, vitalsWithNative); expect(v.status).toBe(400); expect((await v.json()).error.code).toBe('input_form_not_accepted');
  });

  it('PosturePulse symptom reports become a blocking flag and their free text is not stored in findings', async () => {
    const f = syntheticPosture();
    f.symptomReports = [{ symptomReportId: 'sr1', sessionId: f.session.sessionId, reportedAt: new Date().toISOString(), symptoms: ['dizziness'], severity: 'moderate', freeText: 'LeakCheckFreeText', triggeredAction: 'pause' }];
    const sub = await (await submit(tenantA, posture(f, 'unsigned'))).json(); await drain();
    const out = await (await as(tenantA.key, 'GET', `/v1/interpretations/${sub.id}/findings`)).json();
    expect(out.flags.find((x: any) => x.type === 'symptom_reported')).toMatchObject({ severity: 'blocking' });
    expect(JSON.stringify(out)).not.toContain('LeakCheckFreeText');
  });

  it('findingsSha256 covers verification, so a verified and an unverified copy of the same rows cannot share a hash', async () => {
    const f = syntheticPosture();
    const a = await (await submit(tenantA, posture(f, 'signed'))).json(); const b = await (await submit(tenantA, posture(f, 'unsigned'))).json(); await drain();
    const [ja, jb] = [a, b].map((x) => x.id);
    const ha = (await q('SELECT findings_sha256 FROM interpretation_jobs WHERE id = $1', [ja]))[0].findings_sha256;
    const hb = (await q('SELECT findings_sha256 FROM interpretation_jobs WHERE id = $1', [jb]))[0].findings_sha256;
    expect(ha).not.toBe(hb);
  });

  // ── quota, listing, audit ──────────────────────────────────────────────────────────────────

  it('submitting counts against the monthly usage; polling does not', async () => {
    const t = await newTenant('Synthetic Quota'); await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/${SKILL}`, {});
    const usage = async () => { await new Promise((r) => setTimeout(r, 150)); return Number((await q('SELECT usage_this_month FROM tenants WHERE tenant_id = $1', [t.id]))[0].usage_this_month); };
    const u0 = await usage();
    const sub = await (await submit(t, payload())).json();
    const u1 = await usage(); expect(u1).toBe(u0 + 1);
    for (let i = 0; i < 5; i++) { await as(t.key, 'GET', `/v1/interpretations/${sub.id}`); await as(t.key, 'GET', '/v1/interpretations'); }
    expect(await usage()).toBe(u1);
    await drain();
  });

  it('lists only the caller\'s jobs, newest first, with limit and offset', async () => {
    const t = await newTenant('Synthetic Lister'); await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/${SKILL}`, {});
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) { ids.push((await (await submit(t, payload())).json()).id); await new Promise((r) => setTimeout(r, 5)); }
    const all = await (await as(t.key, 'GET', '/v1/interpretations')).json();
    expect(all.items.map((j: any) => j.id)).toEqual([...ids].reverse());
    const page = await (await as(t.key, 'GET', '/v1/interpretations?limit=1&offset=1')).json();
    expect(page.items.map((j: any) => j.id)).toEqual([ids[1]]);
    await drain();
  });

  it('writes hash-chained audit entries (ids and hashes only) for accept and complete', async () => {
    const t = await newTenant('Synthetic Audited'); await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/${SKILL}`, {});
    const sub = await (await submit(t, payload())).json(); await drain();
    const a = await (await adm('GET', `/api/v1/admin/tenants/${t.id}/audit`)).json();
    const types = a.entries.map((e: any) => e.event_type);
    expect(types).toContain('interpretation.accepted'); expect(types).toContain('interpretation.completed');
    expect(a.chain.valid).toBe(true);
    const text = JSON.stringify(a.entries);
    expect(text).toContain(sub.id);
    expect(text).not.toMatch(/Synthetic Test Patient|synthetic@example|SYNTH-SUBJECT-0001|\+000000000/);
  });
});
