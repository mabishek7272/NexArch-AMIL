/**
 * Medical-report workflow service (plan §7, first milestone):
 *
 *   upload → page-level extraction (native/OCR) → candidates → human confirmation
 *   → observations (+ revisions on correction) → immutable hashed snapshot
 *   → rule run (server-owned execution record) → report (SOAP + layman)
 *   → review (new immutable version) → HTML export with provenance.
 *
 * Callers (routes) enforce patient access before calling these functions.
 * Every precondition failure is an explicit WorkflowError; nothing is skipped.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { db, TxClient } from '../db';
import { extractDocument, DocumentExtraction, OcrEngine } from './ocr';
import { parseLabLines, LabCandidate } from './lab-parser';
import { runRules, sha256, ObservationInput, RuleRunOutput } from './rules';
import { buildReport, renderReportHtml, SnapshotObservation, StructuredReport } from './report';
import { renderReportPdf } from './report-pdf';

export class WorkflowError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export const SUPPORTED_MEDIA: Record<string, DocumentExtraction['mediaType']> = {
  'application/pdf': 'application/pdf', 'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'text/plain': 'text/plain',
};

function storageDir(): string {
  return path.resolve(process.env.ANUCLAW_DOCUMENT_DIR ?? './data/documents');
}

/** Detect type from content, not the client-supplied name/MIME. */
export function sniffMediaType(buf: Buffer): DocumentExtraction['mediaType'] | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length && !buf.subarray(0, 4096).includes(0)) return 'text/plain';
  return null;
}

export interface IngestResult {
  documentId: string;
  duplicate: boolean;
  extraction?: { status: DocumentExtraction['status']; error?: string; pages: Array<{ page: number; method: string; status: string; ocrConfidence: number | null }> };
  candidates?: number;
}

