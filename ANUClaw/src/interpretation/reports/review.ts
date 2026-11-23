/**
 * Automatic review (interpretation engine, P4d). A deterministic audit of the assembled layers against the stored
 * findings and governance output: it is NOT a model and NOT a clinician. When every check passes the report is labelled
 * `ai_reviewed`; any failure, a blocking flag, or a narrative that fell back with a review flag routes it to
 * `awaiting_clinician`. This function can only ever return those two states: `clinician_signed` is reachable solely
 * through `signoff.ts`, which needs a named, provisioned clinician.
 *
 * The checks do not trust how the layers were produced (model or template): they re-derive what each layer must say
 * from the stored findings and re-run the narrative guards on the stored text.
 */
import type { FindingsDoc, GovernanceDoc } from '../governance/types';
import type { NormalizedFlag } from '../adapters/types';
import { checkNarrative, layersAgree } from '../narrative/guards';
import { buildNarrativeInput } from '../narrative/input';
import { LAYERS, type Layer, type Narrative } from '../narrative/types';
import { ADVISORY } from './advisory';
import type { ReportLayerDoc } from './assemble';

export const AUTOMATIC_REVIEW = { id: 'automatic-review', version: '1.0.0' } as const;
export type AutomaticReviewState = 'ai_reviewed' | 'awaiting_clinician';

export interface ReviewCheck { id: string; ok: boolean }
export interface AutomaticReview { reviewer: typeof AUTOMATIC_REVIEW; ok: boolean; state: AutomaticReviewState; checks: ReviewCheck[]; failedChecks: string[] }

export function automaticReview(doc: FindingsDoc, gov: GovernanceDoc, layers: Record<Layer, ReportLayerDoc>, governanceSha256: string, narrativeFlags: NormalizedFlag[]): AutomaticReview {
  const checks: ReviewCheck[] = [];
  const check = (id: string, ok: boolean) => checks.push({ id, ok });
  const both = (fn: (l: ReportLayerDoc) => boolean) => LAYERS.every((l) => { try { return fn(layers[l]); } catch { return false; } });

  check('layers_bound_to_findings', both((l) => l.traceability.findingsSha256 === doc.findingsSha256 && l.traceability.governanceSha256 === governanceSha256 && gov.findingsSha256 === doc.findingsSha256));
  check('layers_identical_findings', JSON.stringify(layers.clinical.findings) === JSON.stringify(layers.layman.findings));
  check('rows_match_source', both((l) => {
    if (l.findings.length !== doc.findings.length) return false;
    return doc.findings.every((f, i) => {
      const r = l.findings[i];
      if (r.key !== f.findingKey) return false;
      return f.excluded ? r.value === null && r.valueStatus === 'excluded' : r.value === f.value && (r.unit ?? null) === (f.unit ?? null);
    });
  }));
  check('positions_match_governance', both((l) => l.findings.every((r) => { const p = gov.positions.find((x) => x.findingKey === r.key); return !!p && p.position === r.position && p.basis === r.positionBasis; })));
  const want = [...gov.flags, ...narrativeFlags].map((f) => `${f.type}|${f.severity}`).sort();
  check('all_flags_surfaced', both((l) => JSON.stringify(l.flags.map((f) => `${f.type}|${f.severity}`).sort()) === JSON.stringify(want)));
  check('advisory_matches_governance', both((l) => (gov.referral === null
    ? l.referral === null
    : l.referral !== null && l.referral.text === (l.layer === 'clinical' ? ADVISORY.clinical : ADVISORY.layman) && l.referral.advisory.id === ADVISORY.id && l.referral.advisory.version === ADVISORY.version)));

  const narr = (l: Layer): Narrative => ({ sections: layers[l].sections, nextSteps: layers[l].nextSteps, limitations: layers[l].limitations });
  let guardsOk = true;
  for (const l of LAYERS) { try { if (!checkNarrative(l, narr(l), buildNarrativeInput(l, doc, gov)).ok) guardsOk = false; } catch { guardsOk = false; } }
  check('narrative_guards_pass', guardsOk);
  check('layers_cover_flagged_findings', (() => { try { return layersAgree(narr('clinical'), narr('layman'), buildNarrativeInput('clinical', doc, gov)); } catch { return false; } })());
  check('no_blocking_flags', !gov.flags.some((f) => f.severity === 'blocking') && gov.route.state !== 'awaiting_clinician');
  check('no_review_flag_from_narrative', !narrativeFlags.some((f) => f.type === 'review_required'));

  const failedChecks = checks.filter((c) => !c.ok).map((c) => c.id);
  const ok = failedChecks.length === 0;
  return { reviewer: AUTOMATIC_REVIEW, ok, state: ok ? 'ai_reviewed' : 'awaiting_clinician', checks, failedChecks };
}
