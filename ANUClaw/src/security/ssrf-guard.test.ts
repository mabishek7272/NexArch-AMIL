import { describe, expect, it } from 'vitest';
import { isPublicAddress, resolveSafeTarget, type Resolver } from './ssrf-guard';

const pub: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];
const never: Resolver = async () => { throw new Error('resolver must not be called'); };

describe('isPublicAddress', () => {
  it('accepts ordinary public unicast addresses', () => {
    for (const a of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:2800:220:1:248:1893:25c8:1946', '2001:4860:4860::8888']) expect(isPublicAddress(a), a).toBe(true);
  });
  it('refuses private, loopback, link-local, metadata, CGNAT, documentation, multicast and reserved IPv4', () => {
    for (const a of ['0.0.0.0', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255',
      '192.0.0.1', '192.0.2.5', '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255']) expect(isPublicAddress(a), a).toBe(false);
  });
  it('refuses the neighbours just outside the public edge only where they are really reserved', () => {
    expect(isPublicAddress('172.15.255.255')).toBe(true); expect(isPublicAddress('172.32.0.1')).toBe(true);
    expect(isPublicAddress('100.63.255.255')).toBe(true); expect(isPublicAddress('100.128.0.1')).toBe(true);
    expect(isPublicAddress('11.0.0.1')).toBe(true);
  });
  it('refuses private, loopback, link-local, unique-local, multicast, mapped, NAT64 and tunnelled IPv6', () => {
    for (const a of ['::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', '2001:db8::1', '2002:7f00:1::1', 'fec0::1', '100::1']) expect(isPublicAddress(a), a).toBe(false);
  });
  it('refuses non-addresses and zone ids', () => {
    for (const a of ['', 'example.com', '999.1.1.1', 'fe80::1%eth0', '1.2.3']) expect(isPublicAddress(a), a).toBe(false);
  });
  it('treats a mapped public IPv4 as public', () => { expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true); });
  it('judges hex-form mapped addresses (what the URL parser produces) by the IPv4 inside', () => {
    for (const a of ['::ffff:7f00:1', '::ffff:a00:1', '::ffff:a9fe:a9fe', '::ffff:c0a8:1']) expect(isPublicAddress(a), a).toBe(false);
    expect(isPublicAddress('::ffff:808:808')).toBe(true);
  });
});

describe('resolveSafeTarget: URL rules', () => {
  it('accepts a public https host and returns an address to pin', async () => {
    const r = await resolveSafeTarget('https://hooks.example.com/anuclaw?x=1', pub);
    expect(r).toMatchObject({ ok: true, target: { hostname: 'hooks.example.com', address: '93.184.216.34', family: 4, port: 443 } });
  });
  it.each([
    ['http://hooks.example.com/x', 'scheme_not_https'],
    ['ftp://hooks.example.com/x', 'scheme_not_https'],
    ['https://user:pw@hooks.example.com/x', 'credentials_in_url'],
    ['https://hooks.example.com:22/x', 'port_not_allowed'],
    ['https://hooks.example.com:80/x', 'port_not_allowed'],
    ['https://hooks.example.com:1023/x', 'port_not_allowed'],
    ['not a url', 'invalid_url'],
    ['', 'invalid_url'],
    ['https://', 'invalid_url'],
  ])('refuses %s (%s) before any lookup', async (u, reason) => { expect(await resolveSafeTarget(u, never)).toEqual({ ok: false, reason }); });
  it('allows an unprivileged port', async () => { expect(await resolveSafeTarget('https://hooks.example.com:8443/x', pub)).toMatchObject({ ok: true, target: { port: 8443 } }); });
  it('refuses non-string and oversized input', async () => {
    for (const v of [undefined, null, 5, {}, 'https://a.example/' + 'x'.repeat(3000)]) expect(await resolveSafeTarget(v, never)).toMatchObject({ ok: false, reason: 'invalid_url' });
  });
  it.each(['https://localhost/x', 'https://LOCALHOST./x', 'https://app.localhost/x', 'https://printer.local/x', 'https://db.internal/x', 'https://router.lan/x', 'https://intranet/x', 'https://metadata/x'])(
    'refuses internal-looking name %s without resolving it', async (u) => { expect(await resolveSafeTarget(u, never)).toEqual({ ok: false, reason: 'host_blocked' }); });
});

describe('resolveSafeTarget: address rules', () => {
  it.each([
    'https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://169.254.169.254/latest/meta-data', 'https://192.168.0.1/x', 'https://[::1]/x', 'https://[fe80::1]/x',
    'https://[fd00::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://0.0.0.0/x',
  ])('refuses the IP literal %s', async (u) => { expect(await resolveSafeTarget(u, never)).toEqual({ ok: false, reason: 'address_blocked' }); });

  it.each([
    ['https://2130706433/x', 'decimal 127.0.0.1'], ['https://0x7f000001/x', 'hex 127.0.0.1'], ['https://0177.0.0.1/x', 'octal 127.0.0.1'],
    ['https://127.1/x', 'short 127.0.0.1'], ['https://0xa9fea9fe/x', 'hex metadata'], ['https://2852039166/x', 'decimal metadata'],
  ])('refuses exotic IPv4 spelling %s (%s) because the URL parser canonicalises it', async (u) => {
    expect(await resolveSafeTarget(u, never)).toEqual({ ok: false, reason: 'address_blocked' });
  });

  it('accepts a public IP literal, IPv6 included', async () => {
    expect(await resolveSafeTarget('https://93.184.216.34/x', never)).toMatchObject({ ok: true, target: { address: '93.184.216.34', family: 4 } });
    expect(await resolveSafeTarget('https://[2606:2800:220:1:248:1893:25c8:1946]/x', never)).toMatchObject({ ok: true, target: { family: 6, hostname: '2606:2800:220:1:248:1893:25c8:1946' } });
  });

  it('refuses a name that resolves to a private address', async () => {
    const r = await resolveSafeTarget('https://evil.example.com/x', async () => [{ address: '10.0.0.5', family: 4 }]);
    expect(r).toEqual({ ok: false, reason: 'address_blocked' });
  });

  it('refuses a name when ANY answer is non-public (public + private mix)', async () => {
    const mixed: Resolver = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
    expect(await resolveSafeTarget('https://mixed.example.com/x', mixed)).toEqual({ ok: false, reason: 'address_blocked' });
    const mixed6: Resolver = async () => [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }, { address: '::ffff:169.254.169.254', family: 6 }];
    expect(await resolveSafeTarget('https://mixed6.example.com/x', mixed6)).toEqual({ ok: false, reason: 'address_blocked' });
  });

  it('reports a resolution failure and an empty answer set', async () => {
    expect(await resolveSafeTarget('https://nx.example.com/x', async () => { throw new Error('ENOTFOUND'); })).toEqual({ ok: false, reason: 'resolution_failed' });
    expect(await resolveSafeTarget('https://empty.example.com/x', async () => [])).toEqual({ ok: false, reason: 'resolution_failed' });
  });

  it('pins the FIRST answer, so a later re-resolution cannot change where the request goes (rebinding)', async () => {
    let calls = 0;
    const flip: Resolver = async () => (++calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    const r = await resolveSafeTarget('https://rebind.example.com/x', flip);
    expect(r).toMatchObject({ ok: true, target: { address: '93.184.216.34' } });
    expect(calls).toBe(1); // the guard resolves exactly once; the caller connects to the returned address
  });
});
