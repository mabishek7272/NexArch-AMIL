/** Shared helpers for the validation tools. Pure functions; no I/O; no randomness. */
import { tQuantile, wilson } from '../research/stats';

export type EvidenceKind = 'synthetic_fixture' | 'human_annotated';

export interface Rate { k: number; n: number; rate: number | null; ci95: { low: number; high: number } | null }
export function rate(k: number, n: number): Rate {
  if (n <= 0) return { k, n, rate: null, ci95: null };
  const w = wilson(k, n);
  return { k, n, rate: k / n, ci95: { low: w.low, high: w.high } };
}

export const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
export function sd(x: number[]): number | null {
  if (x.length < 2) return null;
  const m = mean(x); return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1));
}
export function quantile(sortedAsc: number[], q: number): number | null {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);          // linear interpolation (numpy default)
}
export function median(x: number[]): number | null { return quantile([...x].sort((a, b) => a - b), 0.5); }
export { tQuantile };

/**
 * The tools report SEVERAL SEPARATE things and never combine them into a verdict. There is deliberately no "validated", "passed" or
 * "adequate for a claim" flag:
 *   datasetAdequacy     – do the sample size and provenance meet minimums? (structure only; says nothing about performance)
 *   annotationQuality   – who annotated, adjudication, reference independence: SELF-DECLARED in the input and NOT verified here
 *   uncertainty         – whether estimates are reported with intervals (they always are) and which results are underpowered
 *   protocolApproval    – a reference to a pre-specified protocol is recorded, never verified, and never required by the tool
 *   measuredPerformance – the numbers in the rest of the report; descriptive, not a pass/fail
 *   clinicalAcceptance  – always "not assessed": only responsible clinicians can decide it, outside this software
 */
export interface EvidenceReport {
  kind: EvidenceKind;
  datasetAdequacy: { structuralMinimumsMet: boolean; sampleSize: number; minimumRequired: number; thresholdsSource: 'tool_default_placeholder' | 'caller_specified' | 'policy'; reasons: string[]; meaning: string };
  annotationQuality: { status: 'not_applicable_synthetic' | 'self_declared_unverified'; independentReference: boolean | null; adjudicated: boolean | null; annotators: number | null; meaning: string };
  uncertainty: { reportedAsIntervals: true; underpoweredResults: string[]; meaning: string };
  protocolApproval: { status: 'not_recorded' | 'reference_recorded_unverified'; reference: string | null; meaning: string };
  measuredPerformance: { meaning: string };
  clinicalAcceptance: { status: 'not_assessed_by_this_tool'; meaning: string };
  disclaimer: string;
}
export function assessEvidence(args: {
  kind: EvidenceKind; n: number; minN: number; minSource?: 'tool_default_placeholder' | 'caller_specified' | 'policy'; independentReference?: boolean; adjudicated?: boolean; annotators?: number;
  protocolRef?: string | null; underpowered?: string[]; extra?: string[];
}): EvidenceReport {
  const reasons: string[] = [...(args.extra ?? [])];
  if (args.kind !== 'human_annotated') reasons.push('data are synthetic fixtures: they test the tool and the pipeline mechanics, not performance on real material');
  if (args.n < args.minN) reasons.push(`sample size ${args.n} is below the minimum ${args.minN}`);
  if (args.independentReference === false) reasons.push('the reference is declared not independent of the system under test');
  if (args.adjudicated === false) reasons.push('annotations are declared not double-annotated and adjudicated');
  const synthetic = args.kind !== 'human_annotated';
  return {
    kind: args.kind,
    datasetAdequacy: { structuralMinimumsMet: reasons.length === 0, sampleSize: args.n, minimumRequired: args.minN, thresholdsSource: args.minSource ?? 'tool_default_placeholder', reasons,
      meaning: 'Whether the sample size and declared provenance meet minimums. It is NOT a performance result, NOT validation and NOT a release decision. The default minimums are engineering placeholders; the real ones belong in the study protocol.' },
    annotationQuality: { status: synthetic ? 'not_applicable_synthetic' : 'self_declared_unverified', independentReference: args.independentReference ?? null, adjudicated: args.adjudicated ?? null, annotators: args.annotators ?? null,
      meaning: 'Taken from the input file as declared. This tool cannot check who annotated, their qualifications, or the quality of their work.' },
    uncertainty: { reportedAsIntervals: true, underpoweredResults: args.underpowered ?? [], meaning: 'Rates carry Wilson 95% intervals and agreement statistics carry confidence intervals; results flagged underpowered have too little data for those intervals to be trusted.' },
    protocolApproval: { status: args.protocolRef ? 'reference_recorded_unverified' : 'not_recorded', reference: args.protocolRef ?? null, meaning: 'A reference to a pre-specified protocol, recorded as given. Its existence, content and approval are not verified here.' },
    measuredPerformance: { meaning: 'The measured values elsewhere in this report describe THIS dataset only. They are not pass/fail and not a statement about any other population.' },
    clinicalAcceptance: { status: 'not_assessed_by_this_tool', meaning: 'Whether a measured performance is clinically acceptable is a decision for responsible clinicians, outside this software.' },
    disclaimer: 'Nothing in this report is clinical validation, safety evidence, regulatory evidence or an automatic release decision.',
  };
}

export class ValidationInputError extends Error { constructor(public readonly problems: string[]) { super(problems.join('; ')); this.name = 'ValidationInputError'; } }
export function requireSchema(doc: any, expected: string, what: string): void {
  if (!doc || typeof doc !== 'object' || doc.schema !== expected) throw new ValidationInputError([`${what}: "schema" must be "${expected}"`]);
}
