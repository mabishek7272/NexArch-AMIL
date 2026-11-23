/** Narrative generation (P4b) with a STUBBED model call: no network, no key, synthetic data only. */
import { describe, expect, it, vi } from 'vitest';
import type { ModelCallArgs, ProbeRecord } from '../../ai/openrouter';
import { deterministicNarrative } from './deterministic';
import { generateNarratives } from './generate';
import { buildNarrativeInput } from './input';
import { buildMessages, promptFor, PROMPTS as PROMPTS_ALL, PROMPT_ALIASES } from './prompts';
import { resolveNarrativeSettings, validateNarrativeConfig, narrativeModelAllowList } from './settings';
import type { Layer, Narrative } from './types';
import { posture, vitals } from './fixtures';

const MODEL = 'google/gemini-4-hydrogen';
const PROMPTS = { clinical: 'clinical-vitals/v1', layman: 'layman-vitals/v1' };
const { doc, gov } = vitals();
const ENABLED = { enabled: true as const, model: MODEL };

const respond = (n: unknown | string, over: Partial<ProbeRecord> = {}): ProbeRecord => ({
  role: 'review', requestedModel: MODEL, status: 'ok', returnedModel: MODEL, identity: 'exact', latencyMs: 1, attempts: 1,
  usage: { prompt_tokens: 10, completion_tokens: 20 }, egress: { mode: 'deidentified', redactions: 0 },
  data: { choices: [{ message: { content: typeof n === 'string' ? n : JSON.stringify(n) } }] }, ...over,
});
const failure = (status: ProbeRecord['status']): ProbeRecord => ({ role: 'review', requestedModel: MODEL, status, latencyMs: 1, attempts: 1 });
const layerOf = (a: ModelCallArgs): Layer => (String(a.groupId).endsWith('-clinical') ? 'clinical' : 'layman');
const good = (l: Layer): Narrative => deterministicNarrative(l, doc, gov); // a valid narrative a model could plausibly produce
const bad = (l: Layer): Narrative => { const n = good(l); n.sections[1].text += ' It was 999 yesterday.'; return n; }; // an invented number
const run = (call: (a: ModelCallArgs) => Promise<ProbeRecord>, over: Record<string, unknown> = {}) =>
  generateNarratives({ doc, gov, settings: ENABLED, tenantId: 'tenant-synth', prompts: PROMPTS, ...over } as any, { call: call as any });

describe('a model narrative that passes every guard', () => {
  it('is used for both layers, with one call each, as the tenant\'s model, role review, tenant scope', async () => {
    const calls: ModelCallArgs[] = [];
    const r = await run(async (a) => { calls.push(a); return respond(good(layerOf(a))); });
    expect(r.mode).toBe('model'); expect(r.flags).toEqual([]);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toMatchObject({ role: 'review', model: MODEL, path: '/chat/completions', dataClass: 'patient_derived', scope: { kind: 'tenant', id: 'tenant-synth' } });
    expect((calls[0].body as any).response_format).toEqual({ type: 'json_object' });
    for (const l of ['clinical', 'layman'] as Layer[]) expect(r.layers[l]).toMatchObject({ source: 'model', attempts: 1, problems: [], modelRequested: MODEL, modelReturned: MODEL });
    expect(r.narratives.clinical).toEqual(good('clinical'));
    expect(r.promptVersions).toEqual({ clinical: 'clinical-vitals/v2', layman: 'layman-vitals/v2' }); // provenance names the text actually used
  });
  it('tolerates a fenced JSON block', async () => {
    const r = await run(async (a) => respond('```json\n' + JSON.stringify(good(layerOf(a))) + '\n```'));
    expect(r.mode).toBe('model');
  });
});

