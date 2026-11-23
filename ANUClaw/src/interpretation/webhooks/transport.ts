/**
 * The one place a webhook leaves the process (interpretation engine, P3c).
 *
 * It connects ONLY to the address the SSRF guard validated (`target.address`), by overriding the socket lookup, so no
 * second DNS resolution can redirect the request (rebinding). TLS is verified against the real host name (SNI and
 * certificate check use `target.hostname`). Redirects are never followed: a 3xx is returned as a status and counts as
 * a failed delivery. The response body is read only up to a small cap and then discarded; it is never stored.
 */
import * as https from 'https';
import type { ResolvedTarget } from '../../security/ssrf-guard';

export interface PostResult { statusCode: number | null; error: string | null }
export interface PostOptions { timeoutMs?: number; maxResponseBytes?: number; /** Test seam: extra TLS options such as `ca`. */ tls?: Pick<https.RequestOptions, 'ca'> }

export const DEFAULT_TIMEOUT_MS = 10_000;

function errorCode(e: unknown): string {
  const code = String((e as { code?: unknown } | null)?.code ?? '');
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'TIMEOUT') return 'timeout';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_error';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'connection_reset';
  if (/^(CERT_|DEPTH_ZERO|ERR_TLS|ERR_SSL|UNABLE_TO_|SELF_SIGNED|HOSTNAME_MISMATCH)/.test(code) || code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'tls_error';
  return 'network_error';
}

export function pinnedPost(target: ResolvedTarget, headers: Record<string, string>, body: string, opts: PostOptions = {}): Promise<PostResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cap = opts.maxResponseBytes ?? 65_536;
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: PostResult) => { if (!settled) { settled = true; resolve(r); } };
    const isLiteral = target.hostname === target.address;
    const req = https.request({
      host: target.hostname, port: target.port, method: 'POST', path: `${target.url.pathname}${target.url.search}`,
      headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body, 'utf8')) },
      // Connect to the validated address, whatever the name resolves to now.
      lookup: ((_host: string, options: { all?: boolean }, cb: (...a: unknown[]) => void) => {
        if (options?.all) cb(null, [{ address: target.address, family: target.family }]); else cb(null, target.address, target.family);
      }) as unknown as https.RequestOptions['lookup'],
      ...(isLiteral ? {} : { servername: target.hostname }),
      agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }),
      timeout: timeoutMs, rejectUnauthorized: true, ...(opts.tls ?? {}),
    }, (res) => {
      let read = 0;
      res.on('data', (chunk: Buffer) => { read += chunk.length; if (read > cap) res.destroy(); });
      res.on('end', () => done({ statusCode: res.statusCode ?? null, error: null }));
      res.on('close', () => done({ statusCode: res.statusCode ?? null, error: null }));
      res.on('error', () => done({ statusCode: res.statusCode ?? null, error: null }));
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })); });
    req.on('error', (e) => done({ statusCode: null, error: errorCode(e) }));
    req.end(body, 'utf8');
  });
}
