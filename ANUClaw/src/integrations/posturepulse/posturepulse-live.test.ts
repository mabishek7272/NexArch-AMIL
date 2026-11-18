/**
 * LIVE integration against the REAL PosturePulse NestJS backend (opt-in, disposable resources only).
 *
 * This is NOT a stand-in: it talks over HTTP to the actual `services/backend-api` process (Prisma + real PostgreSQL),
 * which in turn used the actual ml-service. TWO separately labelled setups use this file (ANUCLAW_POSTUREPULSE_LIVE_PIPELINE):
 *   - unset / 'seeded_metrics'      : the metric results behind the report were SEEDED into the disposable database
 *                                     (backend/report/sign-off/hash path only; NOT pose-pipeline evidence).
 *   - 'real_pose_model_on_synthetic_video' : produced by scripts/posturepulse-e2e/run.sh — a drawn mannequin video went through
 *                                     upload -> PyAV decode -> real MediaPipe pose model -> quality gate -> metrics -> report.
 *                                     Technical operation only; says nothing about accuracy on real people.
 *
 * Enable with process-only variables (see docs/RUNBOOK-local.md "Live PosturePulse run"):
 *   ANUCLAW_TEST_PG_URL, ANUCLAW_POSTUREPULSE_LIVE_URL (loopback), _SESSION, _REPORT_TOKEN, _CLINICIAN_TOKEN, _SUBJECT, _CONSENT
 */
