/**
 * Tenant lifecycle, multi-key credentials and tenant audit (interpretation engine, P1) against REAL PostgreSQL
 * (disposable database; opt-in via ANUCLAW_TEST_PG_URL) over the real HTTP layer. Synthetic tenants only.
 */
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('tenant lifecycle, keys and audit (real PostgreSQL)', () => {
  const dbName = `anuclaw_ten_${crypto.randomBytes(6).toString('hex')}`;
  const ADMIN = crypto.randomBytes(24).toString('hex');
  let admin: Client; let server: Server; let base: string;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let keysMod: typeof import('./keys');
  const issued: string[] = []; // every plaintext key this file ever saw — none may appear in storage or audit

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, {
      PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName,
      ANUCLAW_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    });
    delete process.env.ANUCLAW_SELF_REGISTRATION;
    delete process.env.ANUCLAW_RATE_STORE;
    vi.resetModules();
    await (await import('../../db/connection')).ensureDbReady();
    q = (await import('../../db')).db.query as any;
    keysMod = await import('./keys');
    const express = (await import('express')).default;
    const app = express(); app.use(express.json());
    app.use((await import('./admin-routes')).createTenantAdminRouter({ adminKey: ADMIN }));
    app.use('/api/v1', (await import('../../api/routes/tenants')).default);
    const { requireAuth } = await import('../../api/middleware/auth');
    app.get('/probe', requireAuth, (req: any, res) => res.json({ tenant: req.tenant.tenant_id, key: req.apiKeyId ?? null }));
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { (await import('../../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const adm = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method, headers: { 'x-admin-key': ADMIN, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const probe = (headers: Record<string, string>) => fetch(base + '/probe', { headers });
  const withKey = (k: string) => ({ 'x-api-key': k });
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const newTenant = async (name: string, plan?: string) => {
    const r = await adm('POST', '/api/v1/admin/tenants', { company_name: name, email: `${name.toLowerCase().replace(/\W+/g, '-')}-${crypto.randomBytes(3).toString('hex')}@synthetic.invalid`, plan });
    const b = await r.json();
    expect(r.status).toBe(201);
    issued.push(b.api_key);
    return { id: b.tenant_id as string, key: b.api_key as string };
  };
  const auditOf = async (id: string) => (await (await adm('GET', `/api/v1/admin/tenants/${id}/audit`)).json());
  const eventTypes = async (id: string) => (await auditOf(id)).entries.map((e: any) => e.event_type);

  // ── admin plane ──────────────────────────────────────────────────────────────────────────────

  it('the admin plane requires the admin key, and answers 503 when no admin key is configured at all', async () => {
    expect((await fetch(base + '/api/v1/admin/tenants')).status).toBe(401);
    expect((await adm('GET', '/api/v1/admin/tenants', undefined, { 'x-admin-key': 'wrong' })).status).toBe(401);
    const saved = process.env.ADMIN_API_KEY; delete process.env.ADMIN_API_KEY;
    try {
      const express = (await import('express')).default;
      const closed = express(); closed.use((await import('./admin-routes')).createTenantAdminRouter());
      const s = await new Promise<Server>((r) => { const x = closed.listen(0, '127.0.0.1', () => r(x)); });
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/v1/admin/tenants`, { headers: { 'x-admin-key': 'anything' } });
      expect(res.status).toBe(503);
      await new Promise<void>((r) => s.close(() => r()));
    } finally { if (saved !== undefined) process.env.ADMIN_API_KEY = saved; }
  });

  it('creates a tenant with a first key shown once; storage holds only a hash; listings never expose key material', async () => {
    const r = await adm('POST', '/api/v1/admin/tenants', { company_name: 'Synthetic Alpha', email: 'alpha@synthetic.invalid', plan: 'pro' }, { 'x-admin-actor': 'dr-synthetic', 'x-request-id': 'req-abc-1' });
    const b = await r.json();
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-request-id')).toBe('req-abc-1');
    expect(b.api_key).toMatch(/^amgi_live_[0-9a-f]{48}$/);
    issued.push(b.api_key);
    expect((await probe(withKey(b.api_key))).status).toBe(200);

    const rows = await q('SELECT * FROM tenant_api_keys WHERE tenant_id = $1', [b.tenant_id]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(b.api_key);
    expect(rows[0].key_hash).toBe(keysMod.hashApiKey(b.api_key));
    expect(rows[0].label).toBe('initial');

    const list = await (await adm('GET', `/api/v1/admin/tenants/${b.tenant_id}/keys`)).json();
    expect(JSON.stringify(list)).not.toMatch(/key_hash|amgi_live_[0-9a-f]{20}/);
    expect(list.keys[0].key_prefix).toBe(b.api_key.slice(0, 14));

    const audit = await auditOf(b.tenant_id);
    expect(audit.entries[0].event_type).toBe('tenant.created');
    expect(audit.entries[0].payload.declared_actor).toBe('dr-synthetic');
    expect(audit.entries[0].payload.request_id).toBe('req-abc-1');
    expect(audit.entries[0].actor).toBe('admin_api');
    expect(JSON.stringify(audit)).not.toContain('alpha@synthetic.invalid'); // e-mail stays out of the immutable chain
    expect(audit.entries[0].payload.email_domain).toBe('synthetic.invalid');
  });

  it('rejects duplicate e-mails case-insensitively and validates input', async () => {
    await adm('POST', '/api/v1/admin/tenants', { company_name: 'Dup', email: 'Dup@Synthetic.Invalid' });
    const dup = await adm('POST', '/api/v1/admin/tenants', { company_name: 'Dup2', email: 'dup@synthetic.invalid' });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe('email_already_registered');
    expect((await adm('POST', '/api/v1/admin/tenants', { company_name: '', email: 'x@y.invalid' })).status).toBe(400);
    expect((await adm('POST', '/api/v1/admin/tenants', { company_name: 'X', email: 'not-an-email' })).status).toBe(400);
    expect((await adm('POST', '/api/v1/admin/tenants', { company_name: 'X', email: 'x@y.invalid', plan: 'platinum' })).status).toBe(400);
  });

  it('lists tenants with paginated results and an active-key count', async () => {
    const t = await newTenant('Synthetic List');
    const page = await (await adm('GET', '/api/v1/admin/tenants?limit=1&offset=0')).json();
    expect(page.tenants).toHaveLength(1);
    const all = await (await adm('GET', '/api/v1/admin/tenants?limit=200')).json();
    expect(all.tenants.find((x: any) => x.tenant_id === t.id).active_keys).toBe(1);
  });

  // ── keys ─────────────────────────────────────────────────────────────────────────────────────

  it('supports several keys at once; each works independently; scopes and labels are validated', async () => {
    const t = await newTenant('Synthetic Multi');
    const second = await (await adm('POST', `/api/v1/admin/tenants/${t.id}/keys`, { label: 'ci', scopes: ['interpret'] })).json();
    issued.push(second.api_key);
    expect(second.key.scopes).toEqual(['interpret']);
    const a = await (await probe(withKey(t.key))).json(); const b = await (await probe(withKey(second.api_key))).json();
    expect(a.tenant).toBe(t.id); expect(b.tenant).toBe(t.id);
    expect(a.key).not.toBe(b.key);
    expect((await adm('POST', `/api/v1/admin/tenants/${t.id}/keys`, { scopes: ['BAD SCOPE'] })).status).toBe(400);
    expect((await adm('POST', `/api/v1/admin/tenants/${t.id}/keys`, { scopes: [] })).status).toBe(400);
    expect((await adm('POST', `/api/v1/admin/tenants/${t.id}/keys`, { label: 'x'.repeat(101) })).status).toBe(400);
    expect((await adm('POST', `/api/v1/admin/tenants/${t.id}/keys`, { expires_at: Date.now() - 1000 })).status).toBe(400);
  });

  it('caps active keys per tenant', async () => {
    const t = await newTenant('Synthetic Cap');
    for (let i = 1; i < keysMod.MAX_ACTIVE_KEYS_PER_TENANT; i++) {
      const r = await adm('POST', `/api/v1/admin/tenants/${t.id}/keys`, { label: `k${i}` });
      expect(r.status).toBe(201); issued.push((await r.json()).api_key);
    }
    const over = await adm('POST', `/api/v1/admin/tenants/${t.id}/keys`, { label: 'one-too-many' });
    expect(over.status).toBe(409);
    expect((await over.json()).error.code).toBe('key_limit_reached');
  });

  it('revoking a key stops it at once (401 key_revoked), is idempotent, and leaves other keys working', async () => {
    const t = await newTenant('Synthetic Revoke');
    const extra = await (await adm('POST', `/api/v1/admin/tenants/${t.id}/keys`, { label: 'extra' })).json(); issued.push(extra.api_key);
    const first = (await (await probe(withKey(t.key))).json()).key;

    const r1 = await adm('POST', `/api/v1/admin/tenants/${t.id}/keys/${first}/revoke`, { reason: 'leaked in a log' });
    expect(r1.status).toBe(200);
    expect((await r1.json()).already_revoked).toBe(false);
    const dead = await probe(withKey(t.key));
    expect(dead.status).toBe(401);
    expect((await dead.json()).code).toBe('key_revoked');
    expect((await probe(withKey(extra.api_key))).status).toBe(200);

    const r2 = await adm('POST', `/api/v1/admin/tenants/${t.id}/keys/${first}/revoke`, {});
    expect((await r2.json()).already_revoked).toBe(true);
    expect((await eventTypes(t.id)).filter((e: string) => e === 'tenant.key.revoked')).toHaveLength(2); // both attempts are on the record
  });

  it('a key id that belongs to another tenant is "not found" for rotate and revoke (no cross-tenant action, no leak)', async () => {
    const a = await newTenant('Synthetic IsoA'); const b = await newTenant('Synthetic IsoB');
    const bKeyId = (await (await probe(withKey(b.key))).json()).key;
    for (const action of ['revoke', 'rotate']) {
      const r = await adm('POST', `/api/v1/admin/tenants/${a.id}/keys/${bKeyId}/${action}`, {});
      expect(r.status).toBe(404);
      expect((await r.json()).error.code).toBe('key_not_found');
    }
    expect((await probe(withKey(b.key))).status).toBe(200);
    expect((await eventTypes(a.id))).toEqual(['tenant.created']); // nothing recorded on A for a refused action
    expect((await adm('GET', '/api/v1/admin/tenants/%20bad%20/keys')).status).toBe(404);
    expect((await adm('GET', `/api/v1/admin/tenants/${crypto.randomUUID()}/keys`)).status).toBe(200); // unknown tenant lists no keys
    expect((await adm('POST', `/api/v1/admin/tenants/${crypto.randomUUID()}/keys`, {})).status).toBe(404);
  });

  it('rotation: the new key works now; the old key keeps working for the grace period, then answers key_expired', async () => {
    const t = await newTenant('Synthetic Rotate');
    const oldId = (await (await probe(withKey(t.key))).json()).key;
    const r = await adm('POST', `/api/v1/admin/tenants/${t.id}/keys/${oldId}/rotate`, { grace_seconds: 3600 });
    const b = await r.json(); issued.push(b.api_key);
    expect(r.status).toBe(201);
    expect(b.key.key_id).not.toBe(oldId);
    expect(b.retired_key.expires_at).toBeGreaterThan(Date.now());
    expect((await probe(withKey(b.api_key))).status).toBe(200);
    expect((await probe(withKey(t.key))).status).toBe(200); // still inside the grace window

    await q('UPDATE tenant_api_keys SET expires_at = $2 WHERE key_id = $1', [oldId, Date.now() - 1000]); // the grace window ends
    const lapsed = await probe(withKey(t.key));
    expect(lapsed.status).toBe(401);
    expect((await lapsed.json()).code).toBe('key_expired');
    const rows = await q('SELECT rotated_from FROM tenant_api_keys WHERE key_id = $1', [b.key.key_id]);
    expect(rows[0].rotated_from).toBe(oldId);
  });

  it('rotation with no grace revokes the old key immediately; revoked/expired keys cannot be rotated; bad grace is refused', async () => {
    const t = await newTenant('Synthetic Rotate0');
    const oldId = (await (await probe(withKey(t.key))).json()).key;
    expect((await adm('POST', `/api/v1/admin/tenants/${t.id}/keys/${oldId}/rotate`, { grace_seconds: keysMod.MAX_ROTATION_GRACE_SECONDS + 1 })).status).toBe(400);
    expect((await adm('POST', `/api/v1/admin/tenants/${t.id}/keys/${oldId}/rotate`, { grace_seconds: -1 })).status).toBe(400);
    const r = await adm('POST', `/api/v1/admin/tenants/${t.id}/keys/${oldId}/rotate`, { grace_seconds: 0 });
    const b = await r.json(); issued.push(b.api_key);
    expect((await (await probe(withKey(t.key))).json()).code).toBe('key_revoked');
    const again = await adm('POST', `/api/v1/admin/tenants/${t.id}/keys/${oldId}/rotate`, {});
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe('key_revoked');
  });

  it('an expiring key works until its time, then answers key_expired', async () => {
    const t = await newTenant('Synthetic Expiry');
    const made = await (await adm('POST', `/api/v1/admin/tenants/${t.id}/keys`, { label: 'short', expires_at: Date.now() + 3_600_000 })).json(); issued.push(made.api_key);
    expect((await probe(withKey(made.api_key))).status).toBe(200);
    await q('UPDATE tenant_api_keys SET expires_at = $2 WHERE key_id = $1', [made.key.key_id, Date.now() - 1]);
    expect((await (await probe(withKey(made.api_key))).json()).code).toBe('key_expired');
  });

  it('records last use (and does not rewrite it on every request)', async () => {
    const t = await newTenant('Synthetic LastUsed');
    const id = (await (await probe(withKey(t.key))).json()).key;
    const first = (await q('SELECT last_used_at FROM tenant_api_keys WHERE key_id = $1', [id]))[0].last_used_at;
    expect(Number(first)).toBeGreaterThan(0);
    await probe(withKey(t.key)); await probe(withKey(t.key));
    const later = (await q('SELECT last_used_at FROM tenant_api_keys WHERE key_id = $1', [id]))[0].last_used_at;
    expect(later).toBe(first);
  });

  // ── tenant status, tokens ────────────────────────────────────────────────────────────────────

  it('suspending a tenant blocks its keys AND its tokens; reactivating restores them', async () => {
    const t = await newTenant('Synthetic Suspend');
    const tok = (await (await fetch(`${base}/api/v1/token`, { method: 'POST', headers: withKey(t.key) })).json()).access_token;
    expect((await probe(bearer(tok))).status).toBe(200);

    const s = await adm('POST', `/api/v1/admin/tenants/${t.id}/suspend`, {});
    expect((await s.json())).toMatchObject({ before: 'active', after: 'suspended' });
    for (const h of [withKey(t.key), bearer(tok)]) {
      const r = await probe(h);
      expect(r.status).toBe(401);
      expect((await r.json()).code).toBe('tenant_suspended');
    }
    await adm('POST', `/api/v1/admin/tenants/${t.id}/reactivate`, {});
    expect((await probe(withKey(t.key))).status).toBe(200);
    expect((await probe(bearer(tok))).status).toBe(200);
    expect(await eventTypes(t.id)).toEqual(['tenant.created', 'tenant.suspended', 'tenant.reactivated']);
  });

  it('a token is tied to the key that minted it: revoking the key ends its tokens, and a token cannot mint another token', async () => {
    const t = await newTenant('Synthetic Token');
    const keyId = (await (await probe(withKey(t.key))).json()).key;
    const mint = await fetch(`${base}/api/v1/token`, { method: 'POST', headers: withKey(t.key) });
    const tok = (await mint.json()).access_token;
    expect((await (await probe(bearer(tok))).json()).key).toBe(keyId);

    const viaToken = await fetch(`${base}/api/v1/token`, { method: 'POST', headers: bearer(tok) });
    expect(viaToken.status).toBe(401);
    expect((await viaToken.json()).code).toBe('api_key_required');

    await adm('POST', `/api/v1/admin/tenants/${t.id}/keys/${keyId}/revoke`, {});
    const after = await probe(bearer(tok));
    expect(after.status).toBe(401);
    expect((await after.json()).code).toBe('key_revoked');
  });

  // ── the plan hole, registration ──────────────────────────────────────────────────────────────

  it('a tenant can no longer change its own plan; only an administrator can, and it is audited', async () => {
    const t = await newTenant('Synthetic Plan');
    const own = await fetch(`${base}/api/v1/account/plan`, { method: 'PUT', headers: { ...withKey(t.key), 'content-type': 'application/json' }, body: JSON.stringify({ plan: 'enterprise' }) });
    expect(own.status).toBe(403);
    expect((await own.json()).code).toBe('plan_change_requires_admin');
    expect((await q('SELECT plan FROM tenants WHERE tenant_id = $1', [t.id]))[0].plan).toBe('free');

    expect((await adm('PUT', `/api/v1/admin/tenants/${t.id}/plan`, { plan: 'platinum' })).status).toBe(400);
    const ok = await adm('PUT', `/api/v1/admin/tenants/${t.id}/plan`, { plan: 'pro' });
    expect(await ok.json()).toMatchObject({ before: 'free', after: 'pro' });
    expect((await q('SELECT plan FROM tenants WHERE tenant_id = $1', [t.id]))[0].plan).toBe('pro');
    expect((await auditOf(t.id)).entries.at(-1)).toMatchObject({ event_type: 'tenant.plan_changed', payload: { before: 'free', after: 'pro' } });
  });

  it('public registration is closed by default; when opened it always creates a free tenant and is audited', async () => {
    const closed = await fetch(`${base}/api/v1/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company_name: 'Sneaky', email: 'sneaky@synthetic.invalid' }) });
    expect(closed.status).toBe(403);
    expect((await closed.json()).code).toBe('registration_closed');

    process.env.ANUCLAW_SELF_REGISTRATION = 'open';
    try {
      const body = (plan?: string) => JSON.stringify({ company_name: 'Open Co', email: `open-${crypto.randomBytes(3).toString('hex')}@synthetic.invalid`, plan });
      const greedy = await fetch(`${base}/api/v1/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body('enterprise') });
      expect(greedy.status).toBe(400);
      expect((await greedy.json()).code).toBe('plan_requires_admin');
      const ok = await fetch(`${base}/api/v1/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body() });
      const b = await ok.json(); issued.push(b.api_key);
      expect(ok.status).toBe(201);
      expect(b.plan).toBe('free');
      expect((await probe(withKey(b.api_key))).status).toBe(200);
      const audit = await auditOf(b.tenant_id);
      expect(audit.entries[0]).toMatchObject({ event_type: 'tenant.created', actor: 'self_registration' });
    } finally { delete process.env.ANUCLAW_SELF_REGISTRATION; }
  });

  // ── legacy keys ──────────────────────────────────────────────────────────────────────────────

  it('a pre-existing plaintext key is hashed, backfilled and keeps working; revoking it sticks across migrations', async () => {
    const legacy = 'amgi_live_' + crypto.randomBytes(24).toString('hex'); issued.push(legacy);
    const tid = crypto.randomUUID();
    await q(`INSERT INTO tenants (tenant_id, company_name, email, api_key, plan, rate_limit_per_min, monthly_quota, created_at) VALUES ($1,'Synthetic Legacy',$2,$3,'free',0,NULL,'x')`, [tid, `${tid}@synthetic.invalid`, legacy]);
    const { migrate, getDb } = await import('../../db/connection');
    await migrate(getDb());
    expect((await probe(withKey(legacy))).status).toBe(200);
    const row = (await q('SELECT key_id, label, created_by FROM tenant_api_keys WHERE tenant_id = $1', [tid]))[0];
    expect(row).toEqual({ key_id: `legacy-${tid}`, label: 'legacy', created_by: 'migration' });

    await adm('POST', `/api/v1/admin/tenants/${tid}/keys/${row.key_id}/revoke`, {});
    expect((await (await probe(withKey(legacy))).json()).code).toBe('key_revoked');
    await migrate(getDb()); // must not revive it
    expect((await (await probe(withKey(legacy))).json()).code).toBe('key_revoked');
  });

  it('a key present only in tenants.api_key_hash (older code registered it after the migration) is adopted on first use and stays revocable', async () => {
    const legacy = 'amgi_live_' + crypto.randomBytes(24).toString('hex'); issued.push(legacy);
    const tid = crypto.randomUUID();
    await q(`INSERT INTO tenants (tenant_id, company_name, email, api_key, api_key_hash, api_key_prefix, plan, rate_limit_per_min, monthly_quota, created_at) VALUES ($1,'Synthetic Old Code',$2,$3,$4,$5,'free',0,NULL,'x')`,
      [tid, `${tid}@synthetic.invalid`, `hashed:${tid}`, keysMod.hashApiKey(legacy), legacy.slice(0, 14)]);
    expect((await q('SELECT 1 FROM tenant_api_keys WHERE tenant_id = $1', [tid]))).toHaveLength(0);
    expect((await probe(withKey(legacy))).status).toBe(200);
    expect((await q('SELECT created_by FROM tenant_api_keys WHERE tenant_id = $1', [tid]))[0].created_by).toBe('adopted');
    await adm('POST', `/api/v1/admin/tenants/${tid}/keys/legacy-${tid}/revoke`, {});
    expect((await (await probe(withKey(legacy))).json()).code).toBe('key_revoked'); // adoption must not resurrect it
  });

  it('unknown, malformed and placeholder keys get the generic 401', async () => {
    for (const bad of ['short', 'amgi_live_' + '0'.repeat(48), 'hashed:whatever-placeholder-value']) {
      const r = await probe(withKey(bad));
      expect(r.status).toBe(401);
      expect((await r.json()).code).toBe('unauthorized');
    }
  });

  // ── audit ────────────────────────────────────────────────────────────────────────────────────

  it('every tenant has its own tamper-evident chain; the chain verifies and entries are never shared between tenants', async () => {
    const a = await newTenant('Synthetic ChainA'); const b = await newTenant('Synthetic ChainB');
    const k = await (await adm('POST', `/api/v1/admin/tenants/${a.id}/keys`, { label: 'x' })).json(); issued.push(k.api_key);
    await adm('POST', `/api/v1/admin/tenants/${a.id}/keys/${k.key.key_id}/revoke`, { reason: 'test' });
    const A = await auditOf(a.id); const B = await auditOf(b.id);
    expect(A.chain.valid).toBe(true); expect(B.chain.valid).toBe(true);
    expect(A.entries.map((e: any) => e.seq)).toEqual([1, 2, 3]);
    expect(B.entries.map((e: any) => e.seq)).toEqual([1]);
    expect(A.entries.map((e: any) => e.event_type)).toEqual(['tenant.created', 'tenant.key.created', 'tenant.key.revoked']);
    expect(JSON.stringify(B)).not.toContain(a.id);
    expect((await adm('GET', `/api/v1/admin/tenants/${crypto.randomUUID()}/audit`)).status).toBe(404);
  });

  it('the audit table is append-only at the database level', async () => {
    const t = await newTenant('Synthetic Append');
    await expect(q(`UPDATE cds_audit_log_mt SET actor = 'attacker' WHERE tenant_id = $1`, [t.id])).rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM cds_audit_log_mt WHERE tenant_id = $1`, [t.id])).rejects.toThrow(/append-only/);
  });

  it('simultaneous admin actions on one tenant keep the chain contiguous and valid', async () => {
    const t = await newTenant('Synthetic Race');
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => adm('POST', `/api/v1/admin/tenants/${t.id}/keys`, { label: `race-${i}` })));
    for (const r of results) { expect(r.status).toBe(201); issued.push((await r.json()).api_key); }
    const audit = await auditOf(t.id);
    expect(audit.chain.valid).toBe(true);
    expect(audit.entries.map((e: any) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('if the audit entry cannot be written, the change is rolled back (no unaudited tenant, key or plan change)', async () => {
    const t = await newTenant('Synthetic Atomic');
    const before = (await q('SELECT COUNT(*)::int AS n FROM tenant_api_keys WHERE tenant_id = $1', [t.id]))[0].n;
    await q('ALTER TABLE cds_audit_log_mt RENAME TO cds_audit_log_mt_broken');
    try {
      const r = await adm('POST', `/api/v1/admin/tenants/${t.id}/keys`, { label: 'ghost' });
      expect(r.status).toBe(500);
      expect((await r.json()).error.code).toBe('internal_error');
      const plan = await adm('PUT', `/api/v1/admin/tenants/${t.id}/plan`, { plan: 'enterprise' });
      expect(plan.status).toBe(500);
      const created = await adm('POST', '/api/v1/admin/tenants', { company_name: 'Ghost Co', email: 'ghost@synthetic.invalid' });
      expect(created.status).toBe(500);
    } finally { await q('ALTER TABLE cds_audit_log_mt_broken RENAME TO cds_audit_log_mt'); }
    expect((await q('SELECT COUNT(*)::int AS n FROM tenant_api_keys WHERE tenant_id = $1', [t.id]))[0].n).toBe(before);
    expect((await q('SELECT plan FROM tenants WHERE tenant_id = $1', [t.id]))[0].plan).toBe('free');
    expect(await q(`SELECT 1 FROM tenants WHERE email = 'ghost@synthetic.invalid'`)).toHaveLength(0);
  });

  it('no plaintext key ever reaches storage or the audit chain (checked against every key this file issued)', async () => {
    const stored = JSON.stringify(await q('SELECT * FROM tenant_api_keys')) + JSON.stringify(await q('SELECT * FROM cds_audit_log_mt')) + JSON.stringify(await q('SELECT * FROM tenants'));
    expect(issued.length).toBeGreaterThan(10);
    for (const k of issued) expect(stored).not.toContain(k);
  });

  it('the audit helper refuses a payload that contains key material', async () => {
    const { recordTenantEvent } = await import('./audit');
    const { db } = await import('../../db');
    const t = await newTenant('Synthetic Scrub');
    await expect(db.transaction((tx) => recordTenantEvent(tx, t.id, { actor: 'admin_api', declaredActor: null, requestId: null }, 'tenant.test', { oops: 'amgi_live_' + 'a'.repeat(48) })))
      .rejects.toThrow(/key material/);
  });
});
