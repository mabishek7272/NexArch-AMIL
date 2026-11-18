/** Clinician provisioning against REAL PostgreSQL (disposable; opt-in). Synthetic users only. */
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('licensed-clinician provisioning (real PostgreSQL)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let server: Server; let base: string;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let auth: typeof import('./auth');
  const ids: Record<string, string> = {}; const cookie: Record<string, string> = {};

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName, DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex') });
    vi.resetModules();
    await (await import('../../db/connection')).ensureDbReady();
    q = (await import('../../db')).db.query as any;
    auth = await import('./auth');
    for (const [k, role] of [['admin', 'admin'], ['admin2', 'admin'], ['op', 'operator'], ['doc', 'viewer']]) {
      ids[k] = crypto.randomUUID();
      await q(`INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1,$2,$3,'x',0)`, [ids[k], `${k}@clinic-synthetic.org`, role]);
      cookie[k] = `dash_token=${(await auth.issueTokens(ids[k])).accessToken}`;
    }
    const express = (await import('express')).default; const cookieParser = (await import('cookie-parser')).default;
    const app = express(); app.use(cookieParser()); app.use(express.json());
    app.use('/api/users', (await import('./routes/users')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/users`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { (await import('../../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const call = (who: string, method: string, p: string, body?: unknown) => fetch(base + p, { method, headers: { cookie: cookie[who], 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const LIC = { license_number: 'SYN-123', jurisdiction: 'Synthetic', licensing_body: 'Synthetic Board', verification_note: 'checked register (synthetic)' };

  it('generic create/update cannot assign clinician', async () => {
    expect((await call('admin', 'POST', '', { email: 'x@clinic-synthetic.org', password: 'Long-Enough-Pass-1!', role: 'clinician' })).status).toBe(400);
    expect((await call('admin', 'PUT', `/${ids.doc}`, { role: 'clinician' })).status).toBe(400);
  });

  it('separation of duties: no self-provisioning; admin/operator accounts cannot be clinicians', async () => {
    expect((await call('admin', 'POST', `/${ids.admin}/clinician-provisioning`, LIC)).status).toBe(403);
    expect((await call('admin', 'POST', `/${ids.admin2}/clinician-provisioning`, LIC)).status).toBe(409);
    expect((await call('admin', 'POST', `/${ids.op}/clinician-provisioning`, LIC)).status).toBe(409);
    expect((await call('op', 'POST', `/${ids.doc}/clinician-provisioning`, LIC)).status).toBe(403); // non-admin
    expect((await call('admin', 'POST', `/${ids.doc}/clinician-provisioning`, { ...LIC, license_number: '' })).status).toBe(400);
  });

  it('provisioning is recorded and audited; revocation demotes and revokes sessions', async () => {
    expect((await call('admin', 'POST', `/${ids.doc}/clinician-provisioning`, LIC)).status).toBe(200);
    const { hasActiveClinicianCredential } = await import('./clinicians');
    expect(await hasActiveClinicianCredential(ids.doc)).toBe(true);
    expect((await q(`SELECT action FROM audit_events WHERE target_id = $1`, [ids.doc])).map((r) => r.action)).toContain('clinician.provision');
    expect((await call('admin', 'PUT', `/${ids.doc}`, { role: 'operator' })).status).toBe(400); // must revoke first
    expect((await call('admin', 'POST', `/${ids.doc}/clinician-revocation`)).status).toBe(200);
    expect(await hasActiveClinicianCredential(ids.doc)).toBe(false);
    expect((await q('SELECT role FROM dash_users WHERE id=$1', [ids.doc]))[0].role).toBe('viewer');
    expect((await q('SELECT COUNT(*)::int AS n FROM dash_sessions WHERE user_id=$1 AND COALESCE(revoked,0)=0', [ids.doc]))[0].n).toBe(0);
  });
});
