/**
 * PosturePulse → ANUClaw import (plan §9.1). PosturePulse computes the geometry;
 * ANUClaw consumes its versioned, CLINICIAN-RELEASED assessment report.
 *
 * Provenance (see ./upstream.ts): a payload is treated as a clinical release ONLY
 * when it arrives via the configured trusted upstream or a verified signed bundle,
 * after session/subject/consent binding, consent state, timestamp rules and
 * content-hash checks. Anything else can only be stored as an `unverified_payload`
 * — labelled as such and excluded from summaries unless explicitly requested.
 *
 * Preserved exactly: the whole upstream report JSON, every row as received
 * (tiers, value ± uncertainty, unsupported reasons, reference status, exclusions),
 * the standing not-measurable list, provenance, symptom reports and their
 * pause/escalate actions. No normality or disease claims; no missing metric is
 * estimated; proxies stay proxies; ANUClaw never resumes a paused capture session.
 */
import * as crypto from 'crypto';
import { db } from '../../db';
import { WorkflowError } from '../../documents/workflow';
import { validateContract } from './contract';
import { DigestStatus, viewSha256, bindingViolations, fetchFromTrustedUpstream, parseKeyring, patientViewMatchesFull, timeRules, timestampViolations, verifyBundle } from './upstream';

export type Verification = 'upstream_verified' | 'signed_bundle_verified' | 'unverified_payload';

export async function linkSubject(args: { patientId: string; subjectPseudoId: string; consentRecordId: string; purpose: string; userId: string }) {
  for (const [k, v] of Object.entries({ subjectPseudoId: args.subjectPseudoId, consentRecordId: args.consentRecordId, purpose: args.purpose })) {
    if (typeof v !== 'string' || !v.trim() || v.length > 300) throw new WorkflowError(400, 'validation', `${k} is required.`);
  }
  const id = crypto.randomUUID();
  try {
    await db.query(`INSERT INTO posture_subject_links (id, patient_id, subject_pseudo_id, consent_record_id, purpose, linked_by, linked_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, args.patientId, args.subjectPseudoId.trim(), args.consentRecordId.trim(), args.purpose.trim(), args.userId, Date.now()]);
  } catch (e: any) {
    if (e?.code === '23505') throw new WorkflowError(409, 'already_linked', 'This subject is already linked to this patient.');
    throw e;
  }
  return { linkId: id };
}

export const LIMITATION: Record<string, string> = {
  estimate: 'Camera-derived estimate with stated uncertainty; not a validated clinical measurement.',
  proxy: 'Camera proxy for a clinical construct; not equivalent to a bony-landmark measurement; not validated.',
  entered: 'Value entered by a person; provenance as recorded by PosturePulse.',
  annotated: 'Value annotated by a person on captured media.',
  not_measurable: 'Not measurable with this system; no value is reported.',
};

export interface PostureImportInput { consentRecord: any; session: any; report: any; symptomReports?: any[] }

async function requireLink(patientId: string, session: any, consent: any) {
  const link = await db.queryOne<any>(
    `SELECT * FROM posture_subject_links WHERE patient_id = $1 AND subject_pseudo_id = $2 AND revoked_at IS NULL`, [patientId, session?.subjectPseudoId]);
  if (!link) throw new WorkflowError(403, 'no_subject_link', 'No authorised link between this patient and the PosturePulse subject.');
  if (link.consent_record_id !== consent?.consentRecordId) throw new WorkflowError(403, 'consent_mismatch', 'The linked consent record does not match the upstream consent record.');
  return link;
}

async function persist(args: { patientId: string; userId: string; link: any; verification: Verification; origin: string | null; digestStatus?: DigestStatus | null; viewSha256?: string | null } & PostureImportInput) {
  const { consentRecord: c, session: s, report: r } = args;
  const sessionId = s.sessionId ?? s.id;
  const symptoms = (args.symptomReports ?? []).map((sr) => ({ reportedAt: sr.reportedAt, severity: sr.severity, symptoms: sr.symptoms, triggeredAction: sr.triggeredAction }));
  const escalation = symptoms.some((x) => x.triggeredAction === 'pause' || x.triggeredAction === 'escalate_review') || s.state === 'Pause';
  void c;
  const id = crypto.randomUUID();
  try {
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO posture_reports (id, patient_id, link_id, session_id, report_id, report_version, sign_off_json, provenance_json, not_measurable_json, symptoms_json, symptom_escalation, content_sha256, imported_by, imported_at, verification, upstream_origin, report_json, digest_status, view_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [id, args.patientId, args.link.id, sessionId, r.reportId, r.reportVersion, JSON.stringify(r.signOff ?? null), JSON.stringify(r.provenance),
          JSON.stringify(r.notMeasurable), JSON.stringify(symptoms), escalation, r.signOff?.contentSha256 ?? sha256Hex(r), args.userId, Date.now(),
          args.verification, args.origin, JSON.stringify(r), args.digestStatus ?? null, args.viewSha256 ?? null],
      );
      for (const row of r.rows) {
        await tx.query(
          `INSERT INTO posture_measurements (id, posture_report_id, metric_key, label, module, tier, unit, side, value, uncertainty, unsupported_reasons_json, reference_json, excluded, limitation_note, position, analysis_text, exclusion_reason, row_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [crypto.randomUUID(), id, row.metricKey, row.label, row.module, row.tier, row.unit, row.side ?? null,
            row.estimate?.value ?? null, row.estimate?.uncertainty ?? null, JSON.stringify(row.unsupportedReasons ?? []),
            row.reference ? JSON.stringify(row.reference) : null, Boolean(row.excluded), LIMITATION[row.tier] ?? 'Unknown tier.',
            row.position, row.analysis?.text ?? null, row.excluded?.reason ?? null, JSON.stringify(row)],
        );
      }
    });
  } catch (e: any) {
    if (e?.code === '23505') throw new WorkflowError(409, 'already_imported', 'This report version was already imported with this verification level.');
    throw e;
  }
  return { postureReportId: id, rows: r.rows.length, symptomEscalation: escalation, verification: args.verification };
}

