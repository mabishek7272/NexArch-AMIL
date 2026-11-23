/**
 * The narrative stage of the report pipeline (interpretation engine, P4b) against REAL PostgreSQL (disposable database;
 * opt-in via ANUCLAW_TEST_PG_URL) over the real HTTP layer. The model call is STUBBED: no network, no key.
 * Synthetic data only.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelCallArgs, ProbeRecord } from '../../ai/openrouter';
import { deterministicNarrative } from '../narrative/deterministic';
import type { Layer, Narrative } from '../narrative/types';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../container-runner', () => ({ runAgent: vi.fn(async () => ({ text: 'unused', artifacts: [] })) }));

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/examples/beaive-vitals.request.json'), 'utf8'));
const SKILL = 'physiological-signal-interpretation';
const MODEL = 'google/gemini-4-hydrogen';

describe.skipIf(!URL_)('narrative stage (real PostgreSQL, stubbed model)', () => {
  const dbName = `anuclaw_nar_${crypto.randomBytes(6).toString('hex')}`;
  const ADMIN = crypto.randomBytes(24).toString('hex');
  let admin: Client; let server: Server; let base: string;
  let mainPool: { end(): Promise<void> } | undefined;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let jobs: typeof import('../jobs/worker'); let reports: typeof import('./worker'); let rqueue: typeof import('./queue');
  let tOff: { id: string; key: string }; let tOn: { id: string; key: string };

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, {
      PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName,
      ANUCLAW_JWT_SECRET: crypto.randomBytes(32).toString('hex'), ANUCLAW_IDENTITY_VAULT_KEY: crypto.randomBytes(32).toString('hex'),
    });
    delete process.env.ANUCLAW_RATE_STORE; delete process.env.ANUCLAW_SELF_REGISTRATION; delete process.env.ANUCLAW_NARRATIVE_MODELS;
    vi.resetModules();
    await (await import('../../db/connection')).ensureDbReady();
    mainPool = (await import('../../db/connection')).getDb();
    q = (await import('../../db')).db.query as any;
    jobs = await import('../jobs/worker'); reports = await import('./worker'); rqueue = await import('./queue');

    const express = (await import('express')).default;
    const app = express(); app.use(express.json({ limit: '2mb' }));
    app.use((await import('../tenancy/admin-routes')).createTenantAdminRouter({ adminKey: ADMIN }));
    app.use((await import('../skills/admin-routes')).createSkillAdminRouter({ adminKey: ADMIN }));
    app.use((await import('../jobs/routes')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    tOff = await newTenant('Synthetic Narr Off'); tOn = await newTenant('Synthetic Narr On');
    expect((await adm('PUT', `/api/v1/admin/tenants/${tOff.id}/skills/${SKILL}`, {})).status).toBe(201);
    expect((await adm('PUT', `/api/v1/admin/tenants/${tOn.id}/skills/${SKILL}`, { config: { narrative: { enabled: true, model: MODEL } } })).status).toBe(201);
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
  const vitals = () => { const r = JSON.parse(JSON.stringify(EXAMPLE)); r.tenantRequestId = `n-${crypto.randomBytes(4).toString('hex')}`; r.subject.externalRef = `SUBJ-${crypto.randomBytes(3).toString('hex')}`; return r; };
  const submit = async (t: { key: string }) => (await (await as(t.key, 'POST', '/v1/interpretations', vitals())).json()).id as string;
  const drainJobs = async () => { for (let i = 0; i < 50; i++) if ((await jobs.runOnce()) === null) return; };
  const reportOf = async (jobId: string) => (await q('SELECT * FROM interpretation_reports WHERE job_id = $1 ORDER BY version', [jobId]))[0];
  const governOnly = async () => { // run stage 1 only for whatever is queued
    for (let i = 0; i < 50; i++) { const r = await rqueue.claimNextReport(); if (!r) return; if (r.stage === 'generating') await reports.processReport(r); else { await q(`UPDATE interpretation_reports SET status='governed', claim_token=NULL, lease_expires_at=NULL WHERE id=$1`, [r.id]); return; } }
  };
  // These tests are about stages 1-2: stop once a report is narrated (stage 3 is covered in report-layers-pg.test.ts). `clean` runs everything to the end.
  const drainReports = async (deps: Parameters<typeof reports.runOnce>[1] = {}) => { for (let i = 0; i < 50; i++) { const o = await reports.runOnce(() => Date.now() + 1000, deps); if (o === null) return; if (o === 'narrated') await park(); } };
  const park = () => q(`UPDATE interpretation_reports SET run_after = 9000000000000 WHERE status = 'narrated' AND run_after < 9000000000000`); // keep narrated reports out of stage 3
  const clean = async () => { await drainJobs(); for (let i = 0; i < 50; i++) if ((await reports.runOnce(() => Date.now() + 1000)) === null) return; };

  /** What a well-behaved model would return for this job's layer: the deterministic text rebuilt from the stored documents. */
  async function goodFor(jobId: string, layer: Layer): Promise<Narrative> {
    const doc = JSON.parse((await q('SELECT document_json FROM normalized_findings WHERE job_id = $1', [jobId]))[0].document_json);
    const gov = JSON.parse((await reportOf(jobId)).governance_json);
    return deterministicNarrative(layer, doc, gov);
  }
  const stub = (jobIdOf: () => string, produce: (l: Layer, jobId: string, n: number) => Promise<unknown | ProbeRecord>) => {
    const counts: Record<string, number> = {}; const calls: ModelCallArgs[] = [];
    const call = vi.fn(async (a: ModelCallArgs): Promise<ProbeRecord> => {
      calls.push(a); const l: Layer = String(a.groupId).endsWith('-clinical') ? 'clinical' : 'layman';
      counts[l] = (counts[l] ?? 0) + 1;
      const out = await produce(l, jobIdOf(), counts[l]);
      if (out && typeof out === 'object' && 'status' in (out as any)) return out as ProbeRecord;
      return { role: 'review', requestedModel: a.model!, status: 'ok', returnedModel: a.model, identity: 'exact', latencyMs: 1, attempts: 1, usage: { prompt_tokens: 1, completion_tokens: 1 }, egress: { mode: 'deidentified', redactions: 0 }, data: { choices: [{ message: { content: JSON.stringify(out) } }] } };
    });
    return { call, calls, deps: { narrative: { call: call as any } } };
  };

  // ── staging and the default ────────────────────────────────────────────────────────────────

  it('stage 1 leaves the report governed and immediately due for the narrative stage; nothing is narrated yet', async () => {
    await clean();
    const id = await submit(tOff); await drainJobs();
    expect(await reports.runOnce(() => Date.now() + 1000)).toBe('governed');
    expect(await reportOf(id)).toMatchObject({ status: 'governed', attempts: 0, narrative_json: null, narrative_mode: null, claim_token: null });
    expect(await reports.runOnce(() => Date.now() + 1000)).toBe('narrated');
    expect((await reportOf(id)).status).toBe('narrated');
    expect(await reports.runOnce()).toBeNull();
  });

  it('by default (no setting) no model is called: fixed-template text, recorded as such', async () => {
    await clean();
    const id = await submit(tOff); await drainJobs();
    const s = stub(() => id, async () => ({}));
    await drainReports(s.deps);
    expect(s.call).not.toHaveBeenCalled();
    const r = await reportOf(id);
    expect(r).toMatchObject({ status: 'narrated', narrative_mode: 'deterministic', model_requested: null, model_returned: null });
    const n = JSON.parse(r.narrative_json);
    expect(n.clinical).toEqual(await goodFor(id, 'clinical')); expect(n.layman).toEqual(await goodFor(id, 'layman'));
    const g = JSON.parse(r.guard_results_json);
    expect(g.layers.clinical).toMatchObject({ source: 'deterministic', attempts: 0, fallbackReason: 'not_enabled' }); expect(g.flags).toEqual([]);
    expect(JSON.parse(r.prompt_versions_json)).toEqual({ clinical: 'clinical-vitals/v2', layman: 'layman-vitals/v2' }); // the manifest names v1; the text actually used is v2
  });

  // ── a tenant that enabled narratives ───────────────────────────────────────────────────────

  it("an enabled tenant gets the model's text, as that tenant's model, accounted to that tenant, with provenance recorded", async () => {
    await clean();
    const id = await submit(tOn); await drainJobs(); await governOnly();
    const s = stub(() => id, async (l, jid) => goodFor(jid, l));
    await drainReports(s.deps);
    expect(s.calls).toHaveLength(2);
    for (const c of s.calls) expect(c).toMatchObject({ role: 'review', model: MODEL, dataClass: 'patient_derived', scope: { kind: 'tenant', id: tOn.id } });
    const r = await reportOf(id);
    expect(r).toMatchObject({ status: 'narrated', narrative_mode: 'model', model_requested: MODEL, model_returned: MODEL });
    const g = JSON.parse(r.guard_results_json);
    expect(g.layers.clinical).toMatchObject({ source: 'model', attempts: 1, problems: [] });
    expect(g.layers.layman).toMatchObject({ source: 'model', attempts: 1 });
    expect(g.layers.layman.readingGrade).toBeLessThanOrEqual(10);
  });

  it("the prompt sent for a real job holds no identity, subject reference, job id or tenant id", async () => {
    await clean();
    const ref = 'PROMPT-REF-' + crypto.randomBytes(3).toString('hex');
    const body = vitals(); body.subject.externalRef = ref; body.subject.identity = { name: 'Prompt Person Qz', email: 'prompt.qz@example.invalid' };
    const id = (await (await as(tOn.key, 'POST', '/v1/interpretations', body)).json()).id as string;
    await drainJobs(); await governOnly();
    const s = stub(() => id, async (l, jid) => goodFor(jid, l));
    await drainReports(s.deps);
    const sent = JSON.stringify(s.calls.map((c) => c.body));
    for (const secret of [ref, 'Prompt Person Qz', 'prompt.qz@example.invalid', id, tOn.id, EXAMPLE.tenantRequestId, 'SYNTH-SESSION-0001']) expect(sent, secret).not.toContain(secret);
    expect(sent).toContain('heart_rate_bpm');
  });

  it('a model answer that breaks a guard is replaced by the fixed template; the audit entry carries codes only', async () => {
    await clean();
    const id = await submit(tOn); await drainJobs(); await governOnly();
    const s = stub(() => id, async (l, jid) => { const n = await goodFor(jid, l); n.sections[1].text += ' It was 999 yesterday and this suggests diabetes.'; return n; });
    await drainReports(s.deps);
    expect(s.calls).toHaveLength(4); // two layers, each tried at most twice
    const r = await reportOf(id);
    expect(r).toMatchObject({ status: 'narrated', narrative_mode: 'model_fallback' });
    const n = JSON.parse(r.narrative_json);
    expect(n.clinical).toEqual(await goodFor(id, 'clinical')); // the fixed template, not the model's text
    expect(JSON.stringify(n)).not.toMatch(/It was 999|yesterday|diabetes/);
    const g = JSON.parse(r.guard_results_json);
    expect(g.layers.clinical).toMatchObject({ source: 'deterministic', attempts: 2, fallbackReason: 'guard_failed' });
    expect(g.layers.clinical.problems.map((p: any) => p.code)).toEqual(expect.arrayContaining(['number_not_in_cited_findings', 'diagnostic_wording']));
    expect(g.flags).toEqual([expect.objectContaining({ type: 'review_required', severity: 'attention' })]);
    const audit = await (await adm('GET', `/api/v1/admin/tenants/${tOn.id}/audit`)).json();
    const e = audit.entries.filter((x: any) => x.event_type === 'interpretation.narrated').find((x: any) => x.payload.job_id === id);
    expect(e.payload).toMatchObject({ mode: 'model_fallback', model_requested: MODEL, layers: { clinical: { source: 'deterministic', attempts: 2, fallback_reason: 'guard_failed' } } });
    expect(e.payload.layers.clinical.problem_codes).toContain('diagnostic_wording');
    expect(JSON.stringify(audit.entries)).not.toMatch(/It was 999|yesterday|diabetes/); // hashes can contain digit runs, so assert on the injected phrase
    expect(audit.chain.valid).toBe(true);
  });

  it('a model failure (spend limit, identity mismatch, outage) falls back without retrying and never to another model', async () => {
    for (const status of ['spend_limit_reached', 'model_mismatch', 'unavailable'] as const) {
      await clean();
      const id = await submit(tOn); await drainJobs(); await governOnly();
      const s = stub(() => id, async () => ({ role: 'review', requestedModel: MODEL, status, latencyMs: 1, attempts: 1 }));
      await drainReports(s.deps);
      expect(s.calls).toHaveLength(2); expect(new Set(s.calls.map((c) => c.model))).toEqual(new Set([MODEL]));
      const r = await reportOf(id);
      expect(r).toMatchObject({ status: 'narrated', narrative_mode: 'model_fallback' });
      expect(JSON.parse(r.guard_results_json).layers.layman.fallbackReason).toBe(`model_${status}`);
    }
  });

  it('a setting that is no longer allowed at run time is not used: fixed template, no call, a flag for the admin', async () => {
    await clean();
    const t = await newTenant('Synthetic Stale Setting'); await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/${SKILL}`, { config: { narrative: { enabled: true, model: MODEL } } });
    const id = await submit(t); await drainJobs(); await governOnly();
    await q(`UPDATE tenant_skills SET config_json = $3 WHERE tenant_id = $1 AND skill_id = $2`, [t.id, SKILL, JSON.stringify({ narrative: { enabled: true, model: 'google/gemini-4-neon' } })]); // e.g. the allow-list changed after saving
    const s = stub(() => id, async () => ({}));
    await drainReports(s.deps);
    expect(s.call).not.toHaveBeenCalled();
    const r = await reportOf(id);
    expect(r).toMatchObject({ narrative_mode: 'model_fallback', model_requested: null });
    expect(JSON.parse(r.guard_results_json).layers.clinical.fallbackReason).toBe('model_not_allowed');
    expect(JSON.parse(r.guard_results_json).flags).toHaveLength(1);
  });

  it('two tenants on the same skill are independent: one off, one on', async () => {
    await clean();
    const a = await submit(tOff); const b = await submit(tOn); await drainJobs(); await governOnly(); await governOnly();
    const s = stub(() => b, async (l, jid) => goodFor(jid, l));
    await drainReports(s.deps);
    expect((await reportOf(a)).narrative_mode).toBe('deterministic');
    expect((await reportOf(b)).narrative_mode).toBe('model');
    expect(new Set(s.calls.map((c) => (c.scope as any).id))).toEqual(new Set([tOn.id]));
  });

  // ── per-tenant setting validation (admin) ──────────────────────────────────────────────────

  it('the admin cannot save a narrative setting that is unknown, unallowed or incomplete, and the audit names keys only', async () => {
    const put = (config: unknown) => adm('PUT', `/api/v1/admin/tenants/${tOff.id}/skills/${SKILL}`, { config });
    for (const bad of [{ narrative: { enabled: true, model: 'google/gemini-4-neon' } }, { narrative: { enabled: true, model: 'google/gemini-4-carbon' } }, { narrative: { enabled: true } },
      { narrative: { enabled: true, model: MODEL, extra: 1 } }, { narrative: 'on' }, { narrative: { enabled: 'yes', model: MODEL } }]) {
      const r = await put(bad); expect(r.status, JSON.stringify(bad)).toBe(400);
      expect((await r.json()).error.code).toBe('validation_failed');
    }
    expect((await put({ narrative: { enabled: true, model: 'google/gemini-4-argon' } })).status).toBe(200);
    expect((await put({ narrative: { enabled: false } })).status).toBe(200);
    expect((await put({ note: 'unrelated config is untouched' })).status).toBe(200);
    expect((await q(`SELECT config_json FROM tenant_skills WHERE tenant_id = $1 AND skill_id = $2`, [tOff.id, SKILL]))[0].config_json).toBe('{"note":"unrelated config is untouched"}');
    const audit = await (await adm('GET', `/api/v1/admin/tenants/${tOff.id}/audit`)).json();
    expect(JSON.stringify(audit.entries)).not.toContain('gemini-4-neon');
  });

  // ── queue behaviour of the stage ───────────────────────────────────────────────────────────

  it('a failing narrative stage retries ONLY that stage: the report returns to governed, governance is kept', async () => {
    await clean();
    const id = await submit(tOn); await drainJobs(); await governOnly();
    const before = await reportOf(id);
    const boom = stub(() => id, async () => { throw new Error('network blew up'); });
    expect(await reports.runOnce(() => Date.now() + 1000, boom.deps)).toBe('retry');
    const r = await reportOf(id);
    expect(r).toMatchObject({ status: 'governed', error_code: 'worker_error', claim_token: null, narrative_json: null });
    expect(r.governance_json).toBe(before.governance_json); expect(r.governance_sha256).toBe(before.governance_sha256);
    expect(Number(r.run_after)).toBeGreaterThan(Date.now()); // backoff
    await q('UPDATE interpretation_reports SET run_after = 0 WHERE job_id = $1', [id]);
    const ok = stub(() => id, async (l, jid) => goodFor(jid, l));
    expect(await reports.runOnce(() => Date.now() + 1000, ok.deps)).toBe('narrated');
  });

  it('the narrative commit is fenced: a claim stolen after the model ran leaves nothing stored', async () => {
    await clean();
    const id = await submit(tOff); await drainJobs(); await governOnly();
    const t0 = Date.now();
    const stale = (await rqueue.claimNextReport(t0, 1000))!;
    expect(stale).toMatchObject({ job_id: id, stage: 'narrating' });
    let fresh: Awaited<ReturnType<typeof rqueue.claimNextReport>> = null;
    const out = await reports.processReport(stale, () => Date.now(), { beforeCommit: async () => { fresh = await rqueue.claimNextReport(Date.now() + 900_000, 300_000); } });
    expect(fresh).toMatchObject({ stage: 'narrating' }); expect(out).toBe('lost');
    expect(await reportOf(id)).toMatchObject({ status: 'narrating', narrative_json: null, claim_token: fresh!.claim_token });
    expect(await rqueue.failReport(stale, 'late', true)).toBe('lost');
    expect(await reports.processReport(fresh!)).toBe('narrated');
    expect((await q(`SELECT count(*)::int AS n FROM cds_audit_log_mt WHERE tenant_id = $1 AND event_type = 'interpretation.narrated' AND payload::text LIKE $2`, [tOff.id, `%${id}%`]))[0].n).toBe(1);
  });

  it('a lost claim during the model calls stops them (the lease is extended before each call)', async () => {
    await clean();
    const id = await submit(tOn); await drainJobs(); await governOnly();
    const stale = (await rqueue.claimNextReport())!; expect(stale.stage).toBe('narrating');
    await q(`UPDATE interpretation_reports SET claim_token = 'someone-else' WHERE id = $1`, [stale.id]); // the claim is gone before the first call
    const s = stub(() => id, async (l, jid) => goodFor(jid, l));
    expect(await reports.processReport(stale, () => Date.now(), {}, s.deps)).toBe('lost');
    expect(s.call).not.toHaveBeenCalled();
  });

  it('integrity problems fail the stage at once instead of narrating something else', async () => {
    await clean();
    const id = await submit(tOff); await drainJobs(); await governOnly();
    await q('ALTER TABLE interpretation_reports DISABLE TRIGGER trg_interpretation_reports_content_immutable');
    try { await q(`UPDATE interpretation_reports SET governance_json = replace(governance_json, '"followUp":true', '"followUp":false') WHERE job_id = $1`, [id]); }
    finally { await q('ALTER TABLE interpretation_reports ENABLE TRIGGER trg_interpretation_reports_content_immutable'); }
    expect(await reports.runOnce(() => Date.now() + 1000)).toBe('failed');
    expect(await reportOf(id)).toMatchObject({ status: 'failed', error_code: 'governance_integrity' });
  });

  it('the narrative is immutable once stored', async () => {
    await clean();
    const id = await submit(tOff); await drainJobs(); await drainReports();
    await expect(q(`UPDATE interpretation_reports SET narrative_json = '{}' WHERE job_id = $1`, [id])).rejects.toThrow(/immutable/);
    await q(`UPDATE interpretation_reports SET status = 'narrated' WHERE job_id = $1`, [id]); // other columns still move
  });
});