describe('what the model is sent', () => {
  it('contains no identity, subject reference, job or tenant id, and no excluded finding', async () => {
    const p = posture('unsigned');
    const calls: ModelCallArgs[] = [];
    await generateNarratives({ doc: p.doc, gov: p.gov, settings: ENABLED, tenantId: 'tenant-synth', prompts: { clinical: 'clinical-posture/v1', layman: 'layman-posture/v1' } },
      { call: (async (a: ModelCallArgs) => { calls.push(a); return failure('unavailable'); }) as any });
    const sent = JSON.stringify(calls.map((c) => c.body));
    for (const secret of [p.doc.subjectRef, p.doc.jobId, p.doc.tenantId, 'tenant-synth', 'head_forward_offset', 'Head forward offset', 'synthetic exclusion', 'clin-synthetic', p.doc.provenance.originalPayloadSha256]) expect(sent, secret).not.toContain(secret);
    expect(sent).toContain('shoulder_height_difference.bilateral'); // but the included finding is there
  });
  it('gives flags as type/severity/keys only (no prose, so no numbers from flag text)', () => {
    const i = buildNarrativeInput('clinical', doc, gov);
    for (const f of i.flags) expect(Object.keys(f).every((k) => ['type', 'severity', 'findingKeys'].includes(k))).toBe(true);
    expect(JSON.stringify(i)).not.toContain(doc.subjectRef);
    expect(i.referralNoticeAdded).toBe(true);
  });
  it('no prompt asks for wording the guards reject (found live: the v1 layman prompt asked for a reassuring negation)', () => {
    for (const id of Object.keys(PROMPTS_ALL)) {
      const text = PROMPTS_ALL[id].system;
      expect(text, id).not.toMatch(/on its own mean anything is wrong|nothing to worry|no cause for concern|is perfectly safe/i);
      expect(text, id).toMatch(/Never use a negation that reassures/);
    }
    // the older ids a manifest may still name resolve to the current text, and the effective id is what a report records
    for (const [old, now] of Object.entries(PROMPT_ALIASES)) { const layer = old.startsWith('clinical') ? 'clinical' : 'layman'; expect(promptFor(old, layer)?.id).toBe(now); }
  });
  it('the system prompt forbids what the guards forbid, and the user message is data', () => {
    const def = promptFor('layman-vitals/v1', 'layman')!;
    const msgs = buildMessages(def, buildNarrativeInput('layman', doc, gov));
    expect(msgs[0].content).toMatch(/Never state or imply a diagnosis/); expect(msgs[0].content).toMatch(/NO numbers/); expect(msgs[0].content).toMatch(/never write, shorten or contradict/);
    expect(msgs[1].content.startsWith('Findings (JSON):')).toBe(true);
    expect(promptFor('layman-vitals/v1', 'clinical')).toBeUndefined(); // a prompt only serves its own layer
    expect(promptFor('nonsense/v1', 'clinical')).toBeUndefined();
  });
});

