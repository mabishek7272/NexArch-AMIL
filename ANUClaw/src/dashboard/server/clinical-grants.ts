/**
 * Explicit clinical grants for dashboard users (plan F03; replaces the former
 * "every dashboard user is a fully-granted clinical tenant").
 *
 * A dashboard user's E-LAB tenant context is derived ONLY from:
 *   - role: engine scopes require 'admin' or 'operator';
 *   - an admin-set grant in dash_users.scope_json:
 *         { "elab": { "clinical_domains": ["oncology", ...] } }
 *     intersected with the domains actually enabled in this build;
 *   - a deployment declaration that a BAA is in place: ELAB_DASHBOARD_BAA_ACTIVE=true.
 * Nothing is implied. Missing/invalid grants yield RUO-only (or no) scope, and the
 * clinical gate then denies with its normal explicit error.
 */
import type { TenantContext } from '../../api/elab/types';

export const ENGINE_ROLES = ['admin', 'operator'] as const;

export interface ElabGrant { clinical_domains: string[] }

/** Parse the grant from scope_json; anything malformed is treated as no grant. */
export function parseElabGrant(scopeJson: string | null | undefined): ElabGrant {
  try {
    const parsed = JSON.parse(scopeJson || '{}');
    const domains = parsed?.elab?.clinical_domains;
    if (Array.isArray(domains) && domains.every((d) => typeof d === 'string')) {
      return { clinical_domains: [...new Set(domains.map((d: string) => d.trim()).filter(Boolean))] };
    }
  } catch { /* malformed → no grant */ }
  return { clinical_domains: [] };
}

/** Validate a scope_json value an admin is about to store. Returns an error message or null. */
export function validateScopeJson(scopeJson: unknown): string | null {
  if (scopeJson === undefined || scopeJson === null) return null;
  if (typeof scopeJson !== 'string') return 'scope_json must be a JSON string.';
  let parsed: any;
  try { parsed = JSON.parse(scopeJson); } catch { return 'scope_json is not valid JSON.'; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'scope_json must be a JSON object.';
  if (parsed.elab !== undefined) {
    const d = parsed.elab?.clinical_domains;
    if (d !== undefined && !(Array.isArray(d) && d.every((x: unknown) => typeof x === 'string'))) {
      return 'scope_json.elab.clinical_domains must be an array of strings.';
    }
  }
  return null;
}

export function dashboardBaaDeclared(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ELAB_DASHBOARD_BAA_ACTIVE === 'true';
}

export function dashTenantContext(
  user: { id: string; role: string; scope_json?: string | null },
  enabledDomains: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): TenantContext {
  const engineRole = (ENGINE_ROLES as readonly string[]).includes(user.role);
  const grant = parseElabGrant(user.scope_json);
  const domains = engineRole ? grant.clinical_domains.filter((d) => enabledDomains.includes(d)) : [];
  const scopes: string[] = [];
  if (engineRole) scopes.push('ruo');
  if (engineRole && domains.length > 0) scopes.push('clinical');
  return {
    tenant_id: `dashboard:${user.id}`,
    scopes,
    baa_active: dashboardBaaDeclared(env),
    allowed_clinical_domains: domains,
    residency: 'us',
  };
}
