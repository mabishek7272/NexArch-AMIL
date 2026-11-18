/**
 * Deterministic train / dev / test separation and contamination checks. Splits are assigned from a SALTED hash of a GROUP key, so every record of a group lands in the same
 * split and the assignment cannot be tuned by looking at results. Proportions are engineering placeholders in config, not statistical or clinical choices.
 */
import * as crypto from 'crypto';
export type SplitName = 'train' | 'dev' | 'test';
export interface SplitConfig { salt: string; trainFraction: number; devFraction: number }
export const DEFAULT_SPLIT: SplitConfig = { salt: 'anuclaw-aikosh-split-v1', trainFraction: 0.7, devFraction: 0.1 };
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
export function splitOf(groupKey: string, cfg: SplitConfig = DEFAULT_SPLIT): SplitName {
  const u = parseInt(crypto.createHash('sha256').update(`${cfg.salt}|${norm(groupKey)}`).digest('hex').slice(0, 8), 16) / 0x100000000;
  return u < cfg.trainFraction ? 'train' : u < cfg.trainFraction + cfg.devFraction ? 'dev' : 'test';
}
export class LeakageError extends Error { constructor(msg: string, public readonly detail: Record<string, unknown> = {}) { super(msg); this.name = 'LeakageError'; } }
export class ContaminationError extends Error { constructor(msg: string) { super(msg); this.name = 'ContaminationError'; } }
export interface BenchItem<I = unknown, G = unknown> { id: string; group: string; split: SplitName; input: I; gold: G; inputText: string }
export function partition<I, G>(items: Array<Omit<BenchItem<I, G>, 'split'>>, cfg: SplitConfig = DEFAULT_SPLIT): Record<SplitName, BenchItem<I, G>[]> {
  const out: Record<SplitName, BenchItem<I, G>[]> = { train: [], dev: [], test: [] }; for (const it of items) out[splitOf(it.group, cfg)].push({ ...it, split: splitOf(it.group, cfg) } as BenchItem<I, G>); return out;
}
/** Group keys and item ids must be disjoint across splits; identical normalised inputs must not straddle splits. Throws LeakageError listing counts (never content). */
export function assertNoSplitLeakage(parts: Record<SplitName, BenchItem[]>, opts: { allowDuplicateInputs?: boolean } = {}): { groups: number; items: number; duplicateInputsAcrossSplits: number } {
  const seenGroup = new Map<string, SplitName>(), seenId = new Map<string, SplitName>(), seenInput = new Map<string, SplitName>(); let dup = 0; let n = 0;
  for (const s of ['train', 'dev', 'test'] as SplitName[]) for (const it of parts[s]) {
    n++; const g = seenGroup.get(norm(it.group)); if (g && g !== s) throw new LeakageError(`group straddles splits (${g} and ${s})`, { split: s });
    seenGroup.set(norm(it.group), s); const i = seenId.get(it.id); if (i && i !== s) throw new LeakageError(`item id appears in two splits (${i} and ${s})`); seenId.set(it.id, s);
    const k = norm(it.inputText); const p = seenInput.get(k); if (p && p !== s) { dup++; if (!opts.allowDuplicateInputs) throw new LeakageError(`identical input text appears in two splits (${p} and ${s})`, { duplicateInputs: dup }); } else seenInput.set(k, s);
  }
  return { groups: seenGroup.size, items: n, duplicateInputsAcrossSplits: dup };
}
/**
 * Prompt-context guard. During evaluation of split S, the context may contain ONLY train-split material, and no text that carries the gold answer of any item in S (or the item's own record).
 * Gold answers shorter than `minGoldLength` (single letters, short numbers) cannot be checked by substring and are guarded by the train-only source rule instead.
 */
export function buildContext<I, G>(contextItems: Array<BenchItem<I, G>>, evaluating: SplitName, evaluatedItems: Array<BenchItem<I, G>>, render: (i: BenchItem<I, G>) => string, minGoldLength = 6): string {
  const parts: string[] = [];
  for (const c of contextItems) { if (c.split !== 'train') throw new ContaminationError(`context item ${c.id} is from the ${c.split} split; only train material may enter a prompt context`); if (evaluating === 'train') throw new ContaminationError('evaluation must not run on the split that supplies the context'); parts.push(render(c)); }
  const ctx = parts.join('\n'); assertContextClean(ctx, evaluatedItems, minGoldLength); return ctx;
}
export function assertContextClean<I, G>(contextText: string, evaluatedItems: Array<BenchItem<I, G>>, minGoldLength = 6): void {
  const c = norm(contextText);
  for (const it of evaluatedItems) {
    const g = norm(typeof it.gold === 'string' ? it.gold : JSON.stringify(it.gold)); if (g.length >= minGoldLength && c.includes(g)) throw new ContaminationError(`prompt context contains the gold answer of held-out item ${it.id}`);
    const t = norm(it.inputText); if (t.length >= 20 && c.includes(t)) throw new ContaminationError(`prompt context contains the input of held-out item ${it.id}`);
  }
}
