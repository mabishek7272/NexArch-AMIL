/**
 * Password hashing — async scrypt with a random per-password salt
 * (Phase 1 repair; docs/SCAN-2026-11-17.md finding 3).
 *
 * Stored format (versioned, self-describing):
 *
 *   scrypt$1$<log2N>$<r>$<p>$<salt b64url>$<key b64url>
 *
 * Parameters parsed from storage are BOUNDED before use, so a tampered row can't
 * request unbounded CPU/memory. Comparison is constant-time. Anything that does
 * not parse exactly is rejected (never treated as a match, never thrown to callers).
 *
 * Legacy rows (64 lowercase hex = SHA-256 + shared constant salt) still verify,
 * and report `needsRehash` so the login route can upgrade them with
 * compare-and-set after a successful sign-in.
 */
import * as crypto from 'crypto';

export const SCRYPT_VERSION = 1;
/** Current target parameters: N = 2^15, r = 8, p = 1 (≈32 MiB per hash). */
export const SCRYPT_TARGET = { log2N: 15, r: 8, p: 1 } as const;
const BOUNDS = { log2N: [14, 17], r: [8, 16], p: [1, 4] } as const;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** Longest password accepted for hashing (DoS guard; scrypt itself has no limit). */
export const MAX_PASSWORD_LENGTH = 1024;

export interface ScryptParams { log2N: number; r: number; p: number }

export interface VerifyResult {
  ok: boolean;
  /** True when the stored hash is legacy or uses non-current parameters. */
  needsRehash: boolean;
  /** True when the stored value is not a recognised hash format. */
  malformed: boolean;
}

function scryptAsync(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const N = 2 ** params.log2N;
  const maxmem = 128 * N * params.r * params.p * 2; // headroom over the 128·N·r requirement
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_BYTES, { N, r: params.r, p: params.p, maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

function inBounds(p: ScryptParams): boolean {
  return (
    Number.isInteger(p.log2N) && p.log2N >= BOUNDS.log2N[0] && p.log2N <= BOUNDS.log2N[1] &&
    Number.isInteger(p.r) && p.r >= BOUNDS.r[0] && p.r <= BOUNDS.r[1] &&
    Number.isInteger(p.p) && p.p >= BOUNDS.p[0] && p.p <= BOUNDS.p[1]
  );
}

function assertPasswordInput(password: string): void {
  if (typeof password !== 'string' || password.length === 0) throw new Error('Password must be a non-empty string.');
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error('Password is too long.');
}

export async function hashPassword(password: string, params: ScryptParams = SCRYPT_TARGET): Promise<string> {
  assertPasswordInput(password);
  if (!inBounds(params)) throw new Error('scrypt parameters out of bounds');
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, params);
  return ['scrypt', SCRYPT_VERSION, params.log2N, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const INT = /^[1-9][0-9]{0,2}$/;

interface ParsedScrypt { params: ScryptParams; salt: Buffer; key: Buffer }

/** Strict parser. Returns null for anything not exactly in the current format. */
export function parseScryptHash(stored: string): ParsedScrypt | null {
  const parts = stored.split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== String(SCRYPT_VERSION)) return null;
  const [, , n, r, p, saltB64, keyB64] = parts;
  if (!INT.test(n) || !INT.test(r) || !INT.test(p) || !B64URL.test(saltB64) || !B64URL.test(keyB64)) return null;
  const params = { log2N: Number(n), r: Number(r), p: Number(p) };
  if (!inBounds(params)) return null;
  const salt = Buffer.from(saltB64, 'base64url');
  const key = Buffer.from(keyB64, 'base64url');
  if (salt.length !== SALT_BYTES || key.length !== KEY_BYTES) return null;
  return { params, salt, key };
}

const LEGACY_HEX = /^[0-9a-f]{64}$/;

function legacyHash(password: string): Buffer {
  return crypto.createHash('sha256').update(password + 'anuclaw-salt').digest();
}

const FAIL: VerifyResult = { ok: false, needsRehash: false, malformed: false };

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<VerifyResult> {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    await dummyVerify();
    return FAIL;
  }
  if (typeof stored !== 'string' || stored.length === 0) {
    await dummyVerify();
    return { ...FAIL, malformed: true };
  }

  const parsed = parseScryptHash(stored);
  if (parsed) {
    const key = await scryptAsync(password, parsed.salt, parsed.params);
    const ok = crypto.timingSafeEqual(key, parsed.key);
    const current =
      parsed.params.log2N === SCRYPT_TARGET.log2N && parsed.params.r === SCRYPT_TARGET.r && parsed.params.p === SCRYPT_TARGET.p;
    return { ok, needsRehash: ok && !current, malformed: false };
  }

  if (LEGACY_HEX.test(stored)) {
    // Spend comparable time to a scrypt verify so legacy vs. upgraded rows aren't distinguishable by timing.
    await dummyVerify();
    const ok = crypto.timingSafeEqual(legacyHash(password), Buffer.from(stored, 'hex'));
    return { ok, needsRehash: ok, malformed: false };
  }

  await dummyVerify();
  return { ...FAIL, malformed: true };
}

let dummy: Promise<ParsedScrypt> | null = null;

/** Burn one scrypt evaluation at target cost (for unknown users / malformed rows). */
export async function dummyVerify(): Promise<void> {
  dummy ??= (async () => {
    const salt = crypto.randomBytes(SALT_BYTES);
    return { params: { ...SCRYPT_TARGET }, salt, key: await scryptAsync('dummy-password-not-a-credential', salt, SCRYPT_TARGET) };
  })();
  const d = await dummy;
  const key = await scryptAsync('x', d.salt, d.params);
  crypto.timingSafeEqual(key, d.key);
}

/** Test helper: produce a legacy-format hash (to exercise upgrade paths). Never used for storage. */
export function legacyHashForTests(password: string): string {
  return legacyHash(password).toString('hex');
}
