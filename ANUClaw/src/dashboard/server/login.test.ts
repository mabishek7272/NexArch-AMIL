/**
 * Login / password-change route behaviour with a MOCKED database. These prove
 * the route logic (CAS upgrade, expected-hash checks). Real lock behaviour is
 * verified separately against PostgreSQL in src/db/pg-integration.test.ts.
 */
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: { query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn() } }));
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { db } from '../../db';
import { hashPassword, legacyHashForTests, verifyPassword } from '../../security/password';
import usersRouter, { __loginThrottle } from './routes/users';

const PW = 'Synthetic-Pass-42!';
const USER_ID = 'user-1';
let storedHash: string;
/** Simulates another transaction changing the hash between steps. */
let changeHashBeforeUpgrade: string | null;
let changeHashBeforeSession: string | null;
let sessionsInserted: number;
let casUpdates: Array<unknown[]>;
let server: Server;
let base: string;
const savedSecret = process.env.DASHBOARD_JWT_SECRET;

beforeAll(async () => {
  process.env.DASHBOARD_JWT_SECRET = crypto.randomBytes(32).toString('hex');
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/auth', usersRouter);
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (savedSecret === undefined) delete process.env.DASHBOARD_JWT_SECRET;
  else process.env.DASHBOARD_JWT_SECRET = savedSecret;
});

beforeEach(async () => {
  storedHash = await hashPassword(PW);
  changeHashBeforeUpgrade = null;
  changeHashBeforeSession = null;
  sessionsInserted = 0;
  casUpdates = [];
  vi.mocked(db.query).mockReset().mockResolvedValue([]);
  vi.mocked(db.queryOne).mockReset().mockImplementation(async (sql: string, params?: any[]) => {
    if (/FROM dash_users WHERE email=\$1/.test(sql)) {
      return params?.[0] === 'user@clinic-synthetic.org'
        ? { id: USER_ID, email: 'user@clinic-synthetic.org', name: null, role: 'viewer', password_hash: storedHash }
        : undefined;
    }
    return undefined;
  });
  vi.mocked(db.transaction).mockReset().mockImplementation(async (fn: any) =>
    fn({
      query: async (sql: string, params: any[] = []) => {
        if (/UPDATE dash_users SET password_hash = \$1 WHERE id = \$2 AND password_hash = \$3/.test(sql)) {
          casUpdates.push(params);
          if (changeHashBeforeUpgrade) storedHash = changeHashBeforeUpgrade;
          if (storedHash !== params[2]) return { rows: [], rowCount: 0 };
          storedHash = params[0];
          return { rows: [], rowCount: 1 };
        }
        if (/FOR SHARE/.test(sql)) {
          if (changeHashBeforeSession) storedHash = changeHashBeforeSession;
          return { rows: [{ password_hash: storedHash }], rowCount: 1 };
        }
        if (/INSERT INTO dash_sessions/.test(sql)) { sessionsInserted++; return { rows: [], rowCount: 1 }; }
        return { rows: [], rowCount: 1 };
      },
    }),
  );
});
afterEach(() => vi.clearAllMocks());
beforeEach(() => { (__loginThrottle.loginFailures as any).windows.clear(); (__loginThrottle.loginAttemptsPerIp as any).windows.clear(); });

const login = (email: string, password: string) =>
  fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });

describe('login', () => {
  it('signs in with a current scrypt hash and does not rehash', async () => {
    const r = await login('user@clinic-synthetic.org', PW);
    expect(r.status).toBe(200);
    expect(sessionsInserted).toBe(1);
    expect(casUpdates).toHaveLength(0);
  });

  it('rejects a wrong password and an unknown account identically, with no session', async () => {
    const a = await login('user@clinic-synthetic.org', 'Wrong-Pass-42!!');
    const b = await login('nobody@clinic-synthetic.org', PW);
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(await a.json()).toEqual(await b.json());
    expect(sessionsInserted).toBe(0);
  });

  it('upgrades a legacy hash with compare-and-set after a successful login', async () => {
    const legacy = legacyHashForTests(PW);
    storedHash = legacy;
    const r = await login('user@clinic-synthetic.org', PW);
    expect(r.status).toBe(200);
    expect(casUpdates).toHaveLength(1);
    expect(casUpdates[0][2]).toBe(legacy); // CAS on the exact verified hash
    expect(storedHash).toMatch(/^scrypt\$1\$/);
    expect((await verifyPassword(PW, storedHash)).ok).toBe(true);
    expect(sessionsInserted).toBe(1);
  });

  it('does not upgrade a legacy hash when the password is wrong', async () => {
    storedHash = legacyHashForTests(PW);
    expect((await login('user@clinic-synthetic.org', 'Wrong-Pass-42!!')).status).toBe(401);
    expect(casUpdates).toHaveLength(0);
  });

  it('issues no session if the password changed before the upgrade (CAS loses)', async () => {
    storedHash = legacyHashForTests(PW);
    changeHashBeforeUpgrade = await hashPassword('Someone-Else-Set-1!');
    const r = await login('user@clinic-synthetic.org', PW);
    expect(r.status).toBe(401);
    expect(sessionsInserted).toBe(0);
  });

  it('issues no session if the password changed after verification', async () => {
    changeHashBeforeSession = await hashPassword('Changed-Meanwhile-9!');
    const r = await login('user@clinic-synthetic.org', PW);
    expect(r.status).toBe(401);
    expect(sessionsInserted).toBe(0);
  });

  it('refuses login for a malformed stored hash', async () => {
    storedHash = 'not-a-hash';
    expect((await login('user@clinic-synthetic.org', PW)).status).toBe(401);
    expect(sessionsInserted).toBe(0);
  });

  it('throttles repeated failures for an account (429) and still rejects', async () => {
    for (let i = 0; i < 5; i++) expect((await login('user@clinic-synthetic.org', 'Wrong-Pass-42!!')).status).toBe(401);
    const blocked = await login('user@clinic-synthetic.org', PW); // even the right password is refused while throttled
    expect(blocked.status).toBe(429);
    expect(sessionsInserted).toBe(0);
  });

  it('a successful login clears the failure counter', async () => {
    for (let i = 0; i < 4; i++) await login('user@clinic-synthetic.org', 'Wrong-Pass-42!!');
    expect((await login('user@clinic-synthetic.org', PW)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login('user@clinic-synthetic.org', 'Wrong-Pass-42!!')).status).toBe(401);
  });
});
