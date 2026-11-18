/**
 * Guarded model transport for the configurable roles (plan §2, §6).
 *
 * `modelCall` is the ONLY exported way to reach the provider from new code. It
 * enforces the same boundary as runAgent, in the same order:
 *   1. BeforeLLMCall hooks (block → explicit error; modify → hook-supplied body)
 *   2. pre-egress policy by declared data class:
 *        patient_derived  → text de-identified per egress policy; images only if
 *                           raw egress is permitted (provider BAA-covered)
 *        reference_public → approved public reference text, sent as-is
 *        synthetic_test   → synthetic probe/test data, sent as-is (never set by routes)
 *   3. bounded transport (timeout, ≤1 retry on 429/5xx/network)
 *   4. local re-identification of text output
 *   5. AfterToolCall hooks (block → output withheld)
 * Provider error bodies can echo input, so they are never returned or logged:
 * only the HTTP status and a vetted provider error code survive.
 *
 * Model identity: the returned id must be the requested id, a DOCUMENTED alias, or
 * a VERIFIED dated version (see MODEL_IDENTITIES). Anything else → model_mismatch
 * (result discarded). A missing returned id is recorded as `unverified`.
 */
import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';
import { runHooks } from '../hooks';
import { egressMode, prepareForEgress, restoreAfterEgress, EgressDecision } from '../security/egress-policy';
import { assertNoRestrictedContent } from '../aikosh/taint';

export type Role = 'ocr' | 'embedding' | 'decision' | 'review';
export type DataClass = 'patient_derived' | 'reference_public' | 'synthetic_test';

export function modelRoles(env: NodeJS.ProcessEnv = process.env): Record<Role, string> {
  return {
    ocr: env.ANUCLAW_MODEL_OCR || 'google/gemini-3.8-flash',
    embedding: env.ANUCLAW_MODEL_EMBEDDING || 'google/gemini-embedding-2',
    decision: env.ANUCLAW_MODEL_DECISION || env.ELAB_DECISION_MODEL || 'google/gemini-decision-1',
    review: env.ANUCLAW_MODEL_REVIEW || env.ELAB_REVIEW_MODEL || 'google/gemma-4-26b-a4b-it',
  };
}

/** Configured embedding dimensions (live-verified 3072 for google/gemini-embedding-2 on 2026-11-17). */
export function configuredEmbeddingDims(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ANUCLAW_EMBEDDING_DIMS ?? 3072);
  return Number.isInteger(n) && n > 0 ? n : 3072;
}

/**
 * Documented aliases and VERIFIED dated versions per requested id. Entries come
 * from live responses recorded in docs/INTEGRATION-STATUS.md; add new ones only
 * after verifying them the same way.
 */
export const MODEL_IDENTITIES: Record<string, { aliases: string[]; verifiedDated: string[] }> = {
  'google/gemini-3.8-flash': { aliases: [], verifiedDated: [] },
  'google/gemini-embedding-2': { aliases: ['gemini-embedding-2'], verifiedDated: [] }, // provider-native id observed live
  'google/gemini-decision-1': { aliases: [], verifiedDated: ['google/gemini-decision-1-20261111'] },
  'google/gemma-4-26b-a4b-it': { aliases: [], verifiedDated: [] },
};

export type IdentityCheck = 'exact' | 'documented_alias' | 'verified_dated_version' | 'unverified_missing' | 'mismatch';

export function checkModelIdentity(requested: string, returned: string | undefined | null): IdentityCheck {
  if (returned === undefined || returned === null || returned === '') return 'unverified_missing';
  if (returned === requested) return 'exact';
  const known = MODEL_IDENTITIES[requested];
  if (known?.aliases.includes(returned)) return 'documented_alias';
  if (known?.verifiedDated.includes(returned)) return 'verified_dated_version';
  return 'mismatch';
}

/** Who a model call is accounted to. */
export interface SpendScope { kind: 'user' | 'tenant' | 'system'; id: string }
export const SYSTEM_SCOPE: SpendScope = { kind: 'system', id: 'system' };
/** Derive a scope from an authenticated actor string ("tenant:<id>" for API tenants, else a dashboard user id). */
export function scopeFromActor(actor?: string | null, tenantId?: string | null): SpendScope {
  if (tenantId) return { kind: 'tenant', id: tenantId };
  if (actor?.startsWith('tenant:')) return { kind: 'tenant', id: actor.slice('tenant:'.length) };
  if (actor) return { kind: 'user', id: actor };
  return SYSTEM_SCOPE;
}

