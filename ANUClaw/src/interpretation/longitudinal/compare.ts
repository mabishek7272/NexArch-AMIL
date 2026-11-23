/**
 * Longitudinal comparison (interpretation engine, P5): a neutral, deterministic comparison of two stored
 * normalized-findings documents of the SAME subject and skill. No model is involved.
 *
 * Rules (all versioned in `LONGITUDINAL_RULESET`; the numbers below are engineering defaults, NOT clinical thresholds):
 *  - A finding is compared only when both scans state a numeric value in the same unit, from the same source model, and the
 *    source reported an uncertainty for BOTH values. Otherwise it is `not_comparable`, with the reason; nothing is guessed.
 *  - combined uncertainty = sqrt(uE^2 + uL^2), where u is the source's plus-minus, or half the width of its interval.
 *  - |later - earlier| > combined uncertainty -> `beyond_uncertainty`; otherwise `within_uncertainty`. Direction is stated only
 *    as "the later value is higher/lower" and only beyond uncertainty. The words improved / worsened / better / worse never
 *    appear: whether a change matters is for a clinician.
 *  - Two scans closer than SHORT_INTERVAL_MS that disagree beyond uncertainty are flagged `short_interval_discrepancy` instead
 *    of being presented as a change over time (the lesson from the earlier two-scan test).
 */
import { contentHash } from '../../cds/hashing';
import type { NormalizedFinding } from '../adapters/types';
import type { FindingsDoc } from '../governance/types';

export const LONGITUDINAL_RULESET = { id: 'longitudinal-ruleset', version: '1.0.0' } as const;
export const SHORT_INTERVAL_MS = 30 * 60 * 1000;
export const COMPARISON_STATEMENT =
  'This comparison describes differences between two scans neutrally, using only the uncertainty the source reported. It does not say whether a change is an improvement or a deterioration, it is not a diagnosis, and it does not replace assessment by a qualified professional.';

export type ComparisonStatus = 'within_uncertainty' | 'beyond_uncertainty' | 'not_comparable';
export type NotComparableReason = 'missing_in_earlier' | 'missing_in_later' | 'value_missing' | 'excluded' | 'non_numeric' | 'unit_changed' | 'no_uncertainty' | 'source_model_changed';

export interface Point { value: number | string | boolean | null; uncertainty?: number }
export interface FindingComparison {
  findingKey: string; label: string; group?: string; unit?: string;
  status: ComparisonStatus; reason?: NotComparableReason;
  earlier?: Point; later?: Point;
  delta?: number; combinedUncertainty?: number; laterIs?: 'higher' | 'lower'; identical?: boolean; shortInterval?: boolean;
}
export interface ScanRef { jobId: string; capturedAt: string; findingsSha256: string; source: Record<string, string> }
export interface ComparisonFlag { type: 'short_interval_discrepancy' | 'source_model_changed'; severity: 'info' | 'attention'; findingKeys?: string[]; detail: string }
export interface ComparisonDoc {
  schemaVersion: 'longitudinal-comparison/v1'; ruleset: typeof LONGITUDINAL_RULESET;
  earlier: ScanRef; later: ScanRef; intervalSeconds: number;
  comparisons: FindingComparison[]; flags: ComparisonFlag[];
  summary: Record<ComparisonStatus, number>; statement: string; comparisonSha256: string;
}

const round = (n: number) => Math.round(n * 1e9) / 1e9;

/** The source's own uncertainty as one non-negative number, or undefined when none was reported. */
export function uncertaintyOf(f: NormalizedFinding): number | undefined {
  const u = f.uncertainty; if (!u) return undefined;
  if (typeof u.plusMinus === 'number' && u.plusMinus >= 0) return u.plusMinus;
  if (u.interval && u.interval[1] >= u.interval[0]) return (u.interval[1] - u.interval[0]) / 2;
  return undefined;
}

