import dns from 'node:dns';
import net from 'node:net';
import { config } from '../config';

/**
 * SSRF protection for outbound webhook requests. Anything that is not a public unicast address is refused:
 * loopback, private (RFC 1918), CGNAT, link-local (incl. the 169.254.169.254 cloud metadata endpoint),
 * unique-local IPv6, multicast, documentation/benchmark ranges and the like.
 */
const blocked = new net.BlockList();
const v4: [string, number][] = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local + cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];
for (const [addr, prefix] of v4) blocked.addSubnet(addr, prefix, 'ipv4');
const v6: [string, number][] = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds arbitrary IPv4)
];
for (const [addr, prefix] of v6) blocked.addSubnet(addr, prefix, 'ipv6');

/** Expand an IPv6 literal into its 8 16-bit groups (handles "::" and an embedded dotted IPv4 tail). */
function expandIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const o = tail[1]!.split('.').map(Number);
    if (o.length !== 4 || o.some((n) => !(n >= 0 && n <= 255))) return null;
    s = s.slice(0, -tail[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ':' + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True when `ip` must not be contacted by the server. Unparseable input counts as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family !== 6) return true;
  const g = expandIPv6(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge by the embedded IPv4 address
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return blocked.check(embedded(g[6]!, g[7]!), 'ipv4');
  // NAT64 well-known prefix 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blocked.check(embedded(g[6]!, g[7]!), 'ipv4');
  return blocked.check(ip.split('%')[0]!, 'ipv6');
}

/** Host part of a URL without IPv6 brackets. */
export const urlHostname = (u: URL) => u.hostname.replace(/^\[|\]$/g, '');

/** Static check (no DNS): literal private IPs and "localhost" names. */
export function isPrivateHostLiteral(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  return net.isIP(h) !== 0 && isBlockedAddress(h);
}

export class SsrfError extends Error {
  constructor(message = 'The destination address is not allowed.') {
    super(message);
    this.name = 'SsrfError';
  }
}

/**
 * `lookup` function for http(s).request: resolves DNS and refuses private results. Because the socket
 * connects to exactly the address validated here, DNS rebinding between check and connect is impossible.
 */
export const safeLookup = ((hostname: string, options: dns.LookupOptions, cb: (...args: unknown[]) => void) => {
  const allowPrivate = config().webhookAllowPrivate;
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = addresses as dns.LookupAddress[];
    if (!allowPrivate) {
      const bad = list.find((a) => isBlockedAddress(a.address));
      if (bad || list.length === 0) return cb(new SsrfError());
    }
    if (options.all) return cb(null, list);
    return cb(null, list[0]!.address, list[0]!.family);
  });
}) as unknown as net.LookupFunction;
