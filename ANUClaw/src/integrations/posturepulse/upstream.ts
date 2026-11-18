/**
 * Trusted-upstream access and provenance verification for PosturePulse (plan §9.1).
 *
 * A caller-supplied report/consent/signOff is NEVER evidence of a clinical
 * release. Release is established only by:
 *   (a) fetching the report, consent record and session from the CONFIGURED
 *       upstream (ANUCLAW_POSTUREPULSE_URL — never taken from a request), or
 *   (b) a signed import bundle verified with a configured shared secret
 *       (ANUCLAW_POSTUREPULSE_IMPORT_SECRET; the signer must hold it).
 * Both paths then verify: session↔subject↔consent binding, consent state and
 * timestamps, sign-off timestamps, and signOff.contentSha256 recomputed with the
 * upstream's own canonicalisation (services/backend-api/src/reports/canonical-json.ts).
 *
 * Outbound requests: only to the configured origin; https required (plain http is
 * allowed only for loopback outside production); no redirects are followed (so
 * bearer tokens cannot be forwarded elsewhere); link-local/metadata and private
 * ranges are refused unless ANUCLAW_POSTUREPULSE_ALLOW_PRIVATE=true; ids are
 * pattern-checked before being placed in a path. DNS-rebinding is not mitigated
 * (the origin is operator-configured, not user-supplied).
 */
import * as crypto from 'crypto';
import axios from 'axios';

// ── canonicalisation (identical algorithm to the upstream) ───────────────────

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}
/** sha256 over canonical JSON of the report body with signOff.contentSha256 left out. */
export function reportContentSha256(body: Record<string, unknown>): string {
  const signOff = body.signOff as Record<string, unknown> | null | undefined;
  let hashed: Record<string, unknown> = body;
  if (signOff && typeof signOff === 'object') {
    const { contentSha256: _d, ...rest } = signOff;
    hashed = { ...body, signOff: rest };
  }
  return crypto.createHash('sha256').update(canonicalJson(hashed)).digest('hex');
}

// ── upstream configuration ───────────────────────────────────────────────────

export interface UpstreamConfig { origin: string }
export class UpstreamConfigError extends Error { constructor(m: string) { super(m); this.name = 'UpstreamConfigError'; } }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|fc|fd|fe80)/i;

export function upstreamConfig(env: NodeJS.ProcessEnv = process.env): UpstreamConfig {
  const raw = (env.ANUCLAW_POSTUREPULSE_URL ?? '').trim();
  if (!raw) throw new UpstreamConfigError('ANUCLAW_POSTUREPULSE_URL is not configured.');
  let u: URL;
  try { u = new URL(raw); } catch { throw new UpstreamConfigError('ANUCLAW_POSTUREPULSE_URL is not a valid URL.'); }
  if (u.username || u.password) throw new UpstreamConfigError('Credentials in the upstream URL are not allowed.');
  if (u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new UpstreamConfigError('Upstream must be an origin only (no path, query or fragment).');
  const host = u.hostname.toLowerCase();
  const loopback = LOOPBACK.has(host);
  const production = (env.NODE_ENV ?? '').toLowerCase() === 'production';
  if (u.protocol === 'http:') {
    if (!loopback || production) throw new UpstreamConfigError('Plain http is allowed only for loopback outside production.');
  } else if (u.protocol !== 'https:') {
    throw new UpstreamConfigError('Upstream must use https.');
  }
  if (!loopback && PRIVATE.test(host) && env.ANUCLAW_POSTUREPULSE_ALLOW_PRIVATE !== 'true') {
    throw new UpstreamConfigError('Private/link-local upstream addresses require ANUCLAW_POSTUREPULSE_ALLOW_PRIVATE=true.');
  }
  return { origin: u.origin };
}

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
export const isSafeId = (s: unknown): s is string => typeof s === 'string' && ID.test(s);

// ── time rules ───────────────────────────────────────────────────────────────

export interface TimeRules { now: Date; clockSkewMs: number; consentMaxAgeDays: number; signOffMaxAgeDays: number }
export function timeRules(env: NodeJS.ProcessEnv = process.env, now = new Date()): TimeRules {
  const n = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    now,
    clockSkewMs: n(env.ANUCLAW_POSTUREPULSE_CLOCK_SKEW_SEC, 300) * 1000,
    // Engineering defaults pending a policy decision by the responsible clinical/privacy owners.
    consentMaxAgeDays: n(env.ANUCLAW_POSTUREPULSE_CONSENT_MAX_AGE_DAYS, 730),
    signOffMaxAgeDays: n(env.ANUCLAW_POSTUREPULSE_SIGNOFF_MAX_AGE_DAYS, 730),
  };
}

