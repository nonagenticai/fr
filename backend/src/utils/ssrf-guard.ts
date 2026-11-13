// src/utils/ssrf-guard.ts
//
// Blocks server-side fetches of user-supplied URLs from reaching internal
// infrastructure (SSRF).
//
// WHY THIS IS DENY-BY-DEFAULT, not an allow-with-blocklist:
// The sibling repo core_app shipped a guard that enumerated the "private"
// ranges and missed CGNAT `100.64.0.0/10`. On this infrastructure that range is
// the ENTIRE Tailscale fleet — every internal host is 100.x.x.x — so the guard
// was decorative: an attacker could still reach every internal service. The
// lesson is that any hand-written list of ranges to BLOCK will eventually miss
// one. So this module inverts it: an address is rejected unless it is provably
// globally routable, mirroring Python's `ipaddress.is_global`.
//
// RESIDUAL GAP, stated honestly: `assertPublicUrl` resolves the hostname and
// checks every returned address, but Bun's `fetch` re-resolves independently, so
// a DNS name that answers with a public IP here and a private one microseconds
// later (DNS rebinding) is NOT fully closed. Closing it needs connect-time
// pinning of the validated IP, which Bun's fetch does not currently expose.
// Resolve-then-check removes the entire trivial attack surface (literal IPs,
// `localhost`, internal hostnames, and stable attacker-controlled A records);
// rebinding remains a known, documented limitation rather than a silent one.

import { lookup } from 'node:dns/promises';
import { AppError } from './errors';

/**
 * A user-supplied URL was refused.
 *
 * 400, not 500 — a rejected input is the caller's to fix, so if this ever
 * reaches the HTTP boundary it must render as a 4xx.
 *
 * ⚠️ CORRECTION, and it matters. An earlier version of this comment claimed
 * "every blocked URL reached the caller as 500" and that n8n retried blocked
 * SSRF attempts forever. THAT WAS WRONG, and I am recording it rather than
 * quietly deleting it. Traced all three call sites afterwards:
 *   - `connectors/rss.ts:104`         -> catches, rethrows ConnectorError('CONFIG_MISMATCH')
 *   - `connectors/n8n-webhook.ts:44`  -> catches, returns { ok:false, CONFIG_MISMATCH }
 *   - `connectors/dispatcher.ts:175`  -> propagates, but `routes/intake-webhook.ts:213`
 *                                        catches per record and answers 200
 * So this error NEVER reaches `handleError` today, and extending AppError
 * changes NOTHING observable. It is defence-in-depth for the day a fourth call
 * site forgets, not a live fix.
 *
 * ⛔ AND DO NOT USE IT TO DELETE THOSE LOCAL CATCHES. They are deliberate: the
 * comments at rss.ts:100-103 and n8n-webhook.ts:41-42 record that reporting a
 * blocked target as a reachability result would turn this route into an
 * EXISTENCE ORACLE for internal hosts (blocked and unreachable must stay
 * indistinguishable to the caller). "handleError maps it now" is not a reason
 * to remove them — the status is a fallback, the conversion is the security
 * control.
 */
export class SsrfBlockedError extends AppError {
  constructor(message: string) {
    super(400, message);
    // ⛔ after super(): AppError's constructor sets name = 'AppError'.
    this.name = 'SsrfBlockedError';
    this.code = 'SSRF_BLOCKED';
  }
}

/** Only these schemes may ever be fetched from a user-supplied URL. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// ---------------------------------------------------------------------------
// IPv4
// ---------------------------------------------------------------------------

/** Parse a dotted-quad into a uint32, or null if it is not a literal IPv4. */
export function parseIpv4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    // Reject '', '01', '+1', ' 1', '0x7f' — anything but a bare 0-255 decimal.
    // Octal/hex forms are a classic guard bypass (0177.0.0.1 == 127.0.0.1).
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    acc = acc * 256 + n;
  }
  return acc >>> 0;
}

