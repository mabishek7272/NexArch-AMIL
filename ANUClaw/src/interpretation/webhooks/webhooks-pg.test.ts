/**
 * Webhook registration, outbox and delivery (interpretation engine, P3c) against REAL PostgreSQL (disposable database;
 * opt-in via ANUCLAW_TEST_PG_URL) over the real HTTP layer. The network is replaced by an injected `post`/`resolve`
 * (the real transport is tested against a real TLS server in transport.test.ts). Synthetic data only.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../container-runner', () => ({ runAgent: vi.fn(async () => ({ text: 'unused', artifacts: [] })) }));

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/examples/beaive-vitals.request.json'), 'utf8'));
const SKILL = 'physiological-signal-interpretation';
const HOOK = 'https://93.184.216.34/anuclaw/hook'; // a public IP literal: no DNS needed
const publicResolve = async () => [{ address: '93.184.216.34', family: 4 }];

describe.skipIf(!URL_)('webhooks: registration, outbox and delivery (real PostgreSQL)', () => {
  const dbName = `anuclaw_wh_${crypto.randomBytes(6).toString('hex')}`;
  const ADMIN = crypto.randomBytes(24).toString('hex');
  let admin: Client; let server: Server; let base: string;
  let mainPool: { end(): Promise<void> } | undefined;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let delivery: typeof import('./delivery');
  let jobs: typeof import('../jobs/worker');
  let signing: typeof import('./signing');
  let tenantA: { id: string; key: string }; let tenantB: { id: string; key: string };
  const secrets: Record<string, string> = {};

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
    delivery = await import('./delivery'); jobs = await import('../jobs/worker'); signing = await import('./signing');

    const express = (await import('express')).default;
    const app = express(); app.use(express.json({ limit: '2mb' }));
    app.use((await import('../tenancy/admin-routes')).createTenantAdminRouter({ adminKey: ADMIN }));
    app.use((await import('../skills/admin-routes')).createSkillAdminRouter({ adminKey: ADMIN }));
    app.use('/api/v1', (await import('../../api/routes/tenants')).default);
    app.use('/api/v1', (await import('./routes')).default);
    app.use((await import('../jobs/routes')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    tenantA = await newTenant('Synthetic Hookco'); tenantB = await newTenant('Synthetic Other');
    for (const t of [tenantA, tenantB]) expect((await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/${SKILL}`, {})).status).toBe(201);
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
  const payload = () => { const r = JSON.parse(JSON.stringify(EXAMPLE)); r.tenantRequestId = `synthetic-${crypto.randomBytes(4).toString('hex')}`; return r; };
  const submit = async (t: { key: string }) => (await (await as(t.key, 'POST', '/v1/interpretations', payload())).json()).id as string;
  const drainJobs = async () => { for (let i = 0; i < 50; i++) if ((await jobs.runOnce()) === null) return; };
  const register = async (t: { key: string; id: string }, url = HOOK) => {
    const r = await as(t.key, 'PUT', '/api/v1/account/webhook', { url }); return { r, b: await r.json() };
  };
  const deliveries = (t: { id: string }) => q('SELECT * FROM webhook_deliveries WHERE tenant_id = $1 ORDER BY created_at, id', [t.id]);
  type Sent = { headers: Record<string, string>; body: string; address: string };
  const fakeNet = (status: number | null = 204, error: string | null = null) => {
    const sent: Sent[] = [];
    const post = vi.fn(async (target: any, headers: Record<string, string>, body: string) => { sent.push({ headers, body, address: target.address }); return { statusCode: status, error }; });
    return { sent, post };
  };

  // ── registration ───────────────────────────────────────────────────────────────────────────

  it('refuses private, loopback, link-local, metadata, http, credentialed and odd URLs, and stores nothing', async () => {
    for (const url of ['http://93.184.216.34/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://10.0.0.5/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x',
      'https://[::ffff:127.0.0.1]/x', 'https://2130706433/x', 'https://u:p@93.184.216.34/x', 'https://93.184.216.34:22/x', 'ftp://93.184.216.34/x', 'nonsense', '']) {
      const { r, b } = await register(tenantA, url);
      expect(r.status, url).toBe(400); expect(b.error.code, url).toBe('webhook_url_rejected');
    }
    expect((await q('SELECT 1 FROM tenant_webhooks WHERE tenant_id = $1', [tenantA.id]))).toHaveLength(0);
    expect((await q('SELECT webhook_url FROM tenants WHERE tenant_id = $1', [tenantA.id]))[0].webhook_url).toBeNull();
    expect((await as(tenantA.key, 'PUT', '/api/v1/account/webhook', {})).status).toBe(400);
  });

  it('first registration returns the signing secret ONCE; it is stored sealed and never returned again', async () => {
    const { r, b } = await register(tenantA);
    expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store');
    expect(b.signing_secret).toMatch(/^whsec_[0-9a-f]{64}$/); secrets[tenantA.id] = b.signing_secret;
    const [row] = await q('SELECT * FROM tenant_webhooks WHERE tenant_id = $1', [tenantA.id]);
    expect(JSON.stringify(row)).not.toContain(b.signing_secret);
    expect(Buffer.from(row.secret_sealed, 'base64').toString('latin1')).not.toContain(b.signing_secret);

    const again = await register(tenantA, 'https://93.184.216.34/anuclaw/hook2');
    expect(again.b.signing_secret).toBeUndefined(); expect(again.b.url).toBe('https://93.184.216.34/anuclaw/hook2');
    const got = await (await as(tenantA.key, 'GET', '/api/v1/account/webhook')).json();
    expect(got).toMatchObject({ configured: true, enabled: true, url: 'https://93.184.216.34/anuclaw/hook2' });
    expect(JSON.stringify(got)).not.toMatch(/whsec_|sealed/);
    expect((await q('SELECT webhook_url FROM tenants WHERE tenant_id = $1', [tenantA.id]))[0].webhook_url).toBe('https://93.184.216.34/anuclaw/hook2');
    await register(tenantA);
  });

  it('refuses to register when no signing key is configured (503) and stores nothing', async () => {
    const saved = process.env.ANUCLAW_WEBHOOK_SECRET_KEY; delete process.env.ANUCLAW_WEBHOOK_SECRET_KEY;
    try {
      const { r, b } = await register(tenantB);
      expect(r.status).toBe(503); expect(b.error.code).toBe('webhook_signing_unavailable');
      expect((await q('SELECT 1 FROM tenant_webhooks WHERE tenant_id = $1', [tenantB.id]))).toHaveLength(0);
    } finally { process.env.ANUCLAW_WEBHOOK_SECRET_KEY = saved; }
  });

  it('rotation returns a new secret once and the old one stops verifying new events', async () => {
    const t = await newTenant('Synthetic Rotator'); await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/${SKILL}`, {});
    const first = (await register(t)).b.signing_secret as string;
    const rot = await as(t.key, 'POST', '/api/v1/account/webhook/secret/rotate');
    const second = (await rot.json()).signing_secret as string;
    expect(second).toMatch(/^whsec_/); expect(second).not.toBe(first);
    await submit(t); await drainJobs();
    const net = fakeNet(); await delivery.runOnce({ post: net.post, resolve: publicResolve });
    expect(net.sent).toHaveLength(1);
    const { headers, body } = net.sent[0];
    expect(signing.verifySignature(second, headers['Anukla-Signature'], body)).toEqual({ ok: true });
    expect(signing.verifySignature(first, headers['Anukla-Signature'], body)).toMatchObject({ ok: false });
    expect((await as(tenantB.key, 'POST', '/api/v1/account/webhook/secret/rotate')).status).toBe(404); // tenantB has none
  });

  // ── outbox ─────────────────────────────────────────────────────────────────────────────────

  it('a completed job queues one completed event with ids/hashes only (no subject reference, values or identity)', async () => {
    await drainJobs(); await q('DELETE FROM webhook_deliveries WHERE tenant_id = $1', [tenantA.id]);
    const id = await submit(tenantA); await drainJobs();
    const rows = await deliveries(tenantA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_id: id, event_type: 'interpretation.completed', status: 'pending', attempts: 0 });
    const body = JSON.parse(rows[0].payload_json);
    expect(body).toMatchObject({ id: rows[0].event_id, type: 'interpretation.completed', data: { jobId: id, skillId: SKILL, status: 'completed' } });
    expect(body.data.findingsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.data.links).toEqual({ self: `/v1/interpretations/${id}`, findings: `/v1/interpretations/${id}/findings` });
    expect(rows[0].payload_json).not.toMatch(/SYNTH-SUBJECT|Synthetic Test Patient|synthetic@example|154|bp_systolic/);
  });

  it('a tenant without a webhook gets no outbox rows', async () => {
    const t = await newTenant('Synthetic Quiet'); await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/${SKILL}`, {});
    await submit(t); await drainJobs();
    expect(await deliveries(t)).toHaveLength(0);
  });

  it('a permanent failure queues a failed event with the error code only', async () => {
    await drainJobs(); await q('DELETE FROM webhook_deliveries WHERE tenant_id = $1', [tenantA.id]);
    const id = await submit(tenantA);
    await q(`UPDATE interpretation_jobs SET skill_id = 'clinical-report-generation' WHERE id = $1`, [id]); // adapter with no implementation
    expect(await jobs.runOnce()).toBe('failed');
    const [row] = await deliveries(tenantA);
    expect(row.event_type).toBe('interpretation.failed');
    expect(JSON.parse(row.payload_json).data).toMatchObject({ jobId: id, status: 'failed', errorCode: 'adapter_unavailable' });
  });

  it('the job change and its notification are ATOMIC: if the outbox insert fails, the job does not complete', async () => {
    await drainJobs(); await q('DELETE FROM webhook_deliveries WHERE tenant_id = $1', [tenantA.id]);
    const id = await submit(tenantA);
    await q('ALTER TABLE webhook_deliveries RENAME TO webhook_deliveries_x');
    try { expect(await jobs.runOnce()).toBe('retry'); } finally { await q('ALTER TABLE webhook_deliveries_x RENAME TO webhook_deliveries'); }
    expect((await q('SELECT status FROM interpretation_jobs WHERE id = $1', [id]))[0].status).toBe('queued');
    expect((await q('SELECT 1 FROM normalized_findings WHERE job_id = $1', [id]))).toHaveLength(0);
    expect(await deliveries(tenantA)).toHaveLength(0);
    await q('UPDATE interpretation_jobs SET run_after = 0 WHERE id = $1', [id]); await drainJobs(); // and it recovers
    expect((await q('SELECT status FROM interpretation_jobs WHERE id = $1', [id]))[0].status).toBe('completed');
    expect(await deliveries(tenantA)).toHaveLength(1);
  });

  // ── delivery ───────────────────────────────────────────────────────────────────────────────

  it('delivers the stored bytes with a verifiable signature, the event id, the attempt number, to the PINNED address', async () => {
    await drainJobs(); await q('DELETE FROM webhook_deliveries WHERE tenant_id = $1', [tenantA.id]);
    await submit(tenantA); await drainJobs();
    const [row] = await deliveries(tenantA);
    const net = fakeNet(204);
    expect(await delivery.runOnce({ post: net.post, resolve: publicResolve })).toBe('delivered');
    const { headers, body, address } = net.sent[0];
    expect(address).toBe('93.184.216.34');
    expect(body).toBe(row.payload_json);
    expect(headers['Anukla-Event-Id']).toBe(row.event_id); expect(headers['Anukla-Event-Type']).toBe('interpretation.completed'); expect(headers['Anukla-Delivery-Attempt']).toBe('1');
    expect(headers['Content-Type']).toBe('application/json');
    expect(signing.verifySignature(secrets[tenantA.id], headers['Anukla-Signature'], body)).toEqual({ ok: true });
    expect((await deliveries(tenantA))[0]).toMatchObject({ status: 'delivered', attempts: 1, last_status_code: 204, last_error: null, claim_token: null });
    expect(await delivery.runOnce({ post: net.post, resolve: publicResolve })).toBeNull(); // nothing left
  });

  it('retries after 1 min, 5 min, 30 min, 2 h, 12 h with identical bytes and event id, a fresh timestamp each time, then is dead', async () => {
    await drainJobs(); await q('DELETE FROM webhook_deliveries WHERE tenant_id = $1', [tenantA.id]);
    await submit(tenantA); await drainJobs();
    const net = fakeNet(500);
    let clock = Date.now() + 5000;
    const expectDelay = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
    for (let attempt = 1; attempt <= 6; attempt++) {
      const out = await delivery.runOnce({ post: net.post, resolve: publicResolve, now: () => clock });
      const [row] = await deliveries(tenantA);
      expect(row.attempts).toBe(attempt); expect(row.last_error).toBe('http_500'); expect(row.last_status_code).toBe(500);
      if (attempt < 6) {
        expect(out).toBe('retry'); expect(row.status).toBe('pending');
        expect(Number(row.run_after)).toBe(clock + expectDelay[attempt - 1]);
        expect(await delivery.runOnce({ post: net.post, resolve: publicResolve, now: () => clock + expectDelay[attempt - 1] - 1 })).toBeNull(); // not before it is due
        clock += expectDelay[attempt - 1];
      } else { expect(out).toBe('dead'); expect(row.status).toBe('dead'); expect(Number(row.dead_at)).toBe(clock); }
    }
    expect(net.sent).toHaveLength(6);
    expect(new Set(net.sent.map((s) => s.body)).size).toBe(1);
    expect(new Set(net.sent.map((s) => s.headers['Anukla-Event-Id'])).size).toBe(1);
    expect(net.sent.map((s) => s.headers['Anukla-Delivery-Attempt'])).toEqual(['1', '2', '3', '4', '5', '6']);
    const stamps = net.sent.map((s) => Number(/t=(\d+)/.exec(s.headers['Anukla-Signature'])![1]));
    expect(new Set(stamps).size).toBe(6); // each attempt is signed at its own time, so the receiver's replay window works
    expect(await delivery.runOnce({ post: net.post, resolve: publicResolve, now: () => clock + 10 * 3_600_000 })).toBeNull(); // dead is final
  });

  it('gives up once 24 h have passed since the first attempt, even with attempts left', async () => {
    await drainJobs(); await q('DELETE FROM webhook_deliveries WHERE tenant_id = $1', [tenantA.id]);
    await submit(tenantA); await drainJobs();
    const now = Date.now() + 5000;
    await q(`UPDATE webhook_deliveries SET attempts = 2, first_attempt_at = $2, status = 'pending' WHERE tenant_id = $1`, [tenantA.id, now - (24 * 3_600_000 - 10 * 60_000)]);
    const net = fakeNet(503);
    expect(await delivery.runOnce({ post: net.post, resolve: publicResolve, now: () => now })).toBe('dead'); // attempt 3 -> next in 30 min would pass 24 h
    expect((await deliveries(tenantA))[0]).toMatchObject({ status: 'dead', attempts: 3 });
  });

  it('records redirects as refused, network errors by code, and never stores a response body', async () => {
    for (const [status, error, expected] of [[302, null, 'redirect_refused'], [null, 'timeout', 'timeout'], [null, 'tls_error', 'tls_error'], [410, null, 'http_410']] as const) {
      await drainJobs(); await q('DELETE FROM webhook_deliveries WHERE tenant_id = $1', [tenantA.id]);
      await submit(tenantA); await drainJobs();
      await delivery.runOnce({ post: fakeNet(status, error).post, resolve: publicResolve, now: () => Date.now() + 5000 });
      expect((await deliveries(tenantA))[0]).toMatchObject({ status: 'pending', last_error: expected });
    }
  });

  it('re-checks the address at delivery time: a name that now resolves to a private address is NOT contacted', async () => {
    await drainJobs(); await q('DELETE FROM webhook_deliveries WHERE tenant_id = $1', [tenantA.id]);
    const saved = (await q('SELECT url FROM tenant_webhooks WHERE tenant_id = $1', [tenantA.id]))[0].url;
    await q(`UPDATE tenant_webhooks SET url = 'https://hooks.rebinding.example/hook' WHERE tenant_id = $1`, [tenantA.id]);
    try {
      await submit(tenantA); await drainJobs();
      const net = fakeNet(204);
      const out = await delivery.runOnce({ post: net.post, resolve: async () => [{ address: '169.254.169.254', family: 4 }], now: () => Date.now() + 5000 });
      expect(out).toBe('retry'); expect(net.post).not.toHaveBeenCalled();
      expect((await deliveries(tenantA))[0]).toMatchObject({ status: 'pending', last_error: 'blocked_address_blocked' });
    } finally { await q('UPDATE tenant_webhooks SET url = $2 WHERE tenant_id = $1', [tenantA.id, saved]); }
  });

  it('a webhook removed before delivery is dead without sending anything; removal also kills what is pending', async () => {
    const t = await newTenant('Synthetic Leaver'); await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/${SKILL}`, {});
    await register(t); await submit(t); await submit(t); await drainJobs();
    expect((await deliveries(t)).filter((d: any) => d.status === 'pending')).toHaveLength(2);
    expect((await as(t.key, 'DELETE', '/api/v1/account/webhook')).status).toBe(204);
    expect((await deliveries(t)).map((d: any) => d.status)).toEqual(['dead', 'dead']);
    expect((await q('SELECT webhook_url FROM tenants WHERE tenant_id = $1', [t.id]))[0].webhook_url).toBeNull();
    const net = fakeNet(); expect(await delivery.runOnce({ post: net.post, resolve: publicResolve })).toBeNull(); expect(net.post).not.toHaveBeenCalled();
    expect((await as(t.key, 'DELETE', '/api/v1/account/webhook')).status).toBe(404);
    // and a delivery that is already claimed when the endpoint disappears is also dead, not sent
    await register(t); await submit(t); await drainJobs();
    const claimed = (await delivery.claimNextDelivery(Date.now() + 5000))!;
    await as(t.key, 'DELETE', '/api/v1/account/webhook');
    await q(`UPDATE webhook_deliveries SET status = 'sending' WHERE id = $1`, [claimed.id]); // removal only touches pending rows
    expect(await delivery.attemptDelivery(claimed, { post: net.post, resolve: publicResolve })).toBe('dead');
    expect(net.post).not.toHaveBeenCalled();
  });

  it('with the signing key missing, delivery is retried (not sent, not lost)', async () => {
    await drainJobs(); await q('DELETE FROM webhook_deliveries WHERE tenant_id = $1', [tenantA.id]);
    await submit(tenantA); await drainJobs();
    const saved = process.env.ANUCLAW_WEBHOOK_SECRET_KEY; delete process.env.ANUCLAW_WEBHOOK_SECRET_KEY;
    try {
      const net = fakeNet();
      expect(await delivery.runOnce({ post: net.post, resolve: publicResolve, now: () => Date.now() + 5000 })).toBe('retry');
      expect(net.post).not.toHaveBeenCalled();
      expect((await deliveries(tenantA))[0]).toMatchObject({ status: 'pending', last_error: 'webhook_secret_key_not_configured' });
    } finally { process.env.ANUCLAW_WEBHOOK_SECRET_KEY = saved; }
  });

  // ── queue behaviour ────────────────────────────────────────────────────────────────────────

  it('concurrent claimers never receive the same delivery, and a stale claim is fenced out', async () => {
    await drainJobs(); await q('DELETE FROM webhook_deliveries WHERE tenant_id = $1', [tenantA.id]);
    for (let i = 0; i < 5; i++) await submit(tenantA);
    await drainJobs();
    const claims = (await Promise.all(Array.from({ length: 10 }, () => delivery.claimNextDelivery(Date.now() + 5000)))).filter(Boolean) as Array<{ id: string }>;
    expect(claims).toHaveLength(5); expect(new Set(claims.map((c) => c.id)).size).toBe(5);

    await q('DELETE FROM webhook_deliveries WHERE tenant_id = $1', [tenantA.id]);
    await submit(tenantA); await drainJobs();
    const t0 = Date.now() + 5000;
    const stale = (await delivery.claimNextDelivery(t0, 1000))!;
    const fresh = (await delivery.claimNextDelivery(t0 + 2000, 60_000))!; // lease expired: reclaimed
    expect(fresh.id).toBe(stale.id); expect(fresh.claim_token).not.toBe(stale.claim_token); expect(fresh.attempts).toBe(2);
    const net = fakeNet(204);
    expect(await delivery.attemptDelivery(stale, { post: net.post, resolve: publicResolve, now: () => t0 + 2500 })).toBe('lost');
    expect((await deliveries(tenantA))[0]).toMatchObject({ status: 'sending', claim_token: fresh.claim_token, last_status_code: null });
    expect(await delivery.attemptDelivery(fresh, { post: net.post, resolve: publicResolve })).toBe('delivered');
  });

  // ── visibility, isolation, audit ───────────────────────────────────────────────────────────

  it('the delivery log is tenant-scoped, filterable, and carries codes only (no payload)', async () => {
    const mine = await (await as(tenantA.key, 'GET', '/api/v1/account/webhook/deliveries?limit=100')).json();
    expect(mine.items.length).toBeGreaterThan(0);
    for (const i of mine.items) expect(Object.keys(i).sort()).toEqual(['attempts', 'createdAt', 'deadAt', 'deliveredAt', 'eventId', 'jobId', 'lastError', 'lastStatusCode', 'nextAttemptAt', 'status', 'type']);
    const ids = new Set((await q('SELECT event_id FROM webhook_deliveries WHERE tenant_id = $1', [tenantB.id])).map((r: any) => r.event_id));
    for (const i of mine.items) expect(ids.has(i.eventId)).toBe(false);
    const dead = await (await as(tenantA.key, 'GET', '/api/v1/account/webhook/deliveries?status=dead')).json();
    expect(dead.items.every((i: any) => i.status === 'dead')).toBe(true);
    expect((await as(tenantA.key, 'GET', '/api/v1/account/webhook/deliveries')).status).toBe(200);
    expect((await fetch(base + '/api/v1/account/webhook/deliveries')).status).toBe(401);
  });

  it('audits registration, rotation and removal with host and key id only, on an intact chain', async () => {
    const t = await newTenant('Synthetic Audited Hooks');
    const sec = (await register(t, 'https://93.184.216.34/very/secret/path?token=abc123')).b.signing_secret as string;
    await as(t.key, 'POST', '/api/v1/account/webhook/secret/rotate'); await as(t.key, 'DELETE', '/api/v1/account/webhook');
    const a = await (await adm('GET', `/api/v1/admin/tenants/${t.id}/audit`)).json();
    expect(a.entries.map((e: any) => e.event_type)).toEqual(expect.arrayContaining(['webhook.registered', 'webhook.secret_rotated', 'webhook.removed']));
    expect(a.chain.valid).toBe(true);
    const text = JSON.stringify(a.entries);
    expect(text).toContain('93.184.216.34');
    expect(text).not.toMatch(/whsec_|very\/secret|abc123/); expect(text).not.toContain(sec);
  });
});
