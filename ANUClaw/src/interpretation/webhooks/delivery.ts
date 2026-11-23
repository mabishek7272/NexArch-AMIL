/**
 * Webhook delivery (interpretation engine, P3c): claim, send, record, schedule the next attempt.
 *
 * Schedule: the first attempt is immediate; retries follow 1 min, 5 min, 30 min, 2 h and 12 h after the previous
 * failure (six attempts in all). A delivery that would still be pending 24 h after its first attempt is dead, and so is
 * one that has used all its attempts. Anything other than a 2xx counts as a failure, including redirects, which are
 * never followed. Claims use FOR UPDATE SKIP LOCKED and a fenced claim token, exactly like the job queue.
 */
import * as crypto from 'crypto';
import { db } from '../../db';
import { logger } from '../../logger';
import { resolveSafeTarget, type Resolver } from '../../security/ssrf-guard';
import { ATTEMPT_HEADER, EVENT_ID_HEADER, EVENT_TYPE_HEADER, SIGNATURE_HEADER, signPayload } from './signing';
import { WebhookSecretError, openWebhookSecret } from './secret';
import { pinnedPost, type PostResult } from './transport';

export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000] as const;
export const MAX_AGE_MS = 24 * 3_600_000;
export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** Delay before the next attempt after `attemptsMade` failed attempts, or null when the delivery is out of attempts. */
export function nextDelayMs(attemptsMade: number): number | null { return RETRY_DELAYS_MS[attemptsMade - 1] ?? null; }

export interface ClaimedDelivery { id: string; event_id: string; tenant_id: string; job_id: string; event_type: string; payload_json: string; attempts: number; claim_token: string; first_attempt_at: number }

export async function claimNextDelivery(now = Date.now(), leaseMs = LEASE_MS): Promise<ClaimedDelivery | null> {
  const token = crypto.randomBytes(16).toString('hex');
  const rows = await db.query<ClaimedDelivery>(
    `UPDATE webhook_deliveries SET status = 'sending', claim_token = $1, lease_expires_at = $2, attempts = attempts + 1, first_attempt_at = COALESCE(first_attempt_at, $3), updated_at = $3
     WHERE id = (
       SELECT id FROM webhook_deliveries
       WHERE (status = 'pending' AND run_after <= $3) OR (status = 'sending' AND lease_expires_at < $3)
       ORDER BY run_after ASC, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, event_id, tenant_id, job_id, event_type, payload_json, attempts, claim_token, first_attempt_at`,
    [token, now + leaseMs, now]);
  return rows[0] ?? null;
}

export interface DeliveryDeps { resolve?: Resolver; post?: typeof pinnedPost; now?: () => number }
export type DeliveryOutcome = 'delivered' | 'retry' | 'dead' | 'lost';

async function markDelivered(d: ClaimedDelivery, status: number, now: number): Promise<DeliveryOutcome> {
  const r = await db.query(`UPDATE webhook_deliveries SET status = 'delivered', last_status_code = $3, last_error = NULL, claim_token = NULL, lease_expires_at = NULL, delivered_at = $4, updated_at = $4
    WHERE id = $1 AND claim_token = $2 AND status = 'sending' RETURNING id`, [d.id, d.claim_token, status, now]);
  return r.length ? 'delivered' : 'lost';
}

async function markFailed(d: ClaimedDelivery, error: string, status: number | null, forceDead: boolean, now: number): Promise<DeliveryOutcome> {
  const delay = nextDelayMs(d.attempts);
  const dead = forceDead || delay === null || now + delay - Number(d.first_attempt_at) > MAX_AGE_MS;
  const r = dead
    ? await db.query(`UPDATE webhook_deliveries SET status = 'dead', last_status_code = $3, last_error = $4, claim_token = NULL, lease_expires_at = NULL, dead_at = $5, updated_at = $5
        WHERE id = $1 AND claim_token = $2 AND status = 'sending' RETURNING id`, [d.id, d.claim_token, status, error, now])
    : await db.query(`UPDATE webhook_deliveries SET status = 'pending', last_status_code = $3, last_error = $4, run_after = $5, claim_token = NULL, lease_expires_at = NULL, updated_at = $6
        WHERE id = $1 AND claim_token = $2 AND status = 'sending' RETURNING id`, [d.id, d.claim_token, status, error, now + (delay as number), now]);
  return r.length === 0 ? 'lost' : dead ? 'dead' : 'retry';
}

