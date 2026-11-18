/**
 * Compliance report agent (M4, plan §4), task type 'compliance.report'. Purely deterministic — compares recorded
 * word counts and recorded human checklist confirmations against the project's latest recorded guideline. Created
 * on demand (not part of the mandatory planner graph, since a guideline is optional and journal/university-
 * specific). See guideline-service.ts#buildComplianceReport for the exact, explicit "this is not an acceptance"
 * notice this agent's output always carries.
 */
import { AgentHandler } from '../types';
import { registerAgent } from '../agent-registry';
import { currentSections } from '../manuscript-service';
import { latestGuideline, buildComplianceReport, saveComplianceReport } from '../guideline-service';

const complianceAgent: AgentHandler = async (ctx) => {
  const sections = await currentSections(ctx.project.id, ctx.project.owner_id);
  const guideline = await latestGuideline(ctx.project.id, ctx.project.owner_id);
  const report = buildComplianceReport(sections.filter((s) => s.kind !== 'outline'), guideline);
  await saveComplianceReport(ctx.project.id, ctx.task.id, report);
  return { kind: 'completed', result: report };
};

export function registerComplianceAgent(): void { registerAgent('compliance.report', complianceAgent); }
