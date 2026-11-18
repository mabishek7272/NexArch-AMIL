/**
 * Registered research analyses (plan §9, §9.3). Only these can be run — there is no
 * free-form code execution. Every output is deterministic (no timestamps/randomness
 * except seeded bootstraps), states what was NOT assessed, and is research-only.
 *
 * Privacy: small-cell suppression (counts in 0 < c < minCell, and groups smaller than
 * minCell, are withheld). Missing values are counted, never imputed. Complete-case
 * analysis is the only missing-data handling.
 */
import { computeMolecularProperties } from '../engines/cheminformatics/properties';
import { rdkitDescriptors, ro5, ro5Refined, RdkitBatch, RdkitDescriptor } from '../engines/cheminformatics/rdkit';
import {
  auc, aucBootstrapCI, benjaminiHochberg, brier, calibration, describe as describeNums, rateRatio, riskRatio, standardisedRate, standardisedRateRatio, welchT, wilson,
} from './stats';

export const RESEARCH_ENGINE_VERSION = 'anuclaw-research-1.0.0';

export class AnalysisError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'AnalysisError'; }
}

// ── CSV ──────────────────────────────────────────────────────────────────────

export const LIMITS = { maxBytes: 10 * 1024 * 1024, maxRows: 100_000, maxCols: 200 };
export interface Dataset { columns: Array<{ name: string; type: 'numeric' | 'categorical' }>; rows: string[][] }

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQ = false;
  const pushField = () => { row.push(field); field = ''; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += ch;
    } else if (ch === '"' && field === '') inQ = true;
    else if (ch === ',') pushField();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      pushField(); if (!(row.length === 1 && row[0] === '')) rows.push(row); row = [];
      if (rows.length > LIMITS.maxRows + 1) throw new AnalysisError('too_many_rows', `More than ${LIMITS.maxRows} rows.`);
    } else field += ch;
  }
  if (inQ) throw new AnalysisError('malformed_csv', 'Unterminated quoted field.');
  if (field !== '' || row.length) { pushField(); rows.push(row); }
  return rows;
}

const MISSING = new Set(['', 'na', 'nan', 'null', 'n/a']);
export const isMissing = (v: string) => MISSING.has(v.trim().toLowerCase());
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Column names that look like direct identifiers are refused (heuristic; not a de-identification guarantee). */
export const IDENTIFIER_COLUMN = /(^|[^a-z])(name|first_?name|last_?name|surname|email|e_?mail|phone|tel|ssn|nhs|mrn|dob|birth_?date|date_?of_?birth|address|street|zip|post_?code)([^a-z]|$)/i;

export function loadDataset(csv: string): Dataset {
  if (Buffer.byteLength(csv) > LIMITS.maxBytes) throw new AnalysisError('too_large', 'Dataset is too large.');
  const raw = parseCsv(csv);
  if (raw.length < 2) throw new AnalysisError('empty_dataset', 'A header and at least one data row are required.');
  const header = raw[0].map((h) => h.trim());
  if (header.length > LIMITS.maxCols) throw new AnalysisError('too_many_columns', `More than ${LIMITS.maxCols} columns.`);
  if (header.some((h) => !h) || new Set(header).size !== header.length) throw new AnalysisError('bad_header', 'Column names must be non-empty and unique.');
  const bad = header.filter((h) => IDENTIFIER_COLUMN.test(h));
  if (bad.length) throw new AnalysisError('identifier_column', `Columns that look like direct identifiers are not accepted: ${bad.join(', ')}. Remove or pseudonymise them first.`);
  const rows = raw.slice(1);
  if (rows.some((r) => r.length !== header.length)) throw new AnalysisError('ragged_rows', 'Every row must have the same number of fields as the header.');
  const columns = header.map((name, j) => {
    const vals = rows.map((r) => r[j]).filter((v) => !isMissing(v));
    return { name, type: (vals.length > 0 && vals.every((v) => NUMERIC.test(v.trim())) ? 'numeric' : 'categorical') as 'numeric' | 'categorical' };
  });
  return { columns, rows };
}

