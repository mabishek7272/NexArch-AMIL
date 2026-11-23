/**
 * Operations views and actions (interpretation engine, P6c): processing history, the webhook delivery log, usage and model
 * spend, and an audit-chain check. Everything here is about PROCESSING, not people: no subject reference, identity, finding
 * value or report text is ever returned, so an operator can run the system without seeing patient data.
 *
 * The only actions are re-queueing (a failed job, a failed report at the stage that failed, a dead webhook delivery). Each is
 * audited in the tenant's chain under the verified person who asked.
 */
import { db } from '../../db';
import { contentHash } from '../../cds/hashing';
import { COUNTED_SQL, spendConfigFromEnv } from '../../ai/spend';
import { TenancyError } from '../tenancy/keys';
import { AuditCtx, ensureTenantAuditReady, readTenantAudit, recordTenantEvent } from '../tenancy/audit';

const JOB_ID = /^job_[0-9a-f]{24}$/; const REPORT_ID = /^rpt_[0-9a-f]{24}$/; const DLV_ID = /^dlv_[0-9a-f]{24}$/;
const TENANT_ID = /^[A-Za-z0-9-]{1,64}$/; const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const JOB_STATUSES = ['queued', 'processing', 'completed', 'failed', 'erased'];
export const DELIVERY_STATUSES = ['pending', 'sending', 'delivered', 'dead'];
const bad = (m: string) => new TenancyError(400, 'validation_failed', m);
const page = (limit?: number, offset?: number) => ({ limit: Math.min(100, Math.max(1, Number.isFinite(limit) && limit ? limit : 25)), offset: Math.max(0, Number.isFinite(offset) && offset ? offset : 0) });
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// ── overview ─────────────────────────────────────────────────────────────────────────────────

export async function overview(now = Date.now()) {
  const day = now - 24 * 3600 * 1000, week = now - 7 * 24 * 3600 * 1000;
  const count = async (sql: string, params: unknown[] = []) => Object.fromEntries((await db.query<{ k: string; n: number }>(sql, params)).map((r) => [r.k, Number(r.n)]));
  const jobs = await count('SELECT status AS k, COUNT(*)::int AS n FROM interpretation_jobs GROUP BY status');
  const jobs24 = await count('SELECT status AS k, COUNT(*)::int AS n FROM interpretation_jobs WHERE created_at >= $1 GROUP BY status', [day]);
  const reports = await count(`SELECT status AS k, COUNT(*)::int AS n FROM interpretation_reports GROUP BY status`);
  const review = await count(`SELECT COALESCE(review_state, 'none') AS k, COUNT(*)::int AS n FROM interpretation_reports WHERE status = 'ready' GROUP BY 1`);
  const deliveries = await count('SELECT status AS k, COUNT(*)::int AS n FROM webhook_deliveries GROUP BY status');
  const oldest = await db.queryOne<{ t: string | null }>(`SELECT MIN(created_at) AS t FROM interpretation_jobs WHERE status = 'queued'`);
  const oldestReport = await db.queryOne<{ t: string | null }>(`SELECT MIN(created_at) AS t FROM interpretation_reports WHERE status IN ('queued','governed','narrated')`);
  const errors = await db.query<{ code: string; source: string; n: number }>(
    `SELECT error_code AS code, 'job' AS source, COUNT(*)::int AS n FROM interpretation_jobs WHERE status = 'failed' AND updated_at >= $1 AND error_code IS NOT NULL GROUP BY error_code
     UNION ALL SELECT error_code, 'report', COUNT(*)::int FROM interpretation_reports WHERE status = 'failed' AND updated_at >= $1 AND error_code IS NOT NULL GROUP BY error_code
     ORDER BY n DESC LIMIT 10`, [week]);
  const done24 = (jobs24.completed ?? 0), failed24 = (jobs24.failed ?? 0);
  return {
    generatedAt: now, jobs, jobsLast24h: jobs24, reports, reviewStates: review, webhookDeliveries: deliveries,
    oldestQueuedJobAgeSeconds: oldest?.t ? Math.max(0, Math.floor((now - Number(oldest.t)) / 1000)) : null,
    oldestPendingReportAgeSeconds: oldestReport?.t ? Math.max(0, Math.floor((now - Number(oldestReport.t)) / 1000)) : null,
    failureRateLast24h: done24 + failed24 === 0 ? null : Math.round((failed24 / (done24 + failed24)) * 1000) / 1000,
    topErrorCodesLast7d: errors.map((e) => ({ code: e.code, source: e.source, count: Number(e.n) })),
  };
}

