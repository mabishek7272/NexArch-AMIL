/**
 * Per-tenant webhook configuration (interpretation engine, P3c). The URL is validated by the SSRF guard at registration
 * (and again on every delivery); the signing secret is generated here, stored sealed, and returned to the tenant
 * exactly once (at first registration, or when rotated). Every change is audited in the same transaction, recording
 * the host and key id only, never the secret or the full URL.
 */
import { db } from '../../db';
import { resolveSafeTarget, type Resolver } from '../../security/ssrf-guard';
import { TenancyError } from '../tenancy/keys';
import { AuditCtx, ensureTenantAuditReady, recordTenantEvent } from '../tenancy/audit';
import { WebhookSecretError, sealWebhookSecret } from './secret';
import { generateWebhookSecret } from './signing';

export interface WebhookView { configured: boolean; url: string | null; enabled: boolean; createdAt: number | null; updatedAt: number | null; secretRotatedAt: number | null; secretKeyId: string | null }

export async function getWebhook(tenantId: string): Promise<WebhookView> {
  const r = await db.queryOne('SELECT url, enabled, created_at, updated_at, secret_rotated_at, secret_kid FROM tenant_webhooks WHERE tenant_id = $1', [tenantId]);
  if (!r) return { configured: false, url: null, enabled: false, createdAt: null, updatedAt: null, secretRotatedAt: null, secretKeyId: null };
  return { configured: true, url: r.url, enabled: !!r.enabled, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), secretRotatedAt: Number(r.secret_rotated_at), secretKeyId: r.secret_kid };
}

function sealOrThrow(tenantId: string, secret: string): { kid: string; sealed: string } {
  try { return sealWebhookSecret(tenantId, secret); } catch (e) {
    if (e instanceof WebhookSecretError) throw new TenancyError(503, 'webhook_signing_unavailable', 'Webhook signing is not configured on this server; ask the platform administrator.');
    throw e;
  }
}

async function validateUrl(url: unknown, resolve?: Resolver): Promise<string> {
  const g = await resolveSafeTarget(url, resolve);
  if (!g.ok) throw new TenancyError(400, 'webhook_url_rejected', 'The webhook URL is not allowed.', { reason: g.reason });
  return g.target.url.toString();
}

/** Registers or updates the tenant's endpoint. `signingSecret` is present only when a new secret was created. */
export async function registerWebhook(tenantId: string, url: unknown, ctx: AuditCtx, opts: { resolve?: Resolver; now?: number } = {}): Promise<{ url: string; signingSecret?: string; created: boolean }> {
  const clean = await validateUrl(url, opts.resolve);
  const host = new URL(clean).host;
  const now = opts.now ?? Date.now();
  await ensureTenantAuditReady();
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`anuclaw:webhook:${tenantId}`]);
    const existing = await tx.query('SELECT secret_kid FROM tenant_webhooks WHERE tenant_id = $1', [tenantId]);
    let secret: string | undefined; let kid: string;
    if (existing.rows.length) {
      kid = existing.rows[0].secret_kid;
      await tx.query('UPDATE tenant_webhooks SET url = $2, enabled = TRUE, updated_at = $3 WHERE tenant_id = $1', [tenantId, clean, now]);
    } else {
      secret = generateWebhookSecret();
      const s = sealOrThrow(tenantId, secret); kid = s.kid;
      await tx.query(`INSERT INTO tenant_webhooks (tenant_id, url, secret_kid, secret_sealed, enabled, created_at, updated_at, secret_rotated_at) VALUES ($1,$2,$3,$4,TRUE,$5,$5,$5)`, [tenantId, clean, s.kid, s.sealed, now]);
    }
    await tx.query('UPDATE tenants SET webhook_url = $2 WHERE tenant_id = $1', [tenantId, clean]); // kept for GET /account
    await recordTenantEvent(tx, tenantId, ctx, 'webhook.registered', { host, secret_kid: kid, created: !existing.rows.length });
    return { url: clean, created: !existing.rows.length, ...(secret ? { signingSecret: secret } : {}) };
  });
}

export async function rotateWebhookSecret(tenantId: string, ctx: AuditCtx, now = Date.now()): Promise<{ signingSecret: string }> {
  await ensureTenantAuditReady();
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`anuclaw:webhook:${tenantId}`]);
    const existing = await tx.query('SELECT 1 FROM tenant_webhooks WHERE tenant_id = $1', [tenantId]);
    if (!existing.rows.length) throw new TenancyError(404, 'webhook_not_configured', 'No webhook is registered.');
    const secret = generateWebhookSecret();
    const s = sealOrThrow(tenantId, secret);
    await tx.query('UPDATE tenant_webhooks SET secret_kid = $2, secret_sealed = $3, secret_rotated_at = $4, updated_at = $4 WHERE tenant_id = $1', [tenantId, s.kid, s.sealed, now]);
    await recordTenantEvent(tx, tenantId, ctx, 'webhook.secret_rotated', { secret_kid: s.kid });
    return { signingSecret: secret };
  });
}

export async function removeWebhook(tenantId: string, ctx: AuditCtx): Promise<void> {
  await ensureTenantAuditReady();
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`anuclaw:webhook:${tenantId}`]);
    const del = await tx.query('DELETE FROM tenant_webhooks WHERE tenant_id = $1', [tenantId]);
    if (!del.rowCount) throw new TenancyError(404, 'webhook_not_configured', 'No webhook is registered.');
    await tx.query('UPDATE tenants SET webhook_url = NULL WHERE tenant_id = $1', [tenantId]);
    // Anything still waiting would have nowhere to go; the delivery worker also marks these dead if it meets one.
    await tx.query(`UPDATE webhook_deliveries SET status = 'dead', last_error = 'webhook_removed', dead_at = $2, updated_at = $2, claim_token = NULL WHERE tenant_id = $1 AND status = 'pending'`, [tenantId, Date.now()]);
    await recordTenantEvent(tx, tenantId, ctx, 'webhook.removed', {});
  });
}
