import { describe, it, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  VERSION_STAMP_MAX_BYTES,
  VERSION_STAMP_POINTER_MAX_CHARS,
  buildVersionStampPointer,
  insertVersionStamp,
  versionStampSerialisedBytes,
  versionStampSha256,
} from '../../../../src/services/improvement-cards/version-stamp';

/**
 * C1-46 — POST /api/cards/project `version_stamp`.
 *
 * The behaviour (row + pointer on a NEW card, neither on a dedupe / lease-loser,
 * no orphan row after a rollback, 422 over 512 chars, GET returns the stamp) was
 * proved against a real Postgres by the project-card-dedupe integration suite,
 * deleted 2026-10-29 — no longer in the suite.
 * This file pins the pure pieces and the PLACEMENT in the route source that a
 * behavioural test cannot see from outside (modelled on
 * project-stamps-tenant.test.ts).
 */
describe('version-stamp helpers', () => {
  it('sha256 is over CANONICAL json — key order does not change it', () => {
    const a = { b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } };
    const b = { a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 };
    const expected = createHash('sha256')
      .update('{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}')
      .digest('hex');
    expect(versionStampSha256(a)).toBe(expected);
    expect(versionStampSha256(b)).toBe(expected);
    // Array order IS semantic.
    expect(versionStampSha256({ x: [1, 2] })).not.toBe(versionStampSha256({ x: [2, 1] }));
  });

  it('the pointer is exactly {"store":"fr","sha256":<hex>} and far under the ceiling', () => {
    const sha = versionStampSha256({ k: 'v' });
    const p = buildVersionStampPointer(sha);
    expect(JSON.parse(p)).toStrictEqual({ store: 'fr', sha256: sha });
    expect(p).toBe(`{"store":"fr","sha256":"${sha}"}`);
    expect(p.length).toBeLessThanOrEqual(VERSION_STAMP_POINTER_MAX_CHARS);
    expect(VERSION_STAMP_POINTER_MAX_CHARS).toBe(512);
  });

  it('insertVersionStamp refuses an empty card id before touching the DB', async () => {
    let err: unknown;
    try {
      await insertVersionStamp({ cardId: '', projectId: crypto.randomUUID(), stamp: {}, sha256: 'a'.repeat(64) });
    } catch (e) {
      err = e;
    }
    expect(String(err)).toContain('without a real card_id');
  });
});

