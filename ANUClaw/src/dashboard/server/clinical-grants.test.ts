import { describe, expect, it } from 'vitest';
import { dashTenantContext, parseElabGrant, validateScopeJson } from './clinical-grants';
import { checkClinicalGate } from '../../api/elab/gate';

const DOMAINS = ['oncology', 'neurology'];
const grant = (d: unknown) => JSON.stringify({ elab: { clinical_domains: d } });
const BAA = { ELAB_DASHBOARD_BAA_ACTIVE: 'true' };

describe('dashboard tenant context is derived from explicit grants only', () => {
  it('a logged-in operator with no grant gets RUO only, no clinical, no BAA', () => {
    const ctx = dashTenantContext({ id: 'u', role: 'operator', scope_json: '{}' }, DOMAINS, {});
    expect(ctx.scopes).toEqual(['ruo']);
    expect(ctx.allowed_clinical_domains).toEqual([]);
    expect(ctx.baa_active).toBe(false);
  });

  it.each(['viewer', 'auditor', 'compliance'])('%s gets no engine scopes even with a grant', (role) => {
    const ctx = dashTenantContext({ id: 'u', role, scope_json: grant(['oncology']) }, DOMAINS, BAA);
    expect(ctx.scopes).toEqual([]);
    expect(ctx.allowed_clinical_domains).toEqual([]);
  });

  it('an admin-granted operator gets only the granted, enabled domains', () => {
    const ctx = dashTenantContext({ id: 'u', role: 'operator', scope_json: grant(['oncology', 'cardiology']) }, DOMAINS, BAA);
    expect(ctx.scopes).toEqual(['ruo', 'clinical']);
    expect(ctx.allowed_clinical_domains).toEqual(['oncology']);
    expect(ctx.baa_active).toBe(true);
  });

  it('BAA is never implied: grant without the deployment declaration has baa_active=false', () => {
    expect(dashTenantContext({ id: 'u', role: 'admin', scope_json: grant(['oncology']) }, DOMAINS, {}).baa_active).toBe(false);
  });

  it.each(['not json', '[]', grant('oncology'), grant([1, 2])])('malformed grant %s → no clinical domains', (sj) => {
    expect(parseElabGrant(sj).clinical_domains).toEqual([]);
  });
});

describe('integration with the existing clinical gate', () => {
  const gate = (ctx: ReturnType<typeof dashTenantContext>, domain: string) => checkClinicalGate(ctx, domain).ok;

  it('denies an ungranted operator', () => {
    expect(gate(dashTenantContext({ id: 'u', role: 'operator', scope_json: '{}' }, DOMAINS, BAA), 'oncology')).toBe(false);
  });

  it('denies a granted operator when BAA is not declared', () => {
    expect(gate(dashTenantContext({ id: 'u', role: 'operator', scope_json: grant(['oncology']) }, DOMAINS, {}), 'oncology')).toBe(false);
  });

  it('denies a domain outside the grant', () => {
    expect(gate(dashTenantContext({ id: 'u', role: 'operator', scope_json: grant(['oncology']) }, DOMAINS, BAA), 'neurology')).toBe(false);
  });

  it('allows only the fully granted combination', () => {
    expect(gate(dashTenantContext({ id: 'u', role: 'operator', scope_json: grant(['oncology']) }, DOMAINS, BAA), 'oncology')).toBe(true);
  });
});

describe('validateScopeJson', () => {
  it.each([[undefined, null], ['{}', null], [grant(['oncology']), null]])('accepts %s', (v, e) => {
    expect(validateScopeJson(v)).toBe(e);
  });
  it.each(['nope', '[]', '"x"', grant('oncology'), 5])('rejects %s', (v) => {
    expect(validateScopeJson(v)).not.toBeNull();
  });
});
