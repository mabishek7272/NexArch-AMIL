/**
 * Research workspace service (plan phase 7). Governance rules enforced here:
 *  - a dataset needs a name, purpose, a data dictionary covering EVERY column, and an
 *    explicit de-identification/authorisation attestation; identifier-like columns are
 *    refused. Datasets are immutable (content hash) and owner-only.
 *  - only registered analyses run; prediction/biomarker analyses additionally require an
 *    explicit research-only acknowledgement and always carry "clinical claims prohibited".
 *  - every run stores inputs (dataset hash, params, plan hash, min-cell, engine version),
 *    the output and its hash; a re-run re-executes and records whether the output hash
 *    reproduced. Failed runs are recorded too.
 */
import * as crypto from 'crypto';
import { db } from '../db';
import { sha256 } from '../documents/rules';
import { WorkflowError } from '../documents/workflow';
import { ANALYSES, AnalysisError, AnalysisName, Dataset, loadDataset, RESEARCH_ENGINE_VERSION } from './analyses';

export function minCell(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ANUCLAW_RESEARCH_MIN_CELL ?? 5);
  return Number.isInteger(n) && n >= 1 ? n : 5;
}

export async function createDataset(args: { userId: string; name: unknown; purpose: unknown; csv: string; dictionary: unknown; attestation: unknown }) {
  const name = typeof args.name === 'string' ? args.name.trim() : '', purpose = typeof args.purpose === 'string' ? args.purpose.trim() : '';
  if (!name || name.length > 200) throw new WorkflowError(400, 'validation', 'name is required (≤ 200 chars).');
  if (purpose.length < 5 || purpose.length > 500) throw new WorkflowError(400, 'validation', 'A purpose of use (5–500 chars) is required.');
  const att = args.attestation as { deidentified?: unknown; authorised?: unknown; statement?: unknown } | undefined;
  if (!att || att.deidentified !== true || att.authorised !== true || typeof att.statement !== 'string' || att.statement.trim().length < 10) {
    throw new WorkflowError(400, 'attestation_required', 'Attest (deidentified:true, authorised:true, statement ≥ 10 chars) that the data is de-identified/synthetic and you are authorised to analyse it.');
  }
  let ds: Dataset;
  try { ds = loadDataset(args.csv); } catch (e) { if (e instanceof AnalysisError) throw new WorkflowError(422, e.code, e.message); throw e; }
  const dict = args.dictionary as Record<string, unknown> | undefined;
  const missing = ds.columns.filter((c) => !dict || typeof dict[c.name] !== 'string' || !(dict[c.name] as string).trim()).map((c) => c.name);
  if (missing.length) throw new WorkflowError(400, 'dictionary_incomplete', `The data dictionary must describe every column. Missing: ${missing.join(', ')}`);
  const id = crypto.randomUUID(), hash = sha256(args.csv);
  try {
    await db.query(
      `INSERT INTO research_datasets (id, owner_id, name, purpose, content_sha256, byte_size, n_rows, columns_json, dictionary_json, attestation_text, csv_text, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, args.userId, name, purpose, hash, Buffer.byteLength(args.csv), ds.rows.length, JSON.stringify(ds.columns), JSON.stringify(dict), att.statement!.trim(), args.csv, Date.now()]);
  } catch (e: any) {
    if (e?.code === '23505') throw new WorkflowError(409, 'duplicate_dataset', 'You already uploaded identical data.');
    throw e;
  }
  return { datasetId: id, rows: ds.rows.length, columns: ds.columns, contentSha256: hash };
}

export async function listDatasets(userId: string) {
  return db.query('SELECT id, name, purpose, content_sha256, n_rows, columns_json, created_at FROM research_datasets WHERE owner_id = $1 ORDER BY created_at DESC', [userId]);
}

async function ownDataset(datasetId: string, userId: string) {
  const d = await db.queryOne<any>('SELECT * FROM research_datasets WHERE id = $1 AND owner_id = $2', [datasetId, userId]);
  if (!d) throw new WorkflowError(404, 'not_found', 'Dataset not found.');
  return d;
}

interface Exec { status: 'completed' | 'failed'; output?: any; outputSha?: string; errorCode?: string; message?: string }

async function execute(analysis: AnalysisName, ds: Dataset, params: any, prespecified: boolean, cell: number): Promise<Exec> {
  try {
    const out = await ANALYSES[analysis].run(ds as any, params as any, { minCell: cell, prespecified });
    return { status: 'completed', output: out, outputSha: sha256(out) };
  } catch (e) {
    if (e instanceof AnalysisError) return { status: 'failed', errorCode: e.code, message: e.message };
    if (e instanceof RangeError || e instanceof TypeError) return { status: 'failed', errorCode: 'bad_values', message: e.message };
    throw e;
  }
}

export async function runAnalysis(args: { userId: string; datasetId: string; analysis: unknown; params: unknown; plan?: unknown; acknowledgeResearchOnly?: unknown }) {
  const analysis = String(args.analysis) as AnalysisName;
  if (!Object.hasOwn(ANALYSES, analysis)) throw new WorkflowError(400, 'unknown_analysis', `analysis must be one of: ${Object.keys(ANALYSES).join(', ')}`);
  if (ANALYSES[analysis].gated && args.acknowledgeResearchOnly !== true) {
    throw new WorkflowError(403, 'research_only_acknowledgement_required', `'${analysis}' is research-only and gated: its outputs are unvalidated and may not support clinical claims. Resubmit with acknowledgeResearchOnly:true.`);
  }
  const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params : {};
  const plan = args.plan && typeof args.plan === 'object' ? args.plan : null;
  if (plan && (typeof (plan as any).endpoint !== 'string' || typeof (plan as any).method !== 'string')) throw new WorkflowError(400, 'plan_invalid', 'A prespecified plan needs at least `endpoint` and `method` strings.');
  const d = await ownDataset(args.datasetId, args.userId);
  const ds: Dataset = { columns: JSON.parse(d.columns_json), rows: loadDataset(d.csv_text).rows };
  const cell = minCell(), planSha = plan ? sha256(plan) : null;
  const inputSha = sha256({ dataset: d.content_sha256, analysis, params, plan: planSha, minCell: cell, engine: RESEARCH_ENGINE_VERSION });
  const ex = await execute(analysis, ds, params, Boolean(plan), cell);
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO research_runs (id, dataset_id, owner_id, analysis, params_json, plan_json, plan_sha256, engine_version, min_cell, input_sha256, output_json, output_sha256, status, error_code, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, d.id, args.userId, analysis, JSON.stringify(params), plan ? JSON.stringify(plan) : null, planSha, RESEARCH_ENGINE_VERSION, cell, inputSha,
      ex.output ? JSON.stringify(ex.output) : null, ex.outputSha ?? null, ex.status, ex.errorCode ?? null, Date.now()]);
  if (ex.status === 'failed') throw new WorkflowError(422, ex.errorCode!, ex.message!, { runId: id });
  return { runId: id, status: ex.status, inputSha256: inputSha, outputSha256: ex.outputSha, output: ex.output };
}

export async function getRun(runId: string, userId: string) {
  const r = await db.queryOne<any>('SELECT r.* FROM research_runs r WHERE r.id = $1 AND r.owner_id = $2', [runId, userId]);
  if (!r) throw new WorkflowError(404, 'not_found', 'Run not found.');
  const output = r.output_json ? JSON.parse(r.output_json) : null;
  const integrity = output ? (sha256(output) === r.output_sha256 ? 'verified' : 'MISMATCH') : 'no_output';
  return { run: r, output, integrity };
}

/** Re-execute a stored run on the same immutable dataset and record whether the output hash reproduced. */
export async function rerun(runId: string, userId: string) {
  const { run } = await getRun(runId, userId);
  if (run.status !== 'completed') throw new WorkflowError(409, 'not_completed', 'Only completed runs can be re-run.');
  const d = await ownDataset(run.dataset_id, userId);
  const ds: Dataset = { columns: JSON.parse(d.columns_json), rows: loadDataset(d.csv_text).rows };
  const ex = await execute(run.analysis, ds, JSON.parse(run.params_json), Boolean(run.plan_json), run.min_cell);
  const reproduced = ex.status === 'completed' && ex.outputSha === run.output_sha256 && run.engine_version === RESEARCH_ENGINE_VERSION;
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO research_runs (id, dataset_id, owner_id, analysis, params_json, plan_json, plan_sha256, engine_version, min_cell, input_sha256, output_json, output_sha256, status, error_code, rerun_of, reproduced, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [id, d.id, userId, run.analysis, run.params_json, run.plan_json, run.plan_sha256, RESEARCH_ENGINE_VERSION, run.min_cell, run.input_sha256,
      ex.output ? JSON.stringify(ex.output) : null, ex.outputSha ?? null, reproduced ? 'completed' : 'not_reproduced', ex.errorCode ?? null, run.id, reproduced, Date.now()]);
  return { runId: id, rerunOf: run.id, reproduced, originalOutputSha256: run.output_sha256, newOutputSha256: ex.outputSha ?? null, engineVersionChanged: run.engine_version !== RESEARCH_ENGINE_VERSION };
}

/** Self-contained artifact: everything needed to audit and re-run the analysis. */
export async function artifact(runId: string, userId: string) {
  const { run, output, integrity } = await getRun(runId, userId);
  const d = await db.queryOne<any>('SELECT name, purpose, content_sha256, n_rows, columns_json, dictionary_json FROM research_datasets WHERE id = $1', [run.dataset_id]);
  return {
    artifactVersion: 'research-artifact-v1', integrity,
    labels: { researchOnly: true, validation: 'unvalidated_research_only', clinicalClaims: 'prohibited' },
    dataset: { id: run.dataset_id, name: d.name, purpose: d.purpose, contentSha256: d.content_sha256, rows: d.n_rows, columns: JSON.parse(d.columns_json), dictionary: JSON.parse(d.dictionary_json) },
    run: { id: run.id, analysis: run.analysis, params: JSON.parse(run.params_json), plan: run.plan_json ? JSON.parse(run.plan_json) : null, planSha256: run.plan_sha256, engineVersion: run.engine_version, minCell: run.min_cell, inputSha256: run.input_sha256, status: run.status, rerunOf: run.rerun_of, reproduced: run.reproduced, createdAt: Number(run.created_at) },
    output, outputSha256: run.output_sha256,
  };
}