export async function ingestDocument(args: {
  patientId: string; userId: string; buffer: Buffer; purpose: string; ocr?: OcrEngine; maxBytes?: number;
}): Promise<IngestResult> {
  const maxBytes = args.maxBytes ?? 25 * 1024 * 1024;
  if (!args.buffer.length) throw new WorkflowError(400, 'empty_file', 'The uploaded file is empty.');
  if (args.buffer.length > maxBytes) throw new WorkflowError(413, 'too_large', 'The uploaded file is too large.');
  const mediaType = sniffMediaType(args.buffer);
  if (!mediaType) throw new WorkflowError(415, 'unsupported_type', 'Only PDF, PNG, JPEG or plain-text documents are supported.');
  if (!args.purpose?.trim()) throw new WorkflowError(400, 'purpose_required', 'A purpose of use is required.');

  const hash = sha256(args.buffer.toString('base64'));
  const existing = await db.queryOne<{ id: string }>('SELECT id FROM documents WHERE patient_id = $1 AND content_sha256 = $2', [args.patientId, hash]);
  if (existing) return { documentId: existing.id, duplicate: true };

  const documentId = crypto.randomUUID();
  const storageKey = `${documentId}.bin`;
  fs.mkdirSync(storageDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(storageDir(), storageKey), args.buffer, { mode: 0o600 });

  // Documents are untrusted input: extraction is pure parsing; nothing in the text is executed or obeyed.
  const extraction = await extractDocument(args.buffer, mediaType, { ocr: args.ocr });
  const candidates: Array<LabCandidate> = extraction.pages
    .filter((p) => p.status === 'ok')
    .flatMap((p) => parseLabLines(p.text, p.page, p.method === 'ocr' ? 'ocr' : 'native_text', p.ocr?.meanConfidence ?? null));

  const now = Date.now();
  const runId = crypto.randomUUID();
  try {
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO documents (id, patient_id, uploaded_by, content_sha256, media_type, byte_size, page_count, storage_key, purpose, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [documentId, args.patientId, args.userId, hash, mediaType, args.buffer.length, extraction.pageCount, storageKey, args.purpose.trim(),
          extraction.status === 'failed' ? 'extraction_failed' : candidates.length ? 'awaiting_confirmation' : 'no_candidates', now],
      );
      await tx.query(`INSERT INTO extraction_runs (id, document_id, parser, ocr_engine, status, error, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [runId, documentId, extraction.parser, args.ocr?.name ?? null, extraction.status, extraction.error ?? null, now]);
      for (const p of extraction.pages) {
        await tx.query(`INSERT INTO extraction_pages (run_id, page, method, status, text, ocr_confidence) VALUES ($1, $2, $3, $4, $5, $6)`,
          [runId, p.page, p.method, p.status, p.text, p.ocr?.meanConfidence ?? null]);
      }
      for (const c of candidates) {
        await tx.query(`INSERT INTO observation_candidates (id, document_id, run_id, data_json, flags_json, status) VALUES ($1, $2, $3, $4, $5, 'pending')`,
          [crypto.randomUUID(), documentId, runId, JSON.stringify(c), JSON.stringify(c.flags)]);
      }
    });
  } catch (err) {
    try { fs.rmSync(path.join(storageDir(), storageKey), { force: true }); } catch { /* ignore */ }
    if ((err as { code?: string }).code === '23505') {
      const dup = await db.queryOne<{ id: string }>('SELECT id FROM documents WHERE patient_id = $1 AND content_sha256 = $2', [args.patientId, hash]);
      if (dup) return { documentId: dup.id, duplicate: true };
    }
    throw err;
  }
  return {
    documentId,
    duplicate: false,
    extraction: { status: extraction.status, error: extraction.error, pages: extraction.pages.map((p) => ({ page: p.page, method: p.method, status: p.status, ocrConfidence: p.ocr?.meanConfidence ?? null })) },
    candidates: candidates.length,
  };
}

export async function getDocumentPatient(documentId: string): Promise<string | null> {
  const r = await db.queryOne<{ patient_id: string }>('SELECT patient_id FROM documents WHERE id = $1', [documentId]);
  return r?.patient_id ?? null;
}

export async function documentReview(documentId: string) {
  const doc = await db.queryOne('SELECT id, patient_id, media_type, page_count, status, purpose, created_at FROM documents WHERE id = $1', [documentId]);
  if (!doc) throw new WorkflowError(404, 'not_found', 'Document not found.');
  const run = await db.queryOne<any>('SELECT * FROM extraction_runs WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1', [documentId]);
  const pages = run ? await db.query('SELECT page, method, status, text, ocr_confidence FROM extraction_pages WHERE run_id = $1 ORDER BY page', [run.id]) : [];
  const candidates = await db.query<any>('SELECT id, data_json, flags_json, status, decided_by, decided_at FROM observation_candidates WHERE document_id = $1 ORDER BY id', [documentId]);
  const observations = await db.query('SELECT * FROM observations WHERE document_id = $1 ORDER BY created_at', [documentId]);
  return {
    document: doc,
    extraction: run ? { id: run.id, parser: run.parser, ocrEngine: run.ocr_engine, status: run.status, error: run.error } : null,
    pages,
    candidates: candidates.map((c) => ({ id: c.id, status: c.status, data: JSON.parse(c.data_json), flags: JSON.parse(c.flags_json), decidedBy: c.decided_by, decidedAt: c.decided_at })),
    observations,
  };
}

export interface CandidateCorrection { analyte?: string; valueRaw?: string; unit?: string | null; refLow?: number | null; refHigh?: number | null }

function parseValueRaw(valueRaw: string): { comparator: string | null; valueNum: number | null } {
  const m = /^(<=|>=|<|>)?\s*(-?\d+(?:\.\d+)?)$/.exec(valueRaw.trim());
  return m ? { comparator: m[1] ?? null, valueNum: Number(m[2]) } : { comparator: null, valueNum: null };
}

export async function decideCandidate(args: {
  candidateId: string; userId: string; action: 'confirm' | 'reject' | 'correct'; correction?: CandidateCorrection; reason?: string;
}): Promise<{ observationId?: string; status: string }> {
  if (args.action === 'correct' && (!args.reason?.trim() || !args.correction)) throw new WorkflowError(400, 'reason_required', 'A correction needs the corrected fields and a reason.');
  return db.transaction(async (tx) => {
    const c = await tx.query<any>(
      `SELECT oc.*, d.patient_id FROM observation_candidates oc JOIN documents d ON d.id = oc.document_id WHERE oc.id = $1 FOR UPDATE OF oc`,
      [args.candidateId],
    );
    const row = c.rows[0];
    if (!row) throw new WorkflowError(404, 'not_found', 'Candidate not found.');
    if (row.status !== 'pending') throw new WorkflowError(409, 'already_decided', 'This candidate has already been decided.');
    const now = Date.now();
    if (args.action === 'reject') {
      await tx.query(`UPDATE observation_candidates SET status = 'rejected', decided_by = $2, decided_at = $3 WHERE id = $1`, [row.id, args.userId, now]);
      await refreshDocumentStatus(tx, row.document_id);
      return { status: 'rejected' };
    }
    const cand: LabCandidate = JSON.parse(row.data_json);
    const corr = args.correction ?? {};
    const valueRaw = (corr.valueRaw ?? cand.valueRaw).trim();
    const parsed = corr.valueRaw !== undefined ? parseValueRaw(valueRaw) : { comparator: cand.comparator, valueNum: cand.valueNum };
    const obs = {
      analyte: (corr.analyte ?? cand.analyte).trim(), valueRaw, comparator: parsed.comparator, valueNum: parsed.valueNum,
      unit: corr.unit !== undefined ? corr.unit : cand.unit,
      refLow: corr.refLow !== undefined ? corr.refLow : cand.refLow,
      refHigh: corr.refHigh !== undefined ? corr.refHigh : cand.refHigh,
    };
    const id = crypto.randomUUID();
    const status = args.action === 'correct' ? 'corrected' : 'confirmed';
    await tx.query(
      `INSERT INTO observations (id, patient_id, document_id, candidate_id, analyte, value_raw, comparator, value_num, unit, ref_low, ref_high, page, method, revision, status, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15,$16,$16)`,
      [id, row.patient_id, row.document_id, row.id, obs.analyte, obs.valueRaw, obs.comparator, obs.valueNum, obs.unit, obs.refLow, obs.refHigh, cand.page, cand.method, status, args.userId, now],
    );
    if (args.action === 'correct') {
      await tx.query(`INSERT INTO observation_revisions (id, observation_id, revision, prior_json, new_json, actor, reason, created_at) VALUES ($1,$2,1,$3,$4,$5,$6,$7)`,
        [crypto.randomUUID(), id, JSON.stringify({ source: 'extraction_candidate', ...cand }), JSON.stringify(obs), args.userId, args.reason!.trim(), now]);
    }
    await tx.query(`UPDATE observation_candidates SET status = $2, decided_by = $3, decided_at = $4 WHERE id = $1`, [row.id, status, args.userId, now]);
    await refreshDocumentStatus(tx, row.document_id);
    return { observationId: id, status };
  });
}

async function refreshDocumentStatus(tx: TxClient, documentId: string): Promise<void> {
  const p = await tx.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM observation_candidates WHERE document_id = $1 AND status = 'pending'`, [documentId]);
  await tx.query(`UPDATE documents SET status = $2 WHERE id = $1 AND status <> 'extraction_failed'`, [documentId, p.rows[0].n > 0 ? 'awaiting_confirmation' : 'confirmed']);
}

/** Correct a confirmed observation: new revision, and everything built on the old value is superseded. */
export async function correctObservation(args: { observationId: string; userId: string; correction: CandidateCorrection; reason: string }) {
  if (!args.reason?.trim()) throw new WorkflowError(400, 'reason_required', 'A reason is required for a correction.');
  return db.transaction(async (tx) => {
    const r = await tx.query<any>('SELECT * FROM observations WHERE id = $1 FOR UPDATE', [args.observationId]);
    const o = r.rows[0];
    if (!o) throw new WorkflowError(404, 'not_found', 'Observation not found.');
    const prior = { analyte: o.analyte, valueRaw: o.value_raw, comparator: o.comparator, valueNum: o.value_num, unit: o.unit, refLow: o.ref_low, refHigh: o.ref_high };
    const valueRaw = args.correction.valueRaw !== undefined ? args.correction.valueRaw.trim() : o.value_raw;
    const parsed = args.correction.valueRaw !== undefined ? parseValueRaw(valueRaw) : { comparator: o.comparator, valueNum: o.value_num };
    const next = {
      analyte: args.correction.analyte?.trim() ?? o.analyte, valueRaw, comparator: parsed.comparator, valueNum: parsed.valueNum,
      unit: args.correction.unit !== undefined ? args.correction.unit : o.unit,
      refLow: args.correction.refLow !== undefined ? args.correction.refLow : o.ref_low,
      refHigh: args.correction.refHigh !== undefined ? args.correction.refHigh : o.ref_high,
    };
    const revision = o.revision + 1;
    const now = Date.now();
    await tx.query(
      `UPDATE observations SET analyte=$2, value_raw=$3, comparator=$4, value_num=$5, unit=$6, ref_low=$7, ref_high=$8, revision=$9, status='corrected', updated_at=$10 WHERE id=$1`,
      [o.id, next.analyte, next.valueRaw, next.comparator, next.valueNum, next.unit, next.refLow, next.refHigh, revision, now],
    );
    await tx.query(`INSERT INTO observation_revisions (id, observation_id, revision, prior_json, new_json, actor, reason, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [crypto.randomUUID(), o.id, revision, JSON.stringify(prior), JSON.stringify(next), args.userId, args.reason.trim(), now]);
    // Invalidate downstream results that used the old value.
    const snaps = await tx.query<{ id: string }>(
      `UPDATE case_snapshots SET superseded_at = $2 WHERE document_id = $1 AND superseded_at IS NULL RETURNING id`, [o.document_id, now]);
    const ids = snaps.rows.map((s) => s.id);
    let reportsSuperseded = 0;
    if (ids.length) {
      const rep = await tx.query(`UPDATE reports SET status = 'superseded' WHERE snapshot_id = ANY($1) AND status <> 'superseded'`, [ids]);
      reportsSuperseded = rep.rowCount;
    }
    return { revision, snapshotsSuperseded: ids.length, reportsSuperseded };
  });
}

export async function createSnapshot(args: { documentId: string; userId: string }) {
  return db.transaction(async (tx) => {
    const d = await tx.query<any>('SELECT id, patient_id, status FROM documents WHERE id = $1 FOR UPDATE', [args.documentId]);
    const doc = d.rows[0];
    if (!doc) throw new WorkflowError(404, 'not_found', 'Document not found.');
    if (doc.status === 'extraction_failed') throw new WorkflowError(409, 'extraction_failed', 'Extraction failed; nothing to snapshot.');
    const pending = await tx.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM observation_candidates WHERE document_id = $1 AND status = 'pending'`, [doc.id]);
    if (pending.rows[0].n > 0) throw new WorkflowError(409, 'confirmation_pending', `${pending.rows[0].n} extracted value(s) still need confirmation.`, { pending: pending.rows[0].n });
    const obs = await tx.query<any>(`SELECT * FROM observations WHERE document_id = $1 AND status IN ('confirmed','corrected') ORDER BY id`, [doc.id]);
    const content = {
      schema: 'case-snapshot-v1', documentId: doc.id, patientId: doc.patient_id,
      observations: obs.rows.map((o): SnapshotObservation => ({
        id: o.id, analyte: o.analyte, valueRaw: o.value_raw, comparator: o.comparator, valueNum: o.value_num, unit: o.unit,
        refLow: o.ref_low, refHigh: o.ref_high, page: o.page, method: o.method, revision: o.revision, status: o.status,
      })),
      missing: { subjective: 'not_provided', examination: 'not_provided' },
    };
    const hash = sha256(content);
    const id = crypto.randomUUID();
    await tx.query(`INSERT INTO case_snapshots (id, patient_id, document_id, content_json, sha256, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, doc.patient_id, doc.id, JSON.stringify(content), hash, args.userId, Date.now()]);
    return { snapshotId: id, sha256: hash, observations: content.observations.length };
  });
}

export async function loadSnapshot(id: string) {
  const s = await db.queryOne<any>('SELECT * FROM case_snapshots WHERE id = $1', [id]);
  if (!s) throw new WorkflowError(404, 'not_found', 'Snapshot not found.');
  const content = JSON.parse(s.content_json);
  if (sha256(content) !== s.sha256) throw new WorkflowError(409, 'snapshot_integrity', 'Snapshot content does not match its hash.');
  return { row: s, content };
}

/** Run released rules on a snapshot and store a server-owned execution record. */
export async function runSnapshotRules(args: { snapshotId: string; userId: string }) {
  const { row, content } = await loadSnapshot(args.snapshotId);
  if (row.superseded_at) throw new WorkflowError(409, 'snapshot_superseded', 'This snapshot was superseded by a correction.');
  const output: RuleRunOutput = runRules(content.observations as ObservationInput[]);
  const id = crypto.randomUUID();
  const outHash = sha256(output);
  await db.query(
    `INSERT INTO engine_runs (id, snapshot_id, snapshot_sha256, engine, engine_version, input_sha256, output_json, output_sha256, status, created_by, created_at)
     VALUES ($1,$2,$3,'rules',$4,$5,$6,$7,'completed',$8,$9)`,
    [id, row.id, row.sha256, output.engineVersion, row.sha256, JSON.stringify(output), outHash, args.userId, Date.now()],
  );
  return { engineRunId: id, outputSha256: outHash, clinicalState: output.clinicalState, findings: output.findings.length };
}

/** Verify an execution record really belongs to this snapshot and is untampered. */
export async function verifiedEngineRun(engineRunId: string, snapshot: { id: string; sha256: string }): Promise<{ output: RuleRunOutput; outputSha256: string }> {
  const r = await db.queryOne<any>('SELECT * FROM engine_runs WHERE id = $1', [engineRunId]);
  if (!r) throw new WorkflowError(404, 'not_found', 'Engine run not found.');
  if (r.snapshot_id !== snapshot.id || r.snapshot_sha256 !== snapshot.sha256 || r.input_sha256 !== snapshot.sha256) {
    throw new WorkflowError(409, 'engine_run_mismatch', 'The engine run was not executed on this snapshot.');
  }
  const output = JSON.parse(r.output_json);
  if (sha256(output) !== r.output_sha256 || r.status !== 'completed') throw new WorkflowError(409, 'engine_run_integrity', 'Engine run output failed integrity verification.');
  return { output, outputSha256: r.output_sha256 };
}

export async function createReport(args: { snapshotId: string; engineRunId: string; userId: string }) {
  const { row, content } = await loadSnapshot(args.snapshotId);
  if (row.superseded_at) throw new WorkflowError(409, 'snapshot_superseded', 'This snapshot was superseded by a correction.');
  const run = await verifiedEngineRun(args.engineRunId, { id: row.id, sha256: row.sha256 });
  const structured = buildReport({
    snapshotId: row.id, snapshotHash: row.sha256, ruleRunId: args.engineRunId, ruleRunOutputHash: run.outputSha256,
    rules: run.output, observations: content.observations, documentLabel: content.documentId, createdAt: new Date().toISOString(),
  });
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO reports (id, patient_id, snapshot_id, engine_run_id, lineage_id, version, status, structured_json, structured_sha256, created_by, created_at)
     VALUES ($1,$2,$3,$4,$1,1,'draft',$5,$6,$7,$8)`,
    [id, row.patient_id, row.id, args.engineRunId, JSON.stringify(structured), sha256(structured), args.userId, Date.now()],
  );
  return { reportId: id, version: 1, status: 'draft' as const };
}

export async function getReport(reportId: string) {
  const r = await db.queryOne<any>('SELECT * FROM reports WHERE id = $1', [reportId]);
  if (!r) throw new WorkflowError(404, 'not_found', 'Report not found.');
  const structured: StructuredReport = JSON.parse(r.structured_json);
  if (sha256(structured) !== r.structured_sha256) throw new WorkflowError(409, 'report_integrity', 'Report content does not match its hash.');
  return { row: r, structured };
}

/** Review creates a NEW immutable version; the reviewed draft is superseded. */
export async function reviewReport(args: { reportId: string; reviewerId: string }) {
  return db.transaction(async (tx) => {
    const r = await tx.query<any>('SELECT * FROM reports WHERE id = $1 FOR UPDATE', [args.reportId]);
    const draft = r.rows[0];
    if (!draft) throw new WorkflowError(404, 'not_found', 'Report not found.');
    if (draft.status !== 'draft') throw new WorkflowError(409, 'not_reviewable', `Only drafts can be reviewed (status: ${draft.status}).`);
    const snap = await tx.query<any>('SELECT superseded_at FROM case_snapshots WHERE id = $1', [draft.snapshot_id]);
    if (snap.rows[0]?.superseded_at) throw new WorkflowError(409, 'snapshot_superseded', 'The underlying data was corrected; create a new report.');
    const structured = JSON.parse(draft.structured_json);
    if (sha256(structured) !== draft.structured_sha256) throw new WorkflowError(409, 'report_integrity', 'Report content does not match its hash.');
    const id = crypto.randomUUID();
    const now = Date.now();
    await tx.query(
      `INSERT INTO reports (id, patient_id, snapshot_id, engine_run_id, lineage_id, version, status, structured_json, structured_sha256, created_by, reviewed_by, reviewed_at, supersedes_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'reviewed',$7,$8,$9,$10,$11,$12,$11)`,
      [id, draft.patient_id, draft.snapshot_id, draft.engine_run_id, draft.lineage_id, draft.version + 1, draft.structured_json, draft.structured_sha256, draft.created_by, args.reviewerId, now, draft.id],
    );
    await tx.query(`UPDATE reports SET status = 'superseded' WHERE id = $1`, [draft.id]);
    return { reportId: id, version: draft.version + 1, status: 'reviewed' as const };
  });
}

export async function exportReportHtml(reportId: string): Promise<{ html: string; sha256: string; status: string }> {
  const { row, structured } = await getReport(reportId);
  let reviewer: string | null = null;
  if (row.reviewed_by) reviewer = (await db.queryOne<{ email: string }>('SELECT email FROM dash_users WHERE id = $1', [row.reviewed_by]))?.email ?? row.reviewed_by;
  const html = renderReportHtml(structured, { reportId: row.id, version: row.version, status: row.status, reviewedBy: reviewer });
  return { html, sha256: sha256(html), status: row.status };
}

export async function exportReportPdf(reportId: string): Promise<{ pdf: Buffer; sha256: string; status: string }> {
  const { row, structured } = await getReport(reportId);
  let reviewer: string | null = null;
  if (row.reviewed_by) reviewer = (await db.queryOne<{ email: string }>('SELECT email FROM dash_users WHERE id = $1', [row.reviewed_by]))?.email ?? row.reviewed_by;
  const pdf = await renderReportPdf(structured, { reportId: row.id, version: row.version, status: row.status, reviewedBy: reviewer });
  return { pdf, sha256: sha256(pdf.toString('base64')), status: row.status };
}