describe('guard failures: one bounded retry, then the fixed template', () => {
  it('retries once with only the machine codes, and uses the second answer if it passes', async () => {
    const seen: Array<{ layer: Layer; user: string }> = [];
    const attempts: Record<string, number> = {};
    const r = await run(async (a) => {
      const l = layerOf(a); attempts[l] = (attempts[l] ?? 0) + 1;
      seen.push({ layer: l, user: (a.body as any).messages[1].content });
      return respond(attempts[l] === 1 ? bad(l) : good(l));
    });
    expect(r.mode).toBe('model');
    for (const l of ['clinical', 'layman'] as Layer[]) expect(r.layers[l]).toMatchObject({ source: 'model', attempts: 2 });
    const second = seen.filter((s) => s.user.includes('rejected by automatic checks'));
    expect(second).toHaveLength(2);
    for (const s of second) { expect(s.user).toContain('number_not_in_cited_findings'); expect(s.user).not.toContain('999'); expect(s.user).not.toContain('yesterday'); }
  });
  it('after two failures that layer uses the fixed template, a review_required flag is added, and no more than 2 calls were made for it', async () => {
    let n = 0;
    const r = await run(async (a) => { n++; return layerOf(a) === 'layman' ? respond(bad('layman')) : respond(good('clinical')); });
    expect(n).toBe(1 + 2);
    expect(r.layers.clinical.source).toBe('model');
    expect(r.layers.layman).toMatchObject({ source: 'deterministic', attempts: 2, fallbackReason: 'guard_failed' });
    expect(r.layers.layman.problems.map((p) => p.code)).toContain('number_not_in_cited_findings');
    expect(r.narratives.layman).toEqual(good('layman'));
    expect(r.mode).toBe('model_fallback');
    expect(r.flags).toEqual([expect.objectContaining({ type: 'review_required', severity: 'attention' })]);
    expect(r.flags[0].detail).toContain('layman');
  });
  it.each([
    ['diagnostic wording', (n: Narrative) => { n.limitations = 'This suggests diabetes.'; }],
    ['reassurance', (n: Narrative) => { n.sections[1].text += ' This is reassuring.'; }],
    ['a missing citation', (n: Narrative) => { n.sections[1].findingRefs = []; }],
    ['an uncited out-of-range finding', (n: Narrative) => { n.sections = n.sections.filter((s) => !s.findingRefs.includes('heart_rate_bpm')); }],
    ['markup', (n: Narrative) => { n.sections[1].text += ' <script>x</script>'; }],
    ['a number in the next steps', (n: Narrative) => { n.nextSteps = ['Repeat in 2 weeks.']; }],
  ])('a model answer with %s is never used', async (_label, mutate) => {
    const r = await run(async (a) => { const n = good(layerOf(a)); mutate(n); return respond(n); });
    expect(r.layers.clinical.source).toBe('deterministic'); expect(r.layers.layman.source).toBe('deterministic');
    expect(r.mode).toBe('model_fallback');
  });
  it('unparseable and structurally wrong answers are retried, then replaced', async () => {
    const kinds = ['this is not json', { sections: 'nope' }, { ...good('clinical'), extra: 1 }];
    for (const k of kinds) {
      let n = 0;
      const r = await run(async () => { n++; return respond(k as any); });
      expect(n).toBe(4); expect(r.mode).toBe('model_fallback'); expect(r.layers.clinical.attempts).toBe(2);
    }
  });
  it('a malformed answer followed by a good one is accepted', async () => {
    const t: Record<string, number> = {};
    const r = await run(async (a) => { const l = layerOf(a); t[l] = (t[l] ?? 0) + 1; return t[l] === 1 ? respond('{ not json') : respond(good(l)); });
    expect(r.mode).toBe('model');
  });
});

describe('everything that is not an accepted model answer ends in the fixed template, never in another model', () => {
  it.each(['spend_limit_reached', 'model_mismatch', 'unavailable', 'timeout', 'http_error', 'blocked_by_policy', 'blocked_by_egress_policy', 'output_blocked_by_policy', 'not_configured', 'malformed'] as const)(
    'status %s: one call per layer, no retry, deterministic text and a flag', async (status) => {
      let n = 0; const models = new Set<unknown>();
      const r = await run(async (a) => { n++; models.add(a.model); return failure(status); });
      expect(n).toBe(2); expect([...models]).toEqual([MODEL]);
      expect(r.mode).toBe('model_fallback');
      for (const l of ['clinical', 'layman'] as Layer[]) expect(r.layers[l]).toMatchObject({ source: 'deterministic', attempts: 1, fallbackReason: `model_${status}` });
      expect(r.narratives.layman).toEqual(good('layman'));
      expect(r.flags).toHaveLength(1);
    });
  it('narratives off (the default): no call at all, deterministic text, no flag', async () => {
    const call = vi.fn();
    const r = await generateNarratives({ doc, gov, settings: { enabled: false, reason: 'not_enabled' }, tenantId: 't', prompts: PROMPTS }, { call: call as any });
    expect(call).not.toHaveBeenCalled(); expect(r.mode).toBe('deterministic'); expect(r.flags).toEqual([]);
    expect(r.layers.clinical).toMatchObject({ source: 'deterministic', attempts: 0, fallbackReason: 'not_enabled' });
  });
  it.each(['model_not_allowed', 'invalid_setting'] as const)('narratives enabled but unusable (%s): no call, deterministic text, and the admin is told with a flag', async (reason) => {
    const call = vi.fn();
    const r = await generateNarratives({ doc, gov, settings: { enabled: false, reason }, tenantId: 't', prompts: PROMPTS }, { call: call as any });
    expect(call).not.toHaveBeenCalled(); expect(r.mode).toBe('model_fallback'); expect(r.flags).toHaveLength(1);
  });
  it('an unknown prompt id is a deterministic fallback for that layer, with no call for it', async () => {
    const call = vi.fn(async (a: ModelCallArgs) => respond(good(layerOf(a))));
    const r = await generateNarratives({ doc, gov, settings: ENABLED, tenantId: 't', prompts: { clinical: 'nonsense/v1', layman: 'layman-vitals/v1' } }, { call: call as any });
    expect(r.layers.clinical).toMatchObject({ source: 'deterministic', attempts: 0, fallbackReason: 'prompt_unknown' });
    expect(call).toHaveBeenCalledTimes(1); // only the layer with a known prompt asked a model
    expect(r.layers.layman.source).toBe('model');
  });
  it('a lost claim stops before any further model call', async () => {
    const call = vi.fn(async () => respond(good('clinical')));
    const r = await generateNarratives({ doc, gov, settings: ENABLED, tenantId: 't', prompts: PROMPTS, heartbeat: async () => false }, { call: call as any });
    expect(call).not.toHaveBeenCalled(); expect(r.layers.clinical.fallbackReason).toBe('claim_lost');
  });
});

