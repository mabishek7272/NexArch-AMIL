/** Browser profile metadata + session lock (real PostgreSQL): never stores a credential; enforces the
 * connecting→active→locked lifecycle; a stale lock (its holder task crashed) is swept, not stuck forever. Opt-in:
 * ANUCLAW_TEST_PG_URL. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('Research Studio browser profiles (real PostgreSQL)', () => {
  const dbName = `anuclaw_rsb_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let profiles: typeof import('./profile-service');
  const userId = crypto.randomUUID(); const other = crypto.randomUUID();

  beforeAll(async () => {
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName }); delete process.env.NODE_ENV;
    vi.resetModules(); await (await import('../../db/connection')).ensureDbReady();
    profiles = await import('./profile-service');
  }, 90_000);
  afterAll(async () => {
    try { (await import('../../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  it('a profile starts disconnected with a real, mode-0700 on-disk directory and no credential anywhere in the row', async () => {
    const p = await profiles.createProfile(userId, 'simulated', 'My test profile');
    expect(p.status).toBe('disconnected');
    expect(fs.existsSync(p.user_data_dir)).toBe(true);
    expect(fs.statSync(p.user_data_dir).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(p)).not.toMatch(/password|cookie|token/i);
  });

  it('the connect lifecycle requires an explicit human confirmation — nothing becomes "active" on its own', async () => {
    const p = await profiles.createProfile(userId, 'simulated', 'Connect lifecycle');
    await expect(profiles.confirmConnected(p.id, userId)).rejects.toThrow(/call beginConnect first/);
    const connecting = await profiles.beginConnect(p.id, userId);
    expect(connecting.status).toBe('connecting');
    const active = await profiles.confirmConnected(p.id, userId);
    expect(active.status).toBe('active');
  });

  it('a session lock is exclusive: a second task cannot lock an already-locked profile', async () => {
    const p = await profiles.createProfile(userId, 'simulated', 'Lock test');
    await profiles.beginConnect(p.id, userId); await profiles.confirmConnected(p.id, userId);
    const locked = await profiles.acquireSessionLock(p.id, 'task-a');
    expect(locked.locked_by_task_id).toBe('task-a');
    await expect(profiles.acquireSessionLock(p.id, 'task-b')).rejects.toThrow(/locked/);
    await profiles.releaseSessionLock(p.id, 'task-a');
    const relocked = await profiles.acquireSessionLock(p.id, 'task-b');
    expect(relocked.locked_by_task_id).toBe('task-b');
  });

  it('a stale lock (holder crashed) is swept and can be reacquired — the same resilience as task-store, applied to browser sessions', async () => {
    const p = await profiles.createProfile(userId, 'simulated', 'Stale lock test');
    await profiles.beginConnect(p.id, userId); await profiles.confirmConnected(p.id, userId);
    await profiles.acquireSessionLock(p.id, 'task-dead', Date.now() - 20 * 60 * 1000); // 20 minutes ago — past STALE_LOCK_MS
    const recovered = await profiles.acquireSessionLock(p.id, 'task-fresh', Date.now());
    expect(recovered.locked_by_task_id).toBe('task-fresh');
  });

  it('disconnect clears the on-disk profile data and resets to disconnected (reversible)', async () => {
    const p = await profiles.createProfile(userId, 'simulated', 'Disconnect test');
    const oldDir = p.user_data_dir; fs.writeFileSync(`${oldDir}/marker.txt`, 'secret-ish session data');
    const after = await profiles.disconnectProfile(p.id, userId);
    expect(after.status).toBe('disconnected');
    expect(fs.existsSync(`${oldDir}/marker.txt`)).toBe(false);
  });

  it('revoke is permanent: the profile cannot be reconnected afterward', async () => {
    const p = await profiles.createProfile(userId, 'simulated', 'Revoke test');
    const after = await profiles.revokeProfile(p.id, userId);
    expect(after.status).toBe('revoked');
    await expect(profiles.beginConnect(p.id, userId)).rejects.toThrow(/only disconnected\/expired/);
  });

  it('owner isolation: a different user cannot see or act on another user\'s profile', async () => {
    const p = await profiles.createProfile(userId, 'simulated', 'Isolation test');
    await expect(profiles.getProfile(p.id, other)).rejects.toThrow(/not found/);
    await expect(profiles.beginConnect(p.id, other)).rejects.toThrow(/not found/);
  });
});
