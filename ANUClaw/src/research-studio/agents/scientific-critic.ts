/**
 * Scientific Critic (M4, plan §3-4), task type 'critique.review'. Entirely structural/evidentiary — it has no
 * opinion on prose quality (that needs a model, which does not exist here); it checks only what the Citation
 * Auditor already recorded. If any audited section has unresolved citation issues, it requests ONE more writing
 * round in the EXACT SAME bounded revision group the planner established (plan §2/§4) — task-store.ts's existing
 * cap (`maxRevisionsInGroup`) is the sole termination authority; this agent pre-checks the count so it never
 * relies on that cap throwing mid-commit (see task-store.ts#revisionGroupCount's doc comment).
 */
import { AgentHandler, NewTaskSpec, TaskRow } from '../types';
import { registerAgent } from '../agent-registry';
import { db } from '../../db';
import { currentSections } from '../manuscript-service';
import { revisionGroupCount, cancelTask } from '../task-store';

interface LatestAudit { section_id: string; overall_status: string }

const scientificCriticAgent: AgentHandler = async (ctx) => {
  const sections = await currentSections(ctx.project.id, ctx.project.owner_id);
  const contentSections = sections.filter((s) => s.kind !== 'outline');
  const audits = await db.query<LatestAudit>(
    `SELECT DISTINCT ON (section_id) section_id, overall_status FROM research_studio_citation_audits WHERE project_id = $1 ORDER BY section_id, ordinal DESC`, [ctx.project.id]);
  const auditBySection = new Map(audits.map((a) => [a.section_id, a.overall_status]));
  const issues = contentSections.filter((s) => auditBySection.get(s.id) === 'issues_found').map((s) => s.section_key);
  const needsHumanAuthorship = contentSections.filter((s) => s.content_source === 'deterministic_digest').map((s) => s.section_key);

  if (!issues.length) {
    return { kind: 'completed', result: { schema: 'anuclaw-research-studio-critique/v1', sectionsReviewed: contentSections.length, citationIssues: [], needsHumanAuthorship, revisionRequested: false } };
  }

  const writingTask = await db.queryOne<TaskRow>(`SELECT * FROM research_studio_tasks WHERE project_id = $1 AND type IN ('writing.draft_sections','writing.draft_chapters') AND revision_group IS NOT NULL ORDER BY ordinal DESC LIMIT 1`, [ctx.project.id]);
  if (!writingTask?.revision_group || !writingTask.max_revisions_in_group) {
    return { kind: 'completed', result: { schema: 'anuclaw-research-studio-critique/v1', sectionsReviewed: contentSections.length, citationIssues: issues, needsHumanAuthorship, revisionRequested: false, note: 'No bounded revision group was found on the writing task; proceeding without requesting a revision.' } };
  }
  const count = await revisionGroupCount(ctx.project.id, writingTask.revision_group);
  if (count >= writingTask.max_revisions_in_group) {
    return { kind: 'completed', result: { schema: 'anuclaw-research-studio-critique/v1', sectionsReviewed: contentSections.length, citationIssues: issues, needsHumanAuthorship, revisionRequested: false, note: `Revision loop bounded (${count}/${writingTask.max_revisions_in_group}): proceeding to export despite unresolved citation issues in: ${issues.join(', ')}.` } };
  }
  // export.manuscript's dependsOn is fixed to the FIRST critique task's id and cannot be amended in place: cancel
  // the original export task (still queued — it cannot have been claimed, since its one dependency, THIS critique
  // task, only becomes 'completed' once this handler's outcome is committed, after this line runs) and create a
  // full replacement tail (writing → citation.audit → critique.review → export.manuscript) chained by type within
  // this one batch, so export never races ahead of the new revision round.
  const oldExport = await db.queryOne<TaskRow>(`SELECT * FROM research_studio_tasks WHERE project_id = $1 AND type = 'export.manuscript' AND status != ALL($2::text[])`, [ctx.project.id, ['cancelled', 'failed']]);
  if (oldExport) await cancelTask(oldExport.id, 'superseded by a new bounded revision round').catch(() => {});
  const childTasks: NewTaskSpec[] = [
    { type: writingTask.type, dependsOn: [ctx.task.id], revisionGroup: writingTask.revision_group, maxRevisionsInGroup: writingTask.max_revisions_in_group },
    { type: 'citation.audit', dependsOn: [writingTask.type] },
    { type: 'critique.review', dependsOn: ['citation.audit'] },
    { type: 'export.manuscript', dependsOn: ['critique.review'] },
  ];
  return { kind: 'completed', result: { schema: 'anuclaw-research-studio-critique/v1', sectionsReviewed: contentSections.length, citationIssues: issues, needsHumanAuthorship, revisionRequested: true, revisionRound: count + 1 }, childTasks };
};

export function registerScientificCritic(): void { registerAgent('critique.review', scientificCriticAgent); }
