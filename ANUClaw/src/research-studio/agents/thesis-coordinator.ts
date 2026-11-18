/**
 * Thesis Coordinator (M4, plan §3-4), task type 'writing.draft_chapters'. Dissertation mode's counterpart to the
 * Manuscript Writer's 'writing.draft_sections': drives `brief.chapterOutline` (already required at project
 * creation — see project-service.ts) instead of a generic IMRaD skeleton, producing one `kind: 'chapter'` section
 * per chapter key. Reuses manuscript-writer.ts's `draftSections` so chapters and sections follow the exact same
 * rule: human-authored text, or an honest placeholder — never fabricated prose, never a model call.
 */
import { AgentHandler, ResearchBrief } from '../types';
import { registerAgent } from '../agent-registry';
import { draftSections } from './manuscript-writer';

const draftChaptersAgent: AgentHandler = async (ctx) => {
  const brief = JSON.parse(ctx.project.brief_json) as ResearchBrief;
  const keys = brief.chapterOutline ?? [];
  if (!keys.length) return { kind: 'failed', reason: 'No chapterOutline is recorded on this dissertation\'s brief.' };
  return draftSections(ctx, 'chapter', keys);
};

export function registerThesisCoordinator(): void { registerAgent('writing.draft_chapters', draftChaptersAgent); }
