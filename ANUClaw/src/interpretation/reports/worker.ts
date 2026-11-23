/**
 * Report worker (interpretation engine, P4): claims a report and runs ONE stage of its pipeline, all fenced by the claim
 * token. Opt-in (ANUCLAW_REPORT_WORKER=true).
 *
 *   queued   -> generating -> governed    stage 1: deterministic governance over the stored findings (no model)
 *   governed -> narrating  -> narrated    stage 2: the explanation text (a model only if the tenant enabled it), guarded
 *   narrated -> assembling -> ready       stage 3: assemble the two report layers (no model) and queue the report_ready event
 *
 * Each stage commits independently and resets the attempt counter, so a retry repeats only the stage that failed.
 */
import { db } from '../../db';
import { logger } from '../../logger';
import { contentHash } from '../../cds/hashing';
import { getAdapterImplementation } from '../adapters';
import type { NormalizedFlag } from '../adapters/types';
import type { Narrative } from '../narrative/types';
import { enqueueReportEvent } from '../webhooks/outbox';
import { assembleLayers } from './assemble';
import { automaticReview } from './review';
import { validateGovernance } from '../contracts/validate';
import { EMPTY_CONTEXT, FindingsDoc, GovernanceDoc, governFindings } from '../governance';
import { generateNarratives, type GenerateDeps } from '../narrative/generate';
import { resolveNarrativeSettings } from '../narrative/settings';
import { getSkill } from '../skills/registry';
import { AuditCtx, ensureTenantAuditReady, recordTenantEvent } from '../tenancy/audit';
import { ClaimedReport, claimNextReport, failReport, heartbeatReport } from './queue';

const WORKER_CTX: AuditCtx = { actor: 'system:report-worker', declaredActor: null, requestId: null };

export type ReportOutcome = 'governed' | 'narrated' | 'ready' | 'retry' | 'failed' | 'lost';
export interface ReportHooks { /** test seam: runs after a stage finished its work and before its fenced commit */ beforeCommit?: () => Promise<void> }
export interface ReportDeps { narrative?: GenerateDeps }

async function loadFindings(r: ClaimedReport): Promise<FindingsDoc | null> {
  const row = await db.queryOne<{ document_json: string }>('SELECT document_json FROM normalized_findings WHERE job_id = $1 AND tenant_id = $2', [r.job_id, r.tenant_id]);
  return row ? (JSON.parse(row.document_json) as FindingsDoc) : null;
}

// ── stage 1: governance ──────────────────────────────────────────────────────────────────────

async function governStage(r: ClaimedReport, now: () => number, hooks: ReportHooks): Promise<ReportOutcome> {
  const doc = await loadFindings(r);
  if (!doc) return failReport(r, 'findings_missing', true, now()); // erased, or never produced
  if (doc.findingsSha256 !== r.findings_sha256) return failReport(r, 'findings_hash_mismatch', true, now());

  // Governance needs the adapter's declarations (risk indicators, sanity bounds, units). Without them the advisory
  // triggers cannot be evaluated, so refuse rather than govern with nothing.
  const adapter = getAdapterImplementation(doc.provenance.adapter.id);
  if (!adapter) return failReport(r, 'adapter_unavailable', true, now());

  const gov = governFindings(doc, adapter.governance ?? EMPTY_CONTEXT, now());
  const valid = validateGovernance(gov);
  if (!valid.ok) { logger.error(`report ${r.id}: governance output failed governance/v1`); return failReport(r, 'governance_invalid', true, now()); }
  const governanceSha256 = contentHash(gov);

  await ensureTenantAuditReady();
  await hooks.beforeCommit?.();
  const t = now();
  return db.transaction(async (tx) => {
    const upd = await tx.query(
      `UPDATE interpretation_reports SET status = 'governed', governance_json = $3, governance_sha256 = $4, error_code = NULL, attempts = 0, run_after = $5,
         claim_token = NULL, lease_expires_at = NULL, updated_at = $5
       WHERE id = $1 AND claim_token = $2 AND status = 'generating' RETURNING id`,
      [r.id, r.claim_token, JSON.stringify(gov), governanceSha256, t]);
    if (!upd.rows.length) return 'lost' as const; // superseded: leave the newer attempt alone
    await recordTenantEvent(tx, r.tenant_id, WORKER_CTX, 'interpretation.governed', {
      report_id: r.id, job_id: r.job_id, governance_sha256: governanceSha256, ruleset_version: gov.ruleset.version,
      route_state: gov.route.state, referral: gov.referral !== null,
    });
    return 'governed' as const;
  });
}

// ── stage 2: narrative ───────────────────────────────────────────────────────────────────────

