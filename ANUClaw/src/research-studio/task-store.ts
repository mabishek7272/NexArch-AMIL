/**
 * Durable task-graph store (M1). One Postgres table per project is persisted state; nothing here is held only in memory, so a
 * second process (or the same process after a restart) sees exactly the same graph. Every state transition is appended to an
 * immutable, hash-chained event log (research_studio_task_events) — the evidence trail the brief requires ("retain evidence of
 * that work"). States: queued, running, awaiting_user, paused, retryable_failure, failed, cancelled, completed.
 *
 * Mechanisms (generic; reusable by every future agent, including browser-based ones):
 *  - atomic claim (UPDATE ... WHERE status='queued' ... RETURNING), same pattern as task-scheduler.ts's executeTask claim;
 *  - idempotent commit: a commit is keyed to the EXACT claim token; a repeat commit of an already-completed task with the
 *    same result hash is a no-op success (protects against duplicate submissions — e.g. a browser action retried after an
 *    uncertain network response); a repeat commit with a DIFFERENT result is refused, never silently overwritten;
 *  - retry with exponential backoff up to max_attempts, after which the task is terminally failed;
 *  - stale-task sweep: a 'running' task whose claim is older than the stale threshold (crash / process restart) is recovered
 *    deterministically — retried if attempts remain, else failed; never left silently stuck;
 *  - pause/resume/cancel, enforced only from states where they make sense;
 *  - downstream invalidation: when a task's result is invalidated, every COMPLETED task that depends on it (directly or
 *    transitively) is flagged invalidated too (the task stays completed — its artifact is not deleted — but is marked stale);
 *  - revision-loop termination: a task declaring a `revisionGroup` cannot be created beyond `maxRevisionsInGroup` members;
 *  - a per-task budget (JSON: maxActions/maxTokens) that the orchestrator checks before dispatch and that `recordUsage`
 *    enforces on every increment — exceeding it fails the task closed, never silently lets it keep running.
 */
import * as crypto from 'crypto';
import { db } from '../db';
import { canonical, sha256Hex } from '../validation/study/manifest';
import { HandlerOutcome, NewTaskSpec, TaskRow, TaskState, TaskEventRow, TERMINAL_STATES } from './types';

export class TaskStoreError extends Error { constructor(public readonly code: string, message: string, public readonly status = 409) { super(message); this.name = 'TaskStoreError'; } }
export const STALE_CLAIM_MS = 15 * 60 * 1000;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 30 * 60 * 1000;
export const backoffMs = (attempts: number) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));

