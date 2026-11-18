/**
 * Scheduled task execution (plan F07).
 *
 * One table (`scheduled_tasks`) is written by the dashboard and read here.
 * Every execution — cron or manual — goes through executeTask(), which:
 *   - claims the task atomically (running_since) so overlapping runs are skipped,
 *     across processes;
 *   - records a task_runs row with the REAL outcome (succeeded / failed /
 *     skipped_overlap), the error code and execution mode;
 *   - delivers output to a channel only when the run succeeded.
 * The scheduler reconciles jobs every minute and re-creates a job whenever its
 * cron, prompt, skill or enabled flag changed. Cancellation of an in-flight agent
 * run is not supported (runAgent has no abort); disabling stops future runs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CronJob } from 'cron';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { runAgent } from './container-runner';
import { findChannel } from './channels/registry';
import { logger } from './logger';
import { safeErrorSummary } from './security/redact';

export interface TaskRow {
  id: string;
  name: string;
  cron: string;
  skill: string;
  prompt: string;
  group_id: string | null;
  channel: string | null;
  enabled: number;
  updated_at: number | null;
  created_at: number;
}

export type RunStatus = 'succeeded' | 'failed' | 'skipped_overlap' | 'not_found';
export interface RunOutcome { runId: number | null; status: RunStatus; error?: string }

const SKILLS_DIR = path.resolve('./container/skills');
/** A claim older than this is considered abandoned (process crash). */
const STALE_CLAIM_MS = Number(process.env.TASK_STALE_CLAIM_MS ?? 30 * 60 * 1000);
const MAX_STORED_OUTPUT = 20_000;

/** Throws if the cron expression is invalid. */
export function assertValidCron(expr: string): void {
  if (typeof expr !== 'string' || !expr.trim()) throw new Error('cron is required');
  // Constructing (not starting) a CronJob validates the expression.
  new CronJob(expr, () => {}, null, false);
}

function buildPrompt(task: TaskRow): string {
  if (task.skill && /^[a-z0-9-]+$/.test(task.skill)) {
    const p = path.join(SKILLS_DIR, task.skill, 'SKILL.md');
    if (fs.existsSync(p)) {
      return `You are running the ${task.skill} skill.\n\n${fs.readFileSync(p, 'utf8').slice(0, 8000)}\n\n---\n\nTask:\n${task.prompt}`;
    }
  }
  return task.prompt;
}

export async function executeTask(taskId: string, trigger: 'cron' | 'manual'): Promise<RunOutcome> {
  const now = Date.now();
  const claim = await db.query<TaskRow>(
    `UPDATE scheduled_tasks SET running_since = $2
      WHERE id = $1 AND (running_since IS NULL OR running_since < $3)
      RETURNING *`,
    [taskId, now, now - STALE_CLAIM_MS],
  );
  const task = claim[0];
  if (!task) {
    const exists = await db.queryOne('SELECT id FROM scheduled_tasks WHERE id = $1', [taskId]);
    if (!exists) return { runId: null, status: 'not_found' };
    const r = await db.queryOne<{ id: number }>(
      `INSERT INTO task_runs (task_id, ts, status, trigger, finished_at, latency_ms) VALUES ($1, $2, 'skipped_overlap', $3, $2, 0) RETURNING id`,
      [taskId, now, trigger],
    );
    return { runId: r?.id ?? null, status: 'skipped_overlap' };
  }

  const run = await db.queryOne<{ id: number }>(
    `INSERT INTO task_runs (task_id, ts, status, trigger) VALUES ($1, $2, 'running', $3) RETURNING id`,
    [taskId, now, trigger],
  );
  const runId = run!.id;
  let status: RunStatus = 'failed';
  let error: string | undefined;
  try {
    const result = await runAgent({
      groupId: task.group_id || `task-${task.id}`,
      channel: task.channel || 'scheduler',
      prompt: buildPrompt(task),
    });
    status = result.error ? 'failed' : 'succeeded';
    error = result.error;
    await db.query(
      `UPDATE task_runs SET status = $2, output = $3, error = $4, execution_mode = $5, finished_at = $6, latency_ms = $7 WHERE id = $1`,
      [runId, status, result.error ? null : result.text.slice(0, MAX_STORED_OUTPUT), result.error ?? null, result.executionMode, Date.now(), Date.now() - now],
    );
    if (status === 'succeeded' && task.channel && task.group_id) {
      const ch = findChannel(task.channel);
      if (ch) {
        await ch.send({ groupId: task.group_id, channel: task.channel, text: result.text });
        for (const artifact of result.artifacts) await ch.send({ groupId: task.group_id, channel: task.channel, text: '', filePath: artifact });
      }
    }
  } catch (err) {
    status = 'failed';
    error = 'task_execution_exception';
    logger.error(`Scheduled task ${task.id} failed: ${safeErrorSummary(err)}`);
    await db.query(`UPDATE task_runs SET status = 'failed', error = $2, finished_at = $3, latency_ms = $4 WHERE id = $1`,
      [runId, error, Date.now(), Date.now() - now]).catch(() => {});
  } finally {
    await db.query(`UPDATE scheduled_tasks SET running_since = NULL, last_run = $2, last_status = $3 WHERE id = $1`,
      [taskId, now, status]).catch(() => {});
  }
  return { runId, status, error };
}

