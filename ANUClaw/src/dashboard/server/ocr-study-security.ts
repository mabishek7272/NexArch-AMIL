/**
 * Security controls for the OCR-study routes that need no external infrastructure (study tooling only; synthetic data).
 * Each control is a policy hook with safe production defaults and unchanged local-development behaviour unless the variable says otherwise:
 *
 *  ANUCLAW_STUDY_REAUTH            required | off     default: required when NODE_ENV=production, otherwise off (local behaviour unchanged)
 *  ANUCLAW_STUDY_FRESH_SESSION_SEC integer            default 120: an access token issued within this many seconds counts as a fresh authentication
 *  ANUCLAW_STUDY_REQUIRE_ORIGIN    true | false       default: true in production (cookie-authenticated mutations must carry a same-origin Origin)
 *  ANUCLAW_STUDY_RATE_*            per-minute caps (see RATE_DEFAULTS); counters are IN-PROCESS (not shared across instances — documented residual risk)
 *
 * Re-authentication is a password re-entry (`reauthPassword` in the body, verified against the stored scrypt hash, never logged or echoed). It is NOT
 * MFA and NOT SSO; those need identity infrastructure (see the threat model).
 */
import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest } from './auth';
import { db } from '../../db';
import { MAX_PASSWORD_LENGTH, verifyPassword } from '../../security/password';
import { auditStudy } from './ocr-study-access';

const prod = () => process.env.NODE_ENV === 'production';
export const reauthRequired = () => (process.env.ANUCLAW_STUDY_REAUTH ?? (prod() ? 'required' : 'off')) === 'required';
export const freshSeconds = () => { const n = Number(process.env.ANUCLAW_STUDY_FRESH_SESSION_SEC ?? 120); return Number.isFinite(n) && n >= 0 ? n : 120; };
const originRequired = () => (process.env.ANUCLAW_STUDY_REQUIRE_ORIGIN ?? (prod() ? 'true' : 'false')) === 'true';

export const SENSITIVE_ACTIONS = ['authorize_unlock', 'execute_unlock', 'member_change', 'export_report', 'configure_severity', 'edit_policy', 'policy_review'] as const;
export type SensitiveAction = typeof SENSITIVE_ACTIONS[number];
export const policySummary = () => ({ reauth: { required: reauthRequired(), freshSessionSeconds: freshSeconds(), method: 'password re-entry (not MFA)', appliesTo: SENSITIVE_ACTIONS }, originCheck: { requiredForCookieMutations: originRequired() }, limits: LIMITS, rateLimits: rates() });

/** Sensitive actions need a fresh session OR a correct `reauthPassword`. Returns true when the request may proceed; otherwise it has answered. */
export async function requireFreshAuth(req: AuthRequest, res: Response, action: SensitiveAction, wsId: string): Promise<boolean> {
  if (!reauthRequired()) return true;
  const token = (req.cookies?.dash_token as string | undefined) ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);
  const iat = token ? Number((jwt.decode(token) as { iat?: number } | null)?.iat) : NaN;
  const age = Number.isFinite(iat) ? Math.floor(Date.now() / 1000) - iat : Infinity;
  if (age < freshSeconds()) return true;
  const pw = req.body?.reauthPassword;
  if (typeof pw === 'string' && pw.length > 0 && pw.length <= MAX_PASSWORD_LENGTH) {
    const row = await db.queryOne<{ password_hash: string | null }>('SELECT password_hash FROM dash_users WHERE id = $1', [req.user!.id]);
    if (row && (await verifyPassword(pw, row.password_hash)).ok) { delete req.body.reauthPassword; return true; }
    await auditStudy(req.user!.id, 'security.reauth_failed', wsId, { policy: action, ageSeconds: Number.isFinite(age) ? age : -1 });
    res.status(401).json({ error: 'Re-authentication failed.', code: 'reauth_failed' }); return false;
  }
  await auditStudy(req.user!.id, 'security.reauth_required', wsId, { policy: action, ageSeconds: Number.isFinite(age) ? age : -1 });
  res.status(401).json({ error: `This action needs a fresh sign-in or your password in "reauthPassword" (session age ${Number.isFinite(age) ? age + 's' : 'unknown'}, limit ${freshSeconds()}s).`, code: 'reauth_required', policy: action }); return false;
}

// ── CSRF / origin ────────────────────────────────────────────────────────────
/**
 * Dashboard cookies are SameSite=Lax and every mutation here is JSON (a cross-site HTML form cannot send application/json). Additional defence:
 * reject a mutation whose Origin does not match this host, whose Sec-Fetch-Site says cross-site, or whose content type is not JSON. In production a
 * cookie-authenticated mutation must carry a matching Origin. Bearer-token requests are not cookie-ambient, so they are exempt from the Origin rule.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
  const deny = (why: string) => { res.status(403).json({ error: 'Cross-site or malformed request refused.', code: 'csrf_refused', reason: why }); };
  const viaCookie = Boolean(req.cookies?.dash_token) && !req.headers.authorization;
  const site = String(req.headers['sec-fetch-site'] ?? ''); if (site === 'cross-site') { deny('sec-fetch-site'); return; }
  const origin = req.headers.origin; const host = req.headers.host;
  if (origin !== undefined) { let h = ''; try { h = new URL(String(origin)).host; } catch { /* invalid */ } if (!host || h !== host) { deny('origin'); return; } }
  else if (viaCookie && originRequired() && site !== 'same-origin') { deny('origin_missing'); return; }
  const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || Boolean(req.headers['transfer-encoding']); const ct = String(req.headers['content-type'] ?? '');
  if (hasBody && !/^application\/json\b/i.test(ct)) { deny('content_type'); return; }
  next();
}

