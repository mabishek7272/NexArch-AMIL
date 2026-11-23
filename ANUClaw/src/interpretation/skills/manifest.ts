/**
 * Interpretation-skill manifests (interpretation engine, P2). A skill is a registry row plus a CODE-defined adapter
 * and prompt set; the manifest is the declarative contract that ties them together. It is strict: unknown keys,
 * unknown adapters and analysis types the adapter cannot read are all refused, so an administrator cannot register
 * a skill that points at nothing.
 */
import { getAdapter } from './adapters';

export const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ANALYSIS_TYPE_RE = /^[a-z0-9_]{2,64}$/;
const PROMPT_ID_RE = /^[a-z0-9][a-z0-9/._-]{1,63}$/;
const DOMAIN_RE = /^[a-z0-9_]{2,40}$/;

export type RiskTier = 'ruo' | 'clinical';

export interface InterpretationManifest {
  id: string;
  version: string;
  title: string;
  acceptsAnalysisTypes: string[];
  adapterId: string;
  inputSchema: 'interpretation-request/v1';
  prompts: { clinical?: string; layman?: string };
  riskTier: RiskTier;
  /** Required for the clinical tier: the domain a tenant must have enabled (tenants.allowed_clinical_domains). */
  clinicalDomain?: string;
  /** A skill that makes clinical claims is refused at the gate until a release mechanism exists (fail closed). */
  requiresRelease: boolean;
}

const KEYS = new Set(['id', 'version', 'title', 'acceptsAnalysisTypes', 'adapterId', 'inputSchema', 'prompts', 'riskTier', 'clinicalDomain', 'requiresRelease']);

export type ManifestResult = { ok: true; manifest: InterpretationManifest } | { ok: false; errors: string[] };

export function validateManifest(input: unknown): ManifestResult {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, errors: ['manifest must be an object'] };
  const m = input as Record<string, unknown>;
  for (const k of Object.keys(m)) if (!KEYS.has(k)) errors.push(`unknown field "${k}"`);

  if (typeof m.id !== 'string' || !SKILL_ID_RE.test(m.id)) errors.push('id must match ^[a-z0-9][a-z0-9-]{1,63}$');
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) errors.push('version must be a semantic version such as 1.0.0');
  if (typeof m.title !== 'string' || m.title.trim().length < 1 || m.title.length > 200) errors.push('title is required (1-200 characters)');
  if (m.inputSchema !== 'interpretation-request/v1') errors.push('inputSchema must be "interpretation-request/v1"');
  if (m.riskTier !== 'ruo' && m.riskTier !== 'clinical') errors.push('riskTier must be "ruo" or "clinical"');
  if (typeof m.requiresRelease !== 'boolean') errors.push('requiresRelease must be true or false');

  if (m.riskTier === 'clinical') {
    if (typeof m.clinicalDomain !== 'string' || !DOMAIN_RE.test(m.clinicalDomain)) errors.push('a clinical-tier skill needs a clinicalDomain such as "cardiometabolic"');
  } else if (m.clinicalDomain !== undefined) {
    errors.push('clinicalDomain is only allowed for the clinical tier');
  }

  const types = m.acceptsAnalysisTypes;
  if (!Array.isArray(types) || types.length < 1 || types.length > 20 || !types.every((t) => typeof t === 'string' && ANALYSIS_TYPE_RE.test(t))) {
    errors.push('acceptsAnalysisTypes must list 1-20 analysis types such as "face_scan_vitals"');
  }

  const prompts = m.prompts as Record<string, unknown> | undefined;
  if (typeof prompts !== 'object' || prompts === null || Array.isArray(prompts)) {
    errors.push('prompts must be an object with a clinical and/or layman prompt id');
  } else {
    for (const k of Object.keys(prompts)) if (k !== 'clinical' && k !== 'layman') errors.push(`unknown prompt layer "${k}"`);
    if (prompts.clinical === undefined && prompts.layman === undefined) errors.push('prompts needs at least one of clinical, layman');
    for (const k of ['clinical', 'layman']) {
      if (prompts[k] !== undefined && (typeof prompts[k] !== 'string' || !PROMPT_ID_RE.test(prompts[k] as string))) errors.push(`prompts.${k} is not a valid prompt id`);
    }
  }

  if (typeof m.adapterId !== 'string' || !SKILL_ID_RE.test(m.adapterId)) {
    errors.push('adapterId must match ^[a-z0-9][a-z0-9-]{1,63}$');
  } else {
    const adapter = getAdapter(m.adapterId);
    if (!adapter) errors.push(`unknown adapterId "${m.adapterId}"`);
    else if (Array.isArray(types) && !adapter.analysisTypes.includes('*')) {
      const bad = (types as string[]).filter((t) => !adapter.analysisTypes.includes(t));
      if (bad.length) errors.push(`adapter "${adapter.id}" cannot read analysis type(s): ${bad.join(', ')}`);
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, manifest: m as unknown as InterpretationManifest };
}