export interface SpendContext { role: Role; model: string; dataClass: DataClass; scope: SpendScope; /** worst case: 1 + retries */ maxAttempts: number }
export type Accounting = 'settled' | 'reservation_kept_accounting_failed' | 'untracked_unavailable' | 'not_tracked';

/**
 * Optional spend tracking (registered at server start; see ./spend.ts). Unit tests run without it.
 * reserve() is called BEFORE the provider request and may refuse; settle()/release() run after it.
 */
export interface SpendHooks {
  reserve?(ctx: SpendContext): Promise<{ ok: true; token: string | null; accounting?: Accounting } | { ok: false; reason: string }>;
  /** May throw; the caller then reports accounting as failed (the reservation stays counted). */
  settle?(token: string, out: { status: CallStatus; returnedModel?: string; usage?: Record<string, unknown>; costRaw: unknown; attempts: number; note?: string }): Promise<void>;
  release?(token: string): Promise<void>;
}
let spendHooks: SpendHooks = {};
export function setSpendHooks(h: SpendHooks): void { spendHooks = h; }
let warnedUntracked = false;
/**
 * Every model call is accounted for by default: if no tracker has been registered the durable ledger is enabled on
 * first use, so no entry point (server, worker, script) can bypass it. Only an explicit ANUCLAW_SPEND_TRACKING=off
 * (used by unit tests) skips tracking, and that is logged.
 */
async function ensureSpendTracking(): Promise<void> {
  if (spendHooks.reserve) return;
  if (process.env.ANUCLAW_SPEND_TRACKING === 'off') {
    if (!warnedUntracked) { warnedUntracked = true; logger.warn('model spend tracking is explicitly disabled (ANUCLAW_SPEND_TRACKING=off); calls are NOT accounted'); }
    return;
  }
  (await import('./spend')).enableSpendTracking();
}

export type CallStatus = 'spend_limit_reached' | 'ok' | 'unavailable' | 'model_mismatch' | 'http_error' | 'malformed' | 'not_configured' | 'timeout' | 'blocked_by_policy' | 'blocked_by_egress_policy' | 'output_blocked_by_policy';

export interface ProbeRecord {
  role: Role;
  requestedModel: string;
  status: CallStatus;
  httpStatus?: number;
  providerErrorCode?: string;
  returnedModel?: string;
  identity?: IdentityCheck;
  reasoningRequested?: string;
  reasoningObserved?: 'reasoning_tokens_reported' | 'not_reported';
  egress?: { mode: EgressDecision['mode'] | 'reference_public' | 'synthetic_test'; redactions: number };
  latencyMs: number;
  attempts: number;
  /** Whether this call's cost was durably accounted. */
  accounting?: Accounting;
  usage?: Record<string, unknown>;
  detail?: string;
  data?: any;
}

const TIMEOUT_MS = Number(process.env.ANUCLAW_MODEL_TIMEOUT_MS ?? 60_000);

function endpoint(pathOrRel: string): string {
  const base = (config.llm.openrouterBaseUrl || 'https://openrouter.ai/api/v1').replace(/\/$/, '') + '/';
  return new URL(pathOrRel.replace(/^\//, ''), base).href;
}

/** Only short machine codes from provider error objects; never messages (they can echo input). */
function vettedErrorCode(data: any): string | undefined {
  const c = data?.error?.code ?? data?.error?.type;
  const s = c === undefined || c === null ? '' : String(c);
  return /^[A-Za-z0-9_.-]{1,40}$/.test(s) ? s : undefined;
}

function networkCode(err: any): string {
  const c = String(err?.code ?? '');
  return /^[A-Z_]{2,30}$/.test(c) ? c : 'network_error';
}

// ── egress over structured bodies ───────────────────────────────────────────────

interface TextSlot { get(): string; set(v: string): void }

function collectText(path: string, body: any): { slots: TextSlot[]; hasImages: boolean } {
  const slots: TextSlot[] = [];
  let hasImages = false;
  if (path.includes('embeddings')) {
    if (Array.isArray(body.input)) body.input.forEach((_: unknown, i: number) => slots.push({ get: () => body.input[i], set: (v) => { body.input[i] = v; } }));
    else if (typeof body.input === 'string') slots.push({ get: () => body.input, set: (v) => { body.input = v; } });
  } else if (path.includes('decisions')) {
    if (Array.isArray(body.state)) body.state.forEach((_: unknown, i: number) => slots.push({ get: () => body.state[i], set: (v) => { body.state[i] = v; } }));
  } else if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (typeof m.content === 'string') slots.push({ get: () => m.content, set: (v) => { m.content = v; } });
      else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part?.type === 'text' && typeof part.text === 'string') slots.push({ get: () => part.text, set: (v) => { part.text = v; } });
          if (part?.type === 'image_url' || part?.type === 'input_image' || part?.type === 'file') hasImages = true;
        }
      }
    }
  }
  return { slots, hasImages };
}

