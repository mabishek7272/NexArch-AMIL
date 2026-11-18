/**
 * /v1 BaaS API against REAL PostgreSQL (disposable; opt-in). Real tenant
 * registration (hashed keys), real API-key auth, real shared-store limits,
 * real workflow. Synthetic tenants and documents only.
 */
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTestPdf } from '../../documents/test-pdf';
import { buildOpenApiV1 } from '../openapi-v1';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe('OpenAPI contract matches implemented /v1 routes', () => {
  it('every route is documented and every documented operation exists', async () => {
    const { listV1Routes } = await import('./baas-v1');
    const impl = new Set(listV1Routes().map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, '{$1}')}`));
    const spec = new Set(Object.entries(buildOpenApiV1().paths).flatMap(([p, ops]) => Object.keys(ops as object).map((m) => `${m.toUpperCase()} ${p}`)));
    expect([...impl].sort()).toEqual([...spec].sort());
  });
});

describe.skipIf(!URL_)('/v1 BaaS (real PostgreSQL)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let server: Server; let base: string;
  const key: Record<string, string> = {};

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName, ANUCLAW_DOCUMENT_DIR: `/tmp/anuclaw-v1-${crypto.randomBytes(4).toString('hex')}` });
    delete process.env.ANUCLAW_RATE_STORE;
    vi.resetModules();
    await (await import('../../db/connection')).ensureDbReady();
    const store = await import('../tenant-store');
    key.a = (await store.registerTenant('Synthetic A', 'a@synthetic.invalid', 'pro')).api_key;
    key.b = (await store.registerTenant('Synthetic B', 'b@synthetic.invalid', 'pro')).api_key;
    const express = (await import('express')).default;
    const app = express(); app.use(express.json());
    app.use((await import('./baas-v1')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { (await import('../../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const call = (who: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method, headers: { ...(who ? { 'x-api-key': key[who] } : {}), 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const upload = (who: string, patientId: string, buf: Buffer, headers: Record<string, string> = {}) => {
    const fd = new FormData(); fd.append('file', new Blob([buf]), 'r.pdf'); fd.append('purpose', 'synthetic api test');
    return fetch(`${base}/v1/patients/${patientId}/documents`, { method: 'POST', headers: { 'x-api-key': key[who], ...headers }, body: fd });
  };

  let patientA: string; let docId: string; let snapId: string; let analysisId: string; let reportId: string;

  it('auth required; contract served', async () => {
    expect((await call(null, 'POST', '/v1/patients', { display_name: 'x' })).status).toBe(401);
    expect((await call(null, 'GET', '/v1/openapi.json')).status).toBe(200);
    const e = await (await call('a', 'GET', '/v1/engines')).json();
    expect(e.engines[0].clinicalState).toBe('no_released_rules');
    expect(e.signOff.available).toBe(false);
  });

  it('idempotent patient creation', async () => {
    const h = { 'idempotency-key': 'create-patient-0001' };
    const r1 = await call('a', 'POST', '/v1/patients', { display_name: 'Synthetic Subject' }, h);
    expect(r1.status).toBe(201);
    patientA = (await r1.json()).id;
    const r2 = await call('a', 'POST', '/v1/patients', { display_name: 'Synthetic Subject' }, h);
    expect(r2.headers.get('idempotent-replayed')).toBe('true');
    expect((await r2.json()).id).toBe(patientA);
    expect((await call('a', 'POST', '/v1/engines-nope', {}, h)).status).toBe(404);
    expect((await call('a', 'POST', `/v1/patients/${patientA}/documents`, {}, h)).status).toBe(422); // key reused on another route
  });

  it('full workflow over the API, with tenant isolation at every step', async () => {
    const up = await upload('a', patientA, buildTestPdf([['Hemoglobin 16.4 g/dL 12.0-15.5', 'Sodium 140 mmol/L 135-145']]));
    expect(up.status).toBe(201);
    docId = (await up.json()).documentId;
    expect((await upload('b', patientA, buildTestPdf([['x 1 u']]))).status).toBe(404);
    expect((await call('b', 'GET', `/v1/documents/${docId}`)).status).toBe(404);

    const review = await (await call('a', 'GET', `/v1/documents/${docId}`)).json();
    expect((await call('b', 'POST', `/v1/candidates/${review.candidates[0].id}/decision`, { action: 'confirm' })).status).toBe(404);
    expect((await call('a', 'POST', `/v1/documents/${docId}/snapshots`)).status).toBe(409);
    for (const c of review.candidates) expect((await call('a', 'POST', `/v1/candidates/${c.id}/decision`, { action: 'confirm' })).status).toBe(200);

    snapId = (await (await call('a', 'POST', `/v1/documents/${docId}/snapshots`)).json()).snapshotId;
    expect((await call('b', 'POST', `/v1/snapshots/${snapId}/analyses`)).status).toBe(404);
    analysisId = (await (await call('a', 'POST', `/v1/snapshots/${snapId}/analyses`)).json()).engineRunId;
    expect((await (await call('a', 'GET', `/v1/jobs/${analysisId}`)).json()).status).toBe('completed');
    expect((await call('b', 'GET', `/v1/jobs/${analysisId}`)).status).toBe(404);

    expect((await call('a', 'POST', `/v1/snapshots/${snapId}/reports`, {})).status).toBe(400);
    const rep = await call('a', 'POST', `/v1/snapshots/${snapId}/reports`, { analysis_id: analysisId });
    expect(rep.status).toBe(201);
    reportId = (await rep.json()).reportId;
    expect((await call('b', 'GET', `/v1/reports/${reportId}`)).status).toBe(404);
    expect((await call('a', 'POST', `/v1/reports/${reportId}/review`)).status).toBe(403);

    const pdf = await call('a', 'GET', `/v1/reports/${reportId}/export.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('x-report-status')).toBe('draft');
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await call('b', 'GET', `/v1/reports/${reportId}/export.html`)).status).toBe(404);
  });

  it('observations are listed only for the owning tenant; evidence search reports no_evidence honestly', async () => {
    expect((await (await call('a', 'GET', `/v1/patients/${patientA}/observations`)).json()).observations).toHaveLength(2);
    expect((await call('b', 'GET', `/v1/patients/${patientA}/observations`)).status).toBe(404);
    expect((await (await call('a', 'GET', '/v1/evidence/search?q=sodium%20units')).json()).status).toBe('no_evidence');
  });

  it('GET /v1/spend reports only the caller tenant\'s model spend; unknown cost is flagged; bad dates rejected', async () => {
    const { db } = await import('../../db');
    const tid = async (email: string) => (await db.queryOne<{ tenant_id: string }>('SELECT tenant_id FROM tenants WHERE email = $1', [email]))!.tenant_id;
    const ta = await tid('a@synthetic.invalid'), tb = await tid('b@synthetic.invalid');
    const ins = (scope: string, state: string, actual: number | null) => db.query(
      `INSERT INTO model_spend_ledger (id, scope_kind, scope_id, period, role, model, data_class, state, reserved_usd, actual_usd, attempts, created_at)
       VALUES ($1,'tenant',$2,'2031-02-03','review','m','synthetic_test',$3,0.02,$4,1,0)`, [crypto.randomUUID(), scope, state, actual]);
    await ins(ta, 'settled', 0.003); await ins(ta, 'unknown_cost', null); await ins(tb, 'settled', 0.5);
    const a = await (await call('a', 'GET', '/v1/spend?from=2031-02-03&to=2031-02-03')).json();
    expect(a.totals).toMatchObject({ calls: 2, knownCostUsd: 0.003, unknownCostCalls: 1, totalIsLowerBound: true });
    const b = await (await call('b', 'GET', '/v1/spend?from=2031-02-03&to=2031-02-03')).json();
    expect(b.totals).toMatchObject({ calls: 1, knownCostUsd: 0.5, totalIsLowerBound: false });
    expect(JSON.stringify(a)).not.toContain(tb);
    expect((await call('a', 'GET', '/v1/spend?from=yesterday')).status).toBe(400);
    expect((await call('a', 'GET', '/v1/spend?from=2031-13-40&to=2031-13-41')).status).toBe(400);   // well-shaped but not a real day
    expect((await call('a', 'GET', '/v1/spend?from=2031-02-05&to=2031-02-03')).status).toBe(400);   // from after to
    expect((await call(null, 'GET', '/v1/spend')).status).toBe(401);
  });

  it('a dashboard-managed patient (no tenant) is not reachable through the API', async () => {
    const pid = crypto.randomUUID();
    await admin.query(`SELECT 1`);
    const { db } = await import('../../db');
    await db.query(`INSERT INTO patients (id, uid, name, created_at, updated_at) VALUES ($1,$2,'Dash Synthetic',0,0)`, [pid, `D-${pid}`]);
    expect((await call('a', 'GET', `/v1/patients/${pid}/documents`)).status).toBe(404);
  });
});
