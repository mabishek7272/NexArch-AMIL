/**
 * Model spend tracking and budget enforcement (plan F16).
 *
 * What is and is not guaranteed
 *  - COST SOURCE: only the provider-reported `usage.cost`. Nothing is estimated from token counts.
 *    A missing, non-numeric, non-finite or negative cost is UNKNOWN (state `unknown_cost`), never 0.
 *    A reported cost of exactly 0 is a known zero.
 *  - BUDGET MATH: each call first inserts a durable RESERVATION in the same transaction that checks the
 *    budget (advisory lock per period, so concurrent callers serialise). Counted spend = settled actual +
 *    reserved amounts of anything not yet settled or of unknown cost (+ the known part of a partially known
 *    cost, whichever is larger). Unknown cost therefore counts CONSERVATIVELY at its reservation.
 *  - STRICTNESS (read carefully): the budget limits ADMISSION by reservation. It is NOT a hard cap on real provider
 *    charges. Each in-flight call may cost more than its reservation, and those excesses ACCUMULATE across concurrent
 *    calls (n calls can overshoot by the sum of their individual excesses); unknown-cost calls are counted at their
 *    reservation, which may be below what the provider really charged. The only hard cap on charges is one enforced
 *    by the provider (e.g. a credit limit on the API key), which this code cannot set. Reports show overruns.
 *  - CONFIGURATION: unset/empty budget = no budget. `0` = an explicit zero budget: every model call is refused.
 *    An invalid value (non-numeric, negative, non-finite, bad reservation JSON/role/amount) never becomes "unlimited":
 *    the tracker refuses all model calls (fail closed) and logs the offending variable name at startup.
 *  - LATE SETTLEMENT: a reservation swept as `unsettled_timeout` is settled with its real cost if the call finishes
 *    afterwards (note `late_settlement:…`); a settled row is never changed again.
 *  - RETRIES: reservation = per-call amount × (1 + retries). The provider reports cost only on the final response,
 *    so earlier billable attempts are unknowable: a call that needed retries settles as `unknown_cost`
 *    (note `incomplete_retries`) and is counted at its reservation.
 *  - FAILURE: if reservation accounting is unavailable and a budget is configured the call is REFUSED. With no
 *    budget configured the call proceeds, is reported `untracked_unavailable`, and a content-free error is logged.
 *    If settlement fails after the call, the reservation stays and keeps counting; the call result says so.
 *  - SCOPE: records carry the authenticated user/tenant (or `system`); budgets are global per UTC day and per scope.
 *  - No prompts, completions, provider bodies or credentials are ever stored or logged here.
 */
import * as crypto from 'crypto';
import { db } from '../db';
import { logger } from '../logger';
import { Accounting, Role, SpendContext, SpendHooks, SpendScope, setSpendHooks, CallStatus } from './openrouter';

export const DEFAULT_RESERVE_USD: Record<Role, number> = { ocr: 0.05, embedding: 0.005, decision: 0.01, review: 0.02 };
export const STALE_RESERVATION_MS = 15 * 60 * 1000;

export interface SpendConfig { globalBudgetUsd: number | null; scopeBudgetUsd: number | null; reserveUsd: Record<Role, number>; /** non-empty → every model call is refused */ invalid: string[] }

/** unset/blank → no budget; "0" → explicit zero budget; anything else must be a finite number ≥ 0. */
function budget(env: NodeJS.ProcessEnv, name: string, invalid: string[]): number | null {
  const v = env[name];
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v.trim());
  if (!Number.isFinite(n) || n < 0) { invalid.push(`${name} must be a finite number >= 0 (0 blocks all model calls; unset means no budget)`); return null; }
  return n;
}

export function spendConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SpendConfig {
  const reserveUsd = { ...DEFAULT_RESERVE_USD }, invalid: string[] = [];
  const raw = env.ANUCLAW_MODEL_RESERVE_USD;
  if (raw !== undefined && raw.trim() !== '') {
    try {
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('not an object');
      for (const [k, v] of Object.entries(o)) {
        if (!Object.hasOwn(reserveUsd, k)) { invalid.push(`ANUCLAW_MODEL_RESERVE_USD has an unknown role '${k}'`); continue; }
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) { invalid.push(`ANUCLAW_MODEL_RESERVE_USD.${k} must be a finite number > 0`); continue; }
        reserveUsd[k as Role] = v;
      }
    } catch { invalid.push('ANUCLAW_MODEL_RESERVE_USD must be a JSON object such as {"ocr":0.05}'); }
  }
  return { globalBudgetUsd: budget(env, 'ANUCLAW_MODEL_DAILY_BUDGET_USD', invalid), scopeBudgetUsd: budget(env, 'ANUCLAW_MODEL_DAILY_BUDGET_PER_SCOPE_USD', invalid), reserveUsd, invalid };
}

