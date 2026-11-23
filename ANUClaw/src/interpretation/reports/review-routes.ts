/**
 * Administrator review queue (interpretation engine, P4d). READ-ONLY, behind the fail-closed X-Admin-Key guard. It lists
 * what needs a clinician: reports the automatic review sent to `awaiting_clinician`, and non-blocking follow-ups (a high-risk
 * finding was delivered with the referral advisory and a clinician should still look). It carries identifiers, hashes and
 * reason codes only: no values, labels or subject references. There is deliberately no route here (or anywhere) that signs.
 *
 *   GET /api/v1/admin/review-queue?kind=all|awaiting|follow_up&limit&offset
 */
import { Router } from 'express';
import { requireAdmin } from '../../api/routes/admin';
import { adminHandler as handle } from '../tenancy/admin-http';
import { listReviewQueue } from './review-queue';

export function createReviewQueueRouter(opts: { adminKey?: string } = {}): Router {
  const guard = requireAdmin(opts.adminKey ?? process.env.ADMIN_API_KEY);
  const router = Router();
  router.get('/api/v1/admin/review-queue', guard, handle(async (req, res) => {
    const kind = String(req.query.kind ?? 'all');
    const limit = Number.parseInt(String(req.query.limit ?? '25'), 10) || 25;
    const offset = Number.parseInt(String(req.query.offset ?? '0'), 10) || 0;
    res.json({ ...(await listReviewQueue({ kind, limit, offset })) });
  }));
  return router;
}
