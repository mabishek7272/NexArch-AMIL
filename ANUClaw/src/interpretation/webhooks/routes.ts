/**
 * Tenant webhook management and delivery log (interpretation engine, P3c), mounted under /api/v1 next to the existing
 * `PUT /account/webhook` (which now registers through `registerWebhook`).
 *
 *   GET    /account/webhook                  configuration (never the secret)
 *   POST   /account/webhook/secret/rotate    new signing secret, shown once
 *   DELETE /account/webhook                  remove the endpoint
 *   GET    /account/webhook/deliveries       this tenant's delivery log (status codes and error codes only)
 */
import * as crypto from 'crypto';
import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../../api/middleware/auth';
import { perTenantRateLimit } from '../../api/middleware/rate-limit';
import { db } from '../../db';
import { logger } from '../../logger';
import { TenancyError } from '../tenancy/keys';
import type { AuditCtx } from '../tenancy/audit';
import { getWebhook, removeWebhook, rotateWebhookSecret } from './config';

const router = Router();
const guards = [requireAuth, perTenantRateLimit];

export function webhookHandler(fn: (req: AuthRequest, res: Response, ctx: AuditCtx) => Promise<void>) {
  return async (req: AuthRequest, res: Response): Promise<void> => {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const ctx: AuditCtx = { actor: `tenant:${req.tenant!.tenant_id}`, declaredActor: null, requestId };
    try { await fn(req, res, ctx); } catch (e) {
      if (e instanceof TenancyError) { res.status(e.status).json({ error: { code: e.code, message: e.message, requestId, ...(e.details ? { details: e.details } : {}) } }); return; }
      logger.error(`webhook route failed [${requestId}]`);
      if (!res.headersSent) res.status(500).json({ error: { code: 'internal_error', message: 'Internal error.', requestId } });
    }
  };
}

router.get('/account/webhook', ...guards, webhookHandler(async (req, res) => { res.json(await getWebhook(req.tenant!.tenant_id)); }));

router.post('/account/webhook/secret/rotate', ...guards, webhookHandler(async (req, res, ctx) => {
  const { signingSecret } = await rotateWebhookSecret(req.tenant!.tenant_id, ctx);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ signing_secret: signingSecret, note: 'Store this now: it is shown once and cannot be retrieved again. Events signed before the rotation were already sent with the previous secret.' });
}));

router.delete('/account/webhook', ...guards, webhookHandler(async (req, res, ctx) => {
  await removeWebhook(req.tenant!.tenant_id, ctx);
  res.status(204).end();
}));

router.get('/account/webhook/deliveries', ...guards, webhookHandler(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? '25'), 10) || 25));
  const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0);
  const status = typeof req.query.status === 'string' && ['pending', 'sending', 'delivered', 'dead'].includes(req.query.status) ? req.query.status : null;
  const rows = await db.query(
    `SELECT event_id, event_type, job_id, status, attempts, last_status_code, last_error, run_after, created_at, delivered_at, dead_at FROM webhook_deliveries
     WHERE tenant_id = $1 AND ($4::text IS NULL OR status = $4) ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`, [req.tenant!.tenant_id, limit, offset, status]);
  res.json({
    items: rows.map((r: any) => ({
      eventId: r.event_id, type: r.event_type, jobId: r.job_id, status: r.status, attempts: Number(r.attempts),
      lastStatusCode: r.last_status_code ?? null, lastError: r.last_error ?? null,
      nextAttemptAt: r.status === 'pending' ? Number(r.run_after) : null, createdAt: Number(r.created_at),
      deliveredAt: r.delivered_at == null ? null : Number(r.delivered_at), deadAt: r.dead_at == null ? null : Number(r.dead_at),
    })),
    limit, offset,
  });
}));

export default router;
