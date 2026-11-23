/**
 * Clinician review module (interpretation engine, P6a). Dashboard API behind cookie auth; the only HTTP path to the
 * sign-off service, and only for a logged-in clinician with an ACTIVE provisioning record.
 *
 *   GET  /queue?kind=all|awaiting|follow_up      clinician or admin: what needs review (ids, hashes, reason codes)
 *   GET  /reports/:id                            clinician: both layers, governance summary, automatic review, version history
 *   GET  /reports/:id/html?layer=clinical|layman clinician: the rendered page (sandboxed in an iframe by the client)
 *   POST /reports/:id/sign                       clinician: { contentSha256, attested: true, password }
 *   POST /reports/:id/reject                     clinician: { contentSha256, reason, password }
 *   POST /reports/:id/regenerate                 clinician or admin: new version over the same findings, after a rejection
 *
 * Signing and rejecting need the clinician's password again (verified here, throttled per account) and an explicit attestation;
 * the content hash they viewed travels with the request, so a report cannot change between viewing and signing. The service
 * re-verifies the clinician in the database. Viewing patient content is itself audited (ids only, never content).
 */
import { Router, Response } from 'express';
import { requireDashAuth, AuthRequest } from '../auth';
import { hasActiveClinicianCredential } from '../clinicians';
import { db } from '../../../db';
import { logger } from '../../../logger';
import { FixedWindowLimiter } from '../../../security/throttle';
import { verifyPassword, dummyVerify, MAX_PASSWORD_LENGTH } from '../../../security/password';
import { TenancyError } from '../../../interpretation/tenancy/keys';
import { AuditCtx, ensureTenantAuditReady, recordTenantEvent } from '../../../interpretation/tenancy/audit';
import { listReviewQueue } from '../../../interpretation/reports/review-queue';
import { signInterpretationReport, rejectInterpretationReport } from '../../../interpretation/reports/signoff';
import { regenerateInterpretationReport } from '../../../interpretation/reports/regenerate';
import { renderReportHtml, bannerFor, type ReviewState } from '../../../interpretation/reports/render';
import { getBranding } from '../../../interpretation/reports/branding';
import type { ReportLayerDoc } from '../../../interpretation/reports/assemble';
import type { GovernanceDoc } from '../../../interpretation/governance/types';
import { contentHash } from '../../../cds/hashing';

const router = Router();
const ID_RE = /^rpt_[0-9a-f]{24}$/;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_PASSWORD_FAILURES = Number(process.env.ANUCLAW_SIGNOFF_MAX_PASSWORD_FAILURES ?? 5);
export const signoffPasswordFailures = new FixedWindowLimiter(FAIL_WINDOW_MS);

type Handler = (req: AuthRequest, res: Response) => Promise<void>;
function wrap(fn: Handler) {
  return async (req: AuthRequest, res: Response): Promise<void> => {
    try { await fn(req, res); } catch (e) {
      if (e instanceof TenancyError) { res.status(e.status).json({ error: e.message, code: e.code }); return; }
      logger.error('anukla review route failed'); // never log the error text: it can echo report content
      if (!res.headersSent) res.status(500).json({ error: 'Internal error.', code: 'internal_error' });
    }
  };
}

const isClinician = (req: AuthRequest) => req.user?.role === 'clinician';
async function requireClinician(req: AuthRequest): Promise<void> {
  if (!isClinician(req) || !(await hasActiveClinicianCredential(req.user!.id))) throw new TenancyError(403, 'clinician_required', 'A provisioned licensed clinician is required for this action.');
}
async function requireReviewerOrAdmin(req: AuthRequest): Promise<'clinician' | 'admin'> {
  if (req.user?.role === 'admin') return 'admin';
  await requireClinician(req); return 'clinician';
}
function reportId(req: AuthRequest): string {
  const id = String(req.params.id);
  if (!ID_RE.test(id)) throw new TenancyError(404, 'not_found', 'Report not found.');
  return id;
}
const ctxFor = (req: AuthRequest): AuditCtx => ({ actor: `clinician:${req.user!.id}`, declaredActor: null, requestId: null });

/** The signed-in user's password, checked again for a signing action. Answered with 403 (not 401) so the client never mistakes it for an expired session and retries. Throttled per account; failures are counted, successes reset. */
async function confirmPassword(req: AuthRequest, password: unknown): Promise<void> {
  const key = `signoff|${req.user!.id}`;
  if (signoffPasswordFailures.peek(key) >= MAX_PASSWORD_FAILURES) throw new TenancyError(429, 'rate_limited', 'Too many incorrect passwords. Try again later.');
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH) throw new TenancyError(400, 'validation_failed', 'Your password is required to confirm.');
  const row = await db.queryOne<{ password_hash: string | null }>('SELECT password_hash FROM dash_users WHERE id = $1', [req.user!.id]);
  const v = row ? await verifyPassword(password, row.password_hash) : (await dummyVerify(), { ok: false });
  if (!v.ok) { signoffPasswordFailures.hit(key, Number.MAX_SAFE_INTEGER); throw new TenancyError(403, 'password_incorrect', 'The password is incorrect.'); }
  signoffPasswordFailures.reset(key);
}

async function loadReport(id: string): Promise<any> {
  const row = await db.queryOne<any>('SELECT r.*, t.company_name AS tenant_name FROM interpretation_reports r LEFT JOIN tenants t ON t.tenant_id = r.tenant_id WHERE r.id = $1', [id]);
  if (!row) throw new TenancyError(404, 'not_found', 'Report not found.');
  if (!row.clinical_json || !row.layman_json) throw new TenancyError(409, 'not_ready', `The report is not ready (${row.status}).`);
  return row;
}

