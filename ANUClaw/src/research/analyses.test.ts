import { describe, expect, it } from 'vitest';
import V from './scipy-vectors.json';
import V2 from '../engines/cheminformatics/rdkit-vectors.json';
import { rdkitAvailable } from '../engines/cheminformatics/rdkit';
import { ANALYSES, AnalysisError, compareGroups, molecularProperties, descriptive, loadDataset, parseCsv, predictionEvaluation, biomarkerScreen, proportions, rates, standardisedRates } from './analyses';

const csvOf = (header: string[], rows: Array<Array<string | number>>) => [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
const O = { minCell: 1 };

describe('CSV loading', () => {
  it('parses quotes, CRLF, escaped quotes and embedded commas', () => {
    expect(parseCsv('a,b\r\n"x,1","he said ""hi"""\r\n')).toEqual([['a', 'b'], ['x,1', 'he said "hi"']]);
  });
  it('infers numeric vs categorical and treats NA/blank as missing', () => {
    const ds = loadDataset('v,g\n1,a\n2.5,b\nNA,a\n');
    expect(ds.columns).toEqual([{ name: 'v', type: 'numeric' }, { name: 'g', type: 'categorical' }]);
  });
  it.each([
    ['direct-identifier column', 'patient_name,v\nJ,1', 'identifier_column'],
    ['email column', 'Email,v\nx@y.z,1', 'identifier_column'],
    ['dob column', 'dob,v\n2000-01-01,1', 'identifier_column'],
    ['duplicate header', 'a,a\n1,2', 'bad_header'],
    ['ragged rows', 'a,b\n1', 'ragged_rows'],
    ['header only', 'a,b', 'empty_dataset'],
    ['unterminated quote', 'a,b\n"x,1', 'malformed_csv'],
  ])('rejects %s', (_l, csv, code) => {
    expect(() => loadDataset(csv)).toThrow(expect.objectContaining({ code }));
  });
  it('does not flag benign names that merely contain identifier-like substrings', () => {
    expect(() => loadDataset('username_count,filename_len,postal_total,v\n1,2,3,4')).not.toThrow();   // 'name'/'post' only as part of a longer word
    expect(() => loadDataset('surname_group_size,v\n1,2')).toThrow(expect.objectContaining({ code: 'identifier_column' })); // conservative on purpose
  });
});

describe('analyses', () => {
  const ds = loadDataset(csvOf(['value', 'grp'], [...V.welch.a.map((v) => [v, 'A']), ...V.welch.b.map((v) => [v, 'B'])]));

  it('compare_groups reproduces scipy and is deterministic', () => {
    const p = { value: 'value', group: 'grp', groupA: 'A', groupB: 'B' };
    const r1 = compareGroups(ds, p, O), r2 = compareGroups(ds, p, O);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    const res = (r1.results as any).result;
    expect(res.p).toBeCloseTo(V.welch.p, 7); expect(res.t).toBeCloseTo(V.welch.t, 9);
    expect(r1.class).toBe('exploratory');
    expect(r1.validation).toEqual({ status: 'unvalidated_research_only', clinicalClaims: 'prohibited' });
    expect(r1.notAssessed).toEqual(expect.arrayContaining(['causal inference', 'confounding adjustment', 'clinical significance']));
  });

  it('small-cell suppression withholds results instead of disclosing small groups', () => {
    const r = compareGroups(ds, { value: 'value', group: 'grp', groupA: 'A', groupB: 'B' }, { minCell: 9 }); // group A has 8
    expect((r.results as any).status).toBe('withheld_small_cell');
    expect(r.suppression.suppressed).toBeGreaterThan(0);
  });

  it('missing values are counted and excluded (complete case), never imputed', () => {
    const d = loadDataset('value,grp\n1,A\n2,A\nNA,A\n3,B\n4,B\n5,B\n');
    const r = compareGroups(d, { value: 'value', group: 'grp', groupA: 'A', groupB: 'B' }, O);
    expect(r.warnings.join(' ')).toMatch(/1 row\(s\).*excluded/);
  });

  it('wrong column types and unknown columns are explicit errors', () => {
    expect(() => compareGroups(ds, { value: 'grp', group: 'grp', groupA: 'A', groupB: 'B' }, O)).toThrow(expect.objectContaining({ code: 'wrong_column_type' }));
    expect(() => compareGroups(ds, { value: 'nope', group: 'grp', groupA: 'A', groupB: 'B' }, O)).toThrow(expect.objectContaining({ code: 'unknown_column' }));
    expect(() => compareGroups(ds, { value: 'value', group: 'grp', groupA: 'A', groupB: 'A' }, O)).toThrow(expect.objectContaining({ code: 'bad_params' }));
  });

  it('descriptive suppresses small categorical cells', () => {
    const d = loadDataset(csvOf(['sex', 'age'], [...Array(12).fill(['F', 30]), ...Array(3).fill(['M', 40])]));
    const r = descriptive(d, {}, { minCell: 5 });
    const sex = (r.results as any[]).find((x) => x.column === 'sex');
    expect(sex.levels).toEqual([{ level: 'F', n: 12 }, { level: 'M', n: null }]);
  });

  it('proportions: Wilson CIs and a risk ratio; zero cells are explicit; small cells suppressed', () => {
    const rows = [...Array(30).fill(['1', 'exposed']), ...Array(70).fill(['0', 'exposed']), ...Array(15).fill(['1', 'control']), ...Array(85).fill(['0', 'control'])];
    const r = proportions(loadDataset(csvOf(['event', 'g'], rows)), { event: 'event', group: 'g', groupA: 'exposed', groupB: 'control' }, { minCell: 5 });
    expect((r.results as any).riskRatio.ratio).toBeCloseTo(V.rr.rr, 12);
    expect((r.results as any).riskRatio.low).toBeCloseTo(V.rr.low, 9);
    const small = proportions(loadDataset(csvOf(['event', 'g'], [...Array(3).fill(['1', 'x']), ...Array(20).fill(['0', 'x']), ...Array(10).fill(['1', 'y']), ...Array(20).fill(['0', 'y'])])), { event: 'event', group: 'g', groupA: 'x', groupB: 'y' }, { minCell: 5 });
    expect((small.results as any).groups.x.status).toBe('withheld_small_cell');
    expect((small.results as any).riskRatio).toBeUndefined();
  });

  it('rates: incidence rate ratio matches the reference', () => {
    const d = loadDataset(csvOf(['cases', 'pt', 'g'], [[40, 1000, 'a'], [25, 1100, 'b']]));
    const r = rates(d, { cases: 'cases', persontime: 'pt', group: 'g', groupA: 'a', groupB: 'b' }, { minCell: 5 });
    expect((r.results as any).rateRatio.ratio).toBeCloseTo(V.irr.irr, 12);
    expect((r.results as any).rateRatio.low).toBeCloseTo(V.irr.low, 9);
  });
});

describe('prediction evaluation (research-only)', () => {
  const mk = (rows: Array<[number, number, string, string]>) => loadDataset(csvOf(['y', 'p', 'subject', 'split'], rows));
  const base = V.auc.y.map((y, i) => [y, V.auc.score[i], `s${i}`, 'test'] as [number, number, string, string]);

  it('AUC/Brier match the references; no split → labelled apparent performance', () => {
    const d = loadDataset(csvOf(['y', 'p'], V.auc.y.map((y, i) => [y, V.auc.score[i]])));
    const r = predictionEvaluation(d, { outcome: 'y', score: 'p' }, O);
    expect((r.results as any).auc).toBeCloseTo(V.auc.auc, 12);
    expect((r.results as any).brier).toBeCloseTo(V.brier.brier, 12);
    expect((r.results as any).evaluatedOn).toMatch(/apparent/);
    expect(r.warnings.join(' ')).toMatch(/APPARENT/);
    expect(r.notAssessed).toEqual(expect.arrayContaining(['external validation', 'subgroup performance', 'prospective workflow evidence', 'clinical utility / decision-curve analysis']));
  });

  it('evaluates only the test split and detects subject-level leakage', () => {
    const rows = [...base, [0, 0.2, 'train1', 'train'], [1, 0.9, 'train2', 'train']] as Array<[number, number, string, string]>;
    const ok = predictionEvaluation(mk(rows), { outcome: 'y', score: 'p', subject: 'subject', split: 'split' }, O);
    expect((ok.results as any).n).toBe(base.length);
    const leaky = [...rows, [1, 0.8, 's0', 'train']] as Array<[number, number, string, string]>; // subject s0 also in train
    const bad = predictionEvaluation(mk(leaky), { outcome: 'y', score: 'p', subject: 'subject', split: 'split' }, O);
    expect((bad.results as any).status).toBe('leakage_detected');
    expect((bad.results as any).auc).toBeUndefined();
  });

  it('scores outside [0,1] are ranked only (no calibration); single class and small cells are explicit', () => {
    const d = loadDataset(csvOf(['y', 'p'], V.auc.y.map((y, i) => [y, V.auc.score[i] * 10])));
    const r = predictionEvaluation(d, { outcome: 'y', score: 'p' }, O);
    expect((r.results as any).brier).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/rankings only/);
    expect((predictionEvaluation(loadDataset('y,p\n1,0.5\n1,0.6\n1,0.7\n'), { outcome: 'y', score: 'p' }, O).results as any).status).toBe('single_class');
    expect((predictionEvaluation(loadDataset(csvOf(['y', 'p'], V.auc.y.map((y, i) => [y, V.auc.score[i]]))), { outcome: 'y', score: 'p' }, { minCell: 50 }).results as any).status).toBe('withheld_small_cell');
  });

  it('bootstrap CI is reproducible for a seed', () => {
    const d = loadDataset(csvOf(['y', 'p'], V.auc.y.map((y, i) => [y, V.auc.score[i]])));
    const a = predictionEvaluation(d, { outcome: 'y', score: 'p', seed: 3, bootstrapB: 300 }, O), b = predictionEvaluation(d, { outcome: 'y', score: 'p', seed: 3, bootstrapB: 300 }, O);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('biomarker screen (exploratory)', () => {
  it('applies Benjamini–Hochberg across features and lists what was not assessed', () => {
    const rows: Array<Array<string | number>> = [];
    for (let i = 0; i < 12; i++) rows.push([5 + (i % 4) * 0.2, 1 + ((i * 7) % 5) * 0.1, 'case']);
    for (let i = 0; i < 12; i++) rows.push([8 + (i % 4) * 0.2, 1 + ((i * 3) % 5) * 0.1, 'ctrl']);
    const d = loadDataset(csvOf(['m1', 'm2', 'status'], rows));
    const r = biomarkerScreen(d, { features: ['m1', 'm2'], outcome: 'status', groupA: 'case', groupB: 'ctrl' }, { minCell: 5 });
    const f = (r.results as any).features;
    expect(f[0].feature).toBe('m1'); expect(f[0].qBH).toBeLessThan(0.001); expect(f[1].qBH).toBeGreaterThanOrEqual(f[1].p);
    expect(r.notAssessed).toEqual(expect.arrayContaining(['assay quality control', 'batch effects', 'confounding', 'independent replication']));
    expect(r.class).toBe('exploratory');
  });
  it('features with too few observations are skipped, not tested', () => {
    const d = loadDataset(csvOf(['m1', 'status'], [[1, 'a'], [2, 'a'], [3, 'b'], [4, 'b']]));
    expect(((biomarkerScreen(d, { features: ['m1'], outcome: 'status', groupA: 'a', groupB: 'b' }, { minCell: 1 }).results as any).features[0].status)).toBe('skipped_insufficient_data');
  });
});

describe('molecular_properties (drug-discovery research)', () => {
  const smi = ['NC(N)=O', 'CC(=O)Oc1ccccc1C(=O)O', 'c1ccsc1', 'CN(C)C(=N)N=C(N)N', 'CCO', 'C1CC', 'not-a-smiles'];
  const ds = loadDataset(['smiles', ...smi].join('\n'));
  const live = rdkitAvailable();

  it.skipIf(!live)('uses RDKit STANDARD descriptors: urea 2/1, aspirin 1/3, thiophene 0/1, metformin 3/1 (live RDKit)', async () => {
    const r = await molecularProperties(ds, { smiles: 'smiles' }, { minCell: 1 });
    const res = r.results as any;
    expect(res.descriptorSource.engine).toBe('rdkit');
    expect(res.descriptorSource.version).toBe(V2._provenance.rdkit);
    expect(res.descriptorSource.methods.hbd).toBe('rdkit.Chem.Lipinski.NumHDonors');
    expect(res).toMatchObject({ molecules: 7, parsed: 5, unparsed: 2 });
    // standard donors over {urea 2, aspirin 1, thiophene 0, metformin 3, ethanol 1} → max 3, min 0
    expect(res.descriptors.hbdStandard.max).toBe(3); expect(res.descriptors.hbdStandard.min).toBe(0);
    expect(res.descriptors.hbaStandard.max).toBe(3);
    expect(res.drugLikeness.originalLipinskiCounters.convention).toMatch(/CalcNumLipinskiHBD/);
    expect(res.drugLikeness.standardRefinedCounters.convention).toMatch(/NumHDonors/);
    expect(r.notAssessed.join(' ')).toMatch(/activity, potency.*computed, not measured/);
    expect(r.warnings.join(' ')).toMatch(/could not be parsed by RDKit/);
  }, 60_000);

  it('RDKit unavailable → H-bond counts and drug-likeness are gated, NOT substituted', async () => {
    const r = await molecularProperties(ds, { smiles: 'smiles' }, { minCell: 1 }, { rdkit: async () => ({ status: 'unavailable', reason: 'python_not_found' }) });
    const res = r.results as any;
    expect(res.descriptorSource.engine).toBe('builtin-approximation');
    expect(res.hBondCounts).toBe('unavailable_requires_rdkit');
    expect(res.drugLikeness).toBe('unavailable_requires_rdkit');
    expect(res.descriptors).toBeUndefined();
    expect(res.molecularWeight).toBeDefined();               // only quantities the cross-check showed to agree
    expect(r.warnings.join(' ')).toMatch(/NOT computed and NOT substituted/);
    expect(r.notAssessed.join(' ')).toMatch(/require RDKit/);
  });

  it('small groups are withheld', async () => {
    const r = await molecularProperties(loadDataset('smiles\nCCO\nCCC'), { smiles: 'smiles' }, { minCell: 5 }, { rdkit: async () => ({ status: 'unavailable', reason: 'python_not_found' }) });
    expect((r.results as any).molecularWeight).toBeUndefined();
  });
});

describe('registry', () => {
  it('prediction and biomarker analyses are gated; others are not', () => {
    expect(Object.fromEntries(Object.entries(ANALYSES).map(([k, v]) => [k, v.gated]))).toEqual({ descriptive: false, molecular_properties: false, compare_groups: false, proportions: false, rates: false, standardised_rates: false, prediction_evaluation: true, biomarker_screen: true });
  });
});

describe('standardised_rates (direct standardisation; weights supplied by the researcher)', () => {
  // Group A is older than group B: crude rates mislead, standardised rates compare like with like.
  const rows: Array<Array<string | number>> = [];
  for (const [g, d, t] of [['A', [2, 10, 40], [5000, 4000, 3000]], ['B', [4, 12, 30], [10000, 5000, 1000]]] as const) {
    ['young', 'mid', 'old'].forEach((band, i) => rows.push([g, band, d[i], t[i]]));
  }
  const ds = loadDataset(csvOf(['grp', 'age_band', 'cases', 'pt'], rows));
  const P = { cases: 'cases', persontime: 'pt', strata: 'age_band', weights: { young: 0.5, mid: 0.3, old: 0.2 }, group: 'grp', groupA: 'A', groupB: 'B' };

  it('crude and standardised rates are both reported; the standardised comparison differs from the crude one', () => {
    const o = standardisedRates(ds, P, O).results as any;
    expect(o.groups.A.crudeRate).toBeCloseTo(52 / 12000, 12); expect(o.groups.B.crudeRate).toBeCloseTo(46 / 16000, 12);
    const expectA = 0.5 * (2 / 5000) + 0.3 * (10 / 4000) + 0.2 * (40 / 3000);
    expect(o.groups.A.standardised.rate).toBeCloseTo(expectA, 12);
    expect(o.standardisedRateRatio.status).toBe('ok');
    expect(o.standardisedRateRatio.ratio).not.toBeCloseTo(o.groups.A.crudeRate / o.groups.B.crudeRate, 2);
  });
  it('states what is not assessed and that no standard population is bundled', () => {
    const out = standardisedRates(ds, P, O);
    expect(out.warnings.join(' ')).toMatch(/supplied by the researcher; no standard population is bundled/);
    expect(out.notAssessed).toContain('choice of standard population'); expect(out.validation.clinicalClaims).toBe('prohibited');
  });
  it('strata without a weight are an error, never merged or dropped', () => {
    expect(() => standardisedRates(ds, { ...P, weights: { young: 1, mid: 1 } }, O)).toThrow(expect.objectContaining({ code: 'weights_missing' }));
  });
  it('invalid weights are refused', () => {
    for (const w of [{}, { young: 0, mid: 1, old: 1 }, { young: -1, mid: 1, old: 1 }, { young: 'x', mid: 1, old: 1 }]) expect(() => standardisedRates(ds, { ...P, weights: w as any }, O)).toThrow(AnalysisError);
  });
  it('a standard stratum absent from a group → not estimable, not zero', () => {
    const d2 = loadDataset(csvOf(['grp', 'age_band', 'cases', 'pt'], rows.filter((r) => !(r[0] === 'B' && r[1] === 'old'))));
    const o = standardisedRates(d2, P, O).results as any;
    expect(o.groups.B.standardised.status).toBe('stratum_without_person_time'); expect(o.standardisedRateRatio.status).toBe('undefined_zero_cell');
  });
  it('multi-column strata (age × sex) are joined with "|" and need matching weights', () => {
    const r2: Array<Array<string | number>> = []; for (const g of ['A', 'B']) for (const a of ['y', 'o']) for (const sx of ['f', 'm']) r2.push([g, a, sx, 5 + (g === 'A' ? 2 : 0), 1000]);
    const d = loadDataset(csvOf(['grp', 'age', 'sex', 'cases', 'pt'], r2));
    const o = standardisedRates(d, { cases: 'cases', persontime: 'pt', strata: ['age', 'sex'], weights: { 'y|f': 1, 'y|m': 1, 'o|f': 1, 'o|m': 1 }, group: 'grp', groupA: 'A', groupB: 'B' }, O).results as any;
    expect(o.groups.A.standardised.rate).toBeCloseTo(7 / 1000, 12);
  });
  it('small cells are suppressed in stratum detail and a small group total withholds the group', () => {
    const o = standardisedRates(ds, P, { minCell: 5 }).results as any;
    expect(o.groups.A.strata.find((s: any) => s.stratum === 'young').cases).toBeNull();      // 2 < 5
    const tiny = loadDataset(csvOf(['grp', 'age_band', 'cases', 'pt'], rows.map((r) => (r[0] === 'B' ? [r[0], r[1], r[1] === 'young' ? 1 : 0, r[3]] : r))));
    const w = standardisedRates(tiny, P, { minCell: 5 }).results as any;
    expect(w.groups.B.status).toBe('withheld_small_cell'); expect(w.standardisedRateRatio).toBeUndefined();
  });
  it('is registered and ungated; the raw `rates` analysis points at it', () => {
    expect(ANALYSES.standardised_rates.gated).toBe(false);
    expect(rates(loadDataset(csvOf(['g', 'c', 't'], [['A', 3, 100], ['B', 4, 120]])), { cases: 'c', persontime: 't', group: 'g', groupA: 'A', groupB: 'B' }, O).notAssessed.join()).toMatch(/use standardised_rates/);
  });
});
