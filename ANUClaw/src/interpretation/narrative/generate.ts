/**
 * Narrative generation (interpretation engine, P4b): the only place a model is asked to explain findings.
 *
 * For each layer (clinical, layman) it makes at most two guarded `modelCall`s (the second only after a shape/guard
 * failure, told the machine codes of what failed, never the rejected text). The first accepted narrative wins; if none is
 * accepted, or no model may be used at all, the deterministic text is used and a `review_required` flag says so.
 *
 * Fail closed: narratives off (the default), a model not on the allow-list, a spend refusal, a hook block, a model-identity
 * mismatch, an HTTP or timeout failure or an unusable response all end in deterministic text. It NEVER falls back to a
 * different model. A transport-level failure is not retried here (the transport already retried once), so one layer can
 * cost at most two calls.
 */
import { modelCall, type ModelCallArgs, type ProbeRecord } from '../../ai/openrouter';
import { parseJsonContent } from '../../ai/adapters';
import type { NormalizedFlag } from '../adapters/types';
import type { FindingsDoc, GovernanceDoc } from '../governance/types';
import { deterministicNarrative } from './deterministic';
import { checkNarrative, layersAgree, shapeNarrative } from './guards';
import { buildNarrativeInput } from './input';
import { buildMessages, promptFor } from './prompts';
import type { GuardProblem, Layer, LayerRecord, Narrative, NarrativeResult } from './types';
import { LAYERS } from './types';
import type { NarrativeSettings } from './settings';

export interface GenerateDeps {
  call?: (args: ModelCallArgs) => Promise<ProbeRecord>;
  /** `patient_derived` in production (egress de-identification applies); tests may use `synthetic_test`. */
  dataClass?: ModelCallArgs['dataClass'];
}

export interface GenerateArgs {
  doc: FindingsDoc; gov: GovernanceDoc; settings: NarrativeSettings; tenantId: string;
  /** manifest.prompts: the prompt id per layer. */
  prompts: Partial<Record<Layer, string>>;
  /** Extends the report lease while the (slow) calls run. */
  heartbeat?: () => Promise<boolean>;
}

const MAX_CALLS_PER_LAYER = 2;
/** Room for low-effort reasoning plus the JSON answer (about 1,500 tokens for four to six sections). */
export const NARRATIVE_MAX_TOKENS = 6000;
const NOT_RETRIED = new Set(['spend_limit_reached', 'blocked_by_policy', 'blocked_by_egress_policy', 'output_blocked_by_policy', 'not_configured', 'model_mismatch', 'unavailable', 'http_error', 'timeout', 'malformed']);

async function modelLayer(layer: Layer, a: GenerateArgs & { settings: { enabled: true; model: string } }, deps: GenerateDeps): Promise<{ narrative: Narrative | null; record: LayerRecord }> {
  const def = promptFor(a.prompts[layer], layer);
  const record: LayerRecord = { source: 'deterministic', attempts: 0, problems: [], modelRequested: a.settings.model };
  if (!def) { record.fallbackReason = 'prompt_unknown'; return { narrative: null, record }; }
  const input = buildNarrativeInput(layer, a.doc, a.gov);
  const call = deps.call ?? modelCall;
  let feedback: string[] | undefined;

  for (let attempt = 1; attempt <= MAX_CALLS_PER_LAYER; attempt++) {
    if (a.heartbeat && !(await a.heartbeat())) { record.fallbackReason = 'claim_lost'; return { narrative: null, record }; }
    record.attempts = attempt;
    const res = await call({
      role: 'review', path: '/chat/completions', dataClass: deps.dataClass ?? 'patient_derived', model: a.settings.model,
      groupId: `narrative-${a.doc.jobId}-${layer}`, scope: { kind: 'tenant', id: a.tenantId }, retries: 1,
      // A reasoning model spends its output budget on hidden reasoning first: with a small cap (found live with google/gemini-4-hydrogen) it used all
      // 2500 tokens thinking and returned no text. Ask for low effort and leave room for the answer; cost stays bounded by max_tokens and the spend budget.
      body: { response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: NARRATIVE_MAX_TOKENS, reasoning: { effort: 'low' }, messages: buildMessages(def, input, feedback) },
    });
    record.modelReturned = res.returnedModel ?? record.modelReturned;
    if (res.usage) record.usage = res.usage;
    if (res.egress) record.egressRedactions = res.egress.redactions;
    if (res.status !== 'ok') { record.fallbackReason = `model_${res.status}`; if (NOT_RETRIED.has(res.status)) return { narrative: null, record }; continue; }

    const parsed = parseJsonContent(res.data);
    if (parsed === null) { record.problems = [{ code: 'malformed_json', severity: 'hard' }]; feedback = ['malformed_json']; record.fallbackReason = 'guard_failed'; continue; }
    const shaped = shapeNarrative(parsed);
    if (!shaped.value) { record.problems = shaped.problems; feedback = shaped.problems.map((p) => p.code); record.fallbackReason = 'guard_failed'; continue; }
    const checked = checkNarrative(layer, shaped.value, input);
    record.problems = checked.problems;
    if (checked.readingGrade !== undefined) record.readingGrade = checked.readingGrade;
    if (checked.ok) { record.source = 'model'; delete record.fallbackReason; return { narrative: shaped.value, record }; }
    feedback = checked.problems.filter((p) => p.severity === 'hard').map((p) => p.code);
    record.fallbackReason = 'guard_failed';
  }
  return { narrative: null, record };
}

