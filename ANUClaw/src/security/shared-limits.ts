/**
 * Shared-store limits in PostgreSQL (plan F16) — correct across processes.
 *   - rate: atomic upsert of a per-key fixed window
 *   - concurrency: expiring leases; acquisition serialised per key with an advisory lock
 *   - monthly quota: one atomic UPDATE that reserves a call only while under quota
 *     (and rolls the month over), so concurrent requests can never exceed it
 */
import * as crypto from 'crypto';
import { db } from '../db';

export async function pgRateHit(key: string, limit: number, windowMs: number, now = Date.now()) {
  const windowStart = now - (now % windowMs);
  const r = await db.query<{ count: number }>(
    `INSERT INTO rate_counters (key, window_start, count) VALUES ($1, $2, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_counters.count + 1
     RETURNING count`, [key, windowStart]);
  const count = Number(r[0].count);
  if (Math.random() < 0.01) void db.query('DELETE FROM rate_counters WHERE window_start < $1', [windowStart - windowMs]).catch(() => {});
  return { allowed: count <= limit, count, retryAfterSec: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)) };
}

export async function pgAcquireLease(key: string, max: number, ttlMs: number): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lease:${key}`]);
    const now = Date.now();
    await tx.query('DELETE FROM run_leases WHERE key = $1 AND expires_at <= $2', [key, now]);
    const c = await tx.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM run_leases WHERE key = $1', [key]);
    if (c.rows[0].n >= max) return null;
    const id = crypto.randomUUID();
    await tx.query('INSERT INTO run_leases (id, key, expires_at) VALUES ($1, $2, $3)', [id, key, now + ttlMs]);
    return id;
  });
}

export async function pgReleaseLease(id: string): Promise<void> {
  await db.query('DELETE FROM run_leases WHERE id = $1', [id]);
}

export function currentMonth(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

/** Atomically reserve one call against the monthly quota. Returns null when exhausted. */
export async function pgReserveQuota(tenantId: string, quota: number | null, month = currentMonth()): Promise<number | null> {
  const r = await db.query<{ usage_this_month: number }>(
    `UPDATE tenants
        SET usage_this_month = CASE WHEN usage_month = $2 THEN usage_this_month + 1 ELSE 1 END,
            usage_month = $2,
            usage_total = usage_total + 1,
            last_active_at = $4
      WHERE tenant_id = $1
        AND ($3::int IS NULL OR (CASE WHEN usage_month = $2 THEN usage_this_month ELSE 0 END) < $3::int)
      RETURNING usage_this_month`,
    [tenantId, month, quota, new Date().toISOString()]);
  return r.length ? Number(r[0].usage_this_month) : null;
}
