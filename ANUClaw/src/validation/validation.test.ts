/** The validation tools, verified with SYNTHETIC fixtures and independent numpy/scipy vectors. No real validation result is produced here. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import V from './validation-vectors.json';
import { blandAltman, evaluatePose, repeatability, PoseReferenceSet, PoseResultSet } from './pose-eval';
import { evaluateOcr } from './ocr-eval';
import { SYNTHETIC_VIEW, withOverrides } from '../ocr-policy/policy';
import { evaluateDevice } from './device-eval';
import { checkRuleDossier, RuleDossier } from './rule-approval';
import { ValidationInputError } from './common';

const root = path.resolve(__dirname, '../..');
const fx = (p: string) => JSON.parse(fs.readFileSync(path.join(root, 'validation', p), 'utf8'));
const close = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(b)));

describe('pose agreement and repeatability match independent numpy/scipy computations', () => {
  it.each([['ba_40'], ['ba_5']] as const)('Bland–Altman %s', (k) => {
    const v = (V as any)[k]; const r = blandAltman(v.sys, v.ref);
    close(r.bias!, v.bias); close(r.biasCI95!.low, v.biasLow); close(r.biasCI95!.high, v.biasHigh); close(r.sdDifference!, v.sd);
    close(r.limitsOfAgreement!.lower, v.loaLower); close(r.limitsOfAgreement!.upper, v.loaUpper);
    close(r.limitsOfAgreement!.lowerCI95.low, v.loaLowerLow); close(r.limitsOfAgreement!.lowerCI95.high, v.loaLowerHigh);
    close(r.limitsOfAgreement!.upperCI95.low, v.loaUpperLow); close(r.limitsOfAgreement!.upperCI95.high, v.loaUpperHigh);
    close(r.mae!, v.mae); close(r.rmse!, v.rmse); close(r.proportionalBiasSlope!, v.slope, 1e-8);
  });
  it.each([['icc_balanced'], ['icc_unbalanced']] as const)('repeatability %s (ICC(1,1), Sw, CV, MDC95)', (k) => {
    const v = (V as any)[k]; const r = repeatability(v.groups);
    expect(r.subjects).toBe(v.k); expect(r.observations).toBe(v.N);
    close(r.withinSubjectSD!, v.sw); close(r.icc11!, v.icc11); close(r.cvPercent!, v.cv); close(r.mdc95!, v.mdc95);
  });
  it('repeatability with too little data says so instead of inventing a number', () => {
    expect(repeatability([[1, 2]])).toMatchObject({ icc11: null, withinSubjectSD: null, note: expect.stringMatching(/at least 2 subjects/) });
    expect(repeatability([[1], [2], [3]]).icc11).toBeNull();
  });
});

describe('evaluatePose', () => {
  const ref = (n: number, kind: 'synthetic_fixture' | 'human_annotated' = 'synthetic_fixture', independent = true): PoseReferenceSet => ({
    schema: 'anuclaw-pose-reference/v1', provenance: { kind, referenceMethod: 'synthetic ground truth', referenceIndependentOfSystem: independent },
    items: Array.from({ length: n }, (_, i) => ({ clipId: `c${i}`, subjectId: `s${i}`, metricKey: 'm', unit: 'deg', referenceValue: i % 7 - 3 })),
  });
  const res = (n: number, bias = 0.5, over: Partial<PoseResultSet['items'][number]> = {}, skip: number[] = []): PoseResultSet => ({
    schema: 'anuclaw-pose-results/v1', system: { pipeline: 'fixture', modelVersion: '0' },
    items: Array.from({ length: n }, (_, i) => skip.includes(i)
      ? { clipId: `c${i}`, subjectId: `s${i}`, metricKey: 'm', unit: 'deg', status: 'unsupported' as const }
      : { clipId: `c${i}`, subjectId: `s${i}`, metricKey: 'm', unit: 'deg', status: 'estimate' as const, value: (i % 7 - 3) + bias + (i % 2 ? 0.3 : -0.3), uncertainty: 0.6, ...over }),
  });

  it('a constant bias is recovered; uncertainty coverage and tolerance are counted', () => {
    const r = evaluatePose(ref(10), res(10), { tolerances: { m: 1 } }).agreement[0];
    close(r.bias!, 0.5); expect(r.paired).toBe(10); expect(r.unsupported.k).toBe(0);
    expect(r.uncertaintyCoverage).toMatchObject({ k: 5, n: 10 });                         // |d| is 0.2 or 0.8 against a stated ±0.6: half are covered
    expect(r.withinTolerance).toMatchObject({ tolerance: 1, k: 10, n: 10 });
  });
  it('unsupported outcomes stay in the denominator (never silently dropped)', () => {
    const r = evaluatePose(ref(10), res(10, 0, {}, [1, 2, 3])).agreement[0];
    expect(r.referenceItems).toBe(10); expect(r.paired).toBe(7); expect(r.unsupported).toMatchObject({ k: 3, n: 10 });
  });
  it('an absent result counts as unsupported too', () => {
    const results = res(10); results.items.pop();
    expect(evaluatePose(ref(10), results).agreement[0].unsupported.k).toBe(1);
  });
  it('unit mismatch, duplicates and non-finite references are input errors', () => {
    expect(() => evaluatePose(ref(3), res(3, 0, { unit: 'cm' }))).toThrow(ValidationInputError);
    const dup = res(3); dup.items.push({ ...dup.items[0] }); expect(() => evaluatePose(ref(3), dup)).toThrow(/duplicate result/);
    const bad = ref(3); bad.items[0].referenceValue = NaN; expect(() => evaluatePose(bad, res(3))).toThrow(/non-finite/);
  });
  it('evidence report: synthetic data, small n, dependent reference and few subjects are each reported as reasons the dataset is structurally insufficient', () => {
    const e = evaluatePose(ref(10), res(10)).evidence;
    expect(e.datasetAdequacy.structuralMinimumsMet).toBe(false);
    for (const part of [/synthetic fixtures/, /below the minimum/, /only 10 subjects/]) expect(e.datasetAdequacy.reasons.join(' ')).toMatch(part);
    expect(e.annotationQuality.status).toBe('not_applicable_synthetic'); expect(e.uncertainty.underpoweredResults).toEqual(['m']);
    expect(evaluatePose(ref(60, 'human_annotated', false), res(60)).evidence.datasetAdequacy.reasons.join(' ')).toMatch(/not independent/);
    expect(evaluatePose(ref(60, 'human_annotated', true), res(60)).agreement[0].underpowered).toBe(false);
    const ok = evaluatePose(ref(60, 'human_annotated', true), res(60)).evidence;                // structure met ≠ validated ≠ acceptable
    expect(ok.datasetAdequacy.structuralMinimumsMet).toBe(true);
    expect(ok.datasetAdequacy.thresholdsSource).toBe('tool_default_placeholder');                // the minimums were NOT chosen by a protocol
    expect(ok.annotationQuality.status).toBe('self_declared_unverified');                        // never verified by the tool
    expect(ok.protocolApproval.status).toBe('not_recorded');
    expect(ok.clinicalAcceptance.status).toBe('not_assessed_by_this_tool'); expect(ok.disclaimer).toMatch(/Nothing in this report is clinical validation/);
  });
  it('repeats of the same subject feed repeatability without needing a reference', () => {
    const items: PoseResultSet['items'] = [];
    for (let s = 0; s < 4; s++) for (let r = 1; r <= 3; r++) items.push({ clipId: `s${s}r${r}`, subjectId: `s${s}`, repeat: r, metricKey: 'm', unit: 'deg', status: 'estimate', value: s * 5 + r * 0.2 });
    const rep = evaluatePose(ref(1), { schema: 'anuclaw-pose-results/v1', system: { pipeline: 'f', modelVersion: '0' }, items }).repeatability[0];
    expect(rep.subjects).toBe(4); close(rep.withinSubjectSD!, 0.2); expect(rep.icc11!).toBeGreaterThan(0.99);
  });
});

describe('evaluateOcr (synthetic annotated fixture with known, deliberate errors)', () => {
  const run = () => evaluateOcr(fx('fixtures/ocr/annotations.synthetic.json'), fx('fixtures/ocr/results.synthetic.json'));
  it('counts matches, misses, extraction failures, extraneous candidates exactly', () => {
    const r = run();
    expect(r.counts).toMatchObject({ documents: 3, truthItems: 11, matched: 9, missed: 0, extractionFailures: 2, extraneousCandidates: 1, pagesTotal: 5, pagesFailed: 1 });
    expect(r.failedPagesByStatus).toEqual({ ocr_unavailable: 1 });
    expect(r.recall.all).toMatchObject({ k: 9, n: 11 }); expect(r.recall.excludingFailedPages).toMatchObject({ k: 9, n: 9 });
    expect(r.precision).toMatchObject({ k: 9, n: 10 });
    expect(r.extraneous).toEqual([{ documentId: 'doc-a', analyte: 'Bilirubin', valueRaw: '12', page: 2 }]);
  });
  it('failures of an unreadable page are NOT reported as misses, and a failed page is never hidden inside recall', () => {
    const r = run(); const o = (id: string) => r.outcomes.find((x) => x.truthId === id)!;
    expect(o('b3')).toMatchObject({ status: 'extraction_failure' }); expect(o('b4')).toMatchObject({ status: 'extraction_failure' });
    expect(r.recall.all.rate).toBeLessThan(r.recall.excludingFailedPages.rate!);
  });
  it('field-level accuracy: value, unit (case-insensitive), reference bound, page attribution', () => {
    const r = run(); const f = (id: string) => r.outcomes.find((x) => x.truthId === id)!.fields!;
    expect(f('a3').allCorrect).toBe(true);                                         // "mmol/l" vs "mmol/L" is the same unit
    expect(f('a2').valueCorrect).toBe(false); expect(f('a4').unitCorrect).toBe(false); expect(f('b2').refHighCorrect).toBe(false); expect(f('c2').pageCorrect).toBe(false);
    expect(r.fieldAccuracyAmongMatched.allFields).toMatchObject({ k: 5, n: 9 });
    expect(r.fieldAccuracyAmongMatched.page).toMatchObject({ k: 8, n: 9 });
  });
  it('SILENT errors (wrong but carrying no uncertainty flag) are counted separately from flagged ones', () => {
    const u = run().uncertaintyFlags;
    expect(u.errorsInMatched).toBe(4); expect(u.errorsFlagged).toBe(1); expect(u.silentErrors).toBe(3);
    expect(u.silentErrorRateAmongMatched).toMatchObject({ k: 3, n: 9 });
  });
  it('the evidence report keeps dataset adequacy, annotation quality, uncertainty, protocol, performance and clinical acceptance SEPARATE', () => {
    const e = run().evidence;
    expect(e.datasetAdequacy.structuralMinimumsMet).toBe(false); expect(e.datasetAdequacy.meaning).toMatch(/NOT a performance result.*NOT validation.*NOT a release decision/s);
    expect(Object.keys(e).sort()).toEqual(['annotationQuality', 'clinicalAcceptance', 'datasetAdequacy', 'disclaimer', 'kind', 'measuredPerformance', 'protocolApproval', 'uncertainty']);
    expect(JSON.stringify(e)).not.toMatch(/adequateForAccuracyStatement|"validated"|"passed"/);     // no combined verdict exists
  });
  it('caller-specified minimums and protocol references are recorded as such, and still unverified', () => {
    const a = fx('fixtures/ocr/annotations.synthetic.json'); a.provenance.protocolRef = 'PROTO-123 (fixture)';
    const e = evaluateOcr(a, fx('fixtures/ocr/results.synthetic.json'), { policy: withOverrides(SYNTHETIC_VIEW, { minTruthItems: 5, minDocuments: 1 }) }).evidence;
    expect(e.datasetAdequacy.thresholdsSource).toBe('policy');
    expect(e.protocolApproval).toMatchObject({ status: 'reference_recorded_unverified', reference: 'PROTO-123 (fixture)' }); expect(e.protocolApproval.meaning).toMatch(/not verified/);
  });
  it('the uncertainty-flag threshold comes from the policy record, not a hidden constant', () => {
    const results = fx('fixtures/ocr/results.synthetic.json'); results.documents[0].candidates[3].ocrConfidence = 0.7;      // the silent unit error (a4) is now low-confidence
    const strict = evaluateOcr(fx('fixtures/ocr/annotations.synthetic.json'), results, { policy: withOverrides(SYNTHETIC_VIEW, { confidenceFlagThreshold: 0.8 }) }).uncertaintyFlags;
    const lax = evaluateOcr(fx('fixtures/ocr/annotations.synthetic.json'), results, { policy: withOverrides(SYNTHETIC_VIEW, { confidenceFlagThreshold: 0.5 }) }).uncertaintyFlags;
    expect(strict.silentErrors).toBe(2); expect(lax.silentErrors).toBe(3);
  });
  it('a result set that omits an annotated document is an input error (omission cannot improve the score)', () => {
    const results = fx('fixtures/ocr/results.synthetic.json'); results.documents = results.documents.slice(0, 2);
    expect(() => evaluateOcr(fx('fixtures/ocr/annotations.synthetic.json'), results)).toThrow(/missing annotated documents: doc-c/);
  });
  it('annotation validation: bad pages, duplicate ids, human sets without annotators', () => {
    const a = fx('fixtures/ocr/annotations.synthetic.json'); a.documents[0].truth[0].page = 9;
    expect(() => evaluateOcr(a, fx('fixtures/ocr/results.synthetic.json'))).toThrow(/page 9 outside 1\.\.2/);
    const h = fx('fixtures/ocr/annotations.synthetic.json'); h.provenance = { ...h.provenance, kind: 'human_annotated', annotators: [] };
    expect(() => evaluateOcr(h, fx('fixtures/ocr/results.synthetic.json'))).toThrow(/name their annotators/);
  });
});

describe('evaluateDevice (synthetic log: 10-min outage, buffered burst, duplicate, future-dated clock)', () => {
  const r = () => evaluateDevice(fx('fixtures/device/log.synthetic.json'));
  it('finds the induced outage and measures completeness/duplicates', () => {
    const e = r();
    expect(e.gaps.knownOutagesDetected).toEqual({ detected: 1, total: 1 });
    expect(e.gaps.longestSec).toBeGreaterThanOrEqual(600);
    expect(e.completeness.expected).toBe(120); expect(e.completeness.duplicates).toBe(1);
    expect(e.completeness.rate.rate!).toBeGreaterThan(0.8); expect(e.completeness.rate.rate!).toBeLessThan(0.95);
  });
  it('detects the buffered flush as a backlog burst with delayed delivery, and flags the future-dated clock', () => {
    const e = r();
    expect(e.delivery.backlogBursts).toBe(1); expect(e.delivery.latencySec.max!).toBeGreaterThanOrEqual(300);
    expect(e.delivery.delayedBeyondMaxLatency.k).toBe(0);                                  // 5 min < the 15 min limit
    expect(e.clock.aheadOfReceiptBeyondSkew.k).toBe(1); expect(e.clock.untrustedClockSuspected).toBe(true);
    expect(e.delivery.outOfOrder.k).toBeGreaterThanOrEqual(1);
  });
  it('current-value availability uses the product freshness model: outage and burst cost availability, shares sum to 1', () => {
    const a = r().currentValueAvailability;
    close(a.fractionCurrent! + a.fractionStale! + a.fractionNoData!, 1, 1e-12);
    expect(a.fractionCurrent!).toBeGreaterThan(0.6); expect(a.fractionCurrent!).toBeLessThan(0.92);
    expect(a.fractionStale!).toBeGreaterThan(0.05);
  });
  it('a perfectly regular delivery is 100% complete with no gaps; a single session is never "adequate" evidence', () => {
    const t0 = Date.parse('2026-11-17T08:00:00Z'); const obs = Array.from({ length: 60 }, (_, i) => ({ sourceTime: new Date(t0 + i * 60000).toISOString(), receivedTime: new Date(t0 + i * 60000 + 1500).toISOString() }));
    const e = evaluateDevice({ schema: 'anuclaw-device-log/v1', provenance: { kind: 'human_annotated', device: { kind: 'x' } }, metric: 'heart_rate', windowStart: new Date(t0).toISOString(), windowEnd: new Date(t0 + 3600000).toISOString(), observations: obs });
    expect(e.gaps.count).toBe(0); expect(e.completeness.rate.rate).toBe(1); expect(e.clock.untrustedClockSuspected).toBe(false);
    expect(e.delivery.latencySec.p50).toBeCloseTo(1.5, 9); expect(e.evidence.datasetAdequacy.structuralMinimumsMet).toBe(false);
  });
  it('input errors: unknown metric, reversed window, unparsable times', () => {
    const base = fx('fixtures/device/log.synthetic.json');
    expect(() => evaluateDevice({ ...base, metric: 'nope' })).toThrow(/unknown metric/);
    expect(() => evaluateDevice({ ...base, windowEnd: base.windowStart })).toThrow(/windowEnd/);
    expect(() => evaluateDevice({ ...base, observations: [{ sourceTime: 'x', receivedTime: 'y' }] })).toThrow(/unparsable/);
  });
});

describe('checkRuleDossier (can never approve; checks completeness and runs boundary cases)', () => {
  const dossier = (): RuleDossier => fx('fixtures/rule-dossier.synthetic.json');
  const evaluator = (i: Record<string, unknown>): string => {
    if (typeof i.ageYears === 'number' && i.ageYears < 18) return 'not_applicable';
    if (i.unit !== 'unit') return 'not_comparable';
    if (typeof i.value !== 'number') return 'insufficient_data';
    return i.value < 10 ? 'low' : i.value > 20 ? 'high' : 'within';
  };
  const reviewer = { name: 'Dr Synthetic Fixture', role: 'consultant (fixture)', credentialRef: 'FIXTURE-LIC-0', independentOfAuthor: true, conflictOfInterestStatement: 'None declared (fixture).' };

  it('fixture without a reviewer is incomplete for exactly that reason; all eight boundary cases execute and pass', () => {
    const r = checkRuleDossier(dossier(), evaluator);
    expect(r.status).toBe('incomplete'); expect(r.issues.filter((i) => i.severity === 'error').map((i) => i.code)).toEqual(['reviewer']);
    expect(r.boundaryResults).toHaveLength(8); expect(r.boundaryResults.every((b) => b.pass)).toBe(true);
    expect(r.coverage.missing).toEqual([]);
  });
  it('with an independent reviewer but no signature: complete_awaiting_human_decision — still not approved, no register draft', () => {
    const r = checkRuleDossier({ ...dossier(), reviewer }, evaluator);
    expect(r.status).toBe('complete_awaiting_human_decision'); expect(r.registerEntryDraft).toBeNull();
  });
  it('with a signature block: signed_record_asserted_unverified + a register DRAFT; the statement says nothing is approved', () => {
    const r = checkRuleDossier({ ...dossier(), reviewer, signature: { statement: 'I reviewed the dossier and approve this version for the stated population.', signedAt: '2026-11-01', recordRef: 'FIXTURE-RECORD-1' } }, evaluator);
    expect(r.status).toBe('signed_record_asserted_unverified');
    expect(r.registerEntryDraft).toMatchObject({ ruleId: 'fixture.synthetic-range-check', ruleVersion: '1.0.0', approverName: 'Dr Synthetic Fixture', approvedAt: '2026-11-01', recordRef: 'FIXTURE-RECORD-1' });
    expect(r.statement).toMatch(/does NOT approve/);
    expect(['incomplete', 'complete_awaiting_human_decision', 'signed_record_asserted_unverified']).toContain(r.status);   // there is no "approved" status
  });
  it('an off-by-one boundary bug in the rule is caught at the exact case (inclusive upper bound)', () => {
    const buggy = (i: Record<string, unknown>) => (i.value === 20 ? 'high' : evaluator(i));
    const r = checkRuleDossier({ ...dossier(), reviewer }, buggy);
    expect(r.status).toBe('incomplete'); expect(r.issues.some((i) => i.code === 'boundary_mismatch' && /case c4 \(at_upper\)/.test(i.message))).toBe(true);
  });
  it('an evaluator that throws is a failed case, not a pass', () => {
    const r = checkRuleDossier({ ...dossier(), reviewer }, () => { throw new Error('boom'); });
    expect(r.boundaryResults.every((b) => !b.pass && /boom/.test(b.note ?? ''))).toBe(true);
  });
  it('no evaluator → warning that the cases were NOT executed', () => {
    expect(checkRuleDossier({ ...dossier(), reviewer }).issues.some((i) => i.code === 'not_executed')).toBe(true);
  });
  it.each([
    ['placeholder source', (d: RuleDossier) => { d.source.citation = 'TBD'; }, 'source'],
    ['short intended use', (d: RuleDossier) => { d.intendedUse = 'checks values'; }, 'intended_use'],
    ['missing exclusions', (d: RuleDossier) => { d.population.excluded = []; }, 'exclusions'],
    ['non-semantic version', (d: RuleDossier) => { d.rule.version = 'v1'; }, 'rule_version'],
    ['reviewer not independent', (d: RuleDossier) => { d.reviewer = { ...reviewer, independentOfAuthor: false }; }, 'reviewer_independence'],
    ['no conflict-of-interest statement', (d: RuleDossier) => { d.reviewer = { ...reviewer, conflictOfInterestStatement: '' }; }, 'reviewer_coi'],
    ['missing boundary kind', (d: RuleDossier) => { d.boundaryCases = d.boundaryCases.filter((c) => c.kind !== 'at_upper'); }, 'boundary_coverage'],
    ['no acceptance targets', (d: RuleDossier) => { d.evaluationPlan.acceptanceTargets = {}; }, 'evaluation_plan'],
    ['threshold order', (d: RuleDossier) => { d.thresholds[0].lower = 30; }, 'threshold_order'],
    ['future signature', (d: RuleDossier) => { d.reviewer = reviewer; d.signature = { statement: 'approve', signedAt: '2999-01-01', recordRef: 'r' }; }, 'signature_future'],
    ['signature without reviewer', (d: RuleDossier) => { d.reviewer = null; d.signature = { statement: 'approve', signedAt: '2026-01-01', recordRef: 'r' }; }, 'signature_without_reviewer'],
    ['previous version equals current', (d: RuleDossier) => { d.changeControl.previousVersion = d.rule.version; }, 'change_control'],
  ])('%s is rejected', (_n, mutate, code) => {
    const d = dossier(); d.reviewer = reviewer; mutate(d);
    const r = checkRuleDossier(d, evaluator);
    expect(r.status).toBe('incomplete'); expect(r.issues.map((i) => i.code)).toContain(code);
  });
  it('the blank TEMPLATE is incomplete (templates cannot be accidentally submitted as approvals)', () => {
    expect(checkRuleDossier(fx('templates/rule-dossier.template.json')).status).toBe('incomplete');
  });
});

describe('templates and CLI', () => {
  it('the blank OCR/pose/device templates are rejected as inputs, with reasons', () => {
    expect(() => evaluateOcr(fx('templates/ocr-annotation.template.json'), fx('templates/ocr-results.template.json'))).toThrow(ValidationInputError);
    expect(() => evaluateDevice(fx('templates/device-log.template.json'))).toThrow(ValidationInputError);
  });
  it('CLI: ocr writes a report and says the dataset is below the stated minimums, and that this is not validation; bad input → exit 2; incomplete dossier → exit 3', () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'val-')), 'r.json');
    const ok = spawnSync('npx', ['tsx', 'scripts/validate.ts', 'ocr', '--annotations', 'validation/fixtures/ocr/annotations.synthetic.json', '--results', 'validation/fixtures/ocr/results.synthetic.json', '--out', out], { cwd: root, encoding: 'utf8' });
    expect(ok.status).toBe(0); expect(ok.stderr).toMatch(/dataset structure: below minimums.*Nothing in this report is clinical validation/s);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).counts.matched).toBe(9);
    const bad = spawnSync('npx', ['tsx', 'scripts/validate.ts', 'ocr', '--annotations', 'validation/templates/ocr-annotation.template.json', '--results', 'validation/templates/ocr-results.template.json'], { cwd: root, encoding: 'utf8' });
    expect(bad.status).toBe(2);
    const rule = spawnSync('npx', ['tsx', 'scripts/validate.ts', 'rule', '--dossier', 'validation/fixtures/rule-dossier.synthetic.json'], { cwd: root, encoding: 'utf8' });
    expect(rule.status).toBe(3); expect(rule.stderr).toMatch(/dossier status: incomplete/);
    void execFileSync;
  }, 60_000);
});
