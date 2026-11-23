/**
 * Replacement version after a rejection (interpretation engine, P6a). A SERVICE FUNCTION called by the dashboard on behalf of
 * a clinician or administrator; there is no tenant-facing route.
 *
 * It queues a NEW version (version + 1, `supersedes_id` = the rejected one) over the SAME stored findings: the report worker then
 * re-runs governance, the narrative stage (with the tenant's CURRENT settings) and assembly, so the new version is
 * produced and reviewed exactly like the first. The rejected version stays visible to the tenant, with its rejected banner, until
 * the replacement is ready; only then does the assemble stage mark it `superseded`. If the replacement fails, the rejected version
 * is left in place and regeneration can be requested again.
 */
import * as crypto from 'crypto';
import { db } from '../../db';
import { contentHash } from '../../cds/hashing';
import { TenancyError } from '../tenancy/keys';
import { AuditCtx, ensureTenantAuditReady, recordTenantEvent } from '../tenancy/audit';

export interface RegenerateArgs { reportId: string; requestedByUserId: string; requestedByRole: 'clinician' | 'admin' }

export async function regenerateInterpretationReport(args: RegenerateArgs, now = Date.now()): Promise<{ reportId: string; version: number }> {
  await ensureTenantAuditReady();
  const ctx: AuditCtx = { actor: `${args.requestedByRole}:${args.requestedByUserId}`, declaredActor: null, requestId: null };
  return db.transaction(async (tx) => {
    const row = (await tx.query<any>('SELECT * FROM interpretation_reports WHERE id = $1 FOR UPDATE', [args.reportId])).rows[0];
    if (!row) throw new TenancyError(404, 'not_found', 'Report not found.');
    if (row.status !== 'ready' || row.review_state !== 'rejected') throw new TenancyError(409, 'not_regenerable', 'Only a rejected report can be regenerated.');
    // The newest version must be this one, or a replacement that already failed (then another attempt is allowed).
    const latest = (await tx.query<any>('SELECT id, version, status FROM interpretation_reports WHERE job_id = $1 ORDER BY version DESC LIMIT 1', [row.job_id])).rows[0];
    if (latest.id !== row.id && latest.status !== 'failed') throw new TenancyError(409, 'regeneration_in_progress', 'A replacement version already exists.');
    const job = (await tx.query<any>('SELECT status FROM interpretation_jobs WHERE id = $1 AND tenant_id = $2', [row.job_id, row.tenant_id])).rows[0];
    if (!job || job.status !== 'completed') throw new TenancyError(409, 'not_regenerable', 'The interpretation is no longer available.');
    const f = (await tx.query<any>('SELECT findings_sha256, document_json FROM normalized_findings WHERE job_id = $1 AND tenant_id = $2', [row.job_id, row.tenant_id])).rows[0];
    if (!f || f.findings_sha256 !== row.findings_sha256) throw new TenancyError(409, 'report_integrity', 'The findings are missing or changed.');
    const doc = JSON.parse(f.document_json);
    const recomputed = contentHash({ findings: doc.findings, flags: doc.flags, sourceVerification: doc.sourceVerification ?? null, notMeasurable: doc.notMeasurable ?? null, symptoms: doc.symptoms ?? null });
    if (recomputed !== row.findings_sha256) throw new TenancyError(409, 'report_integrity', 'The findings are missing or changed.');

    const id = `rpt_${crypto.randomBytes(12).toString('hex')}`; const version = Number(latest.version) + 1;
    await tx.query(
      `INSERT INTO interpretation_reports (id, job_id, tenant_id, version, supersedes_id, status, findings_sha256, run_after, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$7,$7)`, [id, row.job_id, row.tenant_id, version, row.id, row.findings_sha256, now]);
    await recordTenantEvent(tx, row.tenant_id, ctx, 'interpretation.report_regenerated', { report_id: id, supersedes_id: row.id, job_id: row.job_id, version, requested_by: args.requestedByUserId, requested_by_role: args.requestedByRole });
    return { reportId: id, version };
  });
}