function colIndex(ds: Dataset, name: unknown, type?: 'numeric' | 'categorical'): number {
  if (typeof name !== 'string') throw new AnalysisError('bad_params', 'A column name is required.');
  const i = ds.columns.findIndex((c) => c.name === name);
  if (i < 0) throw new AnalysisError('unknown_column', `Unknown column '${name}'.`);
  if (type && ds.columns[i].type !== type) throw new AnalysisError('wrong_column_type', `Column '${name}' is ${ds.columns[i].type}, expected ${type}.`);
  return i;
}
const numAt = (ds: Dataset, i: number) => ds.rows.map((r) => (isMissing(r[i]) ? null : Number(r[i])));
const strAt = (ds: Dataset, i: number) => ds.rows.map((r) => (isMissing(r[i]) ? null : r[i].trim()));

// ── common envelope ──────────────────────────────────────────────────────────

export interface AnalysisOutput {
  analysis: string; engineVersion: string; class: 'exploratory' | 'confirmatory_as_prespecified';
  results: unknown; warnings: string[]; notAssessed: string[]; suppression: { minCell: number; suppressed: number };
  validation: { status: 'unvalidated_research_only'; clinicalClaims: 'prohibited' };
}
export interface RunOptions { minCell: number; prespecified?: boolean }

class Ctx {
  warnings: string[] = []; suppressed = 0;
  constructor(readonly minCell: number) {}
  /** Count → null if it would reveal a small non-zero cell. */
  cell(c: number): number | null { if (c > 0 && c < this.minCell) { this.suppressed++; return null; } return c; }
  groupOk(n: number): boolean { if (n < this.minCell) { this.suppressed++; return false; } return true; }
}
const finish = (analysis: string, opts: RunOptions, ctx: Ctx, results: unknown, notAssessed: string[]): AnalysisOutput => ({
  analysis, engineVersion: RESEARCH_ENGINE_VERSION, class: opts.prespecified ? 'confirmatory_as_prespecified' : 'exploratory',
  results, warnings: ctx.warnings, notAssessed, suppression: { minCell: ctx.minCell, suppressed: ctx.suppressed },
  validation: { status: 'unvalidated_research_only', clinicalClaims: 'prohibited' },
});
const BASE_NOT_ASSESSED = ['causal inference', 'confounding adjustment', 'clinical significance', 'multiplicity beyond what is stated'];

// ── analyses ─────────────────────────────────────────────────────────────────

export function descriptive(ds: Dataset, params: { columns?: string[] }, opts: RunOptions): AnalysisOutput {
  const ctx = new Ctx(opts.minCell);
  const names = params.columns?.length ? params.columns : ds.columns.map((c) => c.name);
  const results = names.map((name) => {
    const i = colIndex(ds, name);
    if (ds.columns[i].type === 'numeric') {
      const v = numAt(ds, i).filter((x): x is number => x !== null);
      const missing = ds.rows.length - v.length;
      if (!ctx.groupOk(v.length)) return { column: name, type: 'numeric', n: null, missing, suppressed: 'n below minimum cell size' };
      return { column: name, type: 'numeric', missing, ...describeNums(v) };
    }
    const vals = strAt(ds, i), present = vals.filter((x): x is string => x !== null);
    const counts = new Map<string, number>(); present.forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1));
    if (counts.size > 50) return { column: name, type: 'categorical', missing: vals.length - present.length, levels: 'too_many_levels (>50): not tabulated' };
    return { column: name, type: 'categorical', missing: vals.length - present.length, levels: [...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([level, c]) => ({ level, n: ctx.cell(c) })) };
  });
  return finish('descriptive', opts, ctx, results, [...BASE_NOT_ASSESSED, 'inference']);
}

function groupPair(ds: Dataset, params: any): { gi: number; a: string; b: string } {
  const gi = colIndex(ds, params.group, 'categorical');
  const a = String(params.groupA), b = String(params.groupB);
  if (!params.groupA || !params.groupB || a === b) throw new AnalysisError('bad_params', 'groupA and groupB must be two different levels.');
  return { gi, a, b };
}

