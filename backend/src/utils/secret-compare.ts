// src/utils/secret-compare.ts
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string equality for secrets (webhook secrets, shared HMACs,
 * API tokens). String `===` is fast-path: it short-circuits on the first
 * mismatching byte, so the time-to-reject leaks the length of the matching
 * prefix. Buffers of unequal length skip the timing-safe compare entirely
 * (length is itself a fingerprint), but pad-and-compare would leak the
 * shorter input's length anyway, so returning false on length mismatch is
 * the standard contract.
 */
export function timingSafeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Per-process random key for `timingSafeEqualsHmac`. It never leaves memory and
// only has to be unknown to a remote caller; a restart rotating it is harmless.
const HMAC_COMPARE_KEY = randomBytes(32);

/**
 * Constant-time string equality that does NOT early-exit on a length mismatch.
 * Both inputs are HMAC'd (SHA-256, per-process random key) to fixed 32-byte
 * digests, which are then compared with `timingSafeEqual`. The time to reject
 * is therefore independent of both the matching prefix AND the presented
 * length — use this where even the secret's length must not be probeable
 * (e.g. a caller token on an internal route).
 */
export function timingSafeEqualsHmac(a: string, b: string): boolean {
  const da = createHmac('sha256', HMAC_COMPARE_KEY).update(a, 'utf8').digest();
  const db = createHmac('sha256', HMAC_COMPARE_KEY).update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}
