/**
 * The clinician review queue (interpretation engine, P4d/P6): what needs a clinician. Shared by the admin API and the dashboard.
 * Identifiers, hashes and reason codes only: no values, labels or subject references.
 */
import { db } from '../../db';
import { TenancyError } from '../tenancy/keys';
import type { GovernanceDoc } from '../governance/types';

export interface QueueItem {
  reportId: string; jobId: string; tenantId: string; tenantName: string | null; version: number;
  kind: 'awaiting_clinician' | 'follow_up'; reviewState: string | null;
  routeReasons: string[]; failedChecks: string[]; referralReasonCodes: string[];
  contentSha256: string | null; findingsSha256: string; readyAt: number | null;
}

export async function listReviewQueue(opts: { kind?: string; limit?: number; offset?: number }): Promise<{ items: QueueItem[]; limit: number; offset: number }> {
  const kind = opts.kind ?? 'all';
  if (!['all', 'awaiting', 'follow_up'].includes(kind)) throw new TenancyError(400, 'validation_failed', 'kind must be all, awaiting or follow_up.');
  const limit = Math.min(100, Math.max(1, opts.limit || 25));
  const offset = Math.max(0, opts.offset || 0);
  const where = kind === 'awaiting' ? `r.review_state = 'awaiting_clinician'`
    : kind === 'follow_up' ? `r.follow_up AND r.review_state IS DISTINCT FROM 'awaiting_clinician'`
      : `(r.review_state = 'awaiting_clinician' OR r.follow_up)`;
  const rows = await db.query(
    `SELECT r.id, r.job_id, r.tenant_id, t.company_name AS tenant_name, r.version, r.review_state, r.content_sha256, r.findings_sha256, r.governance_json, r.ai_review_json, r.ready_at
     FROM interpretation_reports r LEFT JOIN tenants t ON t.tenant_id = r.tenant_id
     WHERE r.status = 'ready' AND r.review_state IS DISTINCT FROM 'clinician_signed' AND r.review_state IS DISTINCT FROM 'rejected' AND ${where}
     ORDER BY (r.review_state = 'awaiting_clinician') DESC, r.ready_at ASC, r.id ASC LIMIT $1 OFFSET $2`, [limit, offset]);
  return {
    items: rows.map((r: any) => {
      const gov = JSON.parse(r.governance_json) as GovernanceDoc; const ai = r.ai_review_json ? JSON.parse(r.ai_review_json) : null;
      return {
        reportId: r.id, jobId: r.job_id, tenantId: r.tenant_id, tenantName: r.tenant_name ?? null, version: Number(r.version),
        kind: r.review_state === 'awaiting_clinician' ? 'awaiting_clinician' as const : 'follow_up' as const, reviewState: r.review_state,
        routeReasons: gov.route.reasons, failedChecks: ai?.failedChecks ?? [], referralReasonCodes: [...new Set((gov.referral?.reasons ?? []).map((x) => x.code))],
        contentSha256: r.content_sha256, findingsSha256: r.findings_sha256, readyAt: r.ready_at === null ? null : Number(r.ready_at),
      };
    }),
    limit, offset,
  };
}
