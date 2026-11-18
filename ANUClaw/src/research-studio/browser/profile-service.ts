/**
 * Browser profile metadata + per-profile session lock (M3, plan §4). Never stores a password, cookie or token — the
 * database holds only metadata (provider, label, status, the profile's own directory path, who currently holds the
 * lock). The authenticated browser state itself is an isolated, on-disk Playwright user-data directory that this
 * module creates (mode 0700) and deletes on disconnect/revoke, addressed only by a server-generated UUID — never a
 * caller-supplied path segment, exactly like import-service.ts's artifact storage.
 *
 * Manual login / takeover: a profile starts 'disconnected'. `beginConnect` moves it to 'connecting' — a human must
 * then actually complete login in a real (non-headless) browser window pointed at this profile's `user_data_dir`
 * (the dashboard/CLI flow that launches that window is out of scope for the automated test harness; see
 * docs/RESEARCH-STUDIO-BROWSER-CONNECTOR.md for the exact manual procedure). `confirmConnected` moves it to 'active'
 * only after the human confirms login succeeded — nothing here ever infers a successful login on its own.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../../db';
import { WorkflowError } from '../../documents/workflow';

export const BROWSER_PROFILE_STATUSES = ['disconnected', 'connecting', 'active', 'expired', 'revoked'] as const;
export type BrowserProfileStatus = typeof BROWSER_PROFILE_STATUSES[number];

export interface BrowserProfileRow {
  id: string; owner_id: string; provider: string; label: string; status: BrowserProfileStatus; user_data_dir: string;
  locked_by_task_id: string | null; locked_at: number | null;
  created_at: number; updated_at: number; last_used_at: number | null;
}

export class BrowserProfileError extends Error { constructor(public readonly code: string, message: string, public readonly status = 409) { super(message); this.name = 'BrowserProfileError'; } }

export function profileRoot(): string { return process.env.ANUCLAW_RESEARCH_STUDIO_BROWSER_ROOT ?? path.join(process.cwd(), 'data', 'research-studio-browser-profiles'); }

async function ownProfile(profileId: string, userId: string): Promise<BrowserProfileRow> {
  const row = await db.queryOne<BrowserProfileRow>('SELECT * FROM research_studio_browser_profiles WHERE id = $1 AND owner_id = $2', [profileId, userId]);
  if (!row) throw new WorkflowError(404, 'not_found', 'Browser profile not found.');
  return row;
}

export async function createProfile(userId: string, provider: string, label: string, now = Date.now()): Promise<BrowserProfileRow> {
  if (!provider?.trim() || !label?.trim()) throw new WorkflowError(400, 'validation', 'provider and label are required.');
  const id = crypto.randomUUID();
  const dir = path.join(profileRoot(), id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  await db.query('INSERT INTO research_studio_browser_profiles (id, owner_id, provider, label, status, user_data_dir, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)',
    [id, userId, provider.trim(), label.trim(), 'disconnected', dir, now]);
  return (await ownProfile(id, userId));
}

export async function listProfiles(userId: string): Promise<BrowserProfileRow[]> { return db.query<BrowserProfileRow>('SELECT * FROM research_studio_browser_profiles WHERE owner_id = $1 ORDER BY ordinal', [userId]); }
export async function getProfile(profileId: string, userId: string): Promise<BrowserProfileRow> { return ownProfile(profileId, userId); }

/** Moves a disconnected profile to 'connecting' — the state meaning "a human must now complete login manually". */
export async function beginConnect(profileId: string, userId: string, now = Date.now()): Promise<BrowserProfileRow> {
  const p = await ownProfile(profileId, userId);
  if (!['disconnected', 'expired'].includes(p.status)) throw new BrowserProfileError('bad_state', `Cannot connect from status "${p.status}"; only disconnected/expired profiles can begin connecting.`);
  await db.query('UPDATE research_studio_browser_profiles SET status = $2, updated_at = $3 WHERE id = $1', [profileId, 'connecting', now]);
  return ownProfile(profileId, userId);
}

