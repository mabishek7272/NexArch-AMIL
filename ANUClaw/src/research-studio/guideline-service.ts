/**
 * Journal/university guideline records and the compliance report (M4, plan §4). Guidelines are append-only and
 * versioned exactly like search strategies — confirming one checklist item creates a new version rather than
 * mutating the record. A checklist item counts as satisfied ONLY when a human explicitly confirmed it; nothing is
 * auto-ticked. The compliance report this produces is explicitly NOT a journal acceptance or a certification that
 * the checklist was actually satisfied — it is a deterministic comparison of recorded word counts and recorded
 * human confirmations against recorded limits, nothing more.
 */
import * as crypto from 'crypto';
import { db } from '../db';
import { WorkflowError } from '../documents/workflow';
import { ownProject } from './permissions';
import { GuidelineRow, ComplianceReportRow, SectionRow } from './types';

const uid = () => crypto.randomUUID();

export interface ChecklistItem { id: string; label: string; confirmed: boolean; confirmedBy: string | null; confirmedAt: number | null }
export interface GuidelineConstraints { sectionWordLimits?: Record<string, number>; overallWordLimit?: number; pageLimit?: number }

export async function createGuideline(projectId: string, userId: string, input: { journalOrUniversity: string; constraints?: GuidelineConstraints; checklist?: Array<{ id: string; label: string }> }, now = Date.now()): Promise<GuidelineRow> {
  await ownProject(projectId, userId);
  if (!input.journalOrUniversity?.trim()) throw new WorkflowError(400, 'validation', 'journalOrUniversity is required.');
  const prior = await db.queryOne<{ n: string }>('SELECT COUNT(*)::text AS n FROM research_studio_guidelines WHERE project_id = $1', [projectId]);
  const version = Number(prior?.n ?? '0') + 1;
  const checklist: ChecklistItem[] = (input.checklist ?? []).map((c) => ({ id: c.id, label: c.label, confirmed: false, confirmedBy: null, confirmedAt: null }));
  const id = uid(); const constraintsJson = JSON.stringify(input.constraints ?? {}); const checklistJson = JSON.stringify(checklist);
  await db.query('INSERT INTO research_studio_guidelines (id, project_id, version, journal_or_university, constraints_json, checklist_json, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, projectId, version, input.journalOrUniversity.trim(), constraintsJson, checklistJson, userId, now]);
  return { id, project_id: projectId, version, journal_or_university: input.journalOrUniversity.trim(), constraints_json: constraintsJson, checklist_json: checklistJson, created_by: userId, created_at: now };
}

export async function listGuidelines(projectId: string, userId: string): Promise<GuidelineRow[]> { await ownProject(projectId, userId); return db.query<GuidelineRow>('SELECT * FROM research_studio_guidelines WHERE project_id = $1 ORDER BY version', [projectId]); }
export async function latestGuideline(projectId: string, userId: string): Promise<GuidelineRow | undefined> { await ownProject(projectId, userId); return db.queryOne<GuidelineRow>('SELECT * FROM research_studio_guidelines WHERE project_id = $1 ORDER BY version DESC LIMIT 1', [projectId]); }

/** Confirms (or un-confirms) ONE checklist item by creating a new guideline version — never mutates the old one. */
export async function confirmChecklistItem(projectId: string, userId: string, itemId: string, confirmed: boolean, now = Date.now()): Promise<GuidelineRow> {
  const current = await latestGuideline(projectId, userId);
  if (!current) throw new WorkflowError(404, 'not_found', 'No guideline record exists for this project yet.');
  const checklist: ChecklistItem[] = JSON.parse(current.checklist_json);
  const idx = checklist.findIndex((c) => c.id === itemId);
  if (idx === -1) throw new WorkflowError(404, 'not_found', `Checklist item "${itemId}" not found.`);
  checklist[idx] = { ...checklist[idx], confirmed, confirmedBy: confirmed ? userId : null, confirmedAt: confirmed ? now : null };
  const id = uid(); const version = current.version + 1; const checklistJson = JSON.stringify(checklist);
  await db.query('INSERT INTO research_studio_guidelines (id, project_id, version, journal_or_university, constraints_json, checklist_json, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, projectId, version, current.journal_or_university, current.constraints_json, checklistJson, userId, now]);
  return { id, project_id: projectId, version, journal_or_university: current.journal_or_university, constraints_json: current.constraints_json, checklist_json: checklistJson, created_by: userId, created_at: now };
}

const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

export interface ComplianceReport {
  schema: 'anuclaw-research-studio-compliance-report/v1';
  notice: string;
  journalOrUniversity: string | null;
  wordCounts: Array<{ sectionKey: string; words: number; limit: number | null; withinLimit: boolean | null }>;
  overall: { words: number; limit: number | null; withinLimit: boolean | null };
  checklist: Array<ChecklistItem & { status: 'confirmed' | 'not_confirmed' }>;
  checklistFullyConfirmed: boolean;
}

/** Pure — exported for direct unit testing. Builds the report from already-fetched sections/guideline; never fetches or invents anything itself. */
export function buildComplianceReport(sections: Pick<SectionRow, 'section_key' | 'content_text'>[], guideline: GuidelineRow | undefined): ComplianceReport {
  const constraints: GuidelineConstraints = guideline ? JSON.parse(guideline.constraints_json) : {};
  const checklist: ChecklistItem[] = guideline ? JSON.parse(guideline.checklist_json) : [];
  const wordCounts = sections.map((s) => {
    const words = countWords(s.content_text);
    const limit = constraints.sectionWordLimits?.[s.section_key] ?? null;
    return { sectionKey: s.section_key, words, limit, withinLimit: limit === null ? null : words <= limit };
  });
  const totalWords = sections.reduce((sum, s) => sum + countWords(s.content_text), 0);
  const overallLimit = constraints.overallWordLimit ?? null;
  const checklistOut = checklist.map((c) => ({ ...c, status: (c.confirmed ? 'confirmed' : 'not_confirmed') as 'confirmed' | 'not_confirmed' }));
  return {
    schema: 'anuclaw-research-studio-compliance-report/v1',
    notice: 'This report compares recorded word counts and recorded human checklist confirmations against recorded limits. It is NOT a journal acceptance, NOT a certification that any checklist item was actually verified correct, and NOT a clinical or academic approval of any kind.',
    journalOrUniversity: guideline?.journal_or_university ?? null,
    wordCounts, overall: { words: totalWords, limit: overallLimit, withinLimit: overallLimit === null ? null : totalWords <= overallLimit },
    checklist: checklistOut, checklistFullyConfirmed: checklist.length > 0 && checklist.every((c) => c.confirmed),
  };
}

export async function saveComplianceReport(projectId: string, taskId: string, report: ComplianceReport, now = Date.now()): Promise<ComplianceReportRow> {
  const id = uid(); const reportJson = JSON.stringify(report);
  await db.query('INSERT INTO research_studio_compliance_reports (id, project_id, task_id, report_json, built_at) VALUES ($1,$2,$3,$4,$5)', [id, projectId, taskId, reportJson, now]);
  return { id, project_id: projectId, task_id: taskId, report_json: reportJson, built_at: now };
}
export async function latestComplianceReport(projectId: string, userId: string): Promise<ComplianceReportRow | undefined> {
  await ownProject(projectId, userId);
  return db.queryOne<ComplianceReportRow>('SELECT * FROM research_studio_compliance_reports WHERE project_id = $1 ORDER BY ordinal DESC LIMIT 1', [projectId]);
}
