/**
 * PosturePulse provenance: contract formats, timestamp rules, hash binding with the
 * UPSTREAM's own canonicalisation, upstream config / SSRF rules, signed bundles, and
 * the trusted fetch against a local stand-in for the upstream routes (the real
 * NestJS backend is not running here — see docs/INTEGRATION-STATUS.md).
 */
import * as http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateContract } from './contract';
import { sealReport, syntheticPosture } from './fixtures';
import {
  bindingViolations, canonicalJson, fetchFromTrustedUpstream, isSafeId, parseKeyring, patientViewMatchesFull, reportContentSha256, signBundle, timeRules,
  timestampViolations, upstreamConfig, verifyBundle,
} from './upstream';
// The real upstream implementation (read-only import from the adjacent PosturePulse checkout).
import { reportContentSha256 as upstreamSha, canonicalJson as upstreamCanonical } from '../../../../../services/backend-api/src/reports/canonical-json';

const NOW = new Date();
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe('contract date-time formats are validated (ajv-formats)', () => {
  it.each(['not-a-date', '2026-13-45T10:00:00Z', '2026-11-17 10:00:00', '', 12345])('rejects consent.grantedAt=%j', (v) => {
    const f = syntheticPosture();
    (f.consentRecord as any).grantedAt = v;
    expect(validateContract('consent-record', f.consentRecord).length).toBeGreaterThan(0);
  });
  it('rejects an invalid sign-off timestamp in a report', () => {
    const f = syntheticPosture();
    f.report.signOff!.signedAt = 'yesterday';
    expect(validateContract('assessment-report', f.report).join(' ')).toMatch(/signedAt|format/);
  });
  it('accepts valid timestamps', () => {
    const f = syntheticPosture();
    expect(validateContract('consent-record', f.consentRecord)).toEqual([]);
    expect(validateContract('assessment-report', f.report)).toEqual([]);
  });
});

describe('explicit timestamp rules', () => {
  const rules = timeRules({}, NOW);
  const fx = () => syntheticPosture({ now: NOW });
  it('baseline passes', () => {
    const f = fx();
    expect(timestampViolations(f.consentRecord, f.session, f.report, rules)).toEqual([]);
  });
  it('future consent / future sign-off (beyond skew) are rejected; within skew is allowed', () => {
    const a = fx(); a.consentRecord.grantedAt = iso(10 * 60_000);
    expect(timestampViolations(a.consentRecord, a.session, a.report, rules)).toContain('consent_granted_in_future');
    const b = fx(); b.report.signOff!.signedAt = iso(10 * 60_000);
    expect(timestampViolations(b.consentRecord, b.session, b.report, rules)).toContain('sign_off_in_future');
    const c = fx(); c.report.signOff!.signedAt = iso(2 * 60_000);
    expect(timestampViolations(c.consentRecord, c.session, c.report, rules)).not.toContain('sign_off_in_future');
  });
  it('expired consent / sign-off use the configured max age', () => {
    const f = fx();
    f.consentRecord.grantedAt = iso(-800 * 86_400_000);
    f.session.createdAt = iso(-799 * 86_400_000);
    f.report.signOff!.signedAt = iso(-798 * 86_400_000);
    const v = timestampViolations(f.consentRecord, f.session, f.report, rules);
    expect(v).toEqual(expect.arrayContaining(['consent_expired', 'sign_off_expired']));
    const lenient = timeRules({ ANUCLAW_POSTUREPULSE_CONSENT_MAX_AGE_DAYS: '1000', ANUCLAW_POSTUREPULSE_SIGNOFF_MAX_AGE_DAYS: '1000' }, NOW);
    expect(timestampViolations(f.consentRecord, f.session, f.report, lenient)).toEqual([]);
  });
  it('ordering: consent after session start, sign-off before session start', () => {
    const a = fx(); a.consentRecord.grantedAt = iso(-60_000); a.session.createdAt = iso(-3_600_000);
    expect(timestampViolations(a.consentRecord, a.session, a.report, rules)).toContain('consent_granted_after_session_start');
    const b = fx(); b.report.signOff!.signedAt = iso(-7_200_000);
    expect(timestampViolations(b.consentRecord, b.session, b.report, rules)).toContain('sign_off_before_session_start');
  });
  it('revocation / withdrawal and unparseable timestamps are violations', () => {
    const a = fx(); (a.consentRecord as any).revokedAt = iso(-1000); (a.consentRecord as any).withdrawalRequestedAt = iso(-500);
    expect(timestampViolations(a.consentRecord, a.session, a.report, rules)).toEqual(expect.arrayContaining(['consent_revoked', 'consent_withdrawal_requested']));
    const b = fx(); (b.consentRecord as any).grantedAt = 'garbage'; (b.report.signOff as any).signedAt = 'garbage';
    expect(timestampViolations(b.consentRecord, b.session, b.report, rules)).toEqual(expect.arrayContaining(['consent_granted_at_invalid', 'sign_off_signed_at_invalid']));
  });
});

