/** Research Studio M3 browser-profile API (real PostgreSQL, real HTTP): full connect lifecycle, owner-only
 * isolation, and that no response body ever contains anything credential-shaped. Opt-in: ANUCLAW_TEST_PG_URL. */
import * as crypto from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('Research Studio M3 browser-profile routes (real PostgreSQL)', () => {
  const dbName = `anuclaw_rsm3_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let server: Server; let base: string;
  const ids: Record<string, string> = {}; const cookie: Record<string, string> = {};

  beforeAll(async () => {
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName, DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex') });
    delete process.env.NODE_ENV;
    vi.resetModules();
    await (await import('../../../db/connection')).ensureDbReady();
    const { db } = await import('../../../db'); const auth = await import('../auth');
    for (const [k, role] of [['opA', 'operator'], ['opB', 'operator']] as const) {
      const id = crypto.randomUUID(); ids[k] = id;
      await db.query(`INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1,$2,$3,'x',0)`, [id, `${k}@research-studio-m3-synthetic.invalid`, role]);
      cookie[k] = `dash_token=${(await auth.issueTokens(id)).accessToken}`;
    }
    (await import('../../../research-studio/register-all-agents')).registerAllResearchStudioAgents();
    const express = (await import('express')).default; const cookieParser = (await import('cookie-parser')).default; const app = express();
    app.use(cookieParser()); app.use(express.json({ limit: '1mb' }));
    app.use('/api/research-studio', (await import('./research-studio')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/research-studio`;
  }, 90_000);
  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { (await import('../../../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const call = async (who: string, method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { cookie: cookie[who], ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ } return { status: r.status, json, text };
  };

  it('the full connect lifecycle round-trips through the API, and no response ever carries anything credential-shaped', async () => {
    const created = await call('opA', 'POST', '/browser-profiles', { provider: 'simulated', label: 'Route test profile' });
    expect(created.status).toBe(201); expect(created.text).not.toMatch(/password|cookie|token|secret/i);
    const id = created.json.profile.id;
    expect((await call('opA', 'GET', '/browser-profiles')).json.profiles.some((p: any) => p.id === id)).toBe(true);
    const connecting = await call('opA', 'POST', `/browser-profiles/${id}/connect`); expect(connecting.json.profile.status).toBe('connecting');
    const active = await call('opA', 'POST', `/browser-profiles/${id}/confirm`); expect(active.json.profile.status).toBe('active');
    const disconnected = await call('opA', 'POST', `/browser-profiles/${id}/disconnect`); expect(disconnected.json.profile.status).toBe('disconnected');
  });

  it('revoke is permanent and reported as such via the API', async () => {
    const created = await call('opA', 'POST', '/browser-profiles', { provider: 'simulated', label: 'Revoke route test' });
    const id = created.json.profile.id;
    const revoked = await call('opA', 'POST', `/browser-profiles/${id}/revoke`); expect(revoked.json.profile.status).toBe('revoked');
    const retry = await call('opA', 'POST', `/browser-profiles/${id}/connect`);
    expect(retry.status).toBe(409);
  });

  it('browser profiles are owner-only (404, never 403)', async () => {
    const created = await call('opA', 'POST', '/browser-profiles', { provider: 'simulated', label: 'Isolation route test' });
    const id = created.json.profile.id;
    expect((await call('opB', 'GET', `/browser-profiles/${id}`)).status).toBe(404);
    expect((await call('opB', 'POST', `/browser-profiles/${id}/connect`)).status).toBe(404);
    const list = await call('opB', 'GET', '/browser-profiles');
    expect(list.json.profiles.some((p: any) => p.id === id)).toBe(false);
  });
});