export interface ModelCallArgs {
  role: Role;
  path: string;
  body: Record<string, unknown>;
  dataClass: DataClass;
  model?: string;
  groupId?: string;
  retries?: number;
  /** Authenticated user/tenant the call is accounted to (defaults to the system scope). */
  scope?: SpendScope;
}

/** The single guarded entry point for provider calls from new code. */
export async function modelCall(args: ModelCallArgs): Promise<ProbeRecord> {
  const model = args.model ?? modelRoles()[args.role];
  const groupId = args.groupId ?? `model-${args.role}`;
  const channel = `model:${args.role}`;
  const started = Date.now();
  const base = { role: args.role, requestedModel: model, latencyMs: 0, attempts: 0 };

  // 1. hooks see the caller's body.
  const before = await runHooks('BeforeLLMCall', groupId, channel, { model, role: args.role, dataClass: args.dataClass, body: args.body });
  if (!before.allowed) return { ...base, status: 'blocked_by_policy', detail: `blocked by ${before.blockedBy ?? 'hook'}` };
  const body = JSON.parse(JSON.stringify((before.payload.body as Record<string, unknown>) ?? args.body));
  body.model = model; // the role's model, not a hook-chosen substitute

  // 2. egress
  const { slots, hasImages } = collectText(args.path, body);
  try { assertNoRestrictedContent(slots.map((s) => s.get())); } catch { return { ...base, status: 'blocked_by_egress_policy', detail: 'blocked: content from a restricted AIKosh source (not approved for external processing)' }; }
  let decision: EgressDecision | null = null;
  let egressInfo: ProbeRecord['egress'];
  if (args.dataClass === 'patient_derived') {
    if (hasImages && egressMode() !== 'raw_baa_covered') {
      return { ...base, status: 'blocked_by_egress_policy', detail: 'images cannot be de-identified; raw egress not permitted' };
    }
    try {
      const prepared = prepareForEgress(slots.map((s) => s.get()));
      decision = prepared.decision;
      prepared.fields.forEach((v, i) => slots[i].set(v));
      egressInfo = { mode: decision.mode, redactions: decision.redactions };
    } catch {
      return { ...base, status: 'blocked_by_egress_policy', detail: 'de-identification failed' };
    }
  } else {
    egressInfo = { mode: args.dataClass, redactions: 0 };
  }

  // 2b. durable reservation against the spend budgets (fails closed with an explicit status)
  await ensureSpendTracking();
  const maxAttempts = 1 + (args.retries ?? 1);
  let token: string | null = null;
  let accounting: Accounting = 'not_tracked';
  if (spendHooks.reserve) {
    let r: Awaited<ReturnType<NonNullable<SpendHooks['reserve']>>>;
    try { r = await spendHooks.reserve({ role: args.role, model, dataClass: args.dataClass, scope: args.scope ?? SYSTEM_SCOPE, maxAttempts }); }
    catch { r = { ok: false, reason: 'spend accounting failed; call refused (fail closed)' }; }
    if (!r.ok) return { ...base, status: 'spend_limit_reached', detail: r.reason };
    token = r.token; accounting = r.accounting ?? (r.token ? 'settled' : 'not_tracked');
  }

  // 3. transport
  if (args.path.includes('chat/completions')) (body as Record<string, unknown>).usage = { include: true };   // provider reports real cost
  let rec: ProbeRecord;
  try {
    rec = await transport(args.role, model, args.path, body, args.retries ?? 1, started);
  } catch (e) {
    // The request may already have reached the provider: keep the reservation as UNKNOWN cost (counted), never release it.
    if (token && spendHooks.settle) await spendHooks.settle(token, { status: 'unavailable', costRaw: undefined, attempts: maxAttempts, note: 'transport_exception' }).catch(() => logger.error(`spend accounting failed for a ${args.role} call; reservation retained`));
    throw e;
  }
  rec.egress = egressInfo;
  rec.accounting = accounting;
  if (token) {
    try {
      if (rec.status === 'not_configured') await spendHooks.release?.(token);   // never sent: nothing billed
      else await spendHooks.settle?.(token, { status: rec.status, returnedModel: rec.returnedModel, usage: rec.usage, costRaw: rec.data?.usage?.cost, attempts: rec.attempts });
    } catch {
      // The reservation row remains and keeps counting at its reserved amount. Say so; log no content.
      rec.accounting = 'reservation_kept_accounting_failed';
      logger.error(`spend accounting failed for a ${args.role} call; reservation retained`);
    }
  }
  if (rec.status !== 'ok') return rec;

  // 4. re-identify text output
  if (decision && rec.data?.choices?.[0]?.message && typeof rec.data.choices[0].message.content === 'string') {
    rec.data.choices[0].message.content = restoreAfterEgress(rec.data.choices[0].message.content, decision);
  }

  // 5. after hooks
  const after = await runHooks('AfterToolCall', groupId, channel, { model, role: args.role, data: rec.data });
  if (!after.allowed) return { ...publicRecord(rec), status: 'output_blocked_by_policy', detail: `withheld by ${after.blockedBy ?? 'hook'}` };
  return rec;
}

