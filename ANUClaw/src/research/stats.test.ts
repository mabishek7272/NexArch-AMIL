/** Statistics core vs scipy-computed reference values (src/research/scipy-vectors.json). */
import { describe, expect, it } from 'vitest';
import V from './scipy-vectors.json';
import {
  auc, aucBootstrapCI, benjaminiHochberg, brier, calibration, describe as desc, mulberry32, normCdf, normQuantile,
  rateRatio, riskRatio, tQuantile, welchT, wilson, chi2Quantile, standardisedRate, standardisedRateRatio,
} from './stats';

const close = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(b)));

describe('reference values come from scipy', () => {
  it('provenance is recorded', () => { expect(V._provenance.scipy).toMatch(/^\d+\.\d+/); });
});

describe('distributions', () => {
  it.each(V.norm_cdf)('normCdf(%j)', ({ x, c }) => close(normCdf(x), c, 1e-12));
  it.each(V.norm_ppf)('normQuantile(%j)', ({ p, q }) => close(normQuantile(p), q, 1e-11));
  it.each(V.t_ppf)('tQuantile(%j)', ({ p, df, q }) => close(tQuantile(p, df), q, 1e-9));
  it('rejects out-of-range probabilities', () => { expect(() => normQuantile(0)).toThrow(); expect(() => tQuantile(1, 5)).toThrow(); });
});

describe('descriptive statistics', () => {
  it('matches numpy (mean, sd ddof=1, median, quartiles type 7)', () => {
    const d = desc(V.describe.x);
    close(d.mean, V.describe.mean); close(d.sd!, V.describe.sd); close(d.median, V.describe.median); close(d.q1, V.describe.q1); close(d.q3, V.describe.q3);
  });
  it('single value → sd is null (not NaN or 0); non-finite input rejected', () => {
    expect(desc([3]).sd).toBeNull();
    expect(() => desc([1, NaN])).toThrow(); expect(() => desc([])).toThrow();
  });
});

describe('Welch t-test', () => {
  it('matches scipy.stats.ttest_ind(equal_var=False) incl. df and CI', () => {
    const r = welchT(V.welch.a, V.welch.b);
    expect(r.status).toBe('ok');
    close(r.t!, V.welch.t); close(r.df!, V.welch.df); close(r.p!, V.welch.p, 1e-7); close(r.diff!, V.welch.diff);
    close(r.ciLow!, V.welch.ciLow, 1e-7); close(r.ciHigh!, V.welch.ciHigh, 1e-7);
  });
  it('explicit states instead of NaN', () => {
    expect(welchT([1], [1, 2]).status).toBe('insufficient_data');
    expect(welchT([2, 2, 2], [2, 2]).status).toBe('zero_variance');
  });
});

describe('proportions and ratios', () => {
  it.each(V.wilson)('wilson(%j)', ({ k, n, low, high }) => { const w = wilson(k, n); close(w.low, low, 1e-9); close(w.high, high, 1e-9); });
  it('risk ratio (Katz) matches the reference; zero cell is undefined, not corrected silently', () => {
    const r = riskRatio(V.rr.a, V.rr.n1, V.rr.c, V.rr.n2);
    close(r.ratio!, V.rr.rr); close(r.low!, V.rr.low, 1e-9); close(r.high!, V.rr.high, 1e-9);
    expect(riskRatio(0, 10, 3, 10).status).toBe('undefined_zero_cell');
  });
  it('incidence rate ratio (log method) matches the reference', () => {
    const r = rateRatio(V.irr.c1, V.irr.t1, V.irr.c2, V.irr.t2);
    close(r.ratio!, V.irr.irr); close(r.low!, V.irr.low, 1e-9); close(r.high!, V.irr.high, 1e-9);
    expect(() => rateRatio(5, 0, 5, 10)).toThrow();
  });
  it('invalid counts throw', () => { expect(() => wilson(5, 3)).toThrow(); expect(() => riskRatio(5, 3, 1, 3)).toThrow(); });
});

describe('multiple comparisons', () => {
  it('Benjamini–Hochberg matches scipy.stats.false_discovery_control', () => {
    const q = benjaminiHochberg(V.bh.p);
    q.forEach((v, i) => close(v, V.bh.q[i], 1e-12));
  });
  it('preserves input order for unsorted p-values', () => {
    const p = [0.5, 0.001, 0.04];
    const q = benjaminiHochberg(p);
    expect(q[1]).toBeLessThan(q[2]); expect(q[2]).toBeLessThanOrEqual(q[0]);
  });
});

