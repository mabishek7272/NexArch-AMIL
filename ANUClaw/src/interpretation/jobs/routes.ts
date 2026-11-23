/**
 * Tenant-facing interpretation API (interpretation engine, P3a), mounted next to the BaaS /v1 router.
 *
 *   POST /v1/interpretations                 202 + Location; Idempotency-Key honoured (database-enforced)
 *   GET  /v1/interpretations                 the caller's jobs (limit/offset)
 *   GET  /v1/interpretations/:id             status
 *   GET  /v1/interpretations/:id/findings    normalized findings once completed (410 once erased)
 *   POST /v1/subject-erasures                permanently erase one subject's data (needs "confirm": true)
 *   GET  /v1/subject-erasures                this tenant's erasure receipts
 *
 * Submitting is metered against the monthly quota; polling (GET) is rate-limited but NOT counted against it.
 * Every lookup is scoped by tenant_id in SQL, so another tenant's job is a 404, never a 403.
 */
import * as crypto from 'crypto';
import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../../api/middleware/auth';
import { perTenantRateLimit, quotaCheck } from '../../api/middleware/rate-limit';
import { usageMeter } from '../../api/middleware/usage-meter';
import { db } from '../../db';
import { logger } from '../../logger';
import { TenancyError } from '../tenancy/keys';
import type { AuditCtx } from '../tenancy/audit';
import { registerBuiltinAdapters } from '../adapters';
import { acceptInterpretation, toJobView } from './intake';
import { eraseSubject, parseErasureRequest } from './erasure';

const router = Router();
registerBuiltinAdapters();

const submitGuards = [requireAuth, perTenantRateLimit, quotaCheck, usageMeter];
const readGuards = [requireAuth, perTenantRateLimit];
const ID_RE = /^job_[0-9a-f]{24}$/;

function handler(fn: (req: AuthRequest, res: Response, ctx: AuditCtx) => Promise<void>) {
  return async (req: AuthRequest, res: Response): Promise<void> => {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const ctx: AuditCtx = { actor: `tenant:${req.tenant!.tenant_id}`, declaredActor: null, requestId };
    try { await fn(req, res, ctx); } catch (e) {
      if (e instanceof TenancyError) {
        res.status(e.status).json({ error: { code: e.code, message: e.message, requestId, ...(e.details ? { details: e.details } : {}) } });
        return;
      }
      logger.error(`interpretation route failed [${requestId}]`); // never log the error text: it can echo payload values
      if (!res.headersSent) res.status(500).json({ error: { code: 'internal_error', message: 'Internal error.', requestId } });
    }
  };
}

function jobId(req: AuthRequest): string {
  const id = String(req.params.id);
  if (!ID_RE.test(id)) throw new TenancyError(404, 'not_found', 'Interpretation not found.');
  return id;
}

router.post('/v1/interpretations', ...submitGuards, handler(async (req, res, ctx) => {
  const out = await acceptInterpretation(req.tenant!, req.body, req.header('idempotency-key'), ctx);
  res.setHeader('Location', `/v1/interpretations/${out.job.id}`);
  if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
  res.status(out.replayed ? 200 : 202).json(out.job);
}));

router.get('/v1/interpretations', ...readGuards, handler(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? '25'), 10) || 25));
  const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0);
  const rows = await db.query('SELECT * FROM interpretation_jobs WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3', [req.tenant!.tenant_id, limit, offset]);
  res.json({ items: rows.map(toJobView), limit, offset });
}));

router.get('/v1/interpretations/:id', ...readGuards, handler(async (req, res) => {
  const row = await db.queryOne('SELECT * FROM interpretation_jobs WHERE id = $1 AND tenant_id = $2', [jobId(req), req.tenant!.tenant_id]);
  if (!row) throw new TenancyError(404, 'not_found', 'Interpretation not found.');
  res.json(toJobView(row));
}));

router.get('/v1/interpretations/:id/findings', ...readGuards, handler(async (req, res) => {
  const id = jobId(req);
  const job = await db.queryOne('SELECT status FROM interpretation_jobs WHERE id = $1 AND tenant_id = $2', [id, req.tenant!.tenant_id]);
  if (!job) throw new TenancyError(404, 'not_found', 'Interpretation not found.');
  if (job.status === 'erased') throw new TenancyError(410, 'subject_erased', 'The data for this interpretation was erased.');
  const row = await db.queryOne<{ document_json: string }>('SELECT document_json FROM normalized_findings WHERE job_id = $1 AND tenant_id = $2', [id, req.tenant!.tenant_id]);
  if (!row) throw new TenancyError(409, 'findings_not_ready', `Findings are not available while the job is ${job.status}.`);
  res.json(JSON.parse(row.document_json));
}));

// Erasure is not metered (a data-subject request must never be refused for quota) but is rate-limited.
router.post('/v1/subject-erasures', ...readGuards, handler(async (req, res, ctx) => {
  const { externalRef, reason } = parseErasureRequest(req.body);
  const receipt = await eraseSubject(req.tenant!.tenant_id, externalRef, reason, ctx);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(receipt);
}));

router.get('/v1/subject-erasures', ...readGuards, handler(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? '25'), 10) || 25));
  const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0);
  const rows = await db.query('SELECT * FROM subject_erasures WHERE tenant_id = $1 ORDER BY requested_at DESC, id DESC LIMIT $2 OFFSET $3', [req.tenant!.tenant_id, limit, offset]);
  res.json({
    items: rows.map((r: any) => ({
      erasureId: r.id, requestedAt: Number(r.requested_at), reason: r.reason, jobsErased: Number(r.jobs_erased), identitiesDeleted: Number(r.identities_deleted),
      payloadsDeleted: Number(r.payloads_deleted), findingsDeleted: Number(r.findings_deleted), reportsDeleted: Number(r.reports_deleted), deliveriesScrubbed: Number(r.deliveries_scrubbed), jobIdsSha256: r.job_ids_sha256,
    })),
    limit, offset,
  });
}));

export function listInterpretationRoutes(): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const layer of (router as any).stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: layer.route.path });
  }
  return out;
}

export default router;
