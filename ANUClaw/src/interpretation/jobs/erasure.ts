/**
 * Subject erasure (interpretation engine, P3d): removes everything ANUClaw holds about one subject of one tenant, in a
 * single transaction, and leaves a tombstone and a receipt that identify no one.
 *
 * Erased: sealed identity, the stored source payload, the normalized findings, the governance output and report layers, and the payload bytes of any webhook
 * event about those jobs (pending events are cancelled). Each job row is kept as a TOMBSTONE: status `erased`, the
 * subject reference replaced, the idempotency key freed (so replaying the old request creates a new job rather than
 * pointing at an empty one), and the request fingerprint and payload/findings hashes cleared.
 *
 * Jobs still queued or being processed are stopped: the row lock taken here serialises with the worker's fenced commit,
 * and clearing the claim token makes that commit fail, so a worker cannot write findings back after erasure.
 *
 * Not erased, by design: the tamper-evident audit chain. It is append-only and hash-linked, and holds only job ids,
 * skill ids and hashes of the (identity-free) stored payloads, never a subject reference or identifier. Erasure appends
 * ONE entry to it, with counts and a hash of the erased job ids.
 */
import * as crypto from 'crypto';
import { db } from '../../db';
import { contentHash } from '../../cds/hashing';
import { TenancyError } from '../tenancy/keys';
import { AuditCtx, ensureTenantAuditReady, recordTenantEvent } from '../tenancy/audit';

export const ERASURE_REASONS = ['subject_request', 'consent_withdrawn', 'tenant_request', 'other'] as const;
export type ErasureReason = (typeof ERASURE_REASONS)[number];

export interface ErasureReceipt {
  erasureId: string; requestedAt: number; reason: ErasureReason;
  jobsErased: number; identitiesDeleted: number; payloadsDeleted: number; findingsDeleted: number; reportsDeleted: number; deliveriesScrubbed: number;
  jobIds: string[];
}

export function parseErasureRequest(body: unknown): { externalRef: string; reason: ErasureReason } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.externalRef !== 'string' || b.externalRef.length < 1 || b.externalRef.length > 128) throw new TenancyError(400, 'validation_failed', 'externalRef is required (1-128 characters).');
  if (b.confirm !== true) throw new TenancyError(400, 'confirmation_required', 'Erasure is permanent. Send "confirm": true to proceed.');
  const reason = b.reason === undefined ? 'subject_request' : b.reason;
  if (typeof reason !== 'string' || !(ERASURE_REASONS as readonly string[]).includes(reason)) throw new TenancyError(400, 'validation_failed', `reason must be one of ${ERASURE_REASONS.join(', ')}.`);
  for (const k of Object.keys(b)) if (!['externalRef', 'confirm', 'reason'].includes(k)) throw new TenancyError(400, 'validation_failed', `Unknown field "${k}".`);
  return { externalRef: b.externalRef, reason: reason as ErasureReason };
}

export async function eraseSubject(tenantId: string, externalRef: string, reason: ErasureReason, ctx: AuditCtx, now = Date.now()): Promise<ErasureReceipt> {
  await ensureTenantAuditReady();
  const erasureId = `ers_${crypto.randomBytes(12).toString('hex')}`;
  return db.transaction(async (tx) => {
    // Lock this subject's live jobs: a worker committing one of them waits for us and then finds its claim gone.
    const locked = await tx.query<{ id: string }>(`SELECT id FROM interpretation_jobs WHERE tenant_id = $1 AND subject_ref = $2 AND status <> 'erased' ORDER BY id FOR UPDATE`, [tenantId, externalRef]);
    const ids = locked.rows.map((r) => r.id);

    const del = async (table: string): Promise<number> => (await tx.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND job_id = ANY($2::text[])`, [tenantId, ids])).rowCount;
    const identitiesDeleted = ids.length ? await del('identity_vault') : 0;
    const payloadsDeleted = ids.length ? await del('source_payloads') : 0;
    const findingsDeleted = ids.length ? await del('normalized_findings') : 0;
    const reportsDeleted = ids.length ? await del('interpretation_reports') : 0; // governance output and both report layers are derived health data

    // Webhook events about these jobs: cancel what is waiting, and blank the stored bytes of all of them.
    const deliveriesScrubbed = ids.length ? (await tx.query(
      `UPDATE webhook_deliveries SET payload_json = '{"erased":true}',
         status = CASE WHEN status IN ('pending','sending') THEN 'dead' ELSE status END,
         last_error = CASE WHEN status IN ('pending','sending') THEN 'subject_erased' ELSE last_error END,
         dead_at = CASE WHEN status IN ('pending','sending') THEN $3 ELSE dead_at END,
         claim_token = NULL, lease_expires_at = NULL, updated_at = $3
       WHERE tenant_id = $1 AND job_id = ANY($2::text[])`, [tenantId, ids, now])).rowCount : 0;

    if (ids.length) {
      await tx.query(
        `UPDATE interpretation_jobs SET status = 'erased', subject_ref = 'erased', idempotency_key = NULL, request_fingerprint = $3,
           original_payload_sha256 = NULL, findings_sha256 = NULL, captured_at = 'erased', claim_token = NULL, lease_expires_at = NULL, updated_at = $4
         WHERE tenant_id = $1 AND id = ANY($2::text[])`, [tenantId, ids, '0'.repeat(64), now]);
    }

    const jobIdsSha = contentHash([...ids].sort());
    await tx.query(
      `INSERT INTO subject_erasures (id, tenant_id, requested_at, actor, reason, jobs_erased, identities_deleted, payloads_deleted, findings_deleted, reports_deleted, deliveries_scrubbed, job_ids_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [erasureId, tenantId, now, ctx.actor, reason, ids.length, identitiesDeleted, payloadsDeleted, findingsDeleted, reportsDeleted, deliveriesScrubbed, jobIdsSha]);
    // The audit entry names no subject and no identifier: only the erasure id, the reason code, counts and a hash of the job ids.
    await recordTenantEvent(tx, tenantId, ctx, 'subject.erased', {
      erasure_id: erasureId, reason, jobs_erased: ids.length, identities_deleted: identitiesDeleted, payloads_deleted: payloadsDeleted,
      findings_deleted: findingsDeleted, reports_deleted: reportsDeleted, deliveries_scrubbed: deliveriesScrubbed, job_ids_sha256: jobIdsSha,
    });
    return { erasureId, requestedAt: now, reason, jobsErased: ids.length, identitiesDeleted, payloadsDeleted, findingsDeleted, reportsDeleted, deliveriesScrubbed, jobIds: ids };
  });
}
