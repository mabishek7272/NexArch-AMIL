/**
 * Timeline and comparison for clinicians (interpretation engine, P6d), behind the dashboard session. The same neutral,
 * deterministic logic as the tenant API (`longitudinal/service.ts`), addressed by job id. These views show finding values, so
 * they are for an ACTIVE clinician only (like opening a report), and each view is audited (ids only, never content).
 *
 *   GET /scans/:jobId?skillId&findingKey&limit    the subject's scans (oldest first) + the finding keys of this scan; with findingKey, its series
 *   GET /compare?a=<jobId>&b=<jobId>              longitudinal-comparison/v1 of two scans of the same subject and skill
 */
import { Router, Response } from 'express';
import { requireDashAuth, AuthRequest } from '../auth';
import { hasActiveClinicianCredential } from '../clinicians';
import { db } from '../../../db';
import { logger } from '../../../logger';
import { TenancyError } from '../../../interpretation/tenancy/keys';
import { AuditCtx, ensureTenantAuditReady, recordTenantEvent } from '../../../interpretation/tenancy/audit';
import { compareJobs, timelineFor } from '../../../interpretation/longitudinal/service';
import { validateLongitudinalComparison } from '../../../interpretation/contracts/validate';
import type { FindingsDoc } from '../../../interpretation/governance/types';

const router = Router();
const JOB_ID = /^job_[0-9a-f]{24}$/;

function wrap(fn: (req: AuthRequest, res: Response) => Promise<unknown>) {
  return [requireDashAuth, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      if (req.user?.role !== 'clinician' || !(await hasActiveClinicianCredential(req.user.id))) throw new TenancyError(403, 'clinician_required', 'A provisioned licensed clinician is required for this action.');
      res.setHeader('Cache-Control', 'no-store');
      res.json(await fn(req, res));
    } catch (e) {
      if (e instanceof TenancyError) { res.status(e.status).json({ error: e.message, code: e.code }); return; }
      logger.error('anukla longitudinal route failed');
      if (!res.headersSent) res.status(500).json({ error: 'Internal error.', code: 'internal_error' });
    }
  }];
}

async function tenantOf(jobId: string): Promise<string> {
  if (!JOB_ID.test(jobId)) throw new TenancyError(404, 'not_found', 'Interpretation not found.');
  const j = await db.queryOne<{ tenant_id: string }>('SELECT tenant_id FROM interpretation_jobs WHERE id = $1', [jobId]);
  if (!j) throw new TenancyError(404, 'not_found', 'Interpretation not found.');
  return j.tenant_id;
}

async function audit(req: AuthRequest, tenantId: string, type: string, data: Record<string, unknown>): Promise<void> {
  await ensureTenantAuditReady();
  const ctx: AuditCtx = { actor: `clinician:${req.user!.id}`, declaredActor: null, requestId: null };
  await db.transaction(async (tx) => { await recordTenantEvent(tx, tenantId, ctx, type, { ...data, viewer_user_id: req.user!.id }); });
}

router.get('/scans/:jobId', ...wrap(async (req) => {
  const jobId = String(req.params.jobId); const tenantId = await tenantOf(jobId);
  const limit = req.query.limit === undefined ? undefined : Number.parseInt(String(req.query.limit), 10);
  if (limit !== undefined && !(limit >= 1)) throw new TenancyError(400, 'validation_failed', 'limit must be a positive integer.');
  const str = (k: string) => (typeof req.query[k] === 'string' && req.query[k] !== '' ? String(req.query[k]) : undefined);
  const timeline = await timelineFor(tenantId, jobId, { skillId: str('skillId'), findingKey: str('findingKey'), limit });
  // The finding keys and labels of THIS scan, so the viewer can choose one to follow (no values).
  const row = await db.queryOne<{ document_json: string }>('SELECT document_json FROM normalized_findings WHERE job_id = $1 AND tenant_id = $2', [jobId, tenantId]);
  const findingKeys = row ? (JSON.parse(row.document_json) as FindingsDoc).findings.filter((f) => !f.excluded).map((f) => ({ key: f.findingKey, label: f.label, unit: f.unit ?? null })) : [];
  await audit(req, tenantId, 'interpretation.timeline_viewed', { job_id: jobId, finding_key: timeline.series?.findingKey ?? null });
  return { ...timeline, findingKeys };
}));

router.get('/compare', ...wrap(async (req) => {
  const a = String(req.query.a ?? ''), b = String(req.query.b ?? '');
  const tenantId = await tenantOf(a);
  const doc = await compareJobs(tenantId, a, b);
  const v = validateLongitudinalComparison(doc);
  if (!v.ok) { logger.error('dashboard comparison failed longitudinal-comparison/v1'); throw new TenancyError(500, 'internal_error', 'Internal error.'); }
  await audit(req, tenantId, 'interpretation.compare_viewed', { job_ids: [a, b], comparison_sha256: doc.comparisonSha256 });
  return doc;
}));

export default router;
