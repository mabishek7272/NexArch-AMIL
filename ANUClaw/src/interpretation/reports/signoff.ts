/**
 * Clinician sign-off (interpretation engine, P4d). A SERVICE FUNCTION, deliberately with no HTTP route: nothing in the
 * tenant API, the admin API or the AI pipeline can sign. The dashboard (P6) is expected to call it on behalf of a logged-in
 * clinician. It does not trust its caller: it re-checks in the database, inside the transaction, that the user is a
 * `clinician` with an ACTIVE provisioning record (the same rule as `requireActiveClinician`).
 *
 * Signing never edits the reviewed report. It creates a NEW version (supersede-not-overwrite) that carries identical content
 * and the clinician's name, time and the SHA-256 of exactly what was signed; the reviewed version becomes `superseded`. The
 * caller must pass the content hash the clinician actually looked at, so a report cannot change between viewing and signing.
 * The database refuses `clinician_signed` without a signer, a time and that hash, and refuses to alter a sign-off afterwards.
 *
 * Rejection records the clinician and a reason on the reviewed version itself (the content is untouched); the tenant sees the
 * "rejected" banner and an `interpretation.report_rejected` event. A replacement version is a separate, later step.
 */
import * as crypto from 'crypto';
import { db } from '../../db';
import { contentHash } from '../../cds/hashing';
import { TenancyError } from '../tenancy/keys';
import { AuditCtx, ensureTenantAuditReady, recordTenantEvent } from '../tenancy/audit';
import { enqueueReportEvent } from '../webhooks/outbox';
import type { TxClient } from '../../db';

export interface SignArgs { reportId: string; clinicianUserId: string; /** the content hash the clinician reviewed (as served by the report endpoint) */ contentSha256: string }
export interface RejectArgs { reportId: string; clinicianUserId: string; reason: string; contentSha256: string }
export interface ReviewOutcome { reportId: string; version: number; reviewState: 'clinician_signed' | 'rejected' }

const SHA_RE = /^[0-9a-f]{64}$/;
const actor = (userId: string): AuditCtx => ({ actor: `clinician:${userId}`, declaredActor: null, requestId: null });

async function requireClinician(tx: TxClient, userId: string): Promise<{ id: string; displayName: string }> {
  if (typeof userId !== 'string' || !userId) throw new TenancyError(403, 'clinician_required', 'A provisioned licensed clinician is required.');
  const r = await tx.query<{ id: string; name: string | null; email: string }>(
    `SELECT u.id, u.name, u.email FROM dash_users u JOIN clinician_credentials c ON c.user_id = u.id WHERE u.id = $1 AND u.role = 'clinician' AND c.status = 'active' LIMIT 1`, [userId]);
  const u = r.rows[0];
  if (!u) throw new TenancyError(403, 'clinician_required', 'A provisioned licensed clinician is required.');
  return { id: u.id, displayName: (u.name?.trim() || u.email).slice(0, 100) };
}

/** Locks the report and checks it can be reviewed now: ready, the newest version, not already signed or rejected, and exactly the content that was viewed. */
async function lockReviewable(tx: TxClient, reportId: string, contentSha256: string): Promise<any> {
  if (typeof contentSha256 !== 'string' || !SHA_RE.test(contentSha256)) throw new TenancyError(400, 'validation_failed', 'contentSha256 (the hash of the content that was reviewed) is required.');
  const row = (await tx.query<any>('SELECT * FROM interpretation_reports WHERE id = $1 FOR UPDATE', [reportId])).rows[0];
  if (!row) throw new TenancyError(404, 'not_found', 'Report not found.');
  if (row.status !== 'ready') throw new TenancyError(409, 'not_reviewable', `Only a ready report can be reviewed (status: ${row.status}).`);
  if (row.review_state === 'clinician_signed' || row.review_state === 'rejected') throw new TenancyError(409, 'already_reviewed', `This version is already ${row.review_state === 'rejected' ? 'rejected' : 'signed'}.`);
  const newer = await tx.query('SELECT 1 FROM interpretation_reports WHERE job_id = $1 AND version > $2 LIMIT 1', [row.job_id, row.version]);
  if (newer.rows.length) throw new TenancyError(409, 'not_latest_version', 'A newer version exists; review that one.');
  // Integrity: the stored content must still hash to what the clinician saw, and still belong to the stored findings.
  if (!row.clinical_json || !row.layman_json) throw new TenancyError(409, 'not_reviewable', 'The report has no content.');
  const clinical = JSON.parse(row.clinical_json); const layman = JSON.parse(row.layman_json);
  const actual = contentHash({ clinical, layman });
  if (actual !== contentSha256) throw new TenancyError(409, 'content_changed', 'The report content is not what was reviewed.');
  if (clinical.traceability?.findingsSha256 !== row.findings_sha256 || layman.traceability?.findingsSha256 !== row.findings_sha256) throw new TenancyError(409, 'report_integrity', 'The report does not match its findings.');
  const f = (await tx.query<{ findings_sha256: string }>('SELECT findings_sha256 FROM normalized_findings WHERE job_id = $1 AND tenant_id = $2', [row.job_id, row.tenant_id])).rows[0];
  if (!f || f.findings_sha256 !== row.findings_sha256) throw new TenancyError(409, 'report_integrity', 'The findings are missing or changed.');
  return { row, contentSha256: actual };
}

