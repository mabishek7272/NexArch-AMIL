/** Monitoring against REAL PostgreSQL (disposable; opt-in): service + HTTP routes + access control. Synthetic only. */
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('monitoring (real PostgreSQL)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let server: Server; let base: string;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let svc: typeof import('./service');
  const cookie: Record<string, string> = {}; const ids: Record<string, string> = {};
  let patientId: string;

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName, DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex') });
    vi.resetModules();
    await (await import('../db/connection')).ensureDbReady();
    q = (await import('../db')).db.query as any;
    svc = await import('./service');
    const auth = await import('../dashboard/server/auth');
    for (const [k, role] of [['op', 'operator'], ['other', 'operator'], ['viewer', 'viewer']]) {
      ids[k] = crypto.randomUUID();
      await q(`INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1,$2,$3,'x',0)`, [ids[k], `${k}@clinic-synthetic.org`, role]);
      cookie[k] = `dash_token=${(await auth.issueTokens(ids[k])).accessToken}`;
    }
    patientId = crypto.randomUUID();
    await q(`INSERT INTO patients (id, uid, name, created_at, updated_at) VALUES ($1,$2,'Synthetic',0,0)`, [patientId, `S-${patientId}`]);
    await q(`INSERT INTO patient_access (patient_id, user_id, access_level, purpose, granted_by, granted_at) VALUES ($1,$2,'owner','t',$2,0), ($1,$3,'read','t',$2,0)`, [patientId, ids.op, ids.viewer]);
    const express = (await import('express')).default; const cookieParser = (await import('cookie-parser')).default;
    const app = express(); app.use(cookieParser()); app.use(express.json());
    app.use('/api/clinical', (await import('../dashboard/server/routes/documents')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/clinical`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { (await import('../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const call = (who: string, method: string, p: string, body?: unknown) => fetch(base + p, { method, headers: { cookie: cookie[who], 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const iso = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000).toISOString();
  let sim: string; let gw: string;

  it('pairing needs write access and a purpose; other users cannot see the patient or devices', async () => {
    expect((await call('viewer', 'POST', `/patients/${patientId}/monitoring/devices`, { kind: 'simulator', label: 'x', purpose: 'a valid purpose' })).status).toBe(403);
    expect((await call('other', 'GET', `/patients/${patientId}/monitoring/devices`)).status).toBe(404);
    expect((await call('op', 'POST', `/patients/${patientId}/monitoring/devices`, { kind: 'simulator', label: 'x', purpose: 'no' })).status).toBe(400);
    expect((await call('op', 'POST', `/patients/${patientId}/monitoring/devices`, { kind: 'bluetooth_pulse_ox', label: 'x', purpose: 'a valid purpose' })).status).toBe(400); // no real hardware adapter exists
    const s = await (await call('op', 'POST', `/patients/${patientId}/monitoring/devices`, { kind: 'simulator', label: 'Sim A', purpose: 'adapter testing' })).json();
    sim = s.deviceId; expect(s.simulation).toBe(true); expect(s.banner).toMatch(/SIMULATION/);
    gw = (await (await call('op', 'POST', `/patients/${patientId}/monitoring/devices`, { kind: 'fhir_gateway', label: 'Gateway', purpose: 'adapter testing' })).json()).deviceId;
  });

  it('simulator and real device kinds are strictly separated', async () => {
    expect((await call('op', 'POST', `/monitoring/devices/${gw}/simulate`, { count: 3 })).status).toBe(409);
    expect((await call('op', 'POST', `/monitoring/devices/${sim}/observations`, { observations: [] })).status).toBe(409);
    expect((await call('op', 'POST', `/monitoring/devices/${sim}/observations`, { fhir: [] })).status).toBe(409);
    expect((await call('op', 'POST', `/monitoring/devices/${gw}/observations`, { observations: [{ metric: 'heart_rate', value: 70, unit: '/min', sourceTime: iso(-5) }], fhir: undefined })).status).toBe(201);
  });

  it('simulated stream: accepted, labelled, duplicates idempotent, dropouts become gaps', async () => {
    const now = Date.now();
    const r = await (await call('op', 'POST', `/monitoring/devices/${sim}/simulate`, { seed: 3, count: 12, metrics: ['heart_rate'], intervalSec: 60, startMs: now - 12 * 60_000, dropoutFrom: 6, dropoutLength: 4, duplicateEvery: 5 })).json();
    expect(r.simulation).toBe(true); expect(r.accepted).toBe(8); expect(r.duplicates).toBeGreaterThanOrEqual(1);
    const again = await (await call('op', 'POST', `/monitoring/devices/${sim}/simulate`, { seed: 3, count: 12, metrics: ['heart_rate'], intervalSec: 60, startMs: now - 12 * 60_000, dropoutFrom: 6, dropoutLength: 4 })).json();
    expect(again.accepted).toBe(0);                       // identical stream replayed → nothing new stored
    const st = await (await call('viewer', 'GET', `/monitoring/devices/${sim}/status`)).json();
    expect(st.simulation).toBe(true); expect(st.banner).toMatch(/SIMULATION/);
    expect(st.gapsLast24h.heart_rate.length).toBe(1);
    expect((await call('other', 'GET', `/monitoring/devices/${sim}/status`)).status).toBe(404);
  });

  it('real-device ingestion: rejects impossible values, flags clock/latency/out-of-order, stores unusual-but-possible values untouched', async () => {
    const batch = [
      { metric: 'heart_rate', value: 185, unit: '/min', sourceTime: iso(-60) },           // unusual, kept
      { metric: 'heart_rate', value: -3, unit: '/min', sourceTime: iso(-50) },            // impossible → rejected
      { metric: 'heart_rate', value: 70, unit: 'bpm', sourceTime: iso(-40) },             // unit mismatch → rejected
      { metric: 'spo2', value: 91, unit: '%', sourceTime: iso(900) },                      // device clock ahead → flagged
      { metric: 'heart_rate', value: 75, unit: '/min', sourceTime: iso(-3 * 3600) },       // very old + out of order
      { metric: 'heart_rate', value: 185, unit: '/min', sourceTime: iso(-60) },           // duplicate of first
    ];
    const r = await (await call('op', 'POST', `/monitoring/devices/${gw}/observations`, { observations: batch })).json();
    expect(r.accepted).toBe(3); expect(r.duplicates).toBe(1);
    expect(r.rejected.map((x: any) => x.reason).sort()).toEqual(['unit_mismatch', 'value_physically_impossible']);
    // out_of_order = 2: the -3 h reading AND the -60 s reading are both older than the -5 s reading stored by an earlier test.
    expect(r.flagged).toMatchObject({ clock_ahead_of_receipt: 1, high_latency: 1, out_of_order: 2 });
    const hist = await (await call('op', 'GET', `/monitoring/devices/${gw}/observations`)).json();
    // The unusual 185 is stored unmodified; its ONLY flag is ordering (older than a reading stored earlier) — no "error" judgement of the value.
    expect(hist.observations.find((o: any) => o.value === 185).flags).toEqual(['out_of_order']);
    expect(hist.observations.every((o: any) => o.simulation === false)).toBe(true);
    expect(hist.observations.find((o: any) => o.metric === 'spo2').limitation).toMatch(/accuracy limitations/);
  });

  it('FHIR gateway: Observation resources map through the adapter; unsupported content is reported, not guessed', async () => {
    const good = { resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '8310-5' }] }, effectiveDateTime: iso(-30), valueQuantity: { value: 98.6, code: '[degF]' } };
    const badUnit = { resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] }, effectiveDateTime: iso(-20), valueQuantity: { value: 80, code: 'mg' } };
    const r = await (await call('op', 'POST', `/monitoring/devices/${gw}/observations`, { fhir: [good, badUnit] })).json();
    expect(r.accepted).toBe(1); expect(r.adapterProblems.join()).toMatch(/unsupported_unit_mg_for_heart_rate/);
    const t = (await (await call('op', 'GET', `/monitoring/devices/${gw}/observations`)).json()).observations.find((o: any) => o.metric === 'temperature');
    expect(t).toMatchObject({ value: 37, unit: 'Cel', original: { value: 98.6, unit: '[degF]' } }); expect(t.flags).toContain('converted_from_original_unit');
  });

  it('status: silence is never a normal reading (stale → value hidden; disconnected after long silence)', async () => {
    const live = await (await call('op', 'GET', `/monitoring/devices/${gw}/status`)).json();
    expect(live.metrics.find((m: any) => m.metric === 'heart_rate').state).toBe('current');
    const later = await svc.status(gw, new Date(Date.now() + 6 * 60_000));
    const hr = later.metrics.find((m) => m.metric === 'heart_rate')!;
    expect(hr.state).toBe('stale'); expect(hr.value).toBeNull(); expect(hr.lastKnown).not.toBeNull();
    const muchLater = await svc.status(gw, new Date(Date.now() + 3 * 3600_000));
    expect(muchLater.state).toBe('disconnected'); expect(muchLater.metrics.every((m) => m.value === null)).toBe(true);
    const empty = await (await call('op', 'POST', `/patients/${patientId}/monitoring/devices`, { kind: 'manual_entry', label: 'Manual', purpose: 'adapter testing' })).json();
    const es = await (await call('op', 'GET', `/monitoring/devices/${empty.deviceId}/status`)).json();
    expect(es.state).toBe('no_data'); expect(es.metrics.every((m: any) => m.value === null)).toBe(true);
  });

  it('REGRESSION freshness: delayed old reading, out-of-order arrival, clock skew and reconnect backlog never masquerade as current physiology', async () => {
    const mk = async (label: string) => (await (await call('op', 'POST', `/patients/${patientId}/monitoring/devices`, { kind: 'manual_entry', label, purpose: 'freshness regression' })).json()).deviceId as string;
    const put = async (dev: string, observations: unknown[]) => (await (await call('op', 'POST', `/monitoring/devices/${dev}/observations`, { observations })).json());
    const hr = async (dev: string, at = new Date()) => (await svc.status(dev, at)).metrics.find((m) => m.metric === 'heart_rate')!;
    const mkobs = (value: number, sec: number) => ({ metric: 'heart_rate', value, unit: '/min', sourceTime: iso(sec) });

    // 1. measured an hour ago, received now
    const d1 = await mk('Delayed');
    expect((await put(d1, [mkobs(70, -3600)])).flagged.high_latency).toBe(1);
    let m = await hr(d1);
    expect(m.state).toBe('stale'); expect(m.value).toBeNull();
    expect(m.lastKnown).toMatchObject({ value: 70, sourceAge: 'old', receiptAge: 'recent' });
    expect(m.lastKnown!.sourceTime < m.lastKnown!.receivedTime).toBe(true);           // both timestamps retained
    expect((await svc.status(d1)).state).toBe('delayed');
    expect((await (await call('op', 'GET', `/monitoring/devices/${d1}/status`)).json()).metrics.find((x: any) => x.metric === 'heart_rate').value).toBeNull();   // over HTTP too

    // 2. out-of-order: newer measurement first, older one arrives later → the newer measurement stays "latest"
    const d2 = await mk('Out of order');
    await put(d2, [mkobs(80, -10)]); await put(d2, [mkobs(60, -100)]);
    m = await hr(d2);
    expect(m).toMatchObject({ state: 'current', value: 80 });

    // 3. clock skew: far-future source time → untrusted, and it cannot shadow a genuine earlier reading
    const d3 = await mk('Skew');
    expect((await put(d3, [mkobs(99, 3000)])).flagged.clock_ahead_of_receipt).toBe(1);
    m = await hr(d3);
    expect(m).toMatchObject({ state: 'untrusted_time', value: null }); expect(m.lastKnown).toMatchObject({ value: 99 });
    await put(d3, [mkobs(72, -20)]);
    m = await hr(d3);
    expect(m).toMatchObject({ state: 'current', value: 72 }); expect(m.flags).toContain('clock_ahead_of_receipt');
    // within permitted skew (+60 s) is fine
    const d3b = await mk('Small skew'); await put(d3b, [mkobs(71, 60)]);
    expect((await hr(d3b)).state).toBe('current');

    // 4. reconnect backlog: 30 readings spanning the last hour received at once, newest 10 minutes old
    const d4 = await mk('Backlog');
    const r = await put(d4, Array.from({ length: 30 }, (_, i) => mkobs(60 + (i % 5), -4200 + i * 120)));
    expect(r.accepted).toBe(30);
    m = await hr(d4);
    expect(m.state).toBe('stale'); expect(m.value).toBeNull(); expect(m.lastKnown!.sourceAgeSec).toBeGreaterThan(180);
    // a genuinely fresh measurement after catch-up is the only thing that becomes current
    await put(d4, [mkobs(77, -5)]);
    expect(await hr(d4)).toMatchObject({ state: 'current', value: 77 });
    // and it ages out on the SOURCE clock even though the device keeps talking
    await put(d4, [mkobs(78, -1000)]);   // old measurement received later; must not replace the newer one
    expect((await hr(d4, new Date(Date.now() + 5 * 60_000)))).toMatchObject({ state: 'stale', value: null, lastKnown: { value: 77 } });
  });

  it('concurrent ingestion of the same batch stores each observation exactly once', async () => {
    const dev = (await (await call('op', 'POST', `/patients/${patientId}/monitoring/devices`, { kind: 'manual_entry', label: 'Race', purpose: 'adapter testing' })).json()).deviceId;
    const observations = Array.from({ length: 20 }, (_, i) => ({ metric: 'heart_rate', value: 60 + i, unit: '/min', sourceTime: iso(-1200 + i * 30) }));
    const rs = await Promise.all(Array.from({ length: 5 }, () => call('op', 'POST', `/monitoring/devices/${dev}/observations`, { observations }).then((r) => r.json())));
    expect(rs.reduce((a, r) => a + r.accepted, 0)).toBe(20);
    expect((await q('SELECT COUNT(*)::int AS n FROM monitoring_observations WHERE device_id=$1', [dev]))[0].n).toBe(20);
  });

  it('alerts: gated for real devices (409), simulation-only otherwise, with an enforced workflow and DB constraint', async () => {
    const gate = await (await call('op', 'GET', '/monitoring/alert-policy')).json();
    expect(gate.status).toBe('gated');
    const refused = await call('op', 'POST', `/monitoring/devices/${gw}/alerts`);
    expect(refused.status).toBe(409); expect((await refused.json()).code).toBe('alerts_gated_pending_validation');
    const a = await (await call('op', 'POST', `/monitoring/devices/${sim}/alerts`)).json();
    expect(a.simulation).toBe(true); expect(a.banner).toMatch(/no real recipient was notified/);
    expect((await call('op', 'POST', `/monitoring/alerts/${a.id}/close`)).status).toBe(409);         // must acknowledge first
    expect((await call('viewer', 'POST', `/monitoring/alerts/${a.id}/acknowledge`)).status).toBe(403);
    expect((await call('other', 'POST', `/monitoring/alerts/${a.id}/acknowledge`)).status).toBe(404);
    expect((await (await call('op', 'POST', `/monitoring/alerts/${a.id}/acknowledge`)).json()).state).toBe('acknowledged');
    expect((await (await call('op', 'POST', `/monitoring/alerts/${a.id}/close`)).json()).state).toBe('closed');
    // Even a direct database write cannot create a non-simulation alert.
    await expect(q(`INSERT INTO monitoring_alerts (id, device_id, state, record_json, simulation, opened_at) VALUES ('x',$1,'open','{}',FALSE,0)`, [gw])).rejects.toThrow(/check constraint/i);
  });

  it('escalation after a missed acknowledgment is persisted (simulation)', async () => {
    const a = await svc.openSimulationAlert(sim, Date.now() - 10 * 60_000);
    const early = await svc.escalateDue(a.id, { acknowledgeWithinSec: 3600, escalateTo: 'on-call-synthetic' }, Date.now());
    expect(early.state).toBe('open');
    const late = await svc.escalateDue(a.id, { acknowledgeWithinSec: 300, escalateTo: 'on-call-synthetic' }, Date.now());
    expect(late).toMatchObject({ state: 'escalated', escalatedTo: 'on-call-synthetic' });
  });

  it('unpaired devices stop accepting data', async () => {
    const dev = (await (await call('op', 'POST', `/patients/${patientId}/monitoring/devices`, { kind: 'manual_entry', label: 'Temp', purpose: 'adapter testing' })).json()).deviceId;
    expect((await call('op', 'POST', `/monitoring/devices/${dev}/unpair`)).status).toBe(200);
    expect((await call('op', 'POST', `/monitoring/devices/${dev}/observations`, { observations: [{ metric: 'heart_rate', value: 70, unit: '/min', sourceTime: iso(-5) }] })).status).toBe(409);
  });
});
