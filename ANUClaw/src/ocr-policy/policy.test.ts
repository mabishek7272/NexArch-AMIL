/** OCR study-policy tests (pure). SYNTHETIC test values only; nothing here chooses or implies a clinical or statistical value. */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { assertPolicyAllows, blankRealPolicy, FIELD_DEFS, FIELD_KEYS, policyAuditReport, PolicyError, requestActivation, seal, SYNTHETIC_LABEL, SYNTHETIC_TEST_POLICY, SYNTHETIC_VIEW, stampOf, validateFieldValue, viewOf, withOverrides, ACTIVATION_GATE_AVAILABLE, AUDIT_STATEMENT, Policy, missingRequired } from './policy';
import { parseLabLines } from '../documents/lab-parser';
import { evaluateOcr } from '../validation/ocr-eval';
import { StudyWorkspaces } from '../validation/study/workspace';
import * as os from 'os';

const rd = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../validation/fixtures/ocr', f), 'utf8'));
const code = (fn: () => unknown) => { try { fn(); return 'no-error'; } catch (e) { return (e as PolicyError).code ?? (e as Error).message; } };
const fullReal = (): Policy => { const b = blankRealPolicy('real-1', 'u'); const f = { ...b.fields }; for (const k of FIELD_KEYS) f[k] = { status: 'configured', value: (SYNTHETIC_TEST_POLICY.fields[k] as { value: unknown }).value, sourceRef: 'TEST-REF (recorded, not verified)', setBy: 'u', setAt: 'x' }; return seal({ ...b, fields: f }); };

describe('one policy record; no conflicting engineering defaults', () => {
  it('the parser and the evaluation consume the SAME confidence value and flag set from one record', () => {
    const lowView = withOverrides(SYNTHETIC_VIEW, { confidenceFlagThreshold: 0.5 }); const highView = withOverrides(SYNTHETIC_VIEW, { confidenceFlagThreshold: 0.99 });
    const flagged = (v: typeof lowView) => parseLabLines('Sodium 140 mmol/L 135-145', 1, 'ocr', 0.9, v)[0].flags.includes('ocr_low_confidence');
    expect([flagged(lowView), flagged(highView)]).toEqual([false, true]);                                               // parser boundary moves with the policy value
    const results = rd('results.synthetic.json'); results.documents[0].candidates[3].ocrConfidence = 0.7; const silent = (v: typeof lowView) => evaluateOcr(rd('annotations.synthetic.json'), results, { policy: v }).uncertaintyFlags.silentErrors;
    expect(silent(withOverrides(SYNTHETIC_VIEW, { confidenceFlagThreshold: 0.8 }))).toBeLessThan(silent(withOverrides(SYNTHETIC_VIEW, { confidenceFlagThreshold: 0.5 })));   // evaluation boundary moves with the same value
    expect(evaluateOcr(rd('annotations.synthetic.json'), rd('results.synthetic.json'), { policy: lowView }).policy).toMatchObject({ policyId: SYNTHETIC_VIEW.id, sha256: SYNTHETIC_VIEW.sha256, overridden: true });
  });
  it('no duplicate confidence/threshold literals remain in the consumers (static check)', () => {
    for (const f of ['src/documents/lab-parser.ts', 'src/validation/ocr-eval.ts', 'src/validation/study/agreement.ts', 'src/validation/study/workspace.ts', 'src/dashboard/server/routes/ocr-study.ts', 'src/aikosh/bench/loaders.ts']) {
      const t = fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(t, f).not.toMatch(/\b0\.8\d?\b|lowConfidence\s*=\s*0|\?\? 300\b|\?\? 30\b|tool placeholder 0/); expect(t, f).not.toMatch(/\{ abs: 0, rel: 0 \}/);
    }
    expect(SYNTHETIC_TEST_POLICY.fields.confidenceFlagThreshold).toMatchObject({ sourceRef: SYNTHETIC_LABEL });           // the only place the value lives, labelled synthetic
  });
  it('every engineering default is a field of the record, with its code paths listed', () => {
    expect(FIELD_KEYS).toEqual(expect.arrayContaining(['confidenceFlagThreshold', 'enabledReviewFlags', 'severityMap', 'humanConfirmation', 'secondReaderRule', 'unitEquivalence', 'annotationTolerance', 'acceptanceCriteriaRef', 'stoppingRulesRef', 'independentReviewRequirementsRef']));
    for (const d of FIELD_DEFS) expect(d.affects.length, d.key).toBeGreaterThan(0); expect(FIELD_DEFS.filter((d) => !d.enforcedByCode).map((d) => d.key)).toEqual(['acceptanceCriteriaRef', 'stoppingRulesRef', 'independentReviewRequirementsRef']);
  });
  it('unit equivalence and annotation tolerance come from the policy; groups are explicit and the synthetic record declares none', () => {
    const v = withOverrides(SYNTHETIC_VIEW, { unitEquivalence: { caseFold: true, microSignToU: true, stripWhitespace: true, equivalentGroups: [['x/y', 'z/w']] } });
    expect(SYNTHETIC_VIEW.unitEquivalence.equivalentGroups).toEqual([]); expect(parseLabLines('A 1 u', 1, 'native_text', null, SYNTHETIC_VIEW).length).toBeGreaterThanOrEqual(0); expect(v.unitEquivalence.equivalentGroups).toHaveLength(1);
  });
});