describe('content-hash binding uses the upstream canonicalisation', () => {
  it('matches the REAL upstream implementation byte-for-byte', () => {
    const f = syntheticPosture();
    expect(reportContentSha256(f.report as any)).toBe(upstreamSha(f.report as any));
    const odd = { b: [3, { z: 1, a: [null, true, 'x'] }], a: { y: 2, x: 1 } };
    expect(canonicalJson(odd)).toBe(upstreamCanonical(odd));
  });
  it('detects any change to a signed report (value, tier, status, sign-off identity)', () => {
    const f = syntheticPosture();
    expect(bindingViolations(f.consentRecord, f.session, f.report)).toEqual([]);
    const mutate = (fn: (r: any) => void) => { const r = structuredClone(f.report) as any; fn(r); return bindingViolations(f.consentRecord, f.session, r); };
    expect(mutate((r) => { r.rows[0].estimate.value = 9.9; })).toContain('content_hash_mismatch');
    expect(mutate((r) => { r.rows[0].tier = 'estimate'; })).toContain('content_hash_mismatch');
    expect(mutate((r) => { r.signOff.clinicianId = 'someone-else'; })).toContain('content_hash_mismatch');
    expect(mutate((r) => { r.status = 'draft'; })).toContain('report_not_released');
  });
  it('a forged sign-off (invented digest) fails; re-sealing a forged report passes the hash but NOT provenance', () => {
    const f = syntheticPosture();
    const forged = structuredClone(f.report) as any;
    forged.rows[0].estimate.value = 0;
    forged.signOff.contentSha256 = 'a'.repeat(64);
    expect(bindingViolations(f.consentRecord, f.session, forged)).toContain('content_hash_mismatch');
    // A hash alone proves nothing about WHO signed — which is why a caller payload is never accepted as a release.
    sealReport(forged);
    expect(bindingViolations(f.consentRecord, f.session, forged)).toEqual([]);
  });
  it('session / subject / consent binding', () => {
    const f = syntheticPosture();
    expect(bindingViolations(f.consentRecord, { ...f.session, sessionId: 'other' }, f.report)).toContain('session_report_mismatch');
    expect(bindingViolations(f.consentRecord, { ...f.session, subjectPseudoId: 'other' }, f.report)).toContain('session_consent_subject_mismatch');
    expect(bindingViolations(f.consentRecord, { ...f.session, consentRecordId: 'other' }, f.report)).toContain('session_consent_record_mismatch');
    // upstream DB-shaped session rows use `id`
    const { sessionId, ...rest } = f.session as any;
    expect(bindingViolations(f.consentRecord, { ...rest, id: sessionId }, f.report)).toEqual([]);
  });
});

