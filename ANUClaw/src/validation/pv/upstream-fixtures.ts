/**
 * SYNTHETIC PosturePulse upstream-report cases: well-formed, malformed, unsigned, withdrawn/revoked, unreleased, tampered and out-of-order. Each case states the violation codes
 * the EXISTING import protections are expected to report. These exercise validation code; they are not real subjects or reports.
 */
import { syntheticPosture, sealReport, bundlePayloadOf } from '../../integrations/posturepulse/fixtures';
import { bindingViolations, signBundle, timestampViolations, timeRules, verifyBundle } from '../../integrations/posturepulse/upstream';
const SECRET = 'synthetic-test-secret-0123456789abcdef0123';
export interface UpstreamCase { id: string; description: string; expectedTimestamp: string[]; expectedBinding: string[]; expectedBundle: 'ok' | string; build: () => { consentRecord: any; session: any; report: any; bundle: any } }
const sign = (f: ReturnType<typeof syntheticPosture>, over: Record<string, unknown> = {}) => signBundle({ ...(bundlePayloadOf(f) as any), ...over }, SECRET);
export function upstreamCases(now = new Date()): UpstreamCase[] {
  const mk = (id: string, description: string, mut: (f: any) => void, exp: { t?: string[]; b?: string[]; bundle?: string }, bundleMut?: (b: any) => void): UpstreamCase => ({ id, description, expectedTimestamp: exp.t ?? [], expectedBinding: exp.b ?? [], expectedBundle: exp.bundle ?? 'ok',
    build: () => { const f = syntheticPosture({ now }); mut(f); const bundle = sign(f); bundleMut?.(bundle); return { consentRecord: f.consentRecord, session: f.session, report: f.report, bundle }; } });
  return [
    mk('ok', 'well-formed, released, consented, signed', () => undefined, {}),
    mk('consent_withdrawal_requested', 'subject requested withdrawal', (f) => { f.consentRecord.withdrawalRequestedAt = new Date(now.getTime() - 60_000).toISOString(); }, { t: ['consent_withdrawal_requested'] }),
    mk('consent_revoked', 'consent revoked', (f) => { f.consentRecord.revokedAt = new Date(now.getTime() - 60_000).toISOString(); }, { t: ['consent_revoked'] }),
    mk('unreleased_draft', 'report is a draft, not released', (f) => { f.report.status = 'draft'; }, { b: ['report_not_released'] }),
    mk('tampered_after_signoff', 'a metric value was edited after the sign-off digest was computed', (f) => { f.report.rows[0].estimate.value = 9.9; }, { b: ['content_hash_mismatch'] }),
    mk('subject_mismatch', 'session subject differs from the consent subject', (f) => { f.session.subjectPseudoId = 'someone-else'; }, { b: ['session_consent_subject_mismatch'] }),
    mk('signoff_before_session_start', 'out of order: sign-off precedes the session', (f) => { f.report.signOff.signedAt = new Date(now.getTime() - 7_200_000).toISOString(); sealReport(f.report); }, { t: ['sign_off_before_session_start'] }),
    mk('signoff_in_future', 'out of order: sign-off is in the future', (f) => { f.report.signOff.signedAt = new Date(now.getTime() + 86_400_000).toISOString(); sealReport(f.report); }, { t: ['sign_off_in_future'] }),
    mk('consent_after_session', 'out of order: consent granted after the session started', (f) => { f.consentRecord.grantedAt = new Date(now.getTime() - 600_000).toISOString(); }, { t: ['consent_granted_after_session_start'] }),
    mk('unsigned_bundle', 'bundle has no signature', () => undefined, { bundle: 'bundle_malformed' }, (b) => { delete b.signature; }),
    mk('bad_signature', 'bundle signature does not match the payload', () => undefined, { bundle: 'bad_signature' }, (b) => { b.payload.issuer = 'tampered-issuer'; }),
    mk('stale_bundle', 'bundle issued long ago (replay)', () => undefined, { bundle: 'bundle_not_fresh' }, (b) => { void b; }),
  ];
}
/** Runs the existing protections over a case and reports what they said (so tests compare expectation and observation). */
export function observeUpstream(c: UpstreamCase, now = new Date()): { timestamp: string[]; binding: string[]; bundle: string } {
  const b = c.build(); const rules = timeRules({} as never, now);
  const bundle = c.id === 'stale_bundle' ? verifyBundle(b.bundle, SECRET, new Date(now.getTime() + 2 * 3_600_000)) : verifyBundle(b.bundle, SECRET, now);
  return { timestamp: timestampViolations(b.consentRecord, b.session, b.report, rules), binding: bindingViolations(b.consentRecord, b.session, b.report), bundle: bundle.ok ? 'ok' : bundle.reason };
}
export const MALFORMED_REPORTS: Array<{ id: string; mutate: (r: any) => void }> = [
  { id: 'missing_sessionId', mutate: (r) => { delete r.sessionId; } }, { id: 'rows_not_array', mutate: (r) => { r.rows = 'x'; } }, { id: 'unknown_status', mutate: (r) => { r.status = 'approved-by-robot'; } }, { id: 'metric_missing_unit', mutate: (r) => { delete r.rows[0].unit; } },
];
export { syntheticPosture };
