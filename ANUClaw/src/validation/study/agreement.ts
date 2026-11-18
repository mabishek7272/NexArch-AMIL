/**
 * Annotation-quality tooling (pure functions, no I/O). Measures how well two INDEPENDENT annotators agree and builds the queue of disagreements for
 * adjudication. It never converts agreement into acceptance: there is no pass/fail, no "adequate" flag, and tolerances are configuration supplied by the
 * protocol (the default is EXACT match, which is the strictest setting, not a clinical choice).
 */
import { rate, Rate } from '../common';
import { SYNTHETIC_VIEW } from '../../ocr-policy/policy';
import { normAnalyte, normUnit } from '../ocr-eval';
import { canonical, sha256Hex, StudyError } from './manifest';

export interface AnnotItem { caseId: string; page: number; analyte: string; valueRaw: string; valueNum: number | null; comparator: string | null; unit: string | null; refLow: number | null; refHigh: number | null }
export interface AnnotatorFile { schema: 'anuclaw-ocr-annotator-file/v1'; annotatorId: string; completedCaseIds: string[]; items: AnnotItem[] }
export const FIELDS = ['page', 'valueRaw', 'valueNum', 'comparator', 'unit', 'refLow', 'refHigh'] as const;
export type Field = typeof FIELDS[number];
export type Tol = { abs: number; rel: number };
export interface AgreementConfig { numericTolerance: { default: Tol; perField?: Partial<Record<'valueNum' | 'refLow' | 'refHigh', Tol>> } }
/** Tolerance comes from the OCR study policy (never a literal here). With no policy the labelled SYNTHETIC test policy's value applies. */
export const configOf = (p: { annotationTolerance: AgreementConfig['numericTolerance'] }): AgreementConfig => ({ numericTolerance: p.annotationTolerance });
export const EXACT: AgreementConfig = configOf(SYNTHETIC_VIEW);

export function validateAnnotatorFile(f: any, validCases: Map<string, number>, annotatorId: string): string[] {
  const p: string[] = [];
  if (f?.schema !== 'anuclaw-ocr-annotator-file/v1') p.push('schema must be anuclaw-ocr-annotator-file/v1');
  if (f?.annotatorId !== annotatorId) p.push(`annotatorId must equal the importing annotator (${annotatorId})`);
  if (!Array.isArray(f?.completedCaseIds) || !f.completedCaseIds.length) p.push('completedCaseIds must be a non-empty array (an annotator states which cases they completed, including cases with no values)');
  for (const c of f?.completedCaseIds ?? []) if (!validCases.has(c)) p.push(`unknown caseId ${c}`);
  for (const [i, it] of (f?.items ?? []).entries()) {
    const pages = validCases.get(it?.caseId);
    if (pages === undefined) { p.push(`item ${i}: unknown caseId ${it?.caseId}`); continue; }
    if (!(f.completedCaseIds ?? []).includes(it.caseId)) p.push(`item ${i}: case ${it.caseId} has items but is not in completedCaseIds`);
    if (!Number.isInteger(it.page) || it.page < 1 || it.page > pages) p.push(`item ${i}: page ${it.page} outside 1..${pages}`);
    if (!it.analyte || typeof it.valueRaw !== 'string') p.push(`item ${i}: analyte and valueRaw are required`);
  }
  return p;
}

const normValue = (s: string) => s.trim().replace(',', '.');
const num = (x: number | null | undefined) => (x === undefined ? null : x);
function numAgree(a: number | null, b: number | null, t: Tol): boolean {
  if (a === null || b === null) return a === b;
  const d = Math.abs(a - b); return d <= t.abs + t.rel * Math.max(Math.abs(a), Math.abs(b)) + 1e-12;
}
const tolFor = (c: AgreementConfig, f: 'valueNum' | 'refLow' | 'refHigh') => c.numericTolerance.perField?.[f] ?? c.numericTolerance.default;
const fieldValue = (it: AnnotItem, f: Field): string | number | null => f === 'valueRaw' ? normValue(it.valueRaw) : f === 'unit' ? normUnit(it.unit) : f === 'comparator' ? (it.comparator ?? null) : f === 'page' ? it.page : num(it[f] as number | null);
function fieldAgrees(a: AnnotItem, b: AnnotItem, f: Field, c: AgreementConfig): boolean {
  if (f === 'valueNum' || f === 'refLow' || f === 'refHigh') return numAgree(num(a[f]), num(b[f]), tolFor(c, f));
  return fieldValue(a, f) === fieldValue(b, f);
}