describe('POST /api/cards/project — version_stamp placement in the route', () => {
  const src = readFileSync(
    join(import.meta.dir, '../../../../src/routes/cards/project.ts'),
    'utf8',
  );

  it('accepts version_stamp as an optional object in CreateProjectCardSchema', () => {
    const schema = src.slice(src.indexOf('const CreateProjectCardSchema'));
    const end = schema.indexOf('\n});');
    expect(schema.slice(0, end)).toContain('version_stamp: z.record(z.string(), z.unknown()).optional()');
  });

  it('the dedupe response path writes neither the row nor the pointer', () => {
    const start = src.indexOf('const dedupedResponse = async');
    const end = src.indexOf('// Open-card dedupe on `asset_id`');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).not.toContain('insertVersionStamp');
    expect(body).not.toContain("'version_stamp'");
    // Positive control: the slice really is the dedupe path.
    expect(body).toContain('deduped: true');
  });

  it('row insert precedes the pointer stamp, both inside the create-rollback try, guarded on a real card id', () => {
    const tryStart = src.indexOf("await stamp(metadata, 'card_type', parsed.card_type);");
    const guard = src.indexOf("if (typeof cardId !== 'string' || cardId.length === 0)");
    const insert = src.indexOf('versionStampRowInserted = await insertVersionStamp(');
    const pointer = src.indexOf("await stamp(metadata, 'version_stamp', versionStamp.pointer);");
    const catchDelete = src.indexOf('await deleteVersionStamp(cardId);');
    for (const i of [tryStart, guard, insert, pointer, catchDelete]) expect(i).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(tryStart);
    expect(insert).toBeGreaterThan(guard);
    expect(pointer).toBeGreaterThan(insert);
    // Nothing between the first stamp and the pointer leaves the try.
    // Comment lines are stripped: prose may say "return" without being code.
    const between = src
      .slice(tryStart, pointer)
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(between).not.toContain('} catch');
    expect(between).not.toMatch(/\breturn\b/);
    // Positive control: the code slice still holds the insert.
    expect(between).toContain('insertVersionStamp(');
    // The row delete lives in the catch AFTER the card delete, and only runs
    // when this request inserted the row and the card delete succeeded.
    const cardDelete = src.indexOf('await agent.cards.delete(cardId);');
    expect(catchDelete).toBeGreaterThan(cardDelete);
    expect(src).toContain('if (versionStampRowInserted && rolledBack) {');
  });

  it('the 422 guard runs before any Planka call', () => {
    const guard = src.indexOf('pointer.length > VERSION_STAMP_POINTER_MAX_CHARS');
    const firstPlanka = src.indexOf('agent.lists.listByBoard(');
    expect(guard).toBeGreaterThan(-1);
    expect(firstPlanka).toBeGreaterThan(guard);
    expect(src).toContain("error: 'version_stamp_pointer_too_long'");
  });

  it('the 64 KiB size cap answers 422 and runs before the lease, the suppression read and any Planka create', () => {
    const guard = src.indexOf('if (stampBytes > VERSION_STAMP_MAX_BYTES) {');
    expect(guard).toBeGreaterThan(-1);
    // The guard returns a 422 naming the field and the limit.
    const block = src.slice(guard, src.indexOf('const sha256 = versionStampSha256(parsed.version_stamp);'));
    expect(block).toContain("error: 'version_stamp_too_large'");
    expect(block).toContain("field: 'version_stamp'");
    expect(block).toContain('max_bytes: VERSION_STAMP_MAX_BYTES');
    expect(block).toMatch(/\n\s*422,\n/);
    // Strictly greater-than: exactly the limit is accepted.
    expect(src).not.toContain('stampBytes >= VERSION_STAMP_MAX_BYTES');
    // Nothing that creates or reserves anything precedes it.
    for (const later of [
      'await isFindingSuppressed(',
      'agent.lists.listByBoard(',
      'await claimCreateLease(',
      'await agent.cards.create({',
      'versionStampRowInserted = await insertVersionStamp(',
    ]) {
      const i = src.indexOf(later);
      expect(i).toBeGreaterThan(guard);
    }
    // And it runs before the stamp is hashed (no work on an oversized body).
    expect(src.indexOf('const sha256 = versionStampSha256(parsed.version_stamp);')).toBeGreaterThan(guard);
  });
});

describe('version_stamp 64 KiB size cap', () => {
  /** A stamp whose serialised form is exactly `n` UTF-8 bytes. */
  const stampOfBytes = (n: number, ch = 'a'): Record<string, unknown> => {
    const overhead = versionStampSerialisedBytes({ s: '' }); // {"s":""} = 8
    const unit = Buffer.byteLength(ch, 'utf8');
    const s = { s: ch.repeat((n - overhead) / unit) };
    expect(versionStampSerialisedBytes(s)).toBe(n);
    return s;
  };
  const overCap = (stamp: Record<string, unknown>) =>
    versionStampSerialisedBytes(stamp) > VERSION_STAMP_MAX_BYTES;

  it('the limit is exactly 64 KiB (65536 bytes)', () => {
    expect(VERSION_STAMP_MAX_BYTES).toBe(65536);
  });

  it('just over the limit is refused; just under and exactly at it are accepted — the boundary is exact', () => {
    expect(overCap(stampOfBytes(VERSION_STAMP_MAX_BYTES + 1))).toBe(true);
    expect(overCap(stampOfBytes(VERSION_STAMP_MAX_BYTES))).toBe(false);
    expect(overCap(stampOfBytes(VERSION_STAMP_MAX_BYTES - 1))).toBe(false);
    // Mutant control: a `>=` cap, or a cap of MAX-1 / MAX+1, flips exactly one
    // of the three lines above (the route's operator is pinned by source above).
  });

  it('counts UTF-8 BYTES, not JS string length', () => {
    // 'é' is 1 UTF-16 unit but 2 UTF-8 bytes: a length-based cap would let
    // this ~2x-oversized stamp through.
    const s = stampOfBytes(VERSION_STAMP_MAX_BYTES + 2, 'é');
    expect(JSON.stringify(s).length).toBeLessThan(VERSION_STAMP_MAX_BYTES);
    expect(overCap(s)).toBe(true);
  });
});