async function appendEvent(projectId: string, taskId: string, event: string, detail: Record<string, unknown>): Promise<void> {
  const last = await db.queryOne<{ seq: number; hash: string }>('SELECT seq, hash FROM research_studio_task_events WHERE project_id = $1 ORDER BY seq DESC LIMIT 1', [projectId]);
  const prevHash = last?.hash ?? '0'.repeat(64);
  const base = { seq: (last?.seq ?? 0) + 1, projectId, taskId, event, detail, at: Date.now(), prevHash };
  const hash = sha256Hex(canonical(base));
  await db.query('INSERT INTO research_studio_task_events (id, project_id, task_id, seq, event, detail_json, at, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [crypto.randomUUID(), projectId, taskId, base.seq, event, JSON.stringify(detail), base.at, prevHash, hash]);
}

export async function listEvents(projectId: string): Promise<TaskEventRow[]> {
  return db.query<TaskEventRow>('SELECT * FROM research_studio_task_events WHERE project_id = $1 ORDER BY seq', [projectId]);
}
/** Re-verifies the hash chain; returns the break point if tampered (never trusts the stored order blindly). */
export async function verifyEventChain(projectId: string): Promise<{ ok: boolean; brokenAtSeq: number | null; entries: number }> {
  const rows = await listEvents(projectId); let prev = '0'.repeat(64);
  for (const r of rows) {
    const base = { seq: r.seq, projectId: r.project_id, taskId: r.task_id, event: r.event, detail: JSON.parse(r.detail_json), at: Number(r.at), prevHash: r.prev_hash };
    if (r.prev_hash !== prev || sha256Hex(canonical(base)) !== r.hash) return { ok: false, brokenAtSeq: r.seq, entries: rows.length };
    prev = r.hash;
  }
  return { ok: true, brokenAtSeq: null, entries: rows.length };
}

/** Current member count of a revision group — exported so a handler (e.g. the Scientific Critic) can decide WHETHER
 * to request another round before building childTasks, rather than relying on createTask's cap-check to throw after
 * this task has already been committed as 'completed'. */
export async function revisionGroupCount(projectId: string, revisionGroup: string): Promise<number> {
  return Number((await db.queryOne<{ n: string }>('SELECT COUNT(*)::text AS n FROM research_studio_tasks WHERE project_id = $1 AND revision_group = $2', [projectId, revisionGroup]))?.n ?? '0');
}

export async function createTask(projectId: string, spec: NewTaskSpec, now = Date.now()): Promise<TaskRow> {
  if (spec.revisionGroup && spec.maxRevisionsInGroup !== undefined) {
    const n = await revisionGroupCount(projectId, spec.revisionGroup);
    if (n >= spec.maxRevisionsInGroup) throw new TaskStoreError('revision_limit_reached', `Revision group "${spec.revisionGroup}" already has ${n} task(s); the limit is ${spec.maxRevisionsInGroup}. The revision loop is bounded and terminates here.`);
  }
  const id = crypto.randomUUID();
  const row: Omit<TaskRow, 'id'> & { id: string } = {
    id, project_id: projectId, type: spec.type, status: 'queued',
    depends_on_json: JSON.stringify(spec.dependsOn ?? []), params_json: JSON.stringify(spec.params ?? {}), result_json: null, result_sha256: null,
    attempts: 0, max_attempts: spec.maxAttempts ?? 3, next_eligible_at: null, claimed_at: null, claim_token: null,
    invalidated_at: null, invalidated_reason: null, budget_json: JSON.stringify(spec.budget ?? {}), usage_json: JSON.stringify({ actions: 0, tokens: 0 }),
    revision_group: spec.revisionGroup ?? null, max_revisions_in_group: spec.maxRevisionsInGroup ?? null, created_at: now, updated_at: now,
  };
  await db.query(
    `INSERT INTO research_studio_tasks (id, project_id, type, status, depends_on_json, params_json, attempts, max_attempts, budget_json, usage_json, revision_group, max_revisions_in_group, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [row.id, row.project_id, row.type, row.status, row.depends_on_json, row.params_json, row.attempts, row.max_attempts, row.budget_json, row.usage_json, row.revision_group, row.max_revisions_in_group, row.created_at, row.updated_at]);
  await appendEvent(projectId, id, 'created', { type: spec.type, dependsOn: spec.dependsOn ?? [] });
  return (row as unknown) as TaskRow;
}

export async function getTask(taskId: string): Promise<TaskRow | undefined> { return db.queryOne<TaskRow>('SELECT * FROM research_studio_tasks WHERE id = $1', [taskId]); }
export async function listTasks(projectId: string): Promise<TaskRow[]> { return db.query<TaskRow>('SELECT * FROM research_studio_tasks WHERE project_id = $1 ORDER BY ordinal', [projectId]); }

/** True once every entry in dependsOn is 'completed' (an invalidated-but-completed dependency still counts: the orchestrator surfaces the staleness separately). */
async function dependenciesSatisfied(task: TaskRow): Promise<boolean> {
  const deps: string[] = JSON.parse(task.depends_on_json);
  if (!deps.length) return true;
  const rows = await db.query<{ status: TaskState }>('SELECT status FROM research_studio_tasks WHERE id = ANY($1::text[])', [deps]);
  return rows.length === deps.length && rows.every((r) => r.status === 'completed');
}

/** Atomically claims ONE ready, queued task of a type this process can run (registry of runnable types supplied by the caller so unimplemented types are never claimed). */
export async function claimNextReady(projectId: string, runnableTypes: string[], now = Date.now()): Promise<{ task: TaskRow; token: string } | null> {
  if (!runnableTypes.length) return null;
  const candidates = await db.query<TaskRow>(
    `SELECT * FROM research_studio_tasks WHERE project_id = $1 AND type = ANY($2::text[]) AND status = 'queued' AND (next_eligible_at IS NULL OR next_eligible_at <= $3) ORDER BY ordinal`,
    [projectId, runnableTypes, now]);
  for (const c of candidates) {
    if (!(await dependenciesSatisfied(c))) continue;
    const token = crypto.randomUUID();
    const claimed = await db.query<TaskRow>(`UPDATE research_studio_tasks SET status = 'running', claimed_at = $2, claim_token = $3, updated_at = $2 WHERE id = $1 AND status = 'queued' RETURNING *`, [c.id, now, token]);
    if (claimed.length) { await appendEvent(projectId, c.id, 'claimed', { token: token.slice(0, 8) }); return { task: claimed[0], token }; }
  }
  return null;
}

/** Adds to the per-task usage counters; fails the task CLOSED (never silently lets it exceed) if the budget is defined and would be exceeded. */
export async function recordUsage(task: TaskRow, token: string, delta: { actions?: number; tokens?: number }): Promise<{ ok: true; usage: { actions: number; tokens: number } } | { ok: false }> {
  const budget = JSON.parse(task.budget_json) as { maxActions?: number; maxTokens?: number };
  const usage = JSON.parse(task.usage_json) as { actions: number; tokens: number };
  const next = { actions: usage.actions + (delta.actions ?? 0), tokens: usage.tokens + (delta.tokens ?? 0) };
  if ((budget.maxActions !== undefined && next.actions > budget.maxActions) || (budget.maxTokens !== undefined && next.tokens > budget.maxTokens)) {
    await failTask(task.id, token, `budget exceeded (actions ${next.actions}/${budget.maxActions ?? '∞'}, tokens ${next.tokens}/${budget.maxTokens ?? '∞'})`, false);
    return { ok: false };
  }
  await db.query('UPDATE research_studio_tasks SET usage_json = $2, updated_at = $3 WHERE id = $1 AND claim_token = $4', [task.id, JSON.stringify(next), Date.now(), token]);
  return { ok: true, usage: next };
}

function resultHashOf(result: unknown): string { return sha256Hex(canonical(result)); }

/** Idempotent: a repeat call with the identical result after it already committed is a successful no-op; a DIFFERENT result after commit is refused. */
export async function commitOutcome(task: TaskRow, token: string, outcome: HandlerOutcome, now = Date.now()): Promise<TaskRow> {
  if (outcome.kind === 'completed') {
    const sha = resultHashOf(outcome.result);
    const claimed = await db.query<TaskRow>(`UPDATE research_studio_tasks SET status = 'completed', result_json = $2, result_sha256 = $3, claim_token = NULL, updated_at = $4 WHERE id = $1 AND status = 'running' AND claim_token = $5 RETURNING *`,
      [task.id, JSON.stringify(outcome.result), sha, now, token]);
    if (!claimed.length) {
      const current = await getTask(task.id);
      if (current?.status === 'completed' && current.result_sha256 === sha) return current;             // duplicate commit of the SAME result: idempotent success
      throw new TaskStoreError('commit_conflict', `Task ${task.id} could not be committed: it is no longer the running task that holds claim token ${token.slice(0, 8)}, or a different result was already committed.`);
    }
    await appendEvent(task.project_id, task.id, 'completed', { resultSha256: sha });
    // A batch of childTasks created in ONE commit may reference each other by `type` in `dependsOn` (resolved here, in
    // creation order, to the real task id) instead of needing to know ids that do not exist yet; an entry that matches
    // neither an earlier type in this batch nor looks like an unresolved placeholder is passed through unchanged (e.g. a
    // real, pre-existing task id from outside this batch).
    const byType = new Map<string, string>();
    for (const spec of outcome.childTasks ?? []) {
      const resolvedDeps = (spec.dependsOn ?? []).map((d) => byType.get(d) ?? d);
      const created = await createTask(task.project_id, { ...spec, dependsOn: resolvedDeps }, now);
      byType.set(spec.type, created.id);
    }
    return claimed[0];
  }
  if (outcome.kind === 'awaiting_user') {
    const r = await db.query<TaskRow>(`UPDATE research_studio_tasks SET status = 'awaiting_user', claim_token = NULL, updated_at = $2 WHERE id = $1 AND status = 'running' AND claim_token = $3 RETURNING *`, [task.id, now, token]);
    if (!r.length) throw new TaskStoreError('commit_conflict', 'Task is no longer held by this claim.');
    await appendEvent(task.project_id, task.id, 'awaiting_user', { reason: outcome.reason }); return r[0];
  }
  if (outcome.kind === 'failed') return failTask(task.id, token, outcome.reason, true);
  return retryOrFail(task.id, token, outcome.reason, now);
}

async function failTask(taskId: string, token: string, reason: string, requireRunning: boolean): Promise<TaskRow> {
  const where = requireRunning ? `status = 'running' AND claim_token = $3` : `claim_token = $3`;
  const r = await db.query<TaskRow>(`UPDATE research_studio_tasks SET status = 'failed', claim_token = NULL, updated_at = $2 WHERE id = $1 AND ${where} RETURNING *`, [taskId, Date.now(), token]);
  if (!r.length) { const cur = await getTask(taskId); if (cur) return cur; throw new TaskStoreError('not_found', 'Task not found.', 404); }
  const t = await getTask(taskId); await appendEvent(t!.project_id, taskId, 'failed', { reason }); return r[0];
}

async function retryOrFail(taskId: string, token: string, reason: string, now: number): Promise<TaskRow> {
  const cur = await db.queryOne<TaskRow>('SELECT * FROM research_studio_tasks WHERE id = $1 AND status = \'running\' AND claim_token = $2', [taskId, token]);
  if (!cur) throw new TaskStoreError('commit_conflict', 'Task is no longer held by this claim.');
  const attempts = cur.attempts + 1;
  if (attempts >= cur.max_attempts) {
    const r = await db.query<TaskRow>(`UPDATE research_studio_tasks SET status = 'failed', attempts = $2, claim_token = NULL, updated_at = $3 WHERE id = $1 RETURNING *`, [taskId, attempts, now]);
    await appendEvent(cur.project_id, taskId, 'failed', { reason, attempts, exhausted: true }); return r[0];
  }
  const nextAt = now + backoffMs(attempts);
  const r = await db.query<TaskRow>(`UPDATE research_studio_tasks SET status = 'retryable_failure', attempts = $2, next_eligible_at = $3, claim_token = NULL, updated_at = $4 WHERE id = $1 RETURNING *`, [taskId, attempts, nextAt, now]);
  await appendEvent(cur.project_id, taskId, 'retryable_failure', { reason, attempts, nextEligibleAt: nextAt }); return r[0];
}

/** Requeues every retryable_failure task whose backoff has elapsed. Call this from the orchestrator tick alongside claimNextReady. */
export async function requeueEligible(projectId: string, now = Date.now()): Promise<number> {
  const rows = await db.query<{ id: string }>(`UPDATE research_studio_tasks SET status = 'queued', next_eligible_at = NULL, updated_at = $2 WHERE project_id = $1 AND status = 'retryable_failure' AND (next_eligible_at IS NULL OR next_eligible_at <= $2) RETURNING id`, [projectId, now]);
  for (const r of rows) await appendEvent(projectId, r.id, 'requeued', {});
  return rows.length;
}

/** Stale-task recovery (crash / process restart): a 'running' task whose claim is older than STALE_CLAIM_MS is treated as a failed attempt of THAT run, retried or terminally failed exactly as a normal failure would be. Never left stuck. */
export async function sweepStale(projectId: string, staleMs = STALE_CLAIM_MS, now = Date.now()): Promise<number> {
  const stale = await db.query<TaskRow>(`SELECT * FROM research_studio_tasks WHERE project_id = $1 AND status = 'running' AND claimed_at < $2`, [projectId, now - staleMs]);
  for (const t of stale) { await appendEvent(projectId, t.id, 'stalled', { claimedAt: t.claimed_at }); await retryOrFail(t.id, t.claim_token!, 'stalled: claim exceeded the staleness window (process restart or crash)', now); }
  return stale.length;
}

const PAUSABLE: TaskState[] = ['queued', 'running', 'retryable_failure', 'awaiting_user'];
export async function pauseTask(taskId: string, now = Date.now()): Promise<TaskRow> {
  const r = await db.query<TaskRow>(`UPDATE research_studio_tasks SET status = 'paused', next_eligible_at = NULL, updated_at = $2 WHERE id = $1 AND status = ANY($3::text[]) RETURNING *`, [taskId, now, PAUSABLE]);
  if (!r.length) throw new TaskStoreError('bad_state', 'Only a queued, running, retryable, or awaiting-user task can be paused.');
  await appendEvent(r[0].project_id, taskId, 'paused', {}); return r[0];
}
export async function resumeTask(taskId: string, now = Date.now()): Promise<TaskRow> {
  const r = await db.query<TaskRow>(`UPDATE research_studio_tasks SET status = 'queued', claim_token = NULL, claimed_at = NULL, updated_at = $2 WHERE id = $1 AND status = 'paused' RETURNING *`, [taskId, now]);
  if (!r.length) throw new TaskStoreError('bad_state', 'Only a paused task can be resumed.');
  await appendEvent(r[0].project_id, taskId, 'resumed', {}); return r[0];
}
/** Resumes an awaiting_user task with the user's answer merged into its params (never fabricated by the system). */
export async function resolveAwaitingUser(taskId: string, answer: unknown, now = Date.now()): Promise<TaskRow> {
  const cur = await db.queryOne<TaskRow>(`SELECT * FROM research_studio_tasks WHERE id = $1 AND status = 'awaiting_user'`, [taskId]);
  if (!cur) throw new TaskStoreError('bad_state', 'Only an awaiting-user task can be resolved.');
  const params = { ...JSON.parse(cur.params_json), userAnswer: answer };
  const r = await db.query<TaskRow>(`UPDATE research_studio_tasks SET status = 'queued', params_json = $2, updated_at = $3 WHERE id = $1 RETURNING *`, [taskId, JSON.stringify(params), now]);
  await appendEvent(cur.project_id, taskId, 'resolved', {}); return r[0];
}
export async function cancelTask(taskId: string, reason: string, now = Date.now()): Promise<TaskRow> {
  const r = await db.query<TaskRow>(`UPDATE research_studio_tasks SET status = 'cancelled', claim_token = NULL, updated_at = $2 WHERE id = $1 AND status != ALL($3::text[]) RETURNING *`, [taskId, now, TERMINAL_STATES]);
  if (!r.length) { const cur = await getTask(taskId); if (cur && TERMINAL_STATES.includes(cur.status)) return cur; throw new TaskStoreError('not_found', 'Task not found.', 404); }
  await appendEvent(r[0].project_id, taskId, 'cancelled', { reason }); return r[0];
}

/** Marks every COMPLETED task that (transitively) depends on `taskId` as invalidated — the artifact is kept (never deleted) but flagged stale. Used when supporting evidence changes. */
export async function invalidateDownstream(taskId: string, reason: string, now = Date.now()): Promise<string[]> {
  const all = await db.query<TaskRow>('SELECT * FROM research_studio_tasks WHERE project_id = (SELECT project_id FROM research_studio_tasks WHERE id = $1)', [taskId]);
  const dependents = (id: string): string[] => all.filter((t) => JSON.parse(t.depends_on_json).includes(id)).map((t) => t.id);
  const toFlag = new Set<string>(); const queue = [taskId];
  while (queue.length) { const id = queue.shift()!; for (const d of dependents(id)) if (!toFlag.has(d)) { toFlag.add(d); queue.push(d); } }
  const ids = [...toFlag]; if (!ids.length) return ids;
  const rows = await db.query<{ id: string; project_id: string }>(`UPDATE research_studio_tasks SET invalidated_at = $2, invalidated_reason = $3, updated_at = $2 WHERE id = ANY($1::text[]) AND status = 'completed' RETURNING id, project_id`, [ids, now, reason]);
  for (const r of rows) await appendEvent(r.project_id, r.id, 'invalidated', { reason, causedBy: taskId });
  return rows.map((r) => r.id);
}
