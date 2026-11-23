/**
 * PosturePulse adapter (interpretation engine, P3b): reads PosturePulse's NATIVE assessment report and normalises it.
 *
 * Verification happens at intake (`prepare`), by the same code the patient importer uses
 * (`src/integrations/posturepulse/service.ts`): a signed bundle is verified with the configured shared secret, then
 * session/subject/consent binding, consent state, timestamps, withheld-row refusal and digests are checked. An
 * `unsigned` payload is only schema-checked and is carried as `unverified_payload` with a BLOCKING flag; it is never
 * upgraded. `run` is pure: it only maps what `prepare` stored.
 *
 * What the adapter preserves (a generic findings list would lose all of it): each row's side, step, sign convention,
 * measurement tier (a proxy stays a proxy), the source's own position against its own reference, the reference's
 * draft/approved status, unsupported reasons, exclusions, the standing not-measurable list, symptom escalation, and
 * the verification level. Nothing is estimated for a row the source could not measure.
 */
import { WorkflowError } from '../../documents/workflow';
import { validateUnverifiedEvidence, verifyBundleEvidence } from '../../integrations/posturepulse/service';
import { AdapterError } from './types';
import type { Adapter, AdapterOutput, NormalizedFinding, NormalizedFlag, NotMeasurable, SourceVerification, StoredRequest, SymptomSummary } from './types';

export const POSTUREPULSE_ADAPTER_ID = 'posturepulse-v1';
export const POSTUREPULSE_ADAPTER_VERSION = '1.0.0';
export const POSTUREPULSE_FORMAT = 'posturepulse-assessment/v0';

interface Submitted { format: string; bundle?: unknown; unsigned?: { consentRecord: any; session: any; report: any; symptomReports?: any[] } }
interface Verified { format: string; verification: SourceVerification; consentRecord: any; session: any; report: any; symptomReports?: any[] }

const TIER_NOTE = 'Camera-derived estimates and proxies from the source are not validated clinical measurements; a proxy is not equivalent to a bony-landmark measurement.';

function sanitize(s: string): string { return s.toLowerCase().replace(/[^a-z0-9_.]/g, '_'); }

function prepare(req: StoredRequest): StoredRequest {
  const np = req.nativePayload as Submitted | undefined;
  if (!np || np.format !== POSTUREPULSE_FORMAT) throw new AdapterError('native_payload_required', 'This skill needs a nativePayload in the posturepulse-assessment/v0 format.', 400);
  let consentRecord: any, session: any, report: any, symptomReports: any[] | undefined, verification: SourceVerification;
  try {
    if (np.bundle !== undefined) {
      const e = verifyBundleEvidence(np.bundle);
      ({ consentRecord, session, report, symptomReports } = e);
      verification = { level: 'signed_bundle_verified', origin: e.origin, digestStatus: e.digestStatus, viewSha256: e.viewSha256 };
    } else {
      ({ consentRecord, session, report, symptomReports } = np.unsigned!);
      validateUnverifiedEvidence({ consentRecord, session, report, symptomReports });
      verification = { level: 'unverified_payload' };
    }
  } catch (e) {
    if (e instanceof WorkflowError) throw new AdapterError(e.code, e.message, e.status, e.details);
    throw e;
  }
  // Bind the report to the subject and session it claims, so one subject's report cannot be attached to another's reference.
  if (session?.subjectPseudoId !== req.subject.externalRef) throw new AdapterError('subject_mismatch', 'subject.externalRef must equal the PosturePulse session subjectPseudoId.', 422);
  if (report?.sessionId !== (session?.sessionId ?? session?.id)) throw new AdapterError('session_mismatch', 'The report belongs to a different session than the one supplied.', 422);
  const stored: Verified = { format: POSTUREPULSE_FORMAT, verification, consentRecord, session, report, ...(symptomReports ? { symptomReports } : {}) };
  return { ...req, nativePayload: stored };
}

