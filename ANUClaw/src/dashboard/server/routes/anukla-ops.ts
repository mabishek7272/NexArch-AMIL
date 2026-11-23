/**
 * Operations module for the interpretation engine (P6c), behind the dashboard session. About processing, not people: nothing
 * returned here contains a subject reference, identity, finding value or report text.
 *
 *   GET  /overview                         queue depth, failure rate, review and delivery counts, top error codes
 *   GET  /jobs, /jobs/:id                  processing history (filters: tenantId, status, skillId, errorCode, from, to)
 *   POST /jobs/:id/retry                   re-queue a failed job
 *   POST /reports/:id/retry                re-queue a failed report at the stage that failed
 *   GET  /webhooks/deliveries, /webhooks/endpoints
 *   POST /webhooks/deliveries/:id/redeliver   send a dead delivery again (same event id)
 *   GET  /usage?from&to                    requests, jobs and model spend per tenant
 *   GET  /audit/verify?tenantId            re-verify each tenant's hash chain
 *
 * Roles: reading is for admin, operator, auditor and compliance (the chain check: admin, auditor, compliance); the three
 * re-queue actions are for admin and operator. Every action is audited in the tenant's chain under `dashboard:<user id>`.
 */
import { Router, Response } from 'express';
import { requireDashAuth, AuthRequest } from '../auth';
import { logger } from '../../../logger';
import { TenancyError } from '../../../interpretation/tenancy/keys';
import * as ops from '../../../interpretation/ops/service';

const router = Router();
const READ = new Set(['admin', 'operator', 'auditor', 'compliance']);
const ACT = new Set(['admin', 'operator']);
const AUDIT_READ = new Set(['admin', 'auditor', 'compliance']);

function guard(roles: Set<string>, fn: (req: AuthRequest, res: Response) => Promise<unknown>) {
  return [requireDashAuth, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      if (!roles.has(req.user?.role ?? '')) { res.status(403).json({ error: 'Insufficient permissions.', code: 'forbidden' }); return; }
      res.setHeader('Cache-Control', 'no-store');
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out);
    } catch (e) {
      if (e instanceof TenancyError) { res.status(e.status).json({ error: e.message, code: e.code }); return; }
      logger.error('anukla ops route failed');
      if (!res.headersSent) res.status(500).json({ error: 'Internal error.', code: 'internal_error' });
    }
  }];
}
const q = (req: AuthRequest, k: string): string | undefined => (typeof req.query[k] === 'string' && req.query[k] !== '' ? String(req.query[k]) : undefined);
const int = (req: AuthRequest, k: string): number | undefined => { const v = q(req, k); return v === undefined ? undefined : Number.parseInt(v, 10); };
const ms = (req: AuthRequest, k: string): number | undefined => {
  const v = q(req, k); if (v === undefined) return undefined;
  const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(t)) throw new TenancyError(400, 'validation_failed', `${k} must be a date or a millisecond timestamp.`);
  return t;
};
const actor = (req: AuthRequest) => `dashboard:${req.user!.id}`;

router.get('/overview', ...guard(READ, () => ops.overview()));
router.get('/jobs', ...guard(READ, (req) => ops.listJobs({ tenantId: q(req, 'tenantId'), status: q(req, 'status'), skillId: q(req, 'skillId'), errorCode: q(req, 'errorCode'), from: ms(req, 'from'), to: ms(req, 'to'), limit: int(req, 'limit'), offset: int(req, 'offset') })));
router.get('/jobs/:id', ...guard(READ, (req) => ops.jobDetail(String(req.params.id))));
router.post('/jobs/:id/retry', ...guard(ACT, async (req, res) => { res.status(202); return ops.retryJob(String(req.params.id), actor(req)); }));
router.post('/reports/:id/retry', ...guard(ACT, async (req, res) => { res.status(202); return ops.retryReport(String(req.params.id), actor(req)); }));
router.get('/webhooks/deliveries', ...guard(READ, (req) => ops.listDeliveries({ tenantId: q(req, 'tenantId'), status: q(req, 'status'), eventType: q(req, 'eventType'), limit: int(req, 'limit'), offset: int(req, 'offset') })));
router.get('/webhooks/endpoints', ...guard(READ, async () => ({ endpoints: await ops.listEndpoints() })));
router.post('/webhooks/deliveries/:id/redeliver', ...guard(ACT, async (req, res) => { res.status(202); return ops.redeliver(String(req.params.id), actor(req)); }));
router.get('/usage', ...guard(READ, (req) => ops.usage({ from: q(req, 'from'), to: q(req, 'to') })));
router.get('/audit/verify', ...guard(AUDIT_READ, (req) => ops.verifyAudit(q(req, 'tenantId'))));

export default router;