/** UTC calendar day; the reset boundary is 00:00:00 UTC. */
export function utcPeriod(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

/** A real calendar day (YYYY-MM-DD): rejects shapes like 2026-13-40 or 2026-02-30. */
export function isUtcDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export interface ParsedCost { usd: number | null; note: 'reported' | 'missing' | 'invalid' | 'negative' }
export function parseCost(raw: unknown): ParsedCost {
  if (raw === undefined || raw === null) return { usd: null, note: 'missing' };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return { usd: null, note: 'invalid' };
  if (raw < 0) return { usd: null, note: 'negative' };
  return { usd: raw, note: 'reported' };
}

export interface ReserveRequest { id: string; scope: SpendScope; period: string; role: Role; model: string; dataClass: string; amountUsd: number; now: number; globalBudgetUsd: number | null; scopeBudgetUsd: number | null }
export interface SettleRequest { state: 'settled' | 'unknown_cost'; actualUsd: number | null; costNote: string; returnedModel?: string; attempts: number; status: string; promptTokens?: number; completionTokens?: number; reasoningTokens?: number; now: number }
export interface ReportFilter { fromPeriod: string; toPeriod: string; scope?: SpendScope }
export interface ReportRow { period: string; role: string; model: string; calls: number; settledCalls: number; unknownCostCalls: number; releasedCalls: number; openReservations: number; knownCostUsd: number; countedUsd: number; attempts: number; overrunCalls: number; overrunUsd: number }

export interface SpendStore {
  tryReserve(r: ReserveRequest): Promise<{ ok: true } | { ok: false; reason: 'global_budget' | 'scope_budget' }>;
  /** false when the row is already settled/released (duplicate). A row swept as `unsettled_timeout` accepts ONE late settlement. */
  settle(id: string, s: SettleRequest): Promise<boolean>;
  release(id: string, now: number): Promise<boolean>;
  sweepStale(olderThanMs: number, now: number): Promise<number>;
  report(f: ReportFilter): Promise<ReportRow[]>;
}

/** Amount a row contributes to the budget. Unsettled/unknown rows count at their reservation (never at zero). */
export const COUNTED_SQL = `CASE state WHEN 'settled' THEN actual_usd WHEN 'released' THEN 0 ELSE GREATEST(reserved_usd, COALESCE(actual_usd, 0)) END`;

export function pgSpendStore(): SpendStore {
  return {
    async tryReserve(r) {
      return db.transaction(async (tx) => {
        // One lock per period: the budget check and the insert are atomic with respect to every other reservation.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`spend:${r.period}`]);
        if (r.globalBudgetUsd !== null) {
          const g = await tx.query<{ s: string }>(`SELECT COALESCE(SUM(${COUNTED_SQL}), 0) AS s FROM model_spend_ledger WHERE period = $1`, [r.period]);
          if (Number(g.rows[0].s) + r.amountUsd > r.globalBudgetUsd + 1e-12) return { ok: false as const, reason: 'global_budget' as const };
        }
        if (r.scopeBudgetUsd !== null) {
          const q = await tx.query<{ s: string }>(`SELECT COALESCE(SUM(${COUNTED_SQL}), 0) AS s FROM model_spend_ledger WHERE period = $1 AND scope_kind = $2 AND scope_id = $3`, [r.period, r.scope.kind, r.scope.id]);
          if (Number(q.rows[0].s) + r.amountUsd > r.scopeBudgetUsd + 1e-12) return { ok: false as const, reason: 'scope_budget' as const };
        }
        await tx.query(
          `INSERT INTO model_spend_ledger (id, scope_kind, scope_id, period, role, model, data_class, state, reserved_usd, attempts, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8,0,$9)`,
          [r.id, r.scope.kind, r.scope.id, r.period, r.role, r.model, r.dataClass, r.amountUsd, r.now]);
        return { ok: true as const };
      });
    },
    async settle(id, s) {
      const r = await db.query(
        `UPDATE model_spend_ledger SET state=$2, actual_usd=$3, cost_note=CASE WHEN state='unknown_cost' THEN 'late_settlement:' || $4 ELSE $4 END, returned_model=$5, attempts=$6, status=$7, prompt_tokens=$8, completion_tokens=$9, reasoning_tokens=$10, settled_at=$11
          WHERE id=$1 AND (state='reserved' OR (state='unknown_cost' AND cost_note='unsettled_timeout')) RETURNING id`,
        [id, s.state, s.actualUsd, s.costNote, s.returnedModel ?? null, s.attempts, s.status, s.promptTokens ?? null, s.completionTokens ?? null, s.reasoningTokens ?? null, s.now]);
      return r.length === 1;
    },
    async release(id, now) {
      return (await db.query(`UPDATE model_spend_ledger SET state='released', actual_usd=0, cost_note='not_sent', settled_at=$2 WHERE id=$1 AND state='reserved' RETURNING id`, [id, now])).length === 1;
    },
    async sweepStale(olderThanMs, now) {
      // A reservation that never settled (crash / lost connection) becomes unknown-cost: still counted, never silently dropped.
      return (await db.query(`UPDATE model_spend_ledger SET state='unknown_cost', cost_note='unsettled_timeout', settled_at=$2 WHERE state='reserved' AND created_at < $1 RETURNING id`, [now - olderThanMs, now])).length;
    },
    async report(f) {
      const params: unknown[] = [f.fromPeriod, f.toPeriod];
      let scopeSql = '';
      if (f.scope) { params.push(f.scope.kind, f.scope.id); scopeSql = ' AND scope_kind = $3 AND scope_id = $4'; }
      const rows = await db.query<any>(
        `SELECT period, role, model, COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE state='settled')::int AS settled, COUNT(*) FILTER (WHERE state='unknown_cost')::int AS unknown,
                COUNT(*) FILTER (WHERE state='released')::int AS released, COUNT(*) FILTER (WHERE state='reserved')::int AS open,
                COALESCE(SUM(actual_usd) FILTER (WHERE state='settled'), 0) AS known, COALESCE(SUM(${COUNTED_SQL}), 0) AS counted, COALESCE(SUM(attempts), 0)::int AS attempts,
                COUNT(*) FILTER (WHERE state='settled' AND actual_usd > reserved_usd)::int AS overrun_calls, COALESCE(SUM(actual_usd - reserved_usd) FILTER (WHERE state='settled' AND actual_usd > reserved_usd), 0) AS overrun_usd
           FROM model_spend_ledger WHERE period >= $1 AND period <= $2${scopeSql} GROUP BY period, role, model ORDER BY period, role, model`, params);
      return rows.map((r) => ({ period: r.period, role: r.role, model: r.model, calls: r.calls, settledCalls: r.settled, unknownCostCalls: r.unknown + r.open, releasedCalls: r.released, openReservations: r.open, knownCostUsd: Number(r.known), countedUsd: Number(r.counted), attempts: r.attempts, overrunCalls: r.overrun_calls, overrunUsd: Number(r.overrun_usd) }));
    },
  };
}

export class SpendTracker {
  constructor(private readonly store: SpendStore, private readonly cfg: SpendConfig, private readonly clock: () => number = Date.now) {}

  get budgeted(): boolean { return this.cfg.globalBudgetUsd !== null || this.cfg.scopeBudgetUsd !== null; }

  async reserve(ctx: SpendContext): Promise<{ ok: true; token: string | null; accounting?: Accounting } | { ok: false; reason: string }> {
    if (this.cfg.invalid.length) return { ok: false, reason: `spend configuration is invalid (${this.cfg.invalid.length} problem(s)); model calls are refused until it is fixed (fail closed)` };
    const now = this.clock();
    const amount = this.cfg.reserveUsd[ctx.role] * Math.max(1, ctx.maxAttempts);
    const id = crypto.randomUUID();
    try {
      const r = await this.store.tryReserve({
        id, scope: ctx.scope, period: utcPeriod(now), role: ctx.role, model: ctx.model, dataClass: ctx.dataClass, amountUsd: amount, now,
        globalBudgetUsd: this.cfg.globalBudgetUsd, scopeBudgetUsd: this.cfg.scopeBudgetUsd,
      });
      if (!r.ok) return { ok: false, reason: r.reason === 'global_budget' ? 'daily global model budget would be exceeded' : 'daily model budget for this user/tenant would be exceeded' };
      return { ok: true, token: id, accounting: 'settled' };
    } catch {
      if (this.budgeted) return { ok: false, reason: 'spend accounting unavailable; call refused because a budget is configured (fail closed)' };
      logger.error('spend accounting unavailable; proceeding without a budget (call will be reported as untracked)');
      return { ok: true, token: null, accounting: 'untracked_unavailable' };
    }
  }

  async settle(token: string, out: { status: CallStatus; returnedModel?: string; usage?: Record<string, unknown>; costRaw: unknown; attempts: number; note?: string }): Promise<void> {
    const c = parseCost(out.costRaw);
    const retried = out.attempts > 1;
    const known = c.usd !== null && !retried && !out.note;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined);
    await this.store.settle(token, {
      state: known ? 'settled' : 'unknown_cost',
      actualUsd: c.usd,
      costNote: out.note ?? (retried ? (c.usd === null ? `incomplete_retries+${c.note}` : 'incomplete_retries') : c.note),
      returnedModel: out.returnedModel, attempts: out.attempts, status: out.status,
      promptTokens: num(out.usage?.prompt_tokens), completionTokens: num(out.usage?.completion_tokens), reasoningTokens: num(out.usage?.reasoning_tokens), now: this.clock(),
    });   // a false return = duplicate settle: idempotent no-op
  }

  async release(token: string): Promise<void> { await this.store.release(token, this.clock()); }
  async reconcile(): Promise<number> { return this.store.sweepStale(STALE_RESERVATION_MS, this.clock()); }
  hooks(): SpendHooks { return { reserve: (c) => this.reserve(c), settle: (t, o) => this.settle(t, o), release: (t) => this.release(t) }; }
}

