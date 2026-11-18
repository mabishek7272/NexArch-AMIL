import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocked query layer — no real database or accounts are touched.
vi.mock('../../db', () => ({ db: { query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn() } }));

import { db } from '../../db';
import { AuthConfigError } from '../../security/jwt-secrets';
import { assertDashboardAuthConfigured, issueTokens, requireDashAuth } from './auth';
import usersRouter from './routes/users';

const query = vi.mocked(db.query);
const queryOne = vi.mocked(db.queryOne);
const transaction = vi.mocked(db.transaction);

/** Statements run inside db.transaction (fake tx with the same session row). */
let txStatements: Array<{ sql: string; params: unknown[] }> = [];

const USER = { id: 'user-1', email: 'synthetic@test.invalid', name: 'Synthetic', role: 'viewer', scope_json: '{}' };

type SessionRow = { user_id: string; expires_at: number; revoked: number } | undefined;
let sessionRow: SessionRow;
let secret: string;
const savedEnv = { d: process.env.DASHBOARD_JWT_SECRET, a: process.env.ANUCLAW_JWT_SECRET };

function restoreEnv(key: 'DASHBOARD_JWT_SECRET' | 'ANUCLAW_JWT_SECRET', v: string | undefined) {
  if (v === undefined) delete process.env[key];
  else process.env[key] = v;
}

function sign(payload: object, key = secret, opts: jwt.SignOptions = { expiresIn: 900 }) {
  return jwt.sign(payload, key, opts);
}

function activeSession(overrides: Partial<NonNullable<SessionRow>> = {}): SessionRow {
  return { user_id: USER.id, expires_at: Date.now() + 60_000, revoked: 0, ...overrides };
}

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json = vi.fn((b: unknown) => { res.body = b; return res; });
  return res;
}

async function callAuth(token: string | undefined) {
  const req: any = { cookies: token ? { dash_token: token } : {}, headers: {} };
  const res = fakeRes();
  const next = vi.fn();
  await requireDashAuth(req, res, next);
  return { req, res, next };
}

beforeEach(() => {
  // Synthetic, per-test secret injected via test setup only.
  secret = crypto.randomBytes(32).toString('hex');
  process.env.DASHBOARD_JWT_SECRET = secret;
  delete process.env.ANUCLAW_JWT_SECRET;
  sessionRow = activeSession();
  query.mockReset().mockResolvedValue([]);
  queryOne.mockReset().mockImplementation(async (sql: string) => {
    if (/FROM\s+dash_sessions/i.test(sql)) return sessionRow;
    if (/FROM\s+dash_users/i.test(sql)) return USER;
    return undefined;
  });
  txStatements = [];
  transaction.mockReset().mockImplementation(async (fn: any) =>
    fn({
      query: async (sql: string, params: unknown[] = []) => {
        txStatements.push({ sql, params });
        if (/FROM dash_users WHERE id = \$1 FOR SHARE/.test(sql)) return { rows: [{ password_hash: 'h' }], rowCount: 1 };
        if (/UPDATE dash_sessions SET revoked = 1/.test(sql)) {
          const active = sessionRow && !sessionRow.revoked && sessionRow.user_id === params[1] && sessionRow.expires_at > Date.now();
          if (active) sessionRow = { ...sessionRow!, revoked: 1 };
          return { rows: [], rowCount: active ? 1 : 0 };
        }
        return { rows: [], rowCount: 1 };
      },
    }),
  );
});

afterEach(() => {
  restoreEnv('DASHBOARD_JWT_SECRET', savedEnv.d);
  restoreEnv('ANUCLAW_JWT_SECRET', savedEnv.a);
});

