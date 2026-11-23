/** Longitudinal comparison rules (interpretation engine, P5). Pure: no database, no model. Synthetic data only. */
import { describe, expect, it } from 'vitest';
import type { NormalizedFinding } from '../adapters/types';
import { validateLongitudinalComparison } from '../contracts/validate';
import { docFrom } from '../narrative/fixtures';
import { buildSeries, compareScans, COMPARISON_STATEMENT, SHORT_INTERVAL_MS, uncertaintyOf } from './compare';

const F = (key: string, value: NormalizedFinding['value'], extra: Partial<NormalizedFinding> = {}): NormalizedFinding => ({
  findingKey: key, sourceKey: key, label: `Label ${key}`, valueStatus: value === null ? 'missing' : 'stated', value, ...extra,
});
const T0 = Date.parse('2026-08-20T08:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
function scan(findings: NormalizedFinding[], capturedMs = 0, over: Record<string, string> = {}, jobId = `job_${'0'.repeat(23)}${capturedMs % 10}`) {
  const doc = docFrom({ findings, flags: [] }, 'beaive-v1', { capturedAt: at(capturedMs), jobId });
  Object.assign(doc.provenance.sourceModel, over);
  doc.findingsSha256 = (jobId.slice(-2) + 'a'.repeat(64)).slice(0, 64);
  return { jobId, doc };
}
const H = 3_600_000, D = 86_400_000;
const cmp = (e: NormalizedFinding, l: NormalizedFinding, gap = 2 * H) => compareScans(scan([e], 0, {}, 'job_000000000000000000000001'), scan([l], gap, {}, 'job_000000000000000000000002')).comparisons[0];
const pm = (v: number) => ({ plusMinus: v });

describe('numeric rule: combined uncertainty', () => {
  it('within: a difference smaller than the combined uncertainty', () => {
    expect(cmp(F('hr', 100, { uncertainty: pm(5) }), F('hr', 103, { uncertainty: pm(5) }))).toMatchObject({ status: 'within_uncertainty', delta: 3, combinedUncertainty: expect.closeTo(7.0710678, 5) });
    expect(cmp(F('hr', 100, { uncertainty: pm(5) }), F('hr', 103, { uncertainty: pm(5) })).laterIs).toBeUndefined();
  });
  it('beyond: a difference larger than the combined uncertainty, with direction only then', () => {
    expect(cmp(F('hr', 100, { uncertainty: pm(2) }), F('hr', 110, { uncertainty: pm(2) }))).toMatchObject({ status: 'beyond_uncertainty', delta: 10, laterIs: 'higher' });
    expect(cmp(F('hr', 110, { uncertainty: pm(2) }), F('hr', 100, { uncertainty: pm(2) }))).toMatchObject({ status: 'beyond_uncertainty', delta: -10, laterIs: 'lower' });
  });
  it('the boundary is exclusive: a difference equal to the combined uncertainty is within it', () => {
    expect(cmp(F('x', 10, { uncertainty: pm(3) }), F('x', 15, { uncertainty: pm(4) }))).toMatchObject({ status: 'within_uncertainty', delta: 5, combinedUncertainty: 5 });
    expect(cmp(F('x', 10, { uncertainty: pm(3) }), F('x', 15.001, { uncertainty: pm(4) })).status).toBe('beyond_uncertainty');
  });
  it('an interval is used as half its width; zero uncertainty means any difference is beyond it', () => {
    expect(uncertaintyOf(F('x', 1, { uncertainty: { interval: [90, 110] } }))).toBe(10);
    expect(cmp(F('x', 100, { uncertainty: { interval: [90, 110] } }), F('x', 104, { uncertainty: pm(0) }))).toMatchObject({ status: 'within_uncertainty', combinedUncertainty: 10 });
    expect(cmp(F('x', 100, { uncertainty: pm(0) }), F('x', 100, { uncertainty: pm(0) })).status).toBe('within_uncertainty');
    expect(cmp(F('x', 100, { uncertainty: pm(0) }), F('x', 100.5, { uncertainty: pm(0) })).status).toBe('beyond_uncertainty');
  });
  it('a malformed interval is treated as no uncertainty', () => { expect(uncertaintyOf(F('x', 1, { uncertainty: { interval: [10, 5] } }))).toBeUndefined(); });
  it('is symmetric in the sign of the change and exact for floats', () => {
    const c = cmp(F('x', 0.1, { uncertainty: pm(0.05) }), F('x', 0.3, { uncertainty: pm(0.05) }));
    expect(c.delta).toBe(0.2);
  });
});

describe('not_comparable: nothing is guessed', () => {
  const U = { uncertainty: pm(1) };
  it.each([
    ['unit changed', F('x', 1, { unit: 'mmHg', ...U }), F('x', 1, { unit: 'kPa', ...U }), 'unit_changed'],
    ['unit added', F('x', 1, U), F('x', 1, { unit: 'kPa', ...U }), 'unit_changed'],
    ['no uncertainty on the earlier value', F('x', 1), F('x', 2, U), 'no_uncertainty'],
    ['no uncertainty on the later value', F('x', 1, U), F('x', 2), 'no_uncertainty'],
    ['no uncertainty on either', F('x', 1), F('x', 2), 'no_uncertainty'],
    ['earlier value missing', F('x', null), F('x', 2, U), 'value_missing'],
    ['later value missing', F('x', 1, U), F('x', null), 'value_missing'],
    ['earlier excluded', F('x', 1, { excluded: { reason: 'poor' }, ...U }), F('x', 2, U), 'excluded'],
    ['later excluded', F('x', 1, U), F('x', 2, { excluded: { reason: 'poor' }, ...U }), 'excluded'],
    ['a text value', F('x', 'High', U), F('x', 'Low', U), 'non_numeric'],
    ['a boolean value', F('x', true, U), F('x', false, U), 'non_numeric'],
    ['numeric text', F('x', '154/94', U), F('x', '150/90', U), 'non_numeric'],
  ])('%s', (_n, e, l, reason) => {
    const c = cmp(e as NormalizedFinding, l as NormalizedFinding);
    expect(c).toMatchObject({ status: 'not_comparable', reason }); expect(c.delta).toBeUndefined(); expect(c.laterIs).toBeUndefined(); expect(c.combinedUncertainty).toBeUndefined();
  });
  it('non-numeric values state only whether they are identical', () => {
    expect(cmp(F('x', 'High'), F('x', 'High'))).toMatchObject({ reason: 'non_numeric', identical: true });
    expect(cmp(F('x', 'High'), F('x', 'Low'))).toMatchObject({ reason: 'non_numeric', identical: false });
  });
  it('a finding present in only one scan', () => {
    const r = compareScans(scan([F('a', 1, { uncertainty: pm(1) })], 0, {}, 'job_000000000000000000000001'), scan([F('b', 1, { uncertainty: pm(1) })], 2 * H, {}, 'job_000000000000000000000002'));
    expect(r.comparisons.map((c) => [c.findingKey, c.status, c.reason])).toEqual([['b', 'not_comparable', 'missing_in_earlier'], ['a', 'not_comparable', 'missing_in_later']]);
  });
  it('an excluded finding never exposes its value', () => {
    const c = cmp(F('x', 999, { excluded: { reason: 'poor' }, uncertainty: pm(1) }), F('x', 5, { uncertainty: pm(1) }));
    expect(c.earlier).toEqual({ value: null }); expect(JSON.stringify(c)).not.toContain('999');
  });
});

describe('source model changes', () => {
  const U = { uncertainty: pm(1) };
  const run = (over: Record<string, string>) => compareScans(scan([F('x', 1, U)], 0, {}, 'job_000000000000000000000001'), scan([F('x', 50, U)], 2 * H, over, 'job_000000000000000000000002'));
  it.each([['modelVersion', '2'], ['modelName', 'other'], ['calibrationVersion', 'c2'], ['application', 'Other App']])('a different %s makes numeric findings not comparable and says why', (k, v) => {
    const r = run({ [k]: v });
    expect(r.comparisons[0]).toMatchObject({ status: 'not_comparable', reason: 'source_model_changed' });
    expect(r.flags.map((f) => f.type)).toContain('source_model_changed');
    expect(r.summary).toEqual({ within_uncertainty: 0, beyond_uncertainty: 0, not_comparable: 1 });
  });
  it('the same source compares normally and raises no such flag', () => { const r = run({}); expect(r.comparisons[0].status).toBe('beyond_uncertainty'); expect(r.flags).toEqual([]); });
});

describe('short-interval discrepancy', () => {
  const U = { uncertainty: pm(1) };
  const run = (gap: number, later = 50) => compareScans(scan([F('x', 10, U), F('y', 5, U)], 0, {}, 'job_000000000000000000000001'), scan([F('x', later, U), F('y', 5, U)], gap, {}, 'job_000000000000000000000002'));
  it('two scans minutes apart that disagree beyond uncertainty are flagged as a discrepancy, not a change over time', () => {
    const r = run(10 * 60_000);
    expect(r.flags).toEqual([expect.objectContaining({ type: 'short_interval_discrepancy', severity: 'attention', findingKeys: ['x'] })]);
    expect(r.comparisons.find((c) => c.findingKey === 'x')).toMatchObject({ status: 'beyond_uncertainty', shortInterval: true });
    expect(r.comparisons.find((c) => c.findingKey === 'y')!.shortInterval).toBeUndefined();
    expect(r.flags[0].detail).toMatch(/not as a change over time/);
  });
  it('the same disagreement far apart is just a difference: no flag', () => { const r = run(2 * H); expect(r.flags).toEqual([]); expect(r.comparisons[0].shortInterval).toBeUndefined(); });
  it('close together but agreeing: no flag', () => expect(run(10 * 60_000, 10.5).flags).toEqual([]));
  it('the threshold is exclusive', () => { expect(run(SHORT_INTERVAL_MS - 1).flags).toHaveLength(1); expect(run(SHORT_INTERVAL_MS).flags).toEqual([]); });
  it('identical capture times are the shortest interval of all', () => { const r = run(0); expect(r.intervalSeconds).toBe(0); expect(r.flags[0].type).toBe('short_interval_discrepancy'); });
});

describe('the document', () => {
  const U = { uncertainty: pm(1) };
  const mk = () => compareScans(scan([F('x', 10, U), F('t', 'High'), F('u', 1, { unit: 'a' })], 0, {}, 'job_000000000000000000000001'), scan([F('x', 20, U), F('t', 'High'), F('u', 1, { unit: 'b' })], 3 * D, {}, 'job_000000000000000000000002'));
  it('is valid longitudinal-comparison/v1, deterministic, and carries the neutral statement', () => {
    const a = mk(), b = mk();
    expect(validateLongitudinalComparison(a)).toEqual({ ok: true }); expect(JSON.stringify(a)).toBe(JSON.stringify(b)); expect(a.comparisonSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.statement).toBe(COMPARISON_STATEMENT); expect(a.intervalSeconds).toBe(3 * 86400);
    expect(a.summary).toEqual({ within_uncertainty: 0, beyond_uncertainty: 1, not_comparable: 2 });
  });
  it('never uses evaluative words about a change', () => {
    const text = JSON.stringify(mk()).replace(/does not say whether a change is an improvement or a deterioration/, '');
    expect(text).not.toMatch(/improv|worsen|better|worse|deteriorat|declin|recover|healthy|normal|abnormal|concern|alarm|risk|diagnos(?!is\b)/i);
  });
  it('the contract rejects an invented field or status', () => {
    const a = JSON.parse(JSON.stringify(mk()));
    expect(validateLongitudinalComparison({ ...a, verdict: 'improved' }).ok).toBe(false);
    a.comparisons[0].status = 'improved'; expect(validateLongitudinalComparison(a).ok).toBe(false);
  });
  it('does not modify its inputs and carries no subject reference', () => {
    const e = scan([F('x', 10, U)], 0, {}, 'job_000000000000000000000001'), l = scan([F('x', 20, U)], 2 * H, {}, 'job_000000000000000000000002');
    const before = JSON.stringify([e, l]); const r = compareScans(e, l);
    expect(JSON.stringify([e, l])).toBe(before); expect(JSON.stringify(r)).not.toContain(e.doc.subjectRef); expect(JSON.stringify(r)).not.toContain(e.doc.tenantId);
  });
  it('the hash covers the content: a changed value changes it', () => {
    const a = mk(); const b = compareScans(scan([F('x', 10, U)], 0, {}, 'job_000000000000000000000001'), scan([F('x', 21, U)], 3 * D, {}, 'job_000000000000000000000002'));
    expect(a.comparisonSha256).not.toBe(b.comparisonSha256);
  });
});

describe('series', () => {
  const U = { uncertainty: pm(1) };
  it('lists a finding across scans with a neutral step between neighbours; absent findings are marked, not invented', () => {
    const s = [scan([F('x', 10, { unit: 'u', ...U })], 0, {}, 'job_000000000000000000000001'), scan([F('y', 1)], 1 * D, {}, 'job_000000000000000000000002'), scan([F('x', 30, { unit: 'u', ...U })], 2 * D, {}, 'job_000000000000000000000003')];
    const { points, steps } = buildSeries('x', s);
    expect(points.map((p) => [p.status, p.value])).toEqual([['stated', 10], ['absent', null], ['stated', 30]]);
    expect(steps.map((t) => [t.status, t.reason])).toEqual([['not_comparable', 'missing_in_later'], ['not_comparable', 'missing_in_earlier']]);
  });
  it('consecutive comparable points give a step with direction only beyond uncertainty', () => {
    const s = [scan([F('x', 10, U)], 0, {}, 'job_000000000000000000000001'), scan([F('x', 10.5, U)], 1 * D, {}, 'job_000000000000000000000002'), scan([F('x', 20, U)], 2 * D, {}, 'job_000000000000000000000003')];
    const { steps } = buildSeries('x', s);
    expect(steps[0]).toMatchObject({ status: 'within_uncertainty', intervalSeconds: 86400 }); expect(steps[0].laterIs).toBeUndefined();
    expect(steps[1]).toMatchObject({ status: 'beyond_uncertainty', laterIs: 'higher' });
  });
  it('a finding that no scan has gives not_comparable steps, never an error', () => {
    const { points, steps } = buildSeries('nope', [scan([F('x', 1)], 0, {}, 'job_000000000000000000000001'), scan([F('x', 1)], D, {}, 'job_000000000000000000000002')]);
    expect(points.every((p) => p.status === 'absent')).toBe(true); expect(steps).toEqual([expect.objectContaining({ status: 'not_comparable', reason: 'missing_in_earlier' })]);
  });
  it('a single scan has no steps', () => expect(buildSeries('x', [scan([F('x', 1, U)], 0)]).steps).toEqual([]));
});
