/**
 * Evidence graph persistence (M2, plan §5): sources → versions → links (dedup proposals) → excerpts → claims →
 * claim-evidence links → screening decisions → evidence matrices. Owner isolation is enforced the same way as M1
 * (404, not 403, via ownProject). Separate status columns are NEVER collapsed into one another:
 *   - metadata_verification_status ('unknown'|'unverified'|'verified'|'mismatch') — did a connector lookup CONFIRM
 *     this record's stated fields? A resolved DOI alone does not set this to 'verified'.
 *   - claim_support_status ('unknown'|'unresolved'|'supported'|'contradicted') — is set ONLY by a human decision or
 *     an explicit, recorded deterministic rule on a specific excerpt↔claim link; never inferred from identifier
 *     resolution or from "multiple agents agreeing" (plan §5's own warning).
 * Revising or withdrawing a source's evidence invalidates downstream TASKS through M1's existing
 * task-store.invalidateDownstream (not a parallel, bespoke invalidation scheme) — see invalidateSourceEvidence below.
 */
import * as crypto from 'crypto';
import { db } from '../db';
import { WorkflowError } from '../documents/workflow';
import { canonical, sha256Hex } from '../validation/study/manifest';
import { ownProject } from './permissions';
import { invalidateDownstream } from './task-store';
import { isExactDuplicate, normalizedIdentityOf, proposedRelation } from './citation-service';
import {
  ArtifactRow, ClaimEvidenceLinkRow, ClaimRow, EvidenceMatrixRow, EvidenceRelation, ExcerptRow, ScreeningDecisionRow,
  ScreeningDecisionValue, SourceLinkRow, SourceRow,
} from './types';

const uid = () => crypto.randomUUID();

// ── Sources ──────────────────────────────────────────────────────────────────────────────────────────────────────
export interface NewSourceInput { doi?: string | null; pmid?: string | null; url?: string | null; title: string; authors?: string[]; year?: number | null; venue?: string | null; sourceType?: string; metadata?: unknown; importProvenance: Record<string, unknown> }

