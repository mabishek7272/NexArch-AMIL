/**
 * PosturePulse import against REAL PostgreSQL (disposable; opt-in). Verified paths:
 * configured-upstream fetch (local stand-in for the upstream routes) and signed
 * bundles. Caller-supplied payloads can only be stored as labelled unverified.
 * Synthetic records only.
 */
import * as crypto from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bundlePayloadOf, sealReport, syntheticPosture } from './fixtures';
import { signBundle } from './upstream';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('PosturePulse import (real PostgreSQL)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`;
  const SECRET = 'import-secret-'.padEnd(40, 'z');
  let admin: Client;
  let svc: typeof import('./service');
  let patientId: string;
  let upstream: http.Server;
  let current = syntheticPosture();
  const bundle = (f: ReturnType<typeof syntheticPosture>) => signBundle(bundlePayloadOf(f) as any, SECRET);

  beforeAll(async () => {
    const f = () => current;
    upstream = http.createServer((req, res) => {
      const send = (c: number, b: unknown) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      const u = req.url ?? ''; const a = req.headers.authorization;
      if (u.endsWith('/released-report')) return a === 'Bearer report-token' ? send(200, { ...f().report, rows: f().report.rows.filter((r: any) => !r.excluded) }) : send(403, {});   // faithful: withdrawn rows omitted
      if (u === `/reports/${f().report.reportId}`) return a === 'Bearer clin-token' ? send(200, f().report) : send(401, {});
      if (u === `/sessions/${f().session.sessionId}`) return a === 'Bearer clin-token' ? send(200, { id: f().session.sessionId, ...f().session, sessionId: undefined }) : send(401, {});
      if (u.startsWith('/consent-records/')) return send(200, { id: f().consentRecord.consentRecordId, ...f().consentRecord });
      send(404, {});
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, {
      PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName,
      ANUCLAW_POSTUREPULSE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, ANUCLAW_POSTUREPULSE_IMPORT_SECRET: SECRET,
    });
    vi.resetModules();
    await (await import('../../db/connection')).ensureDbReady();
    const { db } = await import('../../db');
    patientId = crypto.randomUUID();
    await db.query(`INSERT INTO patients (id, uid, name, created_at, updated_at) VALUES ($1,$2,'Synthetic',0,0)`, [patientId, `S-${patientId}`]);
    svc = await import('./service');
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => upstream.close(() => r()));
    try { (await import('../../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const signed = (f: ReturnType<typeof syntheticPosture>) => svc.importSignedBundle({ patientId, userId: 'u', bundle: bundle(f) });

  it('verified imports require an explicit subject link (never matched by name)', async () => {
    await expect(signed(syntheticPosture())).rejects.toMatchObject({ code: 'no_subject_link' });
    await svc.linkSubject({ patientId, subjectPseudoId: 'subj-synthetic-001', consentRecordId: 'consent-synthetic-001', purpose: 'rehab review (synthetic)', userId: 'admin' });
    await expect(signed(syntheticPosture({ consent: 'consent-other' }))).rejects.toMatchObject({ code: 'consent_mismatch' });
  });

  it('a caller-supplied payload cannot be a clinical release: forged signature / no secret / tampering are refused', async () => {
    const f = syntheticPosture();
    const forged = bundle(f); (forged.payload.report as any).rows[0].estimate.value = 0;
    await expect(svc.importSignedBundle({ patientId, userId: 'u', bundle: forged })).rejects.toMatchObject({ code: 'bad_signature' });
    const wrongKey = signBundle(bundlePayloadOf(f) as any, 'k'.repeat(40));
    await expect(svc.importSignedBundle({ patientId, userId: 'u', bundle: wrongKey })).rejects.toMatchObject({ code: 'bad_signature' });
    await expect(svc.importSignedBundle({ patientId, userId: 'u', bundle: bundle(f) }, { ...process.env, ANUCLAW_POSTUREPULSE_IMPORT_SECRET: '' })).rejects.toMatchObject({ code: 'import_secret_not_configured' });
    // Self-signed with a valid-looking digest but a forged clinician: signature check (not the digest) is what protects provenance.
    const resealed = syntheticPosture(); (resealed.report.signOff as any).clinicianId = 'forged-clinician'; sealReport(resealed.report);
    await expect(svc.importUnverifiedPayload({ patientId, userId: 'u', ...resealed })).resolves.toMatchObject({ verification: 'unverified_payload' });
  });

  it('signed bundle contract: withheld rows never arrive; keyring rotation; the bundle id and key id are recorded', async () => {
    const uniq = (f: ReturnType<typeof syntheticPosture>, id: string) => { f.report.reportId = id; return sealReport(f.report), f; };
    const f = uniq(syntheticPosture({ session: 'session-synthetic-bundle' }), 'report-bundle-1');
    // 1. a correctly signed bundle that still carries a withheld row is refused (a signature does not grant disclosure)
    const leaking = signBundle({ ...bundlePayloadOf(f), report: f.report, view: { kind: 'subject_authorized', rowsWithheld: 0 } } as any, SECRET);
    await expect(svc.importSignedBundle({ patientId, userId: 'u', bundle: leaking })).rejects.toMatchObject({ code: 'bundle_contains_withheld_row' });
    // 2. keyring: key retired → refused; unknown id → refused; valid id → imported and recorded
    const keyring = JSON.stringify({ k1: SECRET, k0: 'o'.repeat(40) });
    const ok = await svc.importSignedBundle({ patientId, userId: 'u', bundle: signBundle(bundlePayloadOf(f, { keyId: 'k1', bundleId: 'bundle-77' }) as any, SECRET) }, { ...process.env, ANUCLAW_POSTUREPULSE_IMPORT_SECRET: '', ANUCLAW_POSTUREPULSE_IMPORT_KEYS: keyring });
    expect(ok.verification).toBe('signed_bundle_verified');
    const { db } = await import('../../db');
    expect((await db.queryOne<any>('SELECT upstream_origin FROM posture_reports WHERE id = $1', [ok.postureReportId]))!.upstream_origin).toBe('signed:synthetic-exporter:k1:bundle-77');
    const f2 = uniq(syntheticPosture({ session: 'session-synthetic-bundle-2' }), 'report-bundle-2');
    await expect(svc.importSignedBundle({ patientId, userId: 'u', bundle: signBundle(bundlePayloadOf(f2, { keyId: 'k9' }) as any, SECRET) }, { ...process.env, ANUCLAW_POSTUREPULSE_IMPORT_KEYS: keyring })).rejects.toMatchObject({ code: 'unknown_key_id' });
    // 3. a malformed digest is refused even when rows are withheld (the contract schema rejects it before the binding check)
    const f3 = uniq(syntheticPosture({ session: 'session-synthetic-bundle-3' }), 'report-bundle-3'); f3.report.signOff!.contentSha256 = 'zz';
    await expect(svc.importSignedBundle({ patientId, userId: 'u', bundle: signBundle(bundlePayloadOf(f3) as any, SECRET) })).rejects.toMatchObject({ code: 'contract_violation' });
  });

  it('integrity labels: a withheld-row digest is an UPSTREAM SIGNED CLAIM; the exported view is digested separately; a mismatching view digest is refused', async () => {
    const uniq = (f: ReturnType<typeof syntheticPosture>, id: string) => { f.report.reportId = id; return sealReport(f.report), f; };
    const f = uniq(syntheticPosture({ session: 'session-synthetic-int-1' }), 'report-int-1');           // fixture has one withheld row
    const out = await svc.importSignedBundle({ patientId, userId: 'u', bundle: bundle(f) });
    const { db } = await import('../../db');
    const row = await db.queryOne<any>('SELECT digest_status, view_sha256 FROM posture_reports WHERE id = $1', [out.postureReportId]);
    expect(row.digest_status).toBe('upstream_signed_claim_not_recomputable');
    expect(row.view_sha256).toBe(bundlePayloadOf(f).view.viewSha256);
    const s = (await svc.postureSummary(patientId)).find((x: any) => x.postureReportId === out.postureReportId);
    expect(s.integrity.signOffDigest).toMatch(/UPSTREAM SIGNED CLAIM.*not an independently verified sign-off/s);
    expect(s.integrity.authentication).toMatch(/shared-secret HMAC.*NOT which clinician/s);
    expect(s.integrity.exportedViewDigest).toContain(row.view_sha256);
    // a view digest that does not match the report actually received
    const f2 = uniq(syntheticPosture({ session: 'session-synthetic-int-2' }), 'report-int-2');
    const bad = signBundle(bundlePayloadOf(f2, { view: { kind: 'subject_authorized', rowsWithheld: 1, viewSha256: 'a'.repeat(64) } }) as any, SECRET);
    await expect(svc.importSignedBundle({ patientId, userId: 'u', bundle: bad })).rejects.toMatchObject({ code: 'view_digest_mismatch' });
    // nothing withheld → the sign-off digest IS recomputed here
    const f3 = uniq(syntheticPosture({ session: 'session-synthetic-int-3' }), 'report-int-3'); f3.report.rows = f3.report.rows.filter((r: any) => !r.excluded); sealReport(f3.report);
    const ok3 = await svc.importSignedBundle({ patientId, userId: 'u', bundle: bundle(f3) });
    expect((await db.queryOne<any>('SELECT digest_status FROM posture_reports WHERE id = $1', [ok3.postureReportId]))!.digest_status).toBe('recomputed_full_body');
    // the verified-upstream path recomputes over the full body
    current = uniq(syntheticPosture({ session: 'session-synthetic-int-4' }), 'report-int-4');
    const up = await svc.importFromUpstream({ patientId, userId: 'u', sessionId: 'session-synthetic-int-4', reportAccessToken: 'report-token', clinicianToken: 'clin-token' });
    expect((await db.queryOne<any>('SELECT digest_status FROM posture_reports WHERE id = $1', [up.postureReportId]))!.digest_status).toBe('recomputed_full_body');
  });

  it('trusted gates: consent scope, withdrawal, expiry, future sign-off, unreleased, hash mismatch', async () => {
    const cases: Array<[string, (f: ReturnType<typeof syntheticPosture>) => void, string]> = [
      ['scope', (f) => { f.consentRecord.scopes = ['raw_video']; }, 'consent_scope'],
      ['withdrawn', (f) => { (f.consentRecord as any).withdrawalRequestedAt = new Date().toISOString(); }, 'consent_withdrawal_requested'],
      ['revoked', (f) => { (f.consentRecord as any).revokedAt = new Date().toISOString(); }, 'consent_revoked'],
      ['expired', (f) => { f.consentRecord.grantedAt = new Date(Date.now() - 900 * 86_400_000).toISOString(); f.session.createdAt = new Date(Date.now() - 899 * 86_400_000).toISOString(); }, 'consent_expired'],
      ['future sign-off', (f) => { f.report.signOff!.signedAt = new Date(Date.now() + 3600_000).toISOString(); sealReport(f.report); }, 'sign_off_in_future'],
      ['unreleased', (f) => { f.report.status = 'draft'; (f.report as any).signOff = null; }, 'report_not_released'],
      // With NO withheld rows the digest is recomputable and a wrong one is refused (with withheld rows it is carried as a signed claim).
      ['hash', (f) => { f.report.rows = f.report.rows.filter((r: any) => !r.excluded); f.report.signOff!.contentSha256 = 'b'.repeat(64); }, 'content_hash_mismatch'],
      ['session mismatch', (f) => { (f.session as any).sessionId = 'another-session'; }, 'session_report_mismatch'],
    ];
    for (const [label, mutate, code] of cases) {
      const f = syntheticPosture(); mutate(f);
      await expect(signed(f), label).rejects.toMatchObject({ code });
    }
  });

  it('verified signed import preserves the upstream report exactly and labels its verification', async () => {
    const f = syntheticPosture();
    f.symptomReports = [{ symptomReportId: 'sym-1', sessionId: f.session.sessionId, reportedAt: new Date(Date.now() - 2_000_000).toISOString(), symptoms: ['dizziness'], severity: 'moderate', freeText: null, triggeredAction: 'pause' }];
    const out = await signed(f);
    expect(out).toMatchObject({ rows: 1, symptomEscalation: true, verification: 'signed_bundle_verified' });   // the withheld row is NOT in the bundle
    await expect(signed(f)).rejects.toMatchObject({ code: 'already_imported' });

    const { db } = await import('../../db');
    const stored = await db.queryOne<any>('SELECT report_json, content_sha256 FROM posture_reports WHERE id = $1', [out.postureReportId]);
    expect(JSON.parse(stored.report_json)).toEqual(JSON.parse(JSON.stringify(bundlePayloadOf(f).report)));   // exactly the authorised view that was signed
    expect(JSON.stringify(stored)).not.toContain('synthetic exclusion');                                      // the withheld row's reason never arrived
    expect(stored.content_sha256).toBe(f.report.signOff!.contentSha256);
    const rowJson = await db.query<any>('SELECT row_json FROM posture_measurements WHERE posture_report_id = $1 ORDER BY metric_key', [out.postureReportId]);
    expect(rowJson.map((r) => JSON.parse(r.row_json))).toEqual(JSON.parse(JSON.stringify(bundlePayloadOf(f).report.rows)));

    const [rep] = await svc.postureSummary(patientId);
    expect(rep.verification).toBe('signed_bundle_verified');
    expect(rep.verificationLabel).toMatch(/^Verified/);
    const shoulder = rep.measurements.find((m: any) => m.metricKey === 'shoulder_height_difference');
    expect(shoulder.text).toBe('Shoulder height difference: 1.2 ± 0.8 cm (proxy).');
    expect(shoulder.limitation).toMatch(/proxy.*not validated/i);
    expect(shoulder.positionNote).toMatch(/DRAFT reference/);
    expect(rep.measurements.find((m: any) => m.metricKey === 'head_forward_offset')).toBeUndefined();   // withheld by the clinician → not present at all
    expect(rep.notMeasurable[0].metricKey).toBe('spinal_curvature');
    expect(rep.symptomNotice).toMatch(/cannot resume/);
    expect(JSON.stringify(rep)).not.toMatch(/\bnormal\b|abnormal|diagnos(is|ed)|healthy/i);
  });

  it('configured-upstream import: verified end to end; wrong tokens and mismatches are refused', async () => {
    current = syntheticPosture({ session: 'session-synthetic-002' });
    const base = { patientId, userId: 'u', sessionId: 'session-synthetic-002', reportAccessToken: 'report-token', clinicianToken: 'clin-token' };
    await expect(svc.importFromUpstream({ ...base, reportAccessToken: 'nope' })).rejects.toMatchObject({ code: 'upstream_unauthorized' });
    await expect(svc.importFromUpstream({ ...base, sessionId: '../etc' })).rejects.toMatchObject({ code: 'upstream_invalid_id' });
    const out = await svc.importFromUpstream(base);
    expect(out.verification).toBe('upstream_verified');
    const [first] = await svc.postureSummary(patientId);
    expect(first.verificationLabel).toMatch(/configured PosturePulse upstream/);
    expect(first.symptomReportsRetrieved).toBe(false);          // upstream path does not fetch symptom reports; stated honestly

    // Upstream serves a report whose hash doesn't match → refused.
    current = syntheticPosture({ session: 'session-synthetic-003' });
    current.report.rows[0].estimate!.value = 99; // not re-sealed
    await expect(svc.importFromUpstream({ ...base, sessionId: 'session-synthetic-003' })).rejects.toMatchObject({ code: 'content_hash_mismatch' });
  });

  it('unverified payloads are stored labelled and excluded from the released clinical record', async () => {
    const f = syntheticPosture({ session: 'session-synthetic-004' });
    f.report.reportId = 'report-unverified-004';
    sealReport(f.report);
    const out = await svc.importUnverifiedPayload({ patientId, userId: 'u', ...f });
    expect(out.verification).toBe('unverified_payload');
    const verifiedOnly = await svc.postureSummary(patientId);
    expect(verifiedOnly.some((r: any) => r.verification === 'unverified_payload')).toBe(false);
    const all = await svc.postureSummary(patientId, { includeUnverified: true });
    const u = all.find((r: any) => r.verification === 'unverified_payload');
    expect(u.verificationLabel).toMatch(/^UNVERIFIED payload/);
    expect(u.verificationLabel).toMatch(/NOT verified/);
  });
});
