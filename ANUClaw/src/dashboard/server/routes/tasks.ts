import { Router } from 'express';
import { requireDashAuth, requireRole } from '../auth';
import { db } from '../../../db';
import * as crypto from 'crypto';
import { assertValidCron, executeTask } from '../../../task-scheduler';
import { logger } from '../../../logger';
import { safeErrorSummary } from '../../../security/redact';

const router = Router();

// Tables are created by the migration (src/db/connection.ts); the scheduler
// (src/task-scheduler.ts) reads the same scheduled_tasks table.

function fail(res: any, where: string, err: unknown): void {
  logger.error(`tasks route error (${where}): ${safeErrorSummary(err)}`);
  res.status(500).json({ error: 'Internal error.' });
}

// List tasks
router.get('/', requireDashAuth, async (_req, res) => {
  try {
    const tasks = await db.query(`
      SELECT t.*,
             (SELECT COUNT(*) FROM task_runs WHERE task_id = t.id) as run_count
      FROM scheduled_tasks t ORDER BY created_at DESC
    `);
    res.json({ tasks });
  } catch (err) {
    fail(res, 'route', err);
  }
});

// Create task
router.post('/', requireDashAuth, requireRole('admin', 'operator'), async (req, res) => {
  const { name, cron, skill, prompt, group_id } = req.body as Record<string, string>;
  if (!name || !cron || !skill || !prompt) {
    res.status(400).json({ error: 'name, cron, skill, and prompt are required.' });
    return;
  }
  try { assertValidCron(cron); } catch { res.status(400).json({ error: 'cron is not a valid cron expression.' }); return; }
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await db.query(`
      INSERT INTO scheduled_tasks (id, name, cron, skill, prompt, group_id, enabled, created_at, updated_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $7, $8)
    `, [id, name, cron, skill, prompt, group_id ?? null, now, (req as any).user?.id ?? 'system']);
    res.status(201).json({ id });
  } catch (err) {
    fail(res, 'route', err);
  }
});

// Update task
router.put('/:id', requireDashAuth, requireRole('admin', 'operator'), async (req, res) => {
  const { name, cron, skill, prompt, group_id, enabled } = req.body as Record<string, unknown>;
  if (cron !== undefined) {
    try { assertValidCron(String(cron)); } catch { res.status(400).json({ error: 'cron is not a valid cron expression.' }); return; }
  }
  try {
    const rows = await db.query(`
      UPDATE scheduled_tasks SET name=COALESCE($1,name), cron=COALESCE($2,cron),
        skill=COALESCE($3,skill), prompt=COALESCE($4,prompt),
        group_id=COALESCE($5,group_id), enabled=COALESCE($6,enabled), updated_at=$8
      WHERE id=$7 RETURNING id
    `, [name ?? null, cron ?? null, skill ?? null, prompt ?? null, group_id ?? null, enabled ?? null, req.params.id, Date.now()]);
    if (!rows.length) { res.status(404).json({ error: 'Task not found.' }); return; }
    res.json({ ok: true, rescheduled_within_seconds: 60 });
  } catch (err) {
    fail(res, 'route', err);
  }
});

// Delete task
router.delete('/:id', requireDashAuth, requireRole('admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM task_runs WHERE task_id=$1', [req.params.id]);
    await db.query('DELETE FROM scheduled_tasks WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    fail(res, 'route', err);
  }
});

// Toggle enabled
router.patch('/:id/toggle', requireDashAuth, requireRole('admin', 'operator'), async (req, res) => {
  try {
    await db.query(`
      UPDATE scheduled_tasks SET enabled = CASE WHEN enabled=1 THEN 0 ELSE 1 END, updated_at=$2 WHERE id=$1
    `, [req.params.id, Date.now()]);
    const t = await db.queryOne('SELECT enabled FROM scheduled_tasks WHERE id=$1', [req.params.id]) as { enabled: number } | undefined;
    res.json({ ok: true, enabled: !!t?.enabled });
  } catch (err) {
    fail(res, 'route', err);
  }
});

// Manual trigger: really executes the task (asynchronously) and records the outcome.
router.post('/:id/trigger', requireDashAuth, requireRole('admin', 'operator'), async (req, res) => {
  try {
    const task = await db.queryOne('SELECT id FROM scheduled_tasks WHERE id=$1', [req.params.id]);
    if (!task) { res.status(404).json({ error: 'Task not found.' }); return; }
    const pending = executeTask(String(req.params.id), 'manual');
    pending.catch((e) => logger.error(`manual task run failed: ${safeErrorSummary(e)}`));
    if (req.query.wait === 'true') {
      const outcome = await pending;
      res.status(outcome.status === 'succeeded' ? 200 : outcome.status === 'skipped_overlap' ? 409 : 502).json(outcome);
      return;
    }
    res.status(202).json({ accepted: true, message: 'Run started; see /runs for its recorded outcome.' });
  } catch (err) { fail(res, 'trigger', err); }
});

// Run history for a task
router.get('/:id/runs', requireDashAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  try {
    const runs = await db.query(`
      SELECT * FROM task_runs WHERE task_id=$1 ORDER BY ts DESC LIMIT $2
    `, [req.params.id, limit]);
    res.json({ runs });
  } catch (err) {
    fail(res, 'route', err);
  }
});

export default router;
