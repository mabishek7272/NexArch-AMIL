/**
 * Sealing of webhook signing secrets (interpretation engine, P3c): AES-256-GCM with a key that lives only in the
 * environment (`ANUCLAW_WEBHOOK_SECRET_KEY`, 64 hex chars) and is SEPARATE from the identity-vault key, so a leak of
 * one does not open the other. The AAD binds a sealed secret to its tenant and key id. The secret is shown to the
 * tenant once and is never returned by any read endpoint.
 */
import * as crypto from 'crypto';

export class WebhookSecretError extends Error {
  constructor(public readonly code: 'webhook_secret_key_not_configured' | 'webhook_secret_unreadable', message: string) { super(message); }
}

export function currentWebhookKey(): { kid: string; key: Buffer } {
  const hex = process.env.ANUCLAW_WEBHOOK_SECRET_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new WebhookSecretError('webhook_secret_key_not_configured', 'Webhook signing is not configured.');
  const kid = process.env.ANUCLAW_WEBHOOK_SECRET_KEY_ID || 'v1';
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(kid)) throw new WebhookSecretError('webhook_secret_key_not_configured', 'Webhook signing is not configured.');
  return { kid, key: Buffer.from(hex, 'hex') };
}

const aad = (tenantId: string, kid: string) => Buffer.from(`webhook|${tenantId}|${kid}`, 'utf8');

export function sealWebhookSecret(tenantId: string, secret: string): { kid: string; sealed: string } {
  const { kid, key } = currentWebhookKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(tenantId, kid));
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return { kid, sealed: Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') };
}

export function openWebhookSecret(tenantId: string, kid: string, sealed: string): string {
  const { key, kid: current } = currentWebhookKey();
  if (kid !== current) throw new WebhookSecretError('webhook_secret_unreadable', 'Sealed secret uses a key id that is not configured.');
  try {
    const raw = Buffer.from(sealed, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAAD(aad(tenantId, kid));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch { throw new WebhookSecretError('webhook_secret_unreadable', 'Sealed secret could not be opened.'); }
}
