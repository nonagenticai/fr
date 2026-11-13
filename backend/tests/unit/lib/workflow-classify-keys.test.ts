// tests/unit/lib/workflow-classify-keys.test.ts
//
// Key-scheme pins for the n8n facet-tag namespace. Nothing tested `slugify`,
// `facetTag` or `parseFacetTag` before this file.
//
// These are not in-process strings: `scripts/tag-n8n-workflows.ts` WRITES the
// produced tags into n8n, where they persist independently of this repo, and
// the read path (`routes/workflows.ts`) parses those stored tags back. A slug
// or separator change therefore does not "rename" anything — it forks the
// namespace: previously-tagged workflows keep the old tag, newly-tagged ones
// get the new one, and one facet silently becomes two with no error anywhere.
import { describe, expect, test } from 'bun:test';
import {
  FACET_NAMESPACES,
  FACET_SEP,
  facetTag,
  parseFacetTag,
  slugify,
} from '../../../src/lib/workflow-classify';

describe('slugify', () => {
  test('lowercases and collapses non-alphanumeric runs to a single dash', () => {
    expect(slugify('Kanban Board Sync!')).toBe('kanban-board-sync');
    expect(slugify('a___b')).toBe('a-b');
    expect(slugify('  Leading & trailing  ')).toBe('leading-trailing');
  });

  test('is idempotent — re-slugifying a slug is a no-op', () => {
    // The tagging script may re-derive from an already-slugified label; if this
    // were not idempotent the tag would drift on every re-run.
    const once = slugify('Kanban Board Sync!');
    expect(slugify(once)).toBe(once);
  });
});

describe('facetTag / parseFacetTag', () => {
  test('round-trips every owned namespace', () => {
    for (const facet of FACET_NAMESPACES) {
      expect(parseFacetTag(facetTag(facet, 'some-slug'))).toEqual({
        facet,
        slug: 'some-slug',
      });
    }
  });

  test('a slug containing the separator keeps its remainder intact', () => {
    // parseFacetTag splits on the FIRST separator only — a slug that itself
    // contains one must not be truncated.
    expect(parseFacetTag(`domain${FACET_SEP}a${FACET_SEP}b`)).toEqual({
      facet: 'domain',
      slug: `a${FACET_SEP}b`,
    });
  });

  test('plain / manual tags pass through as null', () => {
    expect(parseFacetTag('manual-tag')).toBeNull();
    expect(parseFacetTag('unknownfacet:x')).toBeNull();
    expect(parseFacetTag('domain:')).toBeNull(); // empty slug is not a facet tag
    expect(parseFacetTag(':x')).toBeNull(); // empty facet is not a facet tag
  });
});

// ---- SCHEME PIN ---------------------------------------------------------
// The assertions above are round-trips: they call facetTag and parseFacetTag
// from the same build, so flipping FACET_SEP from ':' to '-' keeps all of them
// green while every tag already stored in n8n stops parsing.
//
// The source calls FACET_SEP "the ONLY place the separator is defined" and
// notes it was probe-verified against n8n's Public API. That makes the literal
// below the actual contract with the persisted data.
//
// If this fails you have changed the tag format. That is a BREAKING change
// requiring a re-tag of every existing n8n workflow — not an expected-value
// update.
describe('facet tag scheme is frozen', () => {
  test('separator and namespace list are the persisted contract', () => {
    expect(FACET_SEP).toBe(':');
    expect([...FACET_NAMESPACES]).toEqual(['domain', 'purpose', 'stage', 'trigger']);
  });

  test('the emitted tag string is exact', () => {
    expect(facetTag('domain', 'kanban')).toBe('domain:kanban');
    expect(facetTag('trigger', slugify('On Schedule'))).toBe('trigger:on-schedule');
  });
});
