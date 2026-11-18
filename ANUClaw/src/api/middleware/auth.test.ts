import * as crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocked tenant store — no real tenants or database.
vi.mock('../tenant-store', () => ({ getTenantById: vi.fn(), getTenantByApiKey: vi.fn() }));

import { getTenantById, getTenantByApiKey } from '../tenant-store';
import { AuthConfigError } from '../../security/jwt-secrets';
import { assertApiAuthConfigured, requireAuth, signToken } from './auth';

const TENANT = { tenant_id: 'tenant-synthetic', status: 'active' } as any;
let secret: string;
const saved = process.env.ANUCLAW_JWT_SECRET;

function fakeRes() {
  const res: any = { statusCode: 200 };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json = vi.fn(() => res);
  return res;
}

async function call(headers: Record<string, string>) {
  const req: any = { headers };
  const res = fakeRes();
  const next = vi.fn();
  await requireAuth(req, res, next);
  return { req, res, next };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(() => {
  secret = crypto.randomBytes(32).toString('hex'); // synthetic, per-test
  process.env.ANUCLAW_JWT_SECRET = secret;
  vi.mocked(getTenantById).mockReset().mockImplementation(async (id: string) => (id === TENANT.tenant_id ? TENANT : undefined));
  vi.mocked(getTenantByApiKey).mockReset().mockResolvedValue(undefined as any);
});

afterEach(() => {
  if (saved === undefined) delete process.env.ANUCLAW_JWT_SECRET;
  else process.env.ANUCLAW_JWT_SECRET = saved;
});

describe('API secret configuration', () => {
  it.each([
    ['missing', undefined],
    ['blank', '  '],
    ['previous fallback', 'change-me-in-production'],
    ['.env.example placeholder', 'change-me-to-a-long-random-secret'],
    ['too short', 'abc123'],
  ])('startup assertion and signing fail when the secret is %s', (_l, v) => {
    if (v === undefined) delete process.env.ANUCLAW_JWT_SECRET;
    else process.env.ANUCLAW_JWT_SECRET = v;
    expect(() => assertApiAuthConfigured()).toThrow(AuthConfigError);
    expect(() => signToken(TENANT.tenant_id)).toThrow(AuthConfigError);
  });

  it('signToken produces a token verifiable with the configured secret', () => {
    const payload = jwt.verify(signToken(TENANT.tenant_id), secret) as any;
    expect(payload.sub).toBe(TENANT.tenant_id);
  });
});

describe('requireAuth (Bearer)', () => {
  it('accepts a valid token signed with the configured secret', async () => {
    const { req, res, next } = await call(bearer(signToken(TENANT.tenant_id)));
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.tenant).toBe(TENANT);
  });

  it('never accepts a token signed with the previous fallback secret', async () => {
    const forged = jwt.sign({ sub: TENANT.tenant_id }, 'change-me-in-production', { expiresIn: '1h' });
    const { res, next } = await call(bearer(forged));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('fails closed (503) when the secret is missing, even for a fallback-signed token', async () => {
    delete process.env.ANUCLAW_JWT_SECRET;
    const forged = jwt.sign({ sub: TENANT.tenant_id }, 'change-me-in-production', { expiresIn: '1h' });
    const { res, next } = await call(bearer(forged));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  it('fails closed (503) when the secret is configured as the old fallback value', async () => {
    process.env.ANUCLAW_JWT_SECRET = 'change-me-in-production';
    const forged = jwt.sign({ sub: TENANT.tenant_id }, 'change-me-in-production', { expiresIn: '1h' });
    const { res, next } = await call(bearer(forged));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  it.each([
    ['malformed', () => 'not-a-jwt'],
    ['expired', () => jwt.sign({ sub: TENANT.tenant_id }, secret, { expiresIn: -10 })],
    ['missing sub', () => jwt.sign({ foo: 'bar' }, secret, { expiresIn: '1h' })],
    ['alg=none', () => jwt.sign({ sub: TENANT.tenant_id }, '', { algorithm: 'none' } as any)],
  ])('rejects a %s token', async (_l, make) => {
    const { res, next } = await call(bearer(make()));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a valid token for an unknown or suspended tenant', async () => {
    vi.mocked(getTenantById).mockResolvedValue({ ...TENANT, status: 'suspended' });
    const { res, next } = await call(bearer(signToken(TENANT.tenant_id)));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe('requireAuth (API key path unchanged)', () => {
  it('rejects requests with no credentials', async () => {
    const { res, next } = await call({});
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('still authenticates a valid API key without using the JWT secret', async () => {
    delete process.env.ANUCLAW_JWT_SECRET;
    vi.mocked(getTenantByApiKey).mockResolvedValue(TENANT);
    const { req, next } = await call({ 'x-api-key': 'synthetic-test-key' });
    expect(next).toHaveBeenCalledOnce();
    expect(req.tenant).toBe(TENANT);
  });
});
