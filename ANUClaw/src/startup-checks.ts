/**
 * Startup configuration checks (fail closed where it matters).
 *
 *  - Database credentials: the built-in development defaults (postgres/postgres) are never accepted in production
 *    or for a non-loopback database host; outside production they are allowed for local work but warned about.
 *  - CORS: browsers are same-origin only unless CORS_ORIGINS lists explicit https/http origins. `*` is a local
 *    convenience and is refused in production. Malformed entries are refused (never silently ignored).
 */
import { logger } from './logger';

export class StartupConfigError extends Error { constructor(m: string) { super(m); this.name = 'StartupConfigError'; } }

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const WEAK = new Set(['', 'postgres', 'password', 'admin', 'root', 'changeme', 'anuclaw', 'secret', '123456', '12345678']);
const isProd = (env: NodeJS.ProcessEnv) => (env.NODE_ENV ?? '').toLowerCase() === 'production';

export function checkDatabaseCredentials(env: NodeJS.ProcessEnv = process.env): { warnings: string[] } {
  const host = (env.PG_HOST ?? 'localhost').trim().toLowerCase();
  const user = (env.PG_USER ?? 'postgres').trim();
  const pass = env.PG_PASSWORD ?? 'postgres';
  const defaultUser = user === 'postgres', weak = WEAK.has(pass.trim().toLowerCase()) || pass === user;
  const warnings: string[] = [];
  if (!weak) return { warnings };
  const remote = !LOOPBACK.has(host);
  if (isProd(env)) throw new StartupConfigError(`Refusing to start in production with a default/weak database password (PG_PASSWORD${env.PG_PASSWORD === undefined ? ' is unset' : ''}). Set a strong PG_PASSWORD.`);
  if (remote) throw new StartupConfigError(`Refusing a default/weak database password for the non-loopback database host '${host}'. Set a strong PG_PASSWORD.`);
  warnings.push(`Using a default/weak database password${defaultUser ? ' and the default "postgres" user' : ''} on loopback — acceptable for local development only.`);
  return { warnings };
}

export type CorsPolicy = { kind: 'same_origin' } | { kind: 'any' } | { kind: 'list'; origins: string[] };

export function resolveCorsPolicy(env: NodeJS.ProcessEnv = process.env): CorsPolicy {
  const raw = env.CORS_ORIGINS?.trim();
  if (!raw) return { kind: 'same_origin' };
  if (raw === '*') {
    if (isProd(env)) throw new StartupConfigError("CORS_ORIGINS='*' is not allowed in production; list the exact origins.");
    return { kind: 'any' };
  }
  const origins = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!origins.length) return { kind: 'same_origin' };
  for (const o of origins) {
    let u: URL;
    try { u = new URL(o); } catch { throw new StartupConfigError(`CORS_ORIGINS contains an invalid origin: ${JSON.stringify(o)}`); }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== o.replace(/\/$/, '') || o === '*') throw new StartupConfigError(`CORS_ORIGINS entries must be bare origins like https://app.example.com (got ${JSON.stringify(o)}).`);
    if (u.protocol === 'http:' && isProd(env) && !LOOPBACK.has(u.hostname)) throw new StartupConfigError(`Plain-http CORS origin ${o} is not allowed in production.`);
  }
  return { kind: 'list', origins: origins.map((o) => new URL(o).origin) };
}

/** `origin` option for the `cors` middleware. */
export function corsOriginOption(p: CorsPolicy): boolean | string | string[] {
  return p.kind === 'same_origin' ? false : p.kind === 'any' ? '*' : p.origins;
}

export function runStartupChecks(env: NodeJS.ProcessEnv = process.env): CorsPolicy {
  for (const w of checkDatabaseCredentials(env).warnings) logger.warn(w);
  const cors = resolveCorsPolicy(env);
  if (cors.kind === 'any') logger.warn("CORS_ORIGINS='*': any website may call this API from a browser. Local development only.");
  return cors;
}
