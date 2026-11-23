/**
 * Builds what a narrative layer is told (interpretation engine, P4b), and the numbers it may use.
 *
 * Excluded findings are left out entirely. Identity, the subject reference and the original payload are never part of
 * the findings document, so they cannot be here. Flags are passed as type/severity/keys only: their prose (which can
 * contain numbers) is not given to the model.
 */
import type { NormalizedFinding } from '../adapters/types';
import type { FindingsDoc, GovernanceDoc } from '../governance/types';
import type { Layer, NarrativeInput, NarrativeInputFinding } from './types';

const NUM = /\d+(?:\.\d+)?/g;
const canon = (n: string): string => String(Number(n));

export function inputFinding(f: NormalizedFinding, doc: FindingsDoc, gov: GovernanceDoc): NarrativeInputFinding {
  const p = gov.positions.find((x) => x.findingKey === f.findingKey);
  const out: NarrativeInputFinding = {
    key: f.findingKey, label: f.label, value: f.value, position: p?.position ?? 'no_reference', positionBasis: p?.basis ?? 'no_reference',
  };
  if (f.group) out.group = f.group;
  if (f.unit) out.unit = f.unit;
  if (f.uncertainty) out.uncertainty = f.uncertainty;
  if (f.reference) {
    const r = f.reference;
    out.reference = { suppliedBy: doc.provenance.sourceModel.application ?? 'the source application' };
    if (r.text !== undefined) out.reference.text = r.text;
    if (r.lower !== undefined) out.reference.lower = r.lower;
    if (r.upper !== undefined) out.reference.upper = r.upper;
    if (r.value !== undefined) out.reference.value = r.value;
    if (r.status) out.reference.status = r.status;
  }
  if (f.sourceFlag) out.sourceFlag = f.sourceFlag;
  if (f.tier) out.tier = f.tier;
  if (f.side) out.side = f.side;
  if (f.underResearch) out.underResearch = true;
  if (f.unsupportedReasons?.length) out.unsupportedReasons = f.unsupportedReasons.map((r) => r.replace(/_/g, ' '));
  return out;
}

export function buildNarrativeInput(layer: Layer, doc: FindingsDoc, gov: GovernanceDoc): NarrativeInput {
  const live = doc.findings.filter((f) => !f.excluded);
  const keys = new Set(live.map((f) => f.findingKey));
  const input: NarrativeInput = {
    layer,
    application: doc.provenance.sourceModel.application ?? 'the source application',
    findings: live.map((f) => inputFinding(f, doc, gov)),
    flags: gov.flags.map((f) => ({ type: f.type, severity: f.severity, ...(f.findingKeys ? { findingKeys: f.findingKeys.filter((k) => keys.has(k)) } : {}) })),
    referralNoticeAdded: gov.referral !== null,
  };
  if (doc.provenance.sourceModel.researchStatus) input.researchStatus = doc.provenance.sourceModel.researchStatus;
  if (doc.sourceVerification) input.verification = doc.sourceVerification.level;
  if (doc.notMeasurable?.length) input.notMeasurable = doc.notMeasurable.map((n) => n.label);
  if (doc.symptoms?.length) input.symptomsReported = true;
  return input;
}

/** Every numeric token a finding may legitimately be described with (value, uncertainty, reference, and digits in its labels). */
export function numbersOf(f: NarrativeInputFinding): Set<string> {
  const out = new Set<string>();
  const add = (s: string | number | undefined) => { if (s === undefined) return; for (const m of String(s).match(NUM) ?? []) out.add(canon(m)); };
  add(f.key); add(f.label); add(f.group); add(f.unit);
  if (typeof f.value === 'number') add(Math.abs(f.value)); else if (typeof f.value === 'string') add(f.value);
  if (f.uncertainty) { add(f.uncertainty.plusMinus); for (const v of f.uncertainty.interval ?? []) add(Math.abs(v)); }
  if (f.reference) { add(f.reference.text); add(f.reference.lower === undefined ? undefined : Math.abs(f.reference.lower)); add(f.reference.upper === undefined ? undefined : Math.abs(f.reference.upper)); add(f.reference.value === undefined ? undefined : Math.abs(f.reference.value)); }
  return out;
}

export const numberTokens = (text: string): string[] => (text.match(NUM) ?? []).map(canon);
