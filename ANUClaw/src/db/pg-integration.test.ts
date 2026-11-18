/**
 * REAL PostgreSQL concurrency checks. Opt-in: runs only when
 * ANUCLAW_TEST_PG_URL points at a DISPOSABLE server (never a live database).
 * Each run creates a fresh randomly-named database and drops it afterwards.
 *
 *   ANUCLAW_TEST_PG_URL=postgres://user:pass@127.0.0.1:55432/postgres npx vitest run src/db/pg-integration.test.ts
 */
import * as crypto from 'crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;

vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('PostgreSQL concurrency (disposable database)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client;
  let target: { host: string; port: number; user: string; password: string; database: string };
  const pools: Pool[] = [];
  const newPool = () => { const p = new Pool({ ...target, max: 4 }); pools.push(p); return p; };

  let migrate: (p: Pool) => Promise<void>;
  let auth: typeof import('../dashboard/server/auth');
  let passwords: typeof import('../security/password');

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    target = { host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: dbName };

    // Point the app's pool at the disposable database, then load modules fresh.
    Object.assign(process.env, {
      PG_HOST: target.host, PG_PORT: String(target.port), PG_USER: target.user,
      PG_PASSWORD: target.password, PG_DATABASE: dbName,
      DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    });
    delete process.env.ANUCLAW_BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD;
    vi.resetModules();
    ({ migrate } = await import('./connection'));
    auth = await import('../dashboard/server/auth');
    passwords = await import('../security/password');
    await (await import('./connection')).ensureDbReady();
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled(pools.map((p) => p.end()));
    try { (await import('./connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    }
  });

  async function resetUsers(p: Pool) {
    await p.query('DELETE FROM dash_sessions');
    await p.query('DELETE FROM dash_users');
  }

  it('CONTROL: INSERT … WHERE NOT EXISTS alone lets two concurrent transactions both insert', async () => {
    const p = newPool();
    await resetUsers(p);
    const race = async (email: string) => {
      const c = await p.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT COUNT(*) FROM dash_users');
        const r = await c.query(
          `INSERT INTO dash_users (id, email, role, password_hash, created_at)
           SELECT $1, $2, 'admin', 'x', 0 WHERE NOT EXISTS (SELECT 1 FROM dash_users)`,
          [crypto.randomUUID(), email],
        );
        await c.query('SELECT pg_sleep(0.3)'); // hold the txn open so both INSERTs run before either commits
        await c.query('COMMIT');
        return r.rowCount;
      } finally { c.release(); }
    };
    const counts = await Promise.all([race('a@race.invalid'), race('b@race.invalid')]);
    const { rows } = await p.query('SELECT COUNT(*)::int AS n FROM dash_users');
    expect(counts).toEqual([1, 1]);
    expect(rows[0].n).toBe(2); // demonstrates the original gap
  });

  it('concurrent migrations with bootstrap config create exactly one administrator', async () => {
    const p0 = newPool();
    await resetUsers(p0);
    process.env.ANUCLAW_BOOTSTRAP_ADMIN_EMAIL = 'ops.lead@clinic-synthetic.org';
    process.env.ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD = 'Vq7#tR2!mZp9xLw';
    try {
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => migrate(newPool())));
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    } finally {
      delete process.env.ANUCLAW_BOOTSTRAP_ADMIN_EMAIL;
      delete process.env.ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD;
    }
    const { rows } = await p0.query('SELECT role, password_hash FROM dash_users');
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('admin');
    expect(rows[0].password_hash).toMatch(/^scrypt\$1\$/);
  }, 60_000);

  it('concurrent bootstrapFirstAdmin calls OUTSIDE the migration still create exactly one admin (advisory lock)', async () => {
    const p0 = newPool();
    await resetUsers(p0);
    const { bootstrapFirstAdmin } = await import('./admin-bootstrap');
    const env = { ANUCLAW_BOOTSTRAP_ADMIN_EMAIL: 'ops.lead@clinic-synthetic.org', ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD: 'Vq7#tR2!mZp9xLw' };
    const quiet = { info: () => {}, warn: () => {} };
    const run = async () => {
      const c = await newPool().connect();
      try {
        await c.query('BEGIN');
        const out = await bootstrapFirstAdmin(c, quiet, env);
        await c.query('SELECT pg_sleep(0.2)'); // keep the txn open past the other INSERTs
        await c.query('COMMIT');
        return out;
      } finally { c.release(); }
    };
    const outcomes = await Promise.all(Array.from({ length: 6 }, run));
    expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
    const { rows } = await p0.query('SELECT COUNT(*)::int AS n FROM dash_users');
    expect(rows[0].n).toBe(1);
  }, 60_000);

  async function seedUser(p: Pool, hash: string) {
    const id = crypto.randomUUID();
    await p.query(
      `INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1, $2, 'viewer', $3, 0)`,
      [id, `${id}@clinic-synthetic.org`, hash],
    );
    return id;
  }

  it('a login waiting on an in-flight password change sees the new hash and issues no session', async () => {
    const p = newPool();
    const h1 = await passwords.hashPassword('First-Pass-123!');
    const h2 = await passwords.hashPassword('Second-Pass-456!');
    const id = await seedUser(p, h1);

    const changer = await p.connect();
    await changer.query('BEGIN');
    await changer.query('UPDATE dash_users SET password_hash = $1 WHERE id = $2', [h2, id]); // holds row lock

    const login = auth.issueTokens(id, { expectedPasswordHash: h1 }).then(() => 'issued', (e) => e.kind ?? e.message);
    await new Promise((r) => setTimeout(r, 300));
    await changer.query('UPDATE dash_sessions SET revoked = 1 WHERE user_id = $1', [id]);
    await changer.query('COMMIT');
    changer.release();

    expect(await login).toBe('password_changed');
    const { rows } = await p.query('SELECT COUNT(*)::int AS n FROM dash_sessions WHERE user_id = $1', [id]);
    expect(rows[0].n).toBe(0);
  });

  it('a password change waiting on an in-flight session issue revokes that session', async () => {
    const p = newPool();
    const h1 = await passwords.hashPassword('First-Pass-123!');
    const id = await seedUser(p, h1);

    const issuer = await p.connect();
    await issuer.query('BEGIN');
    await issuer.query('SELECT password_hash FROM dash_users WHERE id = $1 FOR SHARE', [id]);
    const jti = crypto.randomUUID();
    await issuer.query(`INSERT INTO dash_sessions (jti, user_id, expires_at) VALUES ($1, $2, $3)`, [jti, id, Date.now() + 60_000]);

    const change = auth.setPasswordAndRevokeSessions(id, await passwords.hashPassword('Second-Pass-456!'));
    await new Promise((r) => setTimeout(r, 300));
    await issuer.query('COMMIT');
    issuer.release();
    expect(await change).toBe(true);

    const { rows } = await p.query('SELECT revoked FROM dash_sessions WHERE jti = $1', [jti]);
    expect(rows[0].revoked).toBe(1);
  });

  it('concurrent refreshes of one session: exactly one rotation wins', async () => {
    const p = newPool();
    const id = await seedUser(p, await passwords.hashPassword('First-Pass-123!'));
    const jti = crypto.randomUUID();
    await p.query(`INSERT INTO dash_sessions (jti, user_id, expires_at) VALUES ($1, $2, $3)`, [jti, id, Date.now() + 60_000]);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => auth.issueTokens(id, { rotateFromJti: jti })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const { rows } = await p.query('SELECT COUNT(*)::int AS n FROM dash_sessions WHERE user_id = $1 AND COALESCE(revoked,0) = 0', [id]);
    expect(rows[0].n).toBe(1);
  });

  it('legacy upgrade CAS loses to a concurrent password change', async () => {
    const p = newPool();
    const legacy = passwords.legacyHashForTests('First-Pass-123!');
    const id = await seedUser(p, legacy);
    const newer = await passwords.hashPassword('Second-Pass-456!');
    expect(await auth.setPasswordAndRevokeSessions(id, newer)).toBe(true);
    const upgraded = await auth.upgradePasswordHash(id, legacy, await passwords.hashPassword('First-Pass-123!'));
    expect(upgraded).toBeNull();
    const { rows } = await p.query('SELECT password_hash FROM dash_users WHERE id = $1', [id]);
    expect(rows[0].password_hash).toBe(newer);
  });
});
