// tests/unit/utils/ssrf-guard.test.ts
//
// The guard's whole value is what it REFUSES, so these tests are weighted to
// the deny cases — above all `100.64.0.0/10`, the CGNAT range that is the entire
// Tailscale fleet on this infrastructure and the exact range core_app's guard
// missed. If someone "simplifies" this guard, one of these fails.

import { test, expect, describe } from 'bun:test';
import {
  isGloballyRoutableIp,
  isGloballyRoutableIpv4,
  isGloballyRoutableIpv6,
  parseIpv4,
  parseIpv6,
} from '../../../src/utils/ssrf-guard';

describe('parseIpv4 — reject the classic bypass encodings', () => {
  test('accepts a plain dotted quad', () => {
    expect(parseIpv4('127.0.0.1')).toBe(2130706433);
    expect(parseIpv4('0.0.0.0')).toBe(0);
    expect(parseIpv4('255.255.255.255')).toBe(4294967295);
  });

  test('rejects malformed quads', () => {
    for (const v of ['1.2.3', '1.2.3.4.5', '256.0.0.1', '1.2.3.-1', '', ' 1.2.3.4']) {
      expect(parseIpv4(v)).toBeNull();
    }
  });
});

describe('isGloballyRoutableIpv4 — the deny list', () => {
  test('REJECTS CGNAT 100.64.0.0/10 (the Tailscale fleet — core_app missed this)', () => {
    for (const ip of [
      '100.64.0.0',
      '100.64.0.1',
      '100.64.0.10', // a tailnet host
      '100.64.0.12', // another tailnet host
      '100.64.0.13', // another tailnet host
      '100.127.255.255', // top of the range
    ]) {
      expect(isGloballyRoutableIpv4(ip)).toBe(false);
    }
  });

  test('100.63.x and 100.128.x are OUTSIDE the /10 and stay allowed', () => {
    // Guards the mask arithmetic: a sloppy /8 or /16 would wrongly capture these.
    expect(isGloballyRoutableIpv4('100.63.255.255')).toBe(true);
    expect(isGloballyRoutableIpv4('100.128.0.0')).toBe(true);
  });

  test('rejects loopback, RFC1918, link-local and cloud metadata', () => {
    for (const ip of [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // AWS/GCP metadata
      '0.0.0.0',
    ]) {
      expect(isGloballyRoutableIpv4(ip)).toBe(false);
    }
  });

  test('172.15.x and 172.32.x are outside RFC1918 and stay allowed', () => {
    expect(isGloballyRoutableIpv4('172.15.255.255')).toBe(true);
    expect(isGloballyRoutableIpv4('172.32.0.0')).toBe(true);
  });

  test('rejects multicast, broadcast, test and benchmark ranges', () => {
    for (const ip of ['224.0.0.1', '239.255.255.255', '255.255.255.255', '192.0.2.1', '198.18.0.1']) {
      expect(isGloballyRoutableIpv4(ip)).toBe(false);
    }
  });

  test('allows genuinely public addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '217.160.28.34']) {
      expect(isGloballyRoutableIpv4(ip)).toBe(true);
    }
  });
});

describe('isGloballyRoutableIpv6', () => {
  test('rejects loopback, unspecified, ULA, link-local, multicast', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1']) {
      expect(isGloballyRoutableIpv6(ip)).toBe(false);
    }
  });

  test('rejects IPv4-mapped forms of private addresses', () => {
    // ::ffff:127.0.0.1 is loopback wearing a v6 costume — a v6-only check misses it.
    for (const ip of ['::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:100.64.0.1', '::127.0.0.1']) {
      expect(isGloballyRoutableIpv6(ip)).toBe(false);
    }
  });

  test('allows a public v6 address, including its v4-mapped form', () => {
    expect(isGloballyRoutableIpv6('2606:4700:4700::1111')).toBe(true);
    expect(isGloballyRoutableIpv6('::ffff:1.1.1.1')).toBe(true);
  });

  test('parses compressed and zoned forms', () => {
    expect(parseIpv6('fe80::1%eth0')).not.toBeNull();
    expect(isGloballyRoutableIpv6('fe80::1%eth0')).toBe(false);
    expect(parseIpv6('not:an:address:!')).toBeNull();
  });
});

describe('isGloballyRoutableIp — a hostname is never an IP', () => {
  test('returns false for non-literals', () => {
    for (const v of ['example.com', 'localhost', '', 'not-an-ip']) {
      expect(isGloballyRoutableIp(v)).toBe(false);
    }
  });

  test('accepts bracketed v6 literals as URL hosts carry them', () => {
    expect(isGloballyRoutableIp('[::1]')).toBe(false);
    expect(isGloballyRoutableIp('[2606:4700:4700::1111]')).toBe(true);
  });
});