/** What identifies the source of a scan: a change in any of these means differences may not belong to the subject. */
export function sourceKey(doc: FindingsDoc): Record<string, string> {
  const sm = doc.provenance.sourceModel;
  const out: Record<string, string> = { adapter: `${doc.provenance.adapter.id}@${doc.provenance.adapter.version}` };
  for (const k of ['application', 'modelName', 'modelVersion', 'calibrationVersion'] as const) if (sm[k] !== undefined) out[k] = sm[k] as string;
  return out;
}
const sameSource = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export function compareFinding(e: NormalizedFinding | undefined, l: NormalizedFinding | undefined, modelChanged: boolean, shortInterval: boolean): FindingComparison {
  const ref = (l ?? e)!;
  const base: FindingComparison = { findingKey: ref.findingKey, label: ref.label, ...(ref.group ? { group: ref.group } : {}), ...(l?.unit ?? e?.unit ? { unit: (l?.unit ?? e?.unit) as string } : {}), status: 'not_comparable' };
  const nc = (reason: NotComparableReason, extra: Partial<FindingComparison> = {}): FindingComparison => ({ ...base, reason, ...extra });
  const pt = (f: NormalizedFinding): Point => { const u = uncertaintyOf(f); return { value: f.excluded ? null : f.value, ...(u !== undefined && !f.excluded ? { uncertainty: u } : {}) }; };

  if (!e) return nc('missing_in_earlier', { later: pt(l!) });
  if (!l) return nc('missing_in_later', { earlier: pt(e) });
  const pts = { earlier: pt(e), later: pt(l) };
  if (e.excluded || l.excluded) return nc('excluded', pts);
  if (e.valueStatus === 'missing' || l.valueStatus === 'missing' || e.value === null || l.value === null) return nc('value_missing', pts);
  if (typeof e.value !== 'number' || typeof l.value !== 'number') return nc('non_numeric', { ...pts, identical: e.value === l.value });
  if ((e.unit ?? null) !== (l.unit ?? null)) return nc('unit_changed', pts);
  if (modelChanged) return nc('source_model_changed', pts);
  const ue = uncertaintyOf(e), ul = uncertaintyOf(l);
  if (ue === undefined || ul === undefined) return nc('no_uncertainty', pts);

  const delta = round(l.value - e.value); const combined = round(Math.sqrt(ue * ue + ul * ul));
  const beyond = Math.abs(delta) > combined;
  return {
    ...base, status: beyond ? 'beyond_uncertainty' : 'within_uncertainty', ...pts, delta, combinedUncertainty: combined,
    ...(beyond ? { laterIs: delta > 0 ? ('higher' as const) : ('lower' as const) } : {}), ...(beyond && shortInterval ? { shortInterval: true } : {}),
  };
}

export interface ScanInput { jobId: string; doc: FindingsDoc }

/** `earlier` and `later` must already be ordered by capture time. */
export function compareScans(earlier: ScanInput, later: ScanInput): ComparisonDoc {
  const te = Date.parse(earlier.doc.capturedAt), tl = Date.parse(later.doc.capturedAt);
  const intervalMs = Math.max(0, tl - te);
  const short = intervalMs < SHORT_INTERVAL_MS;
  const se = sourceKey(earlier.doc), sl = sourceKey(later.doc);
  const modelChanged = !sameSource(se, sl);

  const byKeyE = new Map(earlier.doc.findings.map((f) => [f.findingKey, f])), byKeyL = new Map(later.doc.findings.map((f) => [f.findingKey, f]));
  const keys = [...later.doc.findings.map((f) => f.findingKey), ...earlier.doc.findings.map((f) => f.findingKey).filter((k) => !byKeyL.has(k))];
  const comparisons = keys.map((k) => compareFinding(byKeyE.get(k), byKeyL.get(k), modelChanged, short));

  const flags: ComparisonFlag[] = [];
  if (modelChanged) flags.push({ type: 'source_model_changed', severity: 'info', detail: 'The scans come from different source models, versions or calibrations, so differences cannot be attributed to the subject and numeric findings are not compared.' });
  const disc = comparisons.filter((c) => c.status === 'beyond_uncertainty').map((c) => c.findingKey);
  if (short && disc.length) flags.push({ type: 'short_interval_discrepancy', severity: 'attention', findingKeys: disc, detail: 'The two scans were taken very close together yet differ by more than the reported uncertainty. This is presented as a discrepancy to check, not as a change over time.' });

  const summary: Record<ComparisonStatus, number> = { within_uncertainty: 0, beyond_uncertainty: 0, not_comparable: 0 };
  for (const c of comparisons) summary[c.status] += 1;
  const scan = (s: ScanInput, src: Record<string, string>): ScanRef => ({ jobId: s.jobId, capturedAt: s.doc.capturedAt, findingsSha256: s.doc.findingsSha256, source: src });
  const body = {
    schemaVersion: 'longitudinal-comparison/v1' as const, ruleset: LONGITUDINAL_RULESET,
    earlier: scan(earlier, se), later: scan(later, sl), intervalSeconds: Math.floor(intervalMs / 1000),
    comparisons, flags, summary, statement: COMPARISON_STATEMENT,
  };
  return { ...body, comparisonSha256: contentHash(body) };
}