export function compareGroups(ds: Dataset, params: { value: string; group: string; groupA: string; groupB: string; confidence?: number }, opts: RunOptions): AnalysisOutput {
  const ctx = new Ctx(opts.minCell);
  const vi = colIndex(ds, params.value, 'numeric'), { gi, a, b } = groupPair(ds, params);
  const conf = params.confidence ?? 0.95;
  if (!(conf > 0.5 && conf < 1)) throw new AnalysisError('bad_params', 'confidence must be between 0.5 and 1.');
  const vals = numAt(ds, vi), grp = strAt(ds, gi);
  const xa: number[] = [], xb: number[] = []; let dropped = 0;
  vals.forEach((v, k) => { if (v === null || grp[k] === null) { dropped++; return; } if (grp[k] === a) xa.push(v); else if (grp[k] === b) xb.push(v); });
  if (dropped) ctx.warnings.push(`${dropped} row(s) with a missing value or group were excluded (complete-case analysis; nothing imputed).`);
  if (!ctx.groupOk(xa.length) || !ctx.groupOk(xb.length)) {
    return finish('compare_groups', opts, ctx, { status: 'withheld_small_cell', note: `A group has fewer than ${ctx.minCell} observations; results are withheld.` }, [...BASE_NOT_ASSESSED, 'normality', 'equal-variance (Welch used)']);
  }
  const t = welchT(xa, xb, conf);
  return finish('compare_groups', opts, ctx, {
    test: 'Welch two-sample t-test (two-sided)', value: params.value, group: params.group, groupA: a, groupB: b,
    summary: { [a]: describeNums(xa), [b]: describeNums(xb) }, result: t,
  }, [...BASE_NOT_ASSESSED, 'normality', 'outliers', 'equal-variance (Welch used)']);
}

export function proportions(ds: Dataset, params: { event: string; eventLevel?: string; group: string; groupA: string; groupB: string; confidence?: number }, opts: RunOptions): AnalysisOutput {
  const ctx = new Ctx(opts.minCell);
  const ei = colIndex(ds, params.event), { gi, a, b } = groupPair(ds, params);
  const level = String(params.eventLevel ?? '1'), ev = ds.rows.map((r) => (isMissing(r[ei]) ? null : r[ei].trim())), grp = strAt(ds, gi);
  const tally = { [a]: { k: 0, n: 0 }, [b]: { k: 0, n: 0 } } as Record<string, { k: number; n: number }>; let dropped = 0;
  ev.forEach((e, i) => { if (e === null || grp[i] === null) { dropped++; return; } const g = grp[i]!; if (g === a || g === b) { tally[g].n++; if (e === level) tally[g].k++; } });
  if (dropped) ctx.warnings.push(`${dropped} row(s) with missing event or group were excluded (complete-case).`);
  const conf = params.confidence ?? 0.95;
  const out: any = { event: params.event, eventLevel: level, groups: {} };
  let withheld = false;
  for (const g of [a, b]) {
    const { k, n } = tally[g];
    if (!ctx.groupOk(n) || ctx.cell(k) === null) { out.groups[g] = { status: 'withheld_small_cell' }; withheld = true; continue; }
    out.groups[g] = { events: k, n, proportion: wilson(k, n, conf) };
  }
  if (!withheld) out.riskRatio = riskRatio(tally[a].k, tally[a].n, tally[b].k, tally[b].n, conf);
  return finish('proportions', opts, ctx, out, [...BASE_NOT_ASSESSED, 'case definition validity', 'representativeness of the sample']);
}

export function rates(ds: Dataset, params: { cases: string; persontime: string; group: string; groupA: string; groupB: string; confidence?: number }, opts: RunOptions): AnalysisOutput {
  const ctx = new Ctx(opts.minCell);
  const ci = colIndex(ds, params.cases, 'numeric'), pi = colIndex(ds, params.persontime, 'numeric'), { gi, a, b } = groupPair(ds, params);
  const cs = numAt(ds, ci), pt = numAt(ds, pi), grp = strAt(ds, gi);
  const tot = { [a]: { c: 0, t: 0 }, [b]: { c: 0, t: 0 } } as Record<string, { c: number; t: number }>; let dropped = 0;
  cs.forEach((c, i) => {
    if (c === null || pt[i] === null || grp[i] === null) { dropped++; return; }
    if (!Number.isInteger(c) || c < 0 || pt[i]! < 0) throw new AnalysisError('bad_values', 'cases must be non-negative integers and person-time non-negative.');
    const g = grp[i]!; if (g === a || g === b) { tot[g].c += c; tot[g].t += pt[i]!; }
  });
  if (dropped) ctx.warnings.push(`${dropped} row(s) with missing values were excluded (complete-case).`);
  const out: any = { groups: {} }; let withheld = false;
  for (const g of [a, b]) {
    if (ctx.cell(tot[g].c) === null) { out.groups[g] = { status: 'withheld_small_cell' }; withheld = true; continue; }
    out.groups[g] = { cases: tot[g].c, personTime: tot[g].t, rate: tot[g].t > 0 ? tot[g].c / tot[g].t : null };
  }
  if (!withheld) out.rateRatio = tot[a].t > 0 && tot[b].t > 0 ? rateRatio(tot[a].c, tot[a].t, tot[b].c, tot[b].t, params.confidence ?? 0.95) : { status: 'undefined_zero_person_time' };
  return finish('rates', opts, ctx, out, [...BASE_NOT_ASSESSED, 'age/sex standardisation (use standardised_rates)', 'reporting delay', 'case definition validity', 'denominator validity']);
}