const t = (s: unknown): number => (typeof s === 'string' ? Date.parse(s) : NaN);
const DAY = 86_400_000;

/** Explicit, deterministic timestamp rules. Returns violated-rule codes (empty = ok). */
export function timestampViolations(consent: any, session: any, report: any, rules: TimeRules): string[] {
  const v: string[] = [];
  const now = rules.now.getTime();
  const future = (ms: number) => ms > now + rules.clockSkewMs;
  const granted = t(consent?.grantedAt), created = t(session?.createdAt), signed = t(report?.signOff?.signedAt);
  if (Number.isNaN(granted)) v.push('consent_granted_at_invalid');
  else {
    if (future(granted)) v.push('consent_granted_in_future');
    if (now - granted > rules.consentMaxAgeDays * DAY) v.push('consent_expired');
  }
  for (const k of ['revokedAt', 'withdrawalRequestedAt'] as const) {
    if (consent?.[k] !== null && consent?.[k] !== undefined) v.push(k === 'revokedAt' ? 'consent_revoked' : 'consent_withdrawal_requested');
  }
  if (Number.isNaN(created)) v.push('session_created_at_invalid');
  else if (!Number.isNaN(granted) && granted > created + rules.clockSkewMs) v.push('consent_granted_after_session_start');
  if (Number.isNaN(signed)) v.push('sign_off_signed_at_invalid');
  else {
    if (future(signed)) v.push('sign_off_in_future');
    if (now - signed > rules.signOffMaxAgeDays * DAY) v.push('sign_off_expired');
    if (!Number.isNaN(created) && signed < created - rules.clockSkewMs) v.push('sign_off_before_session_start');
  }
  return v;
}

// ── provenance verification (shared by both trusted paths) ───────────────────

/**
 * `digestOnly` is for SIGNED BUNDLES whose report is the subject-authorised view: rows the clinician withheld are deliberately
 * not in the bundle, so `signOff.contentSha256` (computed over the full body) cannot be recomputed from it. Authenticity then rests
 * on the bundle signature, which covers the digest as a claim; the digest must still be present and well-formed.
 */
export function bindingViolations(consent: any, session: any, report: any, opts: { digestOnly?: boolean } = {}): string[] {
  const v: string[] = [];
  const sessionId = session?.sessionId ?? session?.id;
  if (!sessionId || sessionId !== report?.sessionId) v.push('session_report_mismatch');
  if (!session?.subjectPseudoId || session.subjectPseudoId !== consent?.subjectPseudoId) v.push('session_consent_subject_mismatch');
  if (!session?.consentRecordId || session.consentRecordId !== consent?.consentRecordId) v.push('session_consent_record_mismatch');
  if (report?.status !== 'released' || !report?.signOff) v.push('report_not_released');
  else {
    const digest = report.signOff.contentSha256;
    if (opts.digestOnly) { if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) v.push('content_hash_malformed'); }
    else if (typeof digest !== 'string' || reportContentSha256(report) !== digest) v.push('content_hash_mismatch');
  }
  return v;
}

// ── signed import bundles (path b) ───────────────────────────────────────────