// ── series for one finding ───────────────────────────────────────────────────────────────────

export interface SeriesPoint { jobId: string; capturedAt: string; value: number | string | boolean | null; unit?: string; uncertainty?: number; status: 'stated' | 'derived' | 'missing' | 'excluded' | 'absent' }
export interface SeriesStep { fromJobId: string; toJobId: string; intervalSeconds: number; status: ComparisonStatus; reason?: NotComparableReason; delta?: number; combinedUncertainty?: number; laterIs?: 'higher' | 'lower'; shortInterval?: boolean }

export function buildSeries(findingKey: string, scans: ScanInput[]): { points: SeriesPoint[]; steps: SeriesStep[] } {
  const points: SeriesPoint[] = scans.map((s) => {
    const f = s.doc.findings.find((x) => x.findingKey === findingKey);
    if (!f) return { jobId: s.jobId, capturedAt: s.doc.capturedAt, value: null, status: 'absent' as const };
    const u = uncertaintyOf(f);
    return { jobId: s.jobId, capturedAt: s.doc.capturedAt, value: f.excluded ? null : f.value, ...(f.unit ? { unit: f.unit } : {}), ...(u !== undefined && !f.excluded ? { uncertainty: u } : {}), status: f.excluded ? ('excluded' as const) : f.valueStatus };
  });
  const steps: SeriesStep[] = [];
  for (let i = 1; i < scans.length; i += 1) {
    const a = scans[i - 1], b = scans[i];
    const ms = Math.max(0, Date.parse(b.doc.capturedAt) - Date.parse(a.doc.capturedAt));
    const changed = !sameSource(sourceKey(a.doc), sourceKey(b.doc));
    const fe = a.doc.findings.find((x) => x.findingKey === findingKey), fl = b.doc.findings.find((x) => x.findingKey === findingKey);
    // A finding neither scan has: nothing to compare (reported as missing, never skipped silently).
    if (!fe && !fl) { steps.push({ fromJobId: a.jobId, toJobId: b.jobId, intervalSeconds: Math.floor(ms / 1000), status: 'not_comparable', reason: 'missing_in_earlier' }); continue; }
    const c = compareFinding(fe, fl, changed, ms < SHORT_INTERVAL_MS);
    steps.push({ fromJobId: a.jobId, toJobId: b.jobId, intervalSeconds: Math.floor(ms / 1000), status: c.status, ...(c.reason ? { reason: c.reason } : {}), ...(c.delta !== undefined ? { delta: c.delta } : {}), ...(c.combinedUncertainty !== undefined ? { combinedUncertainty: c.combinedUncertainty } : {}), ...(c.laterIs ? { laterIs: c.laterIs } : {}), ...(c.shortInterval ? { shortInterval: true } : {}) });
  }
  return { points, steps };
}
