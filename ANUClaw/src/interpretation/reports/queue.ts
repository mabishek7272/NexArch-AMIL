/**
 * Report queue (interpretation engine, P4): the same claim/lease/fence/backoff pattern as the job queue
 * (`jobs/queue.ts`), applied to `interpretation_reports`. A claim uses FOR UPDATE SKIP LOCKED; every state change is
 * fenced by the claim token, so a worker that lost its lease cannot overwrite a newer attempt.
 */
import * as crypto from 'crypto';
import { db } from '../../db';
import { backoffMs } from '../jobs/queue';
import { enqueueReportEvent } from '../webhooks/outbox';

/** A narrative stage can make up to four model calls (two per layer); the lease is extended before each, and a call is bounded by the transport timeout. */
export const REPORT_LEASE_MS = 300_000;

export type ReportStage = 'generating' | 'narrating' | 'assembling';
export interface ClaimedReport { id: string; job_id: string; tenant_id: string; version: number; attempts: number; max_attempts: number; claim_token: string; findings_sha256: string; /** which stage this claim runs: governance (`generating`) or narrative (`narrating`) */ stage: ReportStage }

export async function claimNextReport(now = Date.now(), leaseMs = REPORT_LEASE_MS): Promise<ClaimedReport | null> {
  const token = crypto.randomBytes(16).toString('hex');
  // A queued report starts governance; a governed one starts the narrative stage; an expired lease re-runs the stage it held.
  const rows = await db.query<ClaimedReport>(
    `UPDATE interpretation_reports SET status = CASE WHEN status IN ('queued','generating') THEN 'generating' WHEN status IN ('governed','narrating') THEN 'narrating' ELSE 'assembling' END,
       claim_token = $1, lease_expires_at = $2, attempts = attempts + 1, updated_at = $3
     WHERE id = (
       SELECT id FROM interpretation_reports
       WHERE (status IN ('queued','governed','narrated') AND run_after <= $3) OR (status IN ('generating','narrating','assembling') AND lease_expires_at < $3)
       ORDER BY run_after ASC, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, job_id, tenant_id, version, attempts, max_attempts, claim_token, findings_sha256, status AS stage`,
    [token, now + leaseMs, now]);
  return rows[0] ?? null;
}

/** Extends the lease while a long stage runs. Returns false if the claim was lost (stop work). */
export async function heartbeatReport(id: string, token: string, now = Date.now(), leaseMs = REPORT_LEASE_MS): Promise<boolean> {
  const rows = await db.query(`UPDATE interpretation_reports SET lease_expires_at = $3, updated_at = $4 WHERE id = $1 AND claim_token = $2 AND status IN ('generating','narrating','assembling') RETURNING id`, [id, token, now + leaseMs, now]);
  return rows.length === 1;
}

/** Records a failed attempt: a retry of the SAME stage with backoff, or a permanent failure (out of attempts, or `permanent`). Fenced. */
export async function failReport(r: ClaimedReport, code: string, permanent: boolean, now = Date.now()): Promise<'retry' | 'failed' | 'lost'> {
  const final = permanent || r.attempts >= r.max_attempts;
  if (!final) {
    const rows = await db.query(`UPDATE interpretation_reports SET status = CASE WHEN status = 'assembling' THEN 'narrated' WHEN status = 'narrating' THEN 'governed' ELSE 'queued' END, error_code = $3, run_after = $4, claim_token = NULL, lease_expires_at = NULL, updated_at = $5 WHERE id = $1 AND claim_token = $2 AND status IN ('generating','narrating','assembling') RETURNING id`, [r.id, r.claim_token, code, now + backoffMs(r.attempts), now]);
    return rows.length === 0 ? 'lost' : 'retry';
  }
  // A permanent failure and its webhook notification commit together.
  return db.transaction(async (tx) => {
    const u = await tx.query(`UPDATE interpretation_reports SET status = 'failed', error_code = $3, claim_token = NULL, lease_expires_at = NULL, updated_at = $4 WHERE id = $1 AND claim_token = $2 AND status IN ('generating','narrating','assembling') RETURNING id`, [r.id, r.claim_token, code, now]);
    if (!u.rows.length) return 'lost' as const;
    await enqueueReportEvent(tx, r.tenant_id, 'interpretation.report_failed', { jobId: r.job_id, reportId: r.id, version: r.version, findingsSha256: r.findings_sha256, reviewState: null, errorCode: code }, now);
    return 'failed' as const;
  });
}