export function predictionEvaluation(ds: Dataset, params: { outcome: string; score: string; subject?: string; split?: string; testLabel?: string; bootstrapB?: number; seed?: number }, opts: RunOptions): AnalysisOutput {
  const ctx = new Ctx(opts.minCell);
  const oi = colIndex(ds, params.outcome, 'numeric'), si = colIndex(ds, params.score, 'numeric');
  const sub = params.subject ? strAt(ds, colIndex(ds, params.subject)) : null;
  const split = params.split ? strAt(ds, colIndex(ds, params.split)) : null;
  const testLabel = params.testLabel ?? 'test';
  const y = numAt(ds, oi), s = numAt(ds, si);
  const notAssessed = ['subgroup performance', 'external validation', 'prospective workflow evidence', 'clinical utility / decision-curve analysis', 'timing of predictor availability', 'missing-data handling beyond complete-case', 'model development (only supplied scores are evaluated)'];

  if (split && sub) { // subject-level leakage check
    const where = new Map<string, Set<string>>();
    split.forEach((sp, i) => { if (sp !== null && sub[i] !== null) { if (!where.has(sub[i]!)) where.set(sub[i]!, new Set()); where.get(sub[i]!)!.add(sp); } });
    const leaked = [...where.values()].filter((v) => v.size > 1).length;
    if (leaked) return finish('prediction_evaluation', opts, ctx, { status: 'leakage_detected', subjectsInMultipleSplits: ctx.cell(leaked) ?? `<${ctx.minCell}`, note: 'The same subject appears in more than one split; performance is not reported.' }, notAssessed);
  }
  if (!split) ctx.warnings.push('No split column: these are APPARENT (resubstitution) metrics on the supplied data, not a held-out or external evaluation.');
  if (split && !sub) ctx.warnings.push('No subject column: subject-level leakage between splits could not be checked.');

  const yy: number[] = [], ss: number[] = []; let dropped = 0;
  y.forEach((v, i) => {
    if (v === null || s[i] === null || (split && split[i] !== testLabel)) { if (v === null || s[i] === null) dropped++; return; }
    yy.push(v); ss.push(s[i]!);
  });
  if (dropped) ctx.warnings.push(`${dropped} row(s) with missing outcome or score were excluded (complete-case).`);
  if (yy.some((v) => v !== 0 && v !== 1)) throw new AnalysisError('bad_values', 'outcome must be coded 0/1.');
  const pos = yy.filter((v) => v === 1).length, neg = yy.length - pos;
  if (!ctx.groupOk(pos) && pos > 0 || !ctx.groupOk(neg) && neg > 0 || yy.length < ctx.minCell) {
    return finish('prediction_evaluation', opts, ctx, { status: 'withheld_small_cell', note: 'Too few events or non-events; results withheld.' }, notAssessed);
  }
  const a = auc(yy, ss);
  if (a === null) return finish('prediction_evaluation', opts, ctx, { status: 'single_class', note: 'Only one outcome class is present; AUC is undefined.' }, notAssessed);
  const probs = ss.every((v) => v >= 0 && v <= 1);
  if (!probs) ctx.warnings.push('Scores are outside [0,1], so they were treated as rankings only: no Brier score or calibration is reported (calibration needs probabilities).');
  const res: any = {
    n: yy.length, events: pos, nonEvents: neg, evaluatedOn: split ? `split=${testLabel}` : 'all supplied rows (apparent)',
    auc: a, aucBootstrapCI: aucBootstrapCI(yy, ss, { B: params.bootstrapB ?? 1000, seed: params.seed ?? 12345 }),
  };
  if (probs) { res.brier = brier(yy, ss); res.calibration = calibration(yy, ss, 10); }
  return finish('prediction_evaluation', opts, ctx, res, notAssessed);
}

