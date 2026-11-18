/** Benchmark constructors. Each reads its file(s) through readRecords with use = local_evaluation (offline; no approval needed; hash-verified). */
import { readRecords, UseChecker } from '../reader';
import { normUnit } from '../../validation/ocr-eval';
import { partition, SplitConfig, DEFAULT_SPLIT, BenchItem } from '../splits';
import { Bench } from './common';

type Opts = { root?: string; split?: SplitConfig; checker?: UseChecker };
const rd = (p: string, o: Opts) => readRecords(p, 'local_evaluation', { root: o.root, checker: o.checker });
const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// ── clinical calculators ────────────────────────────────────────────────────
export interface CalcInput { question: string }
export interface CalcGold { key: string; value: number; tolerance: number }
export async function calculatorBench(o: Opts = {}): Promise<Bench<CalcInput, CalcGold, number>> {
  const rows = await rd('clinical_eval/medical_calculator_eval.csv', o); const items: Array<Omit<BenchItem<CalcInput, CalcGold>, 'split'>> = []; let skipped = 0;
  for (const r of rows) {
    let out: Record<string, unknown>; try { out = JSON.parse(s(r.expected_output)); } catch { skipped++; continue; } const v = num(out[s(r.primary_field)]); const tol = num(r.tolerance); if (v === null || tol === null) { skipped++; continue; }
    const question = `${s(r.question_text)}\n${s(r.confinement_instruction)}`;
    items.push({ id: s(r.id), group: s(r.expected_calculator), input: { question }, gold: { key: s(r.primary_field), value: v, tolerance: tol }, inputText: question });
  }
  return { id: 'calculator', description: 'Clinical calculator numeric answers (group split by calculator family: test calculators are unseen)', items: partition(items, o.split ?? DEFAULT_SPLIT), goldFields: ['expected_output', 'expected_calculator', 'primary_field', 'tolerance'],
    score: (it, p) => Math.abs(p - it.gold.value) <= it.gold.tolerance, sourceFiles: ['clinical_eval/medical_calculator_eval.csv'],
    notes: [`${skipped} rows skipped (unparseable expected_output/tolerance)`, 'tolerance is treated as ABSOLUTE; the dataset does not document whether it is absolute or relative (unverified assumption)', 'expected_calculator is the split group and is never given to the predictor'] };
}

// ── MedMCQA (English subset) ────────────────────────────────────────────────
export interface McqInput { question: string; options: string[] }
export async function medmcqaBench(o: Opts = {}): Promise<Bench<McqInput, string, string>> {
  const rows = await rd('clinical_eval/medmcqa_indic_en.csv', o); const items: Array<Omit<BenchItem<McqInput, string>, 'split'>> = []; let flagged = 0, bad = 0;
  for (const r of rows) {
    if (s(r.integrity_flags)) { flagged++; continue; } const cop = Number(r.cop); if (![0, 1, 2, 3].includes(cop)) { bad++; continue; }
    const options = [r.opa, r.opb, r.opc, r.opd].map(s); items.push({ id: s(r.id), group: s(r.question), input: { question: s(r.question), options }, gold: 'ABCD'[cop], inputText: `${s(r.question)}\n${options.join('\n')}` });
  }
  return { id: 'medmcqa', description: 'MedMCQA-style multiple choice (English subset; group split by question text)', items: partition(items, o.split ?? DEFAULT_SPLIT), goldFields: ['cop', 'exp'], score: (it, p) => p === it.gold, sourceFiles: ['clinical_eval/medmcqa_indic_en.csv'],
    notes: [`${flagged} rows excluded because integrity_flags was non-empty; ${bad} excluded for an invalid answer index`, 'the explanation column (exp) is never part of the input', 'the file name says "indic" but only language=en rows were observed'] };
}

// ── pharmacology MCQ + brand/salt mapping ──────────────────────────────────
export async function pharmacologyBench(o: Opts = {}): Promise<Bench<McqInput, string, string>> {
  const rows = await rd('pharmacology/eka_nfi_drug_pharmacology.csv', o); const items: Array<Omit<BenchItem<McqInput, string>, 'split'>> = []; let skipped = 0;
  for (const [i, r] of rows.entries()) {
    let opts: Record<string, string>; try { opts = JSON.parse(s(r.options)); } catch { skipped++; continue; } const ans = s(r.answer).trim(); if (!/^[A-E]$/.test(ans)) { skipped++; continue; }
    const options = Object.keys(opts).sort().map((k) => `${k}. ${opts[k]}`); items.push({ id: `nfi-${i}`, group: s(r.question), input: { question: s(r.question), options }, gold: ans, inputText: `${s(r.question)}\n${options.join('\n')}` });
  }
  return { id: 'pharmacology_mcq', description: 'Pharmacology multiple choice (single-letter answers only)', items: partition(items, o.split ?? DEFAULT_SPLIT), goldFields: ['answer', 'explanation'], score: (it, p) => p === it.gold, sourceFiles: ['pharmacology/eka_nfi_drug_pharmacology.csv'],
    notes: [`${skipped} rows skipped (multi-letter answers such as "A, B" or unparseable options)`, 'explanation is never part of the input'] };
}
export interface BrandInput { question: string; options: string[] }
export async function drugBrandBench(o: Opts = {}): Promise<Bench<BrandInput, string, string>> {
  const rows = await rd('pharmacology/indian_drug_brand_salts.csv', o); const items: Array<Omit<BenchItem<BrandInput, string>, 'split'>> = [];
  for (const r of rows) {
    const letters = ['a', 'b', 'c', 'd', 'e'] as const; const options = letters.map((l) => s(r[`option_${l}`])).filter(Boolean).map((t, i) => `${'ABCDE'[i]}. ${t}`); const ans = s(r.correct_answer).trim();
    if (!/^[A-E]$/.test(ans)) continue; items.push({ id: s(r.question_id), group: s(r.generic_name) || s(r.question_id), input: { question: s(r.question), options }, gold: ans, inputText: `${s(r.question)}\n${options.join('\n')}` });
  }
  return { id: 'drug_brand', description: 'Indian drug brand → generic composition (group split by generic_name so one generic never straddles splits)', items: partition(items, o.split ?? DEFAULT_SPLIT), goldFields: ['correct_answer', 'generic_name', 'medication_name'], score: (it, p) => p === it.gold, sourceFiles: ['pharmacology/indian_drug_brand_salts.csv'],
    notes: ['generic_name, medication_name, therapeutic_class and action_class_name are metadata that could reveal the answer and are never given to the predictor'] };
}