export async function signInterpretationReport(args: SignArgs, now = Date.now()): Promise<ReviewOutcome> {
  await ensureTenantAuditReady();
  return db.transaction(async (tx) => {
    const clin = await requireClinician(tx, args.clinicianUserId);
    const { row, contentSha256 } = await lockReviewable(tx, args.reportId, args.contentSha256);
    const id = `rpt_${crypto.randomBytes(12).toString('hex')}`; const version = Number(row.version) + 1;
    await tx.query(
      `INSERT INTO interpretation_reports (id, job_id, tenant_id, version, supersedes_id, status, attempts, max_attempts, run_after, findings_sha256, governance_json, governance_sha256, narrative_json,
         clinical_json, layman_json, narrative_mode, model_requested, model_returned, prompt_versions_json, guard_results_json, ai_review_json, follow_up, content_sha256,
         review_state, reviewed_by, reviewer_user_id, reviewed_at, signed_content_sha256, created_at, updated_at, ready_at)
       VALUES ($1,$2,$3,$4,$5,'ready',0,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'clinician_signed',$22,$23,$7,$21,$7,$7,$7)`,
      [id, row.job_id, row.tenant_id, version, row.id, row.max_attempts, now, row.findings_sha256, row.governance_json, row.governance_sha256, row.narrative_json,
        row.clinical_json, row.layman_json, row.narrative_mode, row.model_requested, row.model_returned, row.prompt_versions_json, row.guard_results_json, row.ai_review_json, row.follow_up, contentSha256, clin.displayName, clin.id]);
    await tx.query(`UPDATE interpretation_reports SET status = 'superseded', updated_at = $2 WHERE id = $1`, [row.id, now]);
    await recordTenantEvent(tx, row.tenant_id, actor(clin.id), 'interpretation.report_signed', { report_id: id, supersedes_id: row.id, job_id: row.job_id, version, previous_review_state: row.review_state, signed_content_sha256: contentSha256, signer_user_id: clin.id });
    await enqueueReportEvent(tx, row.tenant_id, 'interpretation.report_ready', { jobId: row.job_id, reportId: id, version, findingsSha256: row.findings_sha256, reviewState: 'clinician_signed' }, now);
    return { reportId: id, version, reviewState: 'clinician_signed' as const };
  });
}

export async function rejectInterpretationReport(args: RejectArgs, now = Date.now()): Promise<ReviewOutcome> {
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (reason.length < 1 || reason.length > 500) throw new TenancyError(400, 'validation_failed', 'A reason of 1-500 characters is required.');
  await ensureTenantAuditReady();
  return db.transaction(async (tx) => {
    const clin = await requireClinician(tx, args.clinicianUserId);
    const { row } = await lockReviewable(tx, args.reportId, args.contentSha256);
    await tx.query(`UPDATE interpretation_reports SET review_state = 'rejected', reviewed_by = $2, reviewer_user_id = $3, reviewed_at = $4, rejection_reason = $5, updated_at = $4 WHERE id = $1`, [row.id, clin.displayName, clin.id, now, reason]);
    // The reason is free text and may mention the case: the audit entry records only that one exists, and its length.
    await recordTenantEvent(tx, row.tenant_id, actor(clin.id), 'interpretation.report_rejected', { report_id: row.id, job_id: row.job_id, version: Number(row.version), previous_review_state: row.review_state, reason_length: reason.length, reviewer_user_id: clin.id });
    await enqueueReportEvent(tx, row.tenant_id, 'interpretation.report_rejected', { jobId: row.job_id, reportId: row.id, version: Number(row.version), findingsSha256: row.findings_sha256, reviewState: 'rejected' }, now);
    return { reportId: row.id, version: Number(row.version), reviewState: 'rejected' as const };
  });
}