/** The human confirms login completed. Never inferred automatically — see the module header. */
export async function confirmConnected(profileId: string, userId: string, now = Date.now()): Promise<BrowserProfileRow> {
  const p = await ownProfile(profileId, userId);
  if (p.status !== 'connecting') throw new BrowserProfileError('bad_state', `Cannot confirm from status "${p.status}"; call beginConnect first.`);
  await db.query('UPDATE research_studio_browser_profiles SET status = $2, updated_at = $3, last_used_at = $3 WHERE id = $1', [profileId, 'active', now]);
  return ownProfile(profileId, userId);
}

export async function markExpired(profileId: string, now = Date.now()): Promise<void> {
  await db.query(`UPDATE research_studio_browser_profiles SET status = 'expired', updated_at = $2 WHERE id = $1 AND status = 'active'`, [profileId, now]);
}

/** Disconnects: clears the on-disk profile directory and resets to 'disconnected'. Reversible (a new connect can reuse the profile row with a fresh directory). */
export async function disconnectProfile(profileId: string, userId: string, now = Date.now()): Promise<BrowserProfileRow> {
  const p = await ownProfile(profileId, userId);
  fs.rmSync(p.user_data_dir, { recursive: true, force: true });
  const freshDir = path.join(profileRoot(), p.id); fs.mkdirSync(freshDir, { recursive: true, mode: 0o700 });
  await db.query(`UPDATE research_studio_browser_profiles SET status = 'disconnected', user_data_dir = $2, locked_by_task_id = NULL, locked_at = NULL, updated_at = $3 WHERE id = $1`, [profileId, freshDir, now]);
  return ownProfile(profileId, userId);
}

/** Revokes PERMANENTLY: deletes the on-disk directory and the profile never reconnects (a new profile must be created). */
export async function revokeProfile(profileId: string, userId: string, now = Date.now()): Promise<BrowserProfileRow> {
  const p = await ownProfile(profileId, userId);
  fs.rmSync(p.user_data_dir, { recursive: true, force: true });
  await db.query(`UPDATE research_studio_browser_profiles SET status = 'revoked', locked_by_task_id = NULL, locked_at = NULL, updated_at = $2 WHERE id = $1`, [profileId, now]);
  return ownProfile(profileId, userId);
}

const STALE_LOCK_MS = 15 * 60 * 1000;
/** Atomic CAS lock acquisition — identical pattern to task-store's claimNextReady. Refuses a profile that is not 'active', and sweeps a lock held by a task that is itself no longer running (crash recovery for the browser session, not just the task). */
export async function acquireSessionLock(profileId: string, taskId: string, now = Date.now()): Promise<BrowserProfileRow> {
  const p = await db.queryOne<BrowserProfileRow>('SELECT * FROM research_studio_browser_profiles WHERE id = $1', [profileId]);
  if (!p) throw new WorkflowError(404, 'not_found', 'Browser profile not found.');
  if (p.status !== 'active') throw new BrowserProfileError('not_active', `Profile is "${p.status}", not active; it cannot be locked for a session.`);
  if (p.locked_by_task_id && p.locked_at && now - p.locked_at > STALE_LOCK_MS) {
    await db.query('UPDATE research_studio_browser_profiles SET locked_by_task_id = NULL, locked_at = NULL WHERE id = $1 AND locked_by_task_id = $2', [profileId, p.locked_by_task_id]);
  }
  const r = await db.query<BrowserProfileRow>('UPDATE research_studio_browser_profiles SET locked_by_task_id = $2, locked_at = $3, last_used_at = $3 WHERE id = $1 AND locked_by_task_id IS NULL RETURNING *', [profileId, taskId, now]);
  if (!r.length) throw new BrowserProfileError('locked', 'This profile is already locked by another task.');
  return r[0];
}
export async function releaseSessionLock(profileId: string, taskId: string): Promise<void> {
  await db.query('UPDATE research_studio_browser_profiles SET locked_by_task_id = NULL, locked_at = NULL WHERE id = $1 AND locked_by_task_id = $2', [profileId, taskId]);
}
