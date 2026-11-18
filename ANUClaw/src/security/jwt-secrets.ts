/**
 * JWT signing-secret resolution — fail closed (Phase 1 repair F02, plan.md §14;
 * docs/SCAN-2026-11-17.md finding 3).
 *
 * There is NO default or fallback secret. A missing, blank, short, placeholder,
 * or previously-shipped default value throws `AuthConfigError`. Secrets are read
 * at call time so the process environment (dotenv or test setup) is honoured.
 *
 * Error messages name the environment variable only — never the value.
 */

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

export const MIN_JWT_SECRET_LENGTH = 32;

/** Values that shipped as defaults or examples in this codebase. Never accept. */
export const KNOWN_INSECURE_SECRETS: ReadonlySet<string> = new Set([
  'dashboard-secret-change-me',
  'change-me-in-production',
  'change-me-dashboard-secret',
  'change-me-to-a-long-random-secret',
  'audit-hmac-secret',
]);

const PLACEHOLDER_PATTERN = /change[-_ ]?me|replace[-_ ]?me|your[-_ ]?secret|placeholder|example|^(secret|password|test|dev|default)$/i;

/** Validate a configured secret. Returns the trimmed value or throws. */
export function validateJwtSecret(name: string, value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    throw new AuthConfigError(`${name} is not set. Configure a random secret of at least ${MIN_JWT_SECRET_LENGTH} characters.`);
  }
  if (KNOWN_INSECURE_SECRETS.has(trimmed) || PLACEHOLDER_PATTERN.test(trimmed)) {
    throw new AuthConfigError(`${name} is a known default or placeholder value. Configure a random secret.`);
  }
  if (trimmed.length < MIN_JWT_SECRET_LENGTH) {
    throw new AuthConfigError(`${name} is too short. Use at least ${MIN_JWT_SECRET_LENGTH} characters.`);
  }
  return trimmed;
}

/**
 * Dashboard session secret. Existing convention: `DASHBOARD_JWT_SECRET`, or
 * `ANUCLAW_JWT_SECRET` when the dashboard one is unset. If DASHBOARD_JWT_SECRET
 * is set but unsafe, fail — do not silently fall through to the other variable.
 */
export function getDashboardJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.DASHBOARD_JWT_SECRET ?? '').trim()) {
    return validateJwtSecret('DASHBOARD_JWT_SECRET', env.DASHBOARD_JWT_SECRET);
  }
  if ((env.ANUCLAW_JWT_SECRET ?? '').trim()) {
    return validateJwtSecret('ANUCLAW_JWT_SECRET (used because DASHBOARD_JWT_SECRET is unset)', env.ANUCLAW_JWT_SECRET);
  }
  throw new AuthConfigError(
    `DASHBOARD_JWT_SECRET is not set (and no ANUCLAW_JWT_SECRET). Configure a random secret of at least ${MIN_JWT_SECRET_LENGTH} characters.`,
  );
}

/** API tenant-token secret: `ANUCLAW_JWT_SECRET`. */
export function getApiJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  return validateJwtSecret('ANUCLAW_JWT_SECRET', env.ANUCLAW_JWT_SECRET);
}

/**
 * Audit-export HMAC key: `ANUCLAW_AUDIT_HMAC_SECRET`. Deliberately separate from
 * the JWT signing secrets (no key reuse) and with no fallback.
 */
export function getAuditHmacSecret(env: NodeJS.ProcessEnv = process.env): string {
  return validateJwtSecret('ANUCLAW_AUDIT_HMAC_SECRET', env.ANUCLAW_AUDIT_HMAC_SECRET);
}
