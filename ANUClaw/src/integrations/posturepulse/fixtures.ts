import { reportContentSha256, viewSha256 } from './upstream';

/** Recompute the sign-off digest after a fixture edit (upstream canonicalisation). */
export function sealReport<T extends { signOff: any }>(report: T): T {
  if (report.signOff) report.signOff.contentSha256 = reportContentSha256(report as any);
  return report;
}

/** SYNTHETIC PosturePulse records (test/demo only) shaped to the real schemas. Timestamps are relative to `now`. */
export function syntheticPosture(over: { subject?: string; consent?: string; session?: string; now?: Date } = {}) {
  const subject = over.subject ?? 'subj-synthetic-001';
  const consentId = over.consent ?? 'consent-synthetic-001';
  const sessionId = over.session ?? 'session-synthetic-001';
  const base = (over.now ?? new Date()).getTime();
  const ts = new Date(base - 3_600_000).toISOString();       // consent + session start: 1 h ago
  const signedAt = new Date(base - 1_800_000).toISOString(); // sign-off: 30 min ago
  const prov = { schemaVersion: 'assessment-report/v0', modelVersion: 'synthetic-pose@0', calibrationVersion: 'synthetic-cal@0', producedAt: ts };
  const out = {
    consentRecord: { consentRecordId: consentId, subjectPseudoId: subject, scopes: ['derived_events'], grantedAt: ts, revokedAt: null, withdrawalRequestedAt: null },
    session: {
      sessionId, subjectPseudoId: subject, protocolId: 'protocol-synthetic', protocolVersion: '0.1.0', deploymentContext: 'clinic_supervised',
      consentRecordId: consentId, retentionPolicy: { rawVideo: { optIn: false, retentionDays: null }, derivedEvents: { retentionDays: 30 } }, calibrationRef: null, state: 'ClinicianReview', createdAt: ts,
    },
    report: {
      reportId: 'report-synthetic-001', sessionId, reportVersion: 1, supersedesReportId: null, status: 'released',
      rows: [
        { metricKey: 'shoulder_height_difference', resultId: 'r1', label: 'Shoulder height difference', module: 'static', tier: 'proxy', unit: 'cm', side: 'bilateral', position: 'indeterminate', analysis: { text: 'Synthetic template text.', source: 'fixed_template' }, excluded: null,
          estimate: { value: 1.2, uncertainty: 0.8 }, unsupportedReasons: [], reference: { kind: 'geometric', label: '0 cm', sourceCitation: 'geometric symmetry', status: 'draft', value: 0 } },
        { metricKey: 'head_forward_offset', resultId: 'r2', label: 'Head forward offset', module: 'static', tier: 'estimate', unit: 'deg', side: null, position: 'not_applicable', analysis: { text: 'No estimate: capture quality insufficient.', source: 'fixed_template' }, excluded: { reason: 'synthetic exclusion', clinicianId: 'clin-synthetic' },
          estimate: null, unsupportedReasons: [], reference: null },
      ],
      notMeasurable: [{ metricKey: 'spinal_curvature', label: 'Spinal curvature', reason: 'Requires imaging or palpation', whatWouldBeNeeded: 'Clinical examination or radiograph' }],
      clinicianAssessment: null,
      signOff: { clinicianId: 'clin-synthetic', signedAt, contentSha256: '' },
      provenance: prov,
    },
    symptomReports: [] as any[],
  };
  sealReport(out.report);
  return out;
}

/**
 * What the (proposed) upstream export carries: the subject-AUTHORISED view of the released report — rows the clinician withheld are
 * omitted — plus how many were withheld. `signOff.contentSha256` is left as the upstream computed it (over the full body).
 */
export function bundlePayloadOf(f: ReturnType<typeof syntheticPosture>, extra: Record<string, unknown> = {}) {
  const rows = f.report.rows.filter((r: any) => !r.excluded);
  return {
    ...f, report: { ...f.report, rows }, issuedAt: new Date().toISOString(), issuer: 'synthetic-exporter',
    keyId: 'k1', bundleId: 'bundle-synthetic-1', signatureScheme: 'hmac-sha256/shared-secret',
    view: { kind: 'subject_authorized' as const, rowsWithheld: f.report.rows.length - rows.length, viewSha256: viewSha256({ ...f.report, rows }) }, ...extra,
  };
}
