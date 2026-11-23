import * as crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocked tenant store — no real tenants or database.
vi.mock('../tenant-store', () => ({ getTenantById: vi.fn(), lookupTenantApiKey: vi.fn(), isTenantKeyActive: vi.fn() }));

import { getTenantById, lookupTenantApiKey, isTenantKeyActive } from '../tenant-store';
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
  vi.mocked(lookupTenantApiKey).mockReset().mockResolvedValue({ status: 'unknown' });
  vi.mocked(isTenantKeyActive).mockReset().mockResolvedValue(true);
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
    vi.mocked(lookupTenantApiKey).mockResolvedValue({ status: 'ok', tenant: TENANT, keyId: 'key-1', scopes: ['*'] });
    const { req, next } = await call({ 'x-api-key': 'synthetic-test-key' });
    expect(next).toHaveBeenCalledOnce();
    expect(req.tenant).toBe(TENANT);
    expect(req.apiKeyId).toBe('key-1');
    expect(req.apiKeyScopes).toEqual(['*']);
  });

  it.each([
    ['revoked', 'key_revoked'],
    ['expired', 'key_expired'],
  ] as const)('answers precisely for a %s key', async (status, code) => {
    vi.mocked(lookupTenantApiKey).mockResolvedValue({ status });
    const { res, next } = await call({ 'x-api-key': 'synthetic-test-key' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code }));
  });

  it('gives an unknown key the generic answer (no hint about whether the key ever existed)', async () => {
    const { res, next } = await call({ 'x-api-key': 'synthetic-test-key' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'unauthorized' }));
  });

  it('rejects a valid key whose tenant is suspended', async () => {
    vi.mocked(lookupTenantApiKey).mockResolvedValue({ status: 'ok', tenant: { ...TENANT, status: 'suspended' }, keyId: 'key-1', scopes: ['*'] });
    const { res, next } = await call({ 'x-api-key': 'synthetic-test-key' });
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'tenant_suspended' }));
  });
});

describe('requireAuth (tokens bound to the key that minted them)', () => {
  it('accepts a key-bound token while its key is active and exposes the key id', async () => {
    const { req, next } = await call(bearer(signToken(TENANT.tenant_id, 'key-1')));
    expect(next).toHaveBeenCalledOnce();
    expect(isTenantKeyActive).toHaveBeenCalledWith(TENANT.tenant_id, 'key-1');
    expect(req.apiKeyId).toBe('key-1');
  });

  it('rejects a key-bound token as soon as its key is revoked or expired', async () => {
    vi.mocked(isTenantKeyActive).mockResolvedValue(false);
    const { res, next } = await call(bearer(signToken(TENANT.tenant_id, 'key-1')));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'key_revoked' }));
  });

  it('still accepts a token with no key claim (issued before keys were tracked) without asking about a key', async () => {
    const { next } = await call(bearer(signToken(TENANT.tenant_id)));
    expect(next).toHaveBeenCalledOnce();
    expect(isTenantKeyActive).not.toHaveBeenCalled();
  });

  it('signToken embeds the key id only when one is given', () => {
    expect((jwt.verify(signToken(TENANT.tenant_id, 'key-9'), secret) as any).key).toBe('key-9');
    expect((jwt.verify(signToken(TENANT.tenant_id), secret) as any).key).toBeUndefined();
  });
});
