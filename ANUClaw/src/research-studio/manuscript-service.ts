/**
 * Manuscript/thesis authoring persistence (M4, plan §3-4). Sections are append-only: every draft, revision, or
 * editorial proposal is a NEW row under the same `section_key`, never an edit in place. "Current" content for a
 * key is either the latest row created directly as `accepted` (human-authored or a deterministic digest), or — if
 * a later `proposed` (editorial) row for that key was explicitly accepted by a human decision — that proposal,
 * whichever was created later. A rejected proposal never becomes current; it stays in history as a rejected
 * row, visible but inert.
 */
import * as crypto from 'crypto';
import { db } from '../db';
import { WorkflowError } from '../documents/workflow';
import { ownProject } from './permissions';
import {
  AuthorDecisionRow, SectionClaimLinkRow, SectionCommentRow, SectionContentSource, SectionKind, SectionRow,
} from './types';

const uid = () => crypto.randomUUID();

export interface NewSectionInput {
  sectionKey: string; kind: SectionKind; title: string; contentText: string; contentSource: SectionContentSource;
  modelProvenance?: Record<string, unknown>; status?: 'accepted' | 'proposed'; taskId?: string | null; parentVersionId?: string | null;
}

export async function createSection(projectId: string, userId: string, input: NewSectionInput, now = Date.now()): Promise<SectionRow> {
  await ownProject(projectId, userId);
  if (!input.sectionKey?.trim() || !input.title?.trim()) throw new WorkflowError(400, 'validation', 'sectionKey and title are required.');
  if (input.contentSource === 'model') throw new WorkflowError(400, 'model_unavailable', 'content_source "model" is reserved for a future model/browser-backed writer; no such agent is registered — supply human or deterministic_digest content.');
  const prior = await db.queryOne<{ n: string }>('SELECT COUNT(*)::text AS n FROM research_studio_sections WHERE project_id = $1 AND section_key = $2', [projectId, input.sectionKey]);
  const version = Number(prior?.n ?? '0') + 1;
  const id = uid(); const status = input.status ?? 'accepted';
  const modelProvenanceJson = JSON.stringify(input.modelProvenance ?? { model: null, adapter: null, note: 'no model used — deterministic or human-authored content' });
  await db.query(
    `INSERT INTO research_studio_sections (id, project_id, task_id, section_key, version, kind, title, content_text, content_source, model_provenance_json, status, parent_version_id, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, projectId, input.taskId ?? null, input.sectionKey, version, input.kind, input.title, input.contentText, input.contentSource, modelProvenanceJson, status, input.parentVersionId ?? null, userId, now]);
  return (await db.queryOne<SectionRow>('SELECT * FROM research_studio_sections WHERE id = $1', [id]))!;
}

export async function listSectionVersions(projectId: string, userId: string, sectionKey?: string): Promise<SectionRow[]> {
  await ownProject(projectId, userId);
  return sectionKey
    ? db.query<SectionRow>('SELECT * FROM research_studio_sections WHERE project_id = $1 AND section_key = $2 ORDER BY ordinal', [projectId, sectionKey])
    : db.query<SectionRow>('SELECT * FROM research_studio_sections WHERE project_id = $1 ORDER BY ordinal', [projectId]);
}

/** The effective "current" row per section_key — see module header for the exact rule. */
export async function currentSections(projectId: string, userId: string): Promise<SectionRow[]> {
  await ownProject(projectId, userId);
  const all = await db.query<SectionRow>('SELECT * FROM research_studio_sections WHERE project_id = $1 ORDER BY ordinal', [projectId]);
  const decisions = await db.query<AuthorDecisionRow>(
    `SELECT d.* FROM research_studio_author_decisions d JOIN research_studio_sections s ON s.id = d.section_id WHERE s.project_id = $1`, [projectId]);
  const acceptedProposalIds = new Set(decisions.filter((d) => d.decision === 'accepted').map((d) => d.section_id));
  const byKey = new Map<string, SectionRow>();
  for (const row of all) {
    const qualifies = row.status === 'accepted' || (row.status === 'proposed' && acceptedProposalIds.has(row.id));
    if (!qualifies) continue;
    const existing = byKey.get(row.section_key);
    if (!existing || row.ordinal! > existing.ordinal!) byKey.set(row.section_key, row);
  }
  return [...byKey.values()];
}
export async function getSection(sectionId: string, projectId: string): Promise<SectionRow | undefined> { return db.queryOne<SectionRow>('SELECT * FROM research_studio_sections WHERE id = $1 AND project_id = $2', [sectionId, projectId]); }

export async function addComment(projectId: string, sectionId: string, userId: string, body: string, now = Date.now()): Promise<SectionCommentRow> {
  await ownProject(projectId, userId);
  const section = await getSection(sectionId, projectId); if (!section) throw new WorkflowError(404, 'not_found', 'Section not found.');
  if (!body?.trim()) throw new WorkflowError(400, 'validation', 'body is required.');
  const id = uid();
  await db.query('INSERT INTO research_studio_section_comments (id, project_id, section_id, body, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, projectId, sectionId, body.trim(), userId, now]);
  return { id, project_id: projectId, section_id: sectionId, body: body.trim(), created_by: userId, created_at: now };
}
export async function listComments(sectionId: string, projectId: string, userId: string): Promise<SectionCommentRow[]> { await ownProject(projectId, userId); return db.query<SectionCommentRow>('SELECT * FROM research_studio_section_comments WHERE section_id = $1 AND project_id = $2 ORDER BY ordinal', [sectionId, projectId]); }

/** Accept or reject a PROPOSED section (an editorial edit). Never acts on an already-accepted/rejected row twice. */
export async function decideSection(projectId: string, sectionId: string, userId: string, decision: 'accepted' | 'rejected', reason: string | null, now = Date.now()): Promise<AuthorDecisionRow> {
  await ownProject(projectId, userId);
  const section = await getSection(sectionId, projectId); if (!section) throw new WorkflowError(404, 'not_found', 'Section not found.');
  if (section.status !== 'proposed') throw new WorkflowError(409, 'not_proposed', 'Only a proposed (editorial) section version can be accepted or rejected.');
  const existing = await db.query('SELECT 1 FROM research_studio_author_decisions WHERE section_id = $1', [sectionId]);
  if (existing.length) throw new WorkflowError(409, 'already_decided', 'This proposal already has a decision.');
  const id = uid();
  await db.query('INSERT INTO research_studio_author_decisions (id, project_id, section_id, decision, reason, decided_by, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, projectId, sectionId, decision, reason, userId, now]);
  return { id, project_id: projectId, section_id: sectionId, decision, reason, decided_by: userId, decided_at: now };
}
export async function decisionFor(sectionId: string, projectId: string): Promise<AuthorDecisionRow | undefined> { return db.queryOne<AuthorDecisionRow>('SELECT * FROM research_studio_author_decisions WHERE section_id = $1 AND project_id = $2', [sectionId, projectId]); }

export async function linkSectionClaim(projectId: string, sectionId: string, claimId: string, now = Date.now()): Promise<SectionClaimLinkRow> {
  const section = await getSection(sectionId, projectId); if (!section) throw new WorkflowError(404, 'not_found', 'Section not found.');
  const claim = await db.queryOne('SELECT id FROM research_studio_claims WHERE id = $1 AND project_id = $2', [claimId, projectId]);
  if (!claim) throw new WorkflowError(404, 'not_found', 'Claim not found.');
  const id = uid();
  await db.query('INSERT INTO research_studio_section_claims (id, project_id, section_id, claim_id, created_at) VALUES ($1,$2,$3,$4,$5)', [id, projectId, sectionId, claimId, now]);
  return { id, project_id: projectId, section_id: sectionId, claim_id: claimId, created_at: now };
}
export async function listSectionClaims(sectionId: string, projectId: string): Promise<SectionClaimLinkRow[]> { return db.query<SectionClaimLinkRow>('SELECT * FROM research_studio_section_claims WHERE section_id = $1 AND project_id = $2 ORDER BY ordinal', [sectionId, projectId]); }

/** Marks sections produced by any of these tasks as invalidated — called by the route layer right after
 * evidence-service.reviseSourceMetadata, using the `invalidatedTasks` it returns (keeps services decoupled: neither
 * module imports the other). Never deletes or rewrites the section; the history stays intact. */
export async function invalidateSectionsForTasks(taskIds: string[], reason: string, now = Date.now()): Promise<string[]> {
  if (!taskIds.length) return [];
  const rows = await db.query<{ id: string }>(`UPDATE research_studio_sections SET invalidated_at = $2, invalidated_reason = $3 WHERE task_id = ANY($1::text[]) AND invalidated_at IS NULL RETURNING id`, [taskIds, now, reason]);
  return rows.map((r) => r.id);
}