describe('upstream origin configuration (SSRF rules)', () => {
  const cfg = (url: string, extra: NodeJS.ProcessEnv = {}) => () => upstreamConfig({ ANUCLAW_POSTUREPULSE_URL: url, ...extra });
  it('accepts https origins and loopback http outside production', () => {
    expect(upstreamConfig({ ANUCLAW_POSTUREPULSE_URL: 'https://posture.example.test/' }).origin).toBe('https://posture.example.test');
    expect(upstreamConfig({ ANUCLAW_POSTUREPULSE_URL: 'http://127.0.0.1:3000' }).origin).toBe('http://127.0.0.1:3000');
  });
  it.each([
    ['', {}], ['not a url', {}], ['ftp://x.test', {}], ['http://posture.example.test', {}],
    ['http://127.0.0.1:3000', { NODE_ENV: 'production' }], ['https://user:pw@posture.example.test', {}],
    ['https://posture.example.test/api', {}], ['https://posture.example.test/?q=1', {}],
    ['https://169.254.169.254', {}], ['https://10.0.0.5', {}], ['https://192.168.1.10', {}],
  ])('rejects %j', (url, extra) => { expect(cfg(url, extra)).toThrow(); });
  it('private ranges only with the explicit override', () => {
    expect(upstreamConfig({ ANUCLAW_POSTUREPULSE_URL: 'https://10.0.0.5', ANUCLAW_POSTUREPULSE_ALLOW_PRIVATE: 'true' }).origin).toBe('https://10.0.0.5');
  });
  it('ids are pattern-checked before use in a path', () => {
    expect(isSafeId('session-synthetic-001')).toBe(true);
    for (const bad of ['../etc/passwd', 'a/b', 'a b', '', 'x'.repeat(201), 'a?b=1', '%2e%2e']) expect(isSafeId(bad)).toBe(false);
  });
});

describe('signed import bundles', () => {
  const secret = 'x'.repeat(40);
  const payload = () => { const f = syntheticPosture(); return { ...f, issuedAt: new Date().toISOString(), issuer: 'synthetic-exporter' }; };
  it('verifies a correctly signed, fresh bundle', () => {
    const b = signBundle(payload(), secret);
    expect(verifyBundle(b, secret).ok).toBe(true);
  });
  it.each([
    ['no secret configured', (b: any) => b, undefined, 'import_secret_not_configured'],
    ['short secret', (b: any) => b, 'short', 'import_secret_not_configured'],
    ['wrong secret', (b: any) => b, 'y'.repeat(40), 'bad_signature'],
    ['tampered payload', (b: any) => { b.payload.report.rows[0].estimate.value = 0; return b; }, secret, 'bad_signature'],
    ['malformed signature', (b: any) => { b.signature = 'zz'; return b; }, secret, 'bundle_malformed'],
    ['missing payload', () => ({ signature: 'a'.repeat(64) }), secret, 'bundle_malformed'],
  ])('rejects: %s', (_l, mutate, sec, reason) => {
    const r = verifyBundle(mutate(signBundle(payload(), secret)), sec);
    expect(r).toEqual({ ok: false, reason });
  });
  it('rejects stale and far-future bundles (replay window)', () => {
    const old = signBundle({ ...payload(), issuedAt: new Date(Date.now() - 2 * 3600_000).toISOString() }, secret);
    expect(verifyBundle(old, secret)).toEqual({ ok: false, reason: 'bundle_not_fresh' });
    const fut = signBundle({ ...payload(), issuedAt: new Date(Date.now() + 2 * 3600_000).toISOString() }, secret);
    expect(verifyBundle(fut, secret)).toEqual({ ok: false, reason: 'bundle_not_fresh' });
  });
});

