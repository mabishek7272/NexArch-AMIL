/**
 * Postgres-backed job queue for interpretation jobs (interpretation engine, P3a).
 *
 * - claim: one atomic UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1), so two workers can never
 *   hold the same job. It also reclaims jobs whose lease expired (a worker that died).
 * - fencing: every claim gets a fresh `claim_token`; completion/failure only applies while the row still carries that
 *   token. A worker that lost its lease (and was superseded) cannot overwrite the newer attempt's result.
 * - retry: backoff min(30 min, 30 s * 2^(attempts-1)); after max_attempts the job fails permanently.
 * Job rows never hold payload content or identifiers.
 */
import * as crypto from 'crypto';
import { db } from '../../db';
import { enqueueWebhookEvent } from '../webhooks/outbox';

export const LEASE_MS = 60_000;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 30 * 60_000;

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export interface ClaimedJob { id: string; tenant_id: string; skill_id: string; attempts: number; max_attempts: number; claim_token: string; subject_ref: string; captured_at: string }

export async function claimNextJob(now = Date.now(), leaseMs = LEASE_MS): Promise<ClaimedJob | null> {
  const token = crypto.randomBytes(16).toString('hex');
  const rows = await db.query<ClaimedJob>(
    `UPDATE interpretation_jobs SET status = 'processing', claim_token = $1, lease_expires_at = $2, attempts = attempts + 1, updated_at = $3
     WHERE id = (
       SELECT id FROM interpretation_jobs
       WHERE (status = 'queued' AND run_after <= $3) OR (status = 'processing' AND lease_expires_at < $3)
       ORDER BY run_after ASC, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, tenant_id, skill_id, attempts, max_attempts, claim_token, subject_ref, captured_at`,
    [token, now + leaseMs, now]);
  return rows[0] ?? null;
}

/** Extends the lease while a long adapter runs. Returns false if the claim was lost (stop work). */
export async function heartbeat(jobId: string, token: string, now = Date.now(), leaseMs = LEASE_MS): Promise<boolean> {
  const rows = await db.query(`UPDATE interpretation_jobs SET lease_expires_at = $3, updated_at = $4 WHERE id = $1 AND claim_token = $2 AND status = 'processing' RETURNING id`, [jobId, token, now + leaseMs, now]);
  return rows.length === 1;
}

/** Records a failed attempt: schedules a retry, or fails permanently when out of attempts or when `permanent`. Fenced. */
export async function failAttempt(job: ClaimedJob, code: string, permanent: boolean, now = Date.now()): Promise<'retry' | 'failed' | 'lost'> {
  const final = permanent || job.attempts >= job.max_attempts;
  if (!final) {
    const rows = await db.query(`UPDATE interpretation_jobs SET status = 'queued', error_code = $3, run_after = $4, claim_token = NULL, lease_expires_at = NULL, updated_at = $5 WHERE id = $1 AND claim_token = $2 AND status = 'processing' RETURNING id`, [job.id, job.claim_token, code, now + backoffMs(job.attempts), now]);
    return rows.length === 0 ? 'lost' : 'retry';
  }
  // A permanent failure and its webhook notification commit together.
  return db.transaction(async (tx) => {
    const r = await tx.query(`UPDATE interpretation_jobs SET status = 'failed', error_code = $3, claim_token = NULL, lease_expires_at = NULL, updated_at = $4, completed_at = $4 WHERE id = $1 AND claim_token = $2 AND status = 'processing' RETURNING id`, [job.id, job.claim_token, code, now]);
    if (!r.rows.length) return 'lost' as const;
    await enqueueWebhookEvent(tx, job.tenant_id, 'interpretation.failed', { jobId: job.id, skillId: job.skill_id, status: 'failed', errorCode: code }, now);
    return 'failed' as const;
  });
}
