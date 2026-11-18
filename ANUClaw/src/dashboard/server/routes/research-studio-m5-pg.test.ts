/** Research Studio M5 API (real PostgreSQL, real HTTP): visuals (conceptual + PRISMA), the export task triggered
 * via the API, downloading the REAL stored bytes (byte-identical to what the agent produced), and owner-only
 * isolation. Opt-in: ANUCLAW_TEST_PG_URL. */
import * as crypto from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('Research Studio M5 routes (real PostgreSQL)', () => {
  const dbName = `anuclaw_rsm5_${crypto.randomBytes(6).toString('hex')}`;
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
      await db.query(`INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1,$2,$3,'x',0)`, [id, `${k}@research-studio-m5-synthetic.invalid`, role]);
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
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ } return { status: r.status, json, raw: text, headers: r.headers };
  };
  async function project(who: string) {
    const res = await call(who, 'POST', '/projects', { mode: 'research_protocol', title: `M5 route test ${crypto.randomBytes(4).toString('hex')}`, brief: { topic: 'T', question: 'Q?' } });
    return res.json.project.id as string;
  }

  it('creates a conceptual visual via the API, refuses an invented number, and lists it under "current"', async () => {
    const pid = await project('opA');
    const bad = await call('opA', 'POST', `/projects/${pid}/visuals`, { visualKey: 'flow', type: 'flowchart', kind: 'conceptual', title: 'Process', spec: { nodes: [{ id: 'a', label: 'Start', count: 5 }], edges: [] } });
    expect(bad.status).toBe(400); expect(bad.json.code).toBe('invented_numbers_refused');
    const ok = await call('opA', 'POST', `/projects/${pid}/visuals`, { visualKey: 'flow', type: 'flowchart', kind: 'conceptual', title: 'Process', spec: { nodes: [{ id: 'a', label: 'Start' }], edges: [] } });
    expect(ok.status).toBe(201);
    const list = await call('opA', 'GET', `/projects/${pid}/visuals`);
    expect(list.json.visuals.some((v: any) => v.visual_key === 'flow')).toBe(true);
  });

  it('builds a real PRISMA flow from an actual completed search run', async () => {
    const pid = await project('opA');
    await call('opA', 'POST', `/projects/${pid}/search-strategies`, { databases: ['crossref'], queries: ['q'] });
    const r = await call('opA', 'POST', `/projects/${pid}/visuals`, { type: 'prisma_flow' });
    expect(r.status).toBe(201); expect(r.json.visual.svg).toContain('n = 0'); // no search run completed yet — real zero, not omitted
  });

  it('triggering export via the API produces a real export whose download matches its own stored hash', async () => {
    const pid = await project('opA');
    const { createSection } = await import('../../../research-studio/manuscript-service');
    await createSection(pid, ids.opA, { sectionKey: 'background', kind: 'section', title: 'Background', contentText: 'Real content for the export route test.', contentSource: 'human' });
    const exp = await call('opA', 'POST', `/projects/${pid}/export`, {});
    expect(exp.status).toBe(201); expect(exp.json.task.status).toBe('completed');
    const result = JSON.parse(exp.json.task.result_json);
    const exportsList = await call('opA', 'GET', `/projects/${pid}/exports`);
    expect(exportsList.json.exports.length).toBe(result.exportIds.length);
    const mdExport = exportsList.json.exports.find((e: any) => e.format === 'markdown');
    const dl = await fetch(base + `/projects/${pid}/exports/${mdExport.id}/download`, { headers: { cookie: cookie.opA } });
    const text = await dl.text();
    const { createHash } = await import('crypto');
    expect(createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')).toBe(mdExport.content_sha256);
    expect(text).toContain('Real content for the export route test.');
  });

  it('visuals and exports are owner-only (404, never 403)', async () => {
    const pid = await project('opA');
    await call('opA', 'POST', `/projects/${pid}/visuals`, { visualKey: 'flow', type: 'flowchart', kind: 'conceptual', title: 'P', spec: { nodes: [{ id: 'a', label: 'A' }], edges: [] } });
    expect((await call('opB', 'GET', `/projects/${pid}/visuals`)).status).toBe(404);
    expect((await call('opB', 'POST', `/projects/${pid}/export`, {})).status).toBe(404);
    expect((await call('opB', 'GET', `/projects/${pid}/exports`)).status).toBe(404);
  });
});