export function biomarkerScreen(ds: Dataset, params: { features: string[]; outcome: string; groupA: string; groupB: string; confidence?: number }, opts: RunOptions): AnalysisOutput {
  const ctx = new Ctx(opts.minCell);
  if (!Array.isArray(params.features) || params.features.length < 1 || params.features.length > 1000) throw new AnalysisError('bad_params', 'features must list 1–1000 numeric columns.');
  const { gi, a, b } = groupPair(ds, { group: params.outcome, groupA: params.groupA, groupB: params.groupB });
  const grp = strAt(ds, gi), rows: any[] = [], pvals: number[] = [], idx: number[] = [];
  params.features.forEach((f) => {
    const fi = colIndex(ds, f, 'numeric'), v = numAt(ds, fi), xa: number[] = [], xb: number[] = [];
    v.forEach((x, i) => { if (x === null || grp[i] === null) return; if (grp[i] === a) xa.push(x); else if (grp[i] === b) xb.push(x); });
    if (xa.length < Math.max(3, ctx.minCell) || xb.length < Math.max(3, ctx.minCell)) { rows.push({ feature: f, status: 'skipped_insufficient_data' }); return; }
    const t = welchT(xa, xb, params.confidence ?? 0.95);
    if (t.status !== 'ok') { rows.push({ feature: f, status: t.status }); return; }
    idx.push(rows.length); pvals.push(t.p!);
    rows.push({ feature: f, status: 'tested', nA: xa.length, nB: xb.length, diff: t.diff, ciLow: t.ciLow, ciHigh: t.ciHigh, p: t.p });
  });
  const q = benjaminiHochberg(pvals);
  idx.forEach((ri, k) => { rows[ri].qBH = q[k]; });
  rows.sort((x, y) => (x.status === 'tested' ? 0 : 1) - (y.status === 'tested' ? 0 : 1) || (x.qBH ?? 2) - (y.qBH ?? 2));
  ctx.warnings.push(`${pvals.length} features tested; Benjamini–Hochberg q-values control the false discovery rate across them. These are EXPLORATORY candidate associations.`);
  return finish('biomarker_screen', opts, ctx, { groups: { A: a, B: b }, featuresRequested: params.features.length, tested: pvals.length, features: rows },
    [...BASE_NOT_ASSESSED, 'assay quality control', 'batch effects', 'confounding', 'independent replication', 'analytical validation', 'clinical validity/utility']);
}

/**
 * Drug-discovery research: computed (NOT measured) molecular properties from a SMILES column.
 *
 * Standard descriptors come from RDKit (src/engines/cheminformatics/rdkit.ts); the exact RDKit
 * version and function for every descriptor are recorded in the output. If RDKit is unavailable
 * the analysis does NOT substitute the built-in approximation for H-bond counts or drug-likeness:
 * it reports only formula/MW/heavy-atom/ring statistics (which the cross-check shows agree with
 * RDKit within 0.01 Da) and marks the rest `unavailable_requires_rdkit`.
 */
export interface DescriptorDeps { rdkit: (smiles: string[]) => Promise<RdkitBatch> }
const defaultDeps: DescriptorDeps = { rdkit: (s) => rdkitDescriptors(s) };

