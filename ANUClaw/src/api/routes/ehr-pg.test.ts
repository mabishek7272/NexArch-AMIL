/**
 * API EHR persistence against REAL PostgreSQL (disposable; opt-in via
 * ANUCLAW_TEST_PG_URL). Tenant auth is mocked to take the tenant from a test
 * header; metering is a pass-through. Synthetic data only.
 */
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../middleware/auth', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const t = req.header('x-test-tenant');
    if (!t) { res.status(401).json({ error: 'no tenant' }); return; }
    req.tenant = { tenant_id: t, status: 'active' };
    next();
  },
}));
vi.mock('../middleware/usage-meter', () => ({ usageMeter: (_q: any, _s: any, n: any) => n() }));

describe.skipIf(!URL_)('API EHR persistence (real PostgreSQL)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, {
      PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username),
      PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName,
    });
    vi.resetModules();
    await (await import('../../db/connection')).ensureDbReady();
    const { db } = await import('../../db');
    for (const t of ['tenant-a', 'tenant-b', 'tenant-c']) {
      await db.query(`INSERT INTO tenants (tenant_id, company_name, email, api_key, plan, rate_limit_per_min, created_at) VALUES ($1,'Synthetic',$2,$3,'pro',0,'x')`, [t, `${t}@synthetic.invalid`, `hashed:${t}`]);
    }
    const express = (await import('express')).default;
    const ehr = (await import('./ehr')).default;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/ehr', ehr);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/ehr`;
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

  const call = (tenant: string, method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { 'x-test-tenant': tenant, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const PERSON = { first_name: 'Synth', last_name: 'Example', date_of_birth: '1980-02-29', gender: 'female', country_code: 'gb' };
  let uid: string;

  it('registers with a real write (201 after commit) and detects duplicates (409)', async () => {
    const r = await call('tenant-a', 'POST', '/patients', PERSON);
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.persisted).toBe(true);
    uid = body.patient.uid;
    expect(uid).toMatch(/^ANU-GB-[0-9A-F]{16}$/);
    const dup = await call('tenant-a', 'POST', '/patients', { ...PERSON, first_name: '  SYNTH ' });
    expect(dup.status).toBe(409);
    expect((await dup.json()).uid).toBe(uid);
  });

  it('validates input', async () => {
    expect((await call('tenant-a', 'POST', '/patients', { ...PERSON, date_of_birth: '1981-02-29' })).status).toBe(400);
    expect((await call('tenant-a', 'POST', '/patients', { ...PERSON, date_of_birth: '2999-01-01' })).status).toBe(400);
    expect((await call('tenant-a', 'POST', '/patients', { ...PERSON, gender: 'x' })).status).toBe(400);
  });

  it('search is reachable (not shadowed by /:uid) and tenant-scoped', async () => {
    const qs = '/patients/search?first_name=synth&last_name=example&date_of_birth=1980-02-29&gender=female';
    const a = await (await call('tenant-a', 'GET', qs)).json();
    expect(a.matches.map((m: any) => m.uid)).toEqual([uid]);
    const b = await (await call('tenant-b', 'GET', qs)).json();
    expect(b.matches).toEqual([]);
  });

  it('other tenants cannot read or write the record', async () => {
    expect((await call('tenant-b', 'GET', `/patients/${uid}`)).status).toBe(404);
    expect((await call('tenant-b', 'POST', `/patients/${uid}/diagnoses`, { description: 'x' })).status).toBe(404);
    expect((await call('tenant-b', 'POST', `/patients/${uid}/fhir`)).status).toBe(404);
  });

  it('records persist exactly as supplied and appear on lookup', async () => {
    expect((await call('tenant-a', 'POST', `/patients/${uid}/diagnoses`, { description: 'Synthetic condition', icd10_code: 'Z00.0' })).status).toBe(201);
    expect((await call('tenant-a', 'POST', `/patients/${uid}/prescriptions`, { medication_name: 'Example', dosage: '1 tab', frequency: 'daily', start_date: '2026-01-01' })).status).toBe(201);
    expect((await call('tenant-a', 'POST', `/patients/${uid}/lab-reports`, { test_name: 'Analyte X', value: '<0.01', unit: 'ng/mL' })).status).toBe(201);
    expect((await call('tenant-a', 'POST', `/patients/${uid}/prescriptions`, { medication_name: 'Example' })).status).toBe(400);
    expect((await call('tenant-a', 'POST', `/patients/ANU-GB-NOPE/diagnoses`, { description: 'x' })).status).toBe(404);
    const look = await (await call('tenant-a', 'GET', `/patients/${uid}`)).json();
    expect(look.records.map((r: any) => r.kind)).toEqual(['diagnosis', 'prescription', 'lab_report']);
    expect(look.records[2].data.value).toBe('<0.01'); // inequality preserved, no conversion
  });

  it('FHIR export renders stored rows; HL7 export is explicitly not implemented', async () => {
    const f = await (await call('tenant-a', 'POST', `/patients/${uid}/fhir`)).json();
    expect(f.bundle.entry.map((e: any) => e.resource.resourceType)).toEqual(['Patient', 'Condition', 'MedicationStatement', 'Observation']);
    expect(f.bundle.entry[3].resource.valueString).toBe('<0.01 ng/mL');
    expect(f.conformance).toMatch(/Not validated/);
    expect((await call('tenant-a', 'POST', `/patients/${uid}/hl7`)).status).toBe(501);
  });

  it('concurrent duplicate registrations: exactly one 201', async () => {
    const p = { ...PERSON, first_name: 'Race', last_name: 'Case' };
    const codes = await Promise.all(Array.from({ length: 6 }, () => call('tenant-c', 'POST', '/patients', p).then((r) => r.status)));
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(5);
  });
});