export interface SpendReport {
  note: string; fromPeriod: string; toPeriod: string; scope: SpendScope | 'all';
  rows: ReportRow[];
  totals: { calls: number; knownCostUsd: number; unknownCostCalls: number; countedForBudgetUsd: number; totalIsLowerBound: boolean; overrunCalls: number; overrunUsd: number };
  budget: { globalDailyUsd: number | null; perScopeDailyUsd: number | null; enforced: boolean; configurationErrors: string[]; guarantee: string };
}

export async function spendReport(store: SpendStore, cfg: SpendConfig, f: ReportFilter): Promise<SpendReport> {
  const rows = await store.report(f);
  const sum = (k: keyof ReportRow) => Math.round(rows.reduce((a, r) => a + (r[k] as number), 0) * 1e8) / 1e8;
  const unknown = sum('unknownCostCalls');
  return {
    note: 'Costs are provider-reported. Calls with missing/invalid/negative cost or retried attempts are UNKNOWN and are not included in knownCostUsd; the real total can be higher.',
    fromPeriod: f.fromPeriod, toPeriod: f.toPeriod, scope: f.scope ?? 'all', rows,
    totals: { calls: sum('calls'), knownCostUsd: sum('knownCostUsd'), unknownCostCalls: unknown, countedForBudgetUsd: sum('countedUsd'), totalIsLowerBound: unknown > 0, overrunCalls: sum('overrunCalls'), overrunUsd: sum('overrunUsd') },
    budget: {
      globalDailyUsd: cfg.globalBudgetUsd, perScopeDailyUsd: cfg.scopeBudgetUsd, enforced: cfg.globalBudgetUsd !== null || cfg.scopeBudgetUsd !== null || cfg.invalid.length > 0, configurationErrors: cfg.invalid,
      guarantee: 'Admission control by reservation (atomic per UTC day), NOT a hard cap on provider charges: a call can cost more than its reservation, excesses accumulate across concurrent calls, and unknown-cost calls are counted only at their reservation. Only a provider-side limit is a hard cap.',
    },
  };
}

let tracker: SpendTracker | null = null;
let sweepTimer: NodeJS.Timeout | undefined;

/** Register tracking on the model transport (idempotent). Called at server start. */
export function enableSpendTracking(env: NodeJS.ProcessEnv = process.env): SpendTracker {
  if (tracker) return tracker;
  const cfg = spendConfigFromEnv(env);
  if (cfg.invalid.length) logger.error(`model spend configuration is INVALID; all model calls will be refused: ${cfg.invalid.join('; ')}`);
  tracker = new SpendTracker(pgSpendStore(), cfg);
  setSpendHooks(tracker.hooks());
  sweepTimer = setInterval(() => { tracker?.reconcile().catch(() => logger.error('spend reconcile failed')); }, 10 * 60 * 1000);
  sweepTimer.unref?.();
  return tracker;
}
export function disableSpendTracking(): void { tracker = null; if (sweepTimer) clearInterval(sweepTimer); setSpendHooks({}); }
export function getSpendConfig(env: NodeJS.ProcessEnv = process.env): SpendConfig { return spendConfigFromEnv(env); }
export function pgReport(f: ReportFilter, env: NodeJS.ProcessEnv = process.env) { return spendReport(pgSpendStore(), spendConfigFromEnv(env), f); }
