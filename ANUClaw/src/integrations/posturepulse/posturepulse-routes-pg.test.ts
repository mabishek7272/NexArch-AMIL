/** PosturePulse import routes against REAL PostgreSQL: ANUClaw's OWN patient authorization stays enforced (a valid signature/token never substitutes for it). Synthetic only. */
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { bundlePayloadOf, syntheticPosture } from './fixtures';
import { signBundle } from './upstream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
const SECRET = 'route-test-secret-'.padEnd(40, 'q');
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('PosturePulse import routes: ANUClaw patient authorization (real PostgreSQL)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let server: Server; let base: string;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let svc: typeof import('../../monitoring/service');
  const cookie: Record<string, string> = {}; const ids: Record<string, string> = {};
  let patientId: string;

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName, DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex'), ANUCLAW_POSTUREPULSE_IMPORT_SECRET: SECRET });
    vi.resetModules();
    await (await import('../../db/connection')).ensureDbReady();
    q = (await import('../../db')).db.query as any;
    svc = await import('../../monitoring/service');
    const auth = await import('../../dashboard/server/auth');
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
    app.use('/api/clinical', (await import('../../dashboard/server/routes/documents')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/clinical`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { (await import('../../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const call = (who: string | null, method: string, p: string, body?: unknown) => fetch(base + p, { method, headers: { ...(who ? { cookie: cookie[who] } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const f = syntheticPosture({ session: 'session-route-1' });
  const bundle = () => ({ bundle: signBundle(bundlePayloadOf(f) as any, SECRET) });

  it('linking a subject is admin-only; unauthenticated callers get 401', async () => {
    expect((await call(null, 'POST', `/patients/${patientId}/posture/links`, {})).status).toBe(401);
    expect((await call('op', 'POST', `/patients/${patientId}/posture/links`, { subjectPseudoId: 'subj-synthetic-001', consentRecordId: 'consent-synthetic-001', purpose: 'route test (synthetic)' })).status).toBe(403);
    await q(`INSERT INTO posture_subject_links (id, patient_id, subject_pseudo_id, consent_record_id, purpose, linked_by, linked_at) VALUES ($1,$2,'subj-synthetic-001','consent-synthetic-001','route test (synthetic)','admin',0)`, [crypto.randomUUID(), patientId]);
  });

  it('a VALID signed bundle is still refused for a user with no grant on the patient (404), a read-only user (403) and no session (401)', async () => {
    expect((await call(null, 'POST', `/patients/${patientId}/posture/import-signed`, bundle())).status).toBe(401);
    expect((await call('other', 'POST', `/patients/${patientId}/posture/import-signed`, bundle())).status).toBe(404);
    expect((await call('viewer', 'POST', `/patients/${patientId}/posture/import-signed`, bundle())).status).toBe(403);
    expect((await q('SELECT COUNT(*)::int AS n FROM posture_reports'))[0].n).toBe(0);       // nothing was stored by any refused call
  });

  it('the other verified and unverified import routes enforce the same grants', async () => {
    const body = { sessionId: 'x', reportAccessToken: 'y', clinicianToken: 'z' };
    expect((await call('other', 'POST', `/patients/${patientId}/posture/import`, body)).status).toBe(404);
    expect((await call('viewer', 'POST', `/patients/${patientId}/posture/import`, body)).status).toBe(403);
    expect((await call('viewer', 'POST', `/patients/${patientId}/posture/import-unverified`, {})).status).toBe(403);
    expect((await call('other', 'POST', `/patients/${patientId}/posture/import-unverified`, {})).status).toBe(404);
  });

  it('reading imported posture data needs a read grant: the owner and the read-only user can, another operator and anonymous callers cannot', async () => {
    const ok = await call('op', 'POST', `/patients/${patientId}/posture/import-signed`, bundle());
    expect(ok.status).toBe(201); expect((await ok.json()).verification).toBe('signed_bundle_verified');
    expect((await call('op', 'GET', `/patients/${patientId}/posture`)).status).toBe(200);
    const v = await call('viewer', 'GET', `/patients/${patientId}/posture`); expect(v.status).toBe(200);
    const rep = (await v.json()).reports[0];
    expect(rep.integrity.signOffDigest).toMatch(/UPSTREAM SIGNED CLAIM/); expect(rep.integrity.authentication).toMatch(/NOT which clinician/);
    expect((await call('other', 'GET', `/patients/${patientId}/posture`)).status).toBe(404);
    expect((await call(null, 'GET', `/patients/${patientId}/posture`)).status).toBe(401);
  });

  it('a patient that exists but is not linked to the bundle\'s subject cannot receive it, even for its owner', async () => {
    const p2 = crypto.randomUUID();
    await q(`INSERT INTO patients (id, uid, name, created_at, updated_at) VALUES ($1,$2,'Synthetic Two',0,0)`, [p2, `S-${p2}`]);
    await q(`INSERT INTO patient_access (patient_id, user_id, access_level, purpose, granted_by, granted_at) VALUES ($1,$2,'owner','t',$2,0)`, [p2, ids.op]);
    const f2 = syntheticPosture({ session: 'session-route-2' }); f2.report.reportId = 'report-route-2';
    const r = await call('op', 'POST', `/patients/${p2}/posture/import-signed`, { bundle: signBundle(bundlePayloadOf(f2) as any, SECRET) });
    expect(r.status).toBe(403); expect((await r.json()).code ?? (await r.clone().text())).toBeTruthy();
  });
});
