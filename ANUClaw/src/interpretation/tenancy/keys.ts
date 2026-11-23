/**
 * Tenant API keys (interpretation engine, P1): many keys per tenant, each independently revocable, expirable
 * and rotatable, with last-used tracking. Authentication reads ONLY `tenant_api_keys`.
 *
 * Storage: only a SHA-256 hash and a short prefix are kept; the key is returned exactly once at creation.
 * Keys are 192-bit random values, so a fast hash is adequate (same reasoning as src/api/tenant-store.ts).
 *
 * Schema: `tenant_api_keys` is created by the startup migration (src/db/connection.ts), which also copies each
 * tenant's pre-existing single key (`tenants.api_key_hash`) in as a row labelled `legacy`. As a safety net for
 * the window when older code is still registering tenants, a key found only in `tenants.api_key_hash` is
 * adopted into the table the first time it is presented. A revoked row always stays in the table, so a
 * revoked legacy key can never come back. `tenants.api_key_hash` itself is never modified, so a code rollback
 * keeps the original key working.
 */
import * as crypto from 'crypto';
import { db, TxClient } from '../../db';
import { mapTenantRow } from '../../api/tenant-map';
import type { Tenant } from '../../api/tenant-store';

export class TenancyError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'TenancyError';
  }
}

export const MAX_ACTIVE_KEYS_PER_TENANT = 10;
export const DEFAULT_ROTATION_GRACE_SECONDS = 24 * 60 * 60;
export const MAX_ROTATION_GRACE_SECONDS = 30 * 24 * 60 * 60;
const LAST_USED_RESOLUTION_MS = 60_000;

export function generateApiKey(): string {
  return 'amgi_live_' + crypto.randomBytes(24).toString('hex');
}

export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

/** `*` grants everything (the behaviour every key had before scopes existed). */
export function hasScope(granted: string[], needed: string): boolean {
  return granted.includes('*') || granted.includes(needed);
}

// ── records ─────────────────────────────────────────────────────────────────────────────────────

export interface TenantKeyRecord {
  key_id: string;
  tenant_id: string;
  key_prefix: string;
  label: string;
  scopes: string[];
  created_at: number;
  created_by: string;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
  last_used_at: number | null;
  rotated_from: string | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toRecord(r: Record<string, any>): TenantKeyRecord {
  let scopes: string[] = ['*'];
  try { const p = JSON.parse(String(r.scopes)); if (Array.isArray(p)) scopes = p.map(String); } catch { /* keep default */ }
  return {
    key_id: r.key_id, tenant_id: r.tenant_id, key_prefix: r.key_prefix, label: r.label, scopes,
    created_at: Number(r.created_at), created_by: r.created_by,
    expires_at: num(r.expires_at), revoked_at: num(r.revoked_at), revoked_reason: r.revoked_reason ?? null,
    last_used_at: num(r.last_used_at), rotated_from: r.rotated_from ?? null,
  };
}

const COLS = 'key_id, tenant_id, key_prefix, label, scopes, created_at, created_by, expires_at, revoked_at, revoked_reason, last_used_at, rotated_from';

export function isRecordActive(r: Pick<TenantKeyRecord, 'revoked_at' | 'expires_at'>, now: number): boolean {
  return r.revoked_at === null && (r.expires_at === null || r.expires_at > now);
}

// ── validation ──────────────────────────────────────────────────────────────────────────────────

const SCOPE_RE = /^(\*|[a-z][a-z0-9_:.-]{0,39})$/;

function cleanLabel(label: unknown): string {
  if (label === undefined || label === null) return '';
  if (typeof label !== 'string') throw new TenancyError(400, 'validation_failed', 'label must be a string.');
  const t = label.trim();
  if (t.length > 100) throw new TenancyError(400, 'validation_failed', 'label must be at most 100 characters.');
  return t;
}

function cleanScopes(scopes: unknown): string[] {
  if (scopes === undefined || scopes === null) return ['*'];
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 10 || !scopes.every((s) => typeof s === 'string' && SCOPE_RE.test(s))) {
    throw new TenancyError(400, 'validation_failed', 'scopes must be 1-10 strings such as "*" or "interpret".');
  }
  return [...new Set(scopes as string[])];
}

function cleanExpiry(expiresAt: unknown, now: number): number | null {
  if (expiresAt === undefined || expiresAt === null) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new TenancyError(400, 'validation_failed', 'expiresAt must be a future time (epoch milliseconds).');
  }
  return Math.floor(expiresAt);
}

// ── mutations (each runs inside the caller's transaction so the audit entry commits with it) ─────────

export interface NewKeyOptions {
  label?: string;
  scopes?: string[];
  expiresAt?: number | null;
  createdBy: string;
  rotatedFrom?: string | null;
}

