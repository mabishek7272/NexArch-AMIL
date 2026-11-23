/**
 * Identity vault encryption (interpretation engine, P3a). Direct identifiers are sealed with AES-256-GCM using a key
 * that lives only in the environment (`ANUCLAW_IDENTITY_VAULT_KEY`, 64 hex chars) and is separate from every other
 * secret. The additional authenticated data binds a ciphertext to its tenant, job and key id, so a sealed blob cannot
 * be moved to another tenant's row and still open. Fail closed: with no valid key, identity-bearing requests are
 * refused rather than stored in the clear.
 */
import * as crypto from 'crypto';

export class VaultError extends Error {
  constructor(public readonly code: 'vault_not_configured' | 'vault_open_failed', message: string) { super(message); }
}

export interface VaultKey { kid: string; key: Buffer }

export function currentVaultKey(): VaultKey {
  const hex = process.env.ANUCLAW_IDENTITY_VAULT_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new VaultError('vault_not_configured', 'Identity storage is not configured.');
  const kid = process.env.ANUCLAW_IDENTITY_VAULT_KEY_ID || 'v1';
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(kid)) throw new VaultError('vault_not_configured', 'Identity storage is not configured.');
  return { kid, key: Buffer.from(hex, 'hex') };
}

function aad(tenantId: string, jobId: string, kid: string): Buffer { return Buffer.from(`${tenantId}|${jobId}|${kid}`, 'utf8'); }

export function sealIdentity(tenantId: string, jobId: string, identity: Record<string, unknown>): { kid: string; sealed: string } {
  const { kid, key } = currentVaultKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(tenantId, jobId, kid));
  const ct = Buffer.concat([c.update(JSON.stringify(identity), 'utf8'), c.final()]);
  return { kid, sealed: Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') };
}

export function openIdentity(tenantId: string, jobId: string, kid: string, sealed: string): Record<string, unknown> {
  const { key, kid: current } = currentVaultKey();
  if (kid !== current) throw new VaultError('vault_open_failed', 'Sealed identity uses a key id that is not configured.');
  try {
    const raw = Buffer.from(sealed, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAAD(aad(tenantId, jobId, kid));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
  } catch { throw new VaultError('vault_open_failed', 'Sealed identity could not be opened.'); }
}
