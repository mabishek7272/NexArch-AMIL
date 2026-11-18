/**
 * AIKosh governance tests (local, no network, no model). Fixtures are tiny SYNTHETIC files created in a temp directory with their own inventory; tests against the real
 * data/aikosh files are skipped when the directory is absent. Nothing here validates any dataset or system clinically.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCsv } from './csv';
import { evaluateUse, validateApprovalContent, ApprovalRecord, Decision, FileIdentity, EXTERNAL_USES } from './policy';
import { AikoshError, readRecords } from './reader';
import { clearRestricted, findRestricted, registerRestricted, restrictedCount, RestrictedContentError } from './taint';
import { assertContextClean, assertNoSplitLeakage, buildContext, ContaminationError, LeakageError, partition, splitOf, BenchItem } from './splits';
import { ABSTAIN, Bench, runBenchmark, resetFinalLooks, Predictor } from './bench/common';
import { loadInventory, aikoshRoot, InventoryFile, registryView } from './inventory';
import { majorityLetter, labLookup } from './bench/baselines';
import { syntheticCases, regexExtractor, pathologyBench } from './bench/pathology';
import { prepareForEgress } from '../security/egress-policy';

vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const sha = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const tmp: string[] = []; afterEach(() => { clearRestricted(); resetFinalLooks(); });
function fixture(content: string, name = 'pathology/notes.csv', cols = ['id', 'narrative']): { root: string; inv: InventoryFile } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aikosh-fx-')); tmp.push(root); fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), content);
  const inv = { path: name, sizeBytes: content.length, sha256: sha(content), format: 'csv', rowCount: 1, rowCountMethod: 'x', columns: cols, schema: {}, columnIndicators: [], indicators: { provenanceFieldsFound: [], narrativeColumns: ['narrative'], directIdentifierNameIndicators: [], quasiIdentifierColumns: [], patternIndicators: [] } } as InventoryFile; return { root, inv };
}
const ID: FileIdentity = { path: 'x/a.csv', sha256: 'a'.repeat(64), narrativeColumns: ['narrative'], identifierColumns: ['document_id'] };
const good = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({ id: 'ap-1', path: ID.path, sha256: ID.sha256, recordedBy: 'u1', provenance: 'TEST provenance', licenceName: 'TEST licence', licenceRef: 'TEST-REF', licencePermitsUses: ['rag', 'embeddings', 'model_prompt', 'fine_tuning', 'external_provider', 'clinical_evidence'],
  permittedUses: ['rag'], sensitivity: 'public_reference', consentRef: null, deidentificationRef: null, externalProcessing: 'not_approved', dpaRef: null, clinicalOwnerRef: null, datasetCardSha256: null, externalFieldsReleased: [], ...over });
const approved: Decision = { decision: 'approve', decidedBy: 'u2', decidedAt: 1 };

describe('blocked external processing (pure policy)', () => {
  it('every non-local use is blocked by default with the "unknown — blocked from external processing" status', () => {
    for (const use of ['rag', 'embeddings', 'model_prompt', 'fine_tuning', 'clinical_evidence', 'external_provider'] as const) { const c = evaluateUse(ID, ID.sha256, use, null, null); expect(c.allowed).toBe(false); expect(c.status).toMatch(/unknown — blocked from external processing/); }
    expect(evaluateUse(ID, ID.sha256, 'local_deterministic_test', null, null).allowed).toBe(true); expect(evaluateUse(ID, ID.sha256, 'local_evaluation', null, null).allowed).toBe(true);
  });
  it('an approval needs a DIFFERENT second person, the exact bytes, the use in its permitted list, and is void when revoked', () => {
    expect(evaluateUse(ID, ID.sha256, 'rag', good(), null).reasons.join()).toMatch(/not been approved by a second person/);
    expect(evaluateUse(ID, ID.sha256, 'rag', good(), { ...approved, decidedBy: 'u1' }).reasons.join()).toMatch(/different person/);
    expect(evaluateUse(ID, ID.sha256, 'rag', good(), approved).allowed).toBe(true);
    expect(evaluateUse(ID, 'b'.repeat(64), 'rag', good(), approved).reasons.join()).toMatch(/file changed since the approval/);
    expect(evaluateUse(ID, ID.sha256, 'embeddings', good(), approved).reasons.join()).toMatch(/not among the permitted uses/);
    expect(evaluateUse(ID, ID.sha256, 'rag', good(), { decision: 'revoke', decidedBy: 'u2', decidedAt: 2 }).reasons.join()).toMatch(/revoked/);
  });
  it('external uses need external approval, a DPA and a non-identifiable sensitivity; fine-tuning and clinical evidence need their extra evidence', () => {
    const ext = good({ permittedUses: ['model_prompt'] }); expect(validateApprovalContent(ext).join()).toMatch(/externalProcessing = approved/); expect(validateApprovalContent(ext).join()).toMatch(/dpaRef/);
    expect(validateApprovalContent(good({ permittedUses: ['model_prompt'], externalProcessing: 'approved', dpaRef: 'DPA-1', sensitivity: 'identifiable' })).join()).toMatch(/not allowed for sensitivity "identifiable"/);
    expect(validateApprovalContent(good({ permittedUses: ['model_prompt'], externalProcessing: 'approved', dpaRef: 'DPA-1', sensitivity: 'deidentified' })).join()).toMatch(/consentRef and deidentificationRef/);
    expect(validateApprovalContent(good({ permittedUses: ['model_prompt'], externalProcessing: 'approved', dpaRef: 'DPA-1' })).length).toBe(0);
    expect(validateApprovalContent(good({ permittedUses: ['fine_tuning'], externalProcessing: 'approved', dpaRef: 'D', consentRef: 'C', deidentificationRef: 'X' })).join()).toMatch(/datasetCardSha256/);
    expect(validateApprovalContent(good({ permittedUses: ['clinical_evidence'] })).join()).toMatch(/clinicalOwnerRef/); expect(validateApprovalContent(good({ sensitivity: 'unknown' })).join()).toMatch(/cannot be approved/);
    expect(validateApprovalContent(good({ permittedUses: ['local_evaluation' as never] })).join()).toMatch(/permittedUses must list/); expect(validateApprovalContent(good({ licencePermitsUses: [] })).join()).toMatch(/not covered by the recorded licence/);
    const full = good({ permittedUses: ['model_prompt'], externalProcessing: 'approved', dpaRef: 'DPA-1', sensitivity: 'public_reference' }); expect(evaluateUse(ID, ID.sha256, 'model_prompt', full, approved).allowed).toBe(true);
    expect(evaluateUse(ID, ID.sha256, 'model_prompt', { ...full, sensitivity: 'limited' }, approved).allowed).toBe(false);
  });
  it('narrative and identifier-like fields stay blocked from external use unless the approval releases them explicitly', () => {
    const full = good({ permittedUses: ['model_prompt'], externalProcessing: 'approved', dpaRef: 'DPA-1' }); const c = evaluateUse(ID, ID.sha256, 'model_prompt', full, approved, ['narrative', 'document_id', 'plain']);
    expect(c.allowed).toBe(false); expect(c.blockedFields.sort()).toEqual(['document_id', 'narrative']);
    expect(evaluateUse(ID, ID.sha256, 'model_prompt', { ...full, externalFieldsReleased: ['narrative', 'document_id'] }, approved, ['narrative', 'document_id']).allowed).toBe(true);
    expect(EXTERNAL_USES).toEqual(expect.arrayContaining(['embeddings', 'model_prompt', 'fine_tuning', 'external_provider']));
  });
});

describe('reader: checksum tampering, path safety, unknown files, taint', () => {
  const content = 'id,narrative\n1,"Sections show synthetic carcinoma with perineural invasion present"\n';
  it('reads a verified file for local use and refuses once its bytes change (tampering / replacement)', async () => {
    const { root, inv } = fixture(content); expect((await readRecords(inv.path, 'local_deterministic_test', { root, inventoryFile: inv })).length).toBe(1);
    fs.writeFileSync(path.join(root, inv.path), content.replace('present', 'absent')); await expect(readRecords(inv.path, 'local_evaluation', { root, inventoryFile: inv })).rejects.toMatchObject({ code: 'integrity_failure' });
  });
  it('refuses unknown files, path escapes and (without an approving checker) every non-local use', async () => {
    const { root, inv } = fixture(content); await expect(readRecords('../outside.csv', 'local_evaluation', { root, inventoryFile: inv })).rejects.toMatchObject({ code: 'path_escape' });
    await expect(readRecords('pathology/other.csv', 'local_evaluation', { root })).rejects.toBeInstanceOf(AikoshError);
    for (const use of ['rag', 'embeddings', 'model_prompt', 'fine_tuning', 'clinical_evidence', 'external_provider'] as const) await expect(readRecords(inv.path, use, { root, inventoryFile: inv })).rejects.toMatchObject({ code: 'blocked' });
  });
  it('restricted (narrative / identifier) values read for local use are registered so they cannot leave the process', async () => {
    const { root, inv } = fixture(content); await readRecords(inv.path, 'local_evaluation', { root, inventoryFile: inv }); expect(restrictedCount()).toBeGreaterThan(0);
    expect(findRestricted('please summarise: Sections show synthetic carcinoma with perineural invasion present')).toBe('pathology/notes.csv'); expect(findRestricted('unrelated text')).toBeNull();
    expect(() => prepareForEgress(['context: sections show   SYNTHETIC carcinoma with perineural invasion present'], { ELAB_DEID_REQUIRED: 'false' } as never)).toThrow(RestrictedContentError);
    expect(() => prepareForEgress(['harmless'], { ELAB_DEID_REQUIRED: 'false' } as never)).not.toThrow();
  });
  it('the model-call entry point blocks restricted content for EVERY data class, before any network use', async () => {
    const { root, inv } = fixture(content); await readRecords(inv.path, 'local_evaluation', { root, inventoryFile: inv });
    const { modelCall } = await import('../ai/openrouter'); const r = await modelCall({ role: 'review', dataClass: 'reference_public', path: '/chat/completions', body: { messages: [{ role: 'user', content: `${content.split('\n')[1]}` }] } } as never);
    expect(r.status).toBe('blocked_by_egress_policy'); expect(r.detail).toMatch(/restricted AIKosh/);
  });
  it('parses quoted CSV with embedded newlines and doubled quotes', () => { expect(parseCsv('a,b\n"x\ny","he said ""hi"""\n').rows).toEqual([{ a: 'x\ny', b: 'he said "hi"' }]); });
  it('the taint registry ignores short values and never reports the value itself', () => { registerRestricted(['short', 'a long enough restricted sentence'], 'label'); expect(restrictedCount()).toBe(1); try { throw new RestrictedContentError('label'); } catch (e) { expect((e as Error).message).not.toMatch(/restricted sentence/); } });
});

describe('dataset isolation: splits, leakage, contamination', () => {
  const mk = (n: number): Array<Omit<BenchItem<{ q: string }, string>, 'split'>> => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, group: `g${i % 50}`, input: { q: `question number ${i} with padding text` }, gold: `answer-number-${i}`, inputText: `question number ${i} with padding text` }));
  it('splits are deterministic, group-wise, roughly proportioned, and the salt changes the assignment', () => {
    expect(splitOf('g1')).toBe(splitOf('g1')); const p = partition(mk(2000)); expect(p.train.length + p.dev.length + p.test.length).toBe(2000); expect(p.train.length).toBeGreaterThan(p.test.length); expect(assertNoSplitLeakage(p).groups).toBe(50);
    const other = partition(mk(2000), { salt: 'different', trainFraction: 0.7, devFraction: 0.1 }); expect(JSON.stringify(other.test.map((x) => x.id))).not.toBe(JSON.stringify(p.test.map((x) => x.id)));
  });
  it('a group, an id or an input straddling splits is reported as leakage (counts only, never content)', () => {
    const p = partition(mk(300)); const moved = { ...p.train[0], split: 'test' as const }; p.test.push(moved as never);
    expect(() => assertNoSplitLeakage(p)).toThrow(LeakageError); const q = partition(mk(300)); q.test.push({ ...q.train[0], id: 'zzz', split: 'test' } as never); expect(() => assertNoSplitLeakage(q)).toThrow(/group straddles/);
    const d = partition(mk(300)); const t = d.train[0]; d.test.push({ id: 'new', group: 'brand-new-group', input: t.input, gold: 'x', inputText: t.inputText, split: 'test' } as never); expect(() => assertNoSplitLeakage(d)).toThrow(/identical input text/);
    expect(assertNoSplitLeakage(d, { allowDuplicateInputs: true }).duplicateInputsAcrossSplits).toBe(1);
  });
  it('real benchmarks built from the AIKosh files have no group/id leakage across splits', async () => {
    if (!fs.existsSync(aikoshRoot())) return; const bench = await import('./bench'); for (const b of [await bench.calculatorBench(), await bench.medmcqaBench(), await bench.pharmacologyBench(), await bench.drugBrandBench(), await bench.labBench()]) expect(() => assertNoSplitLeakage(b.items as never, { allowDuplicateInputs: true }), b.id).not.toThrow();
  }, 60_000);
  it('prompt context may contain only TRAIN material and never the gold answer or input of a held-out item', () => {
    const p = partition(mk(400)); const ev = p.test.slice(0, 5); const render = (i: BenchItem<{ q: string }, string>) => `Q: ${i.input.q}`;
    expect(() => buildContext(p.train.slice(0, 3), 'test', ev, render)).not.toThrow(); expect(() => buildContext([p.dev[0]], 'test', ev, render)).toThrow(/only train material/); expect(() => buildContext([p.test[7]], 'test', ev, render)).toThrow(ContaminationError);
    expect(() => buildContext(p.train.slice(0, 1), 'train', ev, render)).toThrow(/same split|supplies the context/);
    expect(() => assertContextClean(`some notes ${ev[0].gold} more`, ev)).toThrow(/gold answer of held-out item/); expect(() => assertContextClean(`Q: ${ev[1].inputText} please`, ev)).toThrow(/input of held-out item/); expect(() => assertContextClean('clean context', ev)).not.toThrow();
  });
});

describe('benchmark runner contamination guards', () => {
  const items = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, group: `g${i}`, input: { q: `question ${i}` }, gold: 'ABCD'[i % 4], inputText: `question ${i}` })); const parts = partition(items);
  const bench: Bench<{ q: string }, string, string> = { id: 't', description: 'd', items: parts, score: (it, p) => p === it.gold, sourceFiles: [], notes: [], goldFields: [] };
  const pred: Predictor<{ q: string }, string> = { name: 'p', predict: () => 'A' };
  it('train cannot be evaluated; test needs final:true and every final look is counted; the report carries the no-claim notice', () => {
    expect(() => runBenchmark(bench, pred, 'train')).toThrow(/memorisation/); expect(() => runBenchmark(bench, pred, 'test')).toThrow(/final: true/);
    const r1 = runBenchmark(bench, pred, 'test', { final: true }); const r2 = runBenchmark(bench, pred, 'test', { final: true }); expect(r1.finalLooksOnThisSplit).toBe(1); expect(r2.finalLooksOnThisSplit).toBe(2);
    expect(r2.clinicalScore).toBe('not_computed_and_not_claimed'); expect(r2.notice).toMatch(/not a clinical score/); expect(runBenchmark(bench, pred, 'dev').finalLooksOnThisSplit).toBe(0);
  });
  it('the predictor sees only train data in fit and frozen, gold-free inputs in predict', () => {
    let fitIds: string[] = []; let mutated = false; const sneaky: Predictor<{ q: string }, string> = { name: 's', fit: (t) => { fitIds = t.map((x) => x.split); }, predict: (i) => { try { (i as { q: string }).q = 'x'; } catch { mutated = true; } return null; } };
    runBenchmark(bench, sneaky, 'dev'); expect(new Set(fitIds)).toEqual(new Set(['train'])); expect(mutated).toBe(true);
  });
  it('a benchmark whose input already contains the gold answer is refused (construction defect)', () => {
    const leaky = partition([...items.slice(0, 300)].map((x) => ({ ...x, gold: `the-answer-${x.id}`, input: { q: `question the-answer-${x.id}` }, inputText: x.inputText }))); const b2: Bench<{ q: string }, string, string> = { ...bench, items: leaky };
    expect(() => runBenchmark(b2, pred, 'dev')).toThrow(/gold answer is present in the predictor input/);
  });
  it('baselines behave as trivial predictors and the harness reports abstentions explicitly', () => {
    const r = runBenchmark(bench, { name: 'abstain', predict: () => ABSTAIN }, 'dev'); expect(r.counts.answered).toBe(0); expect(r.counts.abstained).toBe(bench.items.dev.length); expect(r.accuracyAmongAnswered.rate).toBeNull();
    const maj = runBenchmark(bench, majorityLetter() as never, 'dev'); expect(maj.counts.answered).toBe(bench.items.dev.length); const lab = labLookup(); lab.fit!([]); expect(lab.predict({ testName: 'x', unit: 'y', value: '1', displayRanges: '', specimen: '' })).toBeNull();
  });
  it('benchmark sources import no network or model modules (static check)', () => {
    for (const f of fs.readdirSync(path.join(__dirname, 'bench')).concat(['../reader.ts', '../splits.ts', '../policy.ts'])) { const txt = fs.readFileSync(path.join(__dirname, f.includes('..') ? f.replace('../', '') : `bench/${f}`).replace('/bench/../', '/'), 'utf8'); expect(txt, f).not.toMatch(/from 'axios'|from 'http'|from 'https'|fetch\(|openrouter|modelCall|child_process/); }
  });
});

describe('synthetic pathology benchmark (local only)', () => {
  it('the generator is seeded and deterministic; the regex extractor recovers synthetic fields; real sample narratives are not scored', async () => {
    expect(syntheticCases(5, 1)).toEqual(syntheticCases(5, 1)); expect(syntheticCases(5, 1)).not.toEqual(syntheticCases(5, 2)); const c = syntheticCases(1, 3)[0]; expect(regexExtractor().predict({ narrative: c.narrative })).toEqual(c.gold); expect(regexExtractor().predict({ narrative: 'unstructured text' })).toBeNull();
    const b = await pathologyBench(); expect(b.sourceFiles).toEqual([]); expect(b.notes.join()).toMatch(/says nothing about real pathology/);
    expect(syntheticCases(3).every((x) => x.narrative.startsWith('SYNTHETIC CASE'))).toBe(true);
  });
});

describe('inventory and registry view (real files, skipped if absent)', () => {
  it('every file on disk is inventoried with its SHA-256, defaults to "unknown — blocked from external processing", and parquet twins are flagged', () => {
    const inv = loadInventory(); expect(inv.fileCount).toBe(inv.files.length); const view = registryView(inv);
    for (const v of view) { expect(v.status).toBe('unknown — blocked from external processing'); expect([v.licence, v.consent, v.deidentification, v.externalProcessing]).toEqual(['unknown', 'unknown', 'unknown', 'unknown']); expect(v.sha256).toMatch(/^[0-9a-f]{64}$/); expect(v.catalog).not.toBeNull(); }
    expect(view.find((v) => v.path === 'pathology/sample_pathology_cases.json')!.personalDataIndicators.narrativeColumns).toEqual(expect.arrayContaining(['microscopic_examination', 'clinical_history']));
    expect(view.find((v) => v.path === 'lab/nidaankosha_lab_readings_sample.csv')!.personalDataIndicators.identifierColumns).toEqual(expect.arrayContaining(['document_id', 'age', 'gender']));
  });
  it('the inventory still matches the files on disk (hash re-check; skipped if the data directory is absent)', () => {
    if (!fs.existsSync(aikoshRoot())) return; const inv = loadInventory(); for (const f of inv.files.filter((x) => x.sizeBytes < 10_000_000)) expect(sha(fs.readFileSync(path.join(aikoshRoot(), f.path))), f.path).toBe(f.sha256);
  });
});
