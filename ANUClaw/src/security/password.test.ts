import { describe, expect, it } from 'vitest';
import {
  MAX_PASSWORD_LENGTH,
  SCRYPT_TARGET,
  hashPassword,
  legacyHashForTests,
  parseScryptHash,
  verifyPassword,
} from './password';

const PW = 'Synthetic-Pass-42!'; // test-only

describe('hashPassword', () => {
  it('produces the versioned scrypt format with current parameters', async () => {
    const h = await hashPassword(PW);
    expect(h).toMatch(/^scrypt\$1\$15\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(parseScryptHash(h)?.params).toEqual(SCRYPT_TARGET);
  });

  it('uses a random salt per password', async () => {
    const [a, b] = await Promise.all([hashPassword(PW), hashPassword(PW)]);
    expect(a).not.toBe(b);
  });

  it('rejects out-of-bound parameters, empty and over-long passwords', async () => {
    await expect(hashPassword(PW, { log2N: 20, r: 8, p: 1 })).rejects.toThrow(/bounds/);
    await expect(hashPassword(PW, { log2N: 10, r: 8, p: 1 })).rejects.toThrow(/bounds/);
    await expect(hashPassword('')).rejects.toThrow();
    await expect(hashPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1))).rejects.toThrow(/too long/);
  });
});

describe('verifyPassword', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const h = await hashPassword(PW);
    expect(await verifyPassword(PW, h)).toEqual({ ok: true, needsRehash: false, malformed: false });
    expect((await verifyPassword(PW + 'x', h)).ok).toBe(false);
  });

  it('flags outdated (but in-bounds) parameters for rehash only on success', async () => {
    const old = await hashPassword(PW, { log2N: 14, r: 8, p: 1 });
    expect(await verifyPassword(PW, old)).toMatchObject({ ok: true, needsRehash: true });
    expect(await verifyPassword('wrong-password!!', old)).toMatchObject({ ok: false, needsRehash: false });
  });

  it('verifies legacy SHA-256 rows and requests an upgrade', async () => {
    const legacy = legacyHashForTests(PW);
    expect(await verifyPassword(PW, legacy)).toEqual({ ok: true, needsRehash: true, malformed: false });
    expect(await verifyPassword('wrong-password!!', legacy)).toEqual({ ok: false, needsRehash: false, malformed: false });
  });

  it.each([
    ['null', null],
    ['empty', ''],
    ['plaintext', PW],
    ['uppercase hex (not legacy format)', legacyHashForTests(PW).toUpperCase()],
    ['wrong version', 'scrypt$2$15$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['unbounded N', 'scrypt$1$30$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['huge p', 'scrypt$1$15$8$64$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['leading zero param', 'scrypt$1$015$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['short salt', 'scrypt$1$15$8$1$AAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['bad base64', 'scrypt$1$15$8$1$AAAAAAAAAAAAAAAAAAAA+/$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['extra field', 'scrypt$1$15$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA$x'],
  ])('rejects a malformed stored value (%s) without throwing', async (_l, stored) => {
    const r = await verifyPassword(PW, stored as any);
    expect(r.ok).toBe(false);
    expect(r.malformed).toBe(true);
  });

  it('rejects empty and over-long candidate passwords', async () => {
    const h = await hashPassword(PW);
    expect((await verifyPassword('', h)).ok).toBe(false);
    expect((await verifyPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1), h)).ok).toBe(false);
  });
});
