/**
 * Longitudinal endpoints (interpretation engine, P5), tenant-scoped and read-only, rate-limited but not counted against the quota.
 * No subject reference ever appears in a URL or a response: scans are addressed by job id, and "the same subject" is resolved
 * server-side.
 *
 *   GET /v1/interpretations/:id/timeline?skillId=&findingKey=&limit=   the subject's scans (oldest first) and, with findingKey, that finding's series
 *   GET /v1/interpretations/:id/compare?with=<jobId>                  neutral comparison of two scans of the same subject
 */
import * as crypto from 'crypto';
import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../../api/middleware/auth';
import { perTenantRateLimit } from '../../api/middleware/rate-limit';
import { logger } from '../../logger';
import { TenancyError } from '../tenancy/keys';
import { validateLongitudinalComparison } from '../contracts/validate';
import { compareJobs, timelineFor } from './service';

const router = Router();
const guards = [requireAuth, perTenantRateLimit];

function handler(fn: (req: AuthRequest, res: Response) => Promise<void>) {
  return async (req: AuthRequest, res: Response): Promise<void> => {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    try { await fn(req, res); } catch (e) {
      if (e instanceof TenancyError) { res.status(e.status).json({ error: { code: e.code, message: e.message, requestId, ...(e.details ? { details: e.details } : {}) } }); return; }
      logger.error(`longitudinal route failed [${requestId}]`);
      if (!res.headersSent) res.status(500).json({ error: { code: 'internal_error', message: 'Internal error.', requestId } });
    }
  };
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);

router.get('/v1/interpretations/:id/timeline', ...guards, handler(async (req, res) => {
  const limit = req.query.limit === undefined ? undefined : Number.parseInt(String(req.query.limit), 10);
  if (limit !== undefined && !(limit >= 1)) throw new TenancyError(400, 'validation_failed', 'limit must be a positive integer.');
  res.setHeader('Cache-Control', 'no-store');
  res.json(await timelineFor(req.tenant!.tenant_id, String(req.params.id), { skillId: str(req.query.skillId), findingKey: str(req.query.findingKey), limit }));
}));

router.get('/v1/interpretations/:id/compare', ...guards, handler(async (req, res) => {
  const other = str(req.query.with);
  if (!other) throw new TenancyError(400, 'validation_failed', 'with=<jobId> is required.');
  const doc = await compareJobs(req.tenant!.tenant_id, String(req.params.id), other);
  const v = validateLongitudinalComparison(doc);
  if (!v.ok) { logger.error('longitudinal comparison failed longitudinal-comparison/v1'); throw new TenancyError(500, 'internal_error', 'Internal error.'); }
  res.setHeader('Cache-Control', 'no-store');
  res.json(doc);
}));

export function listLongitudinalRoutes(): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const layer of (router as any).stack) { if (!layer.route) continue; for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: layer.route.path }); }
  return out;
}
export default router;
