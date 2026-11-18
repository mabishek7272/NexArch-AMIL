/**
 * Research Planner (plan §3). Deterministic and pure — no model call, no network, zero cost — and it does real,
 * verifiable work: it converts an already-validated brief into a bounded task graph, and it records which inputs are
 * still missing and which decisions are unresolved (never guessed). As of M4, the FULL chain has real registered
 * agents: literature.search_strategy → literature.search_execute → literature.verify_sources → evidence.extract →
 * evidence.build_matrix → evidence.synthesize(*) → outline.draft(*) → writing.draft_sections/writing.draft_chapters
 * → citation.audit → critique.review → export.manuscript(*). (*) = still unregistered/queued honestly: synthesis,
 * outline drafting and final export remain unimplemented (see agents/{literature-scout,source-verifier,
 * evidence-extractor,evidence-matrix-builder,manuscript-writer,thesis-coordinator,methods-statistics,
 * scientific-critic,citation-auditor}.ts). The API surfaces exactly which task types have no agent; nothing here
 * pretends an unregistered type ran.
 */
import { AgentHandler, NewTaskSpec, ProjectMode, ResearchBrief } from '../types';
import { registerAgent } from '../agent-registry';

export interface PlanNode { type: string; dependsOn: string[]; revisionGroup?: string; maxRevisionsInGroup?: number }
export interface PlanResult { missingInputs: string[]; unresolvedDecisions: string[]; tasks: PlanNode[]; stoppingConditions: string[] }

const REVIEW_MODES: ProjectMode[] = ['narrative_review', 'systematic_review', 'scoping_review'];

/** Pure: same brief and mode always produce the same graph. Exported for direct unit testing without the task store. */
export function planFor(mode: ProjectMode, brief: ResearchBrief): PlanResult {
  const missingInputs: string[] = []; const unresolvedDecisions: string[] = [];
  const nodes: PlanNode[] = [];
  const add = (type: string, dependsOn: string[] = [], extra?: Partial<Pick<PlanNode, 'revisionGroup' | 'maxRevisionsInGroup'>>) => { nodes.push({ type, dependsOn, ...extra }); return type; };

  let lastContentNode: string | null = null;
  if (REVIEW_MODES.includes(mode) || mode === 'dissertation') {
    const strat = add('literature.search_strategy');
    const exec = add('literature.search_execute', [strat]);
    const verify = add('literature.verify_sources', [exec]);
    const extract = add('evidence.extract', [verify]);
    const matrix = add('evidence.build_matrix', [extract]);
    lastContentNode = add('evidence.synthesize', [matrix]);
    if (!brief.referenceTarget) unresolvedDecisions.push('No referenceTarget set: the planner cannot bound how many sources to collect.');
    if (!brief.inclusionCriteria || !brief.exclusionCriteria) missingInputs.push('inclusion/exclusion criteria');
  }

  let methodsNode: string | null = null;
  if (mode === 'original_research') {
    methodsNode = add('methods.analysis');
    if (brief.hasData !== true || !brief.dataResearchRunId) missingInputs.push('actual data/results (hasData/dataResearchRunId): results-drafting cannot be planned without it — no study will be invented to fill this gap');
  }

  const maxRevisionRounds = brief.maxRevisionRounds ?? 2;
  if (!brief.maxRevisionRounds) unresolvedDecisions.push(`No maxRevisionRounds stated; defaulting the revision loop bound to ${maxRevisionRounds}.`);

  const outlineDeps = [lastContentNode, methodsNode].filter((x): x is string => !!x);
  const outline = add('outline.draft', outlineDeps);
  const canDraftSections = !(mode === 'original_research' && (brief.hasData !== true || !brief.dataResearchRunId));
  const writingType = mode === 'dissertation' ? 'writing.draft_chapters' : 'writing.draft_sections';
  // The writing task is the head of a BOUNDED revision group (plan §4): the Scientific Critic requests at most
  // `maxRevisionRounds` further rounds in this exact group before task-store.createTask refuses to grow it further.
  const writingRevisionGroup = `writing-${mode}`;
  const sections = canDraftSections ? add(writingType, [outline], { revisionGroup: writingRevisionGroup, maxRevisionsInGroup: maxRevisionRounds + 1 }) : outline;
  if (!canDraftSections) unresolvedDecisions.push(`${writingType} withheld: original_research has no confirmed data/results yet.`);
  const audited = canDraftSections ? add('citation.audit', [sections]) : sections;
  const critique = add('critique.review', [audited]);
  add('export.manuscript', [critique]);

  if (!brief.wordLimits?.overall && !brief.pageTarget?.pages) unresolvedDecisions.push('No overall word or page limit was stated; the writer has no bound to stop at.');
  if (!brief.referenceHardMax && mode === 'systematic_review') unresolvedDecisions.push('No reference hard maximum stated for a systematic review.');

  const stoppingConditions = [
    `At most ${maxRevisionRounds} critic/revision round(s) per section (bounded; see task-store.ts revisionGroup).`,
    brief.maxRuntimeMinutes ? `Stop after ${brief.maxRuntimeMinutes} minute(s) of wall-clock runtime.` : 'No maxRuntimeMinutes stated: no wall-clock stop is enforced yet.',
    brief.maxActions ? `Stop after ${brief.maxActions} agent action(s).` : 'No maxActions stated: no action-count stop is enforced yet.',
    'Stop and ask the user (awaiting_user) if a required input is still missing when its task becomes ready.',
  ];
  return { missingInputs, unresolvedDecisions, tasks: nodes, stoppingConditions };
}

export const researchPlannerAgent: AgentHandler = async (ctx) => {
  const brief = JSON.parse(ctx.project.brief_json) as ResearchBrief;
  const plan = planFor(ctx.project.mode, brief);
  const childTasks: NewTaskSpec[] = plan.tasks.map((n) => ({ type: n.type, dependsOn: n.dependsOn, revisionGroup: n.revisionGroup, maxRevisionsInGroup: n.maxRevisionsInGroup }));
  return { kind: 'completed', result: { schema: 'anuclaw-research-studio-plan/v1', mode: ctx.project.mode, missingInputs: plan.missingInputs, unresolvedDecisions: plan.unresolvedDecisions, stoppingConditions: plan.stoppingConditions, taskCount: childTasks.length }, childTasks };
};

export function registerResearchPlanner(): void { registerAgent('plan.scope_and_graph', researchPlannerAgent); }