async function transport(role: Role, model: string, path: string, body: Record<string, unknown>, retries: number, started: number): Promise<ProbeRecord> {
  const key = config.llm.openrouterApiKey;
  const reasoningRequested = (body.reasoning as { effort?: string } | undefined)?.effort;
  if (!key) return { role, requestedModel: model, status: 'not_configured', latencyMs: 0, attempts: 0, detail: 'no server-side OpenRouter key' };
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      const r = await axios.post(endpoint(path), body, {
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
      });
      const latencyMs = Date.now() - started;
      if ((r.status === 429 || r.status >= 500) && attempts <= retries) { await new Promise((res) => setTimeout(res, 1500 * attempts)); continue; }
      const providerErrorCode = vettedErrorCode(r.data);
      if (r.status === 404) return { role, requestedModel: model, status: 'unavailable', httpStatus: r.status, providerErrorCode, latencyMs, attempts, reasoningRequested };
      if (r.status < 200 || r.status >= 300) return { role, requestedModel: model, status: 'http_error', httpStatus: r.status, providerErrorCode, latencyMs, attempts, reasoningRequested };
      const returnedModel: string | undefined = typeof r.data?.model === 'string' ? r.data.model : undefined;
      const identity = checkModelIdentity(model, returnedModel);
      if (identity === 'mismatch') {
        return { role, requestedModel: model, status: 'model_mismatch', httpStatus: r.status, returnedModel, identity, latencyMs, attempts, reasoningRequested, detail: 'provider returned a different model; result discarded' };
      }
      const usage = r.data?.usage;
      const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens;
      return {
        role, requestedModel: model, status: 'ok', httpStatus: r.status, returnedModel, identity, latencyMs, attempts, reasoningRequested,
        reasoningObserved: typeof reasoningTokens === 'number' && reasoningTokens > 0 ? 'reasoning_tokens_reported' : 'not_reported',
        usage: usage ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, reasoning_tokens: reasoningTokens, total_tokens: usage.total_tokens } : undefined,
        detail: describe(role, r.data),
        data: r.data,
      };
    } catch (err: any) {
      const code = networkCode(err);
      if (attempts <= retries) { await new Promise((res) => setTimeout(res, 1500 * attempts)); continue; }
      return { role, requestedModel: model, status: code === 'ECONNABORTED' || code === 'ETIMEDOUT' ? 'timeout' : 'http_error', latencyMs: Date.now() - started, attempts, reasoningRequested, detail: code };
    }
  }
}

function describe(role: Role, data: any): string {
  if (role === 'embedding') {
    const v = data?.data?.[0]?.embedding;
    return Array.isArray(v) ? `dims=${v.length} vectors=${data.data.length}` : 'no embedding vector in response';
  }
  if (role === 'decision') return data?.answers && typeof data.answers === 'object' ? `answers=${Object.keys(data.answers).join(',')}` : 'no answers field';
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? `content_chars=${content.length}` : 'no message content';
}

/** Strip response payloads before returning a record to callers/logs/files. */
export function publicRecord(r: ProbeRecord): Omit<ProbeRecord, 'data'> {
  const { data: _d, ...rest } = r;
  return rest;
}
