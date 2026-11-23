/**
 * Tenant-scoped, tamper-evident audit for tenant, key and plan changes (interpretation engine, P1).
 *
 * Reuses the existing durable per-tenant hash chain (`PostgresPerTenantAuditLog`, table `cds_audit_log_mt`:
 * one independent chain per tenant, append-only enforced by a database trigger) rather than adding a second
 * audit mechanism.
 *
 * Every entry is written INSIDE the same database transaction as the change it describes, so either both
 * commit or neither does: no tenant/key/plan change can exist without its audit entry, and a failed audit
 * write rolls the change back. A per-tenant advisory lock serialises writers so two simultaneous actions on
 * one tenant cannot race for the same chain position.
 *
 * Payloads never contain key material; a payload that does is rejected (programming error, fail closed).
 */
import { db, TxClient } from '../../db';
import { PostgresPerTenantAuditLog, ensureTenantAuditSchema } from '../../cds/audit/postgres-tenant';
import type { PgPoolLike } from '../../cds/audit/postgres-sink';
import { verifyChain } from '../../cds/audit/hash-chain';
import type { AuditEntry, ChainVerification } from '../../cds/audit/types';

/** Who performed an admin action. The admin API key proves "an admin", not which one, so a name is only declared. */
export interface AuditCtx {
  actor: string;
  /** Free-text label sent by the caller (X-Admin-Actor). UNVERIFIED — recorded as a claim, never as identity. */
  declaredActor: string | null;
  requestId: string | null;
}

const KEY_MATERIAL_RE = /amgi_live_[0-9a-f]{16,}/i;

let schemaReady: Promise<void> | null = null;

/** Creates the audit table + append-only trigger once per process (idempotent, advisory-locked across processes). */
export function ensureTenantAuditReady(): Promise<void> {
  if (!schemaReady) {
    schemaReady = db.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('anuclaw:cds_audit_log_mt:ddl'))`);
      await ensureTenantAuditSchema(asPool(tx));
    }).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

/** Test hook: forget that the schema was ensured (a fresh database per test file). */
export function resetTenantAuditForTests(): void { schemaReady = null; }

function asPool(tx: TxClient): PgPoolLike {
  return { query: (text, params) => tx.query(text, params as any[]) as ReturnType<PgPoolLike['query']> };
}

export function withContext(ctx: AuditCtx, data: Record<string, unknown>): Record<string, unknown> {
  return { ...data, declared_actor: ctx.declaredActor, request_id: ctx.requestId };
}

/** Appends one entry to the tenant's chain inside `tx`. Call `ensureTenantAuditReady()` before opening the transaction. */
export async function recordTenantEvent(
  tx: TxClient, tenantId: string, ctx: AuditCtx, eventType: string, data: Record<string, unknown>,
): Promise<AuditEntry> {
  const payload = withContext(ctx, data);
  if (KEY_MATERIAL_RE.test(JSON.stringify(payload))) {
    throw new Error('Refusing to write an audit entry that contains API key material.');
  }
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`anuclaw:tenant-audit:${tenantId}`]);
  return new PostgresPerTenantAuditLog(asPool(tx)).record(tenantId, { actor: ctx.actor, event_type: eventType, payload });
}

/** One tenant's entries plus a fresh verification of its chain. Never returns another tenant's entries. */
export async function readTenantAudit(tenantId: string): Promise<{ entries: AuditEntry[]; verification: ChainVerification }> {
  await ensureTenantAuditReady();
  const rows = await db.query(
    `SELECT seq, "timestamp", actor, event_type, payload, prev_hash, entry_hash FROM cds_audit_log_mt WHERE tenant_id = $1 ORDER BY seq ASC`,
    [tenantId]);
  const entries: AuditEntry[] = rows.map((r: any) => ({
    seq: Number(r.seq), timestamp: String(r.timestamp), actor: String(r.actor), event_type: String(r.event_type),
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload, prev_hash: String(r.prev_hash), entry_hash: String(r.entry_hash),
  }));
  return { entries, verification: verifyChain(entries) };
}
