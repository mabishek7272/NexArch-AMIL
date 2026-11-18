/**
 * Visual Agent (M5, plan §5/§8), task type 'visuals.build'. NOT part of the mandatory planner graph — created on
 * demand, since which visuals a project wants is author-specific. Deterministic: builds the PRISMA-style flow from
 * real evidence-graph counts (review/dissertation modes) and any explicitly-requested conceptual/data-derived
 * visuals supplied via task params, through visual-service.ts's fixed renderer registry — never a hand-drawn
 * image, never an invented number.
 */
import { AgentHandler } from '../types';
import { registerAgent } from '../agent-registry';
import { createVisual, buildPrismaFlow, NewVisualInput } from '../visual-service';

const visualAgent: AgentHandler = async (ctx) => {
  const params = JSON.parse(ctx.task.params_json) as { visuals?: NewVisualInput[]; includePrisma?: boolean; userAnswer?: { visuals?: NewVisualInput[]; includePrisma?: boolean } };
  const visuals = params.userAnswer?.visuals ?? params.visuals ?? [];
  const includePrisma = params.userAnswer?.includePrisma ?? params.includePrisma ?? false;
  const created: string[] = []; const failures: Array<{ visualKey: string; reason: string }> = [];

  if (includePrisma) {
    const v = await buildPrismaFlow(ctx.project.id, ctx.project.owner_id);
    created.push(v.id);
  }
  for (const spec of visuals) {
    try { const v = await createVisual(ctx.project.id, ctx.project.owner_id, { ...spec, taskId: ctx.task.id }); created.push(v.id); }
    catch (e) { failures.push({ visualKey: spec.visualKey, reason: (e as Error).message }); }
  }
  if (!created.length && !failures.length) return { kind: 'awaiting_user', reason: 'No visuals were requested. Resolve this task with { "includePrisma": true } and/or { "visuals": [{ visualKey, type, kind, title, spec }] }.' };
  if (!created.length) return { kind: 'failed', reason: `No visual could be built: ${failures.map((f) => f.reason).join('; ')}` };
  return { kind: 'completed', result: { schema: 'anuclaw-research-studio-visuals/v1', created, failures } };
};

export function registerVisualAgent(): void { registerAgent('visuals.build', visualAgent); }
