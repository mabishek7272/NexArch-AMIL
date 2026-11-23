/**
 * Administrator API for tenants and their keys (interpretation engine, P1).
 *
 *   POST /api/v1/admin/tenants                          create a tenant + its first key (key shown once)
 *   GET  /api/v1/admin/tenants                          list tenants (paginated)
 *   POST /api/v1/admin/tenants/:id/suspend | /reactivate
 *   PUT  /api/v1/admin/tenants/:id/plan                 the only way a plan changes
 *   GET  /api/v1/admin/tenants/:id/keys                 never includes key material or hashes
 *   POST /api/v1/admin/tenants/:id/keys                 create another key (shown once)
 *   POST /api/v1/admin/tenants/:id/keys/:keyId/rotate   new key now; old key lapses after a grace period
 *   POST /api/v1/admin/tenants/:id/keys/:keyId/revoke   immediate, idempotent
 *   GET  /api/v1/admin/tenants/:id/audit                that tenant's hash-chained entries + chain verification
 *
 * Auth: the same fail-closed `X-Admin-Key` guard as src/api/routes/admin.ts (503 if ADMIN_API_KEY is unset).
 * That key proves "an administrator", not which one; an optional `X-Admin-Actor` label is recorded in the audit
 * entry as an UNVERIFIED claim. Per-person administrator identity arrives with the dashboard admin plane (P6).
 *
 * Errors: { error: { code, message, requestId } }. A key id that belongs to another tenant is "not found".
 */
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { requireAdmin } from '../../api/routes/admin';
import { TenancyError, createKey, rotateKey, revokeKey, listKeys, TenantKeyRecord } from './keys';
import { ensureTenantAuditReady, readTenantAudit, recordTenantEvent } from './audit';
import { adminCreateTenant, parsePlan, setTenantPlan, setTenantStatus } from './lifecycle';
import { adminHandler as handle, idParam, type AdminGuard } from './admin-http';

const publicKey = (k: TenantKeyRecord) => ({ ...k });

