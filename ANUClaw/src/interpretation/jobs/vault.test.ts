import * as crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VaultError, openIdentity, sealIdentity } from './vault';

const KEY = crypto.randomBytes(32).toString('hex');
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = { k: process.env.ANUCLAW_IDENTITY_VAULT_KEY, id: process.env.ANUCLAW_IDENTITY_VAULT_KEY_ID }; process.env.ANUCLAW_IDENTITY_VAULT_KEY = KEY; delete process.env.ANUCLAW_IDENTITY_VAULT_KEY_ID; });
afterEach(() => { for (const [n, v] of [['ANUCLAW_IDENTITY_VAULT_KEY', saved.k], ['ANUCLAW_IDENTITY_VAULT_KEY_ID', saved.id]] as const) { if (v === undefined) delete process.env[n]; else process.env[n] = v; } });

describe('identity vault', () => {
  const identity = { name: 'Synthetic Person', email: 'synthetic@example.invalid' };

  it('round-trips and does not contain the plaintext', () => {
    const { kid, sealed } = sealIdentity('t1', 'job_a', identity);
    expect(Buffer.from(sealed, 'base64').toString('utf8')).not.toContain('Synthetic');
    expect(openIdentity('t1', 'job_a', kid, sealed)).toEqual(identity);
  });

  it('refuses to open under another tenant or job (AAD binding)', () => {
    const { kid, sealed } = sealIdentity('t1', 'job_a', identity);
    expect(() => openIdentity('t2', 'job_a', kid, sealed)).toThrow(VaultError);
    expect(() => openIdentity('t1', 'job_b', kid, sealed)).toThrow(VaultError);
  });

  it('detects tampering and a wrong key', () => {
    const { kid, sealed } = sealIdentity('t1', 'job_a', identity);
    const raw = Buffer.from(sealed, 'base64'); raw[raw.length - 1] ^= 1;
    expect(() => openIdentity('t1', 'job_a', kid, raw.toString('base64'))).toThrow(VaultError);
    process.env.ANUCLAW_IDENTITY_VAULT_KEY = crypto.randomBytes(32).toString('hex');
    expect(() => openIdentity('t1', 'job_a', kid, sealed)).toThrow(VaultError);
  });

  it('fails closed without a valid key', () => {
    for (const bad of ['', 'short', 'z'.repeat(64)]) {
      process.env.ANUCLAW_IDENTITY_VAULT_KEY = bad;
      expect(() => sealIdentity('t1', 'job_a', identity)).toThrow(/not configured/);
    }
  });
});
