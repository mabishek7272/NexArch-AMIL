/**
 * Visual specifications (M5, plan §5/§8). Every visual is rendered by one of a SMALL, FIXED set of renderer
 * functions below — never `eval`'d or templated from arbitrary user code — producing a real, deterministic SVG
 * string that is persisted alongside its spec (append-only, versioned, exactly like manuscript sections).
 *
 *  - `data_derived` visuals (data_plot, table) MUST name a real `research_runs` id and exact output field(s); the
 *    numbers charted are read LIVE from that run's hash-verified output (`src/research/service.ts#getRun`) at
 *    render time — never a hand-typed number in the spec. A field is either a direct top-level key of the output,
 *    or `"<column>.<metric>"` to reach into that analysis's per-column `results` rows (e.g. `"age.mean"`) — see
 *    `resolveRunField` below. A run that fails integrity or isn't `completed` refuses the render rather than
 *    guessing.
 *  - `conceptual` visuals (flowchart, evidence_map, conceptual_diagram, graphical_abstract) carry layout/labels
 *    only; `createVisual` refuses any spec field that looks like a measured quantity (a key named
 *    count/value/n/total/percent, or a numeric value) UNLESS it is a `prisma_flow`, whose counts are computed
 *    deterministically from real evidence-graph rows by `buildPrismaFlow` below — never accepted as free-typed
 *    input either.
 */
import * as crypto from 'crypto';
import { db } from '../db';
import { WorkflowError } from '../documents/workflow';
import { ownProject } from './permissions';
import { getRun } from '../research/service';
import { VisualKind, VisualType, VisualSpecRow } from './types';

