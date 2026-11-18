/**
 * Research Studio project service (M1). Enforces plan §1's brief rules BEFORE a project is created or its brief is revised:
 *  - original_research needs actual data (hasData / dataResearchRunId) before results-drafting can ever be planned — a
 *    results-drafting task is simply never created without it (see agents/research-planner.ts), and assertCanDraftResults
 *    is the same gate for any future caller;
 *  - narrative/systematic/scoping review need a stated, real search method (and screening method for systematic/scoping);
 *  - "systematic review" is refused unless a traceable search strategy (databases + queries) is present (plan §6);
 *  - case_report needs an explicit data-permissions attestation (authorised + a real statement), mirroring
 *    src/research/service.ts's dataset attestation;
 *  - dissertation needs an institution name and at least one chapter outline entry.
 * Nothing here invents a study, a method or a result to fill a gap: missing inputs block creation (or are surfaced by the
 * planner as unresolved decisions — see research-planner.ts) rather than being silently assumed.
 */
import * as crypto from 'crypto';
import { db } from '../db';
import { WorkflowError } from '../documents/workflow';
import { canonical, sha256Hex } from '../validation/study/manifest';
import { ownProject } from './permissions';
import { PROJECT_MODES, ProjectMode, ProjectRow, ResearchBrief } from './types';

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** Pure (no I/O) — exported for direct unit testing of the plan §1 brief rules without a database. */
export function validateBrief(mode: ProjectMode, brief: ResearchBrief): string[] {
  const problems: string[] = [];
  if (!brief.topic?.trim()) problems.push('topic is required');
  if (!brief.question?.trim()) problems.push('question is required');
  if (['narrative_review', 'systematic_review', 'scoping_review'].includes(mode)) {
    if (!brief.searchMethod?.trim()) problems.push(`${mode} requires searchMethod (the ACTUAL search method to be used — never invented after the fact)`);
  }
  if (['systematic_review', 'scoping_review'].includes(mode)) {
    if (!brief.screeningMethod?.trim()) problems.push(`${mode} requires screeningMethod`);
  }
  if (mode === 'systematic_review') {
    const s = brief.searchStrategy;
    if (!s || !Array.isArray(s.databases) || !s.databases.length || !Array.isArray(s.queries) || !s.queries.length) {
      problems.push('systematic_review requires searchStrategy.databases and searchStrategy.queries (a traceable protocol): the label is refused without it (plan §6)');
    }
  }
  if (mode === 'original_research' && brief.hasData === undefined) problems.push('original_research requires hasData (true/false): results-drafting is never created without actual data');
  if (mode === 'case_report') {
    const p = brief.dataPermissions;
    if (!p || p.authorized !== true || typeof p.statement !== 'string' || p.statement.trim().length < 10) problems.push('case_report requires dataPermissions: { authorized: true, statement (>= 10 chars) }');
  }
  if (mode === 'dissertation') {
    if (!brief.institution?.trim()) problems.push('dissertation requires institution');
    if (!brief.chapterOutline?.length) problems.push('dissertation requires at least one chapterOutline entry');
  }
  return problems;
}

/** Same gate a future Manuscript Writer agent must pass before drafting results for original_research (plan §1, §3). */
export function assertCanDraftResults(project: Pick<ProjectRow, 'mode' | 'brief_json'>): void {
  if (project.mode !== 'original_research') return;
  const brief = JSON.parse(project.brief_json) as ResearchBrief;
  if (brief.hasData !== true || !brief.dataResearchRunId) throw new WorkflowError(409, 'no_data_for_results', 'original_research cannot draft results: hasData is not true, or no dataResearchRunId is recorded. A study is never invented to fill missing results.');
}

export async function createProject(args: { userId: string; mode: unknown; title: unknown; brief: unknown }): Promise<ProjectRow> {
  const mode = String(args.mode) as ProjectMode;
  if (!PROJECT_MODES.includes(mode)) throw new WorkflowError(400, 'bad_mode', `mode must be one of: ${PROJECT_MODES.join(', ')}`);
  const title = str(args.title, 200); if (!title) throw new WorkflowError(400, 'validation', 'title is required.');
  const brief = (args.brief && typeof args.brief === 'object' ? args.brief : {}) as ResearchBrief;
  const problems = validateBrief(mode, brief);
  if (problems.length) throw new WorkflowError(400, 'brief_incomplete', problems.join('; '));
  const id = crypto.randomUUID(), now = Date.now(); const briefJson = JSON.stringify(brief); const sha = sha256Hex(canonical(brief));
  await db.query('INSERT INTO research_studio_projects (id, owner_id, mode, title, status, brief_json, brief_sha256, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)',
    [id, args.userId, mode, title, 'draft', briefJson, sha, now]);
  await db.query('INSERT INTO research_studio_project_revisions (id, project_id, brief_json, brief_sha256, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [crypto.randomUUID(), id, briefJson, sha, args.userId, now]);
  return ownProject(id, args.userId);
}

export async function listProjects(userId: string): Promise<ProjectRow[]> { return db.query<ProjectRow>('SELECT * FROM research_studio_projects WHERE owner_id = $1 ORDER BY created_at DESC', [userId]); }
export async function getProject(projectId: string, userId: string): Promise<ProjectRow> { return ownProject(projectId, userId); }

/** Revises the brief; every revision is kept (immutable), never overwritten, so earlier evidence stays reconstructable. */
export async function reviseBrief(projectId: string, userId: string, patch: unknown): Promise<ProjectRow> {
  const project = await ownProject(projectId, userId);
  const current = JSON.parse(project.brief_json) as ResearchBrief;
  const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
  const problems = validateBrief(project.mode, next);
  if (problems.length) throw new WorkflowError(400, 'brief_incomplete', problems.join('; '));
  const now = Date.now(); const briefJson = JSON.stringify(next); const sha = sha256Hex(canonical(next));
  await db.query('UPDATE research_studio_projects SET brief_json = $2, brief_sha256 = $3, updated_at = $4 WHERE id = $1', [projectId, briefJson, sha, now]);
  await db.query('INSERT INTO research_studio_project_revisions (id, project_id, brief_json, brief_sha256, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [crypto.randomUUID(), projectId, briefJson, sha, userId, now]);
  return ownProject(projectId, userId);
}

export async function listRevisions(projectId: string, userId: string) { await ownProject(projectId, userId); return db.query('SELECT id, brief_sha256, created_by, created_at FROM research_studio_project_revisions WHERE project_id = $1 ORDER BY created_at', [projectId]); }
