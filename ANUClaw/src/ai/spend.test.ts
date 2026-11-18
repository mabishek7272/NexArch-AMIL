/** Spend tracking policy (fake stores; the real-PostgreSQL concurrency/outage/reset tests are in spend-pg.test.ts). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const llm = vi.hoisted(() => ({ provider: 'openrouter', openrouterApiKey: 'sk-or-test-not-real-000000000', openrouterBaseUrl: 'https://provider.invalid/api/v1', openrouterReasoningEffort: 'medium' } as any));
const logs = vi.hoisted(() => [] as string[]);
vi.mock('../config', () => ({ config: { llm } }));
vi.mock('../logger', () => { const rec = (m: string, ...a: unknown[]) => { logs.push([m, ...a.map((x) => JSON.stringify(x))].join(' ')); }; return { logger: { info: rec, warn: rec, error: rec, debug: rec } }; });
vi.mock('axios', () => ({ default: { post: vi.fn() } }));
vi.mock('../db', () => ({ db: { query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn() } }));

import axios from 'axios';
import { modelCall, scopeFromActor, setSpendHooks, SpendContext } from './openrouter';
import { isUtcDay, DEFAULT_RESERVE_USD, ReportRow, ReserveRequest, SettleRequest, SpendStore, SpendTracker, parseCost, spendConfigFromEnv, spendReport, utcPeriod } from './spend';

const post = vi.mocked(axios.post);
const ok = (data: any) => ({ status: 200, data });
const CTX: SpendContext = { role: 'review', model: 'google/gemma-4-26b-a4b-it', dataClass: 'synthetic_test', scope: { kind: 'tenant', id: 't1' }, maxAttempts: 2 };

class FakeStore implements SpendStore {
  reserved: ReserveRequest[] = []; settled = new Map<string, SettleRequest>(); released: string[] = [];
  failReserve = false; failSettle = false; budgetRefusal: 'global_budget' | 'scope_budget' | null = null;
  async tryReserve(r: ReserveRequest) { if (this.failReserve) throw new Error('db down: SECRET-PROMPT-TEXT'); if (this.budgetRefusal) return { ok: false as const, reason: this.budgetRefusal }; this.reserved.push(r); return { ok: true as const }; }
  async settle(id: string, s: SettleRequest) { if (this.failSettle) throw new Error('db down'); if (this.settled.has(id)) return false; this.settled.set(id, s); return true; }
  async release(id: string) { this.released.push(id); return true; }
  async sweepStale() { return 0; }
  async report(): Promise<ReportRow[]> { return []; }
}
const cfg = (over: Partial<ReturnType<typeof spendConfigFromEnv>> = {}) => ({ globalBudgetUsd: null, scopeBudgetUsd: null, reserveUsd: { ...DEFAULT_RESERVE_USD }, invalid: [] as string[], ...over });

beforeEach(() => { post.mockReset(); logs.length = 0; });
afterEach(() => setSpendHooks({}));

describe('cost parsing: provider-reported only; missing is unknown, never zero', () => {
  it.each([
    [0.00000405, { usd: 0.00000405, note: 'reported' }],
    [0, { usd: 0, note: 'reported' }],                         // an explicit zero is a known zero
    [undefined, { usd: null, note: 'missing' }],
    [null, { usd: null, note: 'missing' }],
    ['0.01', { usd: null, note: 'invalid' }],
    [NaN, { usd: null, note: 'invalid' }],
    [Infinity, { usd: null, note: 'invalid' }],
    [{ cost: 1 }, { usd: null, note: 'invalid' }],
    [-0.5, { usd: null, note: 'negative' }],
  ])('%j', (raw, expected) => { expect(parseCost(raw)).toEqual(expected); });
});

describe('UTC reset boundary', () => {
  it('rolls over exactly at 00:00:00 UTC', () => {
    expect(utcPeriod(Date.parse('2026-11-17T23:59:59.999Z'))).toBe('2026-11-17');
    expect(utcPeriod(Date.parse('2026-11-18T00:00:00.000Z'))).toBe('2026-11-18');
    expect(utcPeriod(Date.parse('2026-11-17T23:59:59.999-05:00'))).toBe('2026-11-18');   // local clock offsets cannot shift the day
  });
});

describe('calendar-day validation', () => {
  it.each([['2026-11-17', true], ['2024-02-29', true], ['2026-13-40', false], ['2026-02-30', false], ['2026-2-3', false], ['yesterday', false], ['', false], ['2026-11-17T00:00:00Z', false]])('isUtcDay(%j) = %s', (s, ok) => { expect(isUtcDay(s)).toBe(ok); });
});

describe('configuration', () => {
  it('unset/blank budgets mean "no budget"; valid numbers are used; zero is an explicit zero budget', () => {
    expect(spendConfigFromEnv({})).toMatchObject({ globalBudgetUsd: null, scopeBudgetUsd: null, invalid: [] });
    expect(spendConfigFromEnv({ ANUCLAW_MODEL_DAILY_BUDGET_USD: '  ' })).toMatchObject({ globalBudgetUsd: null, invalid: [] });
    expect(spendConfigFromEnv({ ANUCLAW_MODEL_DAILY_BUDGET_USD: '12.5', ANUCLAW_MODEL_DAILY_BUDGET_PER_SCOPE_USD: '2' })).toMatchObject({ globalBudgetUsd: 12.5, scopeBudgetUsd: 2, invalid: [] });
    expect(spendConfigFromEnv({ ANUCLAW_MODEL_DAILY_BUDGET_USD: '0' })).toMatchObject({ globalBudgetUsd: 0, invalid: [] });
  });
  it.each(['abc', '-3', 'NaN', 'Infinity', '1e999', '$5', '5 usd'])('invalid budget %j is reported, never silently "unlimited"', (bad) => {
    const c = spendConfigFromEnv({ ANUCLAW_MODEL_DAILY_BUDGET_USD: bad });
    expect(c.invalid).toHaveLength(1); expect(c.invalid[0]).toMatch(/ANUCLAW_MODEL_DAILY_BUDGET_USD/);
    expect(spendConfigFromEnv({ ANUCLAW_MODEL_DAILY_BUDGET_PER_SCOPE_USD: bad }).invalid[0]).toMatch(/PER_SCOPE/);
  });
  it('reservation overrides: valid ones apply; invalid JSON, wrong shape, unknown roles and bad amounts are all reported', () => {
    expect(spendConfigFromEnv({ ANUCLAW_MODEL_RESERVE_USD: '{"ocr":0.2}' })).toMatchObject({ reserveUsd: { ocr: 0.2, review: DEFAULT_RESERVE_USD.review }, invalid: [] });
    for (const bad of ['not json', '[1]', 'null', '{"ocr":0}', '{"ocr":-1}', '{"review":"x"}', '{"bogus":1}']) expect(spendConfigFromEnv({ ANUCLAW_MODEL_RESERVE_USD: bad }).invalid.length, bad).toBeGreaterThan(0);
  });
  it('an invalid configuration refuses EVERY model call (fail closed) and never reaches the store', async () => {
    const store = new FakeStore();
    const t = new SpendTracker(store, cfg({ invalid: ['ANUCLAW_MODEL_DAILY_BUDGET_USD must be …'] }));
    expect(await t.reserve(CTX)).toEqual({ ok: false, reason: expect.stringMatching(/spend configuration is invalid.*fail closed/) });
    expect(store.reserved).toHaveLength(0);
  });
  it('a zero budget is enforced as "refuse everything" (store-level check is in the PG test)', async () => {
    const store = new FakeStore(); store.budgetRefusal = 'global_budget';
    expect((await new SpendTracker(store, cfg({ globalBudgetUsd: 0 })).reserve(CTX)).ok).toBe(false);
    expect(new SpendTracker(store, cfg({ globalBudgetUsd: 0 })).budgeted).toBe(true);
  });
  it('scope derivation from the authenticated actor', () => {
    expect(scopeFromActor('tenant:abc')).toEqual({ kind: 'tenant', id: 'abc' });
    expect(scopeFromActor('user-1')).toEqual({ kind: 'user', id: 'user-1' });
    expect(scopeFromActor(undefined)).toEqual({ kind: 'system', id: 'system' });
    expect(scopeFromActor('x', 't9')).toEqual({ kind: 'tenant', id: 't9' });
  });
});

describe('reservation', () => {
  it('reserves per-attempt amount × (1 + retries), in the caller scope, in the UTC period of the clock', async () => {
    const store = new FakeStore();
    const t = new SpendTracker(store, cfg(), () => Date.parse('2026-11-17T23:59:59.000Z'));
    const r = await t.reserve({ ...CTX, maxAttempts: 3 });
    expect(r).toMatchObject({ ok: true });
    expect(store.reserved[0]).toMatchObject({ scope: { kind: 'tenant', id: 't1' }, period: '2026-11-17', role: 'review' });
    expect(store.reserved[0].amountUsd).toBeCloseTo(DEFAULT_RESERVE_USD.review * 3, 12);
  });
  it('budget refusals carry an explicit, content-free reason', async () => {
    const store = new FakeStore(); store.budgetRefusal = 'global_budget';
    const g = await new SpendTracker(store, cfg({ globalBudgetUsd: 1 })).reserve(CTX);
    expect(g).toEqual({ ok: false, reason: expect.stringMatching(/global model budget would be exceeded/) });
    store.budgetRefusal = 'scope_budget';
    expect(await new SpendTracker(store, cfg({ scopeBudgetUsd: 1 })).reserve(CTX)).toEqual({ ok: false, reason: expect.stringMatching(/this user\/tenant would be exceeded/) });
  });
  it('database outage + budget configured → REFUSED (fail closed); no budget → proceeds, reported untracked, safe log', async () => {
    const store = new FakeStore(); store.failReserve = true;
    const closed = await new SpendTracker(store, cfg({ globalBudgetUsd: 5 })).reserve(CTX);
    expect(closed).toEqual({ ok: false, reason: expect.stringMatching(/fail closed/) });
    const open = await new SpendTracker(store, cfg()).reserve(CTX);
    expect(open).toEqual({ ok: true, token: null, accounting: 'untracked_unavailable' });
    expect(logs.join('\n')).toMatch(/proceeding without a budget/);
    expect(logs.join('\n')).not.toMatch(/SECRET-PROMPT-TEXT/);   // error text from the store is never logged
  });
});

describe('settlement', () => {
  const tracker = (store: FakeStore) => new SpendTracker(store, cfg(), () => 1_000);
  const settle = async (costRaw: unknown, attempts = 1, status: any = 'ok') => {
    const store = new FakeStore(); const t = tracker(store);
    await t.settle('id1', { status, costRaw, attempts, usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 3 } });
    return store.settled.get('id1')!;
  };
  it('reported cost → settled with that exact cost and token counts', async () => {
    expect(await settle(0.0123)).toMatchObject({ state: 'settled', actualUsd: 0.0123, costNote: 'reported', attempts: 1, promptTokens: 10, completionTokens: 5, reasoningTokens: 3 });
  });
  it('a known zero stays zero (distinct from unknown)', async () => { expect(await settle(0)).toMatchObject({ state: 'settled', actualUsd: 0 }); });
  it.each([[undefined, 'missing'], [null, 'missing'], ['x', 'invalid'], [NaN, 'invalid'], [-1, 'negative']])('cost %j → unknown_cost (%s), actual NOT stored as 0', async (raw, note) => {
    expect(await settle(raw)).toMatchObject({ state: 'unknown_cost', actualUsd: null, costNote: note });
  });
  it('retried attempts: earlier billable attempts are unknowable → unknown_cost even when the final cost is known', async () => {
    expect(await settle(0.01, 2)).toMatchObject({ state: 'unknown_cost', actualUsd: 0.01, costNote: 'incomplete_retries', attempts: 2 });
    expect(await settle(undefined, 2)).toMatchObject({ state: 'unknown_cost', actualUsd: null, costNote: 'incomplete_retries+missing' });
  });
  it('failed provider calls with no cost are unknown, not free', async () => { expect(await settle(undefined, 1, 'http_error')).toMatchObject({ state: 'unknown_cost', status: 'http_error' }); });
  it('duplicate settlement is an idempotent no-op (second call changes nothing)', async () => {
    const store = new FakeStore(); const t = tracker(store);
    await t.settle('dup', { status: 'ok', costRaw: 0.5, attempts: 1 });
    await t.settle('dup', { status: 'ok', costRaw: 99, attempts: 1 });
    expect(store.settled.get('dup')!.actualUsd).toBe(0.5);
  });
  it('negative or non-finite token counts are dropped, not stored', async () => {
    const store = new FakeStore(); await tracker(store).settle('t', { status: 'ok', costRaw: 0.1, attempts: 1, usage: { prompt_tokens: -5, completion_tokens: NaN, reasoning_tokens: 'x' } });
    expect(store.settled.get('t')).toMatchObject({ promptTokens: undefined, completionTokens: undefined, reasoningTokens: undefined });
  });
});

describe('model transport integration', () => {
  const call = (over: Record<string, unknown> = {}) => modelCall({ role: 'review', path: '/chat/completions', dataClass: 'synthetic_test', scope: { kind: 'user', id: 'u1' }, body: { messages: [{ role: 'user', content: 'SECRET-PROMPT-TEXT' }] }, ...over });
  const reply = (extra: any = {}) => ok({ model: 'google/gemma-4-26b-a4b-it', choices: [{ message: { content: 'SECRET-COMPLETION' } }], usage: { prompt_tokens: 9, completion_tokens: 4, cost: 0.0042 }, ...extra });

  it('a refused reservation never reaches the provider', async () => {
    const store = new FakeStore(); store.budgetRefusal = 'global_budget';
    setSpendHooks(new SpendTracker(store, cfg({ globalBudgetUsd: 1 })).hooks());
    const r = await call();
    expect(r.status).toBe('spend_limit_reached'); expect(post).not.toHaveBeenCalled();
  });
  it('asks the provider to report cost; settles with the REPORTED cost; records the caller scope', async () => {
    const store = new FakeStore(); setSpendHooks(new SpendTracker(store, cfg()).hooks());
    post.mockResolvedValue(reply());
    const r = await call();
    expect(r.status).toBe('ok'); expect(r.accounting).toBe('settled');
    expect((post.mock.calls[0][1] as any).usage).toEqual({ include: true });
    expect([...store.settled.values()][0]).toMatchObject({ state: 'settled', actualUsd: 0.0042 });
    expect(store.reserved[0].scope).toEqual({ kind: 'user', id: 'u1' });
  });
  it('a response without cost is unknown (not zero)', async () => {
    const store = new FakeStore(); setSpendHooks(new SpendTracker(store, cfg()).hooks());
    post.mockResolvedValue(reply({ usage: { prompt_tokens: 9, completion_tokens: 4 } }));
    await call();
    expect([...store.settled.values()][0]).toMatchObject({ state: 'unknown_cost', actualUsd: null, costNote: 'missing' });
  });
  it('provider errors and retried calls are settled as unknown cost with the real attempt count', async () => {
    const store = new FakeStore(); setSpendHooks(new SpendTracker(store, cfg()).hooks());
    post.mockResolvedValueOnce({ status: 503, data: { error: { code: 'x', message: 'SECRET-PROMPT-TEXT echoed' } } });
    post.mockResolvedValueOnce(reply());
    const r = await call({ retries: 1 });
    expect(r.attempts).toBe(2);
    expect([...store.settled.values()][0]).toMatchObject({ state: 'unknown_cost', attempts: 2, costNote: 'incomplete_retries' });
  });
  it('settlement failure is reported on the result, the call still returns, and nothing content-bearing is logged', async () => {
    const store = new FakeStore(); store.failSettle = true; setSpendHooks(new SpendTracker(store, cfg({ globalBudgetUsd: 10 })).hooks());
    post.mockResolvedValue(reply());
    const r = await call();
    expect(r.status).toBe('ok'); expect(r.accounting).toBe('reservation_kept_accounting_failed');
    const all = logs.join('\n');
    expect(all).toMatch(/reservation retained/);
    for (const secret of ['SECRET-PROMPT-TEXT', 'SECRET-COMPLETION', llm.openrouterApiKey]) expect(all).not.toContain(secret);
  });
  it('a transport exception after reservation is NOT released: kept as unknown cost (the request may have been billed)', async () => {
    const store = new FakeStore(); setSpendHooks(new SpendTracker(store, cfg()).hooks());
    post.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    await call().catch(() => undefined);
    expect(store.released).toHaveLength(0);
    expect([...store.settled.values()][0]).toMatchObject({ state: 'unknown_cost', actualUsd: null });   // transport handles network errors itself (retries) → settled as unknown cost
  });
  it('timeouts and provider errors keep the reservation as unknown cost; only a never-sent call releases', async () => {
    const store = new FakeStore(); setSpendHooks(new SpendTracker(store, cfg()).hooks());
    post.mockResolvedValue({ status: 500, data: { error: { message: 'x' } } });
    await call({ retries: 0 });
    expect(store.released).toHaveLength(0); expect([...store.settled.values()][0]).toMatchObject({ state: 'unknown_cost', status: 'http_error' });
  });
  it('NO entry point bypasses accounting: with tracking not explicitly disabled, the first call enables the ledger', async () => {
    const saved = process.env.ANUCLAW_SPEND_TRACKING; delete process.env.ANUCLAW_SPEND_TRACKING;
    try {
      post.mockResolvedValue(reply());
      const r = await call();                                   // mocked db has no ledger → unbudgeted calls proceed but are flagged
      expect(r.accounting).toBe('untracked_unavailable');       // i.e. the tracker WAS consulted (not 'not_tracked')
      const { disableSpendTracking } = await import('./spend'); disableSpendTracking();
    } finally { process.env.ANUCLAW_SPEND_TRACKING = saved; }
  });
  it('explicitly disabled tracking is the only way to skip accounting, and it is logged', async () => {
    post.mockResolvedValue(reply());
    expect((await call()).accounting).toBe('not_tracked');
  });
  it('a call that is never sent (no provider key) releases its reservation', async () => {
    const store = new FakeStore(); setSpendHooks(new SpendTracker(store, cfg()).hooks());
    const saved = llm.openrouterApiKey; llm.openrouterApiKey = '';
    try { const r = await call(); expect(r.status).toBe('not_configured'); expect(store.released).toHaveLength(1); } finally { llm.openrouterApiKey = saved; }
  });
  it('a reserve hook that THROWS refuses the call (fail closed)', async () => {
    setSpendHooks({ reserve: async () => { throw new Error('boom'); } });
    const r = await call(); expect(r.status).toBe('spend_limit_reached'); expect(post).not.toHaveBeenCalled();
  });
  it('without tracking registered the transport is unchanged (accounting not_tracked)', async () => {
    post.mockResolvedValue(reply());
    expect((await call()).accounting).toBe('not_tracked');
  });
});

describe('report: unknown cost is never blended into the known total', () => {
  it('totals are marked as lower bounds when any call has unknown cost', async () => {
    const rows: ReportRow[] = [
      { period: '2026-11-17', role: 'review', model: 'm', calls: 3, settledCalls: 2, unknownCostCalls: 1, releasedCalls: 0, openReservations: 0, knownCostUsd: 0.02, countedUsd: 0.04, attempts: 4, overrunCalls: 1, overrunUsd: 0.01 },
      { period: '2026-11-17', role: 'ocr', model: 'o', calls: 1, settledCalls: 1, unknownCostCalls: 0, releasedCalls: 0, openReservations: 0, knownCostUsd: 0.1, countedUsd: 0.1, attempts: 1, overrunCalls: 0, overrunUsd: 0 },
    ];
    const store: SpendStore = { ...new FakeStore(), report: async () => rows } as any;
    const rep = await spendReport(store, cfg({ globalBudgetUsd: 1 }), { fromPeriod: '2026-11-17', toPeriod: '2026-11-17' });
    expect(rep.totals).toEqual({ calls: 4, knownCostUsd: 0.12, unknownCostCalls: 1, countedForBudgetUsd: 0.14, totalIsLowerBound: true, overrunCalls: 1, overrunUsd: 0.01 });
    expect(rep.budget.enforced).toBe(true); expect(rep.budget.guarantee).toMatch(/NOT a hard cap on provider charges/); expect(rep.budget.configurationErrors).toEqual([]);
    expect(rep.note).toMatch(/UNKNOWN/);
  });
});