export interface AlignedPair { caseId: string; itemKey: string; a: AnnotItem | null; b: AnnotItem | null }
/** Pairs items by (case, normalised analyte, occurrence order by page); items one annotator has and the other lacks stay unpaired (presence disagreement). */
export function alignAnnotations(A: AnnotatorFile, B: AnnotatorFile): AlignedPair[] {
  const common = A.completedCaseIds.filter((c) => B.completedCaseIds.includes(c)).sort();
  const out: AlignedPair[] = [];
  for (const caseId of common) {
    const group = (F: AnnotatorFile) => { const m = new Map<string, AnnotItem[]>(); for (const it of F.items.filter((i) => i.caseId === caseId).sort((x, y) => x.page - y.page)) { const k = normAnalyte(it.analyte); (m.get(k) ?? m.set(k, []).get(k)!).push(it); } return m; };
    const ga = group(A), gb = group(B);
    for (const k of [...new Set([...ga.keys(), ...gb.keys()])].sort()) {
      const la = ga.get(k) ?? [], lb = gb.get(k) ?? [];
      for (let i = 0; i < Math.max(la.length, lb.length); i++) out.push({ caseId, itemKey: `${k}#${i + 1}`, a: la[i] ?? null, b: lb[i] ?? null });
    }
  }
  return out;
}

export interface Disagreement {
  id: string; caseId: string; itemKey: string; field: Field | 'presence'; kind: 'presence' | 'field';
  a: { annotatorId: string; value: unknown }; b: { annotatorId: string; value: unknown };
}
export interface CategoricalAgreement { field: Field; n: number; agree: number; percentAgreement: Rate; cohenKappa: number | null; kappaNote?: string }
export interface AgreementReport {
  schema: 'anuclaw-ocr-annotation-agreement/v1';
  annotators: [string, string]; casesCompared: number; config: AgreementConfig;
  presence: { itemsInEither: number; itemsInBoth: number; onlyA: number; onlyB: number; percentAgreement: Rate };
  fields: Array<CategoricalAgreement & { kind: 'categorical' | 'numeric'; meanAbsDifference?: number | null; maxAbsDifference?: number | null; tolerance?: Tol }>;
  disagreements: Disagreement[];
  note: string;
}

/** Cohen's kappa for two raters over string labels; null when chance agreement is 1 (undefined) or n = 0. */
export function cohenKappa(a: string[], b: string[]): { kappa: number | null; note?: string } {
  if (a.length !== b.length) throw new StudyError('bad_input', 'rating vectors differ in length');
  const n = a.length; if (n === 0) return { kappa: null, note: 'no items' };
  const cats = [...new Set([...a, ...b])]; let po = 0; for (let i = 0; i < n; i++) if (a[i] === b[i]) po++;
  po /= n; let pe = 0;
  for (const c of cats) pe += (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n);
  if (pe >= 1 - 1e-12) return { kappa: null, note: 'chance agreement is 1 (a single category): kappa is undefined' };
  return { kappa: (po - pe) / (1 - pe) };
}