function inV4Block(ip: number, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const baseIp = parseIpv4(base as string);
  if (baseIp === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (baseIp & mask) >>> 0;
}

/**
 * IANA IPv4 Special-Purpose Address Registry — everything NOT globally
 * reachable. Deny-by-default means this list only has to be a superset of the
 * dangerous ranges; a range missing here still has to survive being a routable
 * public address, and adding a new special-purpose range only ever tightens.
 */
const V4_SPECIAL: readonly string[] = [
  '0.0.0.0/8', // "this network"
  '10.0.0.0/8', // RFC1918 private
  '100.64.0.0/10', // CGNAT — THE TAILSCALE FLEET. The range core_app missed.
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local, incl. 169.254.169.254 cloud metadata
  '172.16.0.0/12', // RFC1918 private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1
  '192.88.99.0/24', // 6to4 relay anycast (deprecated)
  '192.168.0.0/16', // RFC1918 private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, includes 255.255.255.255 broadcast
];

export function isGloballyRoutableIpv4(value: string): boolean {
  const ip = parseIpv4(value);
  if (ip === null) return false;
  return !V4_SPECIAL.some((cidr) => inV4Block(ip, cidr));
}

// ---------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------

/** Expand an IPv6 literal to its 8 hextets, or null if unparseable. */
export function parseIpv6(input: string): number[] | null {
  let value = input.trim();
  // Strip a zone id (fe80::1%eth0) — the zone never makes an address global.
  const pct = value.indexOf('%');
  if (pct !== -1) value = value.slice(0, pct);
  if (value === '' || !/^[0-9a-fA-F:.]+$/.test(value)) return null;

  // IPv4-mapped / -embedded tail (::ffff:127.0.0.1) — convert to two hextets.
  let tail: number[] = [];
  const lastColon = value.lastIndexOf(':');
  const maybeV4 = value.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIpv4(maybeV4);
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    value = value.slice(0, lastColon + 1);
    if (value.endsWith(':') && !value.endsWith('::')) value = value.slice(0, -1);
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (g === '' || !/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] ?? '');
  if (head === null) return null;
  if (halves.length === 1) {
    const full = [...head, ...tail];
    return full.length === 8 ? full : null;
  }
  const rest = toGroups(halves[1] ?? '');
  if (rest === null) return null;
  const known = head.length + rest.length + tail.length;
  if (known > 8) return null;
  return [...head, ...new Array(8 - known).fill(0), ...rest, ...tail];
}

