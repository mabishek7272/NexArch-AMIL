import * as crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  AuthConfigError,
  KNOWN_INSECURE_SECRETS,
  getApiJwtSecret,
  getDashboardJwtSecret,
  validateJwtSecret,
} from './jwt-secrets';

/** Synthetic, per-run test secret. Never a real credential. */
const good = () => crypto.randomBytes(32).toString('hex');

describe('validateJwtSecret', () => {
  it.each([undefined, '', '   ', '\n\t'])('rejects missing/blank value %j', (v) => {
    expect(() => validateJwtSecret('X_SECRET', v)).toThrow(AuthConfigError);
  });

  it.each([...KNOWN_INSECURE_SECRETS])('rejects previously shipped default %s', (v) => {
    expect(() => validateJwtSecret('X_SECRET', v)).toThrow(AuthConfigError);
  });

  it.each([
    'please-change-me-0123456789abcdef0123456789',
    'CHANGEME_0123456789abcdef0123456789abcdef',
    'your-secret-here-0123456789abcdef0123456789',
    'placeholder-0123456789abcdef0123456789abcdef',
    'secret',
  ])('rejects placeholder %s', (v) => {
    expect(() => validateJwtSecret('X_SECRET', v)).toThrow(AuthConfigError);
  });

  it('rejects a value shorter than 32 characters', () => {
    expect(() => validateJwtSecret('X_SECRET', 'a1b2c3d4e5f6')).toThrow(/too short/);
  });

  it('accepts and trims a strong random value', () => {
    const s = good();
    expect(validateJwtSecret('X_SECRET', `  ${s}  `)).toBe(s);
  });

  it('names the variable but never echoes the value in errors', () => {
    const bad = 'change-me-in-production';
    try {
      validateJwtSecret('ANUCLAW_JWT_SECRET', bad);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain('ANUCLAW_JWT_SECRET');
      expect((e as Error).message).not.toContain(bad);
    }
  });
});

describe('getDashboardJwtSecret', () => {
  it('uses DASHBOARD_JWT_SECRET when set', () => {
    const s = good();
    expect(getDashboardJwtSecret({ DASHBOARD_JWT_SECRET: s, ANUCLAW_JWT_SECRET: good() })).toBe(s);
  });

  it('uses ANUCLAW_JWT_SECRET when DASHBOARD_JWT_SECRET is unset or blank', () => {
    const s = good();
    expect(getDashboardJwtSecret({ ANUCLAW_JWT_SECRET: s })).toBe(s);
    expect(getDashboardJwtSecret({ DASHBOARD_JWT_SECRET: '  ', ANUCLAW_JWT_SECRET: s })).toBe(s);
  });

  it('fails when neither is set', () => {
    expect(() => getDashboardJwtSecret({})).toThrow(AuthConfigError);
  });

  it('fails (does not fall through) when DASHBOARD_JWT_SECRET is set but unsafe', () => {
    expect(() =>
      getDashboardJwtSecret({ DASHBOARD_JWT_SECRET: 'dashboard-secret-change-me', ANUCLAW_JWT_SECRET: good() }),
    ).toThrow(AuthConfigError);
  });
});

describe('getApiJwtSecret', () => {
  it('fails when missing or unsafe', () => {
    expect(() => getApiJwtSecret({})).toThrow(AuthConfigError);
    expect(() => getApiJwtSecret({ ANUCLAW_JWT_SECRET: 'change-me-in-production' })).toThrow(AuthConfigError);
  });

  it('does not use DASHBOARD_JWT_SECRET', () => {
    expect(() => getApiJwtSecret({ DASHBOARD_JWT_SECRET: good() })).toThrow(AuthConfigError);
  });

  it('returns a valid configured secret', () => {
    const s = good();
    expect(getApiJwtSecret({ ANUCLAW_JWT_SECRET: s })).toBe(s);
  });
});