describe('dashboard secret configuration', () => {
  it('startup assertion fails when the secret is missing or blank', () => {
    delete process.env.DASHBOARD_JWT_SECRET;
    expect(() => assertDashboardAuthConfigured()).toThrow(AuthConfigError);
    process.env.DASHBOARD_JWT_SECRET = '   ';
    expect(() => assertDashboardAuthConfigured()).toThrow(AuthConfigError);
  });

  it('startup assertion fails for the previous fallback value', () => {
    process.env.DASHBOARD_JWT_SECRET = 'dashboard-secret-change-me';
    expect(() => assertDashboardAuthConfigured()).toThrow(AuthConfigError);
  });

  it('issueTokens signs verifiable tokens with the configured secret and records a session', async () => {
    const { accessToken, refreshToken } = await issueTokens(USER.id);
    const a = jwt.verify(accessToken, secret) as any;
    const r = jwt.verify(refreshToken, secret) as any;
    expect(a).toMatchObject({ sub: USER.id, type: 'access' });
    expect(r).toMatchObject({ sub: USER.id, type: 'refresh', jti: a.jti });
    const insert = txStatements.find((t) => /INSERT INTO dash_sessions/.test(t.sql));
    expect(insert?.params).toEqual(expect.arrayContaining([a.jti, USER.id]));
    expect(txStatements[0].sql).toMatch(/FOR SHARE/); // user row locked before the insert
  });

  it('issueTokens refuses to sign without a configured secret and writes no session', async () => {
    delete process.env.DASHBOARD_JWT_SECRET;
    await expect(issueTokens(USER.id)).rejects.toBeInstanceOf(AuthConfigError);
    expect(query).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('requireDashAuth', () => {
  const access = () => sign({ sub: USER.id, jti: 'jti-1', type: 'access' });

  it('accepts a valid token with an active session', async () => {
    const { req, res, next } = await callAuth(access());
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.user).toEqual(USER);
  });

  it('rejects when no session row exists', async () => {
    sessionRow = undefined;
    const { res, next } = await callAuth(access());
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a revoked session', async () => {
    sessionRow = activeSession({ revoked: 1 });
    const { res, next } = await callAuth(access());
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired session row', async () => {
    sessionRow = activeSession({ expires_at: Date.now() - 1 });
    const { res, next } = await callAuth(access());
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("rejects a session row that belongs to a different user", async () => {
    sessionRow = activeSession({ user_id: 'someone-else' });
    const { res, next } = await callAuth(access());
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ['malformed', 'not-a-jwt'],
    ['expired', 'EXPIRED'],
    ['refresh used as access', 'REFRESH'],
    ['unsigned alg=none', 'NONE'],
  ])('rejects a %s token', async (_label, kind) => {
    let token = kind;
    if (kind === 'EXPIRED') token = sign({ sub: USER.id, jti: 'jti-1', type: 'access' }, secret, { expiresIn: -10 });
    if (kind === 'REFRESH') token = sign({ sub: USER.id, jti: 'jti-1', type: 'refresh' });
    if (kind === 'NONE') token = jwt.sign({ sub: USER.id, jti: 'jti-1', type: 'access' }, '', { algorithm: 'none' } as any);
    const { res, next } = await callAuth(token);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('never accepts a token signed with the previous fallback secret', async () => {
    const forged = sign({ sub: USER.id, jti: 'jti-1', type: 'access' }, 'dashboard-secret-change-me');
    const { res, next } = await callAuth(forged);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('fails closed (503) when the secret is missing, even for a fallback-signed token', async () => {
    delete process.env.DASHBOARD_JWT_SECRET;
    const forged = sign({ sub: USER.id, jti: 'jti-1', type: 'access' }, 'dashboard-secret-change-me');
    const { res, next } = await callAuth(forged);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  it('fails closed (503) when the secret is configured as the old fallback value', async () => {
    process.env.DASHBOARD_JWT_SECRET = 'dashboard-secret-change-me';
    const forged = sign({ sub: USER.id, jti: 'jti-1', type: 'access' }, 'dashboard-secret-change-me');
    const { res, next } = await callAuth(forged);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });
});

describe('POST /refresh', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/auth', usersRouter);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const refresh = (token: string) =>
    fetch(`${base}/auth/refresh`, { method: 'POST', headers: { cookie: `dash_refresh=${token}` } });
  const refreshToken = () => sign({ sub: USER.id, jti: 'jti-r', type: 'refresh' }, secret, { expiresIn: 3600 });

  it('rotates: issues a new access+refresh pair and revokes the old session', async () => {
    const r = await refresh(refreshToken());
    expect(r.status).toBe(200);
    const cookies = r.headers.get('set-cookie') ?? '';
    expect(cookies).toMatch(/dash_token=/);
    expect(cookies).toMatch(/dash_refresh=/);
    expect(sessionRow?.revoked).toBe(1);
  });

  it('a rotated (already used) refresh token cannot be reused', async () => {
    const t = refreshToken();
    expect((await refresh(t)).status).toBe(200);
    expect((await refresh(t)).status).toBe(401);
  });

  it('rejects when the session row is missing', async () => {
    sessionRow = undefined;
    const r = await refresh(refreshToken());
    expect(r.status).toBe(401);
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a revoked session', async () => {
    sessionRow = activeSession({ revoked: 1 });
    const r = await refresh(refreshToken());
    expect(r.status).toBe(401);
  });

  it('rejects an access token presented as a refresh token', async () => {
    const r = await refresh(sign({ sub: USER.id, jti: 'jti-r', type: 'access' }));
    expect(r.status).toBe(401);
  });

  it('rejects a refresh token signed with the previous fallback secret', async () => {
    const r = await refresh(sign({ sub: USER.id, jti: 'jti-r', type: 'refresh' }, 'dashboard-secret-change-me'));
    expect(r.status).toBe(401);
  });

  it('fails closed (503) when the secret is missing', async () => {
    delete process.env.DASHBOARD_JWT_SECRET;
    const r = await refresh(sign({ sub: USER.id, jti: 'jti-r', type: 'refresh' }, 'dashboard-secret-change-me'));
    expect(r.status).toBe(503);
  });
});