describe('missing required fields fail closed', () => {
  it('a blank real-study policy has every field unconfigured and cannot produce a view', () => {
    const b = blankRealPolicy('r', 'u'); expect(missingRequired(b)).toEqual(FIELD_DEFS.filter((d) => d.required).map((d) => d.key)); expect(Object.values(b.fields).every((f) => f.status === 'unconfigured')).toBe(true);
    try { viewOf(b); expect.fail('should throw'); } catch (e) { expect((e as PolicyError).code).toBe('policy_unconfigured'); expect((e as PolicyError).missing.length).toBe(FIELD_KEYS.length); }
  });
  it('removing one field from the synthetic policy blocks synthetic tooling too', () => {
    const f = { ...SYNTHETIC_TEST_POLICY.fields }; f.confidenceFlagThreshold = { status: 'unconfigured' }; const p = seal({ ...SYNTHETIC_TEST_POLICY, fields: f }); expect(code(() => assertPolicyAllows(p, { purpose: 'locked_evaluation', data: 'synthetic' }))).toBe('policy_unconfigured');
  });
  it('field values are shape-checked (no clinical judgement), and un-typed values are rejected', () => {
    expect(validateFieldValue('confidenceFlagThreshold', 1.5)).not.toEqual([]); expect(validateFieldValue('confidenceFlagThreshold', 0.5)).toEqual([]); expect(validateFieldValue('humanConfirmation', 'none')).not.toEqual([]); expect(validateFieldValue('severityMap', { value: 'x' })).not.toEqual([]);
    expect(validateFieldValue('annotationTolerance', { default: { abs: -1, rel: 0 } })).not.toEqual([]); expect(validateFieldValue('minTruthItems', 0)).not.toEqual([]); expect(validateFieldValue('secondReaderRule', 'maybe')).not.toEqual([]); expect(validateFieldValue('unknownField', 1)).not.toEqual([]);
  });
});