import * as crypto from 'crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const E = process.env;
const LIVE = Boolean(E.ANUCLAW_TEST_PG_URL && E.ANUCLAW_POSTUREPULSE_LIVE_URL && E.ANUCLAW_POSTUREPULSE_LIVE_SESSION && E.ANUCLAW_POSTUREPULSE_LIVE_REPORT_TOKEN && E.ANUCLAW_POSTUREPULSE_LIVE_CLINICIAN_TOKEN && E.ANUCLAW_POSTUREPULSE_LIVE_SUBJECT && E.ANUCLAW_POSTUREPULSE_LIVE_CONSENT);
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!LIVE)('PosturePulse — REAL backend (live, synthetic data)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let svc: typeof import('./service'); let up: typeof import('./upstream'); let patientId: string;

  beforeAll(async () => {
    const u = new URL(E.ANUCLAW_TEST_PG_URL!);
    admin = new Client({ connectionString: E.ANUCLAW_TEST_PG_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName, ANUCLAW_POSTUREPULSE_URL: E.ANUCLAW_POSTUREPULSE_LIVE_URL });
    vi.resetModules();
    await (await import('../../db/connection')).ensureDbReady();
    const { db } = await import('../../db');
    patientId = crypto.randomUUID();
    await db.query(`INSERT INTO patients (id, uid, name, created_at, updated_at) VALUES ($1,$2,'Synthetic',0,0)`, [patientId, `S-${patientId}`]);
    svc = await import('./service'); up = await import('./upstream');
  }, 60_000);
  afterAll(async () => {
    try { (await import('../../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const args = () => ({ sessionId: E.ANUCLAW_POSTUREPULSE_LIVE_SESSION!, reportAccessToken: E.ANUCLAW_POSTUREPULSE_LIVE_REPORT_TOKEN!, clinicianToken: E.ANUCLAW_POSTUREPULSE_LIVE_CLINICIAN_TOKEN! });

  it('the real backend\'s released report is fetched, its content hash verified with the upstream canonicalisation, and its schemas validate', async () => {
    const f = await up.fetchFromTrustedUpstream(args());
    expect(f.ok).toBe(true); if (!f.ok) return;
    expect(f.value.report.status).toBe('released');
    // When a clinician withdrew a row the subject view omits it, so the hash is verified on the full signed body (clinician route).
    const signed = f.value.fullReport ?? f.value.report;
    if (f.value.fullReport) expect(up.patientViewMatchesFull(f.value.report, f.value.fullReport)).toBe(true);
    expect(up.bindingViolations(f.value.consentRecord, f.value.session, signed)).toEqual([]);
    expect(up.reportContentSha256(signed)).toBe(signed.signOff.contentSha256);                       // OUR canonicalisation == the real backend's hash
    if (E.ANUCLAW_POSTUREPULSE_LIVE_EXPECT_WITHDRAWN === '1') {
      expect(f.value.fullReport).toBeTruthy();                                                       // the withdrawn-row path was really exercised
      expect(signed.rows.some((r: any) => r.excluded)).toBe(true);
      expect(f.value.report.rows.some((r: any) => r.excluded)).toBe(false);
    }
    expect(up.timestampViolations(f.value.consentRecord, f.value.session, f.value.report, up.timeRules())).toEqual([]);
  });

  it.skipIf(E.ANUCLAW_POSTUREPULSE_LIVE_PIPELINE !== 'real_pose_model_on_synthetic_video')('pipeline-produced report: rows come from the pose model, with provenance and uncertainty, and none is seeded', async () => {
    const f = await up.fetchFromTrustedUpstream(args());
    if (!f.ok) throw new Error('fetch failed');
    const rows: any[] = f.value.report.rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.method).toBe('mediapipe_2d_image_plane');
      expect(r.measuredBy?.modelVersion).toMatch(/^mediapipe-pose-(full|lite)\//);   // produced by the real pose model, per the row's own provenance                 // the report's own record of the measurement method
      expect(r.estimate === null || (typeof r.estimate.value === 'number' && r.estimate.uncertainty > 0)).toBe(true);   // never a value without uncertainty
    }
    expect(JSON.stringify(f.value.report)).not.toMatch(/SYNTHETIC-TEST-NOT-A-MODEL/);
    expect(rows.some((r) => r.estimate)).toBe(true);                     // the pose model actually measured something
  });

  it('import requires an explicit subject link; with it the real report is stored as upstream_verified', async () => {
    await expect(svc.importFromUpstream({ patientId, userId: 'u', ...args() })).rejects.toMatchObject({ code: 'no_subject_link' });
    await svc.linkSubject({ patientId, subjectPseudoId: E.ANUCLAW_POSTUREPULSE_LIVE_SUBJECT!, consentRecordId: E.ANUCLAW_POSTUREPULSE_LIVE_CONSENT!, purpose: 'live integration test (synthetic)', userId: 'admin' });
    const r: any = await svc.importFromUpstream({ patientId, userId: 'u', ...args() });
    expect(r.verification).toBe('upstream_verified');
    if (E.ANUCLAW_POSTUREPULSE_LIVE_EXPECT_WITHDRAWN === '1') {
      const { db } = await import('../../db');
      expect((await db.query(`SELECT metric_key FROM posture_measurements WHERE metric_key = 'static.hip_line_tilt'`)).length).toBe(0);   // withdrawn row is not imported
    }
    const sum: any = await svc.postureSummary(patientId);
    expect(JSON.stringify(sum)).toMatch(/Head lateral tilt/);
    expect(JSON.stringify(sum)).toMatch(/not diagnoses or health scores/);     // our own disclaimer travels with the data
    expect(JSON.stringify(sum).replace(/not diagnoses or health scores/g, '')).not.toMatch(/diagnos/i);   // and the real report adds no diagnostic wording
  });

  // Signed-export path: only runs against a backend that has the (proposed) signed-export route. Kept separate from the verified-upstream path.
  it.skipIf(!E.ANUCLAW_POSTUREPULSE_LIVE_SIGNED_SECRET)('signed bundle from the backend: verified offline with the shared secret and imported as signed_bundle_verified; tampering and wrong secrets are refused', async () => {
    const secret = E.ANUCLAW_POSTUREPULSE_LIVE_SIGNED_SECRET!;
    // the exporting clinician needs an explicit session grant (operator action); signing the report is not enough
    require('child_process').spawnSync('npx', ['ts-node', 'scripts/grant-session.ts', 'synth-clinician', E.ANUCLAW_POSTUREPULSE_LIVE_SESSION!, '--by', 'live-test-operator'], { cwd: E.ANUCLAW_POSTUREPULSE_LIVE_BACKEND_DIR, encoding: 'utf8', env: { ...process.env, DATABASE_URL: E.ANUCLAW_POSTUREPULSE_LIVE_DATABASE_URL! } });
    const res = await fetch(`${E.ANUCLAW_POSTUREPULSE_LIVE_URL}/sessions/${E.ANUCLAW_POSTUREPULSE_LIVE_SESSION}/signed-export`, { headers: { authorization: `Bearer ${E.ANUCLAW_POSTUREPULSE_LIVE_CLINICIAN_TOKEN}` } });
    expect(res.status).toBe(200);
    const bundle: any = await res.json();
    expect(up.verifyBundle(bundle, secret).ok).toBe(true);
    // Contract: the bundle is the subject-AUTHORISED view. A withheld row, its metric and its free-text reason must not be in it.
    const text = JSON.stringify(bundle);
    expect(bundle.payload).toMatchObject({ signatureScheme: 'hmac-sha256/shared-secret', keyId: 'v1', issuer: 'posturepulse-backend-api' });
    expect(bundle.payload.bundleId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bundle.payload.report.rows.some((r: any) => r.excluded)).toBe(false);
    if (E.ANUCLAW_POSTUREPULSE_LIVE_EXPECT_WITHDRAWN === '1') {
      expect(bundle.payload.view).toMatchObject({ kind: 'subject_authorized', rowsWithheld: 1 });
      expect(bundle.payload.view.viewSha256).toBe(up.viewSha256(bundle.payload.report));   // independently recomputed here
      expect(text).not.toContain('synthetic exclusion test');           // the clinician's withdrawal reason
      expect(text).not.toContain('static.hip_line_tilt');               // the withheld metric
    } else expect(bundle.payload.view.rowsWithheld).toBe(0);
    expect(up.verifyBundle(bundle, 'w'.repeat(40))).toEqual({ ok: false, reason: 'bad_signature' });
    const tampered = JSON.parse(JSON.stringify(bundle)); tampered.payload.report.rows[0].estimate = { value: 0, uncertainty: 0.1 };
    expect(up.verifyBundle(tampered, secret)).toEqual({ ok: false, reason: 'bad_signature' });
    const r: any = await svc.importSignedBundle({ patientId, userId: 'u', bundle }, { ANUCLAW_POSTUREPULSE_IMPORT_KEYS: JSON.stringify({ v1: secret }) });   // keyring path
    expect(r.verification).toBe('signed_bundle_verified');
    const { db } = await import('../../db');
    const rows = await db.query<any>(`SELECT verification, upstream_origin FROM posture_reports WHERE patient_id = $1 ORDER BY verification`, [patientId]);
    expect(rows.map((x) => x.verification)).toEqual(expect.arrayContaining(['signed_bundle_verified']));
    // the unauthenticated/subject route does not serve bundles
    expect((await fetch(`${E.ANUCLAW_POSTUREPULSE_LIVE_URL}/sessions/${E.ANUCLAW_POSTUREPULSE_LIVE_SESSION}/signed-export`, { headers: { authorization: `Bearer ${E.ANUCLAW_POSTUREPULSE_LIVE_REPORT_TOKEN}` } })).status).toBeGreaterThanOrEqual(401);
    expect((await fetch(`${E.ANUCLAW_POSTUREPULSE_LIVE_URL}/sessions/${E.ANUCLAW_POSTUREPULSE_LIVE_SESSION}/signed-export`)).status).toBe(401);
  });

  // Authorisation for the specific session (scratch backend with the proposed access model).
  it.skipIf(!E.ANUCLAW_POSTUREPULSE_LIVE_SIGNED_SECRET || !E.ANUCLAW_POSTUREPULSE_LIVE_CLINICIAN_B_TOKEN)('signed export is authorised PER SESSION by explicit grant only: SIGNING the report confers nothing; a grantee succeeds; an ungranted clinician and a revoked grantee are refused (403); no token → 401', async () => {
    const url = `${E.ANUCLAW_POSTUREPULSE_LIVE_URL}/sessions/${E.ANUCLAW_POSTUREPULSE_LIVE_SESSION}/signed-export`;
    const get = (tok?: string) => fetch(url, { headers: tok ? { authorization: `Bearer ${tok}` } : {} });
    const grant = (...a: string[]) => require('child_process').spawnSync('npx', ['ts-node', 'scripts/grant-session.ts', ...a], { cwd: E.ANUCLAW_POSTUREPULSE_LIVE_BACKEND_DIR, encoding: 'utf8', env: { ...process.env, DATABASE_URL: E.ANUCLAW_POSTUREPULSE_LIVE_DATABASE_URL! } });
    grant('synth-clinician', E.ANUCLAW_POSTUREPULSE_LIVE_SESSION!, '--revoke', '--by', 'live-test-operator');   // undo the grant the previous test needed
    // A signed this session's report through the role-only sign-off route. That must NOT authorise an export.
    expect((await get(E.ANUCLAW_POSTUREPULSE_LIVE_CLINICIAN_TOKEN)).status).toBe(403);
    expect(grant('synth-clinician', E.ANUCLAW_POSTUREPULSE_LIVE_SESSION!, '--by', 'live-test-operator').status).toBe(0);
    expect((await get(E.ANUCLAW_POSTUREPULSE_LIVE_CLINICIAN_TOKEN)).status).toBe(200);                  // A, now explicitly granted
    const denied = await get(E.ANUCLAW_POSTUREPULSE_LIVE_CLINICIAN_B_TOKEN);
    expect(denied.status).toBe(403); expect(await denied.text()).not.toMatch(/payload|signature|rows/);   // B: clinician role, no grant → nothing
    expect((await get()).status).toBe(401);
    expect(grant('synth-clinician-b', E.ANUCLAW_POSTUREPULSE_LIVE_SESSION!, '--by', 'live-test-operator').status).toBe(0);
    expect((await get(E.ANUCLAW_POSTUREPULSE_LIVE_CLINICIAN_B_TOKEN)).status).toBe(200);               // explicit grant
    expect(grant('synth-clinician-b', E.ANUCLAW_POSTUREPULSE_LIVE_SESSION!, '--revoke', '--by', 'live-test-operator').status).toBe(0);
    expect((await get(E.ANUCLAW_POSTUREPULSE_LIVE_CLINICIAN_B_TOKEN)).status).toBe(403);               // revoked
    // a session id that does not exist is refused exactly like an unauthorised one
    const ghost = await fetch(`${E.ANUCLAW_POSTUREPULSE_LIVE_URL}/sessions/00000000-0000-4000-8000-000000000000/signed-export`, { headers: { authorization: `Bearer ${E.ANUCLAW_POSTUREPULSE_LIVE_CLINICIAN_B_TOKEN}` } });
    expect(ghost.status).toBe(403);
  });

  it('wrong credentials against the real backend are refused, not imported', async () => {
    expect(await up.fetchFromTrustedUpstream({ ...args(), reportAccessToken: 'not-a-token' })).toEqual({ ok: false, reason: 'unauthorized' });
    expect(await up.fetchFromTrustedUpstream({ ...args(), clinicianToken: 'not-a-token' })).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('an unknown session on the real backend is not found / not released', async () => {
    const r = await up.fetchFromTrustedUpstream({ ...args(), sessionId: crypto.randomUUID() });
    expect(r.ok).toBe(false);
  });
});
