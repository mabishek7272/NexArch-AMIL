/**
 * Report endpoints (interpretation engine, P4c), mounted next to the other /v1 routes. Read-only.
 *
 *   GET /v1/interpretations/:id/reports                              versions with status and review state (no content)
 *   GET /v1/interpretations/:id/report?layer=clinical|layman&format=json|html|pdf   the current ready version
 *
 * Tenant-scoped in SQL (another tenant's job is a 404), 410 once the subject was erased, 409 until a report is ready.
 * HTML is served with a locked-down Content-Security-Policy; a PDF that cannot be rendered answers 503 and HTML still works.
 */
import * as crypto from 'crypto';
import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../../api/middleware/auth';
import { perTenantRateLimit } from '../../api/middleware/rate-limit';
import { db } from '../../db';
import { logger } from '../../logger';
import { contentHash } from '../../cds/hashing';
import { TenancyError } from '../tenancy/keys';
import type { ReportLayerDoc } from './assemble';
import { getBranding } from './branding';
import { PdfUnavailable, renderPdf } from './pdf';
import { bannerFor, renderReportHtml, type ReviewInfo, type ReviewState } from './render';

const router = Router();
const ID_RE = /^job_[0-9a-f]{24}$/;
const guards = [requireAuth, perTenantRateLimit];

function handler(fn: (req: AuthRequest, res: Response) => Promise<void>) {
  return async (req: AuthRequest, res: Response): Promise<void> => {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    try { await fn(req, res); } catch (e) {
      if (e instanceof TenancyError) { res.status(e.status).json({ error: { code: e.code, message: e.message, requestId, ...(e.details ? { details: e.details } : {}) } }); return; }
      logger.error(`report route failed [${requestId}]`);
      if (!res.headersSent) res.status(500).json({ error: { code: 'internal_error', message: 'Internal error.', requestId } });
    }
  };
}

async function jobFor(req: AuthRequest): Promise<{ id: string; status: string }> {
  const id = String(req.params.id);
  if (!ID_RE.test(id)) throw new TenancyError(404, 'not_found', 'Interpretation not found.');
  const job = await db.queryOne<{ status: string }>('SELECT status FROM interpretation_jobs WHERE id = $1 AND tenant_id = $2', [id, req.tenant!.tenant_id]);
  if (!job) throw new TenancyError(404, 'not_found', 'Interpretation not found.');
  if (job.status === 'erased') throw new TenancyError(410, 'subject_erased', 'The data for this interpretation was erased.');
  return { id, status: job.status };
}

router.get('/v1/interpretations/:id/reports', ...guards, handler(async (req, res) => {
  const { id } = await jobFor(req);
  const rows = await db.query('SELECT id, version, supersedes_id, status, review_state, reviewed_by, reviewed_at, narrative_mode, findings_sha256, created_at, ready_at, error_code FROM interpretation_reports WHERE job_id = $1 AND tenant_id = $2 ORDER BY version DESC', [id, req.tenant!.tenant_id]);
  res.json({ items: rows.map((r: any) => ({ reportId: r.id, version: Number(r.version), supersedesId: r.supersedes_id ?? null, status: r.status, reviewState: r.review_state ?? null, ...(r.review_state === 'clinician_signed' || r.review_state === 'rejected' ? { reviewedBy: r.reviewed_by, reviewedAt: Number(r.reviewed_at) } : {}), narrativeMode: r.narrative_mode ?? null, findingsSha256: r.findings_sha256, createdAt: Number(r.created_at), readyAt: r.ready_at === null ? null : Number(r.ready_at), ...(r.status === 'failed' ? { errorCode: r.error_code } : {}) })) });
}));

router.get('/v1/interpretations/:id/report', ...guards, handler(async (req, res) => {
  const { id, status: jobStatus } = await jobFor(req);
  const layer = String(req.query.layer ?? '');
  if (layer !== 'clinical' && layer !== 'layman') throw new TenancyError(400, 'validation_failed', 'layer must be "clinical" or "layman".');
  const format = String(req.query.format ?? 'json');
  if (!['json', 'html', 'pdf'].includes(format)) throw new TenancyError(400, 'validation_failed', 'format must be json, html or pdf.');

  const row = await db.queryOne<any>(
    `SELECT id, version, status, review_state, reviewed_by, reviewed_at, rejection_reason, clinical_json, layman_json FROM interpretation_reports
     WHERE job_id = $1 AND tenant_id = $2 AND status = 'ready' ORDER BY version DESC LIMIT 1`, [id, req.tenant!.tenant_id]);
  if (!row) {
    const any = await db.queryOne<{ status: string }>('SELECT status FROM interpretation_reports WHERE job_id = $1 AND tenant_id = $2 ORDER BY version DESC LIMIT 1', [id, req.tenant!.tenant_id]);
    if (!any) {
      if (jobStatus === 'queued' || jobStatus === 'processing') throw new TenancyError(409, 'report_not_ready', `The report is not ready (the job is ${jobStatus}).`);
      throw new TenancyError(404, 'no_report', 'This interpretation has no report.');
    }
    throw new TenancyError(409, 'report_not_ready', `The report is not ready (${any.status}).`);
  }
  const clinical = JSON.parse(row.clinical_json) as ReportLayerDoc; const laymanDoc = JSON.parse(row.layman_json) as ReportLayerDoc;
  const doc = layer === 'clinical' ? clinical : laymanDoc;
  const review: ReviewInfo = { state: (row.review_state ?? null) as ReviewState, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at === null ? null : Number(row.reviewed_at), rejectionReason: row.rejection_reason };

  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  if (format === 'json') {
    res.json({ reportId: row.id, version: Number(row.version), layer, reviewState: review.state, statusBanner: bannerFor(review).text, contentSha256: contentHash({ clinical, layman: laymanDoc }), report: doc });
    return;
  }
  const html = renderReportHtml(doc, review, await getBranding(req.tenant!.tenant_id));
  if (format === 'html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.send(html);
    return;
  }
  try {
    const pdf = await renderPdf(html, bannerFor(review).text, `Report ${row.id} v${row.version} · findings ${doc.traceability.findingsSha256.slice(0, 12)}`);
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="report-${id}-${layer}.pdf"`);
    res.send(pdf);
  } catch (e) {
    if (e instanceof PdfUnavailable) throw new TenancyError(503, 'pdf_renderer_unavailable', 'PDF rendering is not available right now. Request format=html instead.');
    throw e;
  }
}));

export function listReportRoutes(): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const layer of (router as any).stack) { if (!layer.route) continue; for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: layer.route.path }); }
  return out;
}
export default router;