function sha256Hex(v: unknown): string { return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'); }

/** Gates shared by both trusted paths. `sessionSchemaChecked` is false for upstream DB-shaped session rows. */
function assertTrusted(consent: any, session: any, report: any, symptomReports: any[] | undefined, fullReport?: any, opts: { digestOnly?: boolean } = {}) {
  const schemaProblems = [
    ...validateContract('assessment-report', report),
    ...(fullReport ? validateContract('assessment-report', fullReport) : []),
    ...(symptomReports ?? []).flatMap((x) => validateContract('symptom-report', x)),
  ];
  if (schemaProblems.length) throw new WorkflowError(422, 'contract_violation', 'Payload does not match the PosturePulse contract.', schemaProblems);
  if (!Array.isArray(consent?.scopes) || !consent.scopes.includes('derived_events')) throw new WorkflowError(403, 'consent_scope', 'Consent does not include derived_events.');
  // The release/hash evidence is the FULL signed body when the subject view omits withdrawn rows; the subject view must then be exactly that body minus those rows.
  const bind = bindingViolations(consent, session, fullReport ?? report, opts);
  if (fullReport && !patientViewMatchesFull(report, fullReport)) bind.push('patient_view_mismatch');
  if (bind.length) throw new WorkflowError(bind.includes('report_not_released') ? 409 : 403, bind[0], 'Provenance verification failed.', bind);
  for (const x of symptomReports ?? []) if (x.sessionId !== report.sessionId) throw new WorkflowError(422, 'session_mismatch', 'Symptom report belongs to another session.');
  const time = timestampViolations(consent, session, report, timeRules());
  if (time.length) throw new WorkflowError(403, time[0], 'Consent or sign-off timestamps violate the import rules.', time);
}

/** Path (a): fetch report + session + consent from the configured trusted upstream. */
export async function importFromUpstream(args: { patientId: string; userId: string; sessionId: string; reportAccessToken: string; clinicianToken: string }) {
  const f = await fetchFromTrustedUpstream({ sessionId: args.sessionId, reportAccessToken: args.reportAccessToken, clinicianToken: args.clinicianToken });
  if (!f.ok) {
    const status = f.reason === 'not_configured' ? 503 : f.reason === 'pending_review' ? 409 : f.reason === 'invalid_id' ? 400 : f.reason === 'unauthorized' ? 403 : f.reason === 'not_found' ? 404 : 502;
    throw new WorkflowError(status, `upstream_${f.reason}`, `PosturePulse upstream: ${f.reason}.`);
  }
  const { consentRecord, session, report, fullReport, origin } = f.value;
  assertTrusted(consentRecord, session, report, undefined, fullReport);
  const link = await requireLink(args.patientId, session, consentRecord);
  return persist({ patientId: args.patientId, userId: args.userId, link, verification: 'upstream_verified', origin, digestStatus: 'recomputed_full_body', viewSha256: viewSha256(report), consentRecord, session, report });
}

export interface VerifiedBundleEvidence {
  consentRecord: any; session: any; report: any; symptomReports: any[] | undefined;
  origin: string; digestStatus: DigestStatus; viewSha256: string;
}

/**
 * Every check a signed bundle must pass BEFORE it is tied to a patient or a tenant: signature, contract, withheld-row
 * refusal, exported-view digest, binding, consent and timestamps. Shared by the patient import below and by the
 * tenant interpretation adapter, so there is one definition of "verified".
 */
export function verifyBundleEvidence(bundle: any, env: NodeJS.ProcessEnv = process.env): VerifiedBundleEvidence {
  const v = verifyBundle(bundle, env.ANUCLAW_POSTUREPULSE_IMPORT_SECRET, new Date(), 3600, parseKeyring(env.ANUCLAW_POSTUREPULSE_IMPORT_KEYS));
  if (!v.ok) throw new WorkflowError(v.reason === 'import_secret_not_configured' ? 503 : 403, v.reason, 'Signed bundle verification failed.');
  const { consentRecord, session, report, symptomReports } = v.payload;
  const problems = [...validateContract('consent-record', consentRecord), ...validateContract('session', session)];
  if (problems.length) throw new WorkflowError(422, 'contract_violation', 'Bundle does not match the PosturePulse contract.', problems);
  // A bundle must carry the subject-AUTHORISED view only: a row the clinician withheld must never arrive here, even correctly signed.
  if (Array.isArray(report?.rows) && report.rows.some((r: any) => r?.excluded)) throw new WorkflowError(403, 'bundle_contains_withheld_row', 'The bundle contains a row its clinician withheld; refusing to import it.');
  const view = v.payload.view;
  const withheld = view?.kind === 'subject_authorized' && Number.isInteger(view.rowsWithheld) && view.rowsWithheld > 0;
  // The exported view's own digest is verified separately (independent of the sign-off digest), when the exporter states one.
  const computedView = viewSha256(report);
  if (view?.viewSha256 !== undefined && view.viewSha256 !== computedView) throw new WorkflowError(403, 'view_digest_mismatch', 'The exported report does not match the digest of the view the exporter signed.');
  assertTrusted(consentRecord, session, report, symptomReports, undefined, { digestOnly: withheld });
  const origin = `signed:${v.payload.issuer}${v.payload.keyId ? `:${v.payload.keyId}` : ''}${v.payload.bundleId ? `:${v.payload.bundleId}` : ''}`;
  return { consentRecord, session, report, symptomReports, origin, digestStatus: withheld ? 'upstream_signed_claim_not_recomputable' : 'recomputed_full_body', viewSha256: computedView };
}

/** Path (b): a bundle signed with the configured shared secret. */
export async function importSignedBundle(args: { patientId: string; userId: string; bundle: any }, env: NodeJS.ProcessEnv = process.env) {
  const e = verifyBundleEvidence(args.bundle, env);
  const link = await requireLink(args.patientId, e.session, e.consentRecord);
  return persist({ patientId: args.patientId, userId: args.userId, link, verification: 'signed_bundle_verified', origin: e.origin, digestStatus: e.digestStatus, viewSha256: e.viewSha256, consentRecord: e.consentRecord, session: e.session, report: e.report, symptomReports: e.symptomReports });
}

/** Schema-only checks for an UNVERIFIED payload (no release, consent or hash claim is made). Throws 422 on a contract violation. */
export function validateUnverifiedEvidence(args: PostureImportInput): void {
  const problems = [
    ...validateContract('consent-record', args.consentRecord), ...validateContract('session', args.session),
    ...validateContract('assessment-report', args.report), ...(args.symptomReports ?? []).flatMap((x) => validateContract('symptom-report', x)),
  ];
  if (problems.length) throw new WorkflowError(422, 'contract_violation', 'Payload does not match the PosturePulse contract.', problems);
}

/**
 * UNVERIFIED payload: schema + subject link only. Stored and labelled
 * `unverified_payload`; it can NEVER satisfy the released clinical path
 * (no release, consent or hash claims are made).
 */
export async function importUnverifiedPayload(args: { patientId: string; userId: string } & PostureImportInput) {
  validateUnverifiedEvidence(args);
  const link = await requireLink(args.patientId, args.session, args.consentRecord);
  return persist({ ...args, link, verification: 'unverified_payload', origin: null });
}

/** Plain-language summary that keeps uncertainty and limitations attached to every value. */
export async function postureSummary(patientId: string, opts: { includeUnverified?: boolean } = {}) {
  const reports = await db.query<any>(
    `SELECT * FROM posture_reports WHERE patient_id = $1 ${opts.includeUnverified ? '' : "AND verification <> 'unverified_payload'"} ORDER BY imported_at DESC`, [patientId]);
  const out = [];
  for (const rep of reports) {
    const rows = await db.query<any>('SELECT * FROM posture_measurements WHERE posture_report_id = $1 ORDER BY metric_key', [rep.id]);
    out.push({
      postureReportId: rep.id, sessionId: rep.session_id, reportVersion: rep.report_version, signOff: JSON.parse(rep.sign_off_json),
      verification: rep.verification,
      verificationLabel: rep.verification === 'unverified_payload'
        ? 'UNVERIFIED payload — provenance, clinician release and consent were NOT verified; not part of the released clinical record.'
        : `Verified (${rep.verification === 'upstream_verified' ? 'fetched from the configured PosturePulse upstream' : 'signed import bundle, shared-secret authenticated'}); session/subject/consent binding and timestamps checked; see the integrity block for what the sign-off digest check did and did not establish.`,
      integrity: {
        signOffDigest: rep.digest_status === 'upstream_signed_claim_not_recomputable'
          ? 'UPSTREAM SIGNED CLAIM — rows were withheld, so the clinician sign-off digest cannot be recomputed here. It is not an independently verified sign-off; only the bundle signature (shared secret) vouches for it.'
          : rep.digest_status === 'recomputed_full_body' ? 'Recomputed here over the full signed body and matches.' : 'Not applicable (unverified payload).',
        exportedViewDigest: rep.view_sha256 ? `sha256 of the report as imported: ${rep.view_sha256}` : null,
        authentication: rep.verification === 'signed_bundle_verified' ? 'Authenticated by a shared-secret HMAC: proves the holder of the secret produced it, NOT which clinician signed.' : null,
      },
      symptomReportsRetrieved: rep.verification !== 'upstream_verified',
      symptomEscalation: rep.symptom_escalation,
      symptomNotice: rep.symptom_escalation ? 'Symptoms were reported during capture (pause/escalation). ANUClaw cannot resume the capture session; follow the clinician’s instructions.' : null,
      measurements: rows.map((m) => ({
        metricKey: m.metric_key, label: m.label, tier: m.tier, unit: m.unit, side: m.side, excluded: m.excluded, exclusionReason: m.exclusion_reason,
        position: m.position, positionNote: m.reference_json && JSON.parse(m.reference_json).status !== 'approved' ? 'Position is relative to a DRAFT reference.' : null, sourceAnalysis: m.analysis_text,
        text: m.value === null
          ? `${m.label}: no value (${m.tier === 'not_measurable' ? 'not measurable' : 'unsupported by capture quality'}).`
          : `${m.label}: ${m.value} ± ${m.uncertainty ?? '?'} ${m.unit} (${m.tier}).`,
        unsupportedReasons: JSON.parse(m.unsupported_reasons_json),
        reference: m.reference_json ? { ...JSON.parse(m.reference_json), note: JSON.parse(m.reference_json).status === 'approved' ? undefined : 'Reference is a draft and not approved; do not compare values against it.' } : null,
        limitation: m.limitation_note,
      })),
      notMeasurable: JSON.parse(rep.not_measurable_json),
      disclaimer: 'Measurements describe camera-based estimates; they are not diagnoses or health scores. A change between sessions is not necessarily clinically meaningful.',
    });
  }
  return out;
}

