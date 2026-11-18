/** Tenant API key hashing + compatible migration against REAL PostgreSQL (disposable; opt-in). */
import * as crypto from 'crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('tenant API keys hashed at rest (real PostgreSQL)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let store: typeof import('./tenant-store');

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName });
    vi.resetModules();
    await (await import('../db/connection')).ensureDbReady();
    q = (await import('../db')).db.query as any;
    store = await import('./tenant-store');
  }, 60_000);

  afterAll(async () => {
    try { (await import('../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const allColumnsText = async (tenantId: string) => JSON.stringify((await q('SELECT * FROM tenants WHERE tenant_id = $1', [tenantId]))[0]);

  it('legacy plaintext keys are hashed by the migration and keep working', async () => {
    const legacyKey = 'amgi_live_' + crypto.randomBytes(24).toString('hex');
    const tid = crypto.randomUUID();
    await q(`INSERT INTO tenants (tenant_id, company_name, email, api_key, plan, rate_limit_per_min, monthly_quota, created_at) VALUES ($1,'Synthetic Co',$2,$3,'free',0,NULL,'x')`,
      [tid, `${tid}@synthetic.invalid`, legacyKey]);
    const { migrate, getDb } = await import('../db/connection');
    await migrate(getDb());
    expect(await allColumnsText(tid)).not.toContain(legacyKey);
    expect((await q('SELECT api_key, api_key_prefix FROM tenants WHERE tenant_id=$1', [tid]))[0]).toEqual({ api_key: `hashed:${tid}`, api_key_prefix: legacyKey.slice(0, 14) });
    expect((await store.getTenantByApiKey(legacyKey))?.tenant_id).toBe(tid);
    await migrate(getDb()); // idempotent
    expect((await store.getTenantByApiKey(legacyKey))?.tenant_id).toBe(tid);
  });

  it('new registrations store only hash + prefix; key returned once; lookups never expose material', async () => {
    const t = await store.registerTenant('Synthetic New Co', 'new@synthetic.invalid');
    expect(t.api_key).toMatch(/^amgi_live_[0-9a-f]{48}$/);
    expect(await allColumnsText(t.tenant_id)).not.toContain(t.api_key);
    const found = await store.getTenantByApiKey(t.api_key);
    expect(found?.tenant_id).toBe(t.tenant_id);
    expect(found?.api_key).toBe('');
    expect(JSON.stringify(found)).not.toMatch(/api_key_hash|hashed:/);
    expect((await store.getTenantById(t.tenant_id))?.api_key).toBe('');
  });

  it('placeholders, wrong keys and junk are rejected', async () => {
    const t = (await q(`SELECT tenant_id FROM tenants LIMIT 1`))[0];
    expect(await store.getTenantByApiKey(`hashed:${t.tenant_id}`)).toBeNull();
    expect(await store.getTenantByApiKey('amgi_live_' + '0'.repeat(48))).toBeNull();
    expect(await store.getTenantByApiKey('short')).toBeNull();
  });
});