async function auditView(req: AuthRequest, row: any, what: string): Promise<void> {
  await ensureTenantAuditReady();
  await db.transaction(async (tx) => { await recordTenantEvent(tx, row.tenant_id, ctxFor(req), 'interpretation.report_viewed', { report_id: row.id, job_id: row.job_id, version: Number(row.version), viewer_user_id: req.user!.id, view: what }); });
}

router.get('/queue', requireDashAuth, wrap(async (req, res) => {
  await requireReviewerOrAdmin(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await listReviewQueue({ kind: String(req.query.kind ?? 'all'), limit: Number.parseInt(String(req.query.limit ?? '25'), 10), offset: Number.parseInt(String(req.query.offset ?? '0'), 10) }));
}));

router.get('/reports/:id', requireDashAuth, wrap(async (req, res) => {
  await requireClinician(req);
  const row = await loadReport(reportId(req));
  const gov = JSON.parse(row.governance_json) as GovernanceDoc;
  const clinical = JSON.parse(row.clinical_json) as ReportLayerDoc; const layman = JSON.parse(row.layman_json) as ReportLayerDoc;
  const history = await db.query('SELECT id, version, status, review_state, reviewed_by, reviewed_at FROM interpretation_reports WHERE job_id = $1 ORDER BY version DESC', [row.job_id]);
  const latest = history[0];
  const reviewable = row.status === 'ready' && latest.id === row.id && row.review_state !== 'clinician_signed' && row.review_state !== 'rejected';
  await auditView(req, row, 'report');
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    report: {
      id: row.id, jobId: row.job_id, tenantId: row.tenant_id, tenantName: row.tenant_name ?? null, version: Number(row.version), status: row.status,
      reviewState: row.review_state ?? null, reviewedBy: row.reviewed_by ?? null, reviewedAt: row.reviewed_at === null ? null : Number(row.reviewed_at),
      rejectionReason: row.review_state === 'rejected' ? row.rejection_reason : null, readyAt: row.ready_at === null ? null : Number(row.ready_at),
      narrativeMode: row.narrative_mode, modelRequested: row.model_requested, modelReturned: row.model_returned, findingsSha256: row.findings_sha256,
      contentSha256: contentHash({ clinical, layman }), banner: bannerFor({ state: (row.review_state ?? null) as ReviewState, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at === null ? null : Number(row.reviewed_at) }).text,
    },
    governance: { routeState: gov.route.state, routeReasons: gov.route.reasons, followUp: gov.route.followUp, referralReasonCodes: [...new Set((gov.referral?.reasons ?? []).map((x) => x.code))], flags: gov.flags.map((f) => ({ type: f.type, severity: f.severity, detail: f.detail })) },
    aiReview: row.ai_review_json ? JSON.parse(row.ai_review_json) : null,
    clinical, layman,
    history: history.map((h: any) => ({ id: h.id, version: Number(h.version), status: h.status, reviewState: h.review_state ?? null, reviewedBy: h.reviewed_by ?? null, reviewedAt: h.reviewed_at === null ? null : Number(h.reviewed_at) })),
    actions: { canSign: reviewable, canReject: reviewable, canRegenerate: row.status === 'ready' && row.review_state === 'rejected' && ['ready', 'failed'].includes(latest.status) },
  });
}));

router.get('/reports/:id/html', requireDashAuth, wrap(async (req, res) => {
  await requireClinician(req);
  const layer = String(req.query.layer ?? '');
  if (layer !== 'clinical' && layer !== 'layman') throw new TenancyError(400, 'validation_failed', 'layer must be "clinical" or "layman".');
  const row = await loadReport(reportId(req));
  const doc = JSON.parse(layer === 'clinical' ? row.clinical_json : row.layman_json) as ReportLayerDoc;
  await auditView(req, row, `html:${layer}`);
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
  res.send(renderReportHtml(doc, { state: (row.review_state ?? null) as ReviewState, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at === null ? null : Number(row.reviewed_at) }, await getBranding(row.tenant_id)));
}));

router.post('/reports/:id/sign', requireDashAuth, wrap(async (req, res) => {
  await requireClinician(req);
  const id = reportId(req); const b = (req.body ?? {}) as Record<string, unknown>;
  if (b.attested !== true) throw new TenancyError(400, 'attestation_required', 'Confirm that you reviewed this exact version.');
  await confirmPassword(req, b.password);
  res.json(await signInterpretationReport({ reportId: id, clinicianUserId: req.user!.id, contentSha256: b.contentSha256 as string }));
}));

router.post('/reports/:id/reject', requireDashAuth, wrap(async (req, res) => {
  await requireClinician(req);
  const id = reportId(req); const b = (req.body ?? {}) as Record<string, unknown>;
  await confirmPassword(req, b.password);
  res.json(await rejectInterpretationReport({ reportId: id, clinicianUserId: req.user!.id, reason: b.reason as string, contentSha256: b.contentSha256 as string }));
}));

router.post('/reports/:id/regenerate', requireDashAuth, wrap(async (req, res) => {
  const role = await requireReviewerOrAdmin(req);
  res.status(202).json(await regenerateInterpretationReport({ reportId: reportId(req), requestedByUserId: req.user!.id, requestedByRole: role }));
}));

export default router;
