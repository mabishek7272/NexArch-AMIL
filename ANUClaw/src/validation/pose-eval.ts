/**
 * Pose measurement accuracy (agreement with annotated reference measurements) and repeatability.
 *
 * Agreement: Bland–Altman bias and 95% limits of agreement (with confidence intervals), MAE/RMSE, proportional bias, how often the
 * system's own stated uncertainty covers the observed error, and the rate of "unsupported" outcomes (never dropped from the
 * denominator silently). Repeatability: one-way random-effects ANOVA → within-subject SD, ICC(1,1), CV and the minimal detectable
 * change at 95% (MDC95 = 1.96·√2·Sw). Formulas are independently re-computed in scripts/gen-validation-vectors.py.
 */
import { assessEvidence, EvidenceReport, EvidenceKind, mean, rate, Rate, requireSchema, sd, tQuantile, ValidationInputError } from './common';

export interface PoseReferenceSet {
  schema: 'anuclaw-pose-reference/v1';
  provenance: { kind: EvidenceKind; referenceMethod: string; referenceIndependentOfSystem: boolean; annotators?: Array<{ id: string; role: string }>; protocolRef?: string };
  items: Array<{ clipId: string; subjectId: string; metricKey: string; unit: string; referenceValue: number; referenceUncertainty?: number }>;
}
export interface PoseResultSet {
  schema: 'anuclaw-pose-results/v1';
  system: { pipeline: string; modelVersion: string; metricsVersion?: string };
  items: Array<{ clipId: string; subjectId: string; repeat?: number; metricKey: string; unit: string; status: 'estimate' | 'unsupported' | 'not_measurable'; value?: number; uncertainty?: number }>;
}
export interface AgreementMetric {
  metricKey: string; unit: string; referenceItems: number; paired: number; unsupported: Rate;
  bias: number | null; biasCI95: { low: number; high: number } | null; sdDifference: number | null;
  limitsOfAgreement: { lower: number; upper: number; lowerCI95: { low: number; high: number }; upperCI95: { low: number; high: number } } | null;
  mae: number | null; rmse: number | null; proportionalBiasSlope: number | null;
  uncertaintyCoverage: Rate; withinTolerance: (Rate & { tolerance: number }) | null; underpowered: boolean;
}
export interface RepeatabilityMetric {
  metricKey: string; unit: string; subjects: number; observations: number;
  withinSubjectSD: number | null; icc11: number | null; cvPercent: number | null; mdc95: number | null; note?: string;
}
export interface PoseEvaluation {
  schema: 'anuclaw-pose-evaluation/v1'; system: PoseResultSet['system']; referenceMethod: string;
  agreement: AgreementMetric[]; repeatability: RepeatabilityMetric[]; evidence: EvidenceReport;
}

export function blandAltman(sys: number[], ref: number[], unc?: Array<number | undefined>, tolerance?: number): Omit<AgreementMetric, 'metricKey' | 'unit' | 'referenceItems' | 'unsupported' | 'underpowered'> {
  const n = sys.length; const d = sys.map((v, i) => v - ref[i]);
  const cover = unc ? d.reduce((a, di, i) => a + (unc[i] != null && Math.abs(di) <= (unc[i] as number) ? 1 : 0), 0) : 0;
  const coverN = unc ? unc.filter((u) => u != null).length : 0;
  const tol = tolerance != null ? { ...rate(d.filter((x) => Math.abs(x) <= tolerance).length, n), tolerance } : null;
  if (n < 2) return { paired: n, bias: n ? d[0] : null, biasCI95: null, sdDifference: null, limitsOfAgreement: null, mae: n ? Math.abs(d[0]) : null, rmse: n ? Math.abs(d[0]) : null, proportionalBiasSlope: null, uncertaintyCoverage: rate(cover, coverN), withinTolerance: tol };
  const bias = mean(d), s = sd(d)!, t = tQuantile(0.975, n - 1);
  const seBias = s / Math.sqrt(n), seLoA = s * Math.sqrt(1 / n + (1.96 ** 2) / (2 * (n - 1)));
  const lo = bias - 1.96 * s, hi = bias + 1.96 * s;
  const m = sys.map((v, i) => (v + ref[i]) / 2), mm = mean(m);
  const varM = m.reduce((a, x) => a + (x - mm) ** 2, 0);
  const slope = varM > 0 ? m.reduce((a, x, i) => a + (x - mm) * (d[i] - bias), 0) / varM : null;
  return {
    paired: n, bias, biasCI95: { low: bias - t * seBias, high: bias + t * seBias }, sdDifference: s,
    limitsOfAgreement: { lower: lo, upper: hi, lowerCI95: { low: lo - t * seLoA, high: lo + t * seLoA }, upperCI95: { low: hi - t * seLoA, high: hi + t * seLoA } },
    mae: mean(d.map(Math.abs)), rmse: Math.sqrt(mean(d.map((x) => x * x))), proportionalBiasSlope: slope,
    uncertaintyCoverage: rate(cover, coverN), withinTolerance: tol,
  };
}

