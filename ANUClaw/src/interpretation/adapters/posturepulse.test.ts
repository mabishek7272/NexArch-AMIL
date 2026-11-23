/** PosturePulse adapter (P3b): intake verification (`prepare`) and the pure mapping (`run`). Synthetic data only. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundlePayloadOf, sealReport, syntheticPosture } from '../../integrations/posturepulse/fixtures';
import { signBundle } from '../../integrations/posturepulse/upstream';
import { posturepulseAdapter as adapter, POSTUREPULSE_FORMAT } from './posturepulse';
import { AdapterError, type StoredRequest } from './types';

const SECRET = 'import-secret-'.padEnd(40, 'z');
let savedSecret: string | undefined;
beforeEach(() => { savedSecret = process.env.ANUCLAW_POSTUREPULSE_IMPORT_SECRET; process.env.ANUCLAW_POSTUREPULSE_IMPORT_SECRET = SECRET; delete process.env.ANUCLAW_POSTUREPULSE_IMPORT_KEYS; });
afterEach(() => { if (savedSecret === undefined) delete process.env.ANUCLAW_POSTUREPULSE_IMPORT_SECRET; else process.env.ANUCLAW_POSTUREPULSE_IMPORT_SECRET = savedSecret; });

type Fixture = ReturnType<typeof syntheticPosture>;
function request(nativePayload: unknown, subject = 'subj-synthetic-001'): StoredRequest {
  return {
    schemaVersion: 'interpretation-request/v1', skillId: 'posture-analysis-interpretation', analysisType: 'posture_landmark',
    subject: { externalRef: subject }, acquisition: { capturedAt: new Date().toISOString() },
    source: { application: 'PosturePulse', modelName: 'synthetic-pose', modelVersion: '0' }, nativePayload,
  };
}
const signed = (f: Fixture) => request({ format: POSTUREPULSE_FORMAT, bundle: signBundle(bundlePayloadOf(f) as any, SECRET) }, f.session.subjectPseudoId);
const unsigned = (f: Fixture, subject = f.session.subjectPseudoId) => request({ format: POSTUREPULSE_FORMAT, unsigned: { consentRecord: f.consentRecord, session: f.session, report: f.report, symptomReports: f.symptomReports } }, subject);
const normalise = (r: StoredRequest) => adapter.run(adapter.prepare!(r));
const refusal = (fn: () => unknown): AdapterError => { try { fn(); } catch (e) { expect(e).toBeInstanceOf(AdapterError); return e as AdapterError; } throw new Error('expected a refusal'); };

describe('PosturePulse adapter: verified bundle', () => {
  it('verifies, drops the signature envelope, and keeps the verification level', () => {
    const prepared = adapter.prepare!(signed(syntheticPosture()));
    const np = prepared.nativePayload as any;
    expect(np.verification).toMatchObject({ level: 'signed_bundle_verified', digestStatus: 'upstream_signed_claim_not_recomputable' });
    expect(np.verification.origin).toMatch(/^signed:synthetic-exporter:k1:bundle-synthetic-1$/);
    expect(JSON.stringify(prepared)).not.toMatch(/"signature"/);
  });

  it('maps rows with side, tier, source position, draft reference and uncertainty, and does not upgrade a proxy', () => {
    const out = normalise(signed(syntheticPosture()));
    expect(out.findings).toHaveLength(1); // the clinician-withheld row never arrives in a signed bundle
    const f = out.findings[0];
    expect(f).toMatchObject({ findingKey: 'shoulder_height_difference.bilateral', sourceKey: 'shoulder_height_difference', group: 'static', valueStatus: 'stated', value: 1.2, unit: 'cm', side: 'bilateral', tier: 'proxy', sourcePosition: 'indeterminate' });
    expect(f.uncertainty).toEqual({ plusMinus: 0.8 });
    expect(f.reference).toMatchObject({ origin: 'tenant_supplied', status: 'draft', kind: 'geometric', value: 0, text: '0 cm' });
    expect(f.reference?.lower).toBeUndefined(); expect(f.reference?.upper).toBeUndefined(); // a target is not a range
    expect(out.flags.find((x) => x.type === 'draft_reference')?.findingKeys).toEqual([f.findingKey]);
    expect(out.flags.find((x) => x.type === 'under_research')?.detail).toMatch(/not validated clinical measurements/);
    expect(out.flags.some((x) => x.type === 'unverified_source')).toBe(false);
    expect(out.sourceVerification).toMatchObject({ level: 'signed_bundle_verified', reportId: 'report-synthetic-001', reportVersion: 1, reportStatus: 'released', supersedesReportId: null });
    expect(out.notMeasurable).toEqual([{ metricKey: 'spinal_curvature', label: 'Spinal curvature', reason: 'Requires imaging or palpation', whatWouldBeNeeded: 'Clinical examination or radiograph' }]);
  });

  it('refuses a bundle whose content was changed after signing (403) and one signed with another secret', () => {
    const f = syntheticPosture();
    const b = signBundle(bundlePayloadOf(f) as any, SECRET); (b.payload.report.rows[0].estimate as any).value = 9.9;
    expect(refusal(() => adapter.prepare!(request({ format: POSTUREPULSE_FORMAT, bundle: b })))).toMatchObject({ status: 403, code: 'bad_signature' });
    const other = signBundle(bundlePayloadOf(f) as any, 'k'.repeat(40));
    expect(refusal(() => adapter.prepare!(request({ format: POSTUREPULSE_FORMAT, bundle: other })))).toMatchObject({ status: 403, code: 'bad_signature' });
  });

  it('is unavailable (503) when no import secret is configured', () => {
    delete process.env.ANUCLAW_POSTUREPULSE_IMPORT_SECRET;
    expect(refusal(() => adapter.prepare!(signed(syntheticPosture())))).toMatchObject({ status: 503, code: 'import_secret_not_configured' });
  });

  it('refuses an unreleased report even when correctly signed', () => {
    const f = syntheticPosture(); f.report.status = 'draft' as any; (f.report as any).signOff = null; // a well-formed draft has no sign-off
    expect(refusal(() => adapter.prepare!(signed(f)))).toMatchObject({ status: 409, code: 'report_not_released' });
  });

  it('refuses a signed bundle that carries a row the clinician withheld', () => {
    const f = syntheticPosture();
    const payload = { ...bundlePayloadOf(f), report: f.report }; // full body including the excluded row
    expect(refusal(() => adapter.prepare!(request({ format: POSTUREPULSE_FORMAT, bundle: signBundle(payload as any, SECRET) }, f.session.subjectPseudoId)))).toMatchObject({ status: 403, code: 'bundle_contains_withheld_row' });
  });
});

describe('PosturePulse adapter: unsigned payload', () => {
  it('is carried as unverified with a BLOCKING flag and never upgraded', () => {
    const out = normalise(unsigned(syntheticPosture()));
    expect(out.sourceVerification).toMatchObject({ level: 'unverified_payload' });
    expect(out.sourceVerification?.origin).toBeUndefined(); expect(out.sourceVerification?.digestStatus).toBeUndefined();
    expect(out.flags.find((x) => x.type === 'unverified_source')).toMatchObject({ severity: 'blocking' });
  });

  it('preserves an excluded row with its reason, keeps its value status, and does not report it as missing data', () => {
    const out = normalise(unsigned(syntheticPosture()));
    expect(out.findings).toHaveLength(2);
    const ex = out.findings.find((x) => x.sourceKey === 'head_forward_offset')!;
    expect(ex.excluded).toEqual({ reason: 'synthetic exclusion' }); // the clinician's id is not carried
    expect(ex.valueStatus).toBe('missing'); expect(ex.value).toBeNull();
    expect(out.flags.find((x) => x.type === 'missing_data')).toBeUndefined();
  });

  it('flags a row with no value (not excluded) as missing and keeps the source\'s reasons', () => {
    const f = syntheticPosture(); f.report.rows[1].excluded = null; f.report.rows[1].unsupportedReasons = ['occlusion', 'low_confidence'] as any; sealReport(f.report);
    const out = normalise(unsigned(f));
    const row = out.findings.find((x) => x.sourceKey === 'head_forward_offset')!;
    expect(row.unsupportedReasons).toEqual(['occlusion', 'low_confidence']);
    expect(out.flags.find((x) => x.type === 'missing_data')?.findingKeys).toEqual([row.findingKey]);
  });

  it('refuses a payload that does not match the PosturePulse contract (422, paths only)', () => {
    const f = syntheticPosture(); delete (f.report as any).provenance;
    const e = refusal(() => adapter.prepare!(unsigned(f)));
    expect(e).toMatchObject({ status: 422, code: 'contract_violation' });
    expect(JSON.stringify(e.details)).toContain('provenance');
  });
});

describe('PosturePulse adapter: binding and mapping rules', () => {
  it('requires subject.externalRef to equal the session subject, and the report to belong to the session', () => {
    expect(refusal(() => adapter.prepare!(unsigned(syntheticPosture(), 'someone-else')))).toMatchObject({ status: 422, code: 'subject_mismatch' });
    const f = syntheticPosture(); f.report.sessionId = 'session-other'; sealReport(f.report);
    expect(refusal(() => adapter.prepare!(unsigned(f))).status).toBe(422);
  });

  it('keeps left and right rows of one metric apart with unique keys, step ids and sign convention', () => {
    const f = syntheticPosture();
    const base = f.report.rows[0] as any;
    f.report.rows = [
      { ...base, excluded: null, side: 'left', stepId: 'step-a', signConvention: 'positive = left side lower' },
      { ...base, excluded: null, side: 'right', stepId: 'step-b', signConvention: 'positive = right side lower' },
      { ...base, excluded: null, side: null }, { ...base, excluded: null, side: null },
    ]; sealReport(f.report);
    const out = normalise(unsigned(f));
    const keys = out.findings.map((x) => x.findingKey);
    expect(new Set(keys).size).toBe(4);
    expect(out.findings[0]).toMatchObject({ side: 'left', stepId: 'step-a', signConvention: 'positive = left side lower' });
    expect(out.findings[1]).toMatchObject({ side: 'right', stepId: 'step-b', signConvention: 'positive = right side lower' });
    for (const k of keys) expect(k).toMatch(/^[a-z0-9_.]{1,80}$/);
  });

  it('turns symptom reports into a blocking flag and never carries their free text', () => {
    const f = syntheticPosture();
    f.symptomReports = [{ symptomReportId: 'sr1', sessionId: f.session.sessionId, reportedAt: new Date().toISOString(), symptoms: ['pain'], severity: 'mild', freeText: 'my name is Leak Check and I live at 1 Test Road', triggeredAction: 'pause' }];
    const out = normalise(unsigned(f));
    expect(out.flags.find((x) => x.type === 'symptom_reported')).toMatchObject({ severity: 'blocking' });
    expect(out.symptoms).toEqual([{ reportedAt: expect.any(String), severity: 'mild', symptoms: ['pain'], triggeredAction: 'pause' }]);
    expect(JSON.stringify(out)).not.toMatch(/Leak Check|Test Road/);
  });

  it('notes a clinician assessment without copying its text, and is deterministic', () => {
    const f = syntheticPosture(); f.report.clinicianAssessment = { text: 'Free text from the clinician', clinicianId: 'clin-synthetic' } as any; sealReport(f.report);
    const out = normalise(unsigned(f));
    expect(out.flags.find((x) => x.type === 'review_required')).toBeTruthy();
    expect(JSON.stringify(out)).not.toContain('Free text from the clinician');
    expect(JSON.stringify(normalise(unsigned(f)))).toBe(JSON.stringify(normalise(unsigned(f))));
  });

  it('requires the native format', () => {
    expect(refusal(() => adapter.prepare!(request({ format: 'something-else' }))).status).toBe(400);
    expect(refusal(() => adapter.prepare!({ ...request(undefined) })).status).toBe(400);
  });
});