function run(req: StoredRequest): AdapterOutput {
  const np = req.nativePayload as Verified;
  const report = np.report;
  const findings: NormalizedFinding[] = [];
  const flags: NormalizedFlag[] = [];
  const used = new Set<string>();
  const missing: string[] = [], draftRef: string[] = [], tiered: string[] = [];

  for (const row of report.rows as any[]) {
    let key = sanitize(`${row.metricKey}${row.side ? `.${row.side}` : ''}${row.stepId ? `.${row.stepId}` : ''}`).slice(0, 76) || 'row';
    for (let n = 2; used.has(key); n++) key = `${key.replace(/\.\d+$/, '')}.${n}`;
    used.add(key);

    const has = row.estimate !== null && row.estimate !== undefined;
    const f: NormalizedFinding = {
      findingKey: key, sourceKey: row.metricKey, label: row.label, group: row.module,
      valueStatus: has ? 'stated' : 'missing', value: has ? row.estimate.value : null, tier: row.tier, sourcePosition: row.position,
    };
    if (row.unit) f.unit = row.unit;
    if (has) f.uncertainty = { plusMinus: row.estimate.uncertainty };
    if (row.side) f.side = row.side;
    if (row.stepId) f.stepId = row.stepId;
    if (row.signConvention) f.signConvention = row.signConvention;
    if (Array.isArray(row.unsupportedReasons) && row.unsupportedReasons.length) f.unsupportedReasons = row.unsupportedReasons.map(String);
    if (row.excluded) f.excluded = { reason: row.excluded.reason };
    if (row.reference) {
      const r = row.reference;
      f.reference = { origin: 'tenant_supplied', text: r.label, citation: r.sourceCitation, status: r.status, kind: r.kind };
      if (typeof r.value === 'number') f.reference.value = r.value;
      // The source does not say whether its bounds are inclusive, so no inclusivity is asserted.
      if (typeof r.min === 'number') f.reference.lower = r.min;
      if (typeof r.max === 'number') f.reference.upper = r.max;
      if (r.status === 'draft') draftRef.push(key);
    }
    findings.push(f);
    if (!has && !row.excluded) missing.push(key);
    if (row.tier === 'proxy' || row.tier === 'estimate') tiered.push(key);
  }

  const v = np.verification;
  if (v.level === 'unverified_payload') {
    flags.push({ type: 'unverified_source', severity: 'blocking', detail: 'Provenance, clinician release and consent were NOT verified for this report. It is not part of a released clinical record and must not be presented as one.' });
  }
  if (missing.length) flags.push({ type: 'missing_data', severity: 'attention', findingKeys: missing, detail: 'The source reported no value for these rows (see unsupportedReasons and tier); nothing was filled in.' });
  if (draftRef.length) flags.push({ type: 'draft_reference', severity: 'attention', findingKeys: draftRef, detail: 'These rows are compared by the source against a DRAFT, unapproved reference. Do not use it to call a value normal or abnormal.' });
  if (tiered.length) flags.push({ type: 'under_research', severity: 'info', findingKeys: tiered, detail: TIER_NOTE });

  const symptomReports = np.symptomReports ?? [];
  if (symptomReports.length || np.session?.state === 'Pause') {
    flags.push({ type: 'symptom_reported', severity: 'blocking', detail: 'Symptoms were reported during capture (pause or escalation). ANUClaw cannot resume the capture session; follow the clinician’s instructions.' });
  }
  if (report.clinicianAssessment) {
    flags.push({ type: 'review_required', severity: 'info', detail: 'The source report includes a clinician’s own assessment. It is preserved in the original payload and is not interpreted here.' });
  }

  const sourceVerification: SourceVerification = {
    ...v, reportId: report.reportId, reportVersion: report.reportVersion, reportStatus: report.status,
    supersedesReportId: report.supersedesReportId ?? null,
    ...(report.signOff?.signedAt ? { signedAt: report.signOff.signedAt } : {}),
  };
  const notMeasurable: NotMeasurable[] = (report.notMeasurable ?? []).map((n: any) => ({ metricKey: n.metricKey, label: n.label, reason: n.reason, whatWouldBeNeeded: n.whatWouldBeNeeded }));
  // Free text from the person (freeText) is deliberately not carried into findings.
  const symptoms: SymptomSummary[] = symptomReports.map((s: any) => ({ ...(s.reportedAt ? { reportedAt: s.reportedAt } : {}), severity: s.severity, symptoms: [...s.symptoms], triggeredAction: s.triggeredAction }));
  return { findings, flags, sourceVerification, notMeasurable, ...(symptoms.length ? { symptoms } : {}) };
}

export const posturepulseAdapter: Adapter = { id: POSTUREPULSE_ADAPTER_ID, version: POSTUREPULSE_ADAPTER_VERSION, input: 'native', prepare, run };
