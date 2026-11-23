/**
 * Administrator API for tenant branding (interpretation engine, P4c). Same fail-closed X-Admin-Key guard as the other admin routers.
 *
 *   GET    /api/v1/admin/tenants/:id/branding    { productName, hasLogo, logoMime }   (never the logo bytes)
 *   PUT    /api/v1/admin/tenants/:id/branding    { productName?, logoBase64? }  (null clears a field)
 *   DELETE /api/v1/admin/tenants/:id/branding
 */
import { Router, Request } from 'express';
import { db } from '../../db';
import { requireAdmin } from '../../api/routes/admin';
import { TenancyError } from '../tenancy/keys';
import { adminHandler as handle, idParam, type AdminGuard } from '../tenancy/admin-http';
import { brandingView, clearBranding, getBranding, parseBrandingUpdate, setBranding } from './branding';

export function createBrandingAdminRouter(opts: { adminKey?: string; guard?: AdminGuard } = {}): Router {
  const guard = opts.guard ?? requireAdmin(opts.adminKey ?? process.env.ADMIN_API_KEY);
  const router = Router();
  const tid = (req: Request): string => idParam(req, 'id', 'tenant_not_found', 'Tenant not found.');
  const exists = async (id: string): Promise<void> => { if (!(await db.queryOne('SELECT 1 FROM tenants WHERE tenant_id = $1', [id]))) throw new TenancyError(404, 'tenant_not_found', 'Tenant not found.'); };

  router.get('/api/v1/admin/tenants/:id/branding', guard, handle(async (req, res) => { const id = tid(req); await exists(id); res.json({ tenant_id: id, branding: brandingView(await getBranding(id)) }); }));
  router.put('/api/v1/admin/tenants/:id/branding', guard, handle(async (req, res, ctx) => { const id = tid(req); await exists(id); res.json({ tenant_id: id, branding: brandingView(await setBranding(id, parseBrandingUpdate(req.body), ctx)) }); }));
  router.delete('/api/v1/admin/tenants/:id/branding', guard, handle(async (req, res, ctx) => { const id = tid(req); await exists(id); await clearBranding(id, ctx); res.status(204).end(); }));
  return router;
}
