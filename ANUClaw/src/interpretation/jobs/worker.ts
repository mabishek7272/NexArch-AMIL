/**
 * Interpretation worker (interpretation engine, P3a): claims a job, runs the tenant's adapter, validates the result
 * against normalized-findings/v1 and commits it, all fenced by the claim token. Opt-in: started by `src/index.ts`
 * only when ANUCLAW_INTERPRETATION_WORKER=true. P3 makes no model call; governance and the LLM stage come in P4.
 */
import * as crypto from 'crypto';
import { db } from '../../db';
import { logger } from '../../logger';
import { contentHash } from '../../cds/hashing';
import { getSkill } from '../skills/registry';
import { getAdapterImplementation } from '../adapters';
import { AdapterError, StoredRequest } from '../adapters/types';
import { validateNormalizedFindings } from '../contracts/validate';
import { AuditCtx, ensureTenantAuditReady, recordTenantEvent } from '../tenancy/audit';
import { enqueueWebhookEvent } from '../webhooks/outbox';
import { ClaimedJob, claimNextJob, failAttempt, heartbeat } from './queue';

export const RULESET = { id: 'intake-normalisation', version: '1.0.0' } as const;
const WORKER_CTX: AuditCtx = { actor: 'system:interpretation-worker', declaredActor: null, requestId: null };

export type ProcessOutcome = 'completed' | 'retry' | 'failed' | 'lost';

/** `hooks.beforeCommit` is a test seam: it runs after the adapter finished and before the fenced commit. */
export async function processJob(job: ClaimedJob, now = () => Date.now(), hooks: { beforeCommit?: () => Promise<void> } = {}): Promise<ProcessOutcome> {
  const row = await db.queryOne<{ payload_json: string; payload_sha256: string }>('SELECT payload_json, payload_sha256 FROM source_payloads WHERE job_id = $1', [job.id]);
  if (!row) return failAttempt(job, 'source_payload_missing', true, now());
  const req = JSON.parse(row.payload_json) as StoredRequest;

  const skill = await getSkill(job.skill_id);
  const adapterId = typeof skill?.manifest.adapterId === 'string' ? skill.manifest.adapterId : '';
  const adapter = getAdapterImplementation(adapterId);
  if (!adapter) return failAttempt(job, 'adapter_unavailable', true, now());

  let out;
  try {
    if (!(await heartbeat(job.id, job.claim_token, now()))) return 'lost';
    out = adapter.run(req);
  } catch (e) {
    if (e instanceof AdapterError) return failAttempt(job, e.code, true, now());
    logger.error(`interpretation adapter ${adapterId} threw on job ${job.id}`); // never log the error text: it may echo payload values
    return failAttempt(job, 'adapter_error', false, now());
  }

  const sourceModel: Record<string, string> = {};
  for (const k of ['application', 'modelName', 'modelVersion', 'calibrationVersion', 'researchStatus'] as const) {
    const v = req.source[k]; if (v !== undefined) sourceModel[k] = v;
  }
  // The hash covers everything the reports will rely on, so the two layers cannot differ about verification, exclusions or symptoms.
  const findingsSha256 = contentHash({ findings: out.findings, flags: out.flags, sourceVerification: out.sourceVerification ?? null, notMeasurable: out.notMeasurable ?? null, symptoms: out.symptoms ?? null });
  const doc = {
    schemaVersion: 'normalized-findings/v1', jobId: job.id, tenantId: job.tenant_id, skillId: job.skill_id,
    subjectRef: req.subject.externalRef, capturedAt: req.acquisition.capturedAt,
    findings: out.findings, flags: out.flags,
    ...(out.sourceVerification ? { sourceVerification: out.sourceVerification } : {}),
    ...(out.notMeasurable ? { notMeasurable: out.notMeasurable } : {}),
    ...(out.symptoms ? { symptoms: out.symptoms } : {}),
    provenance: { adapter: { id: adapter.id, version: adapter.version }, sourceModel, ruleset: { ...RULESET }, originalPayloadSha256: row.payload_sha256 },
    findingsSha256,
  };
  const v = validateNormalizedFindings(doc);
  if (!v.ok) { logger.error(`interpretation job ${job.id}: adapter output failed normalized-findings/v1`); return failAttempt(job, 'normalized_findings_invalid', true, now()); }

  await ensureTenantAuditReady();
  await hooks.beforeCommit?.();
  const t = now();
  return db.transaction(async (tx) => {
    const upd = await tx.query(
      `UPDATE interpretation_jobs SET status = 'completed', findings_sha256 = $3, adapter_id = $4, adapter_version = $5, error_code = NULL,
         claim_token = NULL, lease_expires_at = NULL, updated_at = $6, completed_at = $6
       WHERE id = $1 AND claim_token = $2 AND status = 'processing' RETURNING id`,
      [job.id, job.claim_token, findingsSha256, adapter.id, adapter.version, t]);
    if (!upd.rows.length) return 'lost' as const; // superseded: leave the newer attempt's state alone
    await tx.query(`INSERT INTO normalized_findings (job_id, tenant_id, findings_sha256, document_json, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [job.id, job.tenant_id, findingsSha256, JSON.stringify(doc), t]);
    await recordTenantEvent(tx, job.tenant_id, WORKER_CTX, 'interpretation.completed', { job_id: job.id, findings_sha256: findingsSha256, adapter_id: adapter.id, adapter_version: adapter.version });
    // A skill that names prompts produces reports: queue the report in the same transaction as the completion.
    const prompts = skill?.manifest.prompts as Record<string, unknown> | undefined;
    if (prompts && typeof prompts === 'object' && Object.keys(prompts).length > 0) {
      await tx.query(
        `INSERT INTO interpretation_reports (id, job_id, tenant_id, version, status, findings_sha256, run_after, created_at, updated_at)
         VALUES ($1,$2,$3,1,'queued',$4,$5,$5,$5) ON CONFLICT (job_id, version) DO NOTHING`,
        [`rpt_${crypto.randomBytes(12).toString('hex')}`, job.id, job.tenant_id, findingsSha256, t]);
    }
    // Same transaction: the notification exists if and only if the completion committed.
    await enqueueWebhookEvent(tx, job.tenant_id, 'interpretation.completed', { jobId: job.id, skillId: job.skill_id, status: 'completed', findingsSha256 }, t);
    return 'completed' as const;
  });
}

/** Claims and processes at most one job. Returns null when the queue is empty. */
export async function runOnce(now = () => Date.now()): Promise<ProcessOutcome | null> {
  const job = await claimNextJob(now());
  if (!job) return null;
  try { return await processJob(job, now); } catch (e) {
    logger.error(`interpretation job ${job.id} failed unexpectedly`);
    return failAttempt(job, 'worker_error', false, now());
  }
}

export interface WorkerHandle { stop(): Promise<void> }

export function startInterpretationWorker(opts: { intervalMs?: number } = {}): WorkerHandle {
  const interval = opts.intervalMs ?? 2000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();
  const tick = (): void => {
    current = (async () => {
      try { while (!stopped && (await runOnce()) !== null) { /* drain */ } } catch (e) { logger.error('interpretation worker tick failed'); }
      if (!stopped) timer = setTimeout(tick, interval);
    })();
  };
  tick();
  return { async stop() { stopped = true; if (timer) clearTimeout(timer); await current; } };
}
