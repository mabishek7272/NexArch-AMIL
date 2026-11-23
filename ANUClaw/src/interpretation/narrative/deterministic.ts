/**
 * Deterministic narrative (interpretation engine, P4b): fixed-template text built only from the findings and governance.
 * It is used when narratives are off (the default), or when a model's text is unavailable or fails a guard. It uses no
 * model, so it can never invent anything, and it is itself held to the same guards (a test asserts it passes them).
 */
import type { FindingsDoc, GovernanceDoc } from '../governance/types';
import { inputFinding } from './input';
import type { Layer, Narrative, NarrativeInputFinding, NarrativeSection } from './types';

const unit = (f: NarrativeInputFinding) => (f.unit ? ` ${f.unit}` : '');
const valueText = (f: NarrativeInputFinding) => (f.value === null ? '' : `${f.value}${unit(f)}`);
const refText = (f: NarrativeInputFinding): string | null => {
  const r = f.reference;
  if (!r || r.status === 'draft') return null;
  if (r.text) return r.text;
  if (r.lower !== undefined && r.upper !== undefined) return `${r.lower} to ${r.upper}${unit(f)}`;
  if (r.lower !== undefined) return `above ${r.lower}${unit(f)}`;
  if (r.upper !== undefined) return `below ${r.upper}${unit(f)}`;
  return null;
};
const reasons = (f: NarrativeInputFinding) => (f.unsupportedReasons?.length ? ` (${f.unsupportedReasons.join(', ')})` : '');

function clinicalLine(f: NarrativeInputFinding, application: string): string {
  if (f.value === null) return `${f.label}: the source reported no value${reasons(f)}.`;
  const unc = f.uncertainty?.plusMinus !== undefined ? ` with an uncertainty of plus or minus ${f.uncertainty.plusMinus}${unit(f)}` : '';
  let s = `${f.label}: ${valueText(f)}${unc}.`;
  const ref = refText(f);
  if (ref) s += ` The reference supplied by ${application} is ${ref}.`;
  switch (f.position) {
    case 'above': s += ' The value is above that reference.'; break;
    case 'below': s += ' The value is below that reference.'; break;
    case 'within': s += ' The value is within that reference.'; break;
    case 'indeterminate': s += ' The value cannot be placed against that reference with certainty.'; break;
    default:
      if (f.reference?.status === 'draft') s += ' The reference supplied by the source is a draft and is not used for comparison.';
      else if (f.positionBasis === 'text_only_reference') s += ' The source gave no usable numeric range, so no comparison was made.';
      else if (f.reference === undefined && f.positionBasis === 'no_reference') s += ' No reference was supplied.';
  }
  // A source flag of "normal" is not repeated: it cannot be restated for an out-of-range value, and a mismatch is reported as a contradiction flag.
  if (f.sourceFlag && f.sourceFlag !== 'normal') s += ` The source flagged it ${f.sourceFlag}.`;
  if (f.tier === 'proxy') s += ' It is a camera-based proxy, not a validated measurement.';
  if (f.underResearch) s += ' It is an experimental estimate and not equivalent to a laboratory result.';
  return s;
}

function laymanLine(f: NarrativeInputFinding, application: string): string {
  if (f.value === null) return `${f.label}: the app could not measure this.`;
  let s = `${f.label}: ${valueText(f)}.`;
  const ref = refText(f);
  if (ref) s += ` The range ${application} uses for this is ${ref}.`;
  switch (f.position) {
    case 'above': s += ' Your result is above that range.'; break;
    case 'below': s += ' Your result is below that range.'; break;
    case 'within': s += ' Your result is within that range.'; break;
    case 'indeterminate': s += ' Your result is too close to the edge of the range to tell.'; break;
    default:
      if (f.reference?.status === 'draft') s += ' The app’s range for this is still a draft, so no comparison is made.';
      else s += ' The app gave no usable range for this, so no comparison is made.';
  }
  if (f.sourceFlag === 'high' || f.sourceFlag === 'low' || f.sourceFlag === 'review') s += ` The app marked it ${f.sourceFlag === 'review' ? 'for review' : f.sourceFlag}.`;
  if (f.tier === 'proxy') s += ' This is an estimate from a camera and is not a medical measurement.';
  if (f.underResearch) s += ' This is an experimental estimate and is not the same as a lab test.';
  return s;
}

export const FLAG_SENTENCE: Record<string, [string, string]> = {
  missing_data: ['Some values were not reported by the source and nothing was filled in.', 'The app could not measure some values, and nothing has been guessed.'],
  under_research: ['Some values are experimental estimates and are not equivalent to a laboratory result.', 'Some results are experimental estimates and are not the same as lab tests.'],
  contradiction: ['For some values the source’s own label does not match the range it supplied.', 'For some results the app’s own label does not match its own range.'],
  low_confidence: ['The source reports low confidence in some values.', 'The app is not very sure about some results.'],
  stale_capture: ['The capture is old.', 'This scan is not recent.'],
  implausible_value: ['Some values look like measurement errors and are held for review.', 'Some results look like measurement mistakes and are held for review.'],
  unit_mismatch: ['Some values are given in an unexpected unit and are held for review.', 'Some results use an unexpected unit and are held for review.'],
  unverified_source: ['The origin of this report was not verified.', 'We could not check where this report came from.'],
  symptom_reported: ['Symptoms were reported during capture.', 'Symptoms were reported during the scan.'],
  draft_reference: ['Some comparisons use a draft reference and are not used here.', 'For some results the app’s range is still a draft, so no comparison is made.'],
};

export function deterministicNarrative(layer: Layer, doc: FindingsDoc, gov: GovernanceDoc): Narrative {
  const application = doc.provenance.sourceModel.application ?? 'the source application';
  const live = doc.findings.filter((f) => !f.excluded).map((f) => inputFinding(f, doc, gov));
  const sections: NarrativeSection[] = [];
  const clinical = layer === 'clinical';
  sections.push({
    id: 'overview', statusLabel: 'interpretation', findingRefs: [],
    text: clinical
      ? `Automated summary of findings reported by ${application}. Reference ranges are those the source supplied and are not endorsed here.`
      : `This report explains results from ${application}. It compares each result with the range the app itself uses. It is not a diagnosis.`,
  });
  live.forEach((f, i) => sections.push({ id: `f_${i + 1}`, statusLabel: 'source_finding', findingRefs: [f.key], text: clinical ? clinicalLine(f, application) : laymanLine(f, application) }));

  const seen = new Set<string>();
  const dq: string[] = [];
  for (const fl of gov.flags) {
    const sentence = FLAG_SENTENCE[fl.type]; if (!sentence || seen.has(fl.type) || fl.severity === 'info' && fl.type !== 'under_research' && fl.type !== 'missing_data') continue;
    seen.add(fl.type); dq.push(sentence[clinical ? 0 : 1]);
  }
  if (dq.length) sections.push({ id: 'data_quality', statusLabel: 'limitation', findingRefs: [], text: dq.join(' ') });

  return clinical
    ? {
      sections,
      nextSteps: ['Confirm any flagged value with validated measurements or clinical examination.', 'Interpret the findings in the context of the patient’s history, by a qualified professional.'],
      limitations: 'These are estimates from a third-party source and are not diagnostic. Reference ranges are those the source supplied.',
    }
    : {
      sections,
      nextSteps: ['Talk with a doctor or another qualified health professional about these results.', 'Bring this report with you.', 'Do not start, stop or change any medicine because of this report.'],
      limitations: 'This report is not a diagnosis. The results come from an app and are estimates only.',
    };
}