/** One attempt for a claimed delivery. Never throws; the outcome is recorded fenced by the claim token. */
export async function attemptDelivery(d: ClaimedDelivery, deps: DeliveryDeps = {}): Promise<DeliveryOutcome> {
  const now = deps.now ?? (() => Date.now());
  const post = deps.post ?? pinnedPost;
  const wh = await db.queryOne<{ url: string; secret_kid: string; secret_sealed: string; enabled: boolean }>('SELECT url, secret_kid, secret_sealed, enabled FROM tenant_webhooks WHERE tenant_id = $1', [d.tenant_id]);
  if (!wh || !wh.enabled) return markFailed(d, 'webhook_removed', null, true, now());

  let secret: string;
  try { secret = openWebhookSecret(d.tenant_id, wh.secret_kid, wh.secret_sealed); } catch (e) {
    return markFailed(d, e instanceof WebhookSecretError ? e.code : 'secret_unavailable', null, false, now());
  }
  // Re-validated on EVERY attempt: DNS may have changed since registration.
  const g = await resolveSafeTarget(wh.url, deps.resolve);
  if (!g.ok) return markFailed(d, `blocked_${g.reason}`, null, false, now());

  const body = d.payload_json;
  const t = Math.floor(now() / 1000);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', 'User-Agent': 'ANUClaw-Webhook/1',
    [SIGNATURE_HEADER]: signPayload(secret, body, t), [EVENT_ID_HEADER]: d.event_id, [EVENT_TYPE_HEADER]: d.event_type, [ATTEMPT_HEADER]: String(d.attempts),
  };
  let res: PostResult;
  try { res = await post(g.target, headers, body); } catch { res = { statusCode: null, error: 'network_error' }; }
  if (res.statusCode !== null && res.statusCode >= 200 && res.statusCode < 300) return markDelivered(d, res.statusCode, now());
  const code = res.statusCode !== null ? (res.statusCode >= 300 && res.statusCode < 400 ? 'redirect_refused' : `http_${res.statusCode}`) : (res.error ?? 'network_error');
  return markFailed(d, code, res.statusCode, false, now());
}

/** Claims and attempts at most one delivery. Returns null when nothing is due. */
export async function runOnce(deps: DeliveryDeps = {}): Promise<DeliveryOutcome | null> {
  const now = deps.now ?? (() => Date.now());
  const d = await claimNextDelivery(now());
  if (!d) return null;
  try { return await attemptDelivery(d, deps); } catch {
    logger.error(`webhook delivery ${d.id} failed unexpectedly`);
    return markFailed(d, 'worker_error', null, false, now());
  }
}

export interface WebhookWorkerHandle { stop(): Promise<void> }

export function startWebhookWorker(opts: { intervalMs?: number } = {}): WebhookWorkerHandle {
  const interval = opts.intervalMs ?? 2000;
  let stopped = false; let timer: NodeJS.Timeout | undefined; let current: Promise<void> = Promise.resolve();
  const tick = (): void => {
    current = (async () => {
      try { while (!stopped && (await runOnce()) !== null) { /* drain */ } } catch { logger.error('webhook worker tick failed'); }
      if (!stopped) timer = setTimeout(tick, interval);
    })();
  };
  tick();
  return { async stop() { stopped = true; if (timer) clearTimeout(timer); await current; } };
}