export function compareAnnotators(A: AnnotatorFile, B: AnnotatorFile, config: AgreementConfig = EXACT): AgreementReport {
  const pairs = alignAnnotations(A, B); const both = pairs.filter((p) => p.a && p.b);
  const disagreements: Disagreement[] = [];
  const mk = (caseId: string, itemKey: string, field: Disagreement['field'], kind: Disagreement['kind'], av: unknown, bv: unknown): Disagreement => ({
    id: sha256Hex(`${caseId}|${itemKey}|${field}`).slice(0, 16), caseId, itemKey, field, kind, a: { annotatorId: A.annotatorId, value: av }, b: { annotatorId: B.annotatorId, value: bv } });
  for (const p of pairs) if (!p.a || !p.b) disagreements.push(mk(p.caseId, p.itemKey, 'presence', 'presence', p.a ?? null, p.b ?? null));
  const fields: AgreementReport['fields'] = [];
  for (const f of FIELDS) {
    const numeric = f === 'valueNum' || f === 'refLow' || f === 'refHigh'; let agree = 0; const diffs: number[] = [];
    const la: string[] = [], lb: string[] = [];
    for (const p of both) {
      const ok = fieldAgrees(p.a!, p.b!, f, config); if (ok) agree++; else disagreements.push(mk(p.caseId, p.itemKey, f, 'field', fieldValue(p.a!, f), fieldValue(p.b!, f)));
      if (numeric) { const x = num(p.a![f as 'valueNum']), y = num(p.b![f as 'valueNum']); if (x !== null && y !== null) diffs.push(Math.abs(x - y)); }
      else { la.push(String(fieldValue(p.a!, f))); lb.push(String(fieldValue(p.b!, f))); }
    }
    const k = numeric || f === 'valueRaw' ? { kappa: null as number | null, note: numeric ? 'numeric field: percent agreement and differences reported (kappa not applicable)' : 'free-text field: percent agreement only' } : cohenKappa(la, lb);
    fields.push({ field: f, kind: numeric ? 'numeric' : 'categorical', n: both.length, agree, percentAgreement: rate(agree, both.length), cohenKappa: k.kappa, kappaNote: k.note,
      ...(numeric ? { meanAbsDifference: diffs.length ? diffs.reduce((s, d) => s + d, 0) / diffs.length : null, maxAbsDifference: diffs.length ? Math.max(...diffs) : null, tolerance: tolFor(config, f as 'valueNum') } : {}) });
  }
  const onlyA = pairs.filter((p) => p.a && !p.b).length, onlyB = pairs.filter((p) => !p.a && p.b).length;
  return { schema: 'anuclaw-ocr-annotation-agreement/v1', annotators: [A.annotatorId, B.annotatorId], casesCompared: new Set(pairs.map((p) => p.caseId)).size, config,
    presence: { itemsInEither: pairs.length, itemsInBoth: both.length, onlyA, onlyB, percentAgreement: rate(both.length, pairs.length) }, fields, disagreements,
    note: 'Agreement is descriptive. It is NOT clinical acceptance and carries no pass/fail; thresholds belong in the approved protocol and are decided by people.' };
}

