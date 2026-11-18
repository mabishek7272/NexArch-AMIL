/** Research workspace over HTTP against REAL PostgreSQL (disposable; opt-in). Synthetic data only. */
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import V from './scipy-vectors.json';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('research workspace (real PostgreSQL)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let server: Server; let base: string;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  const cookie: Record<string, string> = {};

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName, DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex'), ANUCLAW_RESEARCH_MIN_CELL: '1' });
    vi.resetModules();
    await (await import('../db/connection')).ensureDbReady();
    q = (await import('../db')).db.query as any;
    const auth = await import('../dashboard/server/auth');
    for (const [k, role] of [['r1', 'operator'], ['r2', 'operator'], ['viewer', 'viewer']]) {
      const id = crypto.randomUUID();
      await q(`INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1,$2,$3,'x',0)`, [id, `${k}@clinic-synthetic.org`, role]);
      cookie[k] = `dash_token=${(await auth.issueTokens(id)).accessToken}`;
    }
    const express = (await import('express')).default; const cookieParser = (await import('cookie-parser')).default;
    const app = express(); app.use(cookieParser()); app.use(express.json());
    app.use('/api/research', (await import('../dashboard/server/routes/research')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/research`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { (await import('../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const csv = ['value,grp', ...V.welch.a.map((v) => `${v},A`), ...V.welch.b.map((v) => `${v},B`)].join('\n');
  const predCsv = ['y,score', ...V.auc.y.map((y, i) => `${y},${V.auc.score[i]}`)].join('\n');
  const attest = { deidentified: true, authorised: true, statement: 'Synthetic test data generated for verification.' };
  const upload = (who: string, text: string, over: Record<string, unknown> = {}) => {
    const fd = new FormData();
    fd.append('file', new Blob([text]), 'd.csv');
    fd.append('name', String(over.name ?? 'Synthetic set')); fd.append('purpose', String(over.purpose ?? 'verification of the research workflow'));
    fd.append('dictionary', JSON.stringify(over.dictionary ?? Object.fromEntries(text.split('\n')[0].split(',').map((c) => [c, `synthetic column ${c}`]))));
    fd.append('attestation', JSON.stringify(over.attestation ?? attest));
    return fetch(`${base}/datasets`, { method: 'POST', headers: { cookie: cookie[who] }, body: fd });
  };
  const call = (who: string, method: string, p: string, body?: unknown) => fetch(base + p, { method, headers: { cookie: cookie[who], 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

  let ds: string; let runId: string;

  it('roles: viewers are excluded; no cookie → 401', async () => {
    expect((await call('viewer', 'GET', '')).status).toBe(403);
    expect((await fetch(base)).status).toBe(401);
    expect((await call('r1', 'GET', '')).status).toBe(200);
  });

  it('dataset governance: attestation, dictionary, identifiers, duplicates', async () => {
    expect((await upload('r1', csv, { attestation: { deidentified: true } })).status).toBe(400);
    expect((await upload('r1', csv, { dictionary: { value: 'only one column described' } })).status).toBe(400);
    expect((await upload('r1', 'patient_name,v\nJane,1\n', {})).status).toBe(422);
    const ok = await upload('r1', csv);
    expect(ok.status).toBe(201);
    ds = (await ok.json()).datasetId;
    expect((await upload('r1', csv)).status).toBe(409);
    expect((await (await call('r1', 'GET', '/datasets')).json()).datasets).toHaveLength(1);
    expect((await (await call('r2', 'GET', '/datasets')).json()).datasets).toHaveLength(0); // owner-only
  });

  it('runs a registered analysis; results match scipy; record is complete and verified', async () => {
    const r = await call('r1', 'POST', `/datasets/${ds}/runs`, { analysis: 'compare_groups', params: { value: 'value', group: 'grp', groupA: 'A', groupB: 'B' } });
    expect(r.status).toBe(201);
    const body = await r.json();
    runId = body.runId;
    expect(body.output.results.result.p).toBeCloseTo(V.welch.p, 7);
    expect(body.output.validation.clinicalClaims).toBe('prohibited');
    const got = await (await call('r1', 'GET', `/runs/${runId}`)).json();
    expect(got.integrity).toBe('verified');
    expect((await call('r2', 'GET', `/runs/${runId}`)).status).toBe(404);              // owner-only
    expect((await call('r2', 'POST', `/datasets/${ds}/runs`, { analysis: 'descriptive' })).status).toBe(404);
  });

  it('unknown analyses and bad parameters are explicit; failed runs are recorded', async () => {
    expect((await call('r1', 'POST', `/datasets/${ds}/runs`, { analysis: 'run_arbitrary_code' })).status).toBe(400);
    const bad = await call('r1', 'POST', `/datasets/${ds}/runs`, { analysis: 'compare_groups', params: { value: 'missing', group: 'grp', groupA: 'A', groupB: 'B' } });
    expect(bad.status).toBe(422);
    const failedId = (await bad.json()).details.runId;
    expect((await q('SELECT status, error_code FROM research_runs WHERE id=$1', [failedId]))[0]).toEqual({ status: 'failed', error_code: 'unknown_column' });
  });

  it('re-run reproduces the identical output hash; tampering is detected', async () => {
    const rr = await (await call('r1', 'POST', `/runs/${runId}/rerun`)).json();
    expect(rr.reproduced).toBe(true);
    expect(rr.newOutputSha256).toBe(rr.originalOutputSha256);
    await q(`UPDATE research_runs SET output_json = replace(output_json, 'Welch', 'Student') WHERE id = $1`, [runId]);
    expect((await (await call('r1', 'GET', `/runs/${runId}`)).json()).integrity).toBe('MISMATCH');
    const art = await (await call('r1', 'GET', `/runs/${runId}/artifact.json`)).json();
    expect(art.integrity).toBe('MISMATCH');
    expect(art.labels).toEqual({ researchOnly: true, validation: 'unvalidated_research_only', clinicalClaims: 'prohibited' });
  });

  it('gated analyses (prediction, biomarker) require the research-only acknowledgement', async () => {
    const d = await (await upload('r1', predCsv, { name: 'pred set' })).json();
    const params = { outcome: 'y', score: 'score' };
    const refused = await call('r1', 'POST', `/datasets/${d.datasetId}/runs`, { analysis: 'prediction_evaluation', params });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe('research_only_acknowledgement_required');
    const ok = await call('r1', 'POST', `/datasets/${d.datasetId}/runs`, { analysis: 'prediction_evaluation', params, acknowledgeResearchOnly: true });
    expect(ok.status).toBe(201);
    const out = (await ok.json()).output;
    expect(out.results.auc).toBeCloseTo(V.auc.auc, 12);
    expect(out.notAssessed).toEqual(expect.arrayContaining(['external validation', 'prospective workflow evidence']));
    expect(out.validation).toEqual({ status: 'unvalidated_research_only', clinicalClaims: 'prohibited' });
  });

  it('a prespecified plan is hashed and labelled "as prespecified" (not independently verified)', async () => {
    const plan = { endpoint: 'mean difference of value between A and B', method: 'Welch t-test' };
    const r = await (await call('r1', 'POST', `/datasets/${ds}/runs`, { analysis: 'compare_groups', params: { value: 'value', group: 'grp', groupA: 'A', groupB: 'B' }, plan })).json();
    expect(r.output.class).toBe('confirmatory_as_prespecified');
    expect((await call('r1', 'POST', `/datasets/${ds}/runs`, { analysis: 'descriptive', plan: { endpoint: 'x' } })).status).toBe(400);
  });
});
