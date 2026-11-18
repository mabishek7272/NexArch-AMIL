/**
 * Crossref REST API connector (M2, plan §3B/§4) — public bibliographic METADATA only, never paid AI generation and
 * never a model-API fallback. Verified against Crossref's current documentation (api.crossref.org,
 * github.com/CrossRef/rest-api-doc) before writing this: GET /works/{doi} for a single record, GET
 * /works?query.bibliographic=...&rows=&offset=&mailto= for bibliographic search; response envelope
 * {status, 'message-type', 'message-version', message}; no fixed rate limit is published — the API advertises its
 * current limit via X-Rate-Limit-Limit/X-Rate-Limit-Interval response headers, and sending a contact email (the
 * `mailto` parameter) routes a caller to the "polite pool". This connector defaults to a conservative 1 req/s pace
 * (SafeFetcher's `minIntervalMs`) absent better information, and relies on SafeFetcher's existing 429/Retry-After
 * handling rather than inventing a second backoff scheme.
 *
 * Reuses src/sciencedata/fetcher.ts's SafeFetcher (origin allow-list, redirect pinning, size cap, timeout, retry,
 * pacing) rather than a bespoke HTTP client — the same bounded-connector mechanism already used for NCBI/GEO.
 */
import { SafeFetcher, FetchOptions, FetchResult } from '../../sciencedata/fetcher';
import { ScienceError } from '../../sciencedata/types';

export const CROSSREF_ORIGIN = 'https://api.crossref.org';

/** Narrow interface (not the concrete class) so tests can inject a fake, no-network fetcher without building a real SafeFetcher. */
export interface CrossrefFetcher { request(url: string, o?: FetchOptions): Promise<FetchResult> }

export interface CrossrefWork {
  doi: string | null; title: string; authors: Array<{ given?: string; family?: string }>;
  year: number | null; venue: string | null; type: string | null;
  /** Non-empty ONLY when Crossref's own `update-to` field names a correction/retraction notice for this DOI — never inferred any other way. */
  correctionStatus: 'unknown' | 'none' | 'corrected' | 'retracted';
  /** Crossref publishes licence links for SOME records; their presence is a (weak) signal full text MAY be available — never asserted as 'full_text', only as this narrower flag for the Source Verifier to combine with other evidence. */
  hasLicenseLink: boolean;
  raw: unknown;
}

function parseWork(message: Record<string, unknown>): CrossrefWork {
  const dateParts = (k: string): number | null => {
    const d = message[k] as { 'date-parts'?: number[][] } | undefined;
    const y = d?.['date-parts']?.[0]?.[0];
    return typeof y === 'number' ? y : null;
  };
  const updateTo = Array.isArray(message['update-to']) ? (message['update-to'] as Array<{ type?: string }>) : [];
  const correction = updateTo.find((u) => /retract/i.test(u.type ?? ''))
    ? 'retracted' as const
    : updateTo.find((u) => /correct/i.test(u.type ?? ''))
      ? 'corrected' as const
      : 'none' as const;
  const titleArr = message.title as unknown; const title = Array.isArray(titleArr) ? String(titleArr[0] ?? '') : '';
  const authors = Array.isArray(message.author) ? (message.author as Array<{ given?: string; family?: string }>) : [];
  const containerArr = message['container-title'] as unknown; const venue = Array.isArray(containerArr) && containerArr.length ? String(containerArr[0]) : null;
  return {
    doi: typeof message.DOI === 'string' ? message.DOI : null,
    title, authors,
    year: dateParts('published-print') ?? dateParts('published-online') ?? dateParts('published') ?? null,
    venue, type: typeof message.type === 'string' ? message.type : null,
    correctionStatus: correction,
    hasLicenseLink: Array.isArray(message.license) && (message.license as unknown[]).length > 0,
    raw: message,
  };
}

export interface CrossrefSearchResult { works: CrossrefWork[]; totalResults: number | null; status: 'completed' | 'partial' }

export class CrossrefConnector {
  private readonly fetcher: CrossrefFetcher;
  constructor(private readonly opts: { mailto?: string; fetcher?: CrossrefFetcher } = {}) {
    this.fetcher = opts.fetcher ?? new SafeFetcher({
      allowedOrigins: [CROSSREF_ORIGIN], userAgent: `anuclaw-research-studio/1.0${opts.mailto ? ` (mailto:${opts.mailto})` : ''}`,
      defaultTimeoutMs: 15_000, defaultMaxBytes: 5 * 1024 * 1024, minIntervalMs: () => 1000,
    });
  }

  /** A resolved DOI record proves only that Crossref KNOWS of this DOI — it does NOT establish claim support, full-text availability, or that the record matches what a user expects (the Source Verifier compares fields separately). */
  async lookupByDoi(doi: string): Promise<CrossrefWork | null> {
    try {
      const r = await this.fetcher.request(`${CROSSREF_ORIGIN}/works/${encodeURIComponent(doi)}${this.mailtoQS('?')}`, { expectTypes: /json/ });
      const body = JSON.parse(r.body.toString('utf8')) as { message?: Record<string, unknown> };
      return body.message ? parseWork(body.message) : null;
    } catch (e) {
      if (e instanceof ScienceError && e.code === 'not_found') return null;
      throw e;
    }
  }

  /** Bounded bibliographic search: ONE page, capped rows, explicit `partial` status if Crossref reports more results than were fetched — never silently truncated without saying so. */
  async searchBibliographic(query: string, opts: { rows?: number; offset?: number } = {}): Promise<CrossrefSearchResult> {
    const rows = Math.min(Math.max(1, opts.rows ?? 20), 100); const offset = Math.max(0, opts.offset ?? 0);
    const qs = `?query.bibliographic=${encodeURIComponent(query)}&rows=${rows}&offset=${offset}${this.mailtoQS('&')}`;
    const r = await this.fetcher.request(`${CROSSREF_ORIGIN}/works${qs}`, { expectTypes: /json/ });
    const body = JSON.parse(r.body.toString('utf8')) as { message?: { items?: Record<string, unknown>[]; 'total-results'?: number } };
    const items = body.message?.items ?? []; const total = body.message?.['total-results'] ?? null;
    return { works: items.map(parseWork), totalResults: total, status: total !== null && offset + items.length < total ? 'partial' : 'completed' };
  }

  private mailtoQS(sep: '?' | '&'): string { return this.opts.mailto ? `${sep}mailto=${encodeURIComponent(this.opts.mailto)}` : ''; }
}
