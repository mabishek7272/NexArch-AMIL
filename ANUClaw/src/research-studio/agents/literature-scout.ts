/**
 * Literature Scout (M2, plan §3/§3B). Two real, registered task handlers:
 *  - 'literature.search_strategy': deterministic — persists a versioned search strategy from the brief (no network).
 *  - 'literature.search_execute': executes that strategy against ONE bounded public connector (Crossref metadata
 *    only — never paid AI generation, never a model-API fallback) OR is explicitly deferred to local import.
 * Live network retrieval is opt-in (ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR=1); without it the task asks the user to
 * either enable it or import sources locally — it never silently substitutes a paid model call. The connector is
 * injectable for deterministic, no-network tests (`setConnectorForTesting`), exactly like the fixture-vs-live split
 * used by src/sciencedata's providers.
 */
import { AgentHandler } from '../types';
import { registerAgent } from '../agent-registry';
import { recordUsage } from '../task-store';
import { createSearchStrategy, latestSearchStrategy, startSearchRun, completeSearchRun } from '../search-service';
import { createSource } from '../evidence-service';
import { CrossrefConnector } from '../connectors/crossref';
import { assertNoRestrictedContent } from '../../aikosh/taint';

let connectorOverride: CrossrefConnector | null = null;
/** Test-only: inject a connector built with a fake SafeFetcher (recorded/synthetic fixtures), never a real socket. */
export function setConnectorForTesting(c: CrossrefConnector | null): void { connectorOverride = c; }
function connector(): CrossrefConnector { return connectorOverride ?? new CrossrefConnector({ mailto: process.env.ANUCLAW_RESEARCH_STUDIO_CONTACT_EMAIL }); }

const LIVE_ENABLED = () => process.env.ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR === '1' || connectorOverride !== null;
const MAX_RESULTS_PER_QUERY = 20;

const searchStrategyAgent: AgentHandler = async (ctx) => {
  const brief = JSON.parse(ctx.project.brief_json) as { searchStrategy?: { databases: string[]; queries: string[] }; searchMethod?: string; topic?: string; question?: string };
  const queries = brief.searchStrategy?.queries?.length ? brief.searchStrategy.queries : [brief.searchMethod, brief.topic, brief.question].filter((q): q is string => !!q?.trim());
  if (!queries.length) return { kind: 'awaiting_user', reason: 'No searchStrategy.queries, searchMethod, topic or question is available to derive a search query from. Provide at least one via a brief revision.' };
  assertNoRestrictedContent(queries);
  const strategy = await createSearchStrategy(ctx.project.id, ctx.project.owner_id, { databases: brief.searchStrategy?.databases ?? ['crossref'], queries });
  return { kind: 'completed', result: { schema: 'anuclaw-research-studio-search-strategy/v1', strategyId: strategy.id, version: strategy.version, queries, databases: JSON.parse(strategy.databases_json) } };
};

const searchExecuteAgent: AgentHandler = async (ctx) => {
  const resolved = JSON.parse(ctx.task.params_json)?.userAnswer as { imported?: boolean } | undefined;
  if (resolved?.imported) return { kind: 'completed', result: { schema: 'anuclaw-research-studio-search-execute/v1', mode: 'local_import', note: 'Sources were imported locally by the user; no connector call was made.' } };
  if (!LIVE_ENABLED()) {
    return { kind: 'awaiting_user', reason: 'Live connector retrieval is opt-in and not enabled (set ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR=1). Either enable it, or import sources locally via the import API and resolve this task with {"imported": true} once done.' };
  }

  const strategy = await latestSearchStrategy(ctx.project.id);
  if (!strategy) return { kind: 'failed', reason: 'No search strategy exists for this project yet; literature.search_strategy must complete first.' };
  const queries = JSON.parse(strategy.queries_json) as string[];
  let created = 0; let considered = 0; const errors: string[] = [];
  for (const q of queries) {
    const usage = await recordUsage(ctx.task, ctx.token, { actions: 1 });
    if (!usage.ok) return { kind: 'failed', reason: 'Task action budget exhausted during search execution.' };
    const run = await startSearchRun(ctx.project.id, { strategyId: strategy.id, taskId: ctx.task.id, source: 'crossref', query: { bibliographic: q }, page: 1 });
    try {
      const result = await connector().searchBibliographic(q, { rows: MAX_RESULTS_PER_QUERY });
      considered += result.works.length;
      for (const w of result.works) {
        if (!w.title) continue;
        const { exactDuplicateOf } = await createSource(ctx.project.id, ctx.project.owner_id, {
          doi: w.doi, title: w.title, authors: w.authors.map((a) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
          year: w.year, venue: w.venue, sourceType: w.type ?? 'unknown', metadata: w.raw,
          importProvenance: { origin: 'crossref', searchRunId: run.id, query: q, retrievedAt: Date.now() },
        });
        if (!exactDuplicateOf) created++;
      }
      await completeSearchRun(run.id, { status: result.status === 'partial' ? 'partial' : 'completed', resultCount: result.works.length });
    } catch (e) {
      const msg = (e as Error).message ?? 'unknown connector error';
      errors.push(`"${q}": ${msg}`);
      await completeSearchRun(run.id, { status: 'failed', resultCount: 0, error: msg.slice(0, 500) });
    }
  }
  if (created === 0 && errors.length === queries.length) return { kind: 'retryable_failure', reason: `Every query failed: ${errors.join('; ')}` };
  return { kind: 'completed', result: { schema: 'anuclaw-research-studio-search-execute/v1', mode: 'crossref_live', queriesRun: queries.length, considered, sourcesCreated: created, errors } };
};

export function registerLiteratureScout(): void {
  registerAgent('literature.search_strategy', searchStrategyAgent);
  registerAgent('literature.search_execute', searchExecuteAgent);
}
