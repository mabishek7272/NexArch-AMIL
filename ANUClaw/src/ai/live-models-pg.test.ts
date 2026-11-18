/**
 * LIVE provider checks with SYNTHETIC data only. Opt-in: requires BOTH
 *   ANUCLAW_LIVE_MODEL_TESTS=1  and  ANUCLAW_TEST_PG_URL (disposable server).
 * Uses the server-side OpenRouter key via src/config (never printed).
 * Bounded: ≈ 10 provider calls total.
 */
import * as crypto from 'crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const LIVE = process.env.ANUCLAW_LIVE_MODEL_TESTS === '1' && !!process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!LIVE)('live model adapters (synthetic data)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const u = new URL(process.env.ANUCLAW_TEST_PG_URL!);
    admin = new Client({ connectionString: process.env.ANUCLAW_TEST_PG_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName });
    vi.resetModules();
    await (await import('../db/connection')).ensureDbReady();
    q = (await import('../db')).db.query as any;
    for (const [k, role] of [['clin', 'clinician'], ['op', 'operator']]) {
      ids[k] = crypto.randomUUID();
      await q(`INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1,$2,$3,'x',0)`, [ids[k], `${k}@clinic-synthetic.org`, role]);
    }
    await q(`INSERT INTO clinician_credentials (user_id, license_number, jurisdiction, licensing_body, verification_note, status, provisioned_by, provisioned_at) VALUES ($1,'SYN-1','Synthetic','Synthetic Board','fixture','active',$2,0)`, [ids.clin, ids.op]);
  }, 60_000);

  afterAll(async () => {
    try { (await import('../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    }
  });

  it('gemini-3.8-flash vision OCR transcribes a synthetic rendered page; parser recovers ground truth', async () => {
    const { renderPdfPages } = await import('../documents/ocr');
    const { buildTestPdf } = await import('../documents/test-pdf');
    const { geminiVisionOcrEngine } = await import('./adapters');
    const { parseLabLines } = await import('../documents/lab-parser');
    const png = (await renderPdfPages(buildTestPdf([['SYNTHETIC TEST PAGE', 'Hemoglobin 16.4 g/dL 12.0-15.5', 'Potassium <0.5 mmol/L 3.5-5.1']]), [1], 2)).get(1)!;
    const r = await geminiVisionOcrEngine({ syntheticTestData: true }).recognize(png, 'page-1.png');
    expect(r.status).toBe('ok');
    const cands = parseLabLines(r.lines.map((l) => l.text).join('\n'), 1, 'ocr', r.meanConfidence);
    const hb = cands.find((c) => c.analyte === 'Hemoglobin');
    expect(hb).toMatchObject({ valueRaw: '16.4', unit: 'g/dL', refLow: 12, refHigh: 15.5 });
    expect(hb!.flags).toEqual(expect.arrayContaining(['ocr_source', 'ocr_low_confidence'])); // no calibrated confidence → confirmation required
    expect(cands.find((c) => c.analyte === 'Potassium')?.valueRaw).toBe('<0.5');
  }, 90_000);

  it('gemini-embedding-2 retrieval: authorization before candidates, scoping, no-evidence, citation fidelity', async () => {
    const corpus = await import('./reference-corpus');
    const meta = (title: string) => ({ title, publisher: 'Synthetic Test Publisher', sourceUrl: 'https://example.invalid/synthetic', license: 'synthetic test text', version: '1', scope: 'test only' });
    const a = await corpus.addReferenceDocument({ tenantId: null, meta: meta('Units reference'), userId: ids.op, sections: [
      { anchor: 'sodium', text: 'Synthetic reference: serum sodium is commonly reported in mmol/L; one laboratory prints 135-145 mmol/L.' },
      { anchor: 'hemoglobin', text: 'Synthetic reference: hemoglobin is commonly reported in g/dL.' },
    ] });
    const draft = await corpus.addReferenceDocument({ tenantId: null, meta: meta('Draft doc'), userId: ids.op, sections: [{ anchor: 'x', text: 'Synthetic draft: sodium units draft text.' }] });
    const other = await corpus.addReferenceDocument({ tenantId: 'tenant-b', meta: meta('Tenant B doc'), userId: ids.op, sections: [{ anchor: 'x', text: 'Synthetic tenant B: sodium is reported in mmol/L.' }] });

    await expect(corpus.approveReferenceDocument({ documentId: a.id, approverId: ids.op })).rejects.toMatchObject({ code: 'clinician_required' });
    await corpus.approveReferenceDocument({ documentId: a.id, approverId: ids.clin });
    await corpus.approveReferenceDocument({ documentId: other.id, approverId: ids.clin });
    expect((await corpus.retrieveReferences({ tenantId: 'tenant-a', query: 'sodium units' })).status).toBe('no_evidence'); // nothing indexed yet

    const idx = await corpus.indexReferenceDocument(a.id);
    expect(idx.dims).toBe(3072);
    await corpus.indexReferenceDocument(draft.id);
    await corpus.indexReferenceDocument(other.id);

    const res = await corpus.retrieveReferences({ tenantId: 'tenant-a', query: 'What unit is sodium reported in?', k: 3, minScore: 0.3 });
    expect(res.status).toBe('ok');
    expect(res.candidatesConsidered).toBe(2); // draft and tenant-B chunks never became candidates
    expect(res.results.every((r) => r.documentId === a.id)).toBe(true);
    expect(res.results[0].anchor).toBe('sodium');

    const top = res.results[0];
    expect(corpus.verifyCitations([{ text: 'One laboratory prints 135-145 mmol/L.', chunkIds: [top.chunkId] }], res.results)).toEqual([]);
    expect(corpus.verifyCitations([{ text: 'The range is 130-150 mmol/L.', chunkIds: [top.chunkId] }], res.results).length).toBeGreaterThan(0);
    expect(corpus.verifyCitations([{ text: 'x', chunkIds: ['invented-id'] }], res.results)[0]).toMatch(/not retrieved/);
  }, 120_000);

  it('Decision 1 → Gemma review consumes a verified stored engine run and validates output', async () => {
    const pid = crypto.randomUUID();
    await q(`INSERT INTO patients (id, uid, name, created_at, updated_at) VALUES ($1,$2,'Synthetic',0,0)`, [pid, `S-${pid}`]);
    const wf = await import('../documents/workflow');
    const { buildTestPdf } = await import('../documents/test-pdf');
    const ing = await wf.ingestDocument({ patientId: pid, userId: ids.op, buffer: buildTestPdf([['Hemoglobin 16.4 g/dL 12.0-15.5', 'Sodium 140 mmol/L 135-145']]), purpose: 'synthetic live test' });
    const rev = await wf.documentReview(ing.documentId);
    for (const c of rev.candidates) await wf.decideCandidate({ candidateId: c.id, userId: ids.op, action: 'confirm' });
    const snap = await wf.createSnapshot({ documentId: ing.documentId, userId: ids.op });
    const run = await wf.runSnapshotRules({ snapshotId: snap.snapshotId, userId: ids.op });
    const { reviewEngineRun } = await import('./engine-review-service');
    const out = await reviewEngineRun({ snapshotId: snap.snapshotId, engineRunId: run.engineRunId, userId: ids.op });
    // Either outcome is acceptable evidence; a "completed" review must have passed fidelity checks.
    expect(['completed', 'failed_validation', 'review_malformed']).toContain(out.status);
    expect(out.models.decision).toMatch(/^google\/gemini-decision-1/);
    expect(out.models.review).toBe('google/gemma-4-26b-a4b-it');
    if (out.status === 'completed') { expect(out.problems).toEqual([]); expect(out.review!.defers_to_block).toBe(false); }
    const stored = await q('SELECT status, engine_output_sha256 FROM model_reviews WHERE id = $1', [out.reviewId]);
    expect(stored[0]).toEqual({ status: out.status, engine_output_sha256: run.outputSha256 });
    // Reviewing against a run from another snapshot is refused before any model call.
    await expect(reviewEngineRun({ snapshotId: snap.snapshotId, engineRunId: 'nope', userId: ids.op })).rejects.toMatchObject({ status: 404 });
    console.log('LIVE review status:', out.status, out.problems.slice(0, 5));
  }, 180_000);
});
