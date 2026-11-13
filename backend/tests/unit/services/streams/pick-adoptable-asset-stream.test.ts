// tests/unit/services/streams/pick-adoptable-asset-stream.test.ts
//
// Cover for the duplicate-stream fix in services/streams/provisioner.ts.
//
// The measured defect (live, 2026-09-11): tenant 0195f48b-…0002 owns TWO active
// streams for EACH of decision / principle / requirement. Migration 062 re-keyed
// `streams.tenant_id` from 00000000-…0001 to 0195f48b-…0002 without rewriting
// `slug` — which EMBEDS the tenant uuid — so `getOrCreateAssetStream`'s by-slug
// lookup missed a row it had created itself and minted a second one beside it.
//
// ⚠️ The duplication is same-KIND-same-TENANT, never same-SLUG: `GROUP BY slug
// HAVING count(*) > 1` returns zero rows on the live table. The test below pins
// that: the two rows in the duplicate fixture have DIFFERENT slugs, so a slug
// dedupe would find nothing.

import { describe, expect, test } from 'bun:test';

const { pickAdoptableAssetStream } = await import(
  '../../../../src/services/streams/provisioner'
);

const LEGACY_TENANT = '00000000-0000-4000-8000-000000000001';
const TENANT = '0195f48b-d000-7000-8000-000000000002';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function row(slug: string, createdAt: string, id = slug): any {
  return {
    id,
    tenant_id: TENANT,
    kind: 'decision',
    name: 'Asset Authoring — Decisions',
    slug,
    is_active: true,
    created_at: new Date(createdAt),
  };
}

// The live pair, verbatim: same tenant, same kind, DIFFERENT slugs — the
// younger one carries the current tenant uuid, the older the legacy one.
const LEGACY_SLUGGED = row(
  `asset-authoring-decision-${LEGACY_TENANT}`,
  '2026-05-08T00:00:00Z',
  'older',
);
const CURRENT_SLUGGED = row(
  `asset-authoring-decision-${TENANT}`,
  '2026-05-22T00:00:00Z',
  'younger',
);

describe('pickAdoptableAssetStream', () => {
  test('adopts the re-tenanted legacy-slug row instead of minting a second', () => {
    // The whole defect in one assertion: at the moment migration 062 landed,
    // only LEGACY_SLUGGED existed and the by-slug lookup missed it.
    expect(pickAdoptableAssetStream([LEGACY_SLUGGED], 'decision')?.id).toBe('older');
  });

  test('the two live rows have DIFFERENT slugs — a slug dedupe finds nothing', () => {
    expect(LEGACY_SLUGGED.slug).not.toBe(CURRENT_SLUGGED.slug);
    expect(new Set([LEGACY_SLUGGED.slug, CURRENT_SLUGGED.slug]).size).toBe(2);
  });

  test('oldest wins when both halves of the pair already exist', () => {
    // `listStreamsByKind` returns created_at ASC; the incumbent is adopted so
    // repeated calls are stable rather than planner-order dependent.
    expect(
      pickAdoptableAssetStream([LEGACY_SLUGGED, CURRENT_SLUGGED], 'decision')?.id,
    ).toBe('older');
  });

  test('EXCLUDES an operator-created stream with its own slug', () => {
    // Narrowing that keeps this from hijacking a deliberate second stream: only
    // a slug this function itself could have produced is adoptable.
    const operatorStream = row('q3-pricing-decisions', '2026-04-01T00:00:00Z', 'op');
    expect(pickAdoptableAssetStream([operatorStream], 'decision')).toBeUndefined();
  });

  test('EXCLUDES a same-tenant stream of a DIFFERENT kind', () => {
    // The prefix carries the kind, so a principle stream can never be adopted
    // as the decision one even though listStreamsByKind is kind-scoped too.
    const principle = row(
      `asset-authoring-principle-${TENANT}`,
      '2026-04-01T00:00:00Z',
      'principle',
    );
    expect(pickAdoptableAssetStream([principle], 'decision')).toBeUndefined();
  });

  test('no siblings → undefined, so the create path still runs', () => {
    // Mutation control on over-adoption: a version that returned siblings[0]
    // unconditionally would break first-ever provisioning.
    expect(pickAdoptableAssetStream([], 'decision')).toBeUndefined();
  });
});
