/**
 * Skill registry and per-tenant assignment (interpretation engine, P2).
 *
 * Two kinds of skill live in one table:
 *   - `agent`          the file-based skills under container/skills (synced in, one row each);
 *   - `interpretation` manifest-defined skills tied to a code-defined adapter (see manifest.ts, adapters.ts).
 * A tenant can use a skill only through an enabled `tenant_skills` row; `checkSkillAccess` is the single decision
 * point, and it answers "not assigned" for unknown ids too, so a tenant cannot probe the catalogue.
 *
 * One-time grandfathering: the first time the registry starts on a database that has tenants, every existing tenant
 * is assigned every agent skill once (so nothing breaks); a marker row in `registry_state` stops that from ever
 * repeating, so a skill an administrator later removes stays removed. New tenants start with no skills.
 *
 * Every administrator change is audited in the same transaction (tenant changes on the tenant's chain, registry
 * changes on the reserved platform chain `_platform`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { db, TxClient } from '../../db';
import { mapTenantRow } from '../../api/tenant-map';
import type { Tenant } from '../../api/tenant-store';
import { TenancyError } from '../tenancy/keys';
import { AuditCtx, ensureTenantAuditReady, recordTenantEvent } from '../tenancy/audit';
import { InterpretationManifest, RiskTier, SKILL_ID_RE, validateManifest } from './manifest';
import { getAdapter, isAdapterAvailable } from './adapters';
import { validateNarrativeConfig } from '../narrative/settings';

/** Registry-wide events (skills registered/changed) are audited on this reserved chain; real tenant ids are UUIDs. */
export const PLATFORM_AUDIT_ID = '_platform';
const GRANDFATHER_MARKER = 'grandfather_agent_skills_v1';
const MAX_CONFIG_BYTES = 4096;

export type SkillKind = 'agent' | 'interpretation';

export interface SkillRecord {
  skill_id: string;
  kind: SkillKind;
  version: string;
  title: string;
  manifest: Record<string, unknown>;
  risk_tier: RiskTier;
  requires_release: boolean;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  updated_by: string;
}

export interface AssignmentRecord {
  tenant_id: string;
  skill_id: string;
  enabled: boolean;
  config: Record<string, unknown>;
  assigned_at: number;
  assigned_by: string;
}

export function skillsDir(): string {
  return process.env.ANUCLAW_SKILLS_DIR ?? path.resolve('./container/skills');
}

export interface AgentSkillFile { id: string; title: string; description: string }

/** Reads the file-based agent skills from disk (a directory is a skill when it contains SKILL.md). */
export function readAgentSkillCatalogue(dir = skillsDir()): AgentSkillFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((d) => SKILL_ID_RE.test(d) && fs.existsSync(path.join(dir, d, 'SKILL.md')))
    .map((d) => {
      const lines = fs.readFileSync(path.join(dir, d, 'SKILL.md'), 'utf8').split('\n');
      const title = lines[0].replace(/^#+\s*/, '').trim();
      const description = lines.slice(1).find((l) => l.trim().length > 0)?.trim() ?? '';
      return { id: d, title, description: description || title };
    });
}

/** Absolute path of an agent skill's SKILL.md, or null when the id is malformed or the file is missing. */
export function agentSkillFile(skillId: string): string | null {
  if (!SKILL_ID_RE.test(skillId)) return null;
  const p = path.join(skillsDir(), skillId, 'SKILL.md');
  return fs.existsSync(p) ? p : null;
}

// ── the initial interpretation skills (slots until their adapters exist) ────────────────────────

