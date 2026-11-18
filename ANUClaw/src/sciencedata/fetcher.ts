/**
 * Bounded, origin-allow-listed HTTP client for public data providers.
 *  - only https (plain http only for loopback in non-production tests), only origins in the allow-list;
 *  - redirects are followed manually (≤ 3) and EVERY hop must be https + allow-listed (tokens/credentials are never sent anyway);
 *  - hard response-size cap enforced while streaming (axios maxContentLength), identity encoding (no decompression bombs);
 *  - per-request timeout, ≤ N retries with back-off for network errors / 5xx / 429 (honouring Retry-After, capped);
 *  - a minimum interval per host (NCBI allows 3 requests/s without a key);
 *  - optional live-download budget (files + bytes) persisted to a ledger file, so a bounded live check can be enforced.
 * DNS rebinding is not mitigated: the allow-list is operator-controlled, not user-supplied.
 */
import axios from 'axios';
import * as fs from 'fs';
import { ScienceError } from './types';

export interface FetchOptions { /** Restrict THIS request (and every redirect hop) to these origins — a subset of the fetcher's allow-list (the provider's own origins). */ origins?: string[]; maxBytes?: number; timeoutMs?: number; retries?: number; accept?: string; method?: 'GET' | 'HEAD' | 'POST'; body?: unknown; expectTypes?: RegExp; countsAsFile?: boolean }
export interface FetchResult { status: number; headers: Record<string, string>; body: Buffer; finalUrl: string; attempts: number }

export interface BudgetLimits { maxFiles: number; maxBytes: number }
export class LiveBudget {
  constructor(private readonly ledgerPath: string, private readonly limits: BudgetLimits) {}
  private read(): { files: number; bytes: number; requests: number; log: Array<{ url: string; bytes: number; status: number }> } {
    try { return JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8')); } catch { return { files: 0, bytes: 0, requests: 0, log: [] }; }
  }
  check(): void {
    const l = this.read();
    if (l.files >= this.limits.maxFiles || l.bytes >= this.limits.maxBytes) throw new ScienceError('budget_exhausted', `Live download budget exhausted (${l.files}/${this.limits.maxFiles} files, ${l.bytes}/${this.limits.maxBytes} bytes).`, 429);
  }
  record(url: string, bytes: number, status: number, countsAsFile: boolean): void {
    const l = this.read(); l.requests++; if (countsAsFile) l.files++; l.bytes += bytes; l.log.push({ url, bytes, status });
    fs.writeFileSync(this.ledgerPath, JSON.stringify(l, null, 1));
  }
  /** Bytes still allowed; used to cap a single response. */
  remainingBytes(): number { return Math.max(0, this.limits.maxBytes - this.read().bytes); }
}

export interface FetcherConfig {
  allowedOrigins: string[]; allowInsecureLoopback?: boolean; userAgent?: string; defaultMaxBytes?: number; defaultTimeoutMs?: number;
  minIntervalMs?: (host: string) => number; sleep?: (ms: number) => Promise<void>; budget?: LiveBudget | null; maxRetryAfterMs?: number;
}

/** Reads a response stream with a hard byte cap (declared length checked first) and an idle timeout. Never buffers more than the cap. */
function readBounded(stream: NodeJS.ReadableStream, cap: number, declared: number, idleMs: number, head: boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const destroy = () => (stream as unknown as { destroy?: () => void }).destroy?.();
    if (head) { destroy(); return resolve(Buffer.alloc(0)); }
    if (Number.isFinite(declared) && declared > cap) { destroy(); return reject(new ScienceError('too_large', `The response declares ${declared} bytes, above the ${cap}-byte limit; it was not downloaded.`, 413)); }
    const chunks: Buffer[] = []; let total = 0; let done = false; let timer: NodeJS.Timeout;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => finish(() => { destroy(); reject(new ScienceError('timeout', 'The provider stopped sending data.', 504)); }), idleMs); };
    arm();
    stream.on('data', (c: Buffer) => { total += c.length; if (total > cap) { finish(() => { destroy(); reject(new ScienceError('too_large', `The response exceeds the ${cap}-byte limit and was discarded.`, 413)); }); return; } chunks.push(c); arm(); });
    stream.on('end', () => finish(() => { if (Number.isFinite(declared) && total < declared) reject(new ScienceError('unavailable', 'The response ended before its declared length.', 502)); else resolve(Buffer.concat(chunks)); }));
    stream.on('error', () => finish(() => reject(new ScienceError('unavailable', 'The connection failed while downloading.', 502))));
    stream.on('aborted', () => finish(() => reject(new ScienceError('unavailable', 'The connection was aborted while downloading.', 502))));
  });
}

const isLoopback = (h: string) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(h);

export class SafeFetcher {
  private readonly last = new Map<string, number>();
  private readonly gate = new Map<string, Promise<void>>();
  constructor(private readonly cfg: FetcherConfig) {}

  originAllowed(url: string, only?: string[]): boolean {
    let u: URL; try { u = new URL(url); } catch { return false; }
    if (u.username || u.password) return false;
    if (u.protocol === 'http:') {
      if (!(this.cfg.allowInsecureLoopback && isLoopback(u.hostname)) || (process.env.NODE_ENV ?? '').toLowerCase() === 'production') return false;
    } else if (u.protocol !== 'https:') return false;
    return this.cfg.allowedOrigins.includes(u.origin) && (!only || only.includes(u.origin));
  }