// ── processing history ───────────────────────────────────────────────────────────────────────

export interface JobFilter { tenantId?: string; status?: string; skillId?: string; errorCode?: string; from?: number; to?: number; limit?: number; offset?: number }

export async function listJobs(f: JobFilter) {
  const where: string[] = []; const p: unknown[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
  if (f.tenantId) { if (!TENANT_ID.test(f.tenantId)) throw bad('tenantId is not valid.'); add('j.tenant_id = ?', f.tenantId); }
  if (f.status) { if (!JOB_STATUSES.includes(f.status)) throw bad(`status must be one of ${JOB_STATUSES.join(', ')}.`); add('j.status = ?', f.status); }
  if (f.skillId) { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(f.skillId)) throw bad('skillId is not valid.'); add('j.skill_id = ?', f.skillId); }
  if (f.errorCode) { if (!/^[a-z0-9_]{1,64}$/.test(f.errorCode)) throw bad('errorCode is not valid.'); add('j.error_code = ?', f.errorCode); }
  if (f.from !== undefined) add('j.created_at >= ?', f.from);
  if (f.to !== undefined) add('j.created_at < ?', f.to);
  const { limit, offset } = page(f.limit, f.offset);
  p.push(limit, offset);
  const rows = await db.query(
    `SELECT j.id, j.tenant_id, t.company_name, j.skill_id, j.analysis_type, j.status, j.attempts, j.max_attempts, j.error_code, j.adapter_id, j.adapter_version, j.created_at, j.updated_at, j.completed_at,
            r.id AS report_id, r.version AS report_version, r.status AS report_status, r.review_state, r.error_code AS report_error
     FROM interpretation_jobs j LEFT JOIN tenants t ON t.tenant_id = j.tenant_id
     LEFT JOIN LATERAL (SELECT id, version, status, review_state, error_code FROM interpretation_reports WHERE job_id = j.id ORDER BY version DESC LIMIT 1) r ON TRUE
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY j.created_at DESC, j.id DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
  return {
    items: rows.map((r: any) => ({
      jobId: r.id, tenantId: r.tenant_id, tenantName: r.company_name ?? null, skillId: r.skill_id, analysisType: r.analysis_type, status: r.status, attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts),
      errorCode: r.error_code ?? null, adapter: r.adapter_id ? `${r.adapter_id}@${r.adapter_version}` : null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), completedAt: num(r.completed_at),
      report: r.report_id ? { reportId: r.report_id, version: Number(r.report_version), status: r.report_status, reviewState: r.review_state ?? null, errorCode: r.report_error ?? null } : null,
    })),
    limit, offset,
  };
}

export async function jobDetail(jobId: string) {
  if (!JOB_ID.test(jobId)) throw new TenancyError(404, 'not_found', 'Job not found.');
  const j = await db.queryOne<any>('SELECT j.*, t.company_name FROM interpretation_jobs j LEFT JOIN tenants t ON t.tenant_id = j.tenant_id WHERE j.id = $1', [jobId]);
  if (!j) throw new TenancyError(404, 'not_found', 'Job not found.');
  const reports = await db.query('SELECT id, version, supersedes_id, status, attempts, max_attempts, error_code, review_state, narrative_mode, model_requested, model_returned, created_at, updated_at, ready_at FROM interpretation_reports WHERE job_id = $1 ORDER BY version DESC', [jobId]);
  const deliveries = await db.query('SELECT id, event_type, status, attempts, last_status_code, last_error, run_after, created_at, delivered_at, dead_at FROM webhook_deliveries WHERE job_id = $1 ORDER BY created_at, id', [jobId]);
  // The tenant's chain entries about this job: type, time and actor only (never the payload).
  const entries = j.status === 'erased' ? [] : (await readTenantAudit(j.tenant_id)).entries.filter((e: any) => JSON.stringify(e.payload ?? {}).includes(jobId)).map((e: any) => ({ seq: e.seq, timestamp: e.timestamp, eventType: e.event_type, actor: e.actor }));
  return {
    job: {
      jobId: j.id, tenantId: j.tenant_id, tenantName: j.company_name ?? null, skillId: j.skill_id, analysisType: j.analysis_type, status: j.status, attempts: Number(j.attempts), maxAttempts: Number(j.max_attempts), errorCode: j.error_code ?? null,
      adapter: j.adapter_id ? `${j.adapter_id}@${j.adapter_version}` : null, originalPayloadSha256: j.original_payload_sha256 ?? null, findingsSha256: j.findings_sha256 ?? null,
      createdAt: Number(j.created_at), updatedAt: Number(j.updated_at), completedAt: num(j.completed_at), runAfter: Number(j.run_after), claimed: j.claim_token !== null,
    },
    reports: reports.map((r: any) => ({ reportId: r.id, version: Number(r.version), supersedesId: r.supersedes_id ?? null, status: r.status, attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts), errorCode: r.error_code ?? null, reviewState: r.review_state ?? null, narrativeMode: r.narrative_mode ?? null, modelRequested: r.model_requested ?? null, modelReturned: r.model_returned ?? null, createdAt: Number(r.created_at), readyAt: num(r.ready_at) })),
    deliveries: deliveries.map(deliveryView),
    events: entries,
  };
}

const actorCtx = (actor: string): AuditCtx => ({ actor, declaredActor: null, requestId: null });

export async function retryJob(jobId: string, actor: string, now = Date.now()): Promise<{ jobId: string; status: 'queued' }> {
  if (!JOB_ID.test(jobId)) throw new TenancyError(404, 'not_found', 'Job not found.');
  await ensureTenantAuditReady();
  return db.transaction(async (tx) => {
    const j = (await tx.query<any>('SELECT id, tenant_id, status, error_code FROM interpretation_jobs WHERE id = $1 FOR UPDATE', [jobId])).rows[0];
    if (!j) throw new TenancyError(404, 'not_found', 'Job not found.');
    if (j.status !== 'failed') throw new TenancyError(409, 'not_retryable', `Only a failed job can be retried (status: ${j.status}).`);
    const src = await tx.query('SELECT 1 FROM source_payloads WHERE job_id = $1', [jobId]);
    if (!src.rows.length) throw new TenancyError(409, 'not_retryable', 'The source payload is no longer available.');
    await tx.query(`UPDATE interpretation_jobs SET status = 'queued', attempts = 0, error_code = NULL, run_after = $2, claim_token = NULL, lease_expires_at = NULL, completed_at = NULL, updated_at = $2 WHERE id = $1`, [jobId, now]);
    await recordTenantEvent(tx, j.tenant_id, actorCtx(actor), 'interpretation.job_retried', { job_id: jobId, previous_error_code: j.error_code });
    return { jobId, status: 'queued' as const };
  });
}

/** Re-queues a failed report at the stage that failed: what a stage already stored is immutable, so the pipeline resumes after it. */
export async function retryReport(reportId: string, actor: string, now = Date.now()): Promise<{ reportId: string; resumesAt: 'queued' | 'governed' | 'narrated' }> {
  if (!REPORT_ID.test(reportId)) throw new TenancyError(404, 'not_found', 'Report not found.');
  await ensureTenantAuditReady();
  return db.transaction(async (tx) => {
    const r = (await tx.query<any>('SELECT id, job_id, tenant_id, version, status, error_code, governance_json, narrative_json FROM interpretation_reports WHERE id = $1 FOR UPDATE', [reportId])).rows[0];
    if (!r) throw new TenancyError(404, 'not_found', 'Report not found.');
    if (r.status !== 'failed') throw new TenancyError(409, 'not_retryable', `Only a failed report can be retried (status: ${r.status}).`);
    const newer = await tx.query('SELECT 1 FROM interpretation_reports WHERE job_id = $1 AND version > $2 LIMIT 1', [r.job_id, r.version]);
    if (newer.rows.length) throw new TenancyError(409, 'not_retryable', 'A newer version exists.');
    const job = (await tx.query<any>('SELECT status FROM interpretation_jobs WHERE id = $1', [r.job_id])).rows[0];
    if (!job || job.status !== 'completed') throw new TenancyError(409, 'not_retryable', 'The interpretation is no longer available.');
    const resumesAt = !r.governance_json ? 'queued' as const : !r.narrative_json ? 'governed' as const : 'narrated' as const;
    await tx.query(`UPDATE interpretation_reports SET status = $2, attempts = 0, error_code = NULL, run_after = $3, claim_token = NULL, lease_expires_at = NULL, updated_at = $3 WHERE id = $1`, [reportId, resumesAt, now]);
    await recordTenantEvent(tx, r.tenant_id, actorCtx(actor), 'interpretation.report_retried', { report_id: reportId, job_id: r.job_id, version: Number(r.version), previous_error_code: r.error_code, resumes_at: resumesAt });
    return { reportId, resumesAt };
  });
}

// ── webhooks ─────────────────────────────────────────────────────────────────────────────────

const deliveryView = (d: any) => ({
  deliveryId: d.id, eventType: d.event_type, status: d.status, attempts: Number(d.attempts), lastStatusCode: d.last_status_code ?? null, lastError: d.last_error ?? null,
  nextAttemptAt: d.status === 'pending' ? Number(d.run_after) : null, createdAt: Number(d.created_at), deliveredAt: num(d.delivered_at), deadAt: num(d.dead_at),
});

export async function listDeliveries(f: { tenantId?: string; status?: string; eventType?: string; limit?: number; offset?: number }) {
  const where: string[] = []; const p: unknown[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
  if (f.tenantId) { if (!TENANT_ID.test(f.tenantId)) throw bad('tenantId is not valid.'); add('d.tenant_id = ?', f.tenantId); }
  if (f.status) { if (!DELIVERY_STATUSES.includes(f.status)) throw bad(`status must be one of ${DELIVERY_STATUSES.join(', ')}.`); add('d.status = ?', f.status); }
  if (f.eventType) { if (!/^[a-z_.]{1,40}$/.test(f.eventType)) throw bad('eventType is not valid.'); add('d.event_type = ?', f.eventType); }
  const { limit, offset } = page(f.limit, f.offset); p.push(limit, offset);
  const rows = await db.query(
    `SELECT d.*, t.company_name FROM webhook_deliveries d LEFT JOIN tenants t ON t.tenant_id = d.tenant_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY d.created_at DESC, d.id DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
  return { items: rows.map((d: any) => ({ ...deliveryView(d), tenantId: d.tenant_id, tenantName: d.company_name ?? null, jobId: d.job_id, eventId: d.event_id })), limit, offset };
}

export async function redeliver(deliveryId: string, actor: string, now = Date.now()): Promise<{ deliveryId: string; status: 'pending' }> {
  if (!DLV_ID.test(deliveryId)) throw new TenancyError(404, 'not_found', 'Delivery not found.');
  await ensureTenantAuditReady();
  return db.transaction(async (tx) => {
    const d = (await tx.query<any>('SELECT id, tenant_id, job_id, event_id, event_type, status, payload_json FROM webhook_deliveries WHERE id = $1 FOR UPDATE', [deliveryId])).rows[0];
    if (!d) throw new TenancyError(404, 'not_found', 'Delivery not found.');
    if (d.status !== 'dead') throw new TenancyError(409, 'not_redeliverable', `Only a dead delivery can be sent again (status: ${d.status}).`);
    if (d.payload_json.includes('"erased":true')) throw new TenancyError(409, 'not_redeliverable', 'The data for this event was erased.');
    // The same bytes and the same event id go out again, so a receiver that already saw it can ignore it; the 24-hour window restarts.
    await tx.query(`UPDATE webhook_deliveries SET status = 'pending', attempts = 0, run_after = $2, first_attempt_at = NULL, dead_at = NULL, last_error = NULL, last_status_code = NULL, claim_token = NULL, lease_expires_at = NULL, updated_at = $2 WHERE id = $1`, [deliveryId, now]);
    await recordTenantEvent(tx, d.tenant_id, actorCtx(actor), 'webhook.redelivery_requested', { delivery_id: deliveryId, event_id: d.event_id, event_type: d.event_type, job_id: d.job_id });
    return { deliveryId, status: 'pending' as const };
  });
}

/** Each tenant's endpoint: where deliveries go (scheme and host only, since a path or query can carry a token) and whether it is on. Never the secret. */
export async function listEndpoints() {
  const rows = await db.query(`SELECT w.tenant_id, t.company_name, w.url, w.enabled, w.secret_rotated_at, w.updated_at FROM tenant_webhooks w LEFT JOIN tenants t ON t.tenant_id = w.tenant_id ORDER BY t.company_name`);
  return rows.map((r: any) => {
    let origin = 'invalid'; try { origin = new URL(r.url).origin; } catch { /* leave */ }
    return { tenantId: r.tenant_id, tenantName: r.company_name ?? null, endpoint: origin, enabled: !!r.enabled, secretRotatedAt: Number(r.secret_rotated_at), updatedAt: Number(r.updated_at) };
  });
}

// ── usage and spend ──────────────────────────────────────────────────────────────────────────

export async function usage(opts: { from?: string; to?: string; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const to = opts.to ?? new Date(now).toISOString().slice(0, 10);
  const from = opts.from ?? new Date(now - 29 * 86400000).toISOString().slice(0, 10);
  if (!DAY.test(from) || !DAY.test(to) || from > to) throw bad('from and to must be days (YYYY-MM-DD), from not after to.');
  const fromMs = Date.parse(`${from}T00:00:00Z`), toMs = Date.parse(`${to}T00:00:00Z`) + 86400000;
  const tenants = await db.query(`SELECT tenant_id, company_name, plan, status, usage_this_month, usage_total, rate_limit_per_min, last_active_at FROM tenants ORDER BY company_name LIMIT 500`);
  const jobs = await db.query<{ tenant_id: string; status: string; n: number }>(`SELECT tenant_id, status, COUNT(*)::int AS n FROM interpretation_jobs WHERE created_at >= $1 AND created_at < $2 GROUP BY tenant_id, status`, [fromMs, toMs]);
  const spend = await db.query<any>(
    `SELECT scope_id, COUNT(*)::int AS calls, COALESCE(SUM(CASE WHEN state = 'settled' THEN actual_usd END), 0) AS known_usd,
            COALESCE(SUM(${COUNTED_SQL}), 0) AS counted_usd, COUNT(*) FILTER (WHERE state = 'unknown_cost')::int AS unknown_calls
     FROM model_spend_ledger WHERE scope_kind = 'tenant' AND period >= $1 AND period <= $2 GROUP BY scope_id`, [from, to]);
  const sys = await db.queryOne<any>(`SELECT COUNT(*)::int AS calls, COALESCE(SUM(CASE WHEN state = 'settled' THEN actual_usd END), 0) AS known_usd, COUNT(*) FILTER (WHERE state = 'unknown_cost')::int AS unknown_calls FROM model_spend_ledger WHERE period >= $1 AND period <= $2`, [from, to]);
  const cfg = spendConfigFromEnv();
  const byTenantJobs = new Map<string, Record<string, number>>(); for (const j of jobs) byTenantJobs.set(j.tenant_id, { ...(byTenantJobs.get(j.tenant_id) ?? {}), [j.status]: Number(j.n) });
  const bySpend = new Map<string, any>(spend.map((s: any) => [s.scope_id, s]));
  return {
    from, to,
    tenants: tenants.map((t: any) => {
      const s = bySpend.get(t.tenant_id);
      return {
        tenantId: t.tenant_id, tenantName: t.company_name, plan: t.plan, status: t.status, requestsThisMonth: Number(t.usage_this_month ?? 0), requestsTotal: Number(t.usage_total ?? 0), rateLimitPerMin: num(t.rate_limit_per_min), lastActiveAt: t.last_active_at ? String(t.last_active_at) : null,
        jobs: byTenantJobs.get(t.tenant_id) ?? {}, modelCalls: s ? Number(s.calls) : 0, modelSpendKnownUsd: s ? Number(s.known_usd) : 0, modelSpendCountedUsd: s ? Number(s.counted_usd) : 0, modelCallsWithUnknownCost: s ? Number(s.unknown_calls) : 0,
      };
    }),
    modelSpend: {
      allScopes: { calls: Number(sys?.calls ?? 0), knownUsd: Number(sys?.known_usd ?? 0), callsWithUnknownCost: Number(sys?.unknown_calls ?? 0) },
      totalIsLowerBound: Number(sys?.unknown_calls ?? 0) > 0,
      budget: { globalDailyUsd: cfg.globalBudgetUsd, perScopeDailyUsd: cfg.scopeBudgetUsd, enforced: cfg.globalBudgetUsd !== null || cfg.scopeBudgetUsd !== null || cfg.invalid.length > 0, configurationErrors: cfg.invalid },
      note: 'Costs are provider-reported. A call whose cost is missing or invalid counts as unknown and is not in the known total, so the real total can be higher. The budget is admission control, not a hard cap on charges.',
    },
  };
}

// ── audit chain check ────────────────────────────────────────────────────────────────────────

export async function verifyAudit(tenantId?: string) {
  if (tenantId !== undefined && !TENANT_ID.test(tenantId)) throw bad('tenantId is not valid.');
  const tenants = tenantId
    ? await db.query<{ tenant_id: string; company_name: string }>('SELECT tenant_id, company_name FROM tenants WHERE tenant_id = $1', [tenantId])
    : await db.query<{ tenant_id: string; company_name: string }>('SELECT tenant_id, company_name FROM tenants ORDER BY company_name LIMIT 500');
  if (tenantId && !tenants.length) throw new TenancyError(404, 'tenant_not_found', 'Tenant not found.');
  const results: Array<{ tenantId: string; tenantName: string; entries: number; valid: boolean; brokenAt?: number; reason?: string; headHash: string | null }> = [];
  for (const t of tenants) {
    const { entries, verification } = await readTenantAudit(t.tenant_id);
    results.push({ tenantId: t.tenant_id, tenantName: t.company_name, entries: entries.length, valid: verification.valid, ...(verification.valid ? {} : { brokenAt: verification.brokenAt, reason: verification.reason }), headHash: entries.length ? (entries[entries.length - 1] as any).entry_hash : null });
  }
  const checkedAt = Date.now();
  return { checkedAt, tenantsChecked: results.length, allValid: results.every((r) => r.valid), results, fingerprint: contentHash(results.map((r) => [r.tenantId, r.entries, r.headHash])) };
}
