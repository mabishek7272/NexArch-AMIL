/** Dashboard (/api/science) and BaaS (/v1/science) routes: authentication, roles, ownership, tenant isolation. Synthetic mock providers; real PostgreSQL. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startMockProviders } from './testkit';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('science routes (real PostgreSQL, synthetic mock providers)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let mock: Awaited<ReturnType<typeof startMockProviders>>; let server: Server; let base: string;
  const cookie: Record<string, string> = {}; const key: Record<string, string> = {};

  beforeAll(async () => {
    mock = await startMockProviders(); const o = mock.origin;
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, {
      PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName, DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
      ANUCLAW_SCIDATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'scidata-r-')), ANUCLAW_SCIDATA_MIN_INTERVAL_MS: '0', ANUCLAW_SCIDATA_DESCRIBE_TTL_MS: '0', ANUCLAW_SCIDATA_NCBI_MIN_INTERVAL_MS: '0',
      ANUCLAW_SCIDATA_BASE_OVERRIDES: JSON.stringify({ alphafold: o, rcsbData: o, rcsbFiles: o, rcsbSearch: o, ncbiDatasets: o, ncbiEutils: o, ncbiWww: o, ncbiFtp: o }),
    });
    delete process.env.ANUCLAW_RATE_STORE; vi.resetModules();
    await (await import('../db/connection')).ensureDbReady(); const q = (await import('../db')).db.query as any;
    const auth = await import('../dashboard/server/auth');
    for (const [k, role] of [['u1', 'operator'], ['u2', 'operator'], ['viewer', 'viewer']]) {
      const id = crypto.randomUUID(); await q(`INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1,$2,$3,'x',0)`, [id, `${k}@clinic-synthetic.org`, role]);
      cookie[k] = `dash_token=${(await auth.issueTokens(id)).accessToken}`;
    }
    const store = await import('../api/tenant-store');
    key.a = (await store.registerTenant('Synthetic A', 'a@synthetic.invalid', 'pro')).api_key; key.b = (await store.registerTenant('Synthetic B', 'b@synthetic.invalid', 'pro')).api_key;
    const express = (await import('express')).default; const cookieParser = (await import('cookie-parser')).default;
    const app = express(); app.use(cookieParser()); app.use(express.json());
    app.use('/api/science', (await import('../dashboard/server/routes/science')).default);
    app.use((await import('../api/routes/baas-v1')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 90_000);
  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await mock.close();
    try { (await import('../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const dash = (who: string | null, method: string, p: string, body?: unknown) => fetch(`${base}/api/science${p}`, { method, headers: { ...(who ? { cookie: cookie[who] } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const v1 = (who: string | null, method: string, p: string, body?: unknown) => fetch(`${base}/v1/science${p}`, { method, headers: { ...(who ? { 'x-api-key': key[who] } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

  it('dashboard: authentication and roles (anonymous 401, viewer 403, operator allowed)', async () => {
    expect((await dash(null, 'GET', '/')).status).toBe(401); expect((await dash('viewer', 'GET', '/')).status).toBe(403);
    const c = await (await dash('u1', 'GET', '/')).json(); expect(c.providers.map((p: any) => p.id)).toEqual(['alphafold', 'rcsb', 'ncbi_datasets', 'geo']); expect(c.notice).toMatch(/not clinical evidence/);
    expect((await dash('viewer', 'POST', '/retrieve', { provider: 'rcsb', accession: '4HHB', files: ['pdb'] })).status).toBe(403);
  });

  it('dashboard workflow: describe → retrieve → provenance → workspace → attach → manifest; and a second user sees none of it', async () => {
    const d = await (await dash('u1', 'POST', '/describe', { provider: 'alphafold', accession: 'P69905' })).json(); expect(d.classification).toBe('predicted');
    const rr = await dash('u1', 'POST', '/retrieve', { provider: 'alphafold', accession: 'P69905', files: ['pdb'] }); expect(rr.status).toBe(201);
    const sid = (await rr.json()).sources.find((s: any) => s.format === 'pdb').id;
    const ws = await (await dash('u1', 'POST', '/workspaces', { name: 'My study', purpose: 'route test' })).json();
    expect((await dash('u1', 'POST', `/workspaces/${ws.id}/items`, { sourceId: sid, label: 'model' })).status).toBe(201);
    expect((await dash('u1', 'POST', `/workspaces/${ws.id}/items`, { sourceId: sid })).status).toBe(409);
    const man = await dash('u1', 'GET', `/workspaces/${ws.id}/manifest`); expect(man.status).toBe(200); expect(man.headers.get('x-manifest-sha256')).toMatch(/^[0-9a-f]{64}$/);
    const content = await dash('u1', 'GET', `/sources/${sid}/content`); expect(content.status).toBe(200); expect(content.headers.get('x-research-only')).toBe('true'); expect(content.headers.get('content-disposition')).toMatch(/attachment/); expect(content.headers.get('x-content-sha256')).toMatch(/^[0-9a-f]{64}$/);
    for (const [m, p, b] of [['GET', `/sources/${sid}`], ['GET', `/sources/${sid}/content`], ['GET', `/workspaces/${ws.id}`], ['GET', `/workspaces/${ws.id}/manifest`], ['POST', `/workspaces/${ws.id}/items`, { sourceId: sid }]] as const) expect((await dash('u2', m, p, b)).status, `${m} ${p}`).toBe(404);
    expect((await (await dash('u2', 'GET', '/workspaces')).json()).workspaces).toEqual([]);
  });

  it('validation: bad provider/accession/files/query → 400 with explicit codes', async () => {
    expect((await dash('u1', 'POST', '/describe', { provider: 'nope', accession: 'x' })).status).toBe(400);
    const bad = await dash('u1', 'POST', '/describe', { provider: 'rcsb', accession: '../../etc' }); expect(bad.status).toBe(400); expect((await bad.json()).code).toBe('bad_accession');
    expect((await dash('u1', 'POST', '/retrieve', { provider: 'rcsb', accession: '4HHB' })).status).toBe(400);
    expect((await dash('u1', 'POST', '/search', { provider: 'geo', query: '<script>' })).status).toBe(400);
    expect((await dash('u1', 'POST', '/search', { provider: 'alphafold', query: 'hemoglobin' })).status).toBe(400);
    mock.setMode('rcsbJson', 'outage'); try { const r = await dash('u1', 'POST', '/describe', { provider: 'rcsb', accession: '4HHB' }); expect(r.status).toBe(502); expect((await r.json()).code).toBe('unavailable'); } finally { mock.setMode('rcsbJson', ''); }
  });

  it('/v1: API key required; tenants are isolated from each other AND from dashboard users', async () => {
    expect((await v1(null, 'GET', '')).status).toBe(401);
    const r = await v1('a', 'POST', '/retrieve', { provider: 'rcsb', accession: '4HHB', files: ['pdb'] }); expect(r.status).toBe(201);
    const sid = (await r.json()).sources[0].id;
    const ws = await (await v1('a', 'POST', '/workspaces', { name: 'Tenant A', purpose: 'v1 route test' })).json();
    expect((await v1('a', 'POST', `/workspaces/${ws.id}/items`, { sourceId: sid })).status).toBe(201);
    expect((await v1('a', 'GET', `/workspaces/${ws.id}/manifest`)).status).toBe(200);
    for (const [m, p, b] of [['GET', `/sources/${sid}`], ['GET', `/sources/${sid}/content`], ['GET', `/workspaces/${ws.id}`], ['GET', `/workspaces/${ws.id}/manifest`], ['POST', `/workspaces/${ws.id}/items`, { sourceId: sid }]] as const) expect((await v1('b', m, p, b)).status, `tenant B ${m} ${p}`).toBe(404);
    expect((await dash('u1', 'GET', `/sources/${sid}`)).status).toBe(404);     // a tenant's retrieval is not visible to a dashboard user
    expect((await (await v1('b', 'GET', '/workspaces')).json()).workspaces).toEqual([]);
  });

  it('nothing from these routes reaches the approved clinical evidence corpus', async () => {
    const q = (await import('../db')).db.query as any;
    expect((await q('SELECT COUNT(*)::int AS n FROM reference_documents'))[0].n).toBe(0); expect((await q('SELECT COUNT(*)::int AS n FROM reference_chunks'))[0].n).toBe(0);
  });
});
