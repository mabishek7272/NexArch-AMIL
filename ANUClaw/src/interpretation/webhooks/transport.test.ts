/** The transport against a REAL local TLS server: pinned address, SNI, certificate checks, no redirects, timeouts. */
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedTarget } from '../../security/ssrf-guard';
import { pinnedPost } from './transport';

const HOST = 'hooks.example.test';
let dir: string; let cert: string; let key: string;
let server: https.Server; let port: number;
let seen: Array<{ host: string | undefined; servername: string | undefined; path: string; body: string; headers: http.IncomingHttpHeaders }> = [];
let behaviour: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_q, r) => { r.statusCode = 204; r.end(); };

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anuclaw-tls-'));
  const k = path.join(dir, 'key.pem'), c = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', k, '-out', c, '-days', '2', '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`], { stdio: 'ignore' });
  cert = fs.readFileSync(c, 'utf8'); key = fs.readFileSync(k, 'utf8');
  server = https.createServer({ key, cert }, (req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => { seen.push({ host: req.headers.host, servername: (req.socket as any).servername, path: req.url ?? '', body, headers: req.headers }); behaviour(req, res); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); fs.rmSync(dir, { recursive: true, force: true }); });

const target = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  url: new URL(`https://${HOST}:${port}/hook/path?x=1`), hostname: HOST, address: '127.0.0.1', family: 4, port, ...over,
});
const post = (t: ResolvedTarget, body = '{"a":1}', extra: Record<string, string> = {}, opts = {}) => pinnedPost(t, { 'Content-Type': 'application/json', ...extra }, body, { tls: { ca: cert }, ...opts });
const reset = () => { seen = []; behaviour = (_q, r) => { r.statusCode = 204; r.end(); }; };

describe('pinnedPost (real TLS)', () => {
  it('connects to the PINNED address even though the host name does not resolve, sending the real name as SNI and Host', async () => {
    reset();
    const r = await post(target(), '{"hello":"world"}', { 'Anukla-Event-Id': 'evt_1' });
    expect(r).toEqual({ statusCode: 204, error: null }); // hooks.example.test is not resolvable anywhere: only the pin can have worked
    expect(seen).toHaveLength(1);
    expect(seen[0].servername).toBe(HOST);
    expect(seen[0].host).toBe(`${HOST}:${port}`);
    expect(seen[0].path).toBe('/hook/path?x=1');
    expect(seen[0].body).toBe('{"hello":"world"}');
    expect(seen[0].headers['anukla-event-id']).toBe('evt_1');
    expect(seen[0].headers['content-length']).toBe(String(Buffer.byteLength('{"hello":"world"}')));
  });
  it('sends the exact bytes, including non-ASCII, with a matching Content-Length', async () => {
    reset(); const body = JSON.stringify({ n: 'café – 中文' });
    await post(target(), body);
    expect(seen[0].body).toBe(body);
    expect(seen[0].headers['content-length']).toBe(String(Buffer.byteLength(body, 'utf8')));
  });
  it('does NOT follow a redirect: the 3xx is returned and no second request is made', async () => {
    reset(); behaviour = (_q, r) => { r.statusCode = 302; r.setHeader('Location', `https://127.0.0.1:${port}/internal`); r.end(); };
    const r = await post(target());
    expect(r).toEqual({ statusCode: 302, error: null });
    expect(seen).toHaveLength(1);
  });
  it('returns non-2xx statuses as they are', async () => {
    reset(); behaviour = (_q, r) => { r.statusCode = 503; r.end('down'); };
    expect(await post(target())).toEqual({ statusCode: 503, error: null });
  });
  it('verifies the certificate against the real host name (tls_error on a mismatch) and against the trust roots', async () => {
    reset();
    expect(await post(target({ hostname: 'other.example.test', url: new URL(`https://other.example.test:${port}/x`) }))).toEqual({ statusCode: null, error: 'tls_error' });
    expect(await pinnedPost(target(), {}, '{}')).toEqual({ statusCode: null, error: 'tls_error' }); // self-signed, and no `ca` given
    expect(seen).toHaveLength(0);
  });
  it('reports a timeout when the receiver does not answer', async () => {
    reset(); behaviour = () => { /* never respond */ };
    const t0 = Date.now();
    expect(await post(target(), '{}', {}, { timeoutMs: 300 })).toEqual({ statusCode: null, error: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it('reports connection refused for a closed port', async () => {
    const closed = await new Promise<number>((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
    expect(await post(target({ port: closed, url: new URL(`https://${HOST}:${closed}/x`) }))).toEqual({ statusCode: null, error: 'connection_refused' });
  });
  it('does not hang on a huge response body (it is read up to a cap and discarded)', async () => {
    reset(); behaviour = (_q, r) => { r.statusCode = 200; r.write(Buffer.alloc(2_000_000, 97)); r.end(); };
    const r = await post(target(), '{}', {}, { maxResponseBytes: 1024, timeoutMs: 5000 });
    expect(r.statusCode).toBe(200);
  });
});