export async function molecularProperties(ds: Dataset, params: { smiles: string }, opts: RunOptions, deps: DescriptorDeps = defaultDeps): Promise<AnalysisOutput> {
  const ctx = new Ctx(opts.minCell);
  const si = colIndex(ds, params.smiles, 'categorical');
  const present = strAt(ds, si).filter((x): x is string => x !== null);
  const missing = ds.rows.length - present.length;
  if (missing) ctx.warnings.push(`${missing} row(s) with no SMILES were skipped.`);
  if (present.length > 10_000) throw new AnalysisError('too_many_rows', 'At most 10,000 molecules per run.');

  const batch = await deps.rdkit(present);
  const results: any = { molecules: present.length };
  const notAssessed = [
    'activity, potency, selectivity or toxicity (properties are computed, not measured)', 'docking or binding (needs a container runtime)',
    'ADMET or PK/PD prediction', 'experimental validation', 'stereochemistry and tautomer enumeration',
  ];

  if (batch.status === 'ok') {
    const rows = batch.results;
    const good = rows.filter((r): r is RdkitDescriptor => r.ok), bad = rows.length - good.length;
    if (bad) ctx.warnings.push(`${bad} SMILES could not be parsed by RDKit; they are excluded, not guessed.`);
    results.descriptorSource = { engine: 'rdkit', version: batch.rdkitVersion, methods: batch.methods };
    results.parsed = good.length; results.unparsed = bad;
    if (!ctx.groupOk(good.length)) results.status = 'withheld_small_cell';
    else {
      const stat = (f: (d: RdkitDescriptor) => number) => describeNums(good.map(f));
      results.descriptors = {
        molWt: stat((d) => d.molWt), crippenLogP: stat((d) => d.crippenLogP), tpsa: stat((d) => d.tpsa),
        hbdStandard: stat((d) => d.hbd), hbaStandard: stat((d) => d.hba),
        hbdOriginalLipinski: stat((d) => d.hbdOriginalLipinski), hbaOriginalLipinski: stat((d) => d.hbaOriginalLipinski),
        rotatableBonds: stat((d) => d.rotatableBonds),
      };
      const hist = (f: (d: RdkitDescriptor) => number) => { const m = new Map<number, number>(); good.forEach((d) => m.set(f(d), (m.get(f(d)) ?? 0) + 1)); return [...m].sort((a, b) => a[0] - b[0]).map(([v, c]) => ({ violations: v, molecules: ctx.cell(c) })); };
      results.drugLikeness = {
        note: 'Two rule-of-five conventions are reported separately because RDKit\'s standard donor/acceptor counts differ from the original-Lipinski counters. Neither is a clinical or efficacy statement.',
        originalLipinskiCounters: { convention: 'CalcNumLipinskiHBD/HBA + Crippen MolLogP + MolWt', violations: hist((d) => ro5(d).violations) },
        standardRefinedCounters: { convention: 'Lipinski.NumHDonors/NumHAcceptors + Crippen MolLogP + MolWt', violations: hist((d) => ro5Refined(d).violations) },
      };
    }
  } else {
    // RDKit unavailable: report only what the cross-check showed agrees with RDKit; gate the rest.
    ctx.warnings.push(`RDKit is unavailable (${batch.reason}); standard H-bond counts and drug-likeness are NOT computed and NOT substituted.`);
    const mw: number[] = []; let invalid = 0;
    for (const smi of present) { try { mw.push(computeMolecularProperties(smi).molecular_weight); } catch { invalid++; } }
    results.descriptorSource = { engine: 'builtin-approximation', rdkit: `unavailable (${batch.reason})` };
    results.parsed = mw.length; results.unparsed = invalid;
    if (ctx.groupOk(mw.length)) results.molecularWeight = describeNums(mw);
    results.hBondCounts = 'unavailable_requires_rdkit';
    results.drugLikeness = 'unavailable_requires_rdkit';
    notAssessed.push('standard H-bond donor/acceptor counts and drug-likeness (require RDKit)');
  }
  return finish('molecular_properties', opts, ctx, results, notAssessed);
}

/**
 * Directly standardised rates by stratum (e.g. age band × sex), for comparing two groups whose age/sex mix differs.
 * The standard population weights are SUPPLIED by the researcher (none is bundled: the choice of standard changes
 * the result and must be stated). Strata with no person-time make the standardised rate not estimable (never zero).
 */