async function narrateStage(r: ClaimedReport, now: () => number, hooks: ReportHooks, deps: ReportDeps): Promise<ReportOutcome> {
  const doc = await loadFindings(r);
  if (!doc) return failReport(r, 'findings_missing', true, now());
  if (doc.findingsSha256 !== r.findings_sha256) return failReport(r, 'findings_hash_mismatch', true, now());

  const row = await db.queryOne<{ governance_json: string | null; governance_sha256: string | null }>('SELECT governance_json, governance_sha256 FROM interpretation_reports WHERE id = $1', [r.id]);
  if (!row?.governance_json) return failReport(r, 'governance_missing', true, now());
  const gov = JSON.parse(row.governance_json) as GovernanceDoc;
  // The governance output must be exactly what stage 1 stored, and about exactly these findings.
  if (contentHash(gov) !== row.governance_sha256 || gov.findingsSha256 !== doc.findingsSha256) return failReport(r, 'governance_integrity', true, now());

  const job = await db.queryOne<{ skill_id: string }>('SELECT skill_id FROM interpretation_jobs WHERE id = $1 AND tenant_id = $2', [r.job_id, r.tenant_id]);
  const skill = job ? await getSkill(job.skill_id) : undefined;
  const prompts = (skill?.manifest.prompts ?? {}) as { clinical?: string; layman?: string };
  const assign = job ? await db.queryOne<{ config_json: string; enabled: boolean }>('SELECT config_json, enabled FROM tenant_skills WHERE tenant_id = $1 AND skill_id = $2', [r.tenant_id, job.skill_id]) : undefined;
  let config: Record<string, unknown> = {};
  try { if (assign?.config_json) config = JSON.parse(assign.config_json); } catch { /* an unreadable config means narratives off */ }
  const settings = resolveNarrativeSettings(config);

  const result = await generateNarratives({
    doc, gov, settings, tenantId: r.tenant_id, prompts,
    heartbeat: () => heartbeatReport(r.id, r.claim_token, now()),
  }, deps.narrative);

  const layerSummary = (l: 'clinical' | 'layman') => {
    const x = result.layers[l];
    return { source: x.source, attempts: x.attempts, ...(x.fallbackReason ? { fallbackReason: x.fallbackReason } : {}), problems: x.problems, ...(x.readingGrade !== undefined ? { readingGrade: x.readingGrade } : {}), ...(x.usage ? { usage: x.usage } : {}), ...(x.egressRedactions !== undefined ? { egressRedactions: x.egressRedactions } : {}) };
  };
  const guardResults = { layers: { clinical: layerSummary('clinical'), layman: layerSummary('layman') }, flags: result.flags };
  const modelRequested = settings.enabled ? settings.model : null;
  const modelReturned = result.layers.clinical.modelReturned ?? result.layers.layman.modelReturned ?? null;

  await ensureTenantAuditReady();
  await hooks.beforeCommit?.();
  const t = now();
  return db.transaction(async (tx) => {
    const upd = await tx.query(
      `UPDATE interpretation_reports SET status = 'narrated', narrative_json = $3, narrative_mode = $4, model_requested = $5, model_returned = $6,
         prompt_versions_json = $7, guard_results_json = $8, error_code = NULL, attempts = 0, run_after = $9, claim_token = NULL, lease_expires_at = NULL, updated_at = $9
       WHERE id = $1 AND claim_token = $2 AND status = 'narrating' RETURNING id`,
      [r.id, r.claim_token, JSON.stringify({ clinical: result.narratives.clinical, layman: result.narratives.layman }), result.mode, modelRequested, modelReturned,
        JSON.stringify(result.promptVersions), JSON.stringify(guardResults), t]);
    if (!upd.rows.length) return 'lost' as const;
    // Codes and counts only: never the text a model wrote or was shown.
    await recordTenantEvent(tx, r.tenant_id, WORKER_CTX, 'interpretation.narrated', {
      report_id: r.id, job_id: r.job_id, mode: result.mode, model_requested: modelRequested, model_returned: modelReturned, prompt_versions: result.promptVersions,
      layers: Object.fromEntries((['clinical', 'layman'] as const).map((l) => [l, { source: result.layers[l].source, attempts: result.layers[l].attempts, fallback_reason: result.layers[l].fallbackReason ?? null, problem_codes: [...new Set(result.layers[l].problems.map((p) => p.code))] }])),
    });
    return 'narrated' as const;
  });
}

// ── stage 3: assemble ────────────────────────────────────────────────────────────────────────

