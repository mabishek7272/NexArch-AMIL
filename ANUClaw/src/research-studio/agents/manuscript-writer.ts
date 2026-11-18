/**
 * Manuscript Writer (M4, plan §3-4). Two registered task types:
 *  - 'outline.draft': deterministic — a standard section skeleton per mode (a well-known structure, e.g. IMRaD; not
 *    content). This is a template choice, not a fabricated result — no claim, number or finding is invented here.
 *  - 'writing.draft_sections': accepts STRUCTURED, human-supplied section text (exactly like the Evidence
 *    Extractor's pattern — see evidence-extractor.ts) via the task's awaiting_user resolution. Any section without
 *    supplied text gets an honest placeholder digest, NEVER fabricated prose — semantic drafting needs a human
 *    author or a model/browser adapter, neither of which exists in this build (see
 *    docs/RESEARCH-STUDIO-BROWSER-CONNECTOR.md). For `original_research`'s "results" section specifically, the
 *    digest embeds the REAL stored statistical output (from methods.analysis's result) verbatim — never invented
 *    numbers, and never narrated into prose that wasn't actually written by a human.
 */
import { AgentHandler, ProjectMode, TaskRow } from '../types';
import { registerAgent } from '../agent-registry';
import { createSection, listSectionVersions } from '../manuscript-service';
import { assertNoRestrictedContent } from '../../aikosh/taint';
import { db } from '../../db';

const DEFAULT_OUTLINE: Record<ProjectMode, string[]> = {
  narrative_review: ['introduction', 'methods', 'results', 'discussion', 'conclusion'],
  systematic_review: ['introduction', 'methods', 'results', 'discussion', 'conclusion'],
  scoping_review: ['introduction', 'methods', 'results', 'discussion', 'conclusion'],
  original_research: ['introduction', 'methods', 'results', 'discussion', 'conclusion'],
  research_protocol: ['background', 'objectives', 'methods', 'ethics_and_dissemination'],
  case_report: ['introduction', 'case_presentation', 'discussion', 'conclusion'],
  dissertation: [], // dissertation uses writing.draft_chapters via thesis-coordinator.ts, driven by brief.chapterOutline directly
};

const outlineAgent: AgentHandler = async (ctx) => {
  const brief = JSON.parse(ctx.project.brief_json) as { chapterOutline?: string[] };
  const keys = ctx.project.mode === 'dissertation' ? (brief.chapterOutline ?? []) : DEFAULT_OUTLINE[ctx.project.mode];
  if (!keys.length) return { kind: 'failed', reason: 'No outline structure is available for this mode/brief.' };
  const row = await createSection(ctx.project.id, ctx.project.owner_id, {
    sectionKey: 'outline', kind: 'outline', title: 'Outline', contentText: JSON.stringify(keys), contentSource: 'deterministic_digest', taskId: ctx.task.id,
  });
  return { kind: 'completed', result: { schema: 'anuclaw-research-studio-outline/v1', sectionKeys: keys, sectionId: row.id } };
};

export interface SuppliedSection { sectionKey: string; text: string }

/** Shared by writing.draft_sections here and writing.draft_chapters in thesis-coordinator.ts — same rules for both: human text or an honest placeholder, never fabricated prose. */
export async function draftSections(ctx: Parameters<AgentHandler>[0], kind: 'section' | 'chapter', keys: string[]) {
  const params = JSON.parse(ctx.task.params_json) as { sections?: SuppliedSection[]; userAnswer?: { sections?: SuppliedSection[] } };
  const supplied = new Map((params.userAnswer?.sections ?? params.sections ?? []).map((s) => [s.sectionKey, s.text]));
  if (!supplied.size) {
    return { kind: 'awaiting_user' as const, reason: `No human-authored ${kind} text was supplied, and semantic drafting needs a human author or a model/browser adapter (neither exists in this build). Resolve this task with { "sections": [{ "sectionKey": "...", "text": "..." }, ...] } for any/all of: ${keys.join(', ')}.` };
  }
  assertNoRestrictedContent([...supplied.values()]);
  let methodsOutput: unknown = null;
  if (ctx.project.mode === 'original_research') {
    const methodsTask = await db.queryOne<TaskRow>(`SELECT * FROM research_studio_tasks WHERE project_id = $1 AND type = 'methods.analysis' AND status = 'completed' ORDER BY ordinal DESC LIMIT 1`, [ctx.project.id]);
    if (methodsTask?.result_json) methodsOutput = JSON.parse(methodsTask.result_json);
  }
  const created: string[] = [];
  for (const key of keys) {
    const text = supplied.get(key);
    if (text) {
      const row = await createSection(ctx.project.id, ctx.project.owner_id, { sectionKey: key, kind, title: key, contentText: text, contentSource: 'human', taskId: ctx.task.id });
      created.push(row.id);
    } else {
      const digest = key === 'results' && ctx.project.mode === 'original_research' && methodsOutput
        ? `[deterministic digest — real stored statistical output, not narrated into prose]\n${JSON.stringify(methodsOutput)}`
        : `[no human-authored content supplied for "${key}"; semantic drafting is unavailable without a human author or a model/browser adapter]`;
      const row = await createSection(ctx.project.id, ctx.project.owner_id, { sectionKey: key, kind, title: key, contentText: digest, contentSource: 'deterministic_digest', taskId: ctx.task.id });
      created.push(row.id);
    }
  }
  return { kind: 'completed' as const, result: { schema: 'anuclaw-research-studio-draft/v1', kind, sectionIds: created, humanAuthored: [...supplied.keys()] } };
}

const draftSectionsAgent: AgentHandler = async (ctx) => {
  const outlineRows = await listSectionVersions(ctx.project.id, ctx.project.owner_id, 'outline');
  const outline = outlineRows[outlineRows.length - 1];
  const keys: string[] = outline ? JSON.parse(outline.content_text) : DEFAULT_OUTLINE[ctx.project.mode];
  return draftSections(ctx, 'section', keys);
};

export function registerManuscriptWriter(): void {
  registerAgent('outline.draft', outlineAgent);
  registerAgent('writing.draft_sections', draftSectionsAgent);
}