const BUILTIN_INTERPRETATION: InterpretationManifest[] = [
  { id: 'physiological-signal-interpretation', version: '1.0.0', title: 'Physiological Signal Interpretation', acceptsAnalysisTypes: ['face_scan_vitals'], adapterId: 'beaive-v1', inputSchema: 'interpretation-request/v1', prompts: { clinical: 'clinical-vitals/v1', layman: 'layman-vitals/v1' }, riskTier: 'ruo', requiresRelease: false },
  { id: 'posture-analysis-interpretation', version: '1.0.0', title: 'Posture Analysis Interpretation', acceptsAnalysisTypes: ['posture_landmark'], adapterId: 'posturepulse-v1', inputSchema: 'interpretation-request/v1', prompts: { clinical: 'clinical-posture/v1', layman: 'layman-posture/v1' }, riskTier: 'ruo', requiresRelease: false },
  { id: 'clinical-report-generation', version: '1.0.0', title: 'Clinical Report Generation', acceptsAnalysisTypes: ['face_scan_vitals', 'posture_landmark'], adapterId: 'report-clinical-v1', inputSchema: 'interpretation-request/v1', prompts: { clinical: 'clinical-report/v1' }, riskTier: 'ruo', requiresRelease: false },
  { id: 'patient-friendly-explanation', version: '1.0.0', title: 'Patient-Friendly Explanation', acceptsAnalysisTypes: ['face_scan_vitals', 'posture_landmark'], adapterId: 'report-layman-v1', inputSchema: 'interpretation-request/v1', prompts: { layman: 'layman-report/v1' }, riskTier: 'ruo', requiresRelease: false },
];

export function builtinInterpretationManifests(): InterpretationManifest[] { return BUILTIN_INTERPRETATION.map((m) => ({ ...m })); }

// ── mapping ─────────────────────────────────────────────────────────────────────────────────────

const SKILL_COLS = 'skill_id, kind, version, title, manifest_json, risk_tier, requires_release, enabled, created_at, updated_at, updated_by';

function toSkill(r: Record<string, any>): SkillRecord {
  let manifest: Record<string, unknown> = {};
  try { const p = JSON.parse(String(r.manifest_json)); if (p && typeof p === 'object') manifest = p; } catch { /* keep empty */ }
  return {
    skill_id: r.skill_id, kind: r.kind, version: r.version, title: r.title, manifest, risk_tier: r.risk_tier,
    requires_release: !!r.requires_release, enabled: !!r.enabled,
    created_at: Number(r.created_at), updated_at: Number(r.updated_at), updated_by: r.updated_by,
  };
}

function toAssignment(r: Record<string, any>): AssignmentRecord {
  let config: Record<string, unknown> = {};
  try { const p = JSON.parse(String(r.config_json)); if (p && typeof p === 'object') config = p; } catch { /* keep empty */ }
  return { tenant_id: r.tenant_id, skill_id: r.skill_id, enabled: !!r.enabled, config, assigned_at: Number(r.assigned_at), assigned_by: r.assigned_by };
}

// ── startup: sync, seed, one-time grandfathering ────────────────────────────────────────────────

let ready: Promise<void> | null = null;

/** Idempotent, advisory-locked; runs once per process. Every skill decision awaits it first. */
export function ensureSkillRegistry(now = Date.now()): Promise<void> {
  if (!ready) ready = seed(now).catch((e) => { ready = null; throw e; });
  return ready;
}

/** Test hook: forget that the registry was seeded (a fresh database per test file). */
export function resetSkillRegistryForTests(): void { ready = null; }

const ZERO_CTX: AuditCtx = { actor: 'migration', declaredActor: null, requestId: null };

async function insertSkillIfMissing(tx: TxClient, s: {
  id: string; kind: SkillKind; version: string; title: string; manifest: unknown; riskTier: RiskTier; requiresRelease: boolean;
}, now: number, by: string): Promise<void> {
  await tx.query(
    `INSERT INTO skills (skill_id, kind, version, title, manifest_json, risk_tier, requires_release, enabled, created_at, updated_at, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8,$8,$9) ON CONFLICT (skill_id) DO NOTHING`,
    [s.id, s.kind, s.version, s.title, JSON.stringify(s.manifest), s.riskTier, s.requiresRelease, now, by]);
}

