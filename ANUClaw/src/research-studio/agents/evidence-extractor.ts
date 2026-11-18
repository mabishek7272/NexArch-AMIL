/**
 * Evidence Extractor (M2, plan §3/§5), task type 'evidence.extract'. Semantic excerpt extraction from full text is a
 * MODEL-driven operation that is not implemented (no model/browser adapter exists yet — see
 * docs/RESEARCH-STUDIO-BROWSER-CONNECTOR.md). This agent deliberately does NOT pretend to read papers and produce
 * excerpts on its own: it ingests STRUCTURED, human-supplied excerpt annotations (each with an exact locator) and
 * records them as evidence, with `extracted_by: 'human'`. Without any supplied, it asks the user via the existing
 * awaiting_user mechanism — it never fabricates placeholder excerpts to make the task look complete.
 */
import { AgentHandler } from '../types';
import { registerAgent } from '../agent-registry';
import { createExcerpt } from '../evidence-service';
import { assertNoRestrictedContent } from '../../aikosh/taint';

interface SuppliedExcerpt { sourceId: string; locator: { page?: number; section?: string; table?: string; paragraph?: number }; text: string }

const evidenceExtractorAgent: AgentHandler = async (ctx) => {
  const params = JSON.parse(ctx.task.params_json) as { excerpts?: SuppliedExcerpt[]; userAnswer?: { excerpts?: SuppliedExcerpt[] } };
  const supplied = params.userAnswer?.excerpts ?? params.excerpts ?? [];
  if (!supplied.length) {
    return {
      kind: 'awaiting_user',
      reason: 'Semantic/model-driven excerpt extraction is not implemented (no model or browser adapter is connected yet). Provide structured excerpts — [{ sourceId, locator: { page|section|table|paragraph }, text }] — by resolving this task, e.g. POST /tasks/:id/resolve with { "excerpts": [...] }.',
    };
  }
  // Untrusted content notice (plan §5): excerpt text is stored verbatim as DATA below — it is never interpreted as an
  // instruction, never used to authorise a tool call, and is screened for AIKosh-restricted content before anything
  // downstream could send it externally (the Synthesis/Manuscript agents, when built, must do the same before egress).
  assertNoRestrictedContent(supplied.map((s) => s.text));
  const created: string[] = []; const failures: Array<{ index: number; reason: string }> = [];
  for (let i = 0; i < supplied.length; i++) {
    const s = supplied[i];
    try {
      const row = await createExcerpt(ctx.project.id, s.sourceId, ctx.project.owner_id, { locator: s.locator, text: s.text, extractedBy: 'human', taskId: ctx.task.id });
      created.push(row.id);
    } catch (e) { failures.push({ index: i, reason: (e as Error).message }); }
  }
  if (!created.length) return { kind: 'failed', reason: `None of the ${supplied.length} supplied excerpt(s) could be recorded: ${failures.map((f) => f.reason).join('; ')}` };
  return { kind: 'completed', result: { schema: 'anuclaw-research-studio-evidence-extract/v1', excerptsCreated: created.length, excerptIds: created, failures } };
};

export function registerEvidenceExtractor(): void { registerAgent('evidence.extract', evidenceExtractorAgent); }