export async function generateNarratives(a: GenerateArgs, deps: GenerateDeps = {}): Promise<NarrativeResult> {
  const narratives = {} as Record<Layer, Narrative>;
  const layers = {} as Record<Layer, LayerRecord>;
  // The id of the prompt text actually used (a manifest that names an older id resolves to the current text).
  const promptVersions = { clinical: promptFor(a.prompts.clinical, 'clinical')?.id ?? null, layman: promptFor(a.prompts.layman, 'layman')?.id ?? null } as Record<Layer, string | null>;
  const flags: NormalizedFlag[] = [];

  if (!a.settings.enabled) {
    for (const l of LAYERS) { narratives[l] = deterministicNarrative(l, a.doc, a.gov); layers[l] = { source: 'deterministic', attempts: 0, problems: [], fallbackReason: a.settings.reason }; }
    // Off by default is normal. An admin who ENABLED narratives with an unusable setting should hear about it.
    if (a.settings.reason !== 'not_enabled') {
      flags.push({ type: 'review_required', severity: 'attention', detail: 'Model explanations are configured for this account but could not be used, so a fixed template was used instead.' });
      return { mode: 'model_fallback', narratives, layers, promptVersions, flags };
    }
    return { mode: 'deterministic', narratives, layers, promptVersions, flags };
  }
  const settings = a.settings as { enabled: true; model: string };
  for (const l of LAYERS) {
    const r = await modelLayer(l, { ...a, settings }, deps);
    narratives[l] = r.narrative ?? deterministicNarrative(l, a.doc, a.gov);
    layers[l] = r.record;
  }
  // Both layers must describe the same findings. Each layer is already held to the same governance positions and the same
  // must-cite set, so this is a backstop: if it ever fails, the model text is dropped for the layer that is not deterministic.
  const input = buildNarrativeInput('clinical', a.doc, a.gov);
  if (!layersAgree(narratives.clinical, narratives.layman, input)) {
    for (const l of LAYERS) if (layers[l].source === 'model') { narratives[l] = deterministicNarrative(l, a.doc, a.gov); layers[l] = { ...layers[l], source: 'deterministic', fallbackReason: 'layers_disagree' }; }
  }
  const fellBack = LAYERS.filter((l) => layers[l].source === 'deterministic');
  if (fellBack.length) {
    flags.push({ type: 'review_required', severity: 'attention', detail: `The explanation for the ${fellBack.join(' and ')} report could not be checked and a fixed template was used instead.` });
  }
  return { mode: fellBack.length ? 'model_fallback' : 'model', narratives, layers, promptVersions, flags };
}

export type { GuardProblem };