/** `viewSha256` = sha256(canonicalJson(report)) of the report AS EXPORTED (the authorised view), so it can be recomputed here independently of the sign-off digest. */
export interface BundleView { kind: 'subject_authorized'; rowsWithheld: number; viewSha256?: string }

/** How `signOff.contentSha256` was established. Only 'recomputed' means this system re-derived it. */
export type DigestStatus = 'recomputed_full_body' | 'upstream_signed_claim_not_recomputable';
export const viewSha256 = (report: unknown): string => crypto.createHash('sha256').update(canonicalJson(report)).digest('hex');
export interface SignedBundle {
  payload: {
    consentRecord: any; session: any; report: any; symptomReports?: any[]; issuedAt: string; issuer: string;
    /** Identifies which secret signed (rotation). Non-secret. */
    keyId?: string;
    /** Unique per bundle (audit/replay evidence). */
    bundleId?: string;
    /** 'hmac-sha256/shared-secret': whoever can verify can also forge; this is service attribution, NOT independent clinician attribution. */
    signatureScheme?: string;
    /** What the report is: the subject-authorised view, with how many withheld rows it omits. */
    view?: BundleView;
  };
  signature: string;
}

export function signBundle(payload: SignedBundle['payload'], secret: string): SignedBundle {
  return { payload, signature: crypto.createHmac('sha256', secret).update(canonicalJson(payload)).digest('hex') };
}

const KEY_ID = /^[A-Za-z0-9_.-]{1,64}$/;
/** ANUCLAW_POSTUREPULSE_IMPORT_KEYS = JSON object { keyId: secret } (each secret >= 32 chars); null when absent/invalid. */
export function parseKeyring(raw: string | undefined): Record<string, string> | null {
  if (!raw?.trim()) return null;
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    for (const [k, v] of Object.entries(o)) if (!KEY_ID.test(k) || typeof v !== 'string' || v.length < 32) return null;
    return o as Record<string, string>;
  } catch { return null; }
}

export function verifyBundle(bundle: any, secret: string | undefined, now = new Date(), maxAgeSec = 3600, keys: Record<string, string> | null = null): { ok: true; payload: SignedBundle['payload'] } | { ok: false; reason: string } {
  if (!bundle || typeof bundle.signature !== 'string' || !/^[0-9a-f]{64}$/.test(bundle.signature) || !bundle.payload) return { ok: false, reason: 'bundle_malformed' };
  const keyId = bundle.payload.keyId;
  let useSecret = secret;
  if (keyId !== undefined) {
    if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) return { ok: false, reason: 'bundle_malformed' };
    if (keys) { useSecret = keys[keyId]; if (!useSecret) return { ok: false, reason: 'unknown_key_id' }; }
  }
  if (!useSecret || useSecret.length < 32) return { ok: false, reason: 'import_secret_not_configured' };
  const expected = crypto.createHmac('sha256', useSecret).update(canonicalJson(bundle.payload)).digest();
  const given = Buffer.from(bundle.signature, 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' };
  const issued = t(bundle.payload.issuedAt);
  if (Number.isNaN(issued) || Math.abs(now.getTime() - issued) > maxAgeSec * 1000) return { ok: false, reason: 'bundle_not_fresh' };
  return { ok: true, payload: bundle.payload };
}

// ── trusted fetch (path a) ───────────────────────────────────────────────────

export type FetchFailure = 'not_configured' | 'invalid_id' | 'unauthorized' | 'pending_review' | 'not_found' | 'unavailable' | 'redirect_refused';

