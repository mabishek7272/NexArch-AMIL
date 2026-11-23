/**
 * Dashboard administration of the interpretation engine (P6b): tenants, API keys, skill assignment, narrative settings and
 * branding. These are the SAME routers as the X-Admin-Key administrator API (same validation, same audit entries, same paths
 * under /api/v1/admin/...), mounted behind the dashboard session instead of the shared key, so there is one implementation.
 *
 * The guard here:
 *  - needs a live dashboard session (cookie), then a role: reading (GET) is for `admin`, `auditor` and `compliance`; every
 *    change is for `admin` only. Operators, viewers and clinicians are refused.
 *  - sets `auditActor` = `dashboard:<user id>`, so each audit entry names the VERIFIED person who acted (the shared admin key
 *    only ever proves "an administrator").
 * It never needs or reads ADMIN_API_KEY.
 */
import type { NextFunction, Response, Router } from 'express';
import { requireDashAuth, AuthRequest } from '../auth';
import { createTenantAdminRouter } from '../../../interpretation/tenancy/admin-routes';
import { createSkillAdminRouter } from '../../../interpretation/skills/admin-routes';
import { createBrandingAdminRouter } from '../../../interpretation/reports/admin-routes';

const READ_ROLES = new Set(['admin', 'auditor', 'compliance']);

function roleGate(req: AuthRequest, res: Response, next: NextFunction): void {
  const reading = req.method === 'GET' || req.method === 'HEAD';
  const role = req.user?.role ?? '';
  if (reading ? !READ_ROLES.has(role) : role !== 'admin') {
    res.status(403).json({ error: 'Insufficient permissions.', code: 'forbidden' });
    return;
  }
  (req as AuthRequest & { auditActor?: string }).auditActor = `dashboard:${req.user!.id}`;
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export const dashboardAdminGuard = [requireDashAuth, roleGate];

export function mountAnuklaAdmin(dash: Router): void {
  const guard = dashboardAdminGuard as unknown as import('../../../interpretation/tenancy/admin-http').AdminGuard;
  dash.use(createTenantAdminRouter({ guard }));
  dash.use(createSkillAdminRouter({ guard }));
  dash.use(createBrandingAdminRouter({ guard }));
}
