/**
 * Methods/Statistics Agent (M4, plan §3-4), task type 'methods.analysis'. Only ever created for `original_research`
 * projects that already declared `hasData: true` and a `dataResearchRunId` (enforced at project creation —
 * project-service.ts). This agent fetches that run through the EXISTING, already-verified research-run artifact
 * service (`src/research/service.ts#getRun`) — it never recomputes, re-estimates, or invents a statistic. If the
 * run's own stored output hash does not verify, or the run never completed, this fails rather than guessing.
 */
import { AgentHandler } from '../types';
import { registerAgent } from '../agent-registry';
import { getRun } from '../../research/service';
import { WorkflowError } from '../../documents/workflow';

const methodsStatisticsAgent: AgentHandler = async (ctx) => {
  const brief = JSON.parse(ctx.project.brief_json) as { dataResearchRunId?: string };
  if (!brief.dataResearchRunId) return { kind: 'failed', reason: 'No dataResearchRunId is recorded on this brief; no study will be invented to fill this gap.' };
  let found;
  try { found = await getRun(brief.dataResearchRunId, ctx.project.owner_id); }
  catch (e) { if (e instanceof WorkflowError && e.status === 404) return { kind: 'failed', reason: `Research run "${brief.dataResearchRunId}" was not found for this project's owner.` }; throw e; }
  const { run, output, integrity } = found;
  if (integrity !== 'verified') return { kind: 'failed', reason: `The stored run's output hash does not verify (integrity: ${integrity}) — it is not used as a trusted result.` };
  if (run.status !== 'completed') return { kind: 'awaiting_user', reason: `Research run "${run.id}" has status "${run.status}", not completed; results-drafting cannot proceed until it is.` };
  return {
    kind: 'completed',
    result: { schema: 'anuclaw-research-studio-methods/v1', runId: run.id, analysis: run.analysis, engineVersion: run.engine_version, inputSha256: run.input_sha256, outputSha256: run.output_sha256, output },
  };
};

export function registerMethodsStatisticsAgent(): void { registerAgent('methods.analysis', methodsStatisticsAgent); }