/** One-way random-effects ANOVA on groups of repeated measurements (unbalanced allowed). */
export function repeatability(groups: number[][]): Pick<RepeatabilityMetric, 'subjects' | 'observations' | 'withinSubjectSD' | 'icc11' | 'cvPercent' | 'mdc95' | 'note'> {
  const g = groups.filter((x) => x.length >= 2); const k = g.length; const N = g.reduce((a, x) => a + x.length, 0);
  if (k < 2 || N - k < 1) return { subjects: k, observations: N, withinSubjectSD: null, icc11: null, cvPercent: null, mdc95: null, note: 'needs at least 2 subjects with at least 2 repeats each' };
  const grand = g.flat().reduce((a, b) => a + b, 0) / N;
  const means = g.map((x) => mean(x));
  const ssb = g.reduce((a, x, i) => a + x.length * (means[i] - grand) ** 2, 0);
  const ssw = g.reduce((a, x, i) => a + x.reduce((b, v) => b + (v - means[i]) ** 2, 0), 0);
  const msb = ssb / (k - 1), msw = ssw / (N - k);
  const n0 = (N - g.reduce((a, x) => a + x.length ** 2, 0) / N) / (k - 1);
  const sw = Math.sqrt(msw);
  const icc = (msb - msw) / (msb + (n0 - 1) * msw);
  return { subjects: k, observations: N, withinSubjectSD: sw, icc11: icc, cvPercent: grand !== 0 ? (sw / Math.abs(grand)) * 100 : null, mdc95: 1.96 * Math.SQRT2 * sw };
}

export function evaluatePose(reference: PoseReferenceSet, results: PoseResultSet, opts: { tolerances?: Record<string, number>; minPairsPerMetric?: number; minSubjects?: number } = {}): PoseEvaluation {
  requireSchema(reference, 'anuclaw-pose-reference/v1', 'reference'); requireSchema(results, 'anuclaw-pose-results/v1', 'results');
  const problems: string[] = []; const resKey = new Map<string, PoseResultSet['items'][number]>();
  for (const r of results.items) { const k = `${r.clipId}|${r.metricKey}`; if (resKey.has(k)) problems.push(`duplicate result for ${k}`); resKey.set(k, r); }
  const refKey = new Set<string>();
  for (const r of reference.items) { const k = `${r.clipId}|${r.metricKey}`; if (refKey.has(k)) problems.push(`duplicate reference for ${k}`); refKey.add(k); if (!Number.isFinite(r.referenceValue)) problems.push(`non-finite reference for ${k}`); const s = resKey.get(k); if (s && s.unit !== r.unit) problems.push(`unit mismatch for ${k}: reference ${r.unit} vs result ${s.unit}`); }
  if (problems.length) throw new ValidationInputError(problems);

  const minPairs = opts.minPairsPerMetric ?? 35;
  const byMetric = new Map<string, PoseReferenceSet['items']>();
  for (const r of reference.items) { if (!byMetric.has(r.metricKey)) byMetric.set(r.metricKey, []); byMetric.get(r.metricKey)!.push(r); }
  const agreement: AgreementMetric[] = [];
  for (const [metricKey, items] of [...byMetric].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sys: number[] = [], ref: number[] = [], unc: Array<number | undefined> = []; let unsupported = 0;
    for (const it of items) {
      const r = resKey.get(`${it.clipId}|${metricKey}`);
      if (!r || r.status !== 'estimate' || typeof r.value !== 'number' || !Number.isFinite(r.value)) { unsupported++; continue; }   // absent or unsupported: counted, never dropped
      sys.push(r.value); ref.push(it.referenceValue); unc.push(r.uncertainty);
    }
    const stats = blandAltman(sys, ref, unc, opts.tolerances?.[metricKey]);
    agreement.push({ metricKey, unit: items[0].unit, referenceItems: items.length, unsupported: rate(unsupported, items.length), underpowered: stats.paired < minPairs, ...stats });
  }
  const rep: RepeatabilityMetric[] = [];
  const bySubj = new Map<string, Map<string, number[]>>();
  const units = new Map<string, string>();
  for (const r of results.items) {
    if (r.status !== 'estimate' || typeof r.value !== 'number') continue;
    units.set(r.metricKey, r.unit);
    if (!bySubj.has(r.metricKey)) bySubj.set(r.metricKey, new Map());
    const m = bySubj.get(r.metricKey)!; if (!m.has(r.subjectId)) m.set(r.subjectId, []); m.get(r.subjectId)!.push(r.value);
  }
  for (const [metricKey, m] of [...bySubj].sort((a, b) => a[0].localeCompare(b[0]))) rep.push({ metricKey, unit: units.get(metricKey)!, ...repeatability([...m.values()]) });

  const nSubjects = new Set(reference.items.map((i) => i.subjectId)).size;
  const smallest = agreement.length ? Math.min(...agreement.map((a) => a.paired)) : 0;
  const evidence = assessEvidence({
    kind: reference.provenance.kind, n: smallest, minN: minPairs, minSource: opts.minPairsPerMetric !== undefined ? 'caller_specified' : 'tool_default_placeholder',
    independentReference: reference.provenance.referenceIndependentOfSystem, annotators: reference.provenance.annotators?.length, protocolRef: reference.provenance.protocolRef,
    underpowered: agreement.filter((a) => a.underpowered).map((a) => a.metricKey),
    extra: nSubjects < (opts.minSubjects ?? 30) ? [`only ${nSubjects} subjects (minimum ${opts.minSubjects ?? 30})`] : [],
  });
  return { schema: 'anuclaw-pose-evaluation/v1', system: results.system, referenceMethod: reference.provenance.referenceMethod, agreement, repeatability: rep, evidence };
}
