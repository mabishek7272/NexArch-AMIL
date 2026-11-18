"""Independent (numpy/scipy) re-computation of the validation statistics, used to check src/validation/pose-eval.ts.
Run:  .venv-ocr/bin/python -I scripts/gen-validation-vectors.py > src/validation/validation-vectors.json
Formulas: Bland-Altman 1986/1999 (bias, limits of agreement, their CIs via the approximate SE), one-way random-effects ICC(1,1)
(Shrout & Fleiss), within-subject SD from the ANOVA error mean square, MDC95 = 1.96*sqrt(2)*Sw."""
import json, numpy as np, scipy
from scipy import stats

out = {'_provenance': {'generator': 'scripts/gen-validation-vectors.py', 'numpy': np.__version__, 'scipy': scipy.__version__}}

def ba(sys, ref):
    sys = np.array(sys, float); ref = np.array(ref, float); d = sys - ref; n = len(d)
    bias = d.mean(); s = d.std(ddof=1); t = stats.t.ppf(0.975, n - 1)
    se_bias = s / np.sqrt(n); se_loa = s * np.sqrt(1 / n + 1.96 ** 2 / (2 * (n - 1)))
    lo, hi = bias - 1.96 * s, bias + 1.96 * s
    m = (sys + ref) / 2
    slope = stats.linregress(m, d).slope
    return {'sys': list(sys), 'ref': list(ref), 'n': n, 'bias': bias, 'biasLow': bias - t * se_bias, 'biasHigh': bias + t * se_bias, 'sd': s,
            'loaLower': lo, 'loaUpper': hi, 'loaLowerLow': lo - t * se_loa, 'loaLowerHigh': lo + t * se_loa, 'loaUpperLow': hi - t * se_loa, 'loaUpperHigh': hi + t * se_loa,
            'mae': float(np.abs(d).mean()), 'rmse': float(np.sqrt((d ** 2).mean())), 'slope': float(slope)}

rng = np.random.default_rng(20261117)
ref1 = np.round(rng.normal(0, 4, 40), 2); sys1 = np.round(ref1 * 1.05 + 0.4 + rng.normal(0, 1.1, 40), 2)
out['ba_40'] = ba(sys1, ref1)
out['ba_5'] = ba([1.0, 2.5, 3.1, 4.8, 6.0], [0.5, 2.0, 3.5, 4.0, 6.5])

def icc(groups):
    groups = [np.array(g, float) for g in groups if len(g) >= 2]
    k = len(groups); N = sum(len(g) for g in groups); grand = np.concatenate(groups).mean()
    ssb = sum(len(g) * (g.mean() - grand) ** 2 for g in groups); ssw = sum(((g - g.mean()) ** 2).sum() for g in groups)
    msb = ssb / (k - 1); msw = ssw / (N - k); n0 = (N - sum(len(g) ** 2 for g in groups) / N) / (k - 1)
    sw = float(np.sqrt(msw))
    return {'groups': [list(g) for g in groups], 'k': k, 'N': N, 'sw': sw, 'icc11': float((msb - msw) / (msb + (n0 - 1) * msw)), 'cv': float(sw / abs(grand) * 100), 'mdc95': float(1.96 * np.sqrt(2) * sw)}

subj_means = rng.normal(5, 3, 12)
bal = [list(np.round(m + rng.normal(0, 0.8, 3), 2)) for m in subj_means]
unb = [list(np.round(m + rng.normal(0, 0.8, n), 2)) for m, n in zip(subj_means, [2, 3, 4, 2, 3, 5, 2, 2, 3, 4, 2, 3])]
out['icc_balanced'] = icc(bal); out['icc_unbalanced'] = icc(unb)
print(json.dumps(out, indent=1))
