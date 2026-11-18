import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_DEFAULT_ADMIN_EMAILS,
  QueryClient,
  bootstrapFirstAdmin,
  validateBootstrapPassword,
} from './admin-bootstrap';
import { verifyPassword } from '../security/password';

/** In-memory stand-in for the dash_users table. No real database. */
class FakeUsers implements QueryClient {
  rows: Array<{ id: string; email: string; role: string; password_hash: string }> = [];
  statements: string[] = [];
  /** Simulate another process winning the race on INSERT. */
  loseInsertRace = false;

  async query(text: string, params: unknown[] = []) {
    this.statements.push(text);
    if (/pg_advisory_xact_lock/i.test(text)) return { rows: [] };
    if (/LOWER\(email\)\s*=\s*ANY/i.test(text)) {
      const emails = params[0] as string[];
      return { rows: [{ n: this.rows.filter((r) => emails.includes(r.email.toLowerCase())).length }] };
    }
    if (/SELECT COUNT\(\*\)::int AS n FROM dash_users$/i.test(text.trim())) {
      return { rows: [{ n: this.rows.length }] };
    }
    if (/INSERT INTO dash_users/i.test(text)) {
      if (this.loseInsertRace || this.rows.length > 0) return { rows: [], rowCount: 0 };
      const [id, email, , password_hash] = params as string[];
      this.rows.push({ id, email, role: 'admin', password_hash });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL in test: ${text}`);
  }
}

class CaptureLog {
  lines: string[] = [];
  info = (m: string) => { this.lines.push(m); };
  warn = (m: string) => { this.lines.push(m); };
  text() { return this.lines.join('\n'); }
}

// Synthetic test-only credentials. Not real accounts.
const EMAIL = 'ops.lead@clinic-synthetic.org';
const PASSWORD = 'Vq7#tR2!mZp9xLw';
const VALID = { ANUCLAW_BOOTSTRAP_ADMIN_EMAIL: EMAIL, ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD };

function assertNoSecretsLogged(log: CaptureLog, env: Record<string, string | undefined>) {
  const text = log.text();
  for (const v of Object.values(env)) {
    if (v && v.trim().length >= 4) expect(text).not.toContain(v.trim());
  }
  expect(text).not.toContain('scrypt$');
}

describe('no default administrator', () => {
  it('creates no account when bootstrap is not configured, and says so safely', async () => {
    const db = new FakeUsers();
    const log = new CaptureLog();
    expect(await bootstrapFirstAdmin(db, log, {})).toBe('not_configured');
    expect(db.rows).toHaveLength(0);
    expect(db.statements.some((s) => /INSERT/i.test(s))).toBe(false);
    expect(log.text()).toMatch(/no administrator was created/i);
    expect(log.text()).toMatch(/ANUCLAW_BOOTSTRAP_ADMIN_EMAIL/);
  });

  it('leaves no usable former default credential (legacy addresses/password cannot log in)', async () => {
    const db = new FakeUsers();
    await bootstrapFirstAdmin(db, new CaptureLog(), {});
    for (const email of LEGACY_DEFAULT_ADMIN_EMAILS) {
      expect(db.rows.find((r) => r.email === email)).toBeUndefined();
    }
    // The old published password is rejected even if configured explicitly.
    expect(validateBootstrapPassword('admin' + '123', EMAIL).ok).toBe(false);
  });

  it('database init sources no longer hardcode an admin seed or password', () => {
    for (const rel of ['./connection.ts', '../dashboard/server/db-schema.ts']) {
      const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      expect(src).not.toMatch(/INSERT INTO dash_users/i);
      expect(src).not.toContain('admin' + '123');
      for (const email of LEGACY_DEFAULT_ADMIN_EMAILS) expect(src).not.toContain(`'${email}'`);
    }
  });
});

describe('explicit bootstrap', () => {
  it('creates exactly one administrator with a login-compatible scrypt hash, under the advisory lock', async () => {
    const db = new FakeUsers();
    const log = new CaptureLog();
    expect(await bootstrapFirstAdmin(db, log, VALID)).toBe('created');
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ email: EMAIL, role: 'admin' });
    expect(db.rows[0].password_hash).toMatch(/^scrypt\$1\$/);
    expect((await verifyPassword(PASSWORD, db.rows[0].password_hash)).ok).toBe(true);
    expect(db.rows[0].password_hash).not.toContain(PASSWORD);
    const lockAt = db.statements.findIndex((s) => /pg_advisory_xact_lock/.test(s));
    const insertAt = db.statements.findIndex((s) => /INSERT/.test(s));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(insertAt);
    assertNoSecretsLogged(log, VALID);
  });

  it('runs only once: a second start with the same config creates nothing', async () => {
    const db = new FakeUsers();
    await bootstrapFirstAdmin(db, new CaptureLog(), VALID);
    const log = new CaptureLog();
    expect(await bootstrapFirstAdmin(db, log, VALID)).toBe('skipped_users_exist');
    expect(db.rows).toHaveLength(1);
    assertNoSecretsLogged(log, VALID);
  });

  it('does not run when any user already exists (even a non-admin)', async () => {
    const db = new FakeUsers();
    db.rows.push({ id: 'u1', email: 'viewer@clinic-synthetic.org', role: 'viewer', password_hash: 'x' });
    expect(await bootstrapFirstAdmin(db, new CaptureLog(), VALID)).toBe('skipped_users_exist');
    expect(db.rows).toHaveLength(1);
    expect(db.statements.some((s) => /INSERT/i.test(s))).toBe(false);
  });

  it('creates nothing if another process inserts first', async () => {
    const db = new FakeUsers();
    db.loseInsertRace = true;
    expect(await bootstrapFirstAdmin(db, new CaptureLog(), VALID)).toBe('skipped_users_exist');
    expect(db.rows).toHaveLength(0);
  });
});

describe('invalid bootstrap configuration creates no account', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['email only', { ANUCLAW_BOOTSTRAP_ADMIN_EMAIL: EMAIL }],
    ['password only', { ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD }],
    ['blank email', { ANUCLAW_BOOTSTRAP_ADMIN_EMAIL: '   ', ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD }],
    ['blank password', { ANUCLAW_BOOTSTRAP_ADMIN_EMAIL: EMAIL, ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD: '    ' }],
    ['former default password', { ANUCLAW_BOOTSTRAP_ADMIN_EMAIL: EMAIL, ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD: 'admin' + '123' }],
    ['common password + suffix', { ANUCLAW_BOOTSTRAP_ADMIN_EMAIL: EMAIL, ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD: 'Password2026!' }],
    ['placeholder password', { ANUCLAW_BOOTSTRAP_ADMIN_EMAIL: EMAIL, ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD: 'Change-Me-Now-42!' }],
    ['too short', { ANUCLAW_BOOTSTRAP_ADMIN_EMAIL: EMAIL, ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD: 'Aa1!xyz' }],
    ['too few character classes', { ANUCLAW_BOOTSTRAP_ADMIN_EMAIL: EMAIL, ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD: 'lowercaseonlyletters' }],
    ['too few distinct characters', { ANUCLAW_BOOTSTRAP_ADMIN_EMAIL: EMAIL, ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD: 'Aa1!Aa1!Aa1!Aa1!' }],
    ['password contains email name', { ANUCLAW_BOOTSTRAP_ADMIN_EMAIL: EMAIL, ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD: 'Ops.Lead#2026xyz' }],
    ['former default email', { ANUCLAW_BOOTSTRAP_ADMIN_EMAIL: 'admin@amgi.io', ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD }],
    ['placeholder email domain', { ANUCLAW_BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com', ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD }],
    ['invalid email', { ANUCLAW_BOOTSTRAP_ADMIN_EMAIL: 'not-an-email', ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD }],
  ];

  it.each(cases)('%s', async (_label, env) => {
    const db = new FakeUsers();
    const log = new CaptureLog();
    expect(await bootstrapFirstAdmin(db, log, env)).toBe('invalid_config');
    expect(db.rows).toHaveLength(0);
    expect(db.statements.some((s) => /INSERT/i.test(s))).toBe(false);
    expect(log.text()).toMatch(/No administrator was created/);
    assertNoSecretsLogged(log, env);
  });
});

describe('existing databases', () => {
  it('warns about former default accounts with a count only, and does not alter them', async () => {
    const db = new FakeUsers();
    db.rows.push({ id: 'legacy-1', email: 'admin@amgi.io', role: 'admin', password_hash: 'old' });
    const before = JSON.stringify(db.rows);
    const log = new CaptureLog();
    expect(await bootstrapFirstAdmin(db, log, {})).toBe('skipped_users_exist');
    expect(log.text()).toMatch(/1 account\(s\) with a former built-in default admin address/);
    expect(log.text()).not.toContain('admin@amgi.io');
    expect(JSON.stringify(db.rows)).toBe(before);
    expect(db.statements.every((s) => /^\s*SELECT/i.test(s))).toBe(true);
  });
});
