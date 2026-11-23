/**
 * Report queue and the governance stage (interpretation engine, P4a) against REAL PostgreSQL (disposable database;
 * opt-in via ANUCLAW_TEST_PG_URL) over the real HTTP layer. Synthetic data only. No model is ever called.
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

describe.skipIf(!URL_)('report queue and governance stage (real PostgreSQL)', () => {
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
  // Stages 1-2 only (stage 3 is covered in report-layers-pg.test.ts): stop once a report is narrated. `clean` runs everything to the end.
  const drainReports = async () => { for (let i = 0; i < 50; i++) { const o = await reports.runOnce(); if (o === null) return; if (o === 'narrated') await q(`UPDATE interpretation_reports SET run_after = 9000000000000 WHERE status = 'narrated' AND run_after < 9000000000000`); } };
  const reportOf = async (jobId: string) => (await q('SELECT * FROM interpretation_reports WHERE job_id = $1 ORDER BY version', [jobId]))[0];
  const clean = async () => { await drainJobs(); for (let i = 0; i < 50; i++) if ((await reports.runOnce()) === null) return; };

  // ── enqueue ────────────────────────────────────────────────────────────────────────────────

  it('a completed job queues exactly one report, bound to the findings hash; a queued job has none', async () => {
    await clean();
    const id = await submit(vitals());
    expect(await reportOf(id)).toBeUndefined();
    await drainJobs();
    const rows = await q('SELECT * FROM interpretation_reports WHERE job_id = $1', [id]);
    expect(rows).toHaveLength(1);
    const job = (await q('SELECT findings_sha256 FROM interpretation_jobs WHERE id = $1', [id]))[0];
    expect(rows[0]).toMatchObject({ status: 'queued', version: 1, attempts: 0, findings_sha256: job.findings_sha256, governance_json: null, review_state: null });
    await drainReports();
  });

  it('the report is queued in the SAME transaction as the completion: if it cannot be queued, the job does not complete', async () => {
    await clean();
    const id = await submit(vitals());
    await q('ALTER TABLE interpretation_reports RENAME TO interpretation_reports_x');
    try { expect(await jobs.runOnce()).toBe('retry'); } finally { await q('ALTER TABLE interpretation_reports_x RENAME TO interpretation_reports'); }
    expect((await q('SELECT status FROM interpretation_jobs WHERE id = $1', [id]))[0].status).toBe('queued');
    expect((await q('SELECT 1 FROM normalized_findings WHERE job_id = $1', [id]))).toHaveLength(0);
    await q('UPDATE interpretation_jobs SET run_after = 0 WHERE id = $1', [id]); await drainJobs();
    expect(await q('SELECT 1 FROM interpretation_reports WHERE job_id = $1', [id])).toHaveLength(1);
    await drainReports();
  });

  // ── governance stage ───────────────────────────────────────────────────────────────────────

  it('the report worker governs the findings: valid governance/v1, bound to the findings hash, hashed and persisted', async () => {
    await clean();
    const id = await submit(vitals()); await drainJobs();
    expect(await reports.runOnce()).toBe('governed');
    const r = await reportOf(id);
    expect(r).toMatchObject({ status: 'governed', claim_token: null, review_state: null, clinical_json: null, layman_json: null });
    const gov = JSON.parse(r.governance_json);
    expect(validate.validateGovernance(gov)).toEqual({ ok: true });
    expect(gov.findingsSha256).toBe(r.findings_sha256);
    expect(r.governance_sha256).toBe(contentHash(gov));
    expect(gov.referral).toMatchObject({ level: 'see_clinician_soon', textId: 'referral-advisory' });
    expect(gov.route).toEqual({ state: 'eligible_for_ai_review', reasons: [], followUp: true });
    expect(gov.positions.find((p: any) => p.findingKey === 'bp_systolic_mmhg').position).toBe('above');
  });

  it("governance applies the adapter's own declarations: its risk indicators, high-risk findings and sanity bounds", async () => {
    await clean();
    const id = await submit(vitals()); await drainJobs(); await drainReports();
    const gov = JSON.parse((await reportOf(id)).governance_json);
    const reason = (code: string) => gov.referral.reasons.find((x: any) => x.code === code);
    expect(reason('risk_indicator_flagged').findingKeys).toEqual(['bp_risk_category', 'hba1c_risk_category', 'fasting_glucose_risk_category']);
    expect(reason('high_risk_outside_reference').findingKeys).toEqual(['bp_systolic_mmhg', 'bp_diastolic_mmhg', 'hba1c_percent']);

    const odd = await submit(vitals((r) => { r.findings.find((x: any) => x.key === 'hr').value = 400; })); // not a heart rate any device could have measured
    await drainJobs(); await drainReports();
    const g2 = JSON.parse((await reportOf(odd)).governance_json);
    expect(g2.flags.find((x: any) => x.type === 'implausible_value')).toMatchObject({ severity: 'blocking', findingKeys: ['heart_rate_bpm'] });
    expect(g2.route).toMatchObject({ state: 'awaiting_clinician', reasons: ['implausible_value'] });

    const wrongUnit = await submit(vitals((r) => { r.findings.find((x: any) => x.key === 'hr').unit = 'bps'; }));
    await drainJobs(); await drainReports();
    expect(JSON.parse((await reportOf(wrongUnit)).governance_json).route).toMatchObject({ state: 'awaiting_clinician', reasons: ['unit_mismatch'] });
  });

  it('governance output holds no subject reference, identity or source values', async () => {
    await clean();
    const ref = 'GOV-REF-' + crypto.randomBytes(3).toString('hex');
    const id = await submit(vitals((r) => { r.subject.externalRef = ref; r.subject.identity = { name: 'Governance Person Qz', email: 'gov.qz@example.invalid' }; }));
    await drainJobs(); await drainReports();
    const text = (await reportOf(id)).governance_json as string;
    for (const s of [ref, 'Governance Person Qz', 'gov.qz@example.invalid', '154', '6.89']) expect(text, s).not.toContain(s);
  });

  it('a PosturePulse payload with an unsigned source is governed too: blocking flag, held for a clinician, advisory triggered', async () => {
    await clean();
    const id = await submit(posture('unsigned')); await drainJobs(); await drainReports();
    const gov = JSON.parse((await reportOf(id)).governance_json);
    expect(gov.route).toMatchObject({ state: 'awaiting_clinician', reasons: ['unverified_source'] });
    expect(gov.referral.reasons.map((x: any) => x.code)).toEqual(['blocking_flag']);
    const pos = Object.fromEntries(gov.positions.map((p: any) => [p.findingKey, p]));
    expect(pos['shoulder_height_difference.bilateral']).toMatchObject({ position: 'no_reference', basis: 'draft_reference' }); // never normal/abnormal against a draft
    expect(validate.validateGovernance(gov)).toEqual({ ok: true });
  });

  it('a verified PosturePulse bundle is eligible for AI review: no blocking flag, so no clinician hold', async () => {
    await clean();
    const id = await submit(posture('signed')); await drainJobs(); await drainReports();
    const gov = JSON.parse((await reportOf(id)).governance_json);
    expect(gov.route.state).toBe('eligible_for_ai_review');
    expect(gov.referral).toBeNull(); // a proxy against a draft reference triggers nothing
    expect(gov.advisory).toBeNull();
  });

  it('writes a hash-chained audit entry (ids and hashes only) and no entry for work that did not commit', async () => {
    await clean();
    const t = await newTenant('Synthetic Report Audit'); await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/${VITALS}`, {});
    const body = vitals();
    const sub = await (await as(t.key, 'POST', '/v1/interpretations', body)).json(); await drainJobs(); await drainReports();
    const a = await (await adm('GET', `/api/v1/admin/tenants/${t.id}/audit`)).json();
    const e = a.entries.find((x: any) => x.event_type === 'interpretation.governed');
    expect(e.payload).toMatchObject({ job_id: sub.id, route_state: 'eligible_for_ai_review', referral: true, ruleset_version: '1.0.0' });
    expect(a.chain.valid).toBe(true);
    expect(JSON.stringify(a.entries)).not.toMatch(/SYNTH-SUBJECT|Synthetic Test Patient|synthetic@example/);
  });

  // ── queue behaviour ────────────────────────────────────────────────────────────────────────

  it('concurrent claimers never receive the same report', async () => {
    await clean();
    for (let i = 0; i < 5; i++) await submit(vitals());
    await drainJobs();
    const claims = (await Promise.all(Array.from({ length: 10 }, () => rqueue.claimNextReport()))).filter(Boolean) as Array<{ id: string }>;
    expect(claims).toHaveLength(5); expect(new Set(claims.map((c) => c.id)).size).toBe(5);
    for (const c of claims) await reports.processReport(c as any);
  });

  it('the commit is fenced: a claim stolen after governance ran leaves no governance output and no audit entry', async () => {
    await clean();
    const id = await submit(vitals()); await drainJobs();
    const t0 = Date.now();
    const stale = (await rqueue.claimNextReport(t0, 1000))!;
    expect(stale.job_id).toBe(id);
    let fresh: Awaited<ReturnType<typeof rqueue.claimNextReport>> = null;
    const out = await reports.processReport(stale, () => Date.now(), { beforeCommit: async () => { fresh = await rqueue.claimNextReport(Date.now() + 600_000, 120_000); } });
    expect(fresh).not.toBeNull(); expect(out).toBe('lost');
    expect((await reportOf(id))).toMatchObject({ status: 'generating', governance_json: null, claim_token: fresh!.claim_token });
    expect(await rqueue.failReport(stale, 'late', true)).toBe('lost');
    expect(await reports.processReport(fresh!)).toBe('governed');
    expect((await q(`SELECT count(*)::int AS n FROM cds_audit_log_mt WHERE tenant_id = $1 AND event_type = 'interpretation.governed' AND payload::text LIKE $2`, [tenant.id, `%${id}%`]))[0].n).toBe(1);
  });

  it('retries with backoff, then fails permanently; integrity problems fail at once', async () => {
    await clean();
    const id = await submit(vitals()); await drainJobs();
    await q('UPDATE interpretation_reports SET max_attempts = 2 WHERE job_id = $1', [id]);
    const t = Date.now();
    const c1 = (await rqueue.claimNextReport(t))!;
    expect(await rqueue.failReport(c1, 'transient', false, t)).toBe('retry');
    expect(Number((await reportOf(id)).run_after)).toBe(t + 30_000);
    expect(await rqueue.claimNextReport(t + 1000)).toBeNull();
    const c2 = (await rqueue.claimNextReport(t + 30_001))!;
    expect(await rqueue.failReport(c2, 'transient', false, t + 30_001)).toBe('failed');
    expect(await reportOf(id)).toMatchObject({ status: 'failed', error_code: 'transient' });

    const id2 = await submit(vitals()); await drainJobs();
    const stored = JSON.parse((await q('SELECT document_json FROM normalized_findings WHERE job_id = $1', [id2]))[0].document_json);
    stored.findingsSha256 = 'f'.repeat(64); // the stored findings no longer match the hash the report was bound to
    await q('UPDATE normalized_findings SET document_json = $2 WHERE job_id = $1', [id2, JSON.stringify(stored)]);
    expect(await reports.runOnce()).toBe('failed');
    expect(await reportOf(id2)).toMatchObject({ status: 'failed', error_code: 'findings_hash_mismatch' });

    const id3 = await submit(vitals()); await drainJobs();
    await q('DELETE FROM normalized_findings WHERE job_id = $1', [id3]);
    expect(await reports.runOnce()).toBe('failed');
    expect((await reportOf(id3)).error_code).toBe('findings_missing');

    const id4 = await submit(vitals()); await drainJobs();
    await q(`UPDATE normalized_findings SET document_json = replace(document_json, '"id":"beaive-v1"', '"id":"no-such-adapter"') WHERE job_id = $1`, [id4]);
    expect(await reports.runOnce()).toBe('failed');
    expect((await reportOf(id4)).error_code).toBe('adapter_unavailable');
  });

  // ── database rules ─────────────────────────────────────────────────────────────────────────

  it('content is immutable once set: governance, layers and the findings binding cannot be rewritten', async () => {
    await clean();
    const id = await submit(vitals()); await drainJobs(); await drainReports();
    await expect(q(`UPDATE interpretation_reports SET governance_json = '{}' WHERE job_id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(q(`UPDATE interpretation_reports SET governance_sha256 = $2 WHERE job_id = $1`, [id, 'a'.repeat(64)])).rejects.toThrow(/immutable/);
    await expect(q(`UPDATE interpretation_reports SET findings_sha256 = $2 WHERE job_id = $1`, [id, 'a'.repeat(64)])).rejects.toThrow(/immutable/);
    await q(`UPDATE interpretation_reports SET clinical_json = '{"a":1}' WHERE job_id = $1`, [id]); // first write is allowed
    await expect(q(`UPDATE interpretation_reports SET clinical_json = '{"a":2}' WHERE job_id = $1`, [id])).rejects.toThrow(/immutable/);
    await q(`UPDATE interpretation_reports SET status = 'ready' WHERE job_id = $1`, [id]); // non-content columns still move
  });

  it('the database refuses clinician_signed without a named signer, a time and a content hash, and a rejection without a reason', async () => {
    await clean();
    const id = await submit(vitals()); await drainJobs();
    for (const set of [
      `review_state = 'clinician_signed'`,
      `review_state = 'clinician_signed', reviewed_by = 'u1'`,
      `review_state = 'clinician_signed', reviewed_by = 'u1', reviewed_at = 1`,
      `review_state = 'rejected'`,
    ]) await expect(q(`UPDATE interpretation_reports SET ${set} WHERE job_id = $1`, [id]), set).rejects.toThrow(/check constraint/);
    await expect(q(`UPDATE interpretation_reports SET review_state = 'approved' WHERE job_id = $1`, [id])).rejects.toThrow(/check constraint/); // unknown states are refused
    await q(`UPDATE interpretation_reports SET review_state = 'clinician_signed', reviewed_by = 'u1', reviewed_at = 1, signed_content_sha256 = $2 WHERE job_id = $1`, [id, 'a'.repeat(64)]);
    // a sign-off cannot be altered or removed afterwards
    for (const set of [`review_state = 'ai_reviewed'`, `review_state = NULL`, `reviewed_by = 'someone-else'`, `reviewed_at = 2`, `signed_content_sha256 = NULL`, `reviewer_user_id = 'x'`]) await expect(q(`UPDATE interpretation_reports SET ${set} WHERE job_id = $1`, [id]), set).rejects.toThrow(/sign-off cannot be changed|check constraint/);
    await drainReports();
  });
});
