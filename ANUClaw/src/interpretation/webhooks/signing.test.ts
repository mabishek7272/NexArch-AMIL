import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, RETRY_DELAYS_MS, nextDelayMs } from './delivery';
import { generateWebhookSecret, signPayload, verifySignature } from './signing';

const SECRET = 'whsec_' + 'a'.repeat(64);
const BODY = '{"id":"evt_1","type":"interpretation.completed","data":{"jobId":"job_x"}}';
const T = 1_800_000_000;

describe('webhook signing', () => {
  it('signs as t=<unix>,v1=<hex> and verifies', () => {
    const h = signPayload(SECRET, BODY, T);
    expect(h).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(verifySignature(SECRET, h, BODY, { nowMs: T * 1000 })).toEqual({ ok: true });
  });
  it('matches an independently computed HMAC over "t.body" (what a receiver in another language would do)', () => {
    const expected = require('crypto').createHmac('sha256', SECRET).update(`${T}.${BODY}`).digest('hex');
    expect(signPayload(SECRET, BODY, T)).toBe(`t=${T},v1=${expected}`);
  });
  it('rejects a changed body, another secret, and a re-stamped timestamp', () => {
    const h = signPayload(SECRET, BODY, T);
    expect(verifySignature(SECRET, h, BODY.replace('job_x', 'job_y'), { nowMs: T * 1000 })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifySignature('whsec_' + 'b'.repeat(64), h, BODY, { nowMs: T * 1000 })).toEqual({ ok: false, reason: 'mismatch' });
    const restamped = h.replace(`t=${T}`, `t=${T + 100}`); // an attacker refreshing the timestamp of a captured request
    expect(verifySignature(SECRET, restamped, BODY, { nowMs: (T + 100) * 1000 })).toEqual({ ok: false, reason: 'mismatch' });
  });
  it('rejects stale and future timestamps beyond the tolerance, accepts within it', () => {
    const h = signPayload(SECRET, BODY, T);
    expect(verifySignature(SECRET, h, BODY, { nowMs: (T + 301) * 1000 })).toEqual({ ok: false, reason: 'stale' });
    expect(verifySignature(SECRET, h, BODY, { nowMs: (T - 301) * 1000 })).toEqual({ ok: false, reason: 'stale' });
    expect(verifySignature(SECRET, h, BODY, { nowMs: (T + 300) * 1000 })).toEqual({ ok: true });
    expect(verifySignature(SECRET, h, BODY, { nowMs: (T + 3000) * 1000, toleranceSec: 3600 })).toEqual({ ok: true });
  });
  it('rejects malformed headers', () => {
    for (const h of [undefined, '', 'garbage', 't=abc,v1=' + 'a'.repeat(64), `t=${T}`, `v1=${'a'.repeat(64)}`, `t=${T},v1=short`, `t=${T},v1=${'G'.repeat(64)}`, 'x'.repeat(2000)]) {
      expect(verifySignature(SECRET, h as string, BODY, { nowMs: T * 1000 }), String(h).slice(0, 20)).toMatchObject({ ok: false, reason: 'malformed' });
    }
  });
  it('accepts a header carrying several v1 values when any matches (rotation overlap)', () => {
    const good = signPayload(SECRET, BODY, T).split(',v1=')[1];
    expect(verifySignature(SECRET, `t=${T},v1=${'0'.repeat(64)},v1=${good}`, BODY, { nowMs: T * 1000 })).toEqual({ ok: true });
    expect(verifySignature(SECRET, `t=${T},v1=${'0'.repeat(64)},v1=${'1'.repeat(64)}`, BODY, { nowMs: T * 1000 })).toEqual({ ok: false, reason: 'mismatch' });
  });
  it('generates distinct, prefixed, 256-bit secrets', () => {
    const a = generateWebhookSecret(), b = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[0-9a-f]{64}$/); expect(a).not.toBe(b);
  });
});

describe('retry schedule', () => {
  it('retries after 1 min, 5 min, 30 min, 2 h and 12 h, then gives up (six attempts)', () => {
    expect(RETRY_DELAYS_MS).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 43_200_000]);
    expect([1, 2, 3, 4, 5].map(nextDelayMs)).toEqual([...RETRY_DELAYS_MS]);
    expect(nextDelayMs(6)).toBeNull(); expect(nextDelayMs(7)).toBeNull();
    expect(MAX_ATTEMPTS).toBe(6);
  });
  it('the whole schedule fits inside the 24 h cap', () => {
    expect(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThan(24 * 3_600_000);
  });
});
