/** Research Studio API (real PostgreSQL, real HTTP, real sessions). Owner-only isolation, auth/role checks, project creation
 * through the real Research Planner agent, graph/tick/advance, pause/resume/cancel/resolve, and event-chain verification.
 * Opt-in: ANUCLAW_TEST_PG_URL. */
import * as crypto from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('Research Studio routes (real PostgreSQL)', () => {
  const dbName = `anuclaw_rsr_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let server: Server; let base: string;
  const ids: Record<string, string> = {}; const cookie: Record<string, string> = {};

  beforeAll(async () => {
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName, DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex') });
    delete process.env.NODE_ENV;
    vi.resetModules();
    await (await import('../../../db/connection')).ensureDbReady();
    const { db } = await import('../../../db');
    const auth = await import('../auth');
    for (const [k, role] of [['opA', 'operator'], ['opB', 'operator'], ['viewer', 'viewer']] as const) {
      const id = crypto.randomUUID(); ids[k] = id;
      await db.query(`INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1,$2,$3,'x',0)`, [id, `${k}@research-studio-synthetic.invalid`, role]);
      cookie[k] = `dash_token=${(await auth.issueTokens(id)).accessToken}`;
    }
    const { registerResearchPlanner } = await import('../../../research-studio/agents/research-planner');
    registerResearchPlanner();
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

  const call = async (who: string | null, method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { ...(who ? { cookie: cookie[who] } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json };
  };

  it('requires auth and an allowed role', async () => {
    expect((await call(null, 'GET', '/projects')).status).toBe(401);
    expect((await call('viewer', 'GET', '/projects')).status).toBe(403);
    expect((await call('opA', 'GET', '/')).status).toBe(200);
  });

  it('creating a project runs the real Research Planner synchronously and returns a real, non-empty task graph', async () => {
    const res = await call('opA', 'POST', '/projects', { mode: 'research_protocol', title: 'Synthetic protocol', brief: { topic: 'T', question: 'Q?' } });
    expect(res.status).toBe(201);
    const project = res.json.project; expect(project.owner_id).toBe(ids.opA);
    const graph = res.json.graph as any[];
    expect(graph.some((t) => t.type === 'plan.scope_and_graph' && t.status === 'completed')).toBe(true);
    expect(graph.length).toBeGreaterThan(1);                                                    // the planner's childTasks were really created
    expect(graph.filter((t) => t.agentAvailable === false).length).toBeGreaterThan(0);           // honestly reports no fabricated progress for unimplemented agents
  });

  it('rejects an incomplete brief without creating anything (never invents a study to fill a gap)', async () => {
    const res = await call('opA', 'POST', '/projects', { mode: 'original_research', title: 'X', brief: { topic: 'T', question: 'Q?' } });
    expect(res.status).toBe(400); expect(res.json.code).toBe('brief_incomplete');
  });

  it('projects and tasks are owner-only (404, not 403, to avoid existence disclosure)', async () => {
    const res = await call('opA', 'POST', '/projects', { mode: 'research_protocol', title: 'Owner isolation test', brief: { topic: 'T', question: 'Q?' } });
    const projectId = res.json.project.id;
    expect((await call('opB', 'GET', `/projects/${projectId}`)).status).toBe(404);
    expect((await call('opB', 'GET', `/projects/${projectId}/graph`)).status).toBe(404);
    const taskId = res.json.graph[0].id;
    expect((await call('opB', 'POST', `/tasks/${taskId}/pause`)).status).toBe(404);
    expect((await call('opA', 'GET', `/projects/${projectId}`)).status).toBe(200);
  });

  it('tick/advance only ever claim a task whose type has a registered agent, and never fabricate completion of the rest', async () => {
    const res = await call('opA', 'POST', '/projects', { mode: 'research_protocol', title: 'Advance test', brief: { topic: 'T', question: 'Q?' } });
    const projectId = res.json.project.id;
    const advance = await call('opA', 'POST', `/projects/${projectId}/advance`, { maxSteps: 50 });
    expect(advance.status).toBe(200);
    const graph = advance.json.graph as any[];
    const unimplemented = graph.filter((t) => !t.agentAvailable);
    expect(unimplemented.length).toBeGreaterThan(0);
    expect(unimplemented.every((t) => t.status === 'queued')).toBe(true);                        // stuck honestly, not silently completed
  });

  it('brief revisions are append-only and re-validated; the event chain for the project verifies', async () => {
    const res = await call('opA', 'POST', '/projects', { mode: 'research_protocol', title: 'Revision test', brief: { topic: 'T', question: 'Q?' } });
    const projectId = res.json.project.id;
    expect((await call('opA', 'PATCH', `/projects/${projectId}/brief`, { brief: { topic: 'T2' } })).status).toBe(200);
    const revisions = (await call('opA', 'GET', `/projects/${projectId}/revisions`)).json.revisions;
    expect(revisions.length).toBe(2);
    const events = await call('opA', 'GET', `/projects/${projectId}/events`);
    expect(events.json.chain.ok).toBe(true);
    expect(events.json.events.length).toBeGreaterThan(0);
  });

  it('pause → resume round-trips a queued (unimplemented-agent) task via the API', async () => {
    const res = await call('opA', 'POST', '/projects', { mode: 'research_protocol', title: 'Pause test', brief: { topic: 'T', question: 'Q?' } });
    const queued = (res.json.graph as any[]).find((t) => t.status === 'queued' && !t.agentAvailable);
    expect(queued).toBeDefined();
    const paused = await call('opA', 'POST', `/tasks/${queued.id}/pause`); expect(paused.status).toBe(200); expect(paused.json.task.status).toBe('paused');
    const resumed = await call('opA', 'POST', `/tasks/${queued.id}/resume`); expect(resumed.status).toBe(200); expect(resumed.json.task.status).toBe('queued');
    const cancelled = await call('opA', 'POST', `/tasks/${queued.id}/cancel`, { reason: 'test cleanup' }); expect(cancelled.status).toBe(200); expect(cancelled.json.task.status).toBe('cancelled');
  });
});