async function seed(now: number): Promise<void> {
  for (const m of BUILTIN_INTERPRETATION) {
    const v = validateManifest(m);
    if (!v.ok) throw new Error(`built-in skill "${m.id}" has an invalid manifest: ${v.errors.join('; ')}`);
  }
  await ensureTenantAuditReady();
  const catalogue = readAgentSkillCatalogue();
  await db.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('anuclaw:skill-registry:seed'))`);
    for (const s of catalogue) {
      await insertSkillIfMissing(tx, { id: s.id, kind: 'agent', version: 'file', title: s.title, manifest: { description: s.description }, riskTier: 'ruo', requiresRelease: false }, now, 'sync');
    }
    for (const m of BUILTIN_INTERPRETATION) {
      await insertSkillIfMissing(tx, { id: m.id, kind: 'interpretation', version: m.version, title: m.title, manifest: m, riskTier: m.riskTier, requiresRelease: m.requiresRelease }, now, 'seed');
    }

    // One-time grandfathering. Skipped (and retried next start) if no agent skills were found, so a wrong working
    // directory can never burn the marker and leave existing tenants without access.
    if (catalogue.length === 0) return;
    const done = await tx.query('SELECT 1 FROM registry_state WHERE key = $1', [GRANDFATHER_MARKER]);
    if (done.rows.length) return;
    const skillIds = (await tx.query(`SELECT skill_id FROM skills WHERE kind = 'agent' ORDER BY skill_id`)).rows.map((r: any) => String(r.skill_id));
    const tenants = await tx.query('SELECT tenant_id FROM tenants');
    for (const t of tenants.rows) {
      for (const id of skillIds) {
        await tx.query(
          `INSERT INTO tenant_skills (tenant_id, skill_id, enabled, config_json, assigned_at, assigned_by) VALUES ($1,$2,TRUE,'{}',$3,'migration') ON CONFLICT DO NOTHING`,
          [t.tenant_id, id, now]);
      }
      await recordTenantEvent(tx, String(t.tenant_id), ZERO_CTX, 'tenant.skills.grandfathered', { skill_ids: skillIds, reason: 'existing tenant kept its access when the skill gate was introduced' });
    }
    await tx.query(`INSERT INTO registry_state (key, value, updated_at) VALUES ($1,$2,$3)`, [GRANDFATHER_MARKER, JSON.stringify({ tenants: tenants.rows.length, skills: skillIds.length }), now]);
  });
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────

export async function listSkills(): Promise<SkillRecord[]> {
  await ensureSkillRegistry();
  return (await db.query(`SELECT ${SKILL_COLS} FROM skills ORDER BY kind, skill_id`)).map(toSkill);
}

export async function getSkill(skillId: string): Promise<SkillRecord | undefined> {
  if (!SKILL_ID_RE.test(skillId)) return undefined;
  await ensureSkillRegistry();
  const r = await db.queryOne(`SELECT ${SKILL_COLS} FROM skills WHERE skill_id = $1`, [skillId]);
  return r ? toSkill(r) : undefined;
}

export interface TenantSkillView { skill: SkillRecord; assignment: AssignmentRecord }

export async function listTenantSkills(tenantId: string): Promise<TenantSkillView[]> {
  await ensureSkillRegistry();
  const rows = await db.query(
    `SELECT ${SKILL_COLS.split(', ').map((c) => `s.${c}`).join(', ')}, a.tenant_id, a.enabled AS a_enabled, a.config_json, a.assigned_at, a.assigned_by
       FROM tenant_skills a JOIN skills s ON s.skill_id = a.skill_id WHERE a.tenant_id = $1 ORDER BY s.kind, s.skill_id`, [tenantId]);
  return rows.map((r: any) => ({
    skill: toSkill(r),
    assignment: toAssignment({ tenant_id: r.tenant_id, skill_id: r.skill_id, enabled: r.a_enabled, config_json: r.config_json, assigned_at: r.assigned_at, assigned_by: r.assigned_by }),
  }));
}

/** The skills a tenant may actually run right now: assigned, assignment enabled and skill enabled. */
export async function listUsableSkills(tenantId: string, kind?: SkillKind): Promise<SkillRecord[]> {
  return (await listTenantSkills(tenantId))
    .filter((v) => v.assignment.enabled && v.skill.enabled && (!kind || v.skill.kind === kind))
    .map((v) => v.skill);
}

// ── the access decision ─────────────────────────────────────────────────────────────────────────

/** Why a tenant lacks clinical-tier access, or null when it has it (scope, active BAA and the domain are all required). */
export function clinicalAccessProblem(
  tenant: Pick<Tenant, 'scopes' | 'baa_status' | 'allowed_clinical_domains'>, domain: string | undefined,
): string | null {
  if (!tenant.scopes?.includes('clinical')) return 'the tenant has not been granted the clinical scope';
  if (tenant.baa_status !== 'active') return 'the tenant has no active BAA';
  if (!domain || !tenant.allowed_clinical_domains?.includes(domain)) return `the clinical domain "${domain ?? '?'}" is not enabled for the tenant`;
  return null;
}

export type SkillAccess =
  | { ok: true; skill: SkillRecord; assignment: AssignmentRecord }
  | { ok: false; status: number; code: string; message: string };

const NOT_ASSIGNED: SkillAccess = { ok: false, status: 403, code: 'skill_not_assigned', message: 'This skill is not assigned to your account.' };

/** The single decision point. Unknown, malformed and unassigned skills all get the same answer. */
export async function checkSkillAccess(tenant: Tenant, skillId: string): Promise<SkillAccess> {
  const skill = await getSkill(skillId);
  if (!skill) return NOT_ASSIGNED;
  const a = await db.queryOne(`SELECT tenant_id, skill_id, enabled, config_json, assigned_at, assigned_by FROM tenant_skills WHERE tenant_id = $1 AND skill_id = $2`, [tenant.tenant_id, skillId]);
  if (!a) return NOT_ASSIGNED;
  const assignment = toAssignment(a);
  if (!assignment.enabled) return NOT_ASSIGNED;
  if (!skill.enabled) return { ok: false, status: 403, code: 'skill_disabled', message: 'This skill is currently disabled.' };
  if (skill.requires_release) return { ok: false, status: 403, code: 'skill_not_released', message: 'This skill has not been released for use.' };
  if (skill.risk_tier === 'clinical') {
    const domain = typeof skill.manifest.clinicalDomain === 'string' ? skill.manifest.clinicalDomain : undefined;
    if (clinicalAccessProblem(tenant, domain)) return { ok: false, status: 403, code: 'clinical_access_required', message: 'This skill requires clinical-tier access for your account.' };
  }
  if (skill.kind === 'interpretation') {
    const adapterId = typeof skill.manifest.adapterId === 'string' ? skill.manifest.adapterId : '';
    if (!isAdapterAvailable(adapterId)) return { ok: false, status: 503, code: 'skill_unavailable', message: 'This skill is not available yet.' };
  }
  return { ok: true, skill, assignment };
}

// ── administrator operations (each audited in the same transaction) ─────────────────────────────

function cleanConfig(config: unknown): Record<string, unknown> {
  if (config === undefined || config === null) return {};
  if (typeof config !== 'object' || Array.isArray(config)) throw new TenancyError(400, 'validation_failed', 'config must be a JSON object.');
  if (Buffer.byteLength(JSON.stringify(config)) > MAX_CONFIG_BYTES) throw new TenancyError(400, 'validation_failed', `config must be at most ${MAX_CONFIG_BYTES} bytes.`);
  const problem = validateNarrativeConfig((config as Record<string, unknown>).narrative);
  if (problem) throw new TenancyError(400, 'validation_failed', problem);
  return config as Record<string, unknown>;
}

/** Registers a new interpretation skill from a manifest. Agent skills come from the file system, never from this call. */
export async function registerInterpretationSkill(manifestInput: unknown, ctx: AuditCtx, now = Date.now()): Promise<SkillRecord> {
  const v = validateManifest(manifestInput);
  if (!v.ok) throw new TenancyError(400, 'invalid_manifest', v.errors.join('; '));
  const m = v.manifest;
  await ensureSkillRegistry();
  return db.transaction(async (tx) => {
    const exists = await tx.query('SELECT 1 FROM skills WHERE skill_id = $1', [m.id]);
    if (exists.rows.length) throw new TenancyError(409, 'skill_exists', `A skill with id "${m.id}" already exists.`);
    await tx.query(
      `INSERT INTO skills (skill_id, kind, version, title, manifest_json, risk_tier, requires_release, enabled, created_at, updated_at, updated_by)
       VALUES ($1,'interpretation',$2,$3,$4,$5,$6,TRUE,$7,$7,$8)`,
      [m.id, m.version, m.title, JSON.stringify(m), m.riskTier, m.requiresRelease, now, ctx.actor]);
    await recordTenantEvent(tx, PLATFORM_AUDIT_ID, ctx, 'skill.registered', { skill_id: m.id, version: m.version, adapter_id: m.adapterId, risk_tier: m.riskTier, requires_release: m.requiresRelease });
    return toSkill((await tx.query(`SELECT ${SKILL_COLS} FROM skills WHERE skill_id = $1`, [m.id])).rows[0]);
  });
}

export interface SkillPatch { enabled?: unknown; manifest?: unknown }

/** Enable/disable any skill; replace an interpretation skill's manifest with a new VERSION of itself. */
export async function updateSkill(skillId: string, patch: SkillPatch, ctx: AuditCtx, now = Date.now()): Promise<SkillRecord> {
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new TenancyError(400, 'validation_failed', 'enabled must be true or false.');
  if (patch.enabled === undefined && patch.manifest === undefined) throw new TenancyError(400, 'validation_failed', 'Nothing to change: send enabled and/or manifest.');
  await ensureSkillRegistry();
  return db.transaction(async (tx) => {
    const cur = await tx.query(`SELECT ${SKILL_COLS} FROM skills WHERE skill_id = $1 FOR UPDATE`, [skillId]);
    if (!cur.rows.length) throw new TenancyError(404, 'skill_not_found', 'Skill not found.');
    const before = toSkill(cur.rows[0]);
    let next = { version: before.version, title: before.title, manifest_json: JSON.stringify(before.manifest), risk_tier: before.risk_tier, requires_release: before.requires_release };
    if (patch.manifest !== undefined) {
      if (before.kind !== 'interpretation') throw new TenancyError(400, 'validation_failed', 'Only an interpretation skill has a manifest; agent skills are defined by their SKILL.md file.');
      const v = validateManifest(patch.manifest);
      if (!v.ok) throw new TenancyError(400, 'invalid_manifest', v.errors.join('; '));
      if (v.manifest.id !== skillId) throw new TenancyError(400, 'invalid_manifest', 'The manifest id must match the skill being updated.');
      if (v.manifest.version === before.version) throw new TenancyError(400, 'version_unchanged', 'A manifest change needs a new version number.');
      next = { version: v.manifest.version, title: v.manifest.title, manifest_json: JSON.stringify(v.manifest), risk_tier: v.manifest.riskTier, requires_release: v.manifest.requiresRelease };
    }
    const enabled = patch.enabled === undefined ? before.enabled : (patch.enabled as boolean);
    const u = await tx.query(
      `UPDATE skills SET version = $2, title = $3, manifest_json = $4, risk_tier = $5, requires_release = $6, enabled = $7, updated_at = $8, updated_by = $9
        WHERE skill_id = $1 RETURNING ${SKILL_COLS}`,
      [skillId, next.version, next.title, next.manifest_json, next.risk_tier, next.requires_release, enabled, now, ctx.actor]);
    const after = toSkill(u.rows[0]);
    await recordTenantEvent(tx, PLATFORM_AUDIT_ID, ctx, 'skill.updated', {
      skill_id: skillId,
      before: { version: before.version, enabled: before.enabled, risk_tier: before.risk_tier, requires_release: before.requires_release },
      after: { version: after.version, enabled: after.enabled, risk_tier: after.risk_tier, requires_release: after.requires_release },
    });
    return after;
  });
}

export async function assignSkill(
  tenantId: string, skillId: string, input: { enabled?: unknown; config?: unknown }, ctx: AuditCtx, now = Date.now(),
): Promise<{ assignment: AssignmentRecord; created: boolean }> {
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new TenancyError(400, 'validation_failed', 'enabled must be true or false.');
  const config = cleanConfig(input.config);
  await ensureSkillRegistry();
  return db.transaction(async (tx) => {
    const t = await tx.query('SELECT * FROM tenants WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
    if (!t.rows.length) throw new TenancyError(404, 'tenant_not_found', 'Tenant not found.');
    const s = await tx.query(`SELECT ${SKILL_COLS} FROM skills WHERE skill_id = $1`, [skillId]);
    if (!s.rows.length) throw new TenancyError(404, 'skill_not_found', 'Skill not found.');
    const skill = toSkill(s.rows[0]);
    if (!skill.enabled) throw new TenancyError(409, 'skill_disabled', 'A disabled skill cannot be assigned.');
    if (skill.kind === 'interpretation') {
      const adapterId = String(skill.manifest.adapterId ?? '');
      if (!isAdapterAvailable(adapterId)) {
        throw new TenancyError(409, 'adapter_not_available', `The adapter "${adapterId}" (${getAdapter(adapterId) ? 'declared, not implemented yet' : 'unknown'}) is not available, so this skill cannot be assigned yet.`);
      }
    }
    if (skill.risk_tier === 'clinical') {
      const problem = clinicalAccessProblem(mapTenantRow(t.rows[0]), typeof skill.manifest.clinicalDomain === 'string' ? skill.manifest.clinicalDomain : undefined);
      if (problem) throw new TenancyError(409, 'clinical_access_required', `This is a clinical-tier skill and ${problem}.`);
    }
    const existing = await tx.query('SELECT 1 FROM tenant_skills WHERE tenant_id = $1 AND skill_id = $2', [tenantId, skillId]);
    const created = existing.rows.length === 0;
    const enabled = input.enabled === undefined ? true : (input.enabled as boolean);
    const r = await tx.query(
      `INSERT INTO tenant_skills (tenant_id, skill_id, enabled, config_json, assigned_at, assigned_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, skill_id) DO UPDATE SET enabled = $3, config_json = $4
       RETURNING tenant_id, skill_id, enabled, config_json, assigned_at, assigned_by`,
      [tenantId, skillId, enabled, JSON.stringify(config), now, ctx.actor]);
    await recordTenantEvent(tx, tenantId, ctx, created ? 'tenant.skill.assigned' : 'tenant.skill.updated', { skill_id: skillId, kind: skill.kind, enabled, config_keys: Object.keys(config).sort() });
    return { assignment: toAssignment(r.rows[0]), created };
  });
}

export async function unassignSkill(tenantId: string, skillId: string, ctx: AuditCtx): Promise<void> {
  await ensureSkillRegistry();
  await db.transaction(async (tx) => {
    const t = await tx.query('SELECT 1 FROM tenants WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
    if (!t.rows.length) throw new TenancyError(404, 'tenant_not_found', 'Tenant not found.');
    const d = await tx.query('DELETE FROM tenant_skills WHERE tenant_id = $1 AND skill_id = $2 RETURNING skill_id', [tenantId, skillId]);
    if (!d.rows.length) throw new TenancyError(404, 'assignment_not_found', 'That skill is not assigned to this tenant.');
    await recordTenantEvent(tx, tenantId, ctx, 'tenant.skill.unassigned', { skill_id: skillId });
  });
}
