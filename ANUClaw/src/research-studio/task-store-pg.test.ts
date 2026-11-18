/** Durable task-graph engine (real PostgreSQL): claim/commit, idempotency, retry/backoff, stale recovery, pause/resume/cancel,
 * downstream invalidation, revision-loop cap, budget enforcement, and the hash-chained event log. Opt-in: ANUCLAW_TEST_PG_URL. */
import * as crypto from 'crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('Research Studio task-store (real PostgreSQL)', () => {
  const dbName = `anuclaw_rs_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client;
  let store: typeof import('./task-store');
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let projectId: string;

  beforeAll(async () => {
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName });
    delete process.env.NODE_ENV;
    vi.resetModules();
    await (await import('../db/connection')).ensureDbReady();
    const { db } = await import('../db'); q = (s, p) => db.query(s, p as any[]);
    store = await import('./task-store');
    projectId = crypto.randomUUID();
    await q('INSERT INTO research_studio_projects (id, owner_id, mode, title, status, brief_json, brief_sha256, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)',
      [projectId, crypto.randomUUID(), 'research_protocol', 'Test project', 'draft', '{}', 'x', Date.now()]);
  }, 90_000);

  afterAll(async () => {
    try { (await import('../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  it('runs an append-only, hash-chained event log that detects tampering and refuses UPDATE/DELETE/TRUNCATE', async () => {
    const t = await store.createTask(projectId, { type: 'test.leaf' });
    expect((await store.verifyEventChain(projectId)).ok).toBe(true);
    for (const sql of [`DELETE FROM research_studio_task_events WHERE id = (SELECT id FROM research_studio_task_events LIMIT 1)`, `UPDATE research_studio_task_events SET event = event`, `TRUNCATE research_studio_task_events`]) {
      await expect(q(sql)).rejects.toThrow(/immutable/);
    }
    expect(t.status).toBe('queued');
  });

  it('claims atomically, and only tasks whose dependencies are completed become eligible', async () => {
    const parent = await store.createTask(projectId, { type: 'test.parent' });
    const child = await store.createTask(projectId, { type: 'test.child', dependsOn: [parent.id] });
    expect(await store.claimNextReady(projectId, ['test.child'])).toBeNull();                 // parent not completed yet: child not eligible
    const claim1 = await store.claimNextReady(projectId, ['test.parent']);
    expect(claim1?.task.id).toBe(parent.id);
    expect(await store.claimNextReady(projectId, ['test.parent'])).toBeNull();                 // already claimed (running): not claimable again
    await store.commitOutcome(claim1!.task, claim1!.token, { kind: 'completed', result: { ok: true } });
    const claim2 = await store.claimNextReady(projectId, ['test.child']);
    expect(claim2?.task.id).toBe(child.id);
    await store.commitOutcome(claim2!.task, claim2!.token, { kind: 'completed', result: {} });
  });

  it('commit is idempotent: a repeat commit of the SAME result succeeds as a no-op; a DIFFERENT result is refused', async () => {
    await store.createTask(projectId, { type: 'test.idem' });
    const claim = await store.claimNextReady(projectId, ['test.idem']);
    const committed = await store.commitOutcome(claim!.task, claim!.token, { kind: 'completed', result: { v: 1 } });
    const again = await store.commitOutcome(claim!.task, claim!.token, { kind: 'completed', result: { v: 1 } });    // duplicate submission, e.g. a retried browser action
    expect(again.id).toBe(committed.id); expect(again.result_sha256).toBe(committed.result_sha256);
    await expect(store.commitOutcome(claim!.task, claim!.token, { kind: 'completed', result: { v: 2 } })).rejects.toThrow(/commit_conflict|could not be committed/);
  });

  it('a stale claim is swept, retried with backoff, then terminally failed once attempts are exhausted', async () => {
    const t = await store.createTask(projectId, { type: 'test.stale', maxAttempts: 2 });
    const claim = await store.claimNextReady(projectId, ['test.stale']);
    expect(claim).not.toBeNull();
    const old = Date.now() - store.STALE_CLAIM_MS - 1000;
    await q('UPDATE research_studio_tasks SET claimed_at = $2 WHERE id = $1', [t.id, old]);
    const recovered = await store.sweepStale(projectId, store.STALE_CLAIM_MS, Date.now());
    expect(recovered).toBe(1);
    const afterFirst = await store.getTask(t.id); expect(afterFirst?.status).toBe('retryable_failure'); expect(afterFirst?.attempts).toBe(1);
    const requeued = await store.requeueEligible(projectId, Date.now() + store.BACKOFF_MAX_MS);
    expect(requeued).toBe(1);
    const claim2 = await store.claimNextReady(projectId, ['test.stale']);
    await q('UPDATE research_studio_tasks SET claimed_at = $2 WHERE id = $1', [t.id, old]);
    await store.sweepStale(projectId, store.STALE_CLAIM_MS, Date.now());
    const final = await store.getTask(t.id); expect(final?.status).toBe('failed'); expect(final?.attempts).toBe(2);
    void claim2;
  });

  it('pause/resume/cancel are only allowed from sensible states', async () => {
    const t = await store.createTask(projectId, { type: 'test.lifecycle' });
    await store.pauseTask(t.id);
    expect((await store.getTask(t.id))?.status).toBe('paused');
    await expect(store.pauseTask(t.id)).rejects.toThrow(/can be paused/);
    await store.resumeTask(t.id);
    expect((await store.getTask(t.id))?.status).toBe('queued');
    await expect(store.resumeTask(t.id)).rejects.toThrow(/can be resumed/);
    const cancelled = await store.cancelTask(t.id, 'no longer needed');
    expect(cancelled.status).toBe('cancelled');
    await expect(store.pauseTask(t.id)).rejects.toThrow(/can be paused/);                      // cancellation is final
  });

  it('awaiting_user holds the task until resolved, and the answer is merged into params without fabricating anything', async () => {
    const t = await store.createTask(projectId, { type: 'test.ask' });
    const claim = await store.claimNextReady(projectId, ['test.ask']);
    await store.commitOutcome(claim!.task, claim!.token, { kind: 'awaiting_user', reason: 'need a journal name' });
    expect((await store.getTask(t.id))?.status).toBe('awaiting_user');
    const resolved = await store.resolveAwaitingUser(t.id, { journal: 'Lancet' });
    expect(resolved.status).toBe('queued');
    expect(JSON.parse(resolved.params_json).userAnswer).toEqual({ journal: 'Lancet' });
  });

  it('a budget is enforced and fails the task closed, never silently exceeding it', async () => {
    const t = await store.createTask(projectId, { type: 'test.budget', budget: { maxActions: 2 } });
    const claim = await store.claimNextReady(projectId, ['test.budget']);
    const ok1 = await store.recordUsage(claim!.task, claim!.token, { actions: 1 });
    expect(ok1.ok).toBe(true);
    const over = await store.recordUsage({ ...claim!.task, usage_json: JSON.stringify((ok1 as any).usage) }, claim!.token, { actions: 2 });
    expect(over.ok).toBe(false);
    expect((await store.getTask(t.id))?.status).toBe('failed');
  });

  it('a bounded revision group refuses to grow past its cap', async () => {
    await store.createTask(projectId, { type: 'test.revision', revisionGroup: 'rg1', maxRevisionsInGroup: 2 });
    await store.createTask(projectId, { type: 'test.revision', revisionGroup: 'rg1', maxRevisionsInGroup: 2 });
    await expect(store.createTask(projectId, { type: 'test.revision', revisionGroup: 'rg1', maxRevisionsInGroup: 2 })).rejects.toThrow(/bounded and terminates here/);
  });

  it('downstream invalidation flags completed dependents transitively, without deleting their artifacts', async () => {
    const a = await store.createTask(projectId, { type: 'test.inv.a' });
    const b = await store.createTask(projectId, { type: 'test.inv.b', dependsOn: [a.id] });
    const c = await store.createTask(projectId, { type: 'test.inv.c', dependsOn: [b.id] });
    for (const t of [a, b, c]) { const claim = await store.claimNextReady(projectId, [t.type]); await store.commitOutcome(claim!.task, claim!.token, { kind: 'completed', result: { from: t.type } }); }
    const flagged = await store.invalidateDownstream(a.id, 'source evidence corrected');
    expect(new Set(flagged)).toEqual(new Set([b.id, c.id]));
    const bRow = await store.getTask(b.id); expect(bRow?.status).toBe('completed'); expect(bRow?.invalidated_at).not.toBeNull();     // kept, flagged stale
    const cRow = await store.getTask(c.id); expect(cRow?.invalidated_reason).toMatch(/source evidence corrected/);
  });

  it('childTasks created in one commit resolve sibling dependsOn-by-type to the real generated id', async () => {
    await store.createTask(projectId, { type: 'test.spawn' });
    const claim = await store.claimNextReady(projectId, ['test.spawn']);
    await store.commitOutcome(claim!.task, claim!.token, {
      kind: 'completed', result: {},
      childTasks: [{ type: 'test.spawn.first' }, { type: 'test.spawn.second', dependsOn: ['test.spawn.first'] }],
    });
    const rows = await q('SELECT * FROM research_studio_tasks WHERE project_id = $1 AND type = $2', [projectId, 'test.spawn.second']);
    const firstRows = await q('SELECT * FROM research_studio_tasks WHERE project_id = $1 AND type = $2', [projectId, 'test.spawn.first']);
    expect(JSON.parse(rows[0].depends_on_json)).toEqual([firstRows[0].id]);               // not the literal string 'test.spawn.first'
  });
});
