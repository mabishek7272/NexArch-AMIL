/** Trivial, deterministic, local predictors used to exercise the harness. They are NOT models and their output is not a benchmark of any system. */
import { BenchItem } from '../splits';
import { majority, Predictor } from './common';
import { CalcInput, KgFact, KgQuery, LabInput, McqInput, normalizeUnit } from './loaders';

export const majorityLetter = (): Predictor<McqInput, string> => { let m: string | null = null; return { name: 'majority_train_label', fit: (t) => { m = majority(t.map((x) => String(x.gold))); }, predict: () => m }; };
export const trainMedian = (): Predictor<CalcInput, number> => { let med: number | null = null; return { name: 'train_median_value', fit: (t) => { const v = t.map((x) => (x.gold as { value: number }).value).sort((a, b) => a - b); med = v.length ? v[Math.floor(v.length / 2)] : null; }, predict: () => med }; };
export const labLookup = (): Predictor<LabInput, string> => {
  const map = new Map<string, string>(); const key = (i: LabInput) => `${i.testName.toLowerCase().replace(/\s+/g, ' ').trim()}|${normalizeUnit(i.unit)}`;
  return { name: 'train_lookup_test_name_unit (abstains when unseen)', fit: (t: Array<BenchItem<LabInput, unknown>>) => { const c = new Map<string, Map<string, number>>(); for (const x of t) { const k = key(x.input); const m = c.get(k) ?? c.set(k, new Map()).get(k)!; m.set(String(x.gold), (m.get(String(x.gold)) ?? 0) + 1); }
    for (const [k, m] of c) map.set(k, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]); }, predict: (i) => map.get(key(i)) ?? null };
};
/** BM25 over the fact corpus (lexical; local). Returns the top-k fact ids. */
export const bm25 = (corpus: KgFact[], k = 5): Predictor<KgQuery, string[]> => {
  const tok = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? []; const docs = corpus.map((d) => tok(d.text)); const df = new Map<string, number>(); for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const avg = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length); const N = docs.length;
  return { name: `bm25_top${k}`, predict: (q) => { const qt = tok(q.query); const scored = docs.map((d, i) => { const tf = new Map<string, number>(); for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1); let s = 0;
    for (const t of qt) { const f = tf.get(t) ?? 0; if (!f) continue; const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5)); s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.length / avg)); } return { i, s }; }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k); return scored.map((x) => corpus[x.i].id); } };
};
