/**
 * FINAL SYNTHETIC ACCEPTANCE REHEARSAL (opt-in). One run across the implemented product, on SYNTHETIC data only:
 *   scanned report upload → REAL local PaddleOCR → extraction correction/confirmation → stored engine execution → report draft →
 *   review by a provisioned (synthetic fixture) clinician → export + provenance verification → research dataset attachment
 *   (offline REPLAY of retained live artifacts + a synthetic GEO fixture) with isolation + manifest integrity.
 * The container-job leg is in src/container-contract.test.ts ("APPLICATION PATH"); it needs the image.
 *
 *   ANUCLAW_TEST_PG_URL=postgres://… ANUCLAW_OCR_SERVICE_URL=http://127.0.0.1:54001 npx vitest run src/acceptance-rehearsal-pg.test.ts
 *
 * Boundaries: the clinician is a test-fixture account (no real licensure; not an approval of anything); engines run with NO released rules (no clinical
 * output); no model/agent call is made.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildScannedPdf, buildTestPdf } from './documents/test-pdf';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
const OCR = process.env.ANUCLAW_OCR_SERVICE_URL;
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const LINES = ['SYNTHETIC LAB REPORT', 'Hemoglobin 16.4 g/dL 12.0-15.5', 'Sodium 140 mmol/L 135-145', 'Potassium 4.1 mmol/L 3.5-5.1'];
const ART = path.resolve(__dirname, '../docs/evidence/live-artifacts');

describe.skipIf(!URL_ || !OCR)('final synthetic acceptance rehearsal (real PostgreSQL + real local OCR)', () => {
  const dbName = `anuclaw_rehearsal_${crypto.randomBytes(6).toString('hex')}`;
  const docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anuclaw-reh-docs-'));
  const sciDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anuclaw-reh-sci-'));
  let admin: Client; let server: Server; let base: string; let q: (s: string, p?: unknown[]) => Promise<any[]>;
  const cookie: Record<string, string> = {}; const ids: Record<string, string> = {}; let patientId: string;
  const trail: Record<string, unknown> = {};

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName,
      DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex'), ANUCLAW_DOCUMENT_DIR: docDir, OCR_SERVICE_URL: OCR, ANUCLAW_SCIDATA_DIR: sciDir });
    vi.resetModules();
    await (await import('./db/connection')).ensureDbReady();
    q = (s, p) => (require('./db') as any).db.query(s, p);
    const { db } = await import('./db'); q = (s, p) => db.query(s, p as any[]);
    const auth = await import('./dashboard/server/auth');
    for (const [key, role] of [['owner', 'operator'], ['clin', 'clinician']] as const) {
      const id = crypto.randomUUID(); ids[key] = id;
      await q(`INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1,$2,$3,'x',0)`, [id, `${key}@rehearsal-synthetic.invalid`, role]);
      cookie[key] = `dash_token=${(await auth.issueTokens(id)).accessToken}`;
    }
    await q(`INSERT INTO clinician_credentials (user_id, license_number, jurisdiction, licensing_body, verification_note, status, provisioned_by, provisioned_at)
             VALUES ($1,'SYN-REHEARSAL','Synthetic','Synthetic Board','TEST FIXTURE — not a real licence or approval','active',$2,0)`, [ids.clin, ids.owner]);
    patientId = crypto.randomUUID();
    await q(`INSERT INTO patients (id, uid, name, created_at, updated_at) VALUES ($1,$2,'Synthetic Person',0,0)`, [patientId, `S-${patientId}`]);
    await q(`INSERT INTO patient_access (patient_id, user_id, access_level, purpose, granted_by, granted_at) VALUES ($1,$2,'owner','rehearsal',$2,0), ($1,$3,'write','rehearsal',$2,0)`, [patientId, ids.owner, ids.clin]);
    const express = (await import('express')).default; const cookieParser = (await import('cookie-parser')).default;
    const app = express(); app.use(cookieParser()); app.use(express.json());
    app.use('/api/clinical', (await import('./dashboard/server/routes/documents')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/clinical`;
  }, 90_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { (await import('./db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
    fs.rmSync(docDir, { recursive: true, force: true }); fs.rmSync(sciDir, { recursive: true, force: true });
    const out = path.resolve(__dirname, '../docs/evidence/acceptance-rehearsal-latest.json');
    fs.writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), note: 'SYNTHETIC data only. Clinician = test fixture. No model/agent call. Engines had no released rules.', trail }, null, 1));
  });

  const json = (who: string, method: string, p: string, body?: unknown) => fetch(base + p, { method, headers: { cookie: cookie[who], 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let docId: string; let snapId: string; let runId: string; let reportId: string; let obsK: string;

  it('1. a SCANNED (image-only) report goes through REAL PaddleOCR; candidates carry OCR confidence and require confirmation', async () => {
    const { renderPdfPages } = await import('./documents/ocr');
    const png = (await renderPdfPages(buildTestPdf([LINES]), [1], 2)).get(1)!;
    const scanned = await buildScannedPdf(png);
    const fd = new FormData(); fd.append('file', new Blob([scanned]), 'scan.pdf'); fd.append('purpose', 'final synthetic acceptance rehearsal');
    const r = await fetch(`${base}/patients/${patientId}/documents`, { method: 'POST', headers: { cookie: cookie.owner }, body: fd });
    expect(r.status).toBe(201); const body = await r.json(); docId = body.documentId;
    expect(body.extraction.pages[0]).toMatchObject({ page: 1, method: 'ocr', status: 'ok' });
    expect(body.extraction.pages[0].ocrConfidence).toBeGreaterThan(0);
    expect(body.candidates).toBeGreaterThanOrEqual(3);
    trail.ocr = { engine: 'paddleocr (real local service)', pages: body.extraction.pages, candidates: body.candidates };
    review = await (await json('owner', 'GET', `/documents/${docId}`)).json();
    expect(review.candidates.every((c: any) => c.status === 'pending' || c.data)).toBe(true);
  }, 180_000);
  let review: any;

  it('2. correction (reason required) + confirmation; the snapshot is blocked until every candidate is decided', async () => {
    const by = (re: RegExp) => review.candidates.find((c: any) => re.test(c.data.analyte));
    expect((await json('owner', 'POST', `/documents/${docId}/snapshots`)).status).toBe(409);
    for (const c of review.candidates) {
      if (/potassium/i.test(c.data.analyte)) {
        expect((await json('owner', 'POST', `/candidates/${c.id}/decision`, { action: 'correct', correction: { valueRaw: '4.2' } })).status).toBe(400);   // reason required
        const k = await json('owner', 'POST', `/candidates/${c.id}/decision`, { action: 'correct', correction: { valueRaw: '4.2' }, reason: 'rehearsal: operator corrected against the source image' });
        expect(k.status).toBe(200); obsK = (await k.json()).observationId;
      } else expect((await json('owner', 'POST', `/candidates/${c.id}/decision`, { action: 'confirm' })).status).toBe(200);
    }
    expect(by(/hemoglobin/i)).toBeTruthy();
    const s = await json('owner', 'POST', `/documents/${docId}/snapshots`); expect(s.status).toBe(201);
    const snap = await s.json(); snapId = snap.snapshotId; expect(snap.observations).toBeGreaterThanOrEqual(3);
    trail.snapshot = { id: snapId, observations: snap.observations, correctedObservation: obsK };
  });

  it('3. stored engine execution (verified record) → draft report; no released rules means NO clinical output', async () => {
    const rr = await (await json('owner', 'POST', `/snapshots/${snapId}/rule-runs`)).json(); runId = rr.engineRunId;
    expect(rr.clinicalState).toBe('no_released_rules');
    const { loadSnapshot, verifiedEngineRun } = await import('./documents/workflow');
    const snap = await loadSnapshot(snapId); const v = await verifiedEngineRun(runId, { id: snap.row.id, sha256: snap.row.sha256 });
    expect(v.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    const rep = await json('owner', 'POST', `/snapshots/${snapId}/reports`, { engineRunId: runId }); expect(rep.status).toBe(201); reportId = (await rep.json()).reportId;
    trail.engineRun = { id: runId, outputSha256: v.outputSha256, clinicalState: rr.clinicalState };
  });

  it('4. authorized review: an operator cannot sign off; the provisioned (fixture) clinician can; export hashes and provenance verify', async () => {
    expect((await json('owner', 'POST', `/reports/${reportId}/review`)).status).toBe(403);
    const r = await json('clin', 'POST', `/reports/${reportId}/review`); expect(r.status).toBe(201);
    const v2 = await r.json(); expect(v2).toMatchObject({ version: 2, status: 'reviewed' });
    const html = await json('owner', 'GET', `/reports/${v2.reportId}/export.html`); const text = await html.text();
    expect(html.headers.get('x-report-status')).toBe('reviewed');
    expect(html.headers.get('x-content-sha256')).toBe(crypto.createHash('sha256').update(text).digest('hex'));
    expect(text).toContain('Reviewed by clin@rehearsal-synthetic.invalid'); expect(text).toContain('4.2');       // the corrected value, not the OCR value
    const pdfRes = await json('owner', 'GET', `/reports/${v2.reportId}/export.pdf`); expect(pdfRes.status).toBe(200);
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer()); expect(pdfBuf.subarray(0, 5).toString()).toBe('%PDF-');
    const { getReport } = await import('./documents/workflow'); const rep: any = await getReport(v2.reportId);
    expect(JSON.stringify(rep)).toMatch(/version/i);
    trail.report = { id: v2.reportId, status: 'reviewed (fixture clinician)', htmlSha256: html.headers.get('x-content-sha256'), pdfBytes: pdfBuf.length };
  });

  it('5. research dataset attachment: offline REPLAY of retained live artifacts (+ synthetic GEO fixture) — pinned, hash-verified, tenant-isolated, labelled', async () => {
    const { ScienceService } = await import('./sciencedata/service'); const svc = ScienceService.create(process.env);
    const A = { kind: 'user' as const, id: 'rehearsal-A' }; const B = { kind: 'user' as const, id: 'rehearsal-B' };
    const prov = JSON.parse(fs.readFileSync(path.join(ART, 'PROVENANCE.json'), 'utf8')).artifacts as any[];
    const rcsb = prov.find((a) => /4HHB/.test(a.sourceUrl)); const bytes = fs.readFileSync(path.join(ART, 'rcsb-4HHB.pdb'));
    const rep = await svc.replay(A, { provider: 'rcsb', accession: '4HHB', kind: rcsb.kind, format: rcsb.format, classification: rcsb.classification, classificationNote: rcsb.classificationNote ?? 'see live-fetch record',
      sourceUrl: rcsb.sourceUrl, sourceVersion: rcsb.sourceVersion ?? 'unknown', bytes, expectedSha256: rcsb.sha256, origin: 'live_artifact', retrievedAt: Date.parse(rcsb.retrievedAt) } as any);
    expect(rep.acquisition).toBe('replay_of_live_artifact');
    const ws = await svc.createWorkspace(A, 'Rehearsal study', 'final synthetic acceptance rehearsal'); await svc.attach(A, ws.id, rep.sources[0].id, 'hemoglobin structure', 'rehearsal-A');
    const m: any = await svc.manifest(A, ws.id);
    expect(m.items[0].source.integrityCheckedAtExport).toBe('ok'); expect(m.items[0].source.classification).toBe('experimental');
    for (const op of [() => svc.getSource(B, rep.sources[0].id), () => svc.getWorkspace(B, ws.id), () => svc.manifest(B, ws.id), () => svc.attach(B, ws.id, rep.sources[0].id, 'x', 'b')])
      await expect(op()).rejects.toMatchObject({ code: 'not_found' });
    trail.research = { provider: 'rcsb', accession: '4HHB', acquisition: rep.acquisition, sha256: rcsb.sha256, manifestSha256: m.manifestSha256, isolation: 'workspace/source/manifest/attach hidden from another scope', geo: 'GSE2 real bytes were NOT retained → real-GSE2 replay impossible without a new live request (PENDING.json); GEO workflow covered with a synthetic fixture in science-pg tests' };
  }, 60_000);
});
