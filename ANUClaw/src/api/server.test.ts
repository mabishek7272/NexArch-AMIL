/**
 * Startup-boundary tests for the API: builds the REAL app via createApiApp()
 * and exercises it over loopback HTTP. Database and logger are mocked — no
 * Postgres, no real tenants, no external calls.
 */
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../db/connection', () => ({
  getDb: () => ({ query: async () => ({ rows: [] }) }),
  ensureDbReady: async () => {},
}));
vi.mock('../db', () => ({
  db: { query: vi.fn(async () => []), queryOne: vi.fn(async () => undefined) },
  getDb: () => ({ query: async () => ({ rows: [] }) }),
  ensureDbReady: async () => {},
}));
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createApiApp } from './server';
import { CdsAuthConfigError } from './middleware/cds-auth';

// Synthetic per-run credentials. Nothing here is a real key or secret.
const savedApiSecret = process.env.ANUCLAW_JWT_SECRET;
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const AUD = 'https://cds.test.invalid';
const ISS = 'https://ehr.test.invalid';
const ENFORCED = { CDS_JWT_PUBLIC_KEY: PEM, CDS_AUDIENCE: AUD, CDS_TRUSTED_ISSUERS: ISS };

const rsToken = (scope: string, over: Record<string, unknown> = {}) =>
  jwt.sign({ sub: 'clinician-synthetic', aud: AUD, iss: ISS, scope, ...over }, privateKey, {
    algorithm: 'RS256',
    ...('exp' in over ? {} : { expiresIn: '5m' }),
  });

beforeAll(() => {
  process.env.ANUCLAW_JWT_SECRET = crypto.randomBytes(32).toString('hex');
});
afterAll(() => {
  if (savedApiSecret === undefined) delete process.env.ANUCLAW_JWT_SECRET;
  else process.env.ANUCLAW_JWT_SECRET = savedApiSecret;
});

let server: Server | undefined;
async function serve(env: NodeJS.ProcessEnv) {
  const built = createApiApp(env);
  server = await new Promise<Server>((resolve) => {
    const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, token?: string) =>
    fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { ...built, get };
}
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

describe('API startup refuses insecure CDS clinical auth', () => {
  it('fails when CDS is enabled with no key or JWKS', () => {
    expect(() => createApiApp({})).toThrow(CdsAuthConfigError);
  });

  it('exercises assertClinicalAuthHardened (HS256 secret forbidden)', () => {
    expect(() => createApiApp({ CDS_JWT_SECRET: crypto.randomBytes(32).toString('hex') })).toThrow(
      /HS256 shared secret is forbidden/,
    );
  });

  it('exercises assertClinicalAuthHardened (asymmetric cannot be disabled)', () => {
    expect(() => createApiApp({ ...ENFORCED, CDS_REQUIRE_ASYMMETRIC: 'false' })).toThrow(/asymmetric/i);
  });

  it('refuses the removed CDS_AUTH_ENABLED=false bypass', () => {
    expect(() => createApiApp({ ...ENFORCED, CDS_AUTH_ENABLED: 'false' })).toThrow(/cannot be disabled/);
  });

  it('refuses demo mode in production', () => {
    expect(() =>
      createApiApp({ ANUCLAW_DEMO_MODE: 'true', NODE_ENV: 'production', PG_PASSWORD: crypto.randomBytes(16).toString('hex'), CDS_JWT_SECRET: crypto.randomBytes(32).toString('hex') }),
    ).toThrow(/refused/);
  });

  it('refuses to start in production with the default database password or with CORS *', () => {
    const strong = crypto.randomBytes(16).toString('hex');
    expect(() => createApiApp({ NODE_ENV: 'production', CDS_ENABLED: 'false' })).toThrow(/default\/weak database password/);
    expect(() => createApiApp({ NODE_ENV: 'production', CDS_ENABLED: 'false', PG_PASSWORD: strong, CORS_ORIGINS: '*' })).toThrow(/not allowed in production/);
  });
});

describe('enforced CDS auth on the running app', () => {
  it('mounts CDS, keeps discovery public, and rejects absent/invalid/malformed credentials', async () => {
    const api = await serve(ENFORCED);
    expect(api.cds?.mode).toBe('enforced');
    expect(api.bindHost).toBeUndefined();

    expect((await api.get('/health')).status).toBe(200);
    expect((await api.get('/cds-services')).status).toBe(200);

    expect((await api.get('/cds/review/audit/verify')).status).toBe(401); // absent
    expect((await api.get('/cds/review/audit/verify', 'not.a.jwt')).status).toBe(401); // malformed
    const hs = jwt.sign({ sub: 'x', aud: AUD, iss: ISS, scope: 'user/Patient.read' }, 'any-hs256-secret');
    expect((await api.get('/cds/review/audit/verify', hs)).status).toBe(401); // wrong algorithm
    expect((await api.get('/cds/review/audit/verify', rsToken('user/Patient.read', { aud: 'https://other.invalid' }))).status).toBe(401);
    expect((await api.get('/cds/review/audit/verify', rsToken('user/Patient.read', { exp: Math.floor(Date.now() / 1000) - 60 }))).status).toBe(401);
  });

  it('rejects a token from an untrusted issuer and refuses to start without binding', async () => {
    expect(() => createApiApp({ CDS_JWT_PUBLIC_KEY: PEM })).toThrow(/CDS_AUDIENCE/);
    const api = await serve(ENFORCED);
    expect((await api.get('/cds/review/audit/verify', rsToken('user/Patient.read', { iss: 'https://evil.invalid' }))).status).toBe(401);
  });

  it('403s a valid token without the required scope', async () => {
    const api = await serve(ENFORCED);
    expect((await api.get('/cds/review/audit/verify', rsToken('user/Observation.read'))).status).toBe(403);
  });

  it('accepts a valid RS256 token with the required scope', async () => {
    const api = await serve(ENFORCED);
    const r = await api.get('/cds/review/audit/verify', rsToken('user/Patient.read'));
    expect(r.status).toBe(200);
  });
});

describe('CDS intentionally disabled', () => {
  it('starts without CDS config and keeps non-clinical routes usable', async () => {
    const api = await serve({ CDS_ENABLED: 'false' });
    expect(api.cds).toBeNull();
    expect((await api.get('/health')).status).toBe(200);
    expect((await api.get('/api/v1')).status).toBe(200);
    expect((await api.get('/cds-services')).status).toBe(404);
    expect((await api.get('/cds/review/audit/verify')).status).toBe(404);
  });
});

describe('explicit local demo mode', () => {
  it('stays authenticated, accepts the HS256 dev secret, and binds to loopback', async () => {
    const secret = crypto.randomBytes(32).toString('hex');
    const api = await serve({ ANUCLAW_DEMO_MODE: 'true', NODE_ENV: 'development', CDS_JWT_SECRET: secret });
    expect(api.cds?.mode).toBe('demo');
    expect(api.bindHost).toBe('127.0.0.1');

    expect((await api.get('/cds/review/audit/verify')).status).toBe(401);
    const wrong = jwt.sign({ sub: 'x', scope: 'user/Patient.read' }, crypto.randomBytes(32).toString('hex'));
    expect((await api.get('/cds/review/audit/verify', wrong)).status).toBe(401);
    const ok = jwt.sign({ sub: 'dev', scope: 'user/Patient.read' }, secret, { expiresIn: '5m' });
    expect((await api.get('/cds/review/audit/verify', ok)).status).toBe(200);
  });
});
