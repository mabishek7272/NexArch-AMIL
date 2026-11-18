/**
 * Versioned search strategies and search-run records (M2, plan §5/§6). A strategy is append-only (each edit is a new
 * version, never an overwrite) so a systematic/scoping review keeps a traceable protocol. A search run records the
 * exact query, source, filters, pagination and completion status of ONE search execution — whether it came from the
 * Crossref connector or a local bibliography import — so "how were these sources found" is always answerable.
 */
import * as crypto from 'crypto';
import { db } from '../db';
import { WorkflowError } from '../documents/workflow';
import { ownProject } from './permissions';
import { SearchRunRow, SearchStrategyRow } from './types';

const uid = () => crypto.randomUUID();

export async function createSearchStrategy(projectId: string, userId: string, input: { databases: string[]; queries: string[]; filters?: Record<string, unknown> }, now = Date.now()): Promise<SearchStrategyRow> {
  await ownProject(projectId, userId);
  if (!input.queries?.length) throw new WorkflowError(400, 'validation', 'At least one query is required.');
  const prior = await db.queryOne<{ n: string }>('SELECT COUNT(*)::text AS n FROM research_studio_search_strategies WHERE project_id = $1', [projectId]);
  const version = Number(prior?.n ?? '0') + 1;
  const id = uid();
  const databasesJson = JSON.stringify(input.databases ?? []); const queriesJson = JSON.stringify(input.queries); const filtersJson = JSON.stringify(input.filters ?? {});
  await db.query('INSERT INTO research_studio_search_strategies (id, project_id, version, databases_json, queries_json, filters_json, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, projectId, version, databasesJson, queriesJson, filtersJson, userId, now]);
  return { id, project_id: projectId, version, databases_json: databasesJson, queries_json: queriesJson, filters_json: filtersJson, created_by: userId, created_at: now };
}
export async function listSearchStrategies(projectId: string, userId: string): Promise<SearchStrategyRow[]> { await ownProject(projectId, userId); return db.query<SearchStrategyRow>('SELECT * FROM research_studio_search_strategies WHERE project_id = $1 ORDER BY version', [projectId]); }
export async function latestSearchStrategy(projectId: string): Promise<SearchStrategyRow | undefined> { return db.queryOne<SearchStrategyRow>('SELECT * FROM research_studio_search_strategies WHERE project_id = $1 ORDER BY version DESC LIMIT 1', [projectId]); }

export async function startSearchRun(projectId: string, input: { strategyId?: string | null; taskId?: string | null; source: string; query: unknown; filters?: unknown; page?: number }, now = Date.now()): Promise<SearchRunRow> {
  const id = uid();
  await db.query('INSERT INTO research_studio_search_runs (id, project_id, strategy_id, task_id, source, query_json, filters_json, page, status, result_count, started_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [id, projectId, input.strategyId ?? null, input.taskId ?? null, input.source, JSON.stringify(input.query ?? {}), JSON.stringify(input.filters ?? {}), input.page ?? 1, 'running', 0, now]);
  return { id, project_id: projectId, strategy_id: input.strategyId ?? null, task_id: input.taskId ?? null, source: input.source, query_json: JSON.stringify(input.query ?? {}), filters_json: JSON.stringify(input.filters ?? {}), page: input.page ?? 1, status: 'running', result_count: 0, error: null, started_at: now, completed_at: null };
}
export async function completeSearchRun(runId: string, outcome: { status: SearchRunRow['status']; resultCount: number; error?: string | null }, now = Date.now()): Promise<SearchRunRow> {
  const r = await db.query<SearchRunRow>('UPDATE research_studio_search_runs SET status = $2, result_count = $3, error = $4, completed_at = $5 WHERE id = $1 RETURNING *', [runId, outcome.status, outcome.resultCount, outcome.error ?? null, now]);
  if (!r.length) throw new WorkflowError(404, 'not_found', 'Search run not found.');
  return r[0];
}
export async function listSearchRuns(projectId: string, userId: string): Promise<SearchRunRow[]> { await ownProject(projectId, userId); return db.query<SearchRunRow>('SELECT * FROM research_studio_search_runs WHERE project_id = $1 ORDER BY ordinal', [projectId]); }