describe('real data, activation and acceptance-style output fail closed', () => {
  it('the synthetic test policy can never be used with real data; real registration, real-data acceptance and acceptance reports are refused whatever the policy contains', () => {
    expect(code(() => assertPolicyAllows(SYNTHETIC_TEST_POLICY, { purpose: 'real_registration', data: 'real' }))).toBe('synthetic_policy_with_real_data'); expect(code(() => assertPolicyAllows(SYNTHETIC_TEST_POLICY, { purpose: 'synthetic_tooling', data: 'real' }))).toBe('synthetic_policy_with_real_data');
    const full = fullReal(); expect(missingRequired(full)).toEqual([]); for (const purpose of ['real_registration', 'real_data_acceptance', 'locked_evaluation'] as const) expect([purpose, code(() => assertPolicyAllows(full, { purpose, data: 'real' }))]).toEqual([purpose, 'policy_not_active']);
    expect(code(() => assertPolicyAllows(blankRealPolicy('r', 'u'), { purpose: 'real_registration', data: 'real' }))).toBe('policy_not_active'); for (const p of [SYNTHETIC_TEST_POLICY, full]) expect(code(() => assertPolicyAllows(p, { purpose: 'acceptance_report', data: 'synthetic' }))).toBe('acceptance_report_not_available');
    expect(code(() => assertPolicyAllows(full, { purpose: 'synthetic_tooling', data: 'synthetic' }))).toBe('policy_kind_mismatch');            // a real policy is not used for synthetic data either
  });
  it('activation is blocked even with every field, an authorization reference and an independent-review reference', () => {
    expect(ACTIVATION_GATE_AVAILABLE).toBe(false); const full = fullReal();
    try { requestActivation(full, { authorizationRef: 'EXTERNAL-AUTH-1', independentReviewRef: 'EXTERNAL-REVIEW-1' }); expect.fail('x'); } catch (e) { expect((e as PolicyError).code).toBe('activation_blocked'); expect((e as Error).message).toMatch(/approved-protocol gate does not exist/); expect((e as Error).message).toMatch(/not verification or approval/); }
    try { requestActivation(blankRealPolicy('r', 'u'), {}); } catch (e) { expect((e as Error).message).toMatch(/unconfigured fields/); expect((e as Error).message).toMatch(/authorization reference is required/); expect((e as Error).message).toMatch(/independent-review reference is required/); }
    expect(code(() => requestActivation(SYNTHETIC_TEST_POLICY, { authorizationRef: 'a', independentReviewRef: 'b' }))).toBe('activation_blocked');
  });
  it('real (human-annotated) evidence is refused by the evaluator and by dataset registration; synthetic views cannot be overridden into real ones', () => {
    const a = rd('annotations.synthetic.json'); a.provenance = { kind: 'human_annotated', annotators: [{ id: 'x', role: 'r' }], adjudication: 'double_annotated_adjudicated', createdAt: 'x' }; expect(code(() => evaluateOcr(a, rd('results.synthetic.json')))).toBe('synthetic_policy_with_real_data');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pol-')); const svc = new StudyWorkspaces(root); const o = { userId: 'o', scope: { kind: 'tenant' as const, id: 'T' } }; const ws = svc.createWorkspace(o, 'n', 'p').id;
    try { svc.registerDataset(o, ws, { name: 'x', studyRef: 's', provenanceKind: 'human_annotated', split: 'development', protocolRef: 'P', origin: 'o', annotators: ['a1', 'a2'], sources: [{ bytes: Buffer.from('x'), pages: 1, mediaType: 'text/plain' }] }); expect.fail('x'); } catch (e) { expect((e as { code: string }).code).toBe('policy_not_active'); }
    const real = viewOf(fullReal()); expect(code(() => withOverrides(real, { minTruthItems: 1 }))).toBe('override_refused'); fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('policy version drift and exact-version recording', () => {
  it('results stamped with a different policy version are refused; locked runs need a stamp; reports and manifest record the exact version', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pol-')); const svc = new StudyWorkspaces(root); const o = { userId: 'o', scope: { kind: 'tenant' as const, id: 'T' } };
    const ws = svc.createWorkspace(o, 'n', 'p').id; const reg = svc.registerDataset(o, ws, { name: 'x', studyRef: 's', provenanceKind: 'synthetic_fixture', split: 'development', origin: 'o', annotators: ['a1', 'a2'], sources: [{ bytes: Buffer.from('SYNTHETIC'), pages: 1, mediaType: 'text/plain' }] });
    const a = { userId: 'a1', scope: o.scope }, b = { userId: 'a2', scope: o.scope }, adj = { userId: 'j', scope: o.scope }; for (const [u, r] of [['a1', 'annotator'], ['a2', 'annotator'], ['j', 'adjudicator']] as const) svc.addMember(o, ws, u, [r]);
    svc.attestDeidentification(o, ws, reg.datasetId, { declaration: 'synthetic', attestorName: 'n/a', attestorRole: 'fixture', method: 'synthetic', reviewedSampleSize: 0, attestedAt: new Date().toISOString(), attestationRef: 'synthetic', residualRiskNote: 'none' }); svc.generateManifest(o, ws, reg.datasetId);
    const id = reg.caseIds[0]; const file = (who: string) => ({ schema: 'anuclaw-ocr-annotator-file/v1' as const, annotatorId: who, completedCaseIds: [id], items: [{ caseId: id, page: 1, analyte: 'Sodium', valueRaw: '140', valueNum: 140, comparator: null, unit: 'mmol/L', refLow: 135, refHigh: 145 }] });
    svc.importAnnotations(a, ws, reg.datasetId, file('a1')); svc.importAnnotations(b, ws, reg.datasetId, file('a2')); svc.buildTruth(o, ws, reg.datasetId); void adj;
    const res = { schema: 'anuclaw-ocr-extraction/v1', system: { engine: 'FIXTURE', version: '0' }, documents: [{ documentId: id, pages: [{ page: 1, status: 'ok' }], candidates: [{ analyte: 'Sodium', valueRaw: '140', valueNum: 140, unit: 'mmol/L', refLow: 135, refHigh: 145, page: 1, flags: [], ocrConfidence: 0.9 }] }] };
    const otherStamp = { ...stampOf(SYNTHETIC_VIEW), version: 2, sha256: 'f'.repeat(64) };
    expect(code(() => svc.evaluate(o, ws, reg.datasetId, { runId: 'd1', mode: 'development', results: { ...res, policy: otherStamp } }))).toBe('policy_version_drift');
    const ok = svc.evaluate(o, ws, reg.datasetId, { runId: 'd2', mode: 'development', results: { ...res, policy: stampOf(SYNTHETIC_VIEW) } }); expect(ok.report.provenance.policy).toMatchObject({ policyId: SYNTHETIC_VIEW.id, version: SYNTHETIC_VIEW.version, sha256: SYNTHETIC_VIEW.sha256, kind: 'synthetic_test' });
    expect(svc.getManifest(o, ws, reg.datasetId).outputs[0].policy).toMatchObject({ sha256: SYNTHETIC_VIEW.sha256 }); expect(ok.report.evaluation.policy.sha256).toBe(SYNTHETIC_VIEW.sha256);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('policy comparison / audit report', () => {
  it('lists every field with status, source-reference presence, affected code paths and runs; states presence is not verification; selects no threshold', () => {
    const r = policyAuditReport(blankRealPolicy('r', 'u'), [{ runId: 'x', mode: 'development', policyVersion: 1, policySha256: 'a'.repeat(64) }]); expect(r.statement).toBe(AUDIT_STATEMENT); expect(AUDIT_STATEMENT).toMatch(/NOT verification or approval/); expect(r.fields).toHaveLength(FIELD_DEFS.length);
    for (const f of r.fields) { expect(f.status).toBe('unconfigured'); expect(f.sourceReferencePresent).toBe(false); expect(f.sourceReferenceIsVerification).toBe(false); expect(f.affectedCodePaths.length).toBeGreaterThan(0); expect(f.value).toBeNull(); }
    expect(r.requiredFieldsUnconfigured).toHaveLength(FIELD_DEFS.length); expect(r.policy.effectiveState).toMatch(/draft — not effective/); expect(r.runs[0].usesThisPolicyVersion).toBe(false);
    const full = policyAuditReport(fullReal()); expect(full.fields.every((f) => f.sourceReferencePresent && !f.sourceReferenceIsVerification && f.value === 'configured (value in record)')).toBe(true); expect(JSON.stringify(full.fields)).not.toMatch(/recommend|approved by|verified by/i);
    const syn = policyAuditReport(SYNTHETIC_TEST_POLICY); expect(syn.policy.effectiveState).toMatch(/synthetic test policy — usable with synthetic data only/); expect(syn.fields.find((f) => f.key === 'confidenceFlagThreshold')!.sourceReferencePresent).toBe(true);
  });
});

describe('readiness report', () => {
  it('is never eligible; lists every gap with links to existing documents; completing everything changes nothing', async () => {
    const { readinessReport, FIELD_LINKS, INFRA_GATES } = await import('./readiness');
    const blank = readinessReport(blankRealPolicy('r', 'u'), { submitted: false, decision: null, policySha256: null, externalDecisionRef: null, externalSignatureRef: null });
    expect(blank.eligibleForActivation).toBe(false); expect(blank.items.filter((i) => i.category === 'missing_field')).toHaveLength(FIELD_DEFS.length); expect(blank.items.map((i) => i.category)).toEqual(expect.arrayContaining(['missing_external_decision_reference', 'missing_independent_review_reference', 'missing_review_record', 'infrastructure_gate']));
    const full = fullReal(); const done = readinessReport({ ...full, clinicalLeadDecisionRef: 'E1', independentReviewRef: 'E2' } as Policy, { submitted: true, decision: 'reviewed', policySha256: full.sha256, externalDecisionRef: 'E3', externalSignatureRef: 'E4' });
    expect(done.eligibleForActivation).toBe(false); expect(done.items.every((i) => i.category === 'infrastructure_gate')).toBe(true); expect(done.items.length).toBe(INFRA_GATES.length); expect(done.banner).toMatch(/NOT ELIGIBLE FOR ACTIVATION/);
    const links = [...Object.values(FIELD_LINKS).flat(), ...INFRA_GATES.flatMap((g) => g.links)]; for (const l of links) expect(fs.existsSync(path.resolve(__dirname, '../..', l.path)), l.path).toBe(true);
    expect(Object.keys(FIELD_LINKS).sort()).toEqual([...FIELD_KEYS].sort()); expect(JSON.stringify(done)).not.toMatch(/recommend (a|the) |should be set to/i);
  });
});