// ───────────────────────────── adjudication ─────────────────────────────
export interface AdjudicationRecord {
  seq: number; queueId: string; caseId: string; itemKey: string; field: Disagreement['field'];
  /** BOTH original annotations are preserved here, with the exact annotation versions and file hashes they came from. */
  original: { a: { annotatorId: string; annotationVersion: number; annotationSha256: string; value: unknown }; b: { annotatorId: string; annotationVersion: number; annotationSha256: string; value: unknown } };
  decision: { source: 'a' | 'b' | 'other' | 'ambiguous'; finalValue: unknown };
  adjudicatorId: string; reason: string; at: string; prevHash: string; hash: string;
}
export const zeroHash = '0'.repeat(64);
export function makeRecord(prev: AdjudicationRecord | null, r: Omit<AdjudicationRecord, 'seq' | 'prevHash' | 'hash' | 'at'>): AdjudicationRecord {
  const base = { ...r, seq: (prev?.seq ?? 0) + 1, at: new Date().toISOString(), prevHash: prev?.hash ?? zeroHash };
  return { ...base, hash: sha256Hex(canonical(base)) };
}
/** A record applies only if it was made against the CURRENT annotation versions; otherwise it is stale (kept, never deleted, never applied). */
export function currentDecisions(records: AdjudicationRecord[], versions: { a: { version: number; sha256: string }; b: { version: number; sha256: string } }): Map<string, AdjudicationRecord> {
  const m = new Map<string, AdjudicationRecord>();
  for (const r of records) if (r.original.a.annotationVersion === versions.a.version && r.original.a.annotationSha256 === versions.a.sha256 && r.original.b.annotationVersion === versions.b.version && r.original.b.annotationSha256 === versions.b.sha256) m.set(r.queueId, r);
  return m;
}
export interface TruthItem { id: string; page: number; analyte: string; valueRaw: string; valueNum: number | null; comparator: string | null; unit: string | null; refLow: number | null; refHigh: number | null }
export interface BuiltTruth { documents: Array<{ documentId: string; pages: number; truth: TruthItem[] }>; unresolved: Disagreement[]; excludedAmbiguous: Array<{ caseId: string; itemKey: string; field: string }> }
/** Builds the adjudicated truth. Unresolved disagreements are refused by the caller; ambiguous items are EXCLUDED and listed, never silently dropped. */
export function buildTruth(A: AnnotatorFile, B: AnnotatorFile, cases: Array<{ caseId: string; pages: number }>, decisions: Map<string, AdjudicationRecord>, config: AgreementConfig = EXACT): BuiltTruth {
  const rep = compareAnnotators(A, B, config); const queue = new Map(rep.disagreements.map((d) => [d.id, d]));
  const unresolved = rep.disagreements.filter((d) => !decisions.has(d.id)); const excluded: BuiltTruth['excludedAmbiguous'] = [];
  const pairs = alignAnnotations(A, B); const byCase = new Map<string, TruthItem[]>(); let n = 0;
  for (const p of pairs) {
    const presence = decisions.get(sha256Hex(`${p.caseId}|${p.itemKey}|presence`).slice(0, 16));
    let base: AnnotItem | null;
    if (p.a && p.b) base = p.a; else {
      if (!presence) continue;                                             // unresolved presence disagreement (already in `unresolved`)
      if (presence.decision.source === 'ambiguous' || presence.decision.finalValue === 'exclude') { excluded.push({ caseId: p.caseId, itemKey: p.itemKey, field: 'presence' }); continue; }
      const chosen = presence.decision.source === 'a' ? p.a : presence.decision.source === 'b' ? p.b : p.a ?? p.b;
      if (!chosen) { excluded.push({ caseId: p.caseId, itemKey: p.itemKey, field: 'presence' }); continue; }   // the adjudicator sided with the annotator who did NOT record the item: excluded, and listed
      base = chosen;
    }
    const it: TruthItem = { id: '', page: base.page, analyte: base.analyte, valueRaw: base.valueRaw, valueNum: num(base.valueNum), comparator: base.comparator ?? null, unit: base.unit ?? null, refLow: num(base.refLow), refHigh: num(base.refHigh) };
    let drop = false;
    if (p.a && p.b) for (const f of FIELDS) {
      const id = sha256Hex(`${p.caseId}|${p.itemKey}|${f}`).slice(0, 16);
      if (!queue.has(id)) continue;
      const d = decisions.get(id); if (!d) continue;
      if (d.decision.source === 'ambiguous') { excluded.push({ caseId: p.caseId, itemKey: p.itemKey, field: f }); drop = true; continue; }
      (it as unknown as Record<string, unknown>)[f] = d.decision.source === 'a' ? (p.a as unknown as Record<string, unknown>)[f] : d.decision.source === 'b' ? (p.b as unknown as Record<string, unknown>)[f] : d.decision.finalValue;
    }
    if (drop) continue;
    const list = byCase.get(p.caseId) ?? byCase.set(p.caseId, []).get(p.caseId)!; it.id = `${p.caseId}-t${++n}`; list.push(it);
  }
  const done = new Set(A.completedCaseIds.filter((c) => B.completedCaseIds.includes(c)));
  return { documents: cases.filter((c) => done.has(c.caseId)).map((c) => ({ documentId: c.caseId, pages: c.pages, truth: byCase.get(c.caseId) ?? [] })), unresolved, excludedAmbiguous: excluded };
}

// ───────────────────────────── missingness ─────────────────────────────
export interface MissingnessReport { schema: 'anuclaw-ocr-annotation-missingness/v1'; perAnnotator: Record<string, { items: number; missing: Record<'unit' | 'comparator' | 'refLow' | 'refHigh' | 'valueNum', Rate> }>; note: string }
/** How often each optional field is empty in each annotator's items. Informational: an empty field may be correct (a report need not print a unit or range). */
export function annotationMissingness(files: AnnotatorFile[]): MissingnessReport {
  const per: MissingnessReport['perAnnotator'] = {};
  for (const f of files) {
    const n = f.items.length; const c = (fn: (i: AnnotItem) => boolean) => rate(f.items.filter(fn).length, n);
    per[f.annotatorId] = { items: n, missing: { unit: c((i) => !i.unit), comparator: c((i) => !i.comparator), refLow: c((i) => i.refLow == null), refHigh: c((i) => i.refHigh == null), valueNum: c((i) => i.valueNum == null) } };
  }
  return { schema: 'anuclaw-ocr-annotation-missingness/v1', perAnnotator: per, note: 'Empty does not mean wrong: many reports print no unit or reference interval. Compare annotators, not against zero.' };
}