/** Creates a source, auto-flagging EXACT duplicates (same normalized_id) and proposing (never auto-confirming) uncertain near-matches as source_links for a human to review. */
export async function createSource(projectId: string, userId: string, input: NewSourceInput, now = Date.now()): Promise<{ source: SourceRow; exactDuplicateOf: string | null; proposedMatches: string[] }> {
  await ownProject(projectId, userId);
  if (!input.title?.trim()) throw new WorkflowError(400, 'validation', 'title is required.');
  const identity = { doi: input.doi, pmid: input.pmid, url: input.url, title: input.title, year: input.year ?? null };
  const normalizedId = normalizedIdentityOf(identity);
  const existing = await db.query<SourceRow>('SELECT * FROM research_studio_sources WHERE project_id = $1', [projectId]);
  const exact = existing.find((e) => isExactDuplicate(identity, { doi: e.doi, pmid: e.pmid, url: e.url, title: e.title, year: e.year }));
  const id = uid();
  const metadataJson = JSON.stringify(input.metadata ?? {});
  const row: SourceRow = {
    id, project_id: projectId, doi: input.doi ?? null, pmid: input.pmid ?? null, url: input.url ?? null, normalized_id: normalizedId,
    title: input.title.trim(), authors_json: JSON.stringify(input.authors ?? []), year: input.year ?? null, venue: input.venue ?? null,
    source_type: input.sourceType ?? 'unknown', content_hash: null, metadata_json: metadataJson,
    metadata_verification_status: 'unknown', fulltext_status: 'unknown', correction_status: 'unknown',
    import_provenance_json: JSON.stringify(input.importProvenance), created_at: now, updated_at: now,
  };
  await db.query(
    `INSERT INTO research_studio_sources (id, project_id, doi, pmid, url, normalized_id, title, authors_json, year, venue, source_type, content_hash, metadata_json,
      metadata_verification_status, fulltext_status, correction_status, import_provenance_json, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
    [id, projectId, row.doi, row.pmid, row.url, row.normalized_id, row.title, row.authors_json, row.year, row.venue, row.source_type, row.content_hash, row.metadata_json,
      row.metadata_verification_status, row.fulltext_status, row.correction_status, row.import_provenance_json, now]);
  await db.query('INSERT INTO research_studio_source_versions (id, source_id, version, metadata_json, content_hash, retrieved_at, retrieval_metadata_json) VALUES ($1,$2,1,$3,$4,$5,$6)',
    [uid(), id, metadataJson, null, now, JSON.stringify(input.importProvenance)]);

  let exactDuplicateOf: string | null = null; const proposedMatches: string[] = [];
  if (exact) { exactDuplicateOf = exact.id; await createSourceLink(projectId, id, exact.id, 'duplicate', now); }
  else {
    for (const e of existing) {
      if (proposedRelation(identity, { doi: e.doi, pmid: e.pmid, url: e.url, title: e.title, year: e.year }) === 'duplicate') {
        proposedMatches.push(e.id); await createSourceLink(projectId, id, e.id, 'duplicate', now);
      }
    }
  }
  return { source: (await getSource(id, projectId))!, exactDuplicateOf, proposedMatches };
}

export async function listSources(projectId: string, userId: string): Promise<SourceRow[]> { await ownProject(projectId, userId); return db.query<SourceRow>('SELECT * FROM research_studio_sources WHERE project_id = $1 ORDER BY ordinal', [projectId]); }
export async function getSource(sourceId: string, projectId: string): Promise<SourceRow | undefined> { return db.queryOne<SourceRow>('SELECT * FROM research_studio_sources WHERE id = $1 AND project_id = $2', [sourceId, projectId]); }
async function ownSource(sourceId: string, projectId: string, userId: string): Promise<SourceRow> {
  await ownProject(projectId, userId); const s = await getSource(sourceId, projectId);
  if (!s) throw new WorkflowError(404, 'not_found', 'Source not found.'); return s;
}

export async function setMetadataVerification(sourceId: string, projectId: string, userId: string, status: SourceRow['metadata_verification_status'], now = Date.now()): Promise<SourceRow> {
  await ownSource(sourceId, projectId, userId);
  await db.query('UPDATE research_studio_sources SET metadata_verification_status = $2, updated_at = $3 WHERE id = $1', [sourceId, status, now]);
  return (await getSource(sourceId, projectId))!;
}
export async function setFulltextStatus(sourceId: string, projectId: string, userId: string, status: SourceRow['fulltext_status'], now = Date.now()): Promise<SourceRow> {
  await ownSource(sourceId, projectId, userId);
  await db.query('UPDATE research_studio_sources SET fulltext_status = $2, updated_at = $3 WHERE id = $1', [sourceId, status, now]);
  return (await getSource(sourceId, projectId))!;
}

/**
 * Records a NEW version of a source's metadata (append-only `source_versions`) and, if the change is material
 * (identifier, title, or correction_status changed — e.g. a retraction notice appears), invalidates every excerpt
 * drawn from this source and every downstream TASK that consumed one, via M1's existing invalidateDownstream.
 * Never silently updates in place without this cascade — plan §4: "changing or withdrawing evidence must invalidate
 * affected downstream tasks and artifacts."
 */
export async function reviseSourceMetadata(sourceId: string, projectId: string, userId: string, patch: Partial<NewSourceInput> & { correctionStatus?: SourceRow['correction_status'] }, retrievalMetadata: Record<string, unknown>, now = Date.now()): Promise<{ source: SourceRow; invalidatedExcerpts: string[]; invalidatedTasks: string[] }> {
  const current = await ownSource(sourceId, projectId, userId);
  const nextMeta = { ...JSON.parse(current.metadata_json), ...(patch.metadata ?? {}) };
  const oldMeta = JSON.parse(current.metadata_json);
  const structureChanged = current.source_type === 'predicted_structure' && patch.metadata != null && ['sha256','modelVersion','rawMetadataHash'].some((k) => (patch.metadata as Record<string, unknown>)[k] !== undefined && (patch.metadata as Record<string, unknown>)[k] !== oldMeta[k]);
  const material = structureChanged || (patch.doi !== undefined && patch.doi !== current.doi) || (patch.title !== undefined && patch.title !== current.title)
    || (patch.correctionStatus !== undefined && patch.correctionStatus !== current.correction_status);
  const metaJson = JSON.stringify(nextMeta);
  const versions = await db.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM research_studio_source_versions WHERE source_id = $1', [sourceId]);
  const nextVersion = Number(versions[0]?.n ?? '0') + 1;
  await db.query('INSERT INTO research_studio_source_versions (id, source_id, version, metadata_json, content_hash, retrieved_at, retrieval_metadata_json) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [uid(), sourceId, nextVersion, metaJson, null, now, JSON.stringify(retrievalMetadata)]);
  await db.query('UPDATE research_studio_sources SET doi = COALESCE($2,doi), title = COALESCE($3,title), metadata_json = $4, correction_status = COALESCE($5,correction_status), updated_at = $6 WHERE id = $1',
    [sourceId, patch.doi ?? null, patch.title ?? null, metaJson, patch.correctionStatus ?? null, now]);

  let invalidatedExcerpts: string[] = []; let invalidatedTasks: string[] = [];
  if (material) {
    const excerpts = await db.query<{ id: string; task_id: string | null }>(`UPDATE research_studio_excerpts SET invalidated_at = $2, invalidated_reason = $3 WHERE source_id = $1 AND invalidated_at IS NULL RETURNING id, task_id`,
      [sourceId, now, `source metadata revised materially (new version ${nextVersion})`]);
    invalidatedExcerpts = excerpts.map((e) => e.id);
    const taskIds = [...new Set(excerpts.map((e) => e.task_id).filter((t): t is string => !!t))];
    for (const taskId of taskIds) invalidatedTasks.push(...await invalidateDownstream(taskId, `source ${sourceId} was revised: ${patch.correctionStatus ?? 'metadata change'}`, now));
    invalidatedTasks = [...new Set(invalidatedTasks)];
  }
  return { source: (await getSource(sourceId, projectId))!, invalidatedExcerpts, invalidatedTasks };
}

// ── Source links (dedup review) ─────────────────────────────────────────────────────────────────────────────────
async function createSourceLink(projectId: string, a: string, b: string, relation: SourceLinkRow['relation'], now: number): Promise<SourceLinkRow> {
  const id = uid();
  await db.query('INSERT INTO research_studio_source_links (id, project_id, source_id_a, source_id_b, relation, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, projectId, a, b, relation, 'proposed', now]);
  return { id, project_id: projectId, source_id_a: a, source_id_b: b, relation, status: 'proposed', decided_by: null, decided_at: null, created_at: now };
}
export async function listSourceLinks(projectId: string, userId: string): Promise<SourceLinkRow[]> { await ownProject(projectId, userId); return db.query<SourceLinkRow>('SELECT * FROM research_studio_source_links WHERE project_id = $1 ORDER BY ordinal', [projectId]); }
/** Confirming or rejecting a proposed duplicate/relation is a human decision — never automatic (plan §4). */
export async function decideSourceLink(linkId: string, projectId: string, userId: string, decision: 'confirmed' | 'rejected', now = Date.now()): Promise<SourceLinkRow> {
  await ownProject(projectId, userId);
  const r = await db.query<SourceLinkRow>(`UPDATE research_studio_source_links SET status = $2, decided_by = $3, decided_at = $4 WHERE id = $1 AND project_id = $5 AND status = 'proposed' RETURNING *`,
    [linkId, decision, userId, now, projectId]);
  if (!r.length) throw new WorkflowError(409, 'not_pending', 'This link is not in a pending (proposed) state, or does not exist.');
  return r[0];
}

// ── Artifacts (metadata row; file bytes live under import-service's artifactRoot) ──────────────────────────────────
export async function recordArtifact(projectId: string, sourceId: string, userId: string, kind: ArtifactRow['kind'], storagePath: string, sha256: string, sizeBytes: number, now = Date.now()): Promise<ArtifactRow> {
  await ownSource(sourceId, projectId, userId);
  const id = uid();
  await db.query('INSERT INTO research_studio_artifacts (id, project_id, source_id, kind, storage_path, sha256, size_bytes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, projectId, sourceId, kind, storagePath, sha256, sizeBytes, now]);
  return { id, project_id: projectId, source_id: sourceId, kind, storage_path: storagePath, sha256, size_bytes: sizeBytes, created_at: now };
}
export async function listArtifacts(sourceId: string, projectId: string, userId: string): Promise<ArtifactRow[]> { await ownSource(sourceId, projectId, userId); return db.query<ArtifactRow>('SELECT * FROM research_studio_artifacts WHERE source_id = $1 ORDER BY ordinal', [sourceId]); }

// ── Excerpts ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface NewExcerptInput { locator: { page?: number; section?: string; table?: string; paragraph?: number }; text: string; extractedBy: ExcerptRow['extracted_by']; taskId?: string | null }
/** Untrusted content (plan §5 security notice): `text` is stored verbatim as DATA, never interpreted as instructions, never executed. Callers must not pass it to a tool or permission check. */
export async function createExcerpt(projectId: string, sourceId: string, userId: string, input: NewExcerptInput, now = Date.now()): Promise<ExcerptRow> {
  await ownSource(sourceId, projectId, userId);
  if (!input.text?.trim()) throw new WorkflowError(400, 'validation', 'text is required.');
  if (!Object.keys(input.locator ?? {}).length) throw new WorkflowError(400, 'missing_locator', 'A page/section/table/paragraph locator is required — an excerpt without a locator cannot be traced back to its source.');
  const id = uid(); const sha = sha256Hex(canonical(input.text));
  await db.query('INSERT INTO research_studio_excerpts (id, project_id, source_id, task_id, locator_json, text, sha256, extracted_by, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, projectId, sourceId, input.taskId ?? null, JSON.stringify(input.locator), input.text, sha, input.extractedBy, userId, now]);
  return { id, project_id: projectId, source_id: sourceId, task_id: input.taskId ?? null, locator_json: JSON.stringify(input.locator), text: input.text, sha256: sha, extracted_by: input.extractedBy, created_by: userId, invalidated_at: null, invalidated_reason: null, created_at: now };
}
export async function listExcerpts(projectId: string, userId: string, sourceId?: string): Promise<ExcerptRow[]> {
  await ownProject(projectId, userId);
  return sourceId ? db.query<ExcerptRow>('SELECT * FROM research_studio_excerpts WHERE project_id = $1 AND source_id = $2 ORDER BY ordinal', [projectId, sourceId])
    : db.query<ExcerptRow>('SELECT * FROM research_studio_excerpts WHERE project_id = $1 ORDER BY ordinal', [projectId]);
}

// ── Claims and claim-evidence links ─────────────────────────────────────────────────────────────────────────────
export async function createClaim(projectId: string, userId: string, statement: string, now = Date.now()): Promise<ClaimRow> {
  await ownProject(projectId, userId);
  if (!statement?.trim()) throw new WorkflowError(400, 'validation', 'statement is required.');
  const id = uid();
  await db.query('INSERT INTO research_studio_claims (id, project_id, statement, created_by, created_at) VALUES ($1,$2,$3,$4,$5)', [id, projectId, statement.trim(), userId, now]);
  return { id, project_id: projectId, statement: statement.trim(), created_by: userId, created_at: now };
}
export async function listClaims(projectId: string, userId: string): Promise<ClaimRow[]> { await ownProject(projectId, userId); return db.query<ClaimRow>('SELECT * FROM research_studio_claims WHERE project_id = $1 ORDER BY ordinal', [projectId]); }

/**
 * Links an excerpt to a claim with a relation (supports/contradicts/unclear). `claim_support_status` starts
 * 'unresolved' unless the caller explicitly asserts a status AND states how it was decided — resolving a DOI,
 * finding a source, or an agent simply existing is never sufficient (plan §5).
 */
export async function linkClaimEvidence(projectId: string, userId: string, claimId: string, excerptId: string, relation: EvidenceRelation, supportStatus: ClaimEvidenceLinkRow['claim_support_status'] = 'unresolved', now = Date.now()): Promise<ClaimEvidenceLinkRow> {
  await ownProject(projectId, userId);
  const claim = await db.queryOne('SELECT id FROM research_studio_claims WHERE id = $1 AND project_id = $2', [claimId, projectId]);
  if (!claim) throw new WorkflowError(404, 'not_found', 'Claim not found.');
  const excerpt = await db.queryOne<ExcerptRow>('SELECT * FROM research_studio_excerpts WHERE id = $1 AND project_id = $2', [excerptId, projectId]);
  if (!excerpt) throw new WorkflowError(404, 'not_found', 'Excerpt not found.');
  const id = uid();
  await db.query('INSERT INTO research_studio_claim_evidence_links (id, project_id, claim_id, excerpt_id, relation, claim_support_status, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, projectId, claimId, excerptId, relation, supportStatus, userId, now]);
  return { id, project_id: projectId, claim_id: claimId, excerpt_id: excerptId, relation, claim_support_status: supportStatus, created_by: userId, created_at: now };
}
export async function listClaimLinks(claimId: string, projectId: string, userId: string): Promise<ClaimEvidenceLinkRow[]> { await ownProject(projectId, userId); return db.query<ClaimEvidenceLinkRow>('SELECT * FROM research_studio_claim_evidence_links WHERE claim_id = $1 AND project_id = $2 ORDER BY ordinal', [claimId, projectId]); }

/** A claim's overall view: 'contradicted' if ANY link contradicts (even with other support — contradiction is never hidden), else 'supported' if at least one supporting link with an invalidated-free excerpt, else 'unresolved'/'unknown'. */
export function summarizeClaimStatus(links: ClaimEvidenceLinkRow[], excerptsById: Map<string, ExcerptRow>): ClaimEvidenceLinkRow['claim_support_status'] {
  if (!links.length) return 'unknown';
  const live = links.filter((l) => !excerptsById.get(l.excerpt_id)?.invalidated_at);
  if (live.some((l) => l.relation === 'contradicts')) return 'contradicted';
  if (live.some((l) => l.relation === 'supports' && l.claim_support_status === 'supported')) return 'supported';
  return 'unresolved';
}

// ── Screening decisions ──────────────────────────────────────────────────────────────────────────────────────────
export async function recordScreeningDecision(projectId: string, sourceId: string, userId: string, decision: ScreeningDecisionValue, exclusionReason: string | null, now = Date.now()): Promise<ScreeningDecisionRow> {
  await ownSource(sourceId, projectId, userId);
  if (decision === 'exclude' && !exclusionReason?.trim()) throw new WorkflowError(400, 'missing_reason', 'exclusionReason is required when excluding a source.');
  const id = uid();
  await db.query('INSERT INTO research_studio_screening_decisions (id, project_id, source_id, decision, exclusion_reason, decided_by, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, projectId, sourceId, decision, decision === 'exclude' ? exclusionReason!.trim() : null, userId, now]);
  return { id, project_id: projectId, source_id: sourceId, decision, exclusion_reason: decision === 'exclude' ? exclusionReason!.trim() : null, decided_by: userId, decided_at: now };
}
/** The latest decision per source (append-only history; `ordinal` breaks same-millisecond ties). */
export async function currentScreeningDecisions(projectId: string, userId: string): Promise<ScreeningDecisionRow[]> {
  await ownProject(projectId, userId);
  return db.query<ScreeningDecisionRow>(
    `SELECT d.* FROM research_studio_screening_decisions d
     WHERE d.project_id = $1 AND d.ordinal = (SELECT MAX(d2.ordinal) FROM research_studio_screening_decisions d2 WHERE d2.source_id = d.source_id)`,
    [projectId]);
}
export async function screeningHistory(sourceId: string, projectId: string, userId: string): Promise<ScreeningDecisionRow[]> { await ownSource(sourceId, projectId, userId); return db.query<ScreeningDecisionRow>('SELECT * FROM research_studio_screening_decisions WHERE source_id = $1 ORDER BY ordinal', [sourceId]); }

// ── Evidence matrix (persisted output of the deterministic Evidence Matrix Builder agent) ──────────────────────────
export async function saveEvidenceMatrix(projectId: string, taskId: string, matrix: unknown, now = Date.now()): Promise<EvidenceMatrixRow> {
  const id = uid(); const matrixJson = JSON.stringify(matrix);
  await db.query('INSERT INTO research_studio_evidence_matrices (id, project_id, task_id, matrix_json, built_at) VALUES ($1,$2,$3,$4,$5)', [id, projectId, taskId, matrixJson, now]);
  return { id, project_id: projectId, task_id: taskId, matrix_json: matrixJson, built_at: now };
}
export async function latestEvidenceMatrix(projectId: string, userId: string): Promise<EvidenceMatrixRow | undefined> {
  await ownProject(projectId, userId);
  return db.queryOne<EvidenceMatrixRow>('SELECT * FROM research_studio_evidence_matrices WHERE project_id = $1 ORDER BY ordinal DESC LIMIT 1', [projectId]);
}
