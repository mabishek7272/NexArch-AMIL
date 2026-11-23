/**
 * Tenant lifecycle operations performed by an administrator (interpretation engine, P1): create a tenant with
 * its first key, suspend/reactivate it, and change its plan. A tenant can no longer change its own plan.
 *
 * Every function writes its audit entry inside the same transaction as the change (see audit.ts), so a change
 * and its record commit or roll back together. Audit payloads deliberately omit the tenant's e-mail address
 * (the chain is append-only and cannot be edited later); the e-mail domain is recorded instead.
 */
import { db } from '../../db';
import { registerTenant, planLimits, Plan, Tenant } from '../../api/tenant-store';
import { TenancyError } from './keys';
import { AuditCtx, ensureTenantAuditReady, recordTenantEvent } from './audit';
import { ensureSkillRegistry } from '../skills/registry';

export const PLANS: Plan[] = ['free', 'pro', 'enterprise'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parsePlan(plan: unknown): Plan {
  if (typeof plan !== 'string' || !PLANS.includes(plan as Plan)) {
    throw new TenancyError(400, 'validation_failed', `plan must be one of: ${PLANS.join(', ')}.`);
  }
  return plan as Plan;
}

export async function adminCreateTenant(
  input: { companyName: unknown; email: unknown; plan?: unknown },
  ctx: AuditCtx,
): Promise<Tenant> {
  const name = typeof input.companyName === 'string' ? input.companyName.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (name.length < 1 || name.length > 200) throw new TenancyError(400, 'validation_failed', 'company_name is required (1-200 characters).');
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new TenancyError(400, 'validation_failed', 'email must be a valid address.');
  const plan = input.plan === undefined ? 'free' : parsePlan(input.plan);

  await ensureTenantAuditReady();
  // The skill registry's one-time grandfathering must have run BEFORE this tenant exists, or the new tenant would
  // wrongly be treated as an existing one and be handed every agent skill.
  await ensureSkillRegistry();
  try {
    return await registerTenant(name, email, plan, {
      createdBy: ctx.actor,
      label: 'initial',
      afterInsert: async (tx, tenantId) => {
        await recordTenantEvent(tx, tenantId, ctx, 'tenant.created', {
          company_name: name, email_domain: email.split('@')[1].toLowerCase(), plan, first_key_label: 'initial',
        });
      },
    });
  } catch (e) {
    if (e instanceof Error && /already registered/.test(e.message)) {
      throw new TenancyError(409, 'email_already_registered', 'A tenant with that e-mail address already exists.');
    }
    throw e;
  }
}

export async function setTenantStatus(
  tenantId: string, status: 'active' | 'suspended', ctx: AuditCtx,
): Promise<{ tenant_id: string; before: string; after: string }> {
  await ensureTenantAuditReady();
  return db.transaction(async (tx) => {
    const cur = await tx.query('SELECT status FROM tenants WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
    if (!cur.rows.length) throw new TenancyError(404, 'tenant_not_found', 'Tenant not found.');
    const before = String(cur.rows[0].status);
    if (before !== status) await tx.query('UPDATE tenants SET status = $2 WHERE tenant_id = $1', [tenantId, status]);
    await recordTenantEvent(tx, tenantId, ctx, status === 'suspended' ? 'tenant.suspended' : 'tenant.reactivated',
      { before, after: status, changed: before !== status });
    return { tenant_id: tenantId, before, after: status };
  });
}

export async function setTenantPlan(
  tenantId: string, plan: Plan, ctx: AuditCtx,
): Promise<{ tenant_id: string; before: string; after: string }> {
  await ensureTenantAuditReady();
  const limits = planLimits(plan);
  return db.transaction(async (tx) => {
    const cur = await tx.query('SELECT plan FROM tenants WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
    if (!cur.rows.length) throw new TenancyError(404, 'tenant_not_found', 'Tenant not found.');
    const before = String(cur.rows[0].plan);
    await tx.query('UPDATE tenants SET plan = $2, rate_limit_per_min = $3, monthly_quota = $4 WHERE tenant_id = $1',
      [tenantId, plan, limits.rate, limits.quota ?? null]);
    await recordTenantEvent(tx, tenantId, ctx, 'tenant.plan_changed', { before, after: plan });
    return { tenant_id: tenantId, before, after: plan };
  });
}
