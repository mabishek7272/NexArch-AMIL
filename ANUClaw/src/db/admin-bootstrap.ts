/**
 * First-administrator bootstrap (Phase 1 repair; docs/SCAN-2026-11-17.md finding 3).
 *
 * There are NO default administrator accounts or passwords. A fresh database gets
 * an administrator only when BOTH are explicitly configured:
 *
 *   ANUCLAW_BOOTSTRAP_ADMIN_EMAIL
 *   ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD
 *
 * and only while `dash_users` is completely empty. Concurrency: callers MUST run
 * this inside a transaction; it takes a transaction-scoped advisory lock so
 * concurrent boots serialise (INSERT … WHERE NOT EXISTS alone does not
 * serialise under PostgreSQL MVCC — two transactions can both see an empty table).
 * Missing, blank, placeholder-like or weak values create nothing.
 * Log messages never contain the password, its hash, or the email value.
 */
import * as crypto from 'crypto';
import { hashPassword } from '../security/password';

/** Advisory lock key shared with the migration (src/db/connection.ts). */
export const SCHEMA_ADVISORY_LOCK_KEY = 7_428_301_001;

export interface QueryClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface BootstrapLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export type BootstrapOutcome =
  | 'created'
  | 'skipped_users_exist'
  | 'not_configured'
  | 'invalid_config';

export const MIN_BOOTSTRAP_PASSWORD_LENGTH = 12;

/** Emails that were seeded as defaults by earlier versions. Never bootstrap these. */
export const LEGACY_DEFAULT_ADMIN_EMAILS: readonly string[] = ['admin@amgi.io', 'admin@anuclaw.local'];

const PLACEHOLDER_PATTERN = /change[-_ ]?me|replace[-_ ]?me|your[-_ ]?(password|email)|placeholder|example|<.*>/i;
const PLACEHOLDER_EMAIL_DOMAINS = /@(example\.(com|org|net)|test|invalid|localhost)$/i;
const COMMON_WEAK = new Set([
  'password', 'password1', 'password123', 'admin', 'admin123', 'administrator', 'letmein',
  'welcome', 'qwerty', '123456', '12345678', '123456789', '1234567890', 'changeme', 'secret',
]);

export interface ValidationResult {
  ok: boolean;
  /** Safe, value-free reason for logs. */
  reason?: string;
}

export function validateBootstrapEmail(email: string): ValidationResult {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, reason: 'ANUCLAW_BOOTSTRAP_ADMIN_EMAIL is not a valid email address' };
  const lower = email.toLowerCase();
  if (LEGACY_DEFAULT_ADMIN_EMAILS.includes(lower)) {
    return { ok: false, reason: 'ANUCLAW_BOOTSTRAP_ADMIN_EMAIL is a former built-in default address; use your own address' };
  }
  if (PLACEHOLDER_PATTERN.test(email) || PLACEHOLDER_EMAIL_DOMAINS.test(email)) {
    return { ok: false, reason: 'ANUCLAW_BOOTSTRAP_ADMIN_EMAIL looks like a placeholder' };
  }
  return { ok: true };
}

export function validateBootstrapPassword(password: string, email: string): ValidationResult {
  if (password.length < MIN_BOOTSTRAP_PASSWORD_LENGTH) {
    return { ok: false, reason: `ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD is shorter than ${MIN_BOOTSTRAP_PASSWORD_LENGTH} characters` };
  }
  const lower = password.toLowerCase();
  if (COMMON_WEAK.has(lower) || PLACEHOLDER_PATTERN.test(password)) {
    return { ok: false, reason: 'ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD is a common or placeholder value' };
  }
  for (const weak of COMMON_WEAK) {
    if (weak.length >= 5 && lower.startsWith(weak) && /^[\d!@#$%^&*.]*$/.test(lower.slice(weak.length))) {
      return { ok: false, reason: 'ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD is a common password with a suffix' };
    }
  }
  const localPart = email.split('@')[0]?.toLowerCase() ?? '';
  if (localPart.length >= 4 && lower.includes(localPart)) {
    return { ok: false, reason: 'ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD must not contain the email name' };
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) {
    return { ok: false, reason: 'ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD needs at least 3 of: lowercase, uppercase, digit, symbol' };
  }
  if (new Set(password).size < 6) {
    return { ok: false, reason: 'ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD has too few distinct characters' };
  }
  return { ok: true };
}

/**
 * Create the first administrator if — and only if — the user table is empty
 * and valid bootstrap credentials are configured. Never throws for config
 * problems: database initialisation continues without an administrator.
 */
export async function bootstrapFirstAdmin(
  client: QueryClient,
  log: BootstrapLogger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BootstrapOutcome> {
  // Serialise concurrent bootstraps (no-op if the caller already holds it; xact-scoped).
  await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_ADVISORY_LOCK_KEY]);

  // Warn (without altering anything) if accounts with former default addresses exist.
  const legacy = await client.query(
    'SELECT COUNT(*)::int AS n FROM dash_users WHERE LOWER(email) = ANY($1)',
    [LEGACY_DEFAULT_ADMIN_EMAILS as string[]],
  );
  const legacyCount = Number(legacy.rows[0]?.n ?? 0);
  if (legacyCount > 0) {
    log.warn(
      `${legacyCount} account(s) with a former built-in default admin address exist. If the password was never ` +
        'changed it is publicly known — reset or delete them (see docs/SECURITY-default-admin-remediation.md).',
    );
  }

  const count = await client.query('SELECT COUNT(*)::int AS n FROM dash_users');
  const userCount = Number(count.rows[0]?.n ?? 0);
  const email = (env.ANUCLAW_BOOTSTRAP_ADMIN_EMAIL ?? '').trim();
  const password = env.ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD ?? '';
  const configured = email !== '' || password.trim() !== '';

  if (userCount > 0) {
    if (configured) {
      log.info('Admin bootstrap skipped: users already exist. Remove ANUCLAW_BOOTSTRAP_ADMIN_* from the environment.');
    }
    return 'skipped_users_exist';
  }

  if (!configured) {
    log.warn(
      'No dashboard users exist and no administrator was created. To create the first administrator, set ' +
        'ANUCLAW_BOOTSTRAP_ADMIN_EMAIL and ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD and restart.',
    );
    return 'not_configured';
  }

  if (!email || !password.trim()) {
    log.warn('No administrator was created: both ANUCLAW_BOOTSTRAP_ADMIN_EMAIL and ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD are required.');
    return 'invalid_config';
  }
  const checks = [validateBootstrapEmail(email), validateBootstrapPassword(password, email)];
  const failed = checks.find((c) => !c.ok);
  if (failed) {
    log.warn(`No administrator was created: ${failed.reason}.`);
    return 'invalid_config';
  }

  // Under the advisory lock; WHERE NOT EXISTS remains as a second guard.
  const passwordHash = await hashPassword(password);
  const res = await client.query(
    `INSERT INTO dash_users (id, email, name, role, scope_json, password_hash, created_at)
     SELECT $1, $2, $3, 'admin', '{}', $4, $5
     WHERE NOT EXISTS (SELECT 1 FROM dash_users)`,
    [crypto.randomUUID(), email, 'Administrator', passwordHash, Date.now()],
  );
  if ((res.rowCount ?? 0) !== 1) {
    log.info('Admin bootstrap skipped: another process created a user first.');
    return 'skipped_users_exist';
  }
  log.info(
    'First administrator created from ANUCLAW_BOOTSTRAP_ADMIN_* configuration. Remove ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD ' +
      'from the environment now.',
  );
  return 'created';
}
