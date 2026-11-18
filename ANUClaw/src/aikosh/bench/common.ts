/**
 * Local-only evaluation harness for AIKosh benchmarks. No network, no model call, no clinical claim: reports are DESCRIPTIVE measurements of a (usually trivial,
 * deterministic) predictor on a locally held split, labelled as such. A predictor only ever sees `item.input` (never gold, never other splits except TRAIN through
 * `fit`), and the held-out `test` split can be scored only with `final: true` (every final look is counted in the report).
 */
import { rate, Rate } from '../../validation/common';
import { BenchItem, SplitName, assertNoSplitLeakage, ContaminationError } from '../splits';
export const BENCH_NOTICE = 'Local benchmark output only — descriptive measurement on AIKosh files whose provenance, licence and consent are unverified. It is not a clinical score, validation or release claim.';
export const ABSTAIN = null;
export interface Predictor<I, P> { name: string; fit?(train: Array<BenchItem<I, unknown>>): void; predict(input: I): P | null }
export interface Bench<I, G, P> {
  id: string; description: string; items: Record<SplitName, BenchItem<I, G>[]>; score(item: BenchItem<I, G>, pred: P): boolean; sourceFiles: string[]; notes: string[];
  /** Fixed seed set of fields that must never appear in `input` (gold-bearing). */
  goldFields: string[];
}
export interface BenchReport {
  schema: 'anuclaw-aikosh-benchmark-report/v1'; notice: string; benchmark: string; split: SplitName; predictor: string; final: boolean; finalLooksOnThisSplit: number;
  counts: { items: number; answered: number; abstained: number; correct: number }; accuracyAmongAnswered: Rate; coverage: Rate; leakage: { groups: number; items: number; duplicateInputsAcrossSplits: number };
  sourceFiles: string[]; notes: string[]; clinicalScore: 'not_computed_and_not_claimed';
}
const finalLooks = new Map<string, number>();
export function resetFinalLooks() { finalLooks.clear(); }
const deepFreeze = <T,>(o: T): T => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o as object)) deepFreeze(v); } return o; };

export function runBenchmark<I, G, P>(b: Bench<I, G, P>, predictor: Predictor<I, P>, split: SplitName, opts: { final?: boolean } = {}): BenchReport {
  if (split === 'train') throw new ContaminationError('train is the fitting split: evaluating on it measures memorisation, not generalisation');
  if (split === 'test' && !opts.final) throw new ContaminationError('the held-out test split can be evaluated only with final: true (each such look is counted and reported)');
  const leakage = assertNoSplitLeakage(b.items as Record<SplitName, BenchItem[]>, { allowDuplicateInputs: true });
  predictor.fit?.(b.items.train.map((t) => deepFreeze(structuredClone(t))));
  let answered = 0, correct = 0; const key = `${b.id}|${split}`; let looks = finalLooks.get(key) ?? 0; if (opts.final && split === 'test') { looks++; finalLooks.set(key, looks); }
  for (const it of b.items[split]) {
    const input = deepFreeze(structuredClone(it.input)); const gold = typeof it.gold === 'string' ? it.gold : JSON.stringify(it.gold);
    if (gold.length >= 12 && JSON.stringify(input).includes(gold)) throw new ContaminationError(`item ${it.id}: the gold answer is present in the predictor input (benchmark construction defect)`);
    const p = predictor.predict(input); if (p === null) continue; answered++; if (b.score(it, p)) correct++;
  }
  const n = b.items[split].length;
  return { schema: 'anuclaw-aikosh-benchmark-report/v1', notice: BENCH_NOTICE, benchmark: b.id, split, predictor: predictor.name, final: !!opts.final, finalLooksOnThisSplit: split === 'test' ? looks : 0,
    counts: { items: n, answered, abstained: n - answered, correct }, accuracyAmongAnswered: rate(correct, answered), coverage: rate(answered, n), leakage, sourceFiles: b.sourceFiles, notes: b.notes, clinicalScore: 'not_computed_and_not_claimed' };
}
export const majority = (xs: string[]): string | null => { const c = new Map<string, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); let b: string | null = null, n = 0; for (const [k, v] of c) if (v > n) { b = k; n = v; } return b; };
export const abstainAll = <I, P>(): Predictor<I, P> => ({ name: 'abstain_all (harness check)', predict: () => ABSTAIN });
