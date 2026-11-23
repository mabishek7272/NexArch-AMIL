/**
 * Webhook signing (interpretation engine, P3c).
 *
 * Header:  Anukla-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>
 *
 * The timestamp is inside the signed text, so a captured request cannot be replayed with a new timestamp, and a
 * receiver that rejects timestamps older than a few minutes (`toleranceSec`) bounds replay of the original. A header may
 * carry several `v1=` values (a receiver accepts if any matches), which lets a sender overlap two secrets during rotation.
 * Receivers must verify against the RAW request body bytes, before any JSON parsing.
 */
import * as crypto from 'crypto';

export const SIGNATURE_HEADER = 'Anukla-Signature';
export const EVENT_ID_HEADER = 'Anukla-Event-Id';
export const EVENT_TYPE_HEADER = 'Anukla-Event-Type';
export const ATTEMPT_HEADER = 'Anukla-Delivery-Attempt';
export const SECRET_PREFIX = 'whsec_';
export const DEFAULT_TOLERANCE_SEC = 300;

export function generateWebhookSecret(): string { return SECRET_PREFIX + crypto.randomBytes(32).toString('hex'); }

function mac(secret: string, timestampSec: number, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`, 'utf8').digest('hex');
}

export function signPayload(secret: string, rawBody: string, timestampSec: number): string {
  return `t=${timestampSec},v1=${mac(secret, timestampSec, rawBody)}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'malformed' | 'stale' | 'mismatch' };

export function verifySignature(secret: string, header: string | undefined, rawBody: string, opts: { toleranceSec?: number; nowMs?: number } = {}): VerifyResult {
  if (typeof header !== 'string' || header.length > 1024) return { ok: false, reason: 'malformed' };
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) return { ok: false, reason: 'malformed' };
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') { if (!/^\d{1,12}$/.test(v)) return { ok: false, reason: 'malformed' }; t = Number(v); }
    else if (k === 'v1') { if (!/^[0-9a-f]{64}$/.test(v)) return { ok: false, reason: 'malformed' }; sigs.push(v); }
  }
  if (t === null || sigs.length === 0) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(mac(secret, t, rawBody), 'hex');
  // Compare against every candidate (no early exit) so timing does not reveal which one matched.
  let match = false;
  for (const s of sigs) { const given = Buffer.from(s, 'hex'); if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) match = true; }
  if (!match) return { ok: false, reason: 'mismatch' };
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - t) > (opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC)) return { ok: false, reason: 'stale' };
  return { ok: true };
}
