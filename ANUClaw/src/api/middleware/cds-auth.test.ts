import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import type { Request, Response } from 'express';
import {
  cdsHooksAuth,
  smartScopeAuth,
  cdsHooksAuthHardened,
  smartScopeAuthHardened,
  cdsAuthConfigFromEnv,
  resolveCdsAuth,
  isDemoModeEnabled,
  isCdsEnabled,
  CdsAuthConfigError,
} from './cds-auth';
import { CdsAuthConfig, TokenClaims } from '../../cds';

/** Minimal fake req/res to drive middleware without an HTTP server. */
function fakeReq(authorization?: string): Request {
  return { header: (n: string) => (n.toLowerCase() === 'authorization' ? authorization : undefined) } as unknown as Request;
}
function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

function run(mw: ReturnType<typeof cdsHooksAuth>, req: Request) {
  const res = fakeRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  return { res, nexted };
}

const baseConfig = (over: Partial<CdsAuthConfig> = {}): CdsAuthConfig => ({
  enabled: true,
  requiredScopes: ['user/Patient.read'],
  signOffScopes: ['user/MedicationRequest.write'],
  verify: (token: string): TokenClaims => {
    if (token === 'bad') throw new Error('boom');
    return JSON.parse(token) as TokenClaims; // tests pass JSON claims as the "token"
  },
  ...over,
});

