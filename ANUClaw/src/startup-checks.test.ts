import { describe, expect, it, vi } from 'vitest';
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { checkDatabaseCredentials, corsOriginOption, resolveCorsPolicy, StartupConfigError } from './startup-checks';

describe('database credentials', () => {
  it('default credentials on loopback outside production: allowed with a warning', () => {
    expect(checkDatabaseCredentials({}).warnings[0]).toMatch(/local development only/);
    expect(checkDatabaseCredentials({ PG_HOST: '127.0.0.1', PG_PASSWORD: 'postgres' }).warnings).toHaveLength(1);
  });
  it('a strong password produces no warning', () => { expect(checkDatabaseCredentials({ PG_PASSWORD: 'k9$Tq-long-random-value' }).warnings).toEqual([]); });
  it('production refuses default, unset and weak passwords', () => {
    for (const pw of [undefined, 'postgres', 'Password', 'changeme', '']) expect(() => checkDatabaseCredentials({ NODE_ENV: 'production', ...(pw === undefined ? {} : { PG_PASSWORD: pw }) })).toThrow(StartupConfigError);
    expect(() => checkDatabaseCredentials({ NODE_ENV: 'production', PG_USER: 'app', PG_PASSWORD: 'app' })).toThrow(/default\/weak/);   // password == user
  });
  it('a non-loopback database host refuses weak passwords in any environment', () => {
    expect(() => checkDatabaseCredentials({ PG_HOST: 'db.internal', PG_PASSWORD: 'postgres' })).toThrow(/non-loopback/);
    expect(() => checkDatabaseCredentials({ PG_HOST: 'db.internal', PG_PASSWORD: 'a-long-random-secret-1' })).not.toThrow();
  });
});

describe('CORS policy', () => {
  it('unset/blank → same-origin only (the safe default)', () => {
    for (const v of [undefined, '', '  ', ' , ']) expect(resolveCorsPolicy(v === undefined ? {} : { CORS_ORIGINS: v })).toEqual({ kind: 'same_origin' });
    expect(corsOriginOption({ kind: 'same_origin' })).toBe(false);
  });
  it('explicit origins are normalised and applied', () => {
    const p = resolveCorsPolicy({ CORS_ORIGINS: 'https://app.example.com, https://dash.example.com/' });
    expect(p).toEqual({ kind: 'list', origins: ['https://app.example.com', 'https://dash.example.com'] });
    expect(corsOriginOption(p)).toEqual(['https://app.example.com', 'https://dash.example.com']);
  });
  it("'*' works locally but is refused in production", () => {
    expect(corsOriginOption(resolveCorsPolicy({ CORS_ORIGINS: '*' }))).toBe('*');
    expect(() => resolveCorsPolicy({ CORS_ORIGINS: '*', NODE_ENV: 'production' })).toThrow(/not allowed in production/);
  });
  it.each(['app.example.com', 'https://app.example.com/path', 'ftp://x.example.com', 'https://a.example.com,*', 'javascript:alert(1)', 'https://user@example.com'])('malformed entry %j is refused, not ignored', (bad) => {
    expect(() => resolveCorsPolicy({ CORS_ORIGINS: bad })).toThrow(StartupConfigError);
  });
  it('plain-http non-loopback origins are refused in production', () => {
    expect(() => resolveCorsPolicy({ CORS_ORIGINS: 'http://app.example.com', NODE_ENV: 'production' })).toThrow(/Plain-http/);
    expect(resolveCorsPolicy({ CORS_ORIGINS: 'http://localhost:5173', NODE_ENV: 'production' })).toMatchObject({ kind: 'list' });
  });
});
