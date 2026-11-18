/**
 * Authorized reference retrieval (plan §10).
 *
 * - Reference documents are separate from patient records (no patient columns;
 *   patient documents are never indexed here).
 * - Admission: metadata (publisher, source URL, licence, version, scope) required;
 *   documents start as `draft`; only a licensed clinician (`clinician` role) can
 *   approve. Only approved documents are retrievable.
 * - Authorization is applied in SQL BEFORE similarity scoring: approved AND
 *   (global OR caller's tenant) AND same embedding model/dimensions.
 * - No-evidence is explicit. Citations are verified against retrieved chunks,
 *   including the numbers a claim states.
 */
import * as crypto from 'crypto';
import { db } from '../db';
import { embedTexts, cosine } from './adapters';
import { modelRoles } from './openrouter';
import { sha256 } from '../documents/rules';
import { WorkflowError } from '../documents/workflow';

export interface ReferenceMeta { title: string; publisher: string; sourceUrl: string; license: string; version: string; scope: string }
export interface Section { anchor: string; text: string }

export async function addReferenceDocument(args: { tenantId: string | null; meta: ReferenceMeta; sections: Section[]; userId: string }) {
  const m = args.meta;
  for (const k of ['title', 'publisher', 'sourceUrl', 'license', 'version', 'scope'] as const) {
    if (typeof m?.[k] !== 'string' || !m[k].trim()) throw new WorkflowError(400, 'metadata_required', `Reference metadata "${k}" is required.`);
  }
  if (!/^https:\/\//.test(m.sourceUrl)) throw new WorkflowError(400, 'source_url', 'sourceUrl must be an https URL to the original source.');
  if (!Array.isArray(args.sections) || !args.sections.length || args.sections.some((s) => !s?.anchor?.trim() || !s?.text?.trim() || s.text.length > 8000)) {
    throw new WorkflowError(400, 'sections', 'Provide sections with an anchor and text (≤ 8000 chars each).');
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO reference_documents (id, tenant_id, title, publisher, source_url, license, version, scope, status, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10)`,
      [id, args.tenantId, m.title.trim(), m.publisher.trim(), m.sourceUrl.trim(), m.license.trim(), m.version.trim(), m.scope.trim(), args.userId, now],
    );
    for (const s of args.sections) {
      await tx.query(`INSERT INTO reference_chunks (id, document_id, anchor, text, content_sha256) VALUES ($1,$2,$3,$4,$5)`,
        [crypto.randomUUID(), id, s.anchor.trim(), s.text.trim(), sha256(s.text.trim())]);
    }
  });
  return { id, status: 'draft' as const };
}

export async function approveReferenceDocument(args: { documentId: string; approverId: string }) {
  const approver = await db.queryOne<{ ok: boolean }>(
    `SELECT TRUE AS ok FROM dash_users u JOIN clinician_credentials c ON c.user_id = u.id WHERE u.id = $1 AND u.role = 'clinician' AND c.status = 'active'`, [args.approverId]);
  if (!approver?.ok) throw new WorkflowError(403, 'clinician_required', 'Only a provisioned licensed clinician can approve reference content.');
  const r = await db.query(`UPDATE reference_documents SET status = 'approved', approved_by = $2, approved_at = $3 WHERE id = $1 AND status = 'draft' RETURNING id`,
    [args.documentId, args.approverId, Date.now()]);
  if (!r.length) throw new WorkflowError(409, 'not_draft', 'Document not found or not in draft.');
  return { id: args.documentId, status: 'approved' as const };
}

export async function indexReferenceDocument(documentId: string) {
  const chunks = await db.query<{ id: string; text: string }>('SELECT id, text FROM reference_chunks WHERE document_id = $1 ORDER BY anchor', [documentId]);
  if (!chunks.length) throw new WorkflowError(404, 'not_found', 'No chunks for this document.');
  const model = modelRoles().embedding;
  let dims: number | null = null;
  for (let i = 0; i < chunks.length; i += 16) {
    const batch = chunks.slice(i, i + 16);
    const e = await embedTexts(batch.map((c) => c.text), { model, dataClass: 'reference_public' });
    if (e.status !== 'ok') throw new WorkflowError(502, 'embedding_failed', `Embedding failed (${e.status}); document left unindexed.`, { error: e.error });
    dims = e.dims;
    for (let j = 0; j < batch.length; j++) {
      await db.query('UPDATE reference_chunks SET embedding = $2, embedding_model = $3, dims = $4, indexed_at = $5 WHERE id = $1',
        [batch[j].id, e.vectors[j], model, e.dims, Date.now()]);
    }
  }
  return { documentId, chunks: chunks.length, model, dims };
}

export interface RetrievedChunk { chunkId: string; documentId: string; title: string; publisher: string; anchor: string; sourceUrl: string; version: string; score: number; text: string }

export async function retrieveReferences(args: { tenantId: string | null; query: string; k?: number; minScore?: number }): Promise<{ status: 'ok' | 'no_evidence' | 'embedding_failed'; results: RetrievedChunk[]; candidatesConsidered: number; model: string; error?: string }> {
  const model = modelRoles().embedding;
  const k = Math.min(Math.max(args.k ?? 5, 1), 20);
  const minScore = args.minScore ?? 0.5;
  // Authorization FIRST: only approved, in-scope, same-model chunks become candidates.
  const candidates = await db.query<any>(
    `SELECT c.id, c.document_id, c.anchor, c.text, c.embedding, c.dims, d.title, d.publisher, d.source_url, d.version
       FROM reference_chunks c JOIN reference_documents d ON d.id = c.document_id
      WHERE d.status = 'approved' AND (d.tenant_id IS NULL OR d.tenant_id = $1)
        AND c.embedding IS NOT NULL AND c.embedding_model = $2`,
    [args.tenantId, model],
  );
  if (!candidates.length) return { status: 'no_evidence', results: [], candidatesConsidered: 0, model };
  // The query may contain patient context → patient_derived (de-identified per policy).
  const q = await embedTexts([args.query], { model, dataClass: 'patient_derived', scope: args.tenantId ? { kind: 'tenant', id: args.tenantId } : undefined });
  if (q.status !== 'ok') return { status: 'embedding_failed', results: [], candidatesConsidered: candidates.length, model, error: q.error };
  const scored = candidates
    .filter((c) => c.dims === q.dims)
    .map((c): RetrievedChunk => ({ chunkId: c.id, documentId: c.document_id, title: c.title, publisher: c.publisher, anchor: c.anchor, sourceUrl: c.source_url, version: c.version, score: cosine(q.vectors[0], c.embedding.map(Number)), text: c.text }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return { status: scored.length ? 'ok' : 'no_evidence', results: scored, candidatesConsidered: candidates.length, model };
}

const NUMS = /-?\d+(?:\.\d+)?/g;

/** Every cited chunk must have been retrieved, and every number in a claim must appear in its cited text. */
export function verifyCitations(claims: Array<{ text: string; chunkIds: string[] }>, retrieved: RetrievedChunk[]): string[] {
  const byId = new Map(retrieved.map((r) => [r.chunkId, r]));
  const problems: string[] = [];
  claims.forEach((c, i) => {
    if (!c.chunkIds?.length) { problems.push(`claim ${i}: no citation`); return; }
    const texts: string[] = [];
    for (const id of c.chunkIds) {
      const r = byId.get(id);
      if (!r) problems.push(`claim ${i}: cites ${id}, which was not retrieved`);
      else texts.push(r.text);
    }
    const sourceNums = new Set(texts.join(' ').match(NUMS) ?? []);
    for (const n of c.text.match(NUMS) ?? []) if (!sourceNums.has(n)) problems.push(`claim ${i}: number ${n} not found in cited source`);
  });
  return problems;
}