export function isGloballyRoutableIpv6(value: string): boolean {
  const g = parseIpv6(value);
  if (g === null) return false;

  const isZeroPrefix = (n: number) => g.slice(0, n).every((h) => h === 0);

  if (isZeroPrefix(7) && g[7] === 1) return false; // ::1 loopback
  if (g.every((h) => h === 0)) return false; // :: unspecified
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — judge the embedded v4,
  // otherwise ::ffff:127.0.0.1 sails straight past a v6-only check.
  if (isZeroPrefix(5) && g[5] === 0xffff) {
    return isGloballyRoutableIpv4(ipv4FromHextets(g[6] as number, g[7] as number));
  }
  if (isZeroPrefix(6) && !(g[6] === 0 && g[7] === 0)) {
    return isGloballyRoutableIpv4(ipv4FromHextets(g[6] as number, g[7] as number));
  }

  const first = g[0] as number;
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (first === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // 100::/64 discard
  if (first === 0x2001 && (g[1] as number) === 0x0db8) return false; // 2001:db8::/32 doc
  if (first === 0x2002) return false; // 2002::/16 6to4
  return true;
}

function ipv4FromHextets(hi: number, lo: number): string {
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
}

/** True only for a literal IP that is globally routable. */
export function isGloballyRoutableIp(value: string): boolean {
  const v = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (parseIpv4(v) !== null) return isGloballyRoutableIpv4(v);
  if (v.includes(':')) return isGloballyRoutableIpv6(v);
  return false; // not an IP literal at all
}

// ---------------------------------------------------------------------------
// URL guard
// ---------------------------------------------------------------------------

/** Resolves a hostname to all of its addresses. */
async function resolveHost(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/**
 * The ONLY text a refusal carries to the caller. The detail (host, resolved
 * address, resolver error) is an oracle for internal infrastructure — a caller
 * pointing a URL at `postgres.example.com` would read back its address — so it
 * goes to the server log and nowhere else.
 */
export const SSRF_BLOCKED_MESSAGE = 'destination not allowed';

function blocked(detail: string): SsrfBlockedError {
  console.warn(`[ssrf-guard] refused: ${detail}`);
  return new SsrfBlockedError(SSRF_BLOCKED_MESSAGE);
}

/**
 * Throw unless `rawUrl` is safe to fetch server-side.
 *
 * Rejects: non-http(s) schemes (file:, gopher:, data:); literal IPs that are not
 * globally routable; and hostnames that resolve to ANY non-global address (all
 * answers must be public — one bad answer is enough to reach an internal host).
 */
export async function assertPublicUrl(
  rawUrl: string,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw blocked(`not a valid absolute URL: ${rawUrl}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw blocked(`scheme "${url.protocol}" is not allowed; only http and https may be fetched`);
  }

  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;

  if (host === '') throw blocked('URL has no host');

  // Literal IP — decide directly, never resolve.
  if (parseIpv4(host) !== null || host.includes(':')) {
    if (!isGloballyRoutableIp(host)) {
      throw blocked(`refusing to fetch a non-public address: ${host}`);
    }
    return url;
  }

  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch (err) {
    throw blocked(`cannot resolve host "${host}": ${(err as Error).message}`);
  }
  if (addresses.length === 0) {
    throw blocked(`host "${host}" resolved to no addresses`);
  }
  // EVERY answer must be public. A round-robin record mixing a public and an
  // internal address would otherwise be a coin-flip bypass.
  for (const addr of addresses) {
    if (!isGloballyRoutableIp(addr)) {
      throw blocked(`refusing to fetch "${host}": it resolves to non-public address ${addr}`);
    }
  }
  return url;
}

// ---------------------------------------------------------------------------
// safeFetch — the guarded fetch every user-supplied URL goes through
// ---------------------------------------------------------------------------

/** Redirect hops `safeFetch` follows by default, each one re-checked. */
export const SAFE_FETCH_MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SafeFetchOptions {
  /**
   * Hops to follow (each Location re-checked by `assertPublicUrl`). `0` means a
   * redirect is refused outright — use it when the request carries credentials
   * (s3's signed headers must never be replayed to another host).
   */
  maxRedirects?: number;
}

/**
 * `fetch` for a user-supplied URL. Checking only the FIRST URL and then letting
 * fetch follow redirects is no guard at all: a public host answering
 * `302 Location: http://10.43.0.1/` walks straight past it. So:
 *   - `assertPublicUrl` before every request, the first and every hop;
 *   - `redirect: 'manual'`, and a 3xx with a Location is followed by hand
 *     (at most `maxRedirects` hops, default 3), else refused;
 *   - 303, and 301/302 on a non-GET/HEAD, continue as a body-less GET (fetch
 *     spec semantics); 307/308 replay the method and body.
 * Otherwise it behaves like fetch. A refusal throws `SsrfBlockedError`.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? SAFE_FETCH_MAX_REDIRECTS;
  let current = rawUrl;
  let currentInit: RequestInit = { ...init, redirect: 'manual' };
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current);
    const response = await fetch(current, currentInit);
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || location === null) {
      return response;
    }
    if (hop >= maxRedirects) {
      throw blocked(`redirect refused after ${hop} hop(s) from ${rawUrl} (status ${response.status})`);
    }
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw blocked(`unparseable redirect Location from ${current}`);
    }
    const method = (currentInit.method ?? 'GET').toUpperCase();
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')
    ) {
      const { body: _body, ...rest } = currentInit;
      currentInit = { ...rest, method: method === 'HEAD' ? 'HEAD' : 'GET' };
    }
    current = next;
  }
}
