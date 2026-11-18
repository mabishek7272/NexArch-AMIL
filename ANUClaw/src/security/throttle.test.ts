import { describe, expect, it, vi } from 'vitest';
import { FixedWindowLimiter, ConcurrencyGate } from './throttle';

vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { effectiveLimits, perTenantRateLimit, quotaCheck, agentConcurrencyLimit, planLimits, __testing } from '../api/middleware/rate-limit';
import { EventEmitter } from 'events';

describe('FixedWindowLimiter', () => {
  it('allows up to the limit per window and resets after it', () => {
    let t = 0;
    const l = new FixedWindowLimiter(1000, () => t);
    expect([1, 2, 3].map(() => l.hit('k', 2).allowed)).toEqual([true, true, false]);
    t = 1000;
    expect(l.hit('k', 2).allowed).toBe(true);
  });
});

describe('ConcurrencyGate', () => {
  it('caps in-flight work and frees on release', () => {
    const g = new ConcurrencyGate();
    expect(g.tryAcquire('t', 1)).toBe(true);
    expect(g.tryAcquire('t', 1)).toBe(false);
    g.release('t');
    expect(g.tryAcquire('t', 1)).toBe(true);
  });
});

function fakeRes() {
  const res: any = new EventEmitter();
  res.statusCode = 200; res.headers = {};
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  return res;
}
process.env.ANUCLAW_RATE_STORE = 'memory'; // this file tests the in-process store; the shared store is tested in limits-pg.test.ts
const run = async (mw: any, tenant: any) => { const res = fakeRes(); let next = false; await mw({ tenant }, res, () => { next = true; }); return { res, next }; };

describe('tenant limits (in-process store)', () => {
  it('stored 0 means "use plan default", not unlimited', () => {
    expect(effectiveLimits({ plan: 'free', rate_limit_per_min: 0, monthly_quota: null })).toEqual(planLimits().free);
  });

  it('rate limit returns 429 with Retry-After once exceeded', async () => {
    const t = { tenant_id: `t-${Math.random()}`, plan: 'free', rate_limit_per_min: 2 };
    expect((await run(perTenantRateLimit, t)).next).toBe(true);
    expect((await run(perTenantRateLimit, t)).next).toBe(true);
    const third = await run(perTenantRateLimit, t);
    expect(third.next).toBe(false);
    expect(third.res.statusCode).toBe(429);
    expect(third.res.headers['Retry-After']).toBeDefined();
  });

  it('quota exhausted → 429; enterprise default quota is unlimited', async () => {
    expect((await run(quotaCheck, { tenant_id: 'q', plan: 'free', usage_this_month: 1000 })).res.statusCode).toBe(429);
    expect((await run(quotaCheck, { tenant_id: 'q', plan: 'free', usage_this_month: 999 })).next).toBe(true);
    expect((await run(quotaCheck, { tenant_id: 'q', plan: 'enterprise', usage_this_month: 10_000_000 })).next).toBe(true);
  });

  it('missing tenant is rejected, not passed through', async () => {
    expect((await run(perTenantRateLimit, undefined)).res.statusCode).toBe(401);
    expect((await run(quotaCheck, undefined)).res.statusCode).toBe(401);
  });

  it('concurrency limit rejects a second simultaneous run and frees on finish', async () => {
    const t = { tenant_id: `c-${Math.random()}`, plan: 'free' }; // free concurrency = 1
    const first = await run(agentConcurrencyLimit, t);
    expect(first.next).toBe(true);
    expect((await run(agentConcurrencyLimit, t)).res.statusCode).toBe(429);
    first.res.emit('finish');
    expect(__testing.gate.current(`tenant:${t.tenant_id}`)).toBe(0);
    expect((await run(agentConcurrencyLimit, t)).next).toBe(true);
  });

  it('ANUCLAW_PLAN_LIMITS overrides defaults; invalid JSON falls back', () => {
    expect(planLimits({ ANUCLAW_PLAN_LIMITS: '{"free":{"rate":5}}' }).free.rate).toBe(5);
    expect(planLimits({ ANUCLAW_PLAN_LIMITS: 'nope' }).free.rate).toBe(planLimits({}).free.rate);
  });
});