// ── Scheduler (reconciliation) ────────────────────────────────────────────────

export interface JobHandle { stop(): void }
export type JobFactory = (task: TaskRow, onTick: () => void) => JobHandle;

const defaultFactory: JobFactory = (task, onTick) => {
  const job = new CronJob(task.cron, onTick, null, true);
  return { stop: () => job.stop() };
};

interface Active { handle: JobHandle; signature: string }
const active = new Map<string, Active>();

export function taskSignature(t: TaskRow): string {
  return [t.cron, t.prompt, t.skill, t.enabled, t.updated_at ?? '', t.group_id ?? '', t.channel ?? ''].join('\u0001');
}

/** Bring running jobs in line with the given enabled task rows. Exported for tests. */
export function reconcile(tasks: TaskRow[], factory: JobFactory = defaultFactory, registry: Map<string, Active> = active): void {
  const wanted = new Map(tasks.filter((t) => t.enabled === 1).map((t) => [t.id, t]));
  for (const [id, a] of registry) {
    const t = wanted.get(id);
    if (!t || taskSignature(t) !== a.signature) { a.handle.stop(); registry.delete(id); }
  }
  for (const [id, t] of wanted) {
    if (registry.has(id)) continue;
    try {
      const handle = factory(t, () => { executeTask(id, 'cron').catch((e) => logger.error(`task tick failed: ${safeErrorSummary(e)}`)); });
      registry.set(id, { handle, signature: taskSignature(t) });
    } catch (err) {
      logger.error(`Invalid schedule for task ${id}; not scheduled: ${safeErrorSummary(err)}`);
    }
  }
}

export function startScheduler(): void {
  const tick = () => db.query<TaskRow>('SELECT * FROM scheduled_tasks WHERE enabled = 1')
    .then((rows) => reconcile(rows))
    .catch((err) => logger.error(`Task scheduler reload failed: ${safeErrorSummary(err)}`));
  void tick();
  setInterval(tick, 60 * 1000);
  logger.info('Task scheduler started');
}

/** Programmatic creation (e.g. from channels). Validates cron. */
export async function createTask(groupId: string, channel: string, name: string, cron: string, prompt: string): Promise<string> {
  assertValidCron(cron);
  const id = uuidv4();
  await db.query(
    `INSERT INTO scheduled_tasks (id, name, cron, skill, prompt, group_id, channel, enabled, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, '', $4, $5, $6, 1, $7, $7, 'channel')`,
    [id, name, cron, prompt, groupId, channel, Date.now()],
  );
  return id;
}