const uid = () => crypto.randomUUID();
const esc = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Renderers (fixed registry — the only code paths that ever produce SVG) ─────────────────────────────────────
function renderBarChart(title: string, labels: string[], values: number[]): string {
  const w = 480, barW = 50, gap = 20, h = 260, chartH = 180, max = Math.max(1, ...values.map((v) => Math.abs(v)));
  const bars = labels.map((label, i) => {
    const v = values[i] ?? 0; const barH = Math.round((Math.abs(v) / max) * chartH);
    const x = 40 + i * (barW + gap); const y = 220 - barH;
    return `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="#3b82f6" /><text x="${x + barW / 2}" y="235" font-size="11" text-anchor="middle">${esc(label)}</text><text x="${x + barW / 2}" y="${y - 4}" font-size="11" text-anchor="middle">${v}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(w, 40 + labels.length * (barW + gap))}" height="${h}"><text x="10" y="18" font-size="14" font-weight="bold">${esc(title)}</text><line x1="30" y1="220" x2="${30 + labels.length * (barW + gap)}" y2="220" stroke="#000" />${bars}</svg>`;
}

function renderTable(title: string, columns: string[], rows: Array<Array<string | number>>): string {
  const rowH = 24, w = Math.max(300, columns.length * 120);
  const header = columns.map((c, i) => `<text x="${10 + i * 120}" y="20" font-size="12" font-weight="bold">${esc(String(c))}</text>`).join('');
  const body = rows.map((r, ri) => r.map((cell, ci) => `<text x="${10 + ci * 120}" y="${20 + (ri + 1) * rowH}" font-size="12">${esc(String(cell))}</text>`).join('')).join('');
  const lines = rows.map((_, ri) => `<line x1="0" y1="${20 + (ri + 1) * rowH - rowH / 2 + 2}" x2="${w}" y2="${20 + (ri + 1) * rowH - rowH / 2 + 2}" stroke="#ddd" />`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${30 + (rows.length + 1) * rowH}"><text x="10" y="14" font-size="14" font-weight="bold">${esc(title)}</text><g transform="translate(0,10)">${header}${lines}${body}</g></svg>`;
}

/** A simple top-to-bottom flow diagram — boxes with labels, connected by arrows — for flowcharts, evidence maps, PRISMA flow, and the graphical abstract's box layout. */
function renderFlow(title: string, nodes: Array<{ id: string; label: string }>, edges: Array<{ from: string; to: string }>): string {
  const boxW = 260, boxH = 50, gapY = 30, w = boxW + 80;
  const yOf = new Map(nodes.map((n, i) => [n.id, 40 + i * (boxH + gapY)]));
  const boxes = nodes.map((n) => {
    const y = yOf.get(n.id)!;
    const lines = n.label.split('\n');
    const text = lines.map((l, i) => `<text x="${w / 2}" y="${y + boxH / 2 + (i - (lines.length - 1) / 2) * 14 + 4}" font-size="12" text-anchor="middle">${esc(l)}</text>`).join('');
    return `<rect x="${(w - boxW) / 2}" y="${y}" width="${boxW}" height="${boxH}" fill="#eef2ff" stroke="#3b82f6" rx="6" />${text}`;
  }).join('');
  const arrows = edges.map((e) => {
    const y1 = (yOf.get(e.from) ?? 0) + boxH; const y2 = yOf.get(e.to) ?? 0;
    return `<line x1="${w / 2}" y1="${y1}" x2="${w / 2}" y2="${y2}" stroke="#333" marker-end="url(#arrow)" />`;
  }).join('');
  const height = 40 + nodes.length * (boxH + gapY);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#333" /></marker></defs><text x="10" y="18" font-size="14" font-weight="bold">${esc(title)}</text>${arrows}${boxes}</svg>`;
}

/**
 * Resolves one requested field against a real AnalysisOutput (src/research/analyses.ts). Every registered research
 * analysis wraps its numbers inside `output.results` (one object per analysed column/row) rather than exposing a
 * bare top-level numeric key, so a direct `output[field]` lookup alone can never find a real number for any actual
 * analysis — only a direct top-level key (rare; kept for forward compatibility with any future analysis that does
 * expose one). `"<column>.<metric>"` additionally looks up `results.find(r => r.column === column)[metric]`. Either
 * way the value must already exist, verified, inside the hash-checked run output — nothing here computes or guesses
 * a number.
 */
function resolveRunField(output: Record<string, unknown>, field: string): number {
  const direct = output?.[field];
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const dot = field.indexOf('.');
  if (dot > 0) {
    const column = field.slice(0, dot); const metric = field.slice(dot + 1);
    const results = output?.results;
    if (Array.isArray(results)) {
      const row = results.find((r) => r && typeof r === 'object' && (r as Record<string, unknown>).column === column) as Record<string, unknown> | undefined;
      const v = row?.[metric];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return NaN;
}

const NUMERIC_LOOKING_KEY = /^(count|value|values?|n|total|percent|pct|number|num|avg|mean|sum)$/i;
function scanForInventedNumbers(obj: unknown, path = ''): string[] {
  if (obj === null || obj === undefined) return [];
  if (Array.isArray(obj)) return obj.flatMap((v, i) => scanForInventedNumbers(v, `${path}[${i}]`));
  if (typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => {
      const hits = typeof v === 'number' && NUMERIC_LOOKING_KEY.test(k) ? [`${path}.${k}`] : [];
      return [...hits, ...scanForInventedNumbers(v, `${path}.${k}`)];
    });
  }
  return [];
}

export interface NewVisualInput { visualKey: string; type: VisualType; kind: VisualKind; title: string; spec: Record<string, unknown>; taskId?: string | null }

export async function createVisual(projectId: string, userId: string, input: NewVisualInput, now = Date.now()): Promise<VisualSpecRow> {
  await ownProject(projectId, userId);
  if (!input.visualKey?.trim() || !input.title?.trim()) throw new WorkflowError(400, 'validation', 'visualKey and title are required.');

  let svg: string; let dataProvenance: Record<string, unknown> = {};
  if (input.kind === 'data_derived') {
    const runId = input.spec.runId as string | undefined; const fields = input.spec.fields as string[] | undefined;
    if (!runId || !fields?.length) throw new WorkflowError(400, 'validation', 'A data_derived visual requires spec.runId and spec.fields (no hand-typed numbers).');
    const { run, output, integrity } = await getRun(runId, userId).catch(() => { throw new WorkflowError(404, 'not_found', `Research run "${runId}" not found.`); });
    if (integrity !== 'verified') throw new WorkflowError(409, 'integrity_failure', `Run "${runId}"'s output hash does not verify; refusing to chart unverifiable data.`);
    if (run.status !== 'completed') throw new WorkflowError(409, 'not_completed', `Run "${runId}" has not completed.`);
    const values = fields.map((f) => resolveRunField(output as Record<string, unknown>, f));
    if (values.some((v) => Number.isNaN(v))) throw new WorkflowError(400, 'field_not_numeric', `One or more requested fields are not present/numeric in run "${runId}"'s real output.`);
    svg = input.type === 'table' ? renderTable(input.title, fields, [values]) : renderBarChart(input.title, fields, values);
    dataProvenance = { runId, outputSha256: run.output_sha256, fields, generator: input.type === 'table' ? 'renderTable' : 'renderBarChart' };
  } else {
    if (input.type === 'prisma_flow') throw new WorkflowError(400, 'use_builder', 'Use buildPrismaFlow(projectId, userId) for prisma_flow visuals — its counts are computed from real evidence-graph rows, never free-typed.');
    const invented = scanForInventedNumbers(input.spec);
    if (invented.length) throw new WorkflowError(400, 'invented_numbers_refused', `A conceptual visual cannot carry a measured-looking numeric field: ${invented.join(', ')}. Use a data_derived visual (with a real run reference) for actual numbers.`);
    const nodes = (input.spec.nodes as Array<{ id: string; label: string }>) ?? []; const edges = (input.spec.edges as Array<{ from: string; to: string }>) ?? [];
    if (!nodes.length) throw new WorkflowError(400, 'validation', 'spec.nodes is required for a conceptual visual.');
    svg = renderFlow(input.title, nodes, edges);
    dataProvenance = { conceptual: true, note: 'Layout/labels only — no measured quantity backs this visual.' };
  }

  const prior = await db.queryOne<{ n: string }>('SELECT COUNT(*)::text AS n FROM research_studio_visuals WHERE project_id = $1 AND visual_key = $2', [projectId, input.visualKey]);
  const version = Number(prior?.n ?? '0') + 1; const id = uid();
  const specJson = JSON.stringify(input.spec); const dataProvenanceJson = JSON.stringify(dataProvenance);
  await db.query(`INSERT INTO research_studio_visuals (id, project_id, task_id, visual_key, version, type, kind, title, spec_json, data_provenance_json, svg, created_by, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, projectId, input.taskId ?? null, input.visualKey, version, input.type, input.kind, input.title, specJson, dataProvenanceJson, svg, userId, now]);
  return (await db.queryOne<VisualSpecRow>('SELECT * FROM research_studio_visuals WHERE id = $1', [id]))!;
}

/** PRISMA-style flow: counts are computed from REAL rows (search_runs.result_count, screening_decisions), never accepted as a caller-supplied number. */
export async function buildPrismaFlow(projectId: string, userId: string, now = Date.now()): Promise<VisualSpecRow> {
  await ownProject(projectId, userId);
  const runs = await db.query<{ result_count: number }>(`SELECT result_count FROM research_studio_search_runs WHERE project_id = $1 AND status IN ('completed','partial')`, [projectId]);
  const identified = runs.reduce((s, r) => s + (r.result_count ?? 0), 0);
  const decisions = await db.query<{ decision: string; n: string }>(
    `SELECT decision, COUNT(*)::text AS n FROM research_studio_screening_decisions d WHERE d.project_id = $1 AND d.ordinal = (SELECT MAX(d2.ordinal) FROM research_studio_screening_decisions d2 WHERE d2.source_id = d.source_id) GROUP BY decision`, [projectId]);
  const included = Number(decisions.find((d) => d.decision === 'include')?.n ?? '0');
  const excluded = Number(decisions.find((d) => d.decision === 'exclude')?.n ?? '0');
  const screened = included + excluded;
  const nodes = [
    { id: 'identified', label: `Records identified through searches\nn = ${identified}` },
    { id: 'screened', label: `Records screened\nn = ${screened}` },
    { id: 'excluded', label: `Records excluded\nn = ${excluded}` },
    { id: 'included', label: `Studies included\nn = ${included}` },
  ];
  const edges = [{ from: 'identified', to: 'screened' }, { from: 'screened', to: 'excluded' }, { from: 'screened', to: 'included' }];
  const svg = renderFlow('PRISMA-style flow', nodes, edges);
  const prior = await db.queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM research_studio_visuals WHERE project_id = $1 AND visual_key = 'prisma_flow'`, [projectId]);
  const version = Number(prior?.n ?? '0') + 1; const id = uid();
  const spec = { nodes, edges }; const provenance = { identified, screened, excluded, included, computedFrom: 'research_studio_search_runs, research_studio_screening_decisions' };
  await db.query(`INSERT INTO research_studio_visuals (id, project_id, visual_key, version, type, kind, title, spec_json, data_provenance_json, svg, created_by, created_at)
    VALUES ($1,$2,'prisma_flow',$3,'prisma_flow','data_derived',$4,$5,$6,$7,$8,$9)`, [id, projectId, version, 'PRISMA-style flow', JSON.stringify(spec), JSON.stringify(provenance), svg, userId, now]);
  return (await db.queryOne<VisualSpecRow>('SELECT * FROM research_studio_visuals WHERE id = $1', [id]))!;
}
export async function listVisuals(projectId: string, userId: string): Promise<VisualSpecRow[]> { await ownProject(projectId, userId); return db.query<VisualSpecRow>('SELECT * FROM research_studio_visuals WHERE project_id = $1 ORDER BY ordinal', [projectId]); }
export async function currentVisuals(projectId: string, userId: string): Promise<VisualSpecRow[]> {
  const all = await listVisuals(projectId, userId);
  const byKey = new Map<string, VisualSpecRow>();
  for (const v of all) { const existing = byKey.get(v.visual_key); if (!existing || v.ordinal! > existing.ordinal!) byKey.set(v.visual_key, v); }
  return [...byKey.values()];
}
export async function invalidateVisualsForTasks(taskIds: string[], reason: string, now = Date.now()): Promise<string[]> {
  if (!taskIds.length) return [];
  const rows = await db.query<{ id: string }>(`UPDATE research_studio_visuals SET invalidated_at = $2, invalidated_reason = $3 WHERE task_id = ANY($1::text[]) AND invalidated_at IS NULL RETURNING id`, [taskIds, now, reason]);
  return rows.map((r) => r.id);
}
