/**
 * Synthesis Agent (plumbing for M4), task type 'evidence.synthesize'. Purely deterministic — it reads the already-
 * built evidence matrix (M2) and restates it as a synthesis digest (claims grouped by status, explicit gaps and
 * contradictions). It makes NO new judgement and writes NO prose: "multiple agents agreeing does not prove a claim
 * is true" (plan §5) applies here too — this agent does not even attempt to agree or disagree, only to tabulate
 * what earlier, human-reviewed steps already recorded.
 */
import { AgentHandler } from '../types';
import { registerAgent } from '../agent-registry';
import { latestEvidenceMatrix } from '../evidence-service';

const synthesisAgent: AgentHandler = async (ctx) => {
  const matrix = await latestEvidenceMatrix(ctx.project.id, ctx.project.owner_id);
  if (!matrix) return { kind: 'awaiting_user', reason: 'No evidence matrix exists yet; evidence.build_matrix must complete first.' };
  const parsed = JSON.parse(matrix.matrix_json) as { rows: Array<{ claimId: string; statement: string; overallStatus: string; evidence: unknown[] }> };
  const byStatus: Record<string, typeof parsed.rows> = {};
  for (const row of parsed.rows) (byStatus[row.overallStatus] ??= []).push(row);
  const digest = {
    schema: 'anuclaw-research-studio-synthesis/v1',
    claimCount: parsed.rows.length,
    supported: byStatus.supported?.map((r) => r.statement) ?? [],
    contradicted: byStatus.contradicted?.map((r) => r.statement) ?? [],
    unresolved: byStatus.unresolved?.map((r) => r.statement) ?? [],
    unknown: byStatus.unknown?.map((r) => r.statement) ?? [],
    gaps: parsed.rows.filter((r) => r.evidence.length === 0).map((r) => r.statement),
  };
  return { kind: 'completed', result: digest };
};

export function registerSynthesisAgent(): void { registerAgent('evidence.synthesize', synthesisAgent); }