/** Inserts one key row. Used by tenant creation, key creation and rotation; never opens its own transaction. */
export async function insertKeyRow(
  tx: TxClient, tenantId: string, opts: NewKeyOptions, now: number, presetKey?: string,
): Promise<{ record: TenantKeyRecord; apiKey: string }> {
  const apiKey = presetKey ?? generateApiKey();
  const keyId = crypto.randomUUID();
  const r = await tx.query(
    `INSERT INTO tenant_api_keys (key_id, tenant_id, key_hash, key_prefix, label, scopes, created_at, created_by, expires_at, rotated_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLS}`,
    [keyId, tenantId, hashApiKey(apiKey), apiKey.slice(0, 14), cleanLabel(opts.label), JSON.stringify(cleanScopes(opts.scopes)),
      now, opts.createdBy, cleanExpiry(opts.expiresAt, now), opts.rotatedFrom ?? null]);
  return { record: toRecord(r.rows[0]), apiKey };
}

async function assertTenantAndCapacity(tx: TxClient, tenantId: string, now: number, extra = 0): Promise<void> {
  const t = await tx.query('SELECT tenant_id FROM tenants WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
  if (!t.rows.length) throw new TenancyError(404, 'tenant_not_found', 'Tenant not found.');
  const c = await tx.query(
    `SELECT COUNT(*)::int AS n FROM tenant_api_keys WHERE tenant_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`,
    [tenantId, now]);
  if (Number(c.rows[0].n) + extra >= MAX_ACTIVE_KEYS_PER_TENANT) {
    throw new TenancyError(409, 'key_limit_reached', `A tenant may hold at most ${MAX_ACTIVE_KEYS_PER_TENANT} active keys; revoke one first.`);
  }
}

/** Creates an additional key. Caller supplies `audit(tx, record)` which runs in the same transaction. */
export async function createKey(
  tenantId: string, opts: NewKeyOptions, now: number,
  audit: (tx: TxClient, record: TenantKeyRecord) => Promise<void>,
): Promise<{ record: TenantKeyRecord; apiKey: string }> {
  return db.transaction(async (tx) => {
    await assertTenantAndCapacity(tx, tenantId, now);
    const made = await insertKeyRow(tx, tenantId, opts, now);
    await audit(tx, made.record);
    return made;
  });
}

export interface RotateOptions { graceSeconds?: number; createdBy: string; expiresAt?: number | null }

/**
 * Issues a replacement key and retires the old one. With a grace period the old key keeps working until it
 * (or its own earlier expiry) lapses, so a client can switch without downtime; with 0 it is revoked at once.
 */
export async function rotateKey(
  tenantId: string, keyId: string, opts: RotateOptions, now: number,
  audit: (tx: TxClient, info: { oldKey: TenantKeyRecord; newKey: TenantKeyRecord; graceSeconds: number }) => Promise<void>,
): Promise<{ record: TenantKeyRecord; apiKey: string; retired: TenantKeyRecord }> {
  const grace = opts.graceSeconds ?? DEFAULT_ROTATION_GRACE_SECONDS;
  if (!Number.isInteger(grace) || grace < 0 || grace > MAX_ROTATION_GRACE_SECONDS) {
    throw new TenancyError(400, 'validation_failed', `graceSeconds must be an integer from 0 to ${MAX_ROTATION_GRACE_SECONDS}.`);
  }
  return db.transaction(async (tx) => {
    await assertTenantAndCapacity(tx, tenantId, now, 1);
    const found = await tx.query(`SELECT ${COLS} FROM tenant_api_keys WHERE key_id = $1 AND tenant_id = $2 FOR UPDATE`, [keyId, tenantId]);
    if (!found.rows.length) throw new TenancyError(404, 'key_not_found', 'Key not found.');
    const old = toRecord(found.rows[0]);
    if (old.revoked_at !== null) throw new TenancyError(409, 'key_revoked', 'A revoked key cannot be rotated.');
    if (old.expires_at !== null && old.expires_at <= now) throw new TenancyError(409, 'key_expired', 'An expired key cannot be rotated.');

    const made = await insertKeyRow(tx, tenantId,
      { label: old.label, scopes: old.scopes, expiresAt: opts.expiresAt ?? null, createdBy: opts.createdBy, rotatedFrom: old.key_id }, now);

    let updated;
    if (grace === 0) {
      updated = await tx.query(`UPDATE tenant_api_keys SET revoked_at = $2, revoked_reason = 'rotated' WHERE key_id = $1 RETURNING ${COLS}`, [old.key_id, now]);
    } else {
      const lapse = now + grace * 1000;
      updated = await tx.query(`UPDATE tenant_api_keys SET expires_at = LEAST(COALESCE(expires_at, $2), $2) WHERE key_id = $1 RETURNING ${COLS}`, [old.key_id, lapse]);
    }
    const retired = toRecord(updated.rows[0]);
    await audit(tx, { oldKey: retired, newKey: made.record, graceSeconds: grace });
    return { record: made.record, apiKey: made.apiKey, retired };
  });
}

/** Revokes a key immediately. Idempotent: revoking an already-revoked key returns it unchanged. */
export async function revokeKey(
  tenantId: string, keyId: string, reason: string, now: number,
  audit: (tx: TxClient, record: TenantKeyRecord, alreadyRevoked: boolean) => Promise<void>,
): Promise<{ record: TenantKeyRecord; alreadyRevoked: boolean }> {
  const why = (reason ?? '').trim().slice(0, 100) || 'revoked_by_admin';
  return db.transaction(async (tx) => {
    const found = await tx.query(`SELECT ${COLS} FROM tenant_api_keys WHERE key_id = $1 AND tenant_id = $2 FOR UPDATE`, [keyId, tenantId]);
    if (!found.rows.length) throw new TenancyError(404, 'key_not_found', 'Key not found.');
    const cur = toRecord(found.rows[0]);
    if (cur.revoked_at !== null) { await audit(tx, cur, true); return { record: cur, alreadyRevoked: true }; }
    const u = await tx.query(`UPDATE tenant_api_keys SET revoked_at = $2, revoked_reason = $3 WHERE key_id = $1 RETURNING ${COLS}`, [keyId, now, why]);
    const record = toRecord(u.rows[0]);
    await audit(tx, record, false);
    return { record, alreadyRevoked: false };
  });
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────

/** Keys of one tenant, newest first. Never includes the hash. */
export async function listKeys(tenantId: string): Promise<TenantKeyRecord[]> {
  const rows = await db.query(`SELECT ${COLS} FROM tenant_api_keys WHERE tenant_id = $1 ORDER BY created_at DESC, key_id`, [tenantId]);
  return rows.map(toRecord);
}

/** True while the key exists for this tenant, is not revoked and has not expired. Used to bind JWTs to their key. */
export async function isKeyActive(tenantId: string, keyId: string, now = Date.now()): Promise<boolean> {
  const r = await db.queryOne(
    `SELECT 1 FROM tenant_api_keys WHERE key_id = $1 AND tenant_id = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $3)`,
    [keyId, tenantId, now]);
  return !!r;
}

export type KeyLookup =
  | { status: 'ok'; tenant: Tenant; keyId: string; scopes: string[] }
  | { status: 'revoked' | 'expired' | 'unknown' };

const LOOKUP_SQL = `
  SELECT k.key_id AS kk_key_id, k.scopes AS kk_scopes, k.expires_at AS kk_expires_at, k.revoked_at AS kk_revoked_at,
         k.last_used_at AS kk_last_used_at, t.*
    FROM tenant_api_keys k JOIN tenants t ON t.tenant_id = k.tenant_id
   WHERE k.key_hash = $1`;

async function adoptLegacyKey(hash: string, now: number): Promise<void> {
  await db.query(
    `INSERT INTO tenant_api_keys (key_id, tenant_id, key_hash, key_prefix, label, created_at, created_by)
     SELECT 'legacy-' || tenant_id, tenant_id, api_key_hash, COALESCE(api_key_prefix, ''), 'legacy', $2, 'adopted'
       FROM tenants WHERE api_key_hash = $1
     ON CONFLICT DO NOTHING`, [hash, now]);
}

/** Resolves a presented API key. Distinguishes revoked/expired from unknown so callers can answer precisely. */
export async function lookupApiKey(apiKey: string, now = Date.now()): Promise<KeyLookup> {
  if (typeof apiKey !== 'string' || apiKey.length < 16 || apiKey.length > 200 || apiKey.startsWith('hashed:')) return { status: 'unknown' };
  const hash = hashApiKey(apiKey);
  let row = await db.queryOne<Record<string, any>>(LOOKUP_SQL, [hash]);
  if (!row) {
    await adoptLegacyKey(hash, now);
    row = await db.queryOne<Record<string, any>>(LOOKUP_SQL, [hash]);
    if (!row) return { status: 'unknown' };
  }
  if (row.kk_revoked_at !== null && row.kk_revoked_at !== undefined) return { status: 'revoked' };
  const exp = num(row.kk_expires_at);
  if (exp !== null && exp <= now) return { status: 'expired' };

  const last = num(row.kk_last_used_at);
  if (last === null || now - last >= LAST_USED_RESOLUTION_MS) {
    await db.query('UPDATE tenant_api_keys SET last_used_at = $2 WHERE key_id = $1', [row.kk_key_id, now]).catch(() => { /* bookkeeping only */ });
  }
  let scopes: string[] = ['*'];
  try { const p = JSON.parse(String(row.kk_scopes)); if (Array.isArray(p)) scopes = p.map(String); } catch { /* keep default */ }
  const tenantRow: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!k.startsWith('kk_')) tenantRow[k] = v;
  return { status: 'ok', tenant: mapTenantRow(tenantRow), keyId: row.kk_key_id, scopes };
}
