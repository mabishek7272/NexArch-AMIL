/** Shared-store limits against REAL PostgreSQL (disposable; opt-in): correctness under concurrency. */
import * as crypto from 'crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('shared-store limits (real PostgreSQL)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client;
  let L: typeof import('./shared-limits');
  let q: (s: string, p?: unknown[]) => Promise<any[]>;

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName });
    vi.resetModules();
    await (await import('../db/connection')).ensureDbReady();
    q = (await import('../db')).db.query as any;
    L = await import('./shared-limits');
  }, 60_000);

  afterAll(async () => {
    try { (await import('../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  it('rate window: 40 concurrent hits with limit 10 → exactly 10 allowed', async () => {
    const now = Date.now();
    const r = await Promise.all(Array.from({ length: 40 }, () => L.pgRateHit('t:rate', 10, 60_000, now)));
    expect(r.filter((x) => x.allowed)).toHaveLength(10);
  });

  it('leases: 12 concurrent acquisitions with max 3 → exactly 3; release frees; expired leases are reclaimed', async () => {
    const got = await Promise.all(Array.from({ length: 12 }, () => L.pgAcquireLease('t:lease', 3, 60_000)));
    const ids = got.filter(Boolean) as string[];
    expect(ids).toHaveLength(3);
    await L.pgReleaseLease(ids[0]);
    expect(await L.pgAcquireLease('t:lease', 3, 60_000)).not.toBeNull();
    expect(await L.pgAcquireLease('t:short', 1, 1)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(await L.pgAcquireLease('t:short', 1, 60_000)).not.toBeNull(); // expired lease reclaimed
  });

  it('quota: 30 concurrent reservations against quota 7 → exactly 7, never overshoot; month rollover resets', async () => {
    const tid = crypto.randomUUID();
    await q(`INSERT INTO tenants (tenant_id, company_name, email, api_key, plan, rate_limit_per_min, created_at) VALUES ($1,'S',$2,$3,'free',0,'x')`, [tid, `${tid}@s.invalid`, `hashed:${tid}`]);
    const r = await Promise.all(Array.from({ length: 30 }, () => L.pgReserveQuota(tid, 7, '2026-11')));
    expect(r.filter((x) => x !== null)).toHaveLength(7);
    expect((await q('SELECT usage_this_month FROM tenants WHERE tenant_id=$1', [tid]))[0].usage_this_month).toBe(7);
    expect(await L.pgReserveQuota(tid, 7, '2026-12')).toBe(1); // new month
    expect(await L.pgReserveQuota(tid, null, '2026-12')).toBe(2); // unlimited plan
  });
});
