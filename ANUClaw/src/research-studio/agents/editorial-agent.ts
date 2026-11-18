/**
 * Editorial Agent (M4, author-voice editing). Task type 'editorial.author_voice_edit'. NOT part of the mandatory
 * planner graph (the brief calls the writing-sample input "optional"); created on demand per section.
 *
 * There is no model here, so this agent does not itself rewrite anything — "author-voice editing" means the AUTHOR
 * supplies their own edited text (informed by their own writing sample/style, entirely outside this system), and
 * this agent: (1) records it as a PROPOSED new section version with tracked changes against the original,
 * (2) runs deterministic preservation checks (numeric tokens, citation/claim links) and flags any interpretation-
 * altering change for the author's own review, (3) re-runs the Citation Auditor on the affected section after the
 * edit — exactly as the brief requires — and (4) leaves accept/reject to the human via manuscript-service's
 * decideSection, never applying the edit itself.
 *
 * Hard constraint (explicit, not just by omission): this agent NEVER computes or claims an AI-detector score, and
 * NEVER promises "humanized" / "undetectable" / "0% AI" text. Any param resembling that is rejected outright.
 */
import { AgentHandler } from '../types';
import { registerAgent } from '../agent-registry';
import { createSection, getSection, listSectionClaims, linkSectionClaim } from '../manuscript-service';
import { assertNoRestrictedContent } from '../../aikosh/taint';

const FORBIDDEN_PARAM_PATTERN = /detector|humaniz|undetectable|0%\s*ai|bypass.*(ai|plagiarism)/i;

const NUMERIC_TOKEN = /-?\d+(\.\d+)?%?/g;
function numericTokens(text: string): string[] { return text.match(NUMERIC_TOKEN) ?? []; }

interface PreservationReport {
  originalWordCount: number; editedWordCount: number;
  numbersDropped: string[]; numbersAdded: string[];
  interpretationAlteringChange: boolean; reasons: string[];
}
function assessPreservation(original: string, edited: string): PreservationReport {
  const a = numericTokens(original); const b = numericTokens(edited);
  const bSet = new Set(b); const aSet = new Set(a);
  const numbersDropped = a.filter((n) => !bSet.has(n));
  const numbersAdded = b.filter((n) => !aSet.has(n));
  const reasons: string[] = [];
  if (numbersDropped.length) reasons.push(`${numbersDropped.length} numeric value(s) present in the original are missing from the edit: ${numbersDropped.join(', ')}`);
  if (numbersAdded.length) reasons.push(`${numbersAdded.length} numeric value(s) appear in the edit that were not in the original: ${numbersAdded.join(', ')}`);
  const wordDelta = Math.abs(edited.trim().split(/\s+/).length - original.trim().split(/\s+/).length);
  const relativeDelta = wordDelta / Math.max(1, original.trim().split(/\s+/).length);
  if (relativeDelta > 0.4) reasons.push(`word count changed by ${(relativeDelta * 100).toFixed(0)}% — large enough that meaning may have shifted, not just style`);
  return {
    originalWordCount: original.trim().split(/\s+/).filter(Boolean).length, editedWordCount: edited.trim().split(/\s+/).filter(Boolean).length,
    numbersDropped, numbersAdded, interpretationAlteringChange: reasons.length > 0, reasons,
  };
}

const editorialAgent: AgentHandler = async (ctx) => {
  const params = JSON.parse(ctx.task.params_json) as { sectionId?: string; editedText?: string; writingSampleText?: string; styleNotes?: string; userAnswer?: { editedText?: string } };
  for (const v of [params.writingSampleText, params.styleNotes, JSON.stringify(params)]) if (v && FORBIDDEN_PARAM_PATTERN.test(v)) {
    return { kind: 'failed', reason: 'This agent never optimises for AI-detector scores and never claims "humanized"/"undetectable"/"0% AI" output; the request was refused.' };
  }
  const editedText = params.userAnswer?.editedText ?? params.editedText;
  if (!params.sectionId) return { kind: 'failed', reason: 'params.sectionId is required.' };
  const original = await getSection(params.sectionId, ctx.project.id);
  if (!original) return { kind: 'failed', reason: 'Section not found.' };
  if (!editedText) return { kind: 'awaiting_user', reason: `Supply your own author-edited text for section "${original.section_key}" by resolving this task with { "editedText": "..." }. This agent does not generate text itself.` };
  assertNoRestrictedContent([editedText]);

  const preservation = assessPreservation(original.content_text, editedText);
  const proposal = await createSection(ctx.project.id, ctx.project.owner_id, {
    sectionKey: original.section_key, kind: original.kind, title: original.title, contentText: editedText,
    contentSource: 'editorial_proposal', status: 'proposed', parentVersionId: original.id, taskId: ctx.task.id,
    modelProvenance: { model: null, adapter: null, note: 'author-supplied edit; no model involved', writingSampleProvided: !!params.writingSampleText },
  });
  // Citation links carry forward to the proposal unchanged — this agent never alters which claims a section cites, only its prose.
  const claimLinks = await listSectionClaims(original.id, ctx.project.id);
  for (const link of claimLinks) await linkSectionClaim(ctx.project.id, proposal.id, link.claim_id);

  return {
    kind: 'completed',
    result: {
      schema: 'anuclaw-research-studio-editorial-edit/v1', proposalSectionId: proposal.id, originalSectionId: original.id,
      preservation, disclosure: 'Assisted by a tracked, human-authored edit; no AI-generated prose, no detector-evasion processing of any kind.',
      nextStep: preservation.interpretationAlteringChange ? 'A citation re-audit should run before the author decides; review the flagged numeric/interpretation changes first.' : 'A citation re-audit will run automatically if this proposal is accepted.',
    },
  };
};

export function registerEditorialAgent(): void { registerAgent('editorial.author_voice_edit', editorialAgent); }
