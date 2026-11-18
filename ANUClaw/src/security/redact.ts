/**
 * Safe-logging helpers (plan F04). Removes credentials and token-like material
 * from anything written to logs. This is a guard rail, not a licence to log
 * clinical text: callers should still avoid logging prompts or patient data.
 */

const SENSITIVE_KEY = /authorization|cookie|password|passwd|secret|token|api[-_]?key|apikey|credential|private[-_]?key|totp|session/i;

const PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED_JWT]'],
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]'],
  [/\bsk-or-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]'],
  [/\bamgi_(live|test)_[A-Za-z0-9]{8,}\b/g, '[REDACTED_KEY]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\bscrypt\$1\$[^\s"']+/g, '[REDACTED_HASH]'],
  [/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@'],
];

export const MAX_LOG_FIELD = 2000;

export function redactSecrets(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out.length > MAX_LOG_FIELD ? out.slice(0, MAX_LOG_FIELD) + '…[truncated]' : out;
}

/** Serialise a value for logs: errors summarised, sensitive keys dropped, strings redacted. */
export function safeSerialize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value !== 'object') return value;
  if (depth > 4) return '[depth-limit]';
  if (value instanceof Error) {
    const e = value as Error & { code?: unknown; status?: unknown; response?: { status?: unknown } };
    return {
      name: e.name,
      message: redactSecrets(String(e.message ?? '')),
      ...(e.code !== undefined ? { code: String(e.code) } : {}),
      ...(e.response?.status !== undefined ? { status: e.response.status } : {}),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => safeSerialize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k)) { out[k] = '[REDACTED]'; continue; }
    if (k === 'config' || k === 'request' || k === 'headers') continue; // HTTP client internals
    out[k] = safeSerialize(v, depth + 1);
  }
  return out;
}

/** One-line error description safe to show in logs (never raw provider bodies). */
export function safeErrorSummary(err: unknown): string {
  const s = safeSerialize(err) as Record<string, unknown> | string;
  if (typeof s === 'string') return s;
  return [s?.name, s?.code, s?.status, s?.message].filter(Boolean).join(' ').slice(0, 300) || 'unknown error';
}