async function get(origin: string, path: string, token: string | undefined): Promise<{ status: number; data: any } | 'unavailable' | 'redirect_refused'> {
  try {
    const r = await axios.get(`${origin}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      timeout: 15_000, maxRedirects: 0, validateStatus: () => true, maxContentLength: 5_000_000, proxy: false,
    });
    if (r.status >= 300 && r.status < 400) return 'redirect_refused';
    return { status: r.status, data: r.data };
  } catch { return 'unavailable'; }
}

/**
 * `report` is the view served to the subject: the upstream drops rows a clinician WITHDREW (`excluded`) from it, while the
 * stored body — and `signOff.contentSha256`, computed over it — keeps them. When the subject view does not hash to the sign-off
 * digest, `fullReport` carries the clinician's complete body so the hash can still be verified (see patientViewMatchesFull).
 */
export interface FetchedUpstream { report: any; fullReport?: any; consentRecord: any; session: any; origin: string }

/** The subject view must be EXACTLY the full signed body minus withdrawn rows — nothing else may differ. */
export function patientViewMatchesFull(patientView: any, full: any): boolean {
  if (!patientView || !full || !Array.isArray(full.rows)) return false;
  return canonicalJson(patientView) === canonicalJson({ ...full, rows: full.rows.filter((r: any) => !r?.excluded) });
}

export async function fetchFromTrustedUpstream(args: { sessionId: string; reportAccessToken: string; clinicianToken: string }, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true; value: FetchedUpstream } | { ok: false; reason: FetchFailure }> {
  let cfg: UpstreamConfig;
  try { cfg = upstreamConfig(env); } catch { return { ok: false, reason: 'not_configured' }; }
  if (!isSafeId(args.sessionId)) return { ok: false, reason: 'invalid_id' };
  const sid = encodeURIComponent(args.sessionId);

  const rep = await get(cfg.origin, `/sessions/${sid}/released-report`, args.reportAccessToken);
  if (rep === 'unavailable' || rep === 'redirect_refused') return { ok: false, reason: rep };
  if (rep.status === 404 && rep.data?.status === 'pending_review') return { ok: false, reason: 'pending_review' };
  if (rep.status === 401 || rep.status === 403) return { ok: false, reason: 'unauthorized' };
  if (rep.status !== 200) return { ok: false, reason: rep.status === 404 ? 'not_found' : 'unavailable' };

  // A withdrawn row makes the subject view differ from the body that was hashed: fetch the full body as the clinician.
  let fullReport: any;
  const digest = rep.data?.signOff?.contentSha256;
  if (typeof digest === 'string' && reportContentSha256(rep.data) !== digest && isSafeId(rep.data?.reportId)) {
    const full = await get(cfg.origin, `/reports/${encodeURIComponent(rep.data.reportId)}`, args.clinicianToken);
    if (full === 'unavailable' || full === 'redirect_refused') return { ok: false, reason: full };
    if (full.status === 401 || full.status === 403) return { ok: false, reason: 'unauthorized' };
    if (full.status === 200) fullReport = full.data;
  }

  const ses = await get(cfg.origin, `/sessions/${sid}`, args.clinicianToken);
  if (ses === 'unavailable' || ses === 'redirect_refused') return { ok: false, reason: ses };
  if (ses.status === 401 || ses.status === 403) return { ok: false, reason: 'unauthorized' };
  if (ses.status !== 200) return { ok: false, reason: 'unavailable' };

  const consentId = ses.data?.consentRecordId;
  if (!isSafeId(consentId)) return { ok: false, reason: 'invalid_id' };
  const con = await get(cfg.origin, `/consent-records/${encodeURIComponent(consentId)}`, args.clinicianToken);
  if (con === 'unavailable' || con === 'redirect_refused') return { ok: false, reason: con };
  if (con.status !== 200) return { ok: false, reason: con.status === 404 ? 'not_found' : 'unavailable' };
  // The upstream consent GET returns its stored fields; normalise only the id key for comparison.
  const consentRecord = { ...con.data, consentRecordId: con.data?.consentRecordId ?? con.data?.id };
  return { ok: true, value: { report: rep.data, ...(fullReport ? { fullReport } : {}), consentRecord, session: ses.data, origin: cfg.origin } };
}