// ── security headers (this API only returns JSON or attachments) ─────────────
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cross-Origin-Opener-Policy': 'same-origin' });
  next();
}

// ── size / shape limits ─────────────────────────────────────────────────────
export const LIMITS = { maxBodyBytes: 4_000_000, maxSources: 50, maxSourceBytes: 1_048_576, maxTotalSourceBytes: 3_000_000, maxAnnotationItems: 5000, maxResultDocuments: 500, maxResultCandidates: 20000, maxJsonDepth: 12, maxPageSize: 200, defaultPageSize: 100, maxReasonChars: 1000 } as const;
export function jsonDepth(v: unknown, cap = LIMITS.maxJsonDepth + 2, d = 0): number { if (d > cap) return d; if (!v || typeof v !== 'object') return d; let m = d; for (const x of Object.values(v as object)) { m = Math.max(m, jsonDepth(x, cap, d + 1)); if (m > cap) return m; } return m; }
export function depthGuard(req: Request, res: Response, next: NextFunction): void { if (req.body && jsonDepth(req.body) > LIMITS.maxJsonDepth) { res.status(400).json({ error: `JSON nesting deeper than ${LIMITS.maxJsonDepth} is refused.`, code: 'too_deep' }); return; } next(); }
export function page(req: Request): { limit: number; offset: number } {
  const l = Number(req.query.limit ?? LIMITS.defaultPageSize), o = Number(req.query.offset ?? 0);
  return { limit: Number.isInteger(l) && l >= 1 ? Math.min(l, LIMITS.maxPageSize) : LIMITS.defaultPageSize, offset: Number.isInteger(o) && o >= 0 ? Math.min(o, 1_000_000) : 0 };
}
/** Refuses archive/executable/compressed content even when the declared media type claims it is text, PDF or an image. */
export function sniffForbidden(b: Buffer): string | null {
  const m = (...bytes: number[]) => bytes.every((x, i) => b[i] === x);
  if (m(0x50, 0x4b, 0x03, 0x04) || m(0x50, 0x4b, 0x05, 0x06) || m(0x50, 0x4b, 0x07, 0x08)) return 'zip archive';
  if (m(0x1f, 0x8b)) return 'gzip';
  if (m(0x42, 0x5a, 0x68)) return 'bzip2';
  if (m(0x37, 0x7a, 0xbc, 0xaf)) return '7z archive';
  if (m(0x52, 0x61, 0x72, 0x21)) return 'rar archive';
  if (m(0xfd, 0x37, 0x7a, 0x58, 0x5a)) return 'xz';
  if (m(0x7f, 0x45, 0x4c, 0x46) || m(0x4d, 0x5a) || m(0xcf, 0xfa, 0xed, 0xfe)) return 'executable';
  if (b.subarray(257, 262).toString('latin1') === 'ustar') return 'tar archive';
  return null;
}

// ── rate limits (in-process fixed window per user and bucket) ───────────────
export const RATE_DEFAULTS = { sensitive: 20, expensive: 10, upload: 20, general: 600 } as const;
type Bucket = keyof typeof RATE_DEFAULTS;
const rates = () => Object.fromEntries((Object.keys(RATE_DEFAULTS) as Bucket[]).map((b) => { const n = Number(process.env[`ANUCLAW_STUDY_RATE_${b.toUpperCase()}`]); return [b, Number.isInteger(n) && n > 0 ? n : RATE_DEFAULTS[b]]; })) as Record<Bucket, number>;
const windows = new Map<string, { start: number; n: number }>();
export function resetRateLimits(): void { windows.clear(); }
export function rateLimit(bucket: Bucket) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const cap = rates()[bucket]; const key = `${bucket}|${req.user!.id}`; const now = Date.now(); let w = windows.get(key);
    if (!w || now - w.start >= 60_000) { w = { start: now, n: 0 }; windows.set(key, w); }
    if (++w.n > cap) {
      const retry = Math.max(1, Math.ceil((w.start + 60_000 - now) / 1000)); res.set('Retry-After', String(retry));
      try { await auditStudy(req.user!.id, 'security.rate_limited', /^w-[0-9a-f]{12}$/.test(String(req.params.id)) ? String(req.params.id) : 'invalid', { bucket, limit: cap }); } catch { /* never block the refusal */ }
      res.status(429).json({ error: 'Too many requests for this operation; slow down.', code: 'rate_limited', bucket, retryAfterSeconds: retry }); return;
    }
    next();
  };
}
