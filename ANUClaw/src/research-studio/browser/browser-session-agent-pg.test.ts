/** The M3 browser-session agent running through the REAL orchestrator against real PostgreSQL and a real headless
 * Chromium (offline simulated provider). Covers: full lifecycle completion, quota/expiry → awaiting_user (never a
 * silent paid-model fallback), budget exhaustion, lock exclusivity between two tasks, and restart recovery via M1's
 * existing stale-claim sweep. Opt-in: ANUCLAW_TEST_PG_URL. */
import * as crypto from 'crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('Research Studio M3 browser-session agent (real PostgreSQL, real headless Chromium)', () => {
  const dbName = `anuclaw_rsbs_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client;
  let store: typeof import('../task-store'); let orchestrator: typeof import('../orchestrator'); let registry: typeof import('../agent-registry');
  let profiles: typeof import('./profile-service'); let registerAll: typeof import('../register-all-agents').registerAllResearchStudioAgents;
  const userId = crypto.randomUUID();

  beforeAll(async () => {
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName }); delete process.env.NODE_ENV;
    vi.resetModules(); await (await import('../../db/connection')).ensureDbReady();
    store = await import('../task-store'); orchestrator = await import('../orchestrator'); registry = await import('../agent-registry'); profiles = await import('./profile-service');
    registerAll = (await import('../register-all-agents')).registerAllResearchStudioAgents;
    registry.clearRegistry(); registerAll();
  }, 90_000);
  afterAll(async () => {
    try { (await import('../../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  async function newProject(): Promise<string> {
    const { db } = await import('../../db'); const id = crypto.randomUUID();
    await db.query('INSERT INTO research_studio_projects (id, owner_id, mode, title, status, brief_json, brief_sha256, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)',
      [id, userId, 'research_protocol', 'M3 agent test', 'draft', '{}', 'x', Date.now()]);
    return id;
  }
  async function activeProfile(label: string) {
    const p = await profiles.createProfile(userId, 'simulated', label);
    await profiles.beginConnect(p.id, userId); return profiles.confirmConnected(p.id, userId);
  }

  it('completes a full prompt→reply cycle through the real orchestrator, holding and releasing the session lock', async () => {
    const projectId = await newProject(); const profile = await activeProfile('agent test 1');
    const task = await store.createTask(projectId, { type: 'browser.simulated_demo_session', params: { profileId: profile.id, prompt: 'hello from the orchestrator' }, budget: { maxActions: 30 } });
    const r = await orchestrator.tick(projectId);
    expect(r.outcome).toBe('completed');
    const committed = await store.getTask(task.id); expect(JSON.parse(committed!.result_json!).text).toMatch(/complete simulated reply/);
    const after = await profiles.getProfile(profile.id, userId); expect(after.locked_by_task_id).toBeNull(); // released, not left locked
  }, 20_000);

  it('a quota-exceeded condition becomes awaiting_user — never a silent fallback to a paid model API', async () => {
    const projectId = await newProject(); const profile = await activeProfile('agent test quota');
    // Pre-trigger quota via a throwaway adapter session on the same profile directory before the task opens its own.
    const { SimulatedProviderAdapter } = await import('./simulated-provider-adapter');
    const pre = new SimulatedProviderAdapter(); const handle = { profileId: profile.id, userDataDir: profile.user_data_dir };
    await pre.open(handle); await pre._testControl(handle, 'quota'); await pre.close(handle);
    await store.createTask(projectId, { type: 'browser.simulated_demo_session', params: { profileId: profile.id, prompt: 'x' }, budget: { maxActions: 10 } });
    const r = await orchestrator.tick(projectId);
    expect(r.outcome).toBe('awaiting_user');
    const after = await profiles.getProfile(profile.id, userId); expect(after.locked_by_task_id).toBeNull(); // lock released even on this path
  }, 20_000);

  it('a task whose budget is too small to reach completion fails closed, not silently incomplete-but-"done"', async () => {
    const projectId = await newProject(); const profile = await activeProfile('agent test budget');
    await store.createTask(projectId, { type: 'browser.simulated_demo_session', params: { profileId: profile.id, prompt: 'x' }, budget: { maxActions: 0 } });
    const r = await orchestrator.tick(projectId);
    expect(r.outcome).toBe('failed');
  }, 20_000);

  it('two tasks cannot drive the same profile concurrently — the second is told the session is locked', async () => {
    const projectId = await newProject(); const profile = await activeProfile('agent test lock');
    await profiles.acquireSessionLock(profile.id, 'some-other-task-already-running');
    await store.createTask(projectId, { type: 'browser.simulated_demo_session', params: { profileId: profile.id, prompt: 'x' }, budget: { maxActions: 10 } });
    const r = await orchestrator.tick(projectId);
    expect(r.outcome).toBe('retryable_failure');
    await profiles.releaseSessionLock(profile.id, 'some-other-task-already-running');
  }, 20_000);

  it('restart recovery: a task whose claim goes stale (process crash) is recovered by M1\'s existing sweepStale, unchanged for browser-driving tasks', async () => {
    const projectId = await newProject(); const profile = await activeProfile('agent test restart');
    const task = await store.createTask(projectId, { type: 'browser.simulated_demo_session', maxAttempts: 2, params: { profileId: profile.id, prompt: 'x' }, budget: { maxActions: 10 } });
    const claim = await store.claimNextReady(projectId, ['browser.simulated_demo_session']);
    expect(claim?.task.id).toBe(task.id);
    // Simulate a crash: the claim is never committed; its claimed_at is pushed into the stale window.
    const { db } = await import('../../db');
    await db.query('UPDATE research_studio_tasks SET claimed_at = $2 WHERE id = $1', [task.id, Date.now() - store.STALE_CLAIM_MS - 1000]);
    const recovered = await store.sweepStale(projectId);
    expect(recovered).toBe(1);
    const afterSweep = await store.getTask(task.id); expect(afterSweep?.status).toBe('retryable_failure');
  }, 20_000);
});