describe('signed bundles: key ids, rotation, authorised view', () => {
  const s1 = 'a'.repeat(40), s2 = 'b'.repeat(40);
  const base = () => ({ ...syntheticPosture(), issuedAt: new Date().toISOString(), issuer: 'synthetic-exporter', keyId: 'k1', bundleId: 'b-1', signatureScheme: 'hmac-sha256/shared-secret' });
  it('parseKeyring accepts a JSON object of >=32-char secrets keyed by safe ids, and nothing else', () => {
    expect(parseKeyring(JSON.stringify({ k1: s1, 'k2.v': s2 }))).toEqual({ k1: s1, 'k2.v': s2 });
    for (const bad of [undefined, '', 'not json', '[]', '{"k1":"short"}', '{"bad id":"' + s1 + '"}', '{"k1":1}']) expect(parseKeyring(bad as any)).toBeNull();
  });
  it('the keyring selects the secret by keyId; rotation = add the new key, drop the old one later', () => {
    const b = signBundle(base(), s1);
    expect(verifyBundle(b, undefined, new Date(), 3600, { k1: s1, k2: s2 }).ok).toBe(true);
    expect(verifyBundle(b, undefined, new Date(), 3600, { k2: s2 })).toEqual({ ok: false, reason: 'unknown_key_id' });         // old key retired
    expect(verifyBundle(b, undefined, new Date(), 3600, { k1: s2 })).toEqual({ ok: false, reason: 'bad_signature' });         // right id, wrong secret
    expect(verifyBundle(signBundle({ ...base(), keyId: 'k2' }, s2), undefined, new Date(), 3600, { k1: s1, k2: s2 }).ok).toBe(true);
  });
  it('keyId is covered by the signature (cannot be swapped to select another key) and must be well-formed', () => {
    const b = signBundle(base(), s1); b.payload.keyId = 'k2';
    expect(verifyBundle(b, undefined, new Date(), 3600, { k1: s1, k2: s2 })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyBundle(signBundle({ ...base(), keyId: '../x' }, s1), s1)).toEqual({ ok: false, reason: 'bundle_malformed' });
  });
  it('a bundle without keyId still verifies with the single configured secret (backwards compatible)', () => {
    const { keyId: _k, ...noKey } = base();
    expect(verifyBundle(signBundle(noKey, s1), s1).ok).toBe(true);
  });
  it('digestOnly mode requires a well-formed digest but does not recompute it', () => {
    const f = syntheticPosture(); const view = { ...f.report, rows: f.report.rows.filter((r: any) => !r.excluded) };
    expect(bindingViolations(f.consentRecord, f.session, view)).toContain('content_hash_mismatch');
    expect(bindingViolations(f.consentRecord, f.session, view, { digestOnly: true })).toEqual([]);
    expect(bindingViolations(f.consentRecord, f.session, { ...view, signOff: { ...view.signOff, contentSha256: 'nope' } }, { digestOnly: true })).toContain('content_hash_malformed');
  });
});