describe('per-tenant settings', () => {
  const env = {} as NodeJS.ProcessEnv;
  it('default off, and only an allow-listed model can be enabled', () => {
    expect(resolveNarrativeSettings(undefined, env)).toEqual({ enabled: false, reason: 'not_enabled' });
    expect(resolveNarrativeSettings({}, env)).toEqual({ enabled: false, reason: 'not_enabled' });
    expect(resolveNarrativeSettings({ narrative: { enabled: false, model: MODEL } }, env)).toEqual({ enabled: false, reason: 'not_enabled' });
    expect(resolveNarrativeSettings({ narrative: { enabled: true, model: MODEL } }, env)).toEqual({ enabled: true, model: MODEL });
    expect(resolveNarrativeSettings({ narrative: { enabled: true, model: 'google/gemini-4-argon' } }, env)).toEqual({ enabled: true, model: 'google/gemini-4-argon' });
    expect(resolveNarrativeSettings({ narrative: { enabled: true, model: 'google/gemini-4-neon' } }, env)).toEqual({ enabled: false, reason: 'model_not_allowed' });
    expect(resolveNarrativeSettings({ narrative: { enabled: true } }, env)).toEqual({ enabled: false, reason: 'invalid_setting' });
    expect(resolveNarrativeSettings({ narrative: 'yes' }, env)).toEqual({ enabled: false, reason: 'invalid_setting' });
  });
  it('the allow-list is re-checked at run time and can be overridden by the environment', () => {
    const env2 = { ANUCLAW_NARRATIVE_MODELS: 'google/gemini-4-argon' } as NodeJS.ProcessEnv;
    expect(narrativeModelAllowList(env2)).toEqual(['google/gemini-4-argon']);
    expect(resolveNarrativeSettings({ narrative: { enabled: true, model: MODEL } }, env2)).toEqual({ enabled: false, reason: 'model_not_allowed' });
  });
  it('save-time validation names the problem without echoing values', () => {
    expect(validateNarrativeConfig(undefined, env)).toBeNull();
    expect(validateNarrativeConfig({ enabled: true, model: MODEL }, env)).toBeNull();
    expect(validateNarrativeConfig({ enabled: false }, env)).toBeNull();
    for (const bad of ['x', [], { enabled: 'yes' }, { enabled: true }, { enabled: true, model: 'not/allowed' }, { enabled: true, model: MODEL, extra: 1 }, { model: 5 }]) expect(validateNarrativeConfig(bad, env), JSON.stringify(bad)).toEqual(expect.any(String));
  });
});
