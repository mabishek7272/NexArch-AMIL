/**
 * Pre-egress privacy policy (plan F04). Applied by runAgent before ANY text
 * leaves the process for a model provider (container CLI or host fallback).
 *
 *  - provider declared BAA-covered (LLM_BAA_COVERED=true)  → raw text permitted
 *  - otherwise, de-identification required unless ELAB_DEID_REQUIRED=false
 *
 * Uses the existing deterministic regex de-identifier (risk reduction, NOT
 * certified Safe Harbor — see src/dashboard/server/deid.ts). Multiple fields are
 * de-identified in one pass so placeholders are consistent across them; the
 * reversible map never leaves the process.
 */
import { deidentify, reidentify, assessReidentificationRisk } from '../dashboard/server/deid';
import { assertNoRestrictedContent } from '../aikosh/taint';

export interface EgressDecision {
  mode: 'raw_baa_covered' | 'deidentified' | 'raw_deid_disabled';
  redactions: number;
  residualRisk: 'low' | 'residual' | 'not_assessed';
  /** placeholder → original; local only. */
  map: Record<string, string>;
}

const SEP = '\n\u0000␞\u0000\n'; // cannot appear in normal text; breaks regex spans

export function egressMode(env: NodeJS.ProcessEnv = process.env): EgressDecision['mode'] {
  if (env.LLM_BAA_COVERED === 'true') return 'raw_baa_covered';
  if (env.ELAB_DEID_REQUIRED === 'false') return 'raw_deid_disabled';
  return 'deidentified';
}

/** De-identify several fields consistently according to policy. */
export function prepareForEgress(fields: string[], env: NodeJS.ProcessEnv = process.env): { fields: string[]; decision: EgressDecision } {
  // AIKosh restricted content (narratives / identifier-like values from unapproved files) never leaves the process, whatever the egress mode.
  assertNoRestrictedContent(fields.map((f) => f ?? ''));
  const mode = egressMode(env);
  if (mode !== 'deidentified') {
    return { fields, decision: { mode, redactions: 0, residualRisk: 'not_assessed', map: {} } };
  }
  const joined = fields.map((f) => f ?? '').join(SEP);
  const r = deidentify(joined);
  const out = r.text.split(SEP);
  if (out.length !== fields.length) {
    // Never fall back to raw text: fail closed.
    throw new Error('egress de-identification produced an inconsistent field split');
  }
  return {
    fields: out,
    decision: { mode, redactions: r.redactions.length, residualRisk: assessReidentificationRisk(r.redactions), map: r.map },
  };
}

/** Restore identifiers into model output locally. */
export function restoreAfterEgress(text: string, decision: EgressDecision): string {
  return decision.mode === 'deidentified' ? reidentify(text, decision.map) : text;
}