export function standardisedRates(ds: Dataset, params: { cases: string; persontime: string; strata: string | string[]; weights: Record<string, number>; group: string; groupA: string; groupB: string; confidence?: number }, opts: RunOptions): AnalysisOutput {
  const ctx = new Ctx(opts.minCell);
  const ci = colIndex(ds, params.cases, 'numeric'), pi = colIndex(ds, params.persontime, 'numeric'), { gi, a, b } = groupPair(ds, params);
  const names = Array.isArray(params.strata) ? params.strata : [params.strata];
  if (!names.length || names.length > 3) throw new AnalysisError('bad_params', 'strata must name 1–3 columns (e.g. age band, sex).');
  const sIdx = names.map((n) => colIndex(ds, n, 'categorical'));
  const conf = params.confidence ?? 0.95;
  if (!(conf > 0.5 && conf < 1)) throw new AnalysisError('bad_params', 'confidence must be between 0.5 and 1.');
  const wEntries = Object.entries(params.weights ?? {});
  if (!wEntries.length || wEntries.some(([, v]) => typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) throw new AnalysisError('bad_params', 'weights must map every stratum label to a positive number (the standard population).');
  const weights = new Map(wEntries);
  const cs = numAt(ds, ci), pt = numAt(ds, pi), grp = strAt(ds, gi), cols = sIdx.map((i) => strAt(ds, i));
  const acc: Record<string, Map<string, { c: number; t: number }>> = { [a]: new Map(), [b]: new Map() };
  let dropped = 0; const unknown = new Set<string>();
  cs.forEach((c, i) => {
    const lab = cols.map((col) => col[i]);
    if (c === null || pt[i] === null || grp[i] === null || lab.some((l) => l === null)) { dropped++; return; }
    if (!Number.isInteger(c) || c < 0 || pt[i]! < 0) throw new AnalysisError('bad_values', 'cases must be non-negative integers and person-time non-negative.');
    const g = grp[i]!; if (g !== a && g !== b) return;
    const key = lab.join('|');
    if (!weights.has(key)) { unknown.add(key); return; }
    const cur = acc[g].get(key) ?? { c: 0, t: 0 }; cur.c += c; cur.t += pt[i]!; acc[g].set(key, cur);
  });
  if (dropped) ctx.warnings.push(`${dropped} row(s) with missing values were excluded (complete-case).`);
  if (unknown.size) throw new AnalysisError('weights_missing', `The data contain strata with no standard weight: ${[...unknown].slice(0, 10).join(', ')}. Every stratum needs a weight; nothing is merged or dropped silently.`);
  ctx.warnings.push('Standard-population weights were supplied by the researcher; no standard population is bundled. A different standard gives different standardised rates.');

  const out: any = { strata: names, standardStrata: weights.size, groups: {} }; const dsr: Record<string, ReturnType<typeof standardisedRate>> = {}; let withheld = false;
  for (const g of [a, b]) {
    const rows = [...weights].map(([key, weight]) => ({ key, weight, ...(acc[g].get(key) ?? { c: 0, t: 0 }) }));
    const totalCases = rows.reduce((x, r) => x + r.c, 0);
    if (ctx.cell(totalCases) === null) { out.groups[g] = { status: 'withheld_small_cell' }; withheld = true; continue; }
    const r = standardisedRate(rows.map((x) => ({ events: x.c, personTime: x.t, weight: x.weight })), conf);
    dsr[g] = r;
    out.groups[g] = { cases: totalCases, personTime: rows.reduce((x, y) => x + y.t, 0), crudeRate: r.crudeRate ?? null, standardised: r,
      strata: rows.map((x) => ({ stratum: x.key, cases: ctx.cell(x.c), personTime: x.t, standardWeight: x.weight })) };
  }
  if (!withheld) out.standardisedRateRatio = standardisedRateRatio(dsr[a], dsr[b], conf);
  return finish('standardised_rates', opts, ctx, out, [...BASE_NOT_ASSESSED, 'choice of standard population', 'indirect standardisation', 'age/sex-specific rate heterogeneity (a summary hides it)', 'reporting delay', 'case definition validity', 'denominator validity']);
}

export const ANALYSES = {
  descriptive: { run: descriptive, gated: false },
  molecular_properties: { run: molecularProperties, gated: false },
  compare_groups: { run: compareGroups, gated: false },
  proportions: { run: proportions, gated: false },
  rates: { run: rates, gated: false },
  standardised_rates: { run: standardisedRates, gated: false },
  prediction_evaluation: { run: predictionEvaluation, gated: true },
  biomarker_screen: { run: biomarkerScreen, gated: true },
} as const;
export type AnalysisName = keyof typeof ANALYSES;
