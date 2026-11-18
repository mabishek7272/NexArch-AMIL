/**
 * Citation identity (M2, plan §4). Pure functions — no I/O — so the normalisation and duplicate-detection RULES are unit
 * tested directly. "Duplicate" here means the SAME publication record, not the same underlying work: a preprint, a
 * correction and the published version of one paper are deliberately NOT auto-merged (plan §4) — they are proposed as
 * separate `source_link` candidates (relation 'preprint_of'/'correction_of') for a human to confirm or reject.
 */
import * as crypto from 'crypto';

export const sha256Hex = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** DOIs are case-insensitive and sometimes carry a resolver prefix (https://doi.org/, dx.doi.org, doi:). */
export function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '');
  if (!/^10\.\d{4,9}\/\S+$/.test(s)) return null;
  return s;
}

export function normalizePmid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/^pmid:\s*/i, '');
  return /^\d{1,9}$/.test(s) ? s : null;
}

/** Strips tracking params, trailing slash and fragment; lower-cases host. Does not resolve redirects (that is a network operation — see connectors/). */
export function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    u.hostname = u.hostname.toLowerCase();
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|ref$|fbclid$|gclid$)/.test(p)) u.searchParams.delete(p);
    u.hash = '';
    let s = u.toString(); if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch { return null; }
}

/** Normalises free-text for a loose title+year match (lower-case, strip punctuation/whitespace runs) — NOT a semantic match, a syntactic one. */
export function normalizeTitleKey(title: string, year: number | null): string {
  const t = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return year ? `${t}::${year}` : t;
}

export interface SourceIdentity { doi?: string | null; pmid?: string | null; url?: string | null; title: string; year?: number | null }

/**
 * A stable identifier for THIS record. Preference order: DOI > PMID > normalised URL > title+year. This is deliberately
 * the identity used for the SQL dedup index (`idx_rs_sources_normalized`) — exact collisions are flagged automatically;
 * everything else (different identifier, same work) is a PROPOSED link for a human to confirm, never auto-merged.
 */
export function normalizedIdentityOf(s: SourceIdentity): string {
  const doi = normalizeDoi(s.doi); if (doi) return `doi:${doi}`;
  const pmid = normalizePmid(s.pmid); if (pmid) return `pmid:${pmid}`;
  const url = normalizeUrl(s.url); if (url) return `url:${url}`;
  return `title:${normalizeTitleKey(s.title, s.year ?? null)}`;
}

/** True only when two records would resolve to the exact same normalized_id — i.e. an EXACT duplicate, safe to flag automatically. */
export function isExactDuplicate(a: SourceIdentity, b: SourceIdentity): boolean { return normalizedIdentityOf(a) === normalizedIdentityOf(b); }

/**
 * An "uncertain match" worth a human's review: titles are a close (not exact) match AND (same year, or one side has no
 * year) AND the two records are NOT already an exact duplicate by identifier. Deliberately conservative — a false
 * negative here just means a human finds it later via the source library; a false positive that gets auto-merged would
 * silently conflate two different publications, which plan §4 explicitly forbids.
 */
export function proposedRelation(a: SourceIdentity, b: SourceIdentity): 'duplicate' | null {
  if (isExactDuplicate(a, b)) return null; // handled as an exact match, not a "proposal"
  const ta = normalizeTitleKey(a.title, null), tb = normalizeTitleKey(b.title, null);
  if (!ta || !tb) return null;
  const closeTitle = ta === tb || levenshteinRatio(ta, tb) >= 0.92;
  const yearOk = !a.year || !b.year || a.year === b.year;
  return closeTitle && yearOk ? 'duplicate' : null;
}

function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length, lb = b.length; if (!la || !lb) return 0;
  const dp: number[] = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= lb; j++) { const tmp = dp[j]; dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]); prev = tmp; }
  }
  const dist = dp[lb]; return 1 - dist / Math.max(la, lb);
}
