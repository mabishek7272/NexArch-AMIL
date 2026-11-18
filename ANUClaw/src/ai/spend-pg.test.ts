/** Spend ledger against REAL PostgreSQL (disposable; opt-in): atomic budget under concurrency, scopes, outage, reset. Synthetic only. */
import * as crypto from 'crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('model spend ledger (real PostgreSQL)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let sp: typeof import('./spend'); let dbm: typeof import('../db');
  const cfg = (o: Partial<import('./spend').SpendConfig> = {}) => ({ globalBudgetUsd: null, scopeBudgetUsd: null, reserveUsd: { ocr: 0.05, embedding: 0.005, decision: 0.01, review: 0.02 }, invalid: [] as string[], ...o });
  const ctx = (id: string, role: any = 'review') => ({ role, model: 'm', dataClass: 'synthetic_test', scope: { kind: 'tenant' as const, id }, maxAttempts: 1 });

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName });
    vi.resetModules();
    await (await import('../db/connection')).ensureDbReady();
    dbm = await import('../db'); sp = await import('./spend');
  });
  afterAll(async () => { try { await (dbm as any).db.close?.(); } catch { /* ignore */ } await admin.end(); });

  it('concurrent reservations never exceed the global budget (atomic)', async () => {
    const t = new sp.SpendTracker(sp.pgSpendStore(), cfg({ globalBudgetUsd: 0.1 }), () => Date.parse('2030-01-01T12:00:00Z'));
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => t.reserve(ctx(`c${i}`))));   // 30 × 0.02 requested vs 0.10 cap
    expect(rs.filter((r) => r.ok)).toHaveLength(5);
    const rep = await sp.spendReport(sp.pgSpendStore(), cfg({ globalBudgetUsd: 0.1 }), { fromPeriod: '2030-01-01', toPeriod: '2030-01-01' });
    expect(rep.totals.countedForBudgetUsd).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it('per-scope budget isolates tenants; settled actual cost replaces the reservation', async () => {
    const now = () => Date.parse('2030-01-02T12:00:00Z');
    const t = new sp.SpendTracker(sp.pgSpendStore(), cfg({ scopeBudgetUsd: 0.04 }), now);
    const a1 = await t.reserve(ctx('A')); const a2 = await t.reserve(ctx('A')); const a3 = await t.reserve(ctx('A'));
    expect([a1.ok, a2.ok, a3.ok]).toEqual([true, true, false]);
    expect((await t.reserve(ctx('B'))).ok).toBe(true);                     // another tenant unaffected
    await t.settle((a1 as any).token, { status: 'ok', costRaw: 0.001, attempts: 1 });
    await t.settle((a2 as any).token, { status: 'ok', costRaw: 0.001, attempts: 1 });
    expect((await t.reserve(ctx('A'))).ok).toBe(true);                     // headroom freed by REAL cost
    const own = await sp.spendReport(sp.pgSpendStore(), cfg(), { fromPeriod: '2030-01-02', toPeriod: '2030-01-02', scope: { kind: 'tenant', id: 'B' } });
    expect(own.totals.calls).toBe(1);                                       // a tenant report never includes others
  });

  it('duplicate settle is a no-op; unknown cost is counted at its reservation and flagged as lower bound', async () => {
    const now = () => Date.parse('2030-01-03T12:00:00Z');
    const t = new sp.SpendTracker(sp.pgSpendStore(), cfg(), now);
    const r = await t.reserve(ctx('D')) as any;
    await t.settle(r.token, { status: 'ok', costRaw: 0.003, attempts: 1 });
    await t.settle(r.token, { status: 'ok', costRaw: 9, attempts: 1 });
    const u = await t.reserve(ctx('D')) as any;
    await t.settle(u.token, { status: 'ok', costRaw: undefined, attempts: 1 });
    const rep = await sp.spendReport(sp.pgSpendStore(), cfg(), { fromPeriod: '2030-01-03', toPeriod: '2030-01-03' });
    expect(rep.totals).toMatchObject({ calls: 2, knownCostUsd: 0.003, unknownCostCalls: 1, totalIsLowerBound: true });
    expect(rep.totals.countedForBudgetUsd).toBeCloseTo(0.003 + 0.02, 8);
  });

  it('reset boundary: a new UTC day has a fresh budget; the previous day stays full', async () => {
    let clock = Date.parse('2030-01-04T23:59:59.999Z');
    const t = new sp.SpendTracker(sp.pgSpendStore(), cfg({ globalBudgetUsd: 0.02 }), () => clock);
    expect((await t.reserve(ctx('E'))).ok).toBe(true);
    expect((await t.reserve(ctx('E'))).ok).toBe(false);
    clock = Date.parse('2030-01-05T00:00:00.000Z');
    expect((await t.reserve(ctx('E'))).ok).toBe(true);
  });

  it('stale unsettled reservations become unknown-cost (still counted), not dropped', async () => {
    const store = sp.pgSpendStore();
    const t0 = Date.parse('2030-01-06T10:00:00Z');
    const t = new sp.SpendTracker(store, cfg({ globalBudgetUsd: 0.02 }), () => t0);
    expect((await t.reserve(ctx('F'))).ok).toBe(true);
    expect(await store.sweepStale(sp.STALE_RESERVATION_MS, t0 + sp.STALE_RESERVATION_MS + 1000)).toBeGreaterThanOrEqual(1);   // sweep is global: earlier tests' open rows are swept too
    expect((await t.reserve(ctx('F'))).ok).toBe(false);                     // still occupies budget
    const rep = await sp.spendReport(store, cfg(), { fromPeriod: '2030-01-06', toPeriod: '2030-01-06' });
    expect(rep.totals.totalIsLowerBound).toBe(true);
  });

  it('released reservations free their budget', async () => {
    const store = sp.pgSpendStore(); const now = () => Date.parse('2030-01-07T10:00:00Z');
    const t = new sp.SpendTracker(store, cfg({ globalBudgetUsd: 0.02 }), now);
    const r = await t.reserve(ctx('G')) as any;
    expect((await t.reserve(ctx('G'))).ok).toBe(false);
    await store.release(r.token, now());
    expect((await t.reserve(ctx('G'))).ok).toBe(true);
  });

  it('an explicit ZERO budget refuses every call (globally and per scope)', async () => {
    const now = () => Date.parse('2030-01-08T10:00:00Z');
    expect((await new sp.SpendTracker(sp.pgSpendStore(), cfg({ globalBudgetUsd: 0 }), now).reserve(ctx('Z'))).ok).toBe(false);
    expect((await new sp.SpendTracker(sp.pgSpendStore(), cfg({ scopeBudgetUsd: 0 }), now).reserve(ctx('Z'))).ok).toBe(false);
  });

  it('LATE settlement: a call swept as unsettled_timeout accepts exactly one settlement with its real cost', async () => {
    const store = sp.pgSpendStore(); const t0 = Date.parse('2030-01-09T10:00:00Z');
    const t = new sp.SpendTracker(store, cfg(), () => t0);
    const r = await t.reserve(ctx('L')) as any;
    await store.sweepStale(sp.STALE_RESERVATION_MS, t0 + sp.STALE_RESERVATION_MS + 1);
    const swept = await dbm.db.queryOne<any>('SELECT state, cost_note FROM model_spend_ledger WHERE id=$1', [r.token]);
    expect(swept).toMatchObject({ state: 'unknown_cost', cost_note: 'unsettled_timeout' });
    await t.settle(r.token, { status: 'ok', costRaw: 0.004, attempts: 1 });
    const done = await dbm.db.queryOne<any>('SELECT state, cost_note, actual_usd FROM model_spend_ledger WHERE id=$1', [r.token]);
    expect(done).toMatchObject({ state: 'settled', cost_note: 'late_settlement:reported' }); expect(Number(done.actual_usd)).toBeCloseTo(0.004, 10);
    await t.settle(r.token, { status: 'ok', costRaw: 50, attempts: 1 });                     // a second settlement changes nothing
    expect(Number((await dbm.db.queryOne<any>('SELECT actual_usd FROM model_spend_ledger WHERE id=$1', [r.token]))!.actual_usd)).toBeCloseTo(0.004, 10);
    await store.release(r.token, t0);                                                         // and it cannot be released afterwards
    expect((await dbm.db.queryOne<any>('SELECT state FROM model_spend_ledger WHERE id=$1', [r.token]))!.state).toBe('settled');
  });

  it('a late settlement with unknown cost stays unknown (still counted at its reservation)', async () => {
    const store = sp.pgSpendStore(); const t0 = Date.parse('2030-01-10T10:00:00Z');
    const t = new sp.SpendTracker(store, cfg(), () => t0);
    const r = await t.reserve(ctx('L2')) as any;
    await store.sweepStale(sp.STALE_RESERVATION_MS, t0 + sp.STALE_RESERVATION_MS + 1);
    await t.settle(r.token, { status: 'timeout', costRaw: undefined, attempts: 1 });
    const row = await dbm.db.queryOne<any>('SELECT state, actual_usd, cost_note FROM model_spend_ledger WHERE id=$1', [r.token]);
    expect(row).toMatchObject({ state: 'unknown_cost', actual_usd: null, cost_note: 'late_settlement:missing' });
  });

  it('OVERRUNS: real cost above the reservation is recorded and reported; concurrent excesses ACCUMULATE (admission is not a charge cap)', async () => {
    const store = sp.pgSpendStore(); const t0 = Date.parse('2030-01-11T10:00:00Z');
    const t = new sp.SpendTracker(store, cfg({ globalBudgetUsd: 0.1 }), () => t0);   // admits 5 reviews at 0.02
    const rs = (await Promise.all(Array.from({ length: 12 }, () => t.reserve(ctx('O'))))).filter((r) => r.ok) as any[];
    expect(rs).toHaveLength(5);
    await Promise.all(rs.map((r) => t.settle(r.token, { status: 'ok', costRaw: 0.05, attempts: 1 })));   // each really cost 2.5× its reservation
    const rep = await sp.spendReport(store, cfg({ globalBudgetUsd: 0.1 }), { fromPeriod: '2030-01-11', toPeriod: '2030-01-11' });
    expect(rep.totals.knownCostUsd).toBeCloseTo(0.25, 8);                    // real charges exceeded the 0.10 "budget"
    expect(rep.totals).toMatchObject({ overrunCalls: 5 }); expect(rep.totals.overrunUsd).toBeCloseTo(0.15, 8);
    expect((await t.reserve(ctx('O'))).ok).toBe(false);                      // later admission sees the REAL cost, not the reservation
    expect(rep.budget.guarantee).toMatch(/NOT a hard cap on provider charges/);
  });

  it('database outage: budgeted → refused (fail closed); unbudgeted → proceeds flagged untracked', async () => {
    const broken = { ...sp.pgSpendStore(), tryReserve: async () => { throw new Error('connection terminated'); } };
    expect(await new sp.SpendTracker(broken as any, cfg({ globalBudgetUsd: 1 })).reserve(ctx('H'))).toMatchObject({ ok: false });
    expect(await new sp.SpendTracker(broken as any, cfg()).reserve(ctx('H'))).toEqual({ ok: true, token: null, accounting: 'untracked_unavailable' });
  });
});