describe('cdsHooksAuth middleware', () => {
  // Previously this passed the request through. Fail closed: 503, never next().
  it('denies with 503 (never next) when auth is disabled', () => {
    const { res, nexted } = run(cdsHooksAuth(baseConfig({ enabled: false })), fakeReq());
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(503);
  });

  it('denies with 503 when enabled but no verification key exists, without leaking config', () => {
    const { res, nexted } = run(
      cdsHooksAuth(baseConfig({ verify: undefined })),
      fakeReq('Bearer ' + JSON.stringify({ sub: 'ehr' })),
    );
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/CDS_JWT|CDS_JWKS|PUBLIC_KEY|SECRET|JWKS|verification key/);
  });

  it('401s an invalid token', () => {
    const { res, nexted } = run(cdsHooksAuth(baseConfig()), fakeReq('Bearer bad'));
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('401s a non-Bearer authorization header', () => {
    const { res, nexted } = run(cdsHooksAuth(baseConfig()), fakeReq('Basic abc'));
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('401s a missing token', () => {
    const { res, nexted } = run(cdsHooksAuth(baseConfig()), fakeReq());
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('allows a valid token', () => {
    const { res, nexted } = run(
      cdsHooksAuth(baseConfig()),
      fakeReq('Bearer ' + JSON.stringify({ sub: 'ehr', iss: 'https://ehr.example' })),
    );
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(200);
  });
});

describe('smartScopeAuth middleware', () => {
  it('403s when the required scope is missing', () => {
    const { res, nexted } = run(
      smartScopeAuth(baseConfig(), ['user/MedicationRequest.write']),
      fakeReq('Bearer ' + JSON.stringify({ scope: 'user/Patient.read' })),
    );
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('allows when the scope is granted (wildcard)', () => {
    const { res, nexted } = run(
      smartScopeAuth(baseConfig(), ['user/MedicationRequest.write']),
      fakeReq('Bearer ' + JSON.stringify({ scope: 'user/*.*' })),
    );
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(200);
  });
});

describe('cdsAuthConfigFromEnv', () => {
  it('disabled by default with no key', () => {
    expect(cdsAuthConfigFromEnv({}).enabled).toBe(false);
  });

  it('enabled once a key is configured', () => {
    const cfg = cdsAuthConfigFromEnv({ CDS_JWT_SECRET: 's' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.jwtSecret).toBe('s');
  });

  // Previously CDS_AUTH_ENABLED=false switched auth off. The parser no longer
  // honours it, and resolveCdsAuth() refuses it at startup (see below).
  it('CDS_AUTH_ENABLED=false no longer disables auth in the parsed config', () => {
    expect(cdsAuthConfigFromEnv({ CDS_JWT_SECRET: 's', CDS_AUTH_ENABLED: 'false' }).enabled).toBe(true);
  });

  it('parses issuers, audience, and scopes', () => {
    const cfg = cdsAuthConfigFromEnv({
      CDS_JWT_PUBLIC_KEY: 'KEY',
      CDS_TRUSTED_ISSUERS: 'https://a.example, https://b.example',
      CDS_AUDIENCE: 'https://cds.example',
      CDS_REQUIRED_SCOPES: 'user/Patient.read',
    });
    expect(cfg.trustedIssuers).toEqual(['https://a.example', 'https://b.example']);
    expect(cfg.audience).toBe('https://cds.example');
    expect(cfg.requiredScopes).toEqual(['user/Patient.read']);
  });
});

// ── Fail-closed hardened guards ──────────────────────────────────────────────

async function runAsync(mw: ReturnType<typeof cdsHooksAuthHardened>, req: Request) {
  const res = fakeRes();
  let nexted = false;
  await mw(req, res, () => { nexted = true; });
  return { res, nexted };
}

describe('hardened guards fail closed', () => {
  const noKey = (): CdsAuthConfig => ({ enabled: true, requiredScopes: ['user/Patient.read'], signOffScopes: [] });

  it.each([
    ['disabled', { ...noKey(), enabled: false }],
    ['enabled without any key', noKey()],
  ])('cdsHooksAuthHardened answers 503 when %s', async (_l, cfg) => {
    const { res, nexted } = await runAsync(cdsHooksAuthHardened(cfg), fakeReq('Bearer x'));
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(503);
  });

  it('smartScopeAuthHardened answers 503 when disabled', async () => {
    const { res, nexted } = await runAsync(
      smartScopeAuthHardened({ ...noKey(), enabled: false }, ['user/Patient.read']),
      fakeReq('Bearer x'),
    );
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(503);
  });
});

// ── Startup policy ───────────────────────────────────────────────────────────

const strongSecret = () => crypto.randomBytes(32).toString('hex'); // synthetic, per test
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

describe('isCdsEnabled', () => {
  it('defaults to mounted; only an explicit false disables', () => {
    expect(isCdsEnabled({})).toBe(true);
    expect(isCdsEnabled({ CDS_ENABLED: 'true' })).toBe(true);
    expect(isCdsEnabled({ CDS_ENABLED: 'false' })).toBe(false);
  });
});

describe('isDemoModeEnabled', () => {
  it('is off by default and when false', () => {
    expect(isDemoModeEnabled({})).toBe(false);
    expect(isDemoModeEnabled({ ANUCLAW_DEMO_MODE: 'false' })).toBe(false);
  });

  it.each([undefined, '', 'development', 'test'])('is allowed with NODE_ENV=%j', (nodeEnv) => {
    expect(isDemoModeEnabled({ ANUCLAW_DEMO_MODE: 'true', NODE_ENV: nodeEnv })).toBe(true);
  });

  it.each(['production', 'PRODUCTION', 'staging'])('is refused with NODE_ENV=%s', (nodeEnv) => {
    expect(() => isDemoModeEnabled({ ANUCLAW_DEMO_MODE: 'true', NODE_ENV: nodeEnv })).toThrow(CdsAuthConfigError);
  });

  it.each(['1', 'yes', 'on'])('rejects ambiguous value %s', (v) => {
    expect(() => isDemoModeEnabled({ ANUCLAW_DEMO_MODE: v })).toThrow(CdsAuthConfigError);
  });
});

describe('resolveCdsAuth', () => {
  it('fails when no CDS key or JWKS is configured', () => {
    expect(() => resolveCdsAuth({})).toThrow(CdsAuthConfigError);
    expect(() => resolveCdsAuth({})).toThrow(/JWKS|public key/);
  });

  it('runs assertClinicalAuthHardened: an HS256 secret is forbidden outside demo mode', () => {
    expect(() => resolveCdsAuth({ CDS_JWT_SECRET: strongSecret() })).toThrow(/HS256 shared secret is forbidden/);
  });

  it('runs assertClinicalAuthHardened: asymmetric-only cannot be switched off', () => {
    expect(() => resolveCdsAuth({ CDS_JWT_PUBLIC_KEY: PEM, CDS_REQUIRE_ASYMMETRIC: 'false' })).toThrow(/asymmetric/i);
  });

  it('refuses the old CDS_AUTH_ENABLED=false bypass', () => {
    expect(() => resolveCdsAuth({ CDS_JWT_PUBLIC_KEY: PEM, CDS_AUTH_ENABLED: 'false' })).toThrow(/cannot be disabled/);
  });

  const BIND = { CDS_AUDIENCE: 'https://cds.test.invalid', CDS_TRUSTED_ISSUERS: 'https://ehr.test.invalid' };

  it('requires audience and issuer binding in enforced mode', () => {
    expect(() => resolveCdsAuth({ CDS_JWT_PUBLIC_KEY: PEM, CDS_TRUSTED_ISSUERS: BIND.CDS_TRUSTED_ISSUERS })).toThrow(/CDS_AUDIENCE/);
    expect(() => resolveCdsAuth({ CDS_JWT_PUBLIC_KEY: PEM, CDS_AUDIENCE: BIND.CDS_AUDIENCE })).toThrow(/CDS_TRUSTED_ISSUERS/);
  });

  it('accepts a public key (enforced, asymmetric-only by default)', () => {
    const r = resolveCdsAuth({ CDS_JWT_PUBLIC_KEY: PEM, ...BIND });
    expect(r.mode).toBe('enforced');
    expect(r.config.enabled).toBe(true);
    expect(r.config.requireAsymmetric).toBe(true);
  });

  it('accepts a JWKS URI (enforced)', () => {
    expect(resolveCdsAuth({ CDS_JWKS_URI: 'https://issuer.test.invalid/jwks', ...BIND }).mode).toBe('enforced');
  });

  it('demo mode accepts a strong HS256 secret and keeps auth enabled', () => {
    const r = resolveCdsAuth({ ANUCLAW_DEMO_MODE: 'true', NODE_ENV: 'development', CDS_JWT_SECRET: strongSecret() });
    expect(r.mode).toBe('demo');
    expect(r.config.enabled).toBe(true);
    expect(r.config.requireAsymmetric).toBe(false);
  });

  it('demo mode still requires a key', () => {
    expect(() => resolveCdsAuth({ ANUCLAW_DEMO_MODE: 'true', NODE_ENV: 'development' })).toThrow(/still requires/);
  });

  it('demo mode rejects a weak or placeholder secret without echoing it', () => {
    const weak = 'change-me-cds-secret-0123456789abcdef';
    try {
      resolveCdsAuth({ ANUCLAW_DEMO_MODE: 'true', CDS_JWT_SECRET: weak });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CdsAuthConfigError);
      expect((e as Error).message).not.toContain(weak);
    }
    expect(() => resolveCdsAuth({ ANUCLAW_DEMO_MODE: 'true', CDS_JWT_SECRET: 'short' })).toThrow(CdsAuthConfigError);
  });

  it('demo mode is refused in production even with a valid key', () => {
    expect(() =>
      resolveCdsAuth({ ANUCLAW_DEMO_MODE: 'true', NODE_ENV: 'production', CDS_JWT_SECRET: strongSecret() }),
    ).toThrow(/refused/);
  });
});
