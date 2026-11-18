/**
 * Runs the real migration (ensureDbReady) against a mocked `pg` pool — no
 * PostgreSQL connection, no real accounts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executed: string[] = [];
let insertParams: unknown[][] = [];

vi.mock('pg', () => {
  const client = {
    async query(text: string, params?: unknown[]) {
      executed.push(text);
      if (/COUNT\(\*\)/i.test(text)) return { rows: [{ n: 0 }] };
      if (/INSERT INTO dash_users/i.test(text)) {
        insertParams.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    },
    release() {},
  };
  class Pool {
    on() {}
    async connect() { return client; }
    async query() { return { rows: [] }; }
  }
  return { Pool, types: { setTypeParser() {} } };
});

const logLines: string[] = [];
vi.mock('../logger', () => {
  const rec = (m: string, ...a: unknown[]) => { logLines.push([m, ...a.map(String)].join(' ')); };
  return { logger: { info: rec, warn: rec, error: rec, debug: rec } };
});

const KEYS = ['ANUCLAW_BOOTSTRAP_ADMIN_EMAIL', 'ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  executed.length = 0;
  insertParams = [];
  logLines.length = 0;
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  vi.resetModules();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('database initialisation', () => {
  it('succeeds without bootstrap credentials and creates no user', async () => {
    const { ensureDbReady } = await import('./connection');
    await expect(ensureDbReady()).resolves.toBeUndefined();
    expect(executed).toContain('COMMIT');
    expect(executed).not.toContain('ROLLBACK');
    expect(executed.some((s) => /INSERT INTO dash_users/i.test(s))).toBe(false);
    expect(logLines.join('\n')).toMatch(/no administrator was created/i);
  });

  it('creates exactly one admin when valid bootstrap config is provided, without logging it', async () => {
    const password = 'Vq7#tR2!mZp9xLw'; // synthetic, test-only
    process.env.ANUCLAW_BOOTSTRAP_ADMIN_EMAIL = 'ops.lead@clinic-synthetic.org';
    process.env.ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD = password;
    const { ensureDbReady } = await import('./connection');
    await ensureDbReady();
    expect(insertParams).toHaveLength(1);
    expect(executed).toContain('COMMIT');
    const logs = logLines.join('\n');
    expect(logs).not.toContain(password);
    expect(logs).not.toContain('ops.lead@clinic-synthetic.org');
  });
});
