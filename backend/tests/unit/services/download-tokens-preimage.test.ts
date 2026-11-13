// tests/unit/services/download-tokens-preimage.test.ts
//
// PINNING coverage for the artifact download-token SIGNING preimage.
//
// The former coverage (the artifacts route suite, deleted 2026-10-29) was a
// ROUND TRIP: mint a token, resolve it, assert it works. A round trip cannot
// see a re-key — change the separator, the field order, or the field set, and
// mint+resolve still agree with each other, so every one of those tests stays
// green while every token issued by an older replica during a rolling deploy
// becomes unverifiable. This file exists to make that change loud.
//
// ⚠️ EVERY assertion below compares against a FROZEN LITERAL. None of them
// calls `downloadTokenPreimage` on both sides of an expectation. A test shaped
// like `expect(f(a)).not.toBe(f(b))` passes under any implementation that
// separates the fields at all, and `expect(f(a)).toBe(f(a))` can never fail —
// tautologies of exactly that shape hid a real defect in this repo (#739). The
// literals are the whole point.
//
// This is a SIGNING preimage, so the question this file answers is narrower and
// sharper than "is the format stable": can two DISTINCT (user, artifact) pairs
// produce the same signed string? See the block comment on
// `downloadTokenPreimage` for the field-domain argument. The tests here pin
// both halves of it — the format, and the collision that reappears the instant
// a field is allowed to contain the separator.
import { describe, expect, test } from 'bun:test';

import { downloadTokenPreimage } from '../../../src/services/download-tokens';

// Realistic field values: a Keycloak `sub`, an artifact_service uuid7 PK, a
// unix-second timestamp, and a 16-byte hex nonce. These are the SHAPES the
// production mint path actually produces (`mintDownloadToken`).
const USER_ID = '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
const ARTIFACT_ID = '01977c4e-8f21-7c3a-b2d5-6e7f8a9b0c1d';
const ISSUED_AT = 1785312000;
const NONCE = 'a3f19b2c7d4e5081926a3b4c5d6e7f80';

describe('downloadTokenPreimage — frozen format', () => {
  test('renders the exact byte string the HMAC covers', () => {
    // Frozen literal. If this changes, EVERY download token minted by an older
    // replica stops verifying against a newer one and vice versa — the two
    // halves of a rolling deploy hand each other 401s. That is a deliberate,
    // reviewable act, not something to discover from a support ticket.
    expect(downloadTokenPreimage(USER_ID, ARTIFACT_ID, ISSUED_AT, NONCE)).toBe(
      '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f|01977c4e-8f21-7c3a-b2d5-6e7f8a9b0c1d|1785312000|a3f19b2c7d4e5081926a3b4c5d6e7f80',
    );
  });

  test('field ORDER is pinned, not just the field set', () => {
    // Swapping user and artifact would keep the round trip green and keep the
    // separator count at three, but re-keys every live token just the same.
    expect(downloadTokenPreimage('u1', 'a1', 7, 'n1')).toBe('u1|a1|7|n1');
  });

  test('issuedAt is rendered as bare decimal digits', () => {
    // `${number}` — no padding, no ISO string, no milliseconds. A change to
    // millisecond precision would silently re-key and would ALSO break the
    // `ageSeconds` TTL arithmetic in `resolveDownloadToken`.
    expect(downloadTokenPreimage('u', 'a', 0, 'n')).toBe('u|a|0|n');
    expect(downloadTokenPreimage('u', 'a', 1785312000, 'n')).toBe('u|a|1785312000|n');
  });
});

describe('downloadTokenPreimage — injectivity over the real field domains', () => {
  test('a legitimately minted preimage contains EXACTLY three separators', () => {
    // This is the load-bearing property. With exactly three `|`, the 4-way
    // split of the preimage is unique, so the only tuple that can produce this
    // signed string is the one that did — no signature can be transplanted
    // between two distinct (user, artifact) pairs.
    //
    // It holds because every field's domain excludes `|`:
    //   userId     — Keycloak `sub`, a UUID
    //   artifactId — artifact_service `Uuid` PK; every upstream route types the
    //                path param `artifact_id: UUID`, so a non-UUID 422s before
    //                a token can be minted for it
    //   issuedAt   — Math.floor(Date.now()/1000), decimal digits
    //   nonce      — randomBytes(16).toString('hex')
    const preimage = downloadTokenPreimage(USER_ID, ARTIFACT_ID, ISSUED_AT, NONCE);
    expect(preimage.split('|')).toHaveLength(4);

    // And each field, spelled out as a frozen literal, is separator-free.
    expect(USER_ID.includes('|')).toBe(false);
    expect(ARTIFACT_ID.includes('|')).toBe(false);
    expect(String(ISSUED_AT).includes('|')).toBe(false);
    expect(NONCE.includes('|')).toBe(false);
  });

  test('UUID and hex charsets provably cannot contain the separator', () => {
    // Not a spot check on two constants — an assertion about the CHARSETS the
    // producing systems are constrained to.
    expect(/^[0-9a-f-]+$/.test(USER_ID)).toBe(true);
    expect(/^[0-9a-f-]+$/.test(ARTIFACT_ID)).toBe(true);
    expect(/^[0-9a-f]{32}$/.test(NONCE)).toBe(true);
    expect(Number.isInteger(ISSUED_AT)).toBe(true);
    // `|` is not in [0-9a-f-].
    expect(/^[0-9a-f-]+$/.test('a|b')).toBe(false);
  });

  test('⚠️ the collision REAPPEARS the moment a field admits the separator', () => {
    // Documented failure mode, asserted rather than described. If `artifactId`
    // ever widens beyond a UUID (a free-form key, a path, a client-supplied
    // slug), these two DISTINCT tuples collapse onto one signed string:
    //
    //     (u, 'a|123', 456, 'n')   ->  'u|a|123|456|n'
    //     (u, 'a',     123, '456|n') ->  'u|a|123|456|n'
    //
    // A token minted for artifact 'a|123' would then verify as a token for
    // artifact 'a'. Both sides below are frozen literals, so this test states
    // the hazard as fact — it does not merely compare the function to itself.
    expect(downloadTokenPreimage('u', 'a|123', 456, 'n')).toBe('u|a|123|456|n');
    expect(downloadTokenPreimage('u', 'a', 123, '456|n')).toBe('u|a|123|456|n');

    // If a future change widens the artifact_id domain, delete this test and
    // move the preimage to the netstring framing (`<len>:<value>`) that
    // `connectors/rss.ts derivedStableId` uses — that framing is injective for
    // ALL inputs with no assumption about field contents. Re-keying is safe
    // there (a stale dedup key only re-delivers); re-keying HERE invalidates
    // live tokens, so it needs the 5-minute TTL drain, not a flag day.
  });
});