  private async pace(host: string): Promise<void> {
    const min = this.cfg.minIntervalMs?.(host) ?? 0; if (!min) return;
    const prev = this.gate.get(host) ?? Promise.resolve();
    const next = prev.then(async () => {
      const wait = Math.max(0, (this.last.get(host) ?? 0) + min - Date.now());
      if (wait) await (this.cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(wait);
      this.last.set(host, Date.now());
    });
    this.gate.set(host, next.catch(() => undefined)); await next;
  }

  async request(url: string, o: FetchOptions = {}): Promise<FetchResult> {
    const sleep = this.cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const retries = o.retries ?? 2, maxRetryAfter = this.cfg.maxRetryAfterMs ?? 10_000;
    let cap = o.maxBytes ?? this.cfg.defaultMaxBytes ?? 20 * 1024 * 1024;
    let lastErr: ScienceError | null = null;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      this.cfg.budget?.check();
      if (this.cfg.budget) cap = Math.min(cap, Math.max(1, this.cfg.budget.remainingBytes()));
      let cur = url; let hops = 0;
      try {
        for (;;) {
          if (!this.originAllowed(cur, o.origins)) throw new ScienceError(hops ? 'redirect_refused' : 'blocked_origin', hops ? 'A redirect led outside this provider\'s approved origins and was refused.' : 'The URL is not on this provider\'s approved origins.', 403);
          await this.pace(new URL(cur).hostname);
          const r = await axios.request({
            url: cur, method: o.method ?? 'GET', data: o.body, responseType: 'stream', maxRedirects: 0, validateStatus: () => true, proxy: false,
            timeout: o.timeoutMs ?? this.cfg.defaultTimeoutMs ?? 30_000, maxBodyLength: 1_000_000, decompress: false,
            headers: { 'User-Agent': this.cfg.userAgent ?? 'anuclaw-research-connector/1.0', 'Accept-Encoding': 'identity', Accept: o.accept ?? '*/*',   // axios' default Accept (application/json, text/plain, */*) makes ftp.ncbi.nlm.nih.gov stall on file GETs (found live)
             ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          });
          const headers: Record<string, string> = {}; for (const [k, v] of Object.entries(r.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
          if (r.status >= 300 && r.status < 400 && headers.location) {
            if (++hops > 3) throw new ScienceError('redirect_refused', 'Too many redirects.', 502);
            cur = new URL(headers.location, cur).toString(); continue;
          }
          const body = await readBounded(r.data as NodeJS.ReadableStream, cap, Number(headers['content-length']), o.timeoutMs ?? this.cfg.defaultTimeoutMs ?? 30_000, (o.method ?? 'GET') === 'HEAD');
          const record = () => this.cfg.budget?.record(cur, body.length, r.status, o.countsAsFile !== false && (o.method ?? 'GET') !== 'HEAD');
          if (r.status === 404) { record(); throw new ScienceError('not_found', 'The provider has no such record.', 404); }
          if (r.status === 429 || r.status === 503 && headers['retry-after']) {
            record();
            const ra = Number(headers['retry-after']); const wait = Number.isFinite(ra) ? Math.min(ra * 1000, maxRetryAfter) : 1000 * attempt;
            lastErr = new ScienceError('rate_limited', 'The provider is rate limiting requests.', 429, { retryAfterSec: Number.isFinite(ra) ? ra : null });
            if (attempt <= retries) { await sleep(wait); break; } throw lastErr;
          }
          if (r.status >= 500) { record(); lastErr = new ScienceError('unavailable', `The provider returned HTTP ${r.status}.`, 502); if (attempt <= retries) { await sleep(Math.min(250 * 2 ** (attempt - 1), 2000)); break; } throw lastErr; }
          if (r.status === 401 || r.status === 403) { record(); throw new ScienceError('access_denied', `The provider answered HTTP ${r.status} (access denied). The reason is not established by the response — it is NOT assumed to be controlled-access data. Nothing was retrieved.`, 403, { httpStatus: r.status }); }
          if (r.status >= 400) { record(); throw new ScienceError('unavailable', `The provider rejected the request (HTTP ${r.status}).`, 502); }
          const ct = headers['content-type'] ?? '';
          if (o.expectTypes && !o.expectTypes.test(ct)) { record(); throw new ScienceError('bad_content_type', `Unexpected content type '${ct.slice(0, 60)}'.`, 502); }
          record();
          return { status: r.status, headers, body, finalUrl: cur, attempts: attempt };
        }
      } catch (e) {
        if (e instanceof ScienceError) { if (e.code === 'rate_limited' || e.code === 'unavailable') { lastErr = e; if (attempt <= retries && !(e.code === 'unavailable' && /rejected the request/.test(e.message))) continue; } throw e; }
        const err = e as { code?: string; message?: string };
        if (/maxContentLength/i.test(err.message ?? '') || err.code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED') throw new ScienceError('too_large', `The response exceeds the ${cap}-byte limit and was discarded.`, 413);
        if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') lastErr = new ScienceError('timeout', 'The provider did not answer in time.', 504);
        else lastErr = new ScienceError('unavailable', 'The provider could not be reached.', 502, { cause: String(err.code ?? 'unknown').slice(0, 40) });
        if (attempt > retries) throw lastErr; await sleep(Math.min(250 * 2 ** (attempt - 1), 2000));
      }
    }
    throw lastErr ?? new ScienceError('unavailable', 'The provider could not be reached.', 502);
  }
}
