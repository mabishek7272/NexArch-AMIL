/**
 * Administrator API for the skill registry and for assigning skills to tenants (interpretation engine, P2).
 *
 *   GET    /api/v1/admin/skills                              all skills, with how many tenants have each
 *   POST   /api/v1/admin/skills                              register an interpretation skill from a manifest
 *   PATCH  /api/v1/admin/skills/:skillId                     { enabled? , manifest? } — a manifest change needs a new version
 *   GET    /api/v1/admin/adapters                            declared adapters and whether each is implemented
 *   GET    /api/v1/admin/tenants/:id/skills                  a tenant's assignments
 *   PUT    /api/v1/admin/tenants/:id/skills/:skillId         assign / update ({ enabled?, config? }); idempotent
 *   DELETE /api/v1/admin/tenants/:id/skills/:skillId         unassign
 *
 * Same fail-closed `X-Admin-Key` guard and `{ error: { code, message, requestId } }` errors as the tenant admin
 * routes; every change is audited in the same transaction (see registry.ts).
 */
import { Router, Request } from 'express';
import { db } from '../../db';
import { requireAdmin } from '../../api/routes/admin';
import { TenancyError } from '../tenancy/keys';
import { adminHandler as handle, idParam, type AdminGuard } from '../tenancy/admin-http';
import { SKILL_ID_RE } from './manifest';
import { listAdapters } from './adapters';
import { assignSkill, ensureSkillRegistry, listSkills, listTenantSkills, registerInterpretationSkill, unassignSkill, updateSkill } from './registry';

export function createSkillAdminRouter(opts: { adminKey?: string; guard?: AdminGuard } = {}): Router {
  const guard = opts.guard ?? requireAdmin(opts.adminKey ?? process.env.ADMIN_API_KEY);
  const router = Router();

  const tenantId = (req: Request): string => idParam(req, 'id', 'tenant_not_found', 'Tenant not found.');
  const skillId = (req: Request): string => {
    const id = String(req.params.skillId);
    if (!SKILL_ID_RE.test(id)) throw new TenancyError(404, 'skill_not_found', 'Skill not found.');
    return id;
  };

  router.get('/api/v1/admin/skills', guard, handle(async (_req, res) => {
    const skills = await listSkills();
    const counts = await db.query('SELECT skill_id, COUNT(*)::int AS tenants FROM tenant_skills GROUP BY skill_id');
    const byId = new Map(counts.map((c: any) => [String(c.skill_id), Number(c.tenants)]));
    res.json({ skills: skills.map((s) => ({ ...s, tenants_assigned: byId.get(s.skill_id) ?? 0 })) });
  }));

  router.post('/api/v1/admin/skills', guard, handle(async (req, res, ctx) => {
    res.status(201).json({ skill: await registerInterpretationSkill(req.body?.manifest, ctx) });
  }));

  router.patch('/api/v1/admin/skills/:skillId', guard, handle(async (req, res, ctx) => {
    res.json({ skill: await updateSkill(skillId(req), { enabled: req.body?.enabled, manifest: req.body?.manifest }, ctx) });
  }));

  router.get('/api/v1/admin/adapters', guard, handle(async (_req, res) => {
    res.json({ adapters: listAdapters() });
  }));

  router.get('/api/v1/admin/tenants/:id/skills', guard, handle(async (req, res) => {
    const tid = tenantId(req);
    const exists = await db.queryOne('SELECT 1 FROM tenants WHERE tenant_id = $1', [tid]);
    if (!exists) throw new TenancyError(404, 'tenant_not_found', 'Tenant not found.');
    await ensureSkillRegistry();
    res.json({ tenant_id: tid, skills: await listTenantSkills(tid) });
  }));

  router.put('/api/v1/admin/tenants/:id/skills/:skillId', guard, handle(async (req, res, ctx) => {
    const out = await assignSkill(tenantId(req), skillId(req), { enabled: req.body?.enabled, config: req.body?.config }, ctx);
    res.status(out.created ? 201 : 200).json({ assignment: out.assignment, created: out.created });
  }));

  router.delete('/api/v1/admin/tenants/:id/skills/:skillId', guard, handle(async (req, res, ctx) => {
    await unassignSkill(tenantId(req), skillId(req), ctx);
    res.status(204).end();
  }));

  return router;
}