async function assembleStage(r: ClaimedReport, now: () => number, hooks: ReportHooks): Promise<ReportOutcome> {
  const doc = await loadFindings(r);
  if (!doc) return failReport(r, 'findings_missing', true, now());
  if (doc.findingsSha256 !== r.findings_sha256) return failReport(r, 'findings_hash_mismatch', true, now());
  const row = await db.queryOne<any>('SELECT governance_json, governance_sha256, narrative_json, narrative_mode, model_requested, model_returned, prompt_versions_json, guard_results_json FROM interpretation_reports WHERE id = $1', [r.id]);
  if (!row?.governance_json || !row.narrative_json || !row.narrative_mode || !row.prompt_versions_json) return failReport(r, 'stage_input_missing', true, now());
  const gov = JSON.parse(row.governance_json) as GovernanceDoc;
  if (contentHash(gov) !== row.governance_sha256 || gov.findingsSha256 !== doc.findingsSha256) return failReport(r, 'governance_integrity', true, now());

  const narratives = JSON.parse(row.narrative_json) as Record<'clinical' | 'layman', Narrative>;
  const guard = row.guard_results_json ? (JSON.parse(row.guard_results_json) as { flags?: NormalizedFlag[] }) : {};
  const narrativeFlags = guard.flags ?? [];
  const layers = assembleLayers({
    doc, gov, narratives, narrativeFlags, governanceSha256: row.governance_sha256,
    meta: { reportId: r.id, version: r.version, narrativeMode: row.narrative_mode, modelRequested: row.model_requested, modelReturned: row.model_returned, promptVersions: JSON.parse(row.prompt_versions_json) },
  });
  // The automatic review (deterministic, no model) decides between ai_reviewed and awaiting_clinician. It cannot produce clinician_signed.
  const review = automaticReview(doc, gov, layers, row.governance_sha256, narrativeFlags);
  const reviewState = review.state;
  const contentSha256 = contentHash({ clinical: layers.clinical, layman: layers.layman });
  await ensureTenantAuditReady();
  await hooks.beforeCommit?.();
  const t = now();
  return db.transaction(async (tx) => {
    const upd = await tx.query(
      `UPDATE interpretation_reports SET status = 'ready', clinical_json = $3, layman_json = $4, review_state = $5, ai_review_json = $7, content_sha256 = $8, follow_up = $9, error_code = NULL, attempts = 0,
         claim_token = NULL, lease_expires_at = NULL, updated_at = $6, ready_at = $6
       WHERE id = $1 AND claim_token = $2 AND status = 'assembling' RETURNING id`,
      [r.id, r.claim_token, JSON.stringify(layers.clinical), JSON.stringify(layers.layman), reviewState, t, JSON.stringify({ ...review, reviewedAt: new Date(t).toISOString() }), contentSha256, gov.route.followUp]);
    if (!upd.rows.length) return 'lost' as const;
    // A replacement for a rejected version: the rejected one is superseded only now that its replacement is ready.
    await tx.query(`UPDATE interpretation_reports SET status = 'superseded', updated_at = $2 WHERE id = (SELECT supersedes_id FROM interpretation_reports WHERE id = $1) AND status = 'ready' AND review_state = 'rejected'`, [r.id, t]);
    await recordTenantEvent(tx, r.tenant_id, WORKER_CTX, 'interpretation.report_ready', { report_id: r.id, job_id: r.job_id, version: r.version, review_state: reviewState, failed_checks: review.failedChecks, findings_sha256: doc.findingsSha256, content_sha256: contentSha256 });
    await enqueueReportEvent(tx, r.tenant_id, 'interpretation.report_ready', { jobId: r.job_id, reportId: r.id, version: r.version, findingsSha256: doc.findingsSha256, reviewState }, t);
    return 'ready' as const;
  });
}

/** `hooks.beforeCommit` is a test seam: it runs after a stage finished its work and before its fenced commit. */
export async function processReport(r: ClaimedReport, now = () => Date.now(), hooks: ReportHooks = {}, deps: ReportDeps = {}): Promise<ReportOutcome> {
  if (r.stage === 'assembling') return assembleStage(r, now, hooks);
  return r.stage === 'narrating' ? narrateStage(r, now, hooks, deps) : governStage(r, now, hooks);
}

/** Claims and processes at most one report stage. Returns null when nothing is due. */
export async function runOnce(now = () => Date.now(), deps: ReportDeps = {}): Promise<ReportOutcome | null> {
  const r = await claimNextReport(now());
  if (!r) return null;
  try { return await processReport(r, now, {}, deps); } catch {
    logger.error(`report ${r.id} failed unexpectedly`);
    return failReport(r, 'worker_error', false, now());
  }
}

export interface ReportWorkerHandle { stop(): Promise<void> }

export function startReportWorker(opts: { intervalMs?: number } = {}): ReportWorkerHandle {
  const interval = opts.intervalMs ?? 2000;
  let stopped = false; let timer: NodeJS.Timeout | undefined; let current: Promise<void> = Promise.resolve();
  const tick = (): void => {
    current = (async () => {
      try { while (!stopped && (await runOnce()) !== null) { /* drain */ } } catch { logger.error('report worker tick failed'); }
      if (!stopped) timer = setTimeout(tick, interval);
    })();
  };
  tick();
  return { async stop() { stopped = true; if (timer) clearTimeout(timer); await current; } };
}
