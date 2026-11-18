/**
 * The autonomous orchestrator (plan §2). `tick(projectId)` is the one entry point that advances a project's task graph by
 * one step: it recovers stalled tasks, requeues backed-off retries, claims exactly one ready task whose type has a
 * registered agent, runs that agent, and commits its outcome — all through task-store.ts's durable, idempotent primitives,
 * so calling tick() again from a different process after a restart continues correctly rather than redoing or losing work.
 *
 * This function does not loop internally (no unbounded synchronous work, no hidden recursion): callers (the API, a test,
 * or — once added — a scheduler like task-scheduler.ts) call it repeatedly. `runToQuiescence` is a bounded convenience
 * for tests and for synchronous callers that want "advance until nothing more can happen right now".
 */
import { getTask, claimNextReady, commitOutcome, requeueEligible, sweepStale, TaskStoreError } from './task-store';
import { handlerFor, runnableTypes } from './agent-registry';
import { db } from '../db';
import { ProjectRow, TaskRow } from './types';

export interface TickResult { advanced: boolean; task?: TaskRow; outcome?: 'completed' | 'awaiting_user' | 'retryable_failure' | 'failed' | 'error'; staleRecovered: number; requeued: number }

export async function tick(projectId: string): Promise<TickResult> {
  const staleRecovered = await sweepStale(projectId);
  const requeued = await requeueEligible(projectId);
  const claim = await claimNextReady(projectId, runnableTypes());
  if (!claim) return { advanced: false, staleRecovered, requeued };
  const handler = handlerFor(claim.task.type);
  if (!handler) return { advanced: false, staleRecovered, requeued };            // should not happen: runnableTypes() only lists registered types
  const project = await db.queryOne<ProjectRow>('SELECT * FROM research_studio_projects WHERE id = $1', [claim.task.project_id]);
  if (!project) return { advanced: false, staleRecovered, requeued };
  try {
    const outcome = await handler({ project, task: claim.task, token: claim.token });
    const committed = await commitOutcome(claim.task, claim.token, outcome, Date.now());
    return { advanced: true, task: committed, outcome: outcome.kind === 'completed' ? 'completed' : outcome.kind, staleRecovered, requeued };
  } catch (err) {
    // A throwing handler is treated as a retryable failure of THIS attempt, never as a silent success.
    try { await commitOutcome(claim.task, claim.token, { kind: 'retryable_failure', reason: `handler threw: ${(err as Error).message}`.slice(0, 500) }); }
    catch (e) { if (!(e instanceof TaskStoreError)) throw e; }
    return { advanced: true, task: await getTask(claim.task.id), outcome: 'error', staleRecovered, requeued };
  }
}

/** Bounded convenience: ticks until nothing advances or the step budget is exhausted. Used by tests and the API's "advance now" action. */
export async function runToQuiescence(projectId: string, maxSteps = 50): Promise<TickResult[]> {
  const results: TickResult[] = [];
  for (let i = 0; i < maxSteps; i++) { const r = await tick(projectId); results.push(r); if (!r.advanced) break; }
  return results;
}

export interface TaskView extends TaskRow { agentAvailable: boolean }
/** Every task of the project, each flagged with whether an agent is currently registered to run it — the honest signal the UI shows instead of fabricated progress. */
export async function projectGraphView(projectId: string): Promise<TaskView[]> {
  const rows = await db.query<TaskRow>('SELECT * FROM research_studio_tasks WHERE project_id = $1 ORDER BY ordinal', [projectId]);
  const runnable = new Set(runnableTypes());
  return rows.map((r) => ({ ...r, agentAvailable: runnable.has(r.type) }));
}
