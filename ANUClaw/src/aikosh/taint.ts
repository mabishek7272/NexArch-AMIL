/**
 * Process-local registry of RESTRICTED values (narrative text and identifier-like values read from AIKosh files that are not approved for external use).
 * The egress path (prepareForEgress and modelCall) refuses any outgoing text that contains one of them. It is a safety net against accidental leakage, not a
 * de-identification method: paraphrases, partial quotes below the length floor and values read by other processes are NOT caught.
 */
const MIN_LEN = 12;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const restricted = new Map<string, string>();
export function registerRestricted(values: Iterable<unknown>, label: string): number {
  let n = 0; for (const v of values) { if (typeof v !== 'string') continue; const k = norm(v); if (k.length >= MIN_LEN && !restricted.has(k)) { restricted.set(k, label); n++; } } return n;
}
export class RestrictedContentError extends Error { constructor(public readonly label: string) { super(`outgoing text contains content from a restricted data source (${label}); blocked from external processing`); this.name = 'RestrictedContentError'; } }
/** Returns the label of the restricted source found in `text` (never the value itself), or null. */
export function findRestricted(text: string): string | null {
  if (restricted.size === 0 || !text) return null; const t = norm(text);
  for (const [k, label] of restricted) if (t.includes(k)) return label; return null;
}
export function assertNoRestrictedContent(texts: string[]): void { for (const t of texts) { const l = findRestricted(t); if (l) throw new RestrictedContentError(l); } }
export function restrictedCount(): number { return restricted.size; }
export function clearRestricted(): void { restricted.clear(); }
