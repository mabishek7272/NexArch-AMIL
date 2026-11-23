/**
 * Subject erasure (interpretation engine, P3d) against REAL PostgreSQL (disposable database; opt-in via
 * ANUCLAW_TEST_PG_URL) over the real HTTP layer. The key test scans EVERY table for the erased subject's reference,
 * identity and planted markers. Synthetic data only.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { contentHash } from '../../cds/hashing';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../container-runner', () => ({ runAgent: vi.fn(async () => ({ text: 'unused', artifacts: [] })) }));

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/examples/beaive-vitals.request.json'), 'utf8'));
const SKILL = 'physiological-signal-interpretation';
const HOOK = 'https://93.184.216.34/anuclaw/hook';
const publicResolve = async () => [{ address: '93.184.216.34', family: 4 }];

// Strings that exist ONLY in the erased subject's data. Any of them surviving anywhere is a failed erasure.
const REF = 'ERASE-ME-0001';
// Identity is sealed at intake, so its plaintext must not exist in ANY table, before or after erasure.
const IDENTITY = ['Erasable Person Zq', 'erasable.zq@example.invalid', '99900011122'];
// These live in the stored source payload (identity-free) until erasure removes it.
const MARKERS = ['SESSION-ERASE-ZQ', 'EXT-ERASE-ZQ', 'REQ-ERASE-ZQ', 'erase_marker_zq', 'ErasureLabelZq']; // the last two are a finding key and label: they land in the findings, the governance output AND the stored narrative

describe.skipIf(!URL_)('subject erasure (real PostgreSQL)', () => {
  const dbName = `anuclaw_ers_${crypto.randomBytes(6).toString('hex')}`;
  const ADMIN = crypto.randomBytes(24).toString('hex');
  let admin: Client; let server: Server; let base: string;
  let mainPool: { end(): Promise<void> } | undefined;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let queue: typeof import('./queue'); let worker: typeof import('./worker'); let delivery: typeof import('../webhooks/delivery'); let reportWorker: typeof import('../reports/worker');
  let tenantA: { id: string; key: string }; let tenantB: { id: string; key: string };

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, {
      PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName,
      ANUCLAW_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
      ANUCLAW_IDENTITY_VAULT_KEY: crypto.randomBytes(32).toString('hex'),
      ANUCLAW_WEBHOOK_SECRET_KEY: crypto.randomBytes(32).toString('hex'),
    });
    delete process.env.ANUCLAW_RATE_STORE; delete process.env.ANUCLAW_SELF_REGISTRATION;
    vi.resetModules();
    await (await import('../../db/connection')).ensureDbReady();
    mainPool = (await import('../../db/connection')).getDb();
    q = (await import('../../db')).db.query as any;
    queue = await import('./queue'); worker = await import('./worker'); delivery = await import('../webhooks/delivery'); reportWorker = await import('../reports/worker');

    const express = (await import('express')).default;
    const app = express(); app.use(express.json({ limit: '2mb' }));
    app.use((await import('../tenancy/admin-routes')).createTenantAdminRouter({ adminKey: ADMIN }));
    app.use((await import('../skills/admin-routes')).createSkillAdminRouter({ adminKey: ADMIN }));
    app.use('/api/v1', (await import('../../api/routes/tenants')).default);
    app.use((await import('./routes')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    tenantA = await newTenant('Synthetic Eraser'); tenantB = await newTenant('Synthetic Bystander');
    for (const t of [tenantA, tenantB]) expect((await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/${SKILL}`, {})).status).toBe(201);
    expect((await as(tenantA.key, 'PUT', '/api/v1/account/webhook', { url: HOOK })).status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await mainPool?.end().catch(() => { /* already closed */ });
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const adm = (method: string, p: string, body?: unknown) => fetch(base + p, { method, headers: { 'x-admin-key': ADMIN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const as = (key: string, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + p, { method, headers: { 'x-api-key': key, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  async function newTenant(name: string) {
    const r = await adm('POST', '/api/v1/admin/tenants', { company_name: name, email: `${name.toLowerCase().replace(/\W+/g, '-')}-${crypto.randomBytes(3).toString('hex')}@synthetic.invalid`, plan: 'enterprise' });
    const b = await r.json(); expect(r.status).toBe(201); return { id: b.tenant_id as string, key: b.api_key as string };
  }
  const body = (ref: string, over: (r: any) => void = () => {}) => {
    const r = JSON.parse(JSON.stringify(EXAMPLE)); r.tenantRequestId = `req-${crypto.randomBytes(4).toString('hex')}`; r.subject.externalRef = ref; over(r); return r;
  };
  const target = (ref = REF) => body(ref, (r) => {
    r.tenantRequestId = `REQ-ERASE-ZQ-${crypto.randomBytes(3).toString('hex')}`;
    r.subject.identity = { name: 'Erasable Person Zq', email: 'erasable.zq@example.invalid', phone: '+99900011122' };
    r.acquisition.sessionRef = 'SESSION-ERASE-ZQ'; r.extensions = { marker: 'EXT-ERASE-ZQ' };
    r.findings.push({ key: 'erase_marker_zq', label: 'ErasureLabelZq', value: 1 });
  });
  const submit = async (t: { key: string }, b: unknown, idem?: string) => { const r = await as(t.key, 'POST', '/v1/interpretations', b, idem ? { 'idempotency-key': idem } : {}); return { r, j: await r.json() }; };
  const drain = async () => { for (let i = 0; i < 50; i++) if ((await worker.runOnce()) === null) return; };
  const drainReports = async () => { for (let i = 0; i < 50; i++) if ((await reportWorker.runOnce()) === null) return; };
  const erase = (t: { key: string }, b: unknown) => as(t.key, 'POST', '/v1/subject-erasures', b);

  /** Every row of every table, as text, minus rows that belong to the bystander tenant. */
  async function everything(): Promise<string> {
    const tables = (await q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).map((r: any) => r.tablename as string);
    const out: string[] = [];
    for (const t of tables) for (const r of await q(`SELECT x::text AS row FROM "${t}" x`)) if (!String(r.row).includes(tenantB.id)) out.push(`${t}: ${r.row}`);
    return out.join('\n');
  }

  // ── the main scenario ──────────────────────────────────────────────────────────────────────

  it('erases the subject everywhere: no reference, identity or marker survives in ANY table; others are untouched', async () => {
    await drain();
    // S1 (to erase): two completed jobs (one delivered by webhook, one still pending), one claimed mid-processing, one queued.
    const j1 = (await submit(tenantA, target())).j.id; const j2 = (await submit(tenantA, target())).j.id; await drain();
    await drainReports(); // governance output now exists for the subject (it carries the marker finding key)
    expect((await q(`SELECT governance_json FROM interpretation_reports WHERE job_id = ANY($1::text[])`, [[j1, j2]])).every((x: any) => String(x.governance_json).includes('erase_marker_zq'))).toBe(true);
    expect((await q(`SELECT narrative_json FROM interpretation_reports WHERE job_id = ANY($1::text[])`, [[j1, j2]])).every((x: any) => String(x.narrative_json).includes('ErasureLabelZq'))).toBe(true); // the stored narrative quotes the label
    // Both report layers (stage 3) quote the label and the marker finding too, so the whole-database scan below covers them.
    expect((await q(`SELECT clinical_json, layman_json FROM interpretation_reports WHERE job_id = ANY($1::text[])`, [[j1, j2]])).every((x: any) => String(x.clinical_json).includes('ErasureLabelZq') && String(x.layman_json).includes('ErasureLabelZq'))).toBe(true);
    const net = { post: vi.fn(async () => ({ statusCode: 204, error: null })) };
    expect(await delivery.runOnce({ post: net.post as any, resolve: publicResolve })).toBe('delivered'); // j1's event
    // Others that must survive: another subject of tenant A, and the SAME reference string under tenant B.
    const keep = (await submit(tenantA, body('KEEP-ME-0002', (r) => { r.subject.identity = { name: 'Keeper Person', email: 'keeper@example.invalid' }; }))).j.id;
    const other = (await submit(tenantB, body(REF, (r) => { r.subject.identity = { name: 'Bravo Person', email: 'bravo@example.invalid' }; }))).j.id;
    await drain();
    // Created AFTER the last drain, so they are still live when erasure runs: one claimed mid-processing, one queued.
    const j3 = (await submit(tenantA, target())).j.id; const claimed3 = (await queue.claimNextJob())!; expect(claimed3.id).toBe(j3);
    const j4 = (await submit(tenantA, target())).j.id;
    const before = await everything();
    expect(before).toContain(REF); // sanity: the scan does see the data before erasure
    for (const m of MARKERS) expect(before, m).toContain(m);
    for (const m of IDENTITY) expect(before, `${m} must never be stored in the clear`).not.toContain(m);
    const [pre] = await q('SELECT 1 FROM identity_vault WHERE job_id = $1', [j1]); expect(pre).toBeTruthy();

    const r = await erase(tenantA, { externalRef: REF, confirm: true, reason: 'consent_withdrawn' });
    expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store');
    const receipt = await r.json();
    expect(receipt).toMatchObject({ reason: 'consent_withdrawn', jobsErased: 4, identitiesDeleted: 4, payloadsDeleted: 4, findingsDeleted: 2, reportsDeleted: 2 });
    expect([...receipt.jobIds].sort()).toEqual([j1, j2, j3, j4].sort());
    expect(receipt.deliveriesScrubbed).toBe(4); // two completed events and two report_ready events

    // The completeness check: nothing about the subject is left anywhere.
    const dump = await everything();
    expect(dump).not.toContain(REF);
    for (const m of [...MARKERS, ...IDENTITY]) expect(dump, m).not.toContain(m);

    // Tombstones keep no linkage; everything else of the tenant is intact.
    const tombs = await q(`SELECT * FROM interpretation_jobs WHERE id = ANY($1::text[]) ORDER BY id`, [[j1, j2, j3, j4]]);
    for (const t of tombs) expect(t).toMatchObject({ status: 'erased', subject_ref: 'erased', idempotency_key: null, request_fingerprint: '0'.repeat(64), original_payload_sha256: null, findings_sha256: null, captured_at: 'erased', claim_token: null });
    for (const id of [keep, other]) {
      expect((await q('SELECT status FROM interpretation_jobs WHERE id = $1', [id]))[0].status).toBe('completed');
      expect((await q('SELECT 1 FROM normalized_findings WHERE job_id = $1', [id]))).toHaveLength(1);
      expect((await q('SELECT 1 FROM identity_vault WHERE job_id = $1', [id]))).toHaveLength(1);
      expect((await q('SELECT 1 FROM source_payloads WHERE job_id = $1', [id]))).toHaveLength(1);
    }
    expect((await q('SELECT subject_ref FROM interpretation_jobs WHERE id = $1', [other]))[0].subject_ref).toBe(REF); // tenant B's same-named subject

    // Webhook events: pending ones cancelled, every stored body blanked.
    const dl = await q(`SELECT job_id, event_type, status, payload_json, last_error FROM webhook_deliveries WHERE job_id = ANY($1::text[])`, [[j1, j2, j3, j4]]);
    expect(dl.every((d: any) => d.payload_json === '{"erased":true}')).toBe(true);
    expect(dl.find((d: any) => d.job_id === j1 && d.event_type === 'interpretation.completed')!.status).toBe('delivered');
    expect(dl.filter((d: any) => d.event_type === 'interpretation.report_ready').every((d: any) => d.status === 'dead' && d.last_error === 'subject_erased')).toBe(true); // the report events were cancelled too
    expect(dl.find((d: any) => d.job_id === j2 && d.event_type === 'interpretation.completed')).toMatchObject({ status: 'dead', last_error: 'subject_erased' });
    // Sending everything that is due: the survivor's event goes out, none of the erased subject's events do.
    const sentBefore = net.post.mock.calls.length;
    for (let i = 0; i < 20 && (await delivery.runOnce({ post: net.post as any, resolve: publicResolve, now: () => Date.now() + 1000 })) !== null; i++) { /* drain */ }
    const sentBodies = net.post.mock.calls.slice(sentBefore).map((c: any[]) => String(c[2]));
    expect(sentBodies.length).toBeGreaterThan(0);
    expect(sentBodies.some((b) => b.includes(keep))).toBe(true);
    for (const id of [j1, j2, j3, j4]) expect(sentBodies.some((b) => b.includes(id)), `event for erased job ${id}`).toBe(false);

    // The in-flight worker cannot write findings back, and the queued job is never processed.
    expect(await worker.processJob(claimed3)).toBe('lost');
    await drain();
    expect((await q(`SELECT count(*)::int AS n FROM normalized_findings WHERE job_id = ANY($1::text[])`, [[j1, j2, j3, j4]]))[0].n).toBe(0);
    expect((await q(`SELECT status FROM interpretation_jobs WHERE id = ANY($1::text[])`, [[j3, j4]])).every((x: any) => x.status === 'erased')).toBe(true);
    expect(await everything()).not.toContain(REF);
  });

  it('shows tombstones to the tenant: status erased with no subject, findings 410, still listed', async () => {
    const { j } = await submit(tenantA, target('ERASE-ME-0003')); await drain();
    await erase(tenantA, { externalRef: 'ERASE-ME-0003', confirm: true });
    const st = await (await as(tenantA.key, 'GET', `/v1/interpretations/${j.id}`)).json();
    expect(st).toMatchObject({ id: j.id, status: 'erased', subjectRef: null, capturedAt: null, originalPayloadSha256: null, findingsSha256: null });
    const f = await as(tenantA.key, 'GET', `/v1/interpretations/${j.id}/findings`);
    expect(f.status).toBe(410); expect((await f.json()).error.code).toBe('subject_erased');
    expect((await (await as(tenantA.key, 'GET', '/v1/interpretations?limit=100')).json()).items.some((i: any) => i.id === j.id && i.status === 'erased')).toBe(true);
  });

  // ── audit and receipts ─────────────────────────────────────────────────────────────────────

  it('appends ONE audit entry with counts and a hash of the job ids, naming no subject; the chain stays intact', async () => {
    const t = await newTenant('Synthetic Audited Eraser'); await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/${SKILL}`, {});
    const ref = 'AUDIT-REF-' + crypto.randomBytes(3).toString('hex');
    const a1 = (await submit(t, body(ref, (r) => { r.subject.identity = { name: 'Audit Subject Qx' }; }))).j.id; await drain();
    const receipt = await (await erase(t, { externalRef: ref, confirm: true })).json();
    const audit = await (await adm('GET', `/api/v1/admin/tenants/${t.id}/audit`)).json();
    const entries = audit.entries.filter((e: any) => e.event_type === 'subject.erased');
    expect(entries).toHaveLength(1);
    expect(entries[0].payload).toMatchObject({ erasure_id: receipt.erasureId, reason: 'subject_request', jobs_erased: 1, identities_deleted: 1, payloads_deleted: 1, findings_deleted: 1 });
    expect(entries[0].payload.job_ids_sha256).toBe(contentHash([a1]));
    expect(audit.chain.valid).toBe(true);
    const text = JSON.stringify(audit.entries);
    expect(text).not.toContain(ref); expect(text).not.toContain('Audit Subject Qx');
    expect(text).toContain(a1); // the earlier accepted/completed entries remain: job ids and hashes only
  });

  it('erasing again, or an unknown subject, erases nothing and still returns an auditable receipt of zeros', async () => {
    const r1 = await (await erase(tenantA, { externalRef: REF, confirm: true })).json();
    expect(r1).toMatchObject({ jobsErased: 0, identitiesDeleted: 0, payloadsDeleted: 0, findingsDeleted: 0, deliveriesScrubbed: 0, jobIds: [] });
    const r2 = await (await erase(tenantA, { externalRef: 'NEVER-EXISTED', confirm: true })).json();
    expect(r2.jobsErased).toBe(0); expect(r2.erasureId).not.toBe(r1.erasureId);
    expect((await q('SELECT count(*)::int AS n FROM subject_erasures WHERE id = ANY($1::text[])', [[r1.erasureId, r2.erasureId]]))[0].n).toBe(2);
  });

  it('keeps tenant-scoped receipts that carry no subject reference', async () => {
    const mine = await (await as(tenantA.key, 'GET', '/v1/subject-erasures?limit=100')).json();
    expect(mine.items.length).toBeGreaterThan(2);
    for (const i of mine.items) expect(Object.keys(i).sort()).toEqual(['deliveriesScrubbed', 'erasureId', 'findingsDeleted', 'identitiesDeleted', 'jobIdsSha256', 'jobsErased', 'payloadsDeleted', 'reason', 'reportsDeleted', 'requestedAt']);
    expect(JSON.stringify(mine)).not.toContain(REF);
    const theirs = await (await as(tenantB.key, 'GET', '/v1/subject-erasures?limit=100')).json();
    expect(theirs.items).toHaveLength(0);
    expect((await q('SELECT * FROM subject_erasures'))
      .every((r: any) => !JSON.stringify(r).includes(REF))).toBe(true);
  });

  // ── validation and safety rails ────────────────────────────────────────────────────────────

  it('requires explicit confirmation and a valid body, and erases nothing otherwise', async () => {
    const { j } = await submit(tenantA, target('ERASE-ME-0004')); await drain();
    for (const bad of [{ externalRef: 'ERASE-ME-0004' }, { externalRef: 'ERASE-ME-0004', confirm: 'yes' }, { externalRef: 'ERASE-ME-0004', confirm: false },
      { confirm: true }, { externalRef: '', confirm: true }, { externalRef: 'x'.repeat(129), confirm: true }, { externalRef: 5, confirm: true },
      { externalRef: 'ERASE-ME-0004', confirm: true, reason: 'because' }, { externalRef: 'ERASE-ME-0004', confirm: true, extra: 1 }, {}]) {
      const r = await erase(tenantA, bad); expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await q('SELECT status FROM interpretation_jobs WHERE id = $1', [j.id]))[0].status).toBe('completed');
    expect((await fetch(base + '/v1/subject-erasures', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ externalRef: 'x', confirm: true }) })).status).toBe(401);
  });

  it("one tenant cannot erase another tenant's subject by reusing its reference", async () => {
    const ref = 'SHARED-REF-' + crypto.randomBytes(3).toString('hex');
    const mine = (await submit(tenantA, body(ref))).j.id; const theirs = (await submit(tenantB, body(ref))).j.id; await drain();
    await erase(tenantA, { externalRef: ref, confirm: true });
    expect((await q('SELECT status FROM interpretation_jobs WHERE id = $1', [mine]))[0].status).toBe('erased');
    expect((await q('SELECT status FROM interpretation_jobs WHERE id = $1', [theirs]))[0].status).toBe('completed');
    expect((await q('SELECT 1 FROM normalized_findings WHERE job_id = $1', [theirs]))).toHaveLength(1);
  });

  it('frees the idempotency key: replaying an erased request creates a NEW job instead of pointing at the tombstone', async () => {
    const key = `erase-idem-${crypto.randomBytes(5).toString('hex')}`; const ref = 'IDEM-REF-' + crypto.randomBytes(3).toString('hex');
    const b = body(ref);
    const first = await submit(tenantA, b, key); expect(first.r.status).toBe(202);
    await erase(tenantA, { externalRef: ref, confirm: true });
    const again = await submit(tenantA, b, key);
    expect(again.r.status).toBe(202); expect(again.j.id).not.toBe(first.j.id);
    expect((await q('SELECT status FROM interpretation_jobs WHERE id = $1', [first.j.id]))[0].status).toBe('erased');
    await drain();
  });

  // ── concurrency ────────────────────────────────────────────────────────────────────────────

  it('erasure racing the worker never leaves findings behind (row lock + fenced commit)', async () => {
    await drain();
    for (let i = 0; i < 8; i++) {
      const ref = `RACE-${i}-${crypto.randomBytes(2).toString('hex')}`;
      const { j } = await submit(tenantA, body(ref, (r) => { r.subject.identity = { name: `Racer ${i}` }; }));
      await Promise.all([worker.runOnce(), erase(tenantA, { externalRef: ref, confirm: true })]);
      await drain();
      expect((await q('SELECT status FROM interpretation_jobs WHERE id = $1', [j.id]))[0].status, `iteration ${i}`).toBe('erased');
      for (const t of ['normalized_findings', 'source_payloads', 'identity_vault', 'interpretation_reports']) expect((await q(`SELECT 1 FROM ${t} WHERE job_id = $1`, [j.id])), `${t} iteration ${i}`).toHaveLength(0);
    }
  });

  // ── fingerprint (found while building erasure) ─────────────────────────────────────────────

  it('the stored request fingerprint cannot be used to test guesses about identity', async () => {
    const withId = body('FP-REF-1', (r) => { r.subject.identity = { name: 'Fingerprint Person', email: 'fp@example.invalid' }; });
    const key = `fp-${crypto.randomBytes(5).toString('hex')}`;
    const a = await submit(tenantA, withId, key);
    const [row] = await q('SELECT request_fingerprint FROM interpretation_jobs WHERE id = $1', [a.j.id]);
    const noIdentity = JSON.parse(JSON.stringify(withId)); delete noIdentity.subject.identity;
    expect(row.request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(row.request_fingerprint).not.toBe(contentHash(withId));       // not a plain hash of the body an attacker could recompute
    expect(row.request_fingerprint).not.toBe(contentHash(noIdentity));
    // ...and idempotency still works: same body replays, a body that differs only in identity is a different request.
    expect((await submit(tenantA, withId, key)).r.status).toBe(200);
    const changed = JSON.parse(JSON.stringify(withId)); changed.subject.identity.name = 'Someone Else';
    expect((await submit(tenantA, changed, key)).r.status).toBe(409);
    // an identity-free body has nothing to guess and keeps the plain hash
    const plain = body('FP-REF-2', (r) => { delete r.subject.identity; }); const p = await submit(tenantA, plain);
    expect((await q('SELECT request_fingerprint FROM interpretation_jobs WHERE id = $1', [p.j.id]))[0].request_fingerprint).toBe(contentHash(plain));
    await drain();
  });
});