describe('prediction evaluation', () => {
  it('AUC matches the Mann–Whitney reference; undefined with one class; ties handled', () => {
    close(auc(V.auc.y, V.auc.score)!, V.auc.auc, 1e-12);
    expect(auc([1, 1, 1], [0.1, 0.2, 0.3])).toBeNull();
    expect(auc([0, 1], [0.5, 0.5])).toBe(0.5);
  });
  it('Brier score matches the reference', () => { close(brier(V.brier.y, V.brier.p), V.brier.brier, 1e-12); });
  it('bootstrap CI is reproducible for a seed, differs across seeds, and brackets the estimate', () => {
    const a = aucBootstrapCI(V.auc.y, V.auc.score, { B: 400, seed: 7 })!, b = aucBootstrapCI(V.auc.y, V.auc.score, { B: 400, seed: 7 })!, c = aucBootstrapCI(V.auc.y, V.auc.score, { B: 400, seed: 8 })!;
    expect(a).toEqual(b); expect(a.low === c.low && a.high === c.high).toBe(false);
    expect(a.low).toBeLessThanOrEqual(V.auc.auc); expect(a.high).toBeGreaterThanOrEqual(V.auc.auc);
  });
  it('calibration bins report counts; ECE is 0 for perfectly calibrated bins', () => {
    const c = calibration([0, 1, 0, 1], [0, 1, 0, 1], 2);
    expect(c.ece).toBe(0); expect(c.bins.map((b) => b.n)).toEqual([2, 2]);
    expect(calibration([1, 1], [0.1, 0.1], 10).ece).toBeCloseTo(0.9, 12);
  });
  it('validates labels and probabilities', () => {
    expect(() => auc([0, 2], [0.1, 0.2])).toThrow(); expect(() => brier([0, 1], [0.5, 1.5])).toThrow(); expect(() => auc([0], [0.1, 0.2])).toThrow();
  });
  it('PRNG is deterministic', () => { const r = mulberry32(1), s = mulberry32(1); expect([r(), r(), r()]).toEqual([s(), s(), s()]); });
});

describe('direct standardisation (vs scipy chi2 + independent Fay–Feuer implementation)', () => {
  it.each(V.chi2_ppf)('chi2Quantile(%j)', ({ p, df, q }) => close(chi2Quantile(p, df), q, 1e-9));
  const strata = (e: number[], t: number[], w: number[]) => e.map((events, i) => ({ events, personTime: t[i], weight: w[i] }));
  it('standardised rate, variance and Fay–Feuer interval match scipy', () => {
    const r = standardisedRate(strata(V.dsr.events, V.dsr.personTime, V.dsr.weights));
    expect(r.status).toBe('ok');
    close(r.rate!, V.dsr.rate, 1e-12); close(r.variance!, V.dsr.variance, 1e-12); close(r.low!, V.dsr.low, 1e-8); close(r.high!, V.dsr.high, 1e-8);
  });
  it('weights are normalised (scale of the standard does not matter)', () => {
    const a = standardisedRate(strata(V.dsr.events, V.dsr.personTime, V.dsr.weights)), b = standardisedRate(strata(V.dsr.events, V.dsr.personTime, V.dsr.weights.map((w) => w * 1000)));
    close(a.rate!, b.rate!, 1e-12); close(a.high!, b.high!, 1e-10);
  });
  it('zero events: rate 0, lower bound 0, upper bound still estimable and matches scipy', () => {
    const r = standardisedRate(strata(V.dsr_zero.events, V.dsr_zero.personTime, V.dsr_zero.weights));
    expect(r.rate).toBe(0); expect(r.low).toBe(0); close(r.high!, V.dsr_zero.high, 1e-8);
  });
  it('a stratum with no person-time is NOT treated as a zero-rate stratum', () => {
    expect(standardisedRate([{ events: 1, personTime: 100, weight: 1 }, { events: 0, personTime: 0, weight: 1 }])).toMatchObject({ status: 'stratum_without_person_time' });
  });
  it('rejects invalid strata', () => {
    expect(() => standardisedRate([{ events: -1, personTime: 1, weight: 1 }])).toThrow(RangeError);
    expect(() => standardisedRate([{ events: 1, personTime: 1, weight: 0 }])).toThrow(RangeError);
    expect(() => standardisedRate([{ events: 1.5, personTime: 1, weight: 1 }])).toThrow(RangeError);
  });
  it('ratio of standardised rates matches the independent delta-method computation', () => {
    const a = standardisedRate(strata(V.dsr_ratio.a.events, V.dsr_ratio.a.personTime, V.dsr_ratio.weights)), b = standardisedRate(strata(V.dsr_ratio.b.events, V.dsr_ratio.b.personTime, V.dsr_ratio.weights));
    const r = standardisedRateRatio(a, b);
    close(r.ratio!, V.dsr_ratio.ratio, 1e-12); close(r.low!, V.dsr_ratio.low, 1e-9); close(r.high!, V.dsr_ratio.high, 1e-9);
  });
});