export function createTenantAdminRouter(opts: { adminKey?: string; guard?: AdminGuard } = {}): Router {
  const guard = opts.guard ?? requireAdmin(opts.adminKey ?? process.env.ADMIN_API_KEY);
  const router = Router();

  const tenantId = (req: Request): string => idParam(req, 'id', 'tenant_not_found', 'Tenant not found.');
  const keyId = (req: Request): string => idParam(req, 'keyId', 'key_not_found', 'Key not found.');
  const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

  router.post('/api/v1/admin/tenants', guard, handle(async (req, res, ctx) => {
    const t = await adminCreateTenant({ companyName: req.body?.company_name, email: req.body?.email, plan: req.body?.plan }, ctx);
    noStore(res);
    res.status(201).json({
      tenant_id: t.tenant_id, company_name: t.company_name, plan: t.plan, status: t.status,
      api_key: t.api_key, notice: 'Store this API key securely. It is shown once and cannot be recovered; rotate it if lost.',
    });
  }));

  router.get('/api/v1/admin/tenants', guard, handle(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const rows = await db.query(
      `SELECT t.tenant_id, t.company_name, t.email, t.status, t.plan, t.created_at, t.last_active_at,
              (SELECT COUNT(*)::int FROM tenant_api_keys k WHERE k.tenant_id = t.tenant_id AND k.revoked_at IS NULL
                  AND (k.expires_at IS NULL OR k.expires_at > $3)) AS active_keys
         FROM tenants t ORDER BY t.created_at DESC, t.tenant_id LIMIT $1 OFFSET $2`,
      [limit, offset, Date.now()]);
    res.json({ tenants: rows, limit, offset });
  }));

  router.get('/api/v1/admin/tenants/:id', guard, handle(async (req, res) => {
    const t = await db.queryOne(
      `SELECT t.tenant_id, t.company_name, t.email, t.status, t.plan, t.created_at, t.last_active_at,
              (SELECT COUNT(*)::int FROM tenant_api_keys k WHERE k.tenant_id = t.tenant_id AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > $2)) AS active_keys
         FROM tenants t WHERE t.tenant_id = $1`, [tenantId(req), Date.now()]);
    if (!t) throw new TenancyError(404, 'tenant_not_found', 'Tenant not found.');
    res.json({ tenant: t });
  }));

  router.post('/api/v1/admin/tenants/:id/suspend', guard, handle(async (req, res, ctx) => {
    res.json(await setTenantStatus(tenantId(req), 'suspended', ctx));
  }));
  router.post('/api/v1/admin/tenants/:id/reactivate', guard, handle(async (req, res, ctx) => {
    res.json(await setTenantStatus(tenantId(req), 'active', ctx));
  }));
  router.put('/api/v1/admin/tenants/:id/plan', guard, handle(async (req, res, ctx) => {
    res.json(await setTenantPlan(tenantId(req), parsePlan(req.body?.plan), ctx));
  }));

  router.get('/api/v1/admin/tenants/:id/keys', guard, handle(async (req, res) => {
    res.json({ keys: (await listKeys(tenantId(req))).map(publicKey) });
  }));

  router.post('/api/v1/admin/tenants/:id/keys', guard, handle(async (req, res, ctx) => {
    const tid = tenantId(req);
    await ensureTenantAuditReady();
    const made = await createKey(
      tid, { label: req.body?.label, scopes: req.body?.scopes, expiresAt: req.body?.expires_at, createdBy: ctx.actor }, Date.now(),
      async (tx, k) => { await recordTenantEvent(tx, tid, ctx, 'tenant.key.created', { key_id: k.key_id, key_prefix: k.key_prefix, label: k.label, scopes: k.scopes, expires_at: k.expires_at }); });
    noStore(res);
    res.status(201).json({ key: publicKey(made.record), api_key: made.apiKey, notice: 'Shown once; cannot be recovered.' });
  }));

  router.post('/api/v1/admin/tenants/:id/keys/:keyId/rotate', guard, handle(async (req, res, ctx) => {
    const tid = tenantId(req);
    await ensureTenantAuditReady();
    const out = await rotateKey(
      tid, keyId(req), { graceSeconds: req.body?.grace_seconds, expiresAt: req.body?.expires_at, createdBy: ctx.actor }, Date.now(),
      async (tx, info) => {
        await recordTenantEvent(tx, tid, ctx, 'tenant.key.rotated', {
          old_key_id: info.oldKey.key_id, old_key_prefix: info.oldKey.key_prefix, new_key_id: info.newKey.key_id, new_key_prefix: info.newKey.key_prefix,
          grace_seconds: info.graceSeconds, old_key_expires_at: info.oldKey.expires_at, old_key_revoked: info.oldKey.revoked_at !== null,
        });
      });
    noStore(res);
    res.status(201).json({ key: publicKey(out.record), api_key: out.apiKey, retired_key: publicKey(out.retired), notice: 'Shown once; cannot be recovered.' });
  }));

  router.post('/api/v1/admin/tenants/:id/keys/:keyId/revoke', guard, handle(async (req, res, ctx) => {
    const tid = tenantId(req);
    await ensureTenantAuditReady();
    const out = await revokeKey(tid, keyId(req), String(req.body?.reason ?? ''), Date.now(),
      async (tx, k, already) => { await recordTenantEvent(tx, tid, ctx, 'tenant.key.revoked', { key_id: k.key_id, key_prefix: k.key_prefix, reason: k.revoked_reason, already_revoked: already }); });
    res.json({ key: publicKey(out.record), already_revoked: out.alreadyRevoked });
  }));

  router.get('/api/v1/admin/tenants/:id/audit', guard, handle(async (req, res) => {
    const tid = tenantId(req);
    const exists = await db.queryOne('SELECT 1 FROM tenants WHERE tenant_id = $1', [tid]);
    if (!exists) throw new TenancyError(404, 'tenant_not_found', 'Tenant not found.');
    const { entries, verification } = await readTenantAudit(tid);
    res.json({ tenant_id: tid, chain: verification, entry_count: entries.length, entries });
  }));

  return router;
}
