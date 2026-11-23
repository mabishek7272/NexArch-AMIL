/**
 * SSRF guard for tenant-supplied outbound URLs (interpretation engine, P3c).
 *
 * A tenant chooses where webhooks go, so the destination is hostile input. This guard:
 *  - allows https only, no credentials in the URL, and only port 443 or an unprivileged port (1024-65535);
 *  - refuses internal-looking names (localhost, *.localhost, *.local, *.internal, *.localdomain, bare single-label hosts);
 *  - resolves the host and refuses it if ANY answer is not a public unicast address (so a name with one public and one
 *    private record cannot be used to reach the private one);
 *  - returns one validated address for the caller to PIN the connection to. Connecting to that address rather than
 *    resolving again defeats DNS rebinding between this check and the request.
 * The WHATWG URL parser already normalises exotic IPv4 spellings (decimal, hex, octal, short forms) to dotted-quad,
 * so the address checks below see the canonical form.
 *
 * Redirects must NOT be followed by the caller (a public host can redirect to an internal one); see
 * `src/interpretation/webhooks/transport.ts`.
 */
import * as dns from 'dns';
import * as net from 'net';

export type SsrfReason =
  | 'invalid_url' | 'scheme_not_https' | 'credentials_in_url' | 'port_not_allowed'
  | 'host_blocked' | 'resolution_failed' | 'address_blocked';

export interface ResolvedTarget {
  url: URL;
  /** Host name as it must appear in SNI and the Host header (IPv6 literals without brackets). */
  hostname: string;
  /** The single validated address to connect to. */
  address: string;
  family: 4 | 6;
  port: number;
}

export type GuardResult = { ok: true; target: ResolvedTarget } | { ok: false; reason: SsrfReason };
export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const blocked = new net.BlockList();
const v4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
for (const [net_, prefix] of v4) blocked.addSubnet(net_, prefix, 'ipv4');
const v6: Array<[string, number]> = [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32],
  ['2001:2::', 48], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];
// No ::ffff:0:0/96 rule: Node matches IPv4 against it, which would block every IPv4 address. Mapped addresses are unwrapped explicitly below.
for (const [net_, prefix] of v6) blocked.addSubnet(net_, prefix, 'ipv6');

/** True when the address is a public unicast address this process may connect to. */
export function isPublicAddress(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 0) return false;
  if (kind === 6) {
    if (address.includes('%')) return false; // zone ids make no sense for a public peer
    const mapped = address.toLowerCase().match(/^(?:0{0,4}:){0,5}ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
  }
  return !blocked.check(address, kind === 4 ? 'ipv4' : 'ipv6');
}

const INTERNAL_SUFFIX = /\.(localhost|local|internal|localdomain|lan|home|corp|intranet)$/;

function hostLooksInternal(host: string): boolean {
  if (host === 'localhost' || INTERNAL_SUFFIX.test(host)) return true;
  // A bare single-label name resolves via search domains, i.e. inside the operator's network.
  return net.isIP(host) === 0 && !host.includes('.');
}

const defaultResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

export async function resolveSafeTarget(rawUrl: unknown, resolve: Resolver = defaultResolver): Promise<GuardResult> {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) return { ok: false, reason: 'invalid_url' };
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { ok: false, reason: 'invalid_url' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme_not_https' };
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' };
  const port = url.port ? Number(url.port) : 443;
  if (!(port === 443 || (port >= 1024 && port <= 65535))) return { ok: false, reason: 'port_not_allowed' };

  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname) return { ok: false, reason: 'invalid_url' };

  const literal = net.isIP(hostname);
  if (literal) {
    return isPublicAddress(hostname) ? { ok: true, target: { url, hostname, address: hostname, family: literal as 4 | 6, port } } : { ok: false, reason: 'address_blocked' };
  }
  if (hostLooksInternal(hostname)) return { ok: false, reason: 'host_blocked' };

  let answers: Array<{ address: string; family: number }>;
  try { answers = await resolve(hostname); } catch { return { ok: false, reason: 'resolution_failed' }; }
  if (!answers.length) return { ok: false, reason: 'resolution_failed' };
  if (answers.some((a) => !isPublicAddress(a.address))) return { ok: false, reason: 'address_blocked' };
  const first = answers[0];
  return { ok: true, target: { url, hostname, address: first.address, family: first.family === 6 ? 6 : 4, port } };
}
