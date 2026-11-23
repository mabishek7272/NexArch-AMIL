/**
 * Per-tenant narrative settings (interpretation engine, P4b), read from the skill-assignment config
 * (`tenant_skills.config_json`, key `narrative`): `{ "enabled": boolean, "model": "<allow-listed id>" }`.
 *
 * Default OFF: with no setting, a tenant gets the deterministic text only and no model is ever called. That is also the
 * per-tenant "budget zero". A model is used only if it is on the allow-list; dollar limits come from the existing daily
 * per-scope budget (ANUCLAW_MODEL_DAILY_BUDGET_PER_SCOPE_USD), enforced by `modelCall`.
 */
export const DEFAULT_NARRATIVE_MODELS = ['google/gemini-4-hydrogen', 'google/gemini-4-argon'];

export function narrativeModelAllowList(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.ANUCLAW_NARRATIVE_MODELS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_NARRATIVE_MODELS;
  return raw.split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9._/:-]{3,120}$/.test(s));
}

export type NarrativeSettings = { enabled: true; model: string } | { enabled: false; reason: 'not_enabled' | 'invalid_setting' | 'model_not_allowed' };

/** Returns a problem message (echoing at most the model id) when a `narrative` block is not acceptable; used at admin-save time. */
export function validateNarrativeConfig(block: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  if (block === undefined) return null;
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return 'narrative must be an object like {"enabled": true, "model": "google/gemini-4-hydrogen"}';
  const b = block as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'enabled' && k !== 'model') return `narrative has an unknown field "${k}"`;
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return 'narrative.enabled must be true or false';
  if (b.model !== undefined && typeof b.model !== 'string') return 'narrative.model must be a model id';
  if (b.enabled === true) {
    if (typeof b.model !== 'string') return 'narrative.model is required when narrative is enabled';
    if (!narrativeModelAllowList(env).includes(b.model)) return `narrative.model "${b.model.slice(0, 80)}" is not on the allow-list (${narrativeModelAllowList(env).join(', ')})`;
  }
  return null;
}

/** Runtime resolution: the allow-list is re-checked, because it may have changed since the setting was saved. */
export function resolveNarrativeSettings(config: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv = process.env): NarrativeSettings {
  const block = config?.narrative;
  if (block === undefined) return { enabled: false, reason: 'not_enabled' };
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return { enabled: false, reason: 'invalid_setting' };
  const b = block as { enabled?: unknown; model?: unknown };
  if (b.enabled !== true) return { enabled: false, reason: 'not_enabled' };
  if (typeof b.model !== 'string') return { enabled: false, reason: 'invalid_setting' };
  if (!narrativeModelAllowList(env).includes(b.model)) return { enabled: false, reason: 'model_not_allowed' };
  return { enabled: true, model: b.model };
}
