/**
 * Longitudinal service (interpretation engine, P5): loads stored findings for scans of one subject and compares them.
 * Everything is scoped by tenant in SQL (another tenant's job is a 404). A subject is whatever `subject_ref` the tenant used;
 * nothing here ever returns it. Erased scans are gone (410 when asked for directly, absent from timelines).
 */
import { db } from '../../db';
import { contentHash } from '../../cds/hashing';
import { TenancyError } from '../tenancy/keys';
import type { FindingsDoc } from '../governance/types';
import { buildSeries, compareScans, type ComparisonDoc, type ScanInput, type SeriesPoint, type SeriesStep } from './compare';

const JOB_RE = /^job_[0-9a-f]{24}$/;
const KEY_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const SKILL_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_TIMELINE = 100;

interface JobRow { id: string; tenant_id: string; skill_id: string; subject_ref: string; status: string; captured_at: string; findings_sha256: string | null; created_at: string | number }

async function jobRow(tenantId: string, id: string): Promise<JobRow> {
  if (!JOB_RE.test(id)) throw new TenancyError(404, 'not_found', 'Interpretation not found.');
  const job = await db.queryOne<JobRow>('SELECT id, tenant_id, skill_id, subject_ref, status, captured_at, findings_sha256, created_at FROM interpretation_jobs WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (!job) throw new TenancyError(404, 'not_found', 'Interpretation not found.');
  if (job.status === 'erased') throw new TenancyError(410, 'subject_erased', 'The data for this interpretation was erased.');
  return job;
}

async function loadDoc(job: JobRow): Promise<FindingsDoc> {
  if (job.status !== 'completed') throw new TenancyError(409, 'findings_not_ready', `Findings are not available while the job is ${job.status}.`, { jobId: job.id });
  const row = await db.queryOne<{ document_json: string }>('SELECT document_json FROM normalized_findings WHERE job_id = $1 AND tenant_id = $2', [job.id, job.tenant_id]);
  if (!row) throw new TenancyError(409, 'findings_not_ready', 'Findings are not available.', { jobId: job.id });
  const doc = JSON.parse(row.document_json) as FindingsDoc;
  // Recompute the hash the worker stored (it covers everything a comparison relies on): a document edited after the fact does not match.
  const recomputed = contentHash({ findings: doc.findings, flags: doc.flags, sourceVerification: doc.sourceVerification ?? null, notMeasurable: doc.notMeasurable ?? null, symptoms: doc.symptoms ?? null });
  if (doc.findingsSha256 !== job.findings_sha256 || recomputed !== job.findings_sha256) throw new TenancyError(409, 'integrity_error', 'Stored findings do not match their hash.', { jobId: job.id });
  return doc;
}

const order = (a: { capturedAt: string; created: number; id: string }, b: { capturedAt: string; created: number; id: string }) =>
  Date.parse(a.capturedAt) - Date.parse(b.capturedAt) || a.created - b.created || a.id.localeCompare(b.id);

export async function compareJobs(tenantId: string, idA: string, idB: string): Promise<ComparisonDoc> {
  if (idA === idB) throw new TenancyError(400, 'validation_failed', 'Choose two different scans to compare.');
  const [a, b] = [await jobRow(tenantId, idA), await jobRow(tenantId, idB)];
  if (a.subject_ref !== b.subject_ref) throw new TenancyError(409, 'different_subjects', 'These scans are not of the same subject.');
  if (a.skill_id !== b.skill_id) throw new TenancyError(409, 'different_skills', 'These scans were interpreted under different skills and cannot be compared.');
  const [da, db_] = [await loadDoc(a), await loadDoc(b)];
  const sa = { jobId: a.id, doc: da, capturedAt: da.capturedAt, created: Number(a.created_at), id: a.id }, sb = { jobId: b.id, doc: db_, capturedAt: db_.capturedAt, created: Number(b.created_at), id: b.id };
  const [earlier, later] = order(sa, sb) <= 0 ? [sa, sb] : [sb, sa];
  return compareScans({ jobId: earlier.jobId, doc: earlier.doc }, { jobId: later.jobId, doc: later.doc });
}

export interface TimelineItem { jobId: string; skillId: string; status: string; capturedAt: string; findingsSha256: string | null; self: boolean; report: { reportId: string; version: number; reviewState: string | null } | null }
export interface Timeline { skillId: string; count: number; truncated: boolean; items: TimelineItem[]; series?: { findingKey: string; points: SeriesPoint[]; steps: SeriesStep[] } }

export async function timelineFor(tenantId: string, id: string, opts: { skillId?: string; findingKey?: string; limit?: number } = {}): Promise<Timeline> {
  const job = await jobRow(tenantId, id);
  const skillId = opts.skillId ?? job.skill_id;
  if (!SKILL_RE.test(skillId)) throw new TenancyError(400, 'validation_failed', 'skillId is not valid.');
  if (opts.findingKey !== undefined && !KEY_RE.test(opts.findingKey)) throw new TenancyError(400, 'validation_failed', 'findingKey is not valid.');
  const limit = Math.min(MAX_TIMELINE, Math.max(1, opts.limit ?? 50));

  const rows = await db.query<JobRow & { rid: string | null; rversion: number | null; rstate: string | null }>(
    `SELECT j.id, j.tenant_id, j.skill_id, j.subject_ref, j.status, j.captured_at, j.findings_sha256, j.created_at, r.id AS rid, r.version AS rversion, r.review_state AS rstate
     FROM interpretation_jobs j
     LEFT JOIN LATERAL (SELECT id, version, review_state FROM interpretation_reports WHERE job_id = j.id AND status = 'ready' ORDER BY version DESC LIMIT 1) r ON TRUE
     WHERE j.tenant_id = $1 AND j.subject_ref = $2 AND j.skill_id = $3 AND j.status <> 'erased' ORDER BY j.created_at ASC LIMIT 1000`, [tenantId, job.subject_ref, skillId]);
  const sorted = rows.map((r) => ({ r, capturedAt: r.captured_at, created: Number(r.created_at), id: r.id })).sort(order);
  const truncated = sorted.length > limit;
  const kept = sorted.slice(-limit);
  const items: TimelineItem[] = kept.map(({ r }) => ({
    jobId: r.id, skillId: r.skill_id, status: r.status, capturedAt: r.captured_at, findingsSha256: r.findings_sha256 ?? null, self: r.id === job.id,
    report: r.rid ? { reportId: r.rid, version: Number(r.rversion), reviewState: r.rstate ?? null } : null,
  }));
  const out: Timeline = { skillId, count: items.length, truncated, items };
  if (opts.findingKey) {
    const scans: ScanInput[] = [];
    for (const { r } of kept) if (r.status === 'completed') scans.push({ jobId: r.id, doc: await loadDoc(r) });
    out.series = { findingKey: opts.findingKey, ...buildSeries(opts.findingKey, scans) };
  }
  return out;
}