describe('trusted upstream fetch (local stand-in for the upstream routes)', () => {
  let server: http.Server; let origin: string;
  const seen: Array<{ url: string; auth?: string }> = [];
  let other: http.Server; let otherHits = 0;
  const f = syntheticPosture();
  const sessionRow = { id: f.session.sessionId, subjectPseudoId: f.session.subjectPseudoId, consentRecordId: f.session.consentRecordId, state: 'ClinicianReview', createdAt: f.session.createdAt };
  const consent = { id: f.consentRecord.consentRecordId, ...f.consentRecord };

  beforeAll(async () => {
    other = http.createServer((_q, r) => { otherHits++; r.writeHead(200); r.end('{}'); });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
    const otherPort = (other.address() as AddressInfo).port;
    server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization });
      const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const u = req.url ?? '';
      if (u.startsWith('/sessions/redirect-me/')) { res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/steal` }); res.end(); return; }
      // Faithful to the real upstream: the subject view omits rows the clinician withdrew; the clinician route serves the whole signed body.
      if (u === `/sessions/${f.session.sessionId}/released-report`) return req.headers.authorization === 'Bearer report-token' ? send(200, { ...f.report, rows: f.report.rows.filter((r: any) => !r.excluded) }) : send(403, {});
      if (u === `/reports/${f.report.reportId}`) return req.headers.authorization === 'Bearer clin-token' ? send(200, f.report) : send(401, {});
      if (u === '/sessions/pending-1/released-report') return send(404, { status: 'pending_review' });
      if (u === `/sessions/${f.session.sessionId}`) return req.headers.authorization === 'Bearer clin-token' ? send(200, sessionRow) : send(401, {});
      if (u === `/consent-records/${f.consentRecord.consentRecordId}`) return send(200, consent);
      send(404, {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await new Promise<void>((r) => other.close(() => r())); });
  const env = () => ({ ANUCLAW_POSTUREPULSE_URL: origin });
  const args = (over: Partial<{ sessionId: string; reportAccessToken: string; clinicianToken: string }> = {}) => ({ sessionId: f.session.sessionId, reportAccessToken: 'report-token', clinicianToken: 'clin-token', ...over });

  it('fetches report + session + consent from the configured origin only', async () => {
    const r = await fetchFromTrustedUpstream(args(), env());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.report.rows.some((x: any) => x.excluded)).toBe(false);           // the subject view, exactly as served
      expect(r.value.fullReport).toEqual(f.report);                                    // fetched because the subject view cannot hash to the digest
      expect(bindingViolations(r.value.consentRecord, r.value.session, r.value.fullReport)).toEqual([]);
      expect(bindingViolations(r.value.consentRecord, r.value.session, r.value.report)).toContain('content_hash_mismatch');   // the old check would have rejected this valid release
      expect(patientViewMatchesFull(r.value.report, r.value.fullReport)).toBe(true);
    }
  });
  it('the subject view must be EXACTLY the signed body minus withdrawn rows', () => {
    const view = { ...f.report, rows: f.report.rows.filter((r: any) => !r.excluded) };
    expect(patientViewMatchesFull(view, f.report)).toBe(true);
    const altered = JSON.parse(JSON.stringify(view)); altered.rows[0].estimate.value = 99;
    expect(patientViewMatchesFull(altered, f.report)).toBe(false);                    // a changed value is not hidden by the exclusion allowance
    expect(patientViewMatchesFull({ ...view, rows: [...view.rows, { metricKey: 'extra' }] }, f.report)).toBe(false);
    expect(patientViewMatchesFull({ ...view, rows: [] }, f.report)).toBe(false);      // silently dropping a NON-withdrawn row is refused
    expect(patientViewMatchesFull(null, f.report)).toBe(false);
  });
  it('maps upstream outcomes explicitly', async () => {
    expect(await fetchFromTrustedUpstream(args({ reportAccessToken: 'wrong' }), env())).toEqual({ ok: false, reason: 'unauthorized' });
    expect(await fetchFromTrustedUpstream(args({ clinicianToken: 'wrong' }), env())).toEqual({ ok: false, reason: 'unauthorized' });
    expect(await fetchFromTrustedUpstream(args({ sessionId: 'pending-1' }), env())).toEqual({ ok: false, reason: 'pending_review' });
    expect(await fetchFromTrustedUpstream(args({ sessionId: '../x' }), env())).toEqual({ ok: false, reason: 'invalid_id' });
    expect(await fetchFromTrustedUpstream(args(), {})).toEqual({ ok: false, reason: 'not_configured' });
    expect(await fetchFromTrustedUpstream(args(), { ANUCLAW_POSTUREPULSE_URL: 'http://127.0.0.1:1' })).toEqual({ ok: false, reason: 'unavailable' });
  });
  it('never follows redirects, so tokens cannot be forwarded to another host', async () => {
    seen.length = 0; otherHits = 0;
    expect(await fetchFromTrustedUpstream(args({ sessionId: 'redirect-me' }), env())).toEqual({ ok: false, reason: 'redirect_refused' });
    expect(otherHits).toBe(0);
  });
  it('sends each credential only to the intended routes', async () => {
    seen.length = 0;
    await fetchFromTrustedUpstream(args(), env());
    expect(seen.find((s) => s.url.endsWith('/released-report'))?.auth).toBe('Bearer report-token');
    expect(seen.find((s) => s.url === `/sessions/${f.session.sessionId}`)?.auth).toBe('Bearer clin-token');
    expect(seen.find((s) => s.url === `/reports/${f.report.reportId}`)?.auth).toBe('Bearer clin-token');   // the full body is a clinician-only route
  });
});
