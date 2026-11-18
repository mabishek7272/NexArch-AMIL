/**
 * Tenant rate limits, monthly quotas and agent-run concurrency (plan F16).
 *
 * Previously both middlewares were deliberate pass-throughs ("unlimited").
 * Effective limits = the tenant's stored value when > 0, else the plan default.
 * Plan defaults can be overridden with ANUCLAW_PLAN_LIMITS (JSON), e.g.
 *   {"free":{"rate":30,"quota":1000,"concurrency":1}, ...}
 * These defaults are operational guards chosen for safety, not billing terms.
 */
import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { FixedWindowLimiter, ConcurrencyGate } from '../../security/throttle';
import { logger } from '../../logger';
import { pgRateHit, pgAcquireLease, pgReleaseLease, pgReserveQuota } from '../../security/shared-limits';

export interface PlanLimit { rate: number; quota: number | null; concurrency: number }

export const DEFAULT_PLAN_LIMITS: Record<string, PlanLimit> = {
  free:       { rate: 30,  quota: 1_000,  concurrency: 1 },
  pro:        { rate: 120, quota: 50_000, concurrency: 4 },
  enterprise: { rate: 600, quota: null,   concurrency: 8 },
};

export function planLimits(env: NodeJS.ProcessEnv = process.env): Record<string, PlanLimit> {
  if (!env.ANUCLAW_PLAN_LIMITS) return DEFAULT_PLAN_LIMITS;
  try {
    const parsed = JSON.parse(env.ANUCLAW_PLAN_LIMITS);
    const out: Record<string, PlanLimit> = { ...DEFAULT_PLAN_LIMITS };
    for (const [plan, v] of Object.entries(parsed as Record<string, Partial<PlanLimit>>)) {
      const base = out[plan] ?? DEFAULT_PLAN_LIMITS.free;
      out[plan] = {
        rate: Number.isInteger(v.rate) && v.rate! > 0 ? v.rate! : base.rate,
        quota: v.quota === null ? null : Number.isInteger(v.quota) && v.quota! > 0 ? v.quota! : base.quota,
        concurrency: Number.isInteger(v.concurrency) && v.concurrency! > 0 ? v.concurrency! : base.concurrency,
      };
    }
    return out;
  } catch {
    logger.warn('ANUCLAW_PLAN_LIMITS is not valid JSON; using built-in plan defaults.');
    return DEFAULT_PLAN_LIMITS;
  }
}

export function effectiveLimits(tenant: { plan?: string; rate_limit_per_min?: number; monthly_quota?: number | null }): PlanLimit {
  const plan = planLimits()[tenant.plan ?? 'free'] ?? DEFAULT_PLAN_LIMITS.free;
  return {
    rate: tenant.rate_limit_per_min && tenant.rate_limit_per_min > 0 ? tenant.rate_limit_per_min : plan.rate,
    quota: typeof tenant.monthly_quota === 'number' && tenant.monthly_quota > 0 ? tenant.monthly_quota : plan.quota,
    concurrency: plan.concurrency,
  };
}

const perMinute = new FixedWindowLimiter(60_000);
const gate = new ConcurrencyGate();
const LEASE_TTL_MS = Number(process.env.ANUCLAW_RUN_LEASE_TTL_MS ?? 15 * 60 * 1000);

/** 'postgres' (default; shared across processes) or 'memory' (single process only). */
export function rateStore(env: NodeJS.ProcessEnv = process.env): 'postgres' | 'memory' {
  return env.ANUCLAW_RATE_STORE === 'memory' ? 'memory' : 'postgres';
}

function storeFailure(res: Response, what: string, err: unknown): void {
  logger.error(`${what} store unavailable: ${err instanceof Error ? err.name : 'error'}`);
  // Fail closed: if limits cannot be checked, the request is not served.
  res.status(503).json({ error: 'Rate limiting is temporarily unavailable.', code: 'limits_unavailable' });
}

export async function perTenantRateLimit(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const t = req.tenant;
  if (!t) { res.status(401).json({ error: 'Authentication required.' }); return; }
  const { rate } = effectiveLimits(t);
  let r: { allowed: boolean; count: number; retryAfterSec: number };
  try {
    r = rateStore() === 'memory' ? perMinute.hit(`tenant:${t.tenant_id}`, rate) : await pgRateHit(`tenant:${t.tenant_id}`, rate, 60_000);
  } catch (err) { storeFailure(res, 'rate', err); return; }
  res.setHeader('X-RateLimit-Limit', String(rate));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, rate - r.count)));
  if (!r.allowed) {
    res.setHeader('Retry-After', String(r.retryAfterSec));
    res.status(429).json({ error: 'Rate limit exceeded.', code: 'rate_limited', retry_after_seconds: r.retryAfterSec });
    return;
  }
  next();
}

/**
 * Monthly quota. With the shared store this ATOMICALLY reserves the call (the
 * usage meter then does not count it again); concurrent requests cannot overshoot.
 */
export async function quotaCheck(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const t = req.tenant;
  if (!t) { res.status(401).json({ error: 'Authentication required.' }); return; }
  const { quota } = effectiveLimits(t);
  if (rateStore() === 'memory') {
    if (quota !== null && (t.usage_this_month ?? 0) >= quota) {
      res.status(429).json({ error: 'Monthly quota exhausted.', code: 'quota_exceeded', monthly_quota: quota });
      return;
    }
    next();
    return;
  }
  try {
    const used = await pgReserveQuota(t.tenant_id, quota);
    if (used === null) { res.status(429).json({ error: 'Monthly quota exhausted.', code: 'quota_exceeded', monthly_quota: quota }); return; }
    (req as any).quotaReserved = true;
    next();
  } catch (err) { storeFailure(res, 'quota', err); }
}

/** Limit simultaneous agent runs per tenant; released when the response finishes. */
export async function agentConcurrencyLimit(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const t = req.tenant;
  if (!t) { res.status(401).json({ error: 'Authentication required.' }); return; }
  const { concurrency } = effectiveLimits(t);
  const key = `tenant:${t.tenant_id}`;
  let release: () => void;
  if (rateStore() === 'memory') {
    if (!gate.tryAcquire(key, concurrency)) { tooMany(res, concurrency); return; }
    release = () => gate.release(key);
  } else {
    let lease: string | null;
    try { lease = await pgAcquireLease(key, concurrency, LEASE_TTL_MS); } catch (err) { storeFailure(res, 'concurrency', err); return; }
    if (!lease) { tooMany(res, concurrency); return; }
    release = () => { void pgReleaseLease(lease!).catch(() => {}); };
  }
  let released = false;
  const once = () => { if (!released) { released = true; release(); } };
  res.on('finish', once);
  res.on('close', once);
  next();
}

function tooMany(res: Response, max: number): void {
  res.status(429).json({ error: 'Too many concurrent runs for this tenant.', code: 'concurrency_limited', max_concurrent: max });
}

/** Test helper. */
export const __testing = { perMinute, gate };
