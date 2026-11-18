/**
 * Patient access control against REAL PostgreSQL (disposable DB; opt-in via
 * ANUCLAW_TEST_PG_URL). Real auth sessions, real routers; the model call
 * (runAgent) is mocked. Synthetic users/patients only.
 */
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const agent = vi.hoisted(() => ({ next: { text: 'draft text', artifacts: [], executionMode: 'host_text_only', warnings: [] } as any, calls: 0 }));
vi.mock('../../container-runner', () => ({ runAgent: vi.fn(async () => { agent.calls++; return agent.next; }) }));

describe.skipIf(!URL_)('patient access control (real PostgreSQL)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client;
  let server: Server;
  let base: string;
  let q: (sql: string, p?: unknown[]) => Promise<any[]>;
  const cookie: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, {
      PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username),
      PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName,
      DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    });
    delete process.env.ANUCLAW_BOOTSTRAP_ADMIN_EMAIL;
    vi.resetModules();
    const conn = await import('../../db/connection');
    await conn.ensureDbReady();
    const { db } = await import('../../db');
    q = (sql, p) => db.query(sql, p as any[]);
    const auth = await import('./auth');
    const express = (await import('express')).default;
    const cookieParser = (await import('cookie-parser')).default;
    const patients = (await import('./routes/patients')).default;

    for (const role of ['admin', 'operator', 'operator2', 'viewer', 'auditor']) {
      const id = crypto.randomUUID();
      ids[role] = id;
      await q(`INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1, $2, $3, 'x', 0)`,
        [id, `${role}@clinic-synthetic.org`, role === 'operator2' ? 'operator' : role]);
      const { accessToken } = await auth.issueTokens(id);
      cookie[role] = `dash_token=${accessToken}`;
    }
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api/patients', patients);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/patients`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { (await import('../../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    }
  });

  const call = (who: string, method: string, path = '', body?: unknown) =>
    fetch(base + path, { method, headers: { cookie: cookie[who], 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

  let patientId: string;

  it('creator becomes owner; other users cannot see or open the record', async () => {
    const r = await call('operator', 'POST', '', { name: 'Synthetic Person', conditions: ['condition-a'] });
    expect(r.status).toBe(201);
    patientId = (await r.json()).id;

    expect((await (await call('operator', 'GET')).json()).total).toBe(1);
    expect((await (await call('operator2', 'GET')).json()).total).toBe(0);
    expect((await call('operator2', 'GET', `/${patientId}`)).status).toBe(404);
    expect((await call('viewer', 'GET', `/${patientId}`)).status).toBe(404);
    expect((await call('admin', 'GET', `/${patientId}`)).status).toBe(404); // admins are not implicitly granted
  });

  it('auditor/compliance roles have no patient-data access', async () => {
    expect((await call('auditor', 'GET')).status).toBe(403);
    expect((await call('auditor', 'POST', '', { name: 'x' })).status).toBe(403);
  });

  it('a pre-existing unowned row is invisible to everyone until explicitly assigned', async () => {
    const legacyId = crypto.randomUUID();
    await q(`INSERT INTO patients (id, uid, name, created_at, updated_at) VALUES ($1, $2, 'Legacy Synthetic', 0, 0)`, [legacyId, `L-${legacyId}`]);
    for (const who of ['admin', 'operator', 'operator2', 'viewer']) {
      expect((await call(who, 'GET', `/${legacyId}`)).status).toBe(404);
    }
    const un = await (await call('admin', 'GET', '/unassigned')).json();
    const row = un.unassigned.find((x: any) => x.id === legacyId);
    expect(row).toBeDefined();
    expect(row.name).toBeUndefined(); // no clinical/identifying fields beyond id/uid
    expect((await call('operator', 'GET', '/unassigned')).status).toBe(403);

    // Explicit, audited assignment with purpose.
    expect((await call('admin', 'POST', `/${legacyId}/access`, { user_id: ids.viewer, access_level: 'read' })).status).toBe(400);
    expect((await call('admin', 'POST', `/${legacyId}/access`, { user_id: ids.viewer, access_level: 'write', purpose: 'care team' })).status).toBe(400);
    expect((await call('admin', 'POST', `/${legacyId}/access`, { user_id: ids.viewer, access_level: 'read', purpose: 'care team review' })).status).toBe(200);
    expect((await call('viewer', 'GET', `/${legacyId}`)).status).toBe(200);
    expect((await call('viewer', 'PUT', `/${legacyId}`, { name: 'changed' })).status).toBe(403);
    expect((await call('viewer', 'DELETE', `/${legacyId}`)).status).toBe(403);
    const auditRows = await q(`SELECT action FROM audit_events WHERE target_id = $1`, [legacyId]);
    expect(auditRows.map((r) => r.action)).toContain('patient.access.grant');

    // Revocation takes effect immediately.
    expect((await call('admin', 'DELETE', `/${legacyId}/access/${ids.viewer}`)).status).toBe(200);
    expect((await call('viewer', 'GET', `/${legacyId}`)).status).toBe(404);
  });

  it('analysis requires write access, stores a labelled draft, and never mutates the record', async () => {
    agent.calls = 0;
    expect((await call('operator2', 'POST', `/${patientId}/analyse`, { analysis_type: 'risk_stratification' })).status).toBe(404);
    expect(agent.calls).toBe(0);

    agent.next = { text: 'Overall risk 99. Documented factors: ...', artifacts: [], executionMode: 'host_text_only', warnings: [] };
    const before = (await q('SELECT risk_score, risk_level, ai_summary FROM patients WHERE id = $1', [patientId]))[0];
    const r = await call('operator', 'POST', `/${patientId}/analyse`, { analysis_type: 'risk_stratification' });
    expect(await r.text()).toContain('draft_unreviewed');
    const after = (await q('SELECT risk_score, risk_level, ai_summary FROM patients WHERE id = $1', [patientId]))[0];
    expect(after).toEqual(before);
    const a = await q('SELECT status, execution_mode, created_by FROM patient_analyses WHERE patient_id = $1', [patientId]);
    expect(a).toEqual([{ status: 'draft_unreviewed', execution_mode: 'host_text_only', created_by: ids.operator }]);
  });

  it('a failed model run stores nothing and reports failure', async () => {
    agent.next = { text: '', artifacts: [], error: 'provider_request_failed', executionMode: 'host_text_only', warnings: [] };
    const body = await (await call('operator', 'POST', `/${patientId}/analyse`, { analysis_type: 'general' })).text();
    expect(body).toContain('"success":false');
    const a = await q('SELECT COUNT(*)::int AS n FROM patient_analyses WHERE patient_id = $1', [patientId]);
    expect(a[0].n).toBe(1);
  });

  it('bulk risk scoring is explicitly not implemented', async () => {
    expect((await call('operator', 'POST', '/bulk/risk-score')).status).toBe(501);
  });

  it('only the owner can delete', async () => {
    expect((await call('admin', 'POST', `/${patientId}/access`, { user_id: ids.operator2, access_level: 'write', purpose: 'cover shift' })).status).toBe(200);
    expect((await call('operator2', 'DELETE', `/${patientId}`)).status).toBe(404);
    expect((await call('operator', 'DELETE', `/${patientId}`)).status).toBe(200);
  });
});
