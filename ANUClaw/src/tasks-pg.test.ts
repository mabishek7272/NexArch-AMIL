/**
 * Scheduled task execution against REAL PostgreSQL (disposable; opt-in via
 * ANUCLAW_TEST_PG_URL). runAgent and channels are mocked.
 */
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const agent = vi.hoisted(() => ({ result: { text: 'task output', artifacts: [], executionMode: 'host_text_only', warnings: [] } as any, delayMs: 0, calls: 0 }));
vi.mock('./container-runner', () => ({
  runAgent: vi.fn(async () => { agent.calls++; await new Promise((r) => setTimeout(r, agent.delayMs)); return agent.result; }),
}));
vi.mock('./channels/registry', () => ({ findChannel: () => undefined }));

describe.skipIf(!URL_)('scheduled tasks (real PostgreSQL)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client;
  let sched: typeof import('./task-scheduler');
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let server: Server;
  let base: string;
  let cookieHdr: string;

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, {
      PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username),
      PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName,
      DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    });
    vi.resetModules();
    await (await import('./db/connection')).ensureDbReady();
    const { db } = await import('./db');
    q = (s, p) => db.query(s, p as any[]);
    sched = await import('./task-scheduler');
    const auth = await import('./dashboard/server/auth');
    const uid = crypto.randomUUID();
    await q(`INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1, 'op@clinic-synthetic.org', 'operator', 'x', 0)`, [uid]);
    cookieHdr = `dash_token=${(await auth.issueTokens(uid)).accessToken}`;
    const express = (await import('express')).default;
    const cookieParser = (await import('cookie-parser')).default;
    const app = express();
    app.use(cookieParser()); app.use(express.json());
    app.use('/api/tasks', (await import('./dashboard/server/routes/tasks')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tasks`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { (await import('./db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    }
  });

  const call = (method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { cookie: cookieHdr, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

  let taskId: string;

  it('dashboard-created tasks are read by the scheduler table (single source)', async () => {
    expect((await call('POST', '', { name: 'n', cron: 'not a cron', skill: 'x', prompt: 'p' })).status).toBe(400);
    const r = await call('POST', '', { name: 'Daily summary', cron: '0 6 * * *', skill: 'anuclaw-clinical', prompt: 'summarise' });
    expect(r.status).toBe(201);
    taskId = (await r.json()).id;
    const rows = await q('SELECT id FROM scheduled_tasks WHERE enabled = 1');
    expect(rows.map((x) => x.id)).toContain(taskId);
  });

  it('manual trigger really executes and records success', async () => {
    agent.calls = 0;
    agent.result = { text: 'task output', artifacts: [], executionMode: 'host_text_only', warnings: [] };
    const r = await call('POST', `/${taskId}/trigger?wait=true`);
    expect(r.status).toBe(200);
    expect(agent.calls).toBe(1);
    const runs = await (await call('GET', `/${taskId}/runs`)).json();
    expect(runs.runs[0]).toMatchObject({ status: 'succeeded', trigger: 'manual', execution_mode: 'host_text_only', output: 'task output' });
  });

  it('a failed agent run is recorded as failed (not success)', async () => {
    agent.result = { text: '', artifacts: [], error: 'provider_request_failed', executionMode: 'host_text_only', warnings: [] };
    const r = await call('POST', `/${taskId}/trigger?wait=true`);
    expect(r.status).toBe(502);
    const run = (await q('SELECT status, error, output FROM task_runs WHERE task_id = $1 ORDER BY id DESC LIMIT 1', [taskId]))[0];
    expect(run).toEqual({ status: 'failed', error: 'provider_request_failed', output: null });
    expect((await q('SELECT last_status FROM scheduled_tasks WHERE id = $1', [taskId]))[0].last_status).toBe('failed');
  });

  it('overlapping runs are skipped and recorded, claim released afterwards', async () => {
    agent.result = { text: 'ok', artifacts: [], executionMode: 'host_text_only', warnings: [] };
    agent.delayMs = 300;
    const [a, b] = await Promise.all([sched.executeTask(taskId, 'cron'), sched.executeTask(taskId, 'cron')]);
    agent.delayMs = 0;
    expect([a.status, b.status].sort()).toEqual(['skipped_overlap', 'succeeded']);
    expect((await q('SELECT running_since FROM scheduled_tasks WHERE id = $1', [taskId]))[0].running_since).toBeNull();
  });

  it('unknown task id → not_found; editing cron bumps updated_at (forces reschedule)', async () => {
    expect((await sched.executeTask('nope', 'manual')).status).toBe('not_found');
    const before = (await q('SELECT updated_at FROM scheduled_tasks WHERE id = $1', [taskId]))[0].updated_at;
    await new Promise((r) => setTimeout(r, 5));
    expect((await call('PUT', `/${taskId}`, { cron: '30 7 * * *' })).status).toBe(200);
    const after = (await q('SELECT cron, updated_at FROM scheduled_tasks WHERE id = $1', [taskId]))[0];
    expect(after.cron).toBe('30 7 * * *');
    expect(Number(after.updated_at)).toBeGreaterThan(Number(before));
    expect((await call('PUT', `/${taskId}`, { cron: 'bad cron' })).status).toBe(400);
  });

  it('legacy `tasks` rows are copied (not moved) into scheduled_tasks by the migration', async () => {
    await q(`INSERT INTO groups (id, channel, created_at) VALUES ('g-legacy', 'telegram', 'x') ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO tasks (id, group_id, channel, name, cron, prompt, enabled, created_at) VALUES ('legacy-1', 'g-legacy', 'telegram', 'old', '0 9 * * *', 'p', 1, 'x')`);
    const { migrate, getDb } = await import('./db/connection');
    await migrate(getDb());
    expect((await q(`SELECT group_id, channel FROM scheduled_tasks WHERE id = 'legacy-1'`))[0]).toEqual({ group_id: 'g-legacy', channel: 'telegram' });
    expect((await q(`SELECT COUNT(*)::int AS n FROM tasks WHERE id = 'legacy-1'`))[0].n).toBe(1);
  });
});