// ── laboratory extraction / normalization ──────────────────────────────────
export interface LabInput { testName: string; unit: string; value: string; displayRanges: string; specimen: string }
export async function labBench(o: Opts = {}): Promise<Bench<LabInput, string, string>> {
  const rows = await rd('lab/nidaankosha_lab_readings_sample.csv', o); const items: Array<Omit<BenchItem<LabInput, string>, 'split'>> = [];
  rows.forEach((r, i) => { const loinc = s(r.loinc); if (!loinc) return; const input = { testName: s(r.test_name), unit: s(r.unit), value: s(r.value), displayRanges: s(r.display_ranges), specimen: s(r.specimen) };
    items.push({ id: `lab-${i}`, group: s(r.document_id), input, gold: loinc, inputText: JSON.stringify(input) }); });
  return { id: 'lab', description: 'Lab test-name → LOINC normalization (group split by document_id so one report never straddles splits)', items: partition(items, o.split ?? DEFAULT_SPLIT), goldFields: ['loinc'], score: (it, p) => p === it.gold, sourceFiles: ['lab/nidaankosha_lab_readings_sample.csv'],
    notes: ['age, gender and document_id are never given to the predictor (document_id is only the split group and is registered as restricted for egress)', 'only the 15,000-row CSV sample is read; the full parquet files are inventory-only', 'LOINC labels are those in the file; their correctness is unverified', 'identical (test, unit, value) inputs recur across documents, so duplicate inputs DO appear in different splits (counted in leakage.duplicateInputsAcrossSplits); label regularity makes a test-name lookup look very accurate — that reflects the dataset, not a capability'] };
}
/** Unit normalization is the OCR study policy's unit-equivalence record (no unit equivalence is hard-coded in the benchmark). */
export function normalizeUnit(u: string): string { return normUnit(u); }

// ── knowledge-graph retrieval ───────────────────────────────────────────────
export interface KgQuery { query: string }
export interface KgFact { id: string; text: string }
const KG_RE = /^(.*?) \(([A-Za-z][A-Za-z ]*)\) (is (?:a symptom present in|a sub-concept of|treated by)) (?:the )?(.*?) \(([A-Za-z][A-Za-z ]*)\)(?: \w+)?\.$/;
export async function kgBench(file: 'knowledge_graph/bodhi_s_nl_facts.jsonl' | 'knowledge_graph/bodhi_m_nl_facts.jsonl', o: Opts = {}): Promise<Bench<KgQuery, string[], string[]> & { corpus: KgFact[]; unparsed: number }> {
  const rows = await rd(file, o); const corpus: KgFact[] = []; const byQuery = new Map<string, string[]>(); let unparsed = 0;
  rows.forEach((r, i) => { const t = s(r.text); const id = `${file.includes('_s_') ? 'S' : 'M'}${i}`; corpus.push({ id, text: t }); const m = KG_RE.exec(t); if (!m) { unparsed++; return; }
    const q = `${m[3]} ${m[4]} (${m[5]})`; (byQuery.get(q) ?? byQuery.set(q, []).get(q)!).push(id); });
  const items: Array<Omit<BenchItem<KgQuery, string[]>, 'split'>> = [...byQuery.entries()].map(([q, ids], i) => ({ id: `kgq-${i}`, group: q, input: { query: q }, gold: ids.sort(), inputText: q }));
  return { id: 'kg_retrieval', description: 'Fact retrieval: query = relation phrase + tail entity; gold = the supporting facts. Queries are split by query text; the corpus is the shared knowledge base', items: partition(items, o.split ?? DEFAULT_SPLIT), corpus, unparsed, goldFields: [],
    score: (it, p) => p.some((x) => it.gold.includes(x)), sourceFiles: [file], notes: [`${unparsed} facts did not match the parser and are in the corpus but have no query`, 'the supporting fact is in the corpus BY DESIGN (it is the retrieval target); this benchmark measures retrieval only and never builds a generation prompt, so no answer enters a prompt context',
      'the triples files are not used: their alignment with the NL-facts files is unverified'] };
}
