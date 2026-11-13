// tests/unit/bridge-dedup.test.ts
//
// Unit coverage for the pure bridge dedup key primitives.
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  computeContentDigest,
  computeStableId,
  outputIdsKey,
} from '../../src/domain/bridge/dedup';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

describe('computeStableId', () => {
  test('coding: sha256("coding|<tool>|<rule_id>|<file_path>|<line_number>")', () => {
    const got = computeStableId({
      producer: 'coding',
      tool: 'pylint',
      rule_id: 'E501',
      file_path: 'src/foo.py',
      line_number: 42,
    });
    const expected = sha256Hex('coding|pylint|E501|src/foo.py|42');
    expect(got).toBe(expected);
  });

  test('kag: sha256("kag|<session_id>|<url>")', () => {
    const got = computeStableId({
      producer: 'kag',
      session_id: 'sess-1',
      url: 'https://example.com/a',
    });
    const expected = sha256Hex('kag|sess-1|https://example.com/a');
    expect(got).toBe(expected);
  });

  test('artifacts: sha256("artifacts|<artifact_id>|<version>")', () => {
    const got = computeStableId({
      producer: 'artifacts',
      artifact_id: 'art-1',
      version: 'v3',
    });
    const expected = sha256Hex('artifacts|art-1|v3');
    expect(got).toBe(expected);
  });

  test('different inputs produce different ids', () => {
    const a = computeStableId({
      producer: 'kag',
      session_id: 's1',
      url: 'u',
    });
    const b = computeStableId({
      producer: 'kag',
      session_id: 's2',
      url: 'u',
    });
    expect(a).not.toBe(b);
  });
});

describe('computeContentDigest', () => {
  test('whitespace-insensitive', () => {
    const a = computeContentDigest('Hello  World', 'body  text');
    const b = computeContentDigest('Hello World', 'body text');
    expect(a).toBe(b);
  });

  test('case-insensitive', () => {
    const a = computeContentDigest('HELLO', 'BODY');
    const b = computeContentDigest('hello', 'body');
    expect(a).toBe(b);
  });

  test('leading/trailing whitespace ignored', () => {
    const a = computeContentDigest('  hi  ', '  body  ');
    const b = computeContentDigest('hi', 'body');
    expect(a).toBe(b);
  });

  test('different content -> different digest', () => {
    const a = computeContentDigest('a', 'x');
    const b = computeContentDigest('b', 'x');
    expect(a).not.toBe(b);
  });

  // The `\n` between the normalised title and body is a field separator, not
  // cosmetic: without it ("ab", "c") and ("a", "bc") both digest "abc" and two
  // unrelated findings dedup onto one card. None of the assertions above would
  // notice — they only compare a digest to another digest from the same build.
  test('the title/body separator makes field boundaries unambiguous', () => {
    expect(computeContentDigest('ab', 'c')).not.toBe(computeContentDigest('a', 'bc'));
  });
});

// ===========================================================================
// DIGEST PINS — these three keys are CROSS-SYSTEM COMPATIBILITY CONTRACTS
// ===========================================================================
//
// `stable_id` and `content_digest` are PERSISTED (card_bridge_links.stable_id /
// .content_digest) and looked up with `=` on every subsequent bridge run;
// `metadata.output_ids_key` likewise (card_drafts, queried via `->>`). As
// dedup.ts's own header puts it: "change the formula here and you orphan every
// previously-promoted card" — every stored row silently stops matching, so a
// re-analysis promotes DUPLICATE cards for findings already on the board
// instead of deduping onto them.
//
// The formula assertions above are stronger than a bare regex, but they still
// RE-IMPLEMENT the preimage in the test file (`sha256Hex('coding|pylint|…')`).
// A single find-and-replace across src/ and tests/ — say, swapping the `|`
// separator — moves both sides together and stays green. Frozen literals cannot
// be re-derived by a mechanical edit, so they are what actually holds the line.
//
// If one of these fails you have changed the wire format. That is a BREAKING
// change requiring a producer-side version bump and a backfill plan for the
// existing card_bridge_links rows — NOT an expected-value update.
//
// (These values were generated from the current implementation and
// cross-checked against the independently-written formula tests above.)
describe('bridge dedup key schemes are frozen', () => {
  test('computeStableId — coding', () => {
    expect(
      computeStableId({
        producer: 'coding',
        tool: 'pylint',
        rule_id: 'E501',
        file_path: 'src/foo.py',
        line_number: 42,
      }),
    ).toBe('ddef69595a6f70bb4292d2a52a7ec27718d3e3b95036530796d1d3191a17a1b0');
  });

  test('computeStableId — kag', () => {
    expect(
      computeStableId({
        producer: 'kag',
        session_id: 'sess-1',
        url: 'https://example.com/a',
      }),
    ).toBe('933306c9499a8d5d4300891affd044b0c447f59e9682eee13cd7f2bfd675fb5c');
  });

  test('computeStableId — artifacts', () => {
    expect(
      computeStableId({
        producer: 'artifacts',
        artifact_id: 'art-1',
        version: 'v3',
      }),
    ).toBe('1add1cc74d14aac606be57942227434daee3e661c3db22426d0cb1fcea1f2fb7');
  });

  test('computeContentDigest', () => {
    expect(computeContentDigest('Hello World', 'body text')).toBe(
      'eb20f087c1e1082e83fc77a7f513e89bfc71e9bc787fa70db5b494955c293c3a',
    );
  });

  // `outputIdsKey` is a plain canonical string rather than a digest, but it is
  // the same kind of contract: `agui/actions/bridge.ts` and `routes/tools/bridge.ts`
  // must produce byte-identical keys (a route-stamped key has to match an
  // action-stamped one), and the value is compared against the stored
  // `metadata->>'output_ids_key'` of drafts written by earlier releases.
  test('outputIdsKey — sorted JSON array, stable under permutation', () => {
    expect(outputIdsKey(['out-c', 'out-a', 'out-b'])).toBe('["out-a","out-b","out-c"]');
    expect(outputIdsKey(['out-a', 'out-b', 'out-c'])).toBe('["out-a","out-b","out-c"]');
    expect(outputIdsKey([])).toBe('[]');
  });

  // Sorting must not mutate the caller's array — `agui/actions/bridge.ts` reuses
  // `input.output_ids` after stamping the key.
  test('outputIdsKey does not mutate its input', () => {
    const ids = ['out-c', 'out-a'];
    outputIdsKey(ids);
    expect(ids).toEqual(['out-c', 'out-a']);
  });
});
