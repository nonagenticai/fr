// tests/unit/routes/me-usage-funding-spec.test.ts
//
// fr-agui P4d-1 (P4-carry, from P4b part 3): the literal GET /api/me/usage/funding said it takes "the same
// params as /api/tenant/usage/breakdown minus actor_id" but declared none. The served spec now lists them;
// pinned against the tenant breakdown it mirrors, so the two cannot drift apart.
import { describe, expect, test } from 'bun:test';

import { openapiSpec } from '../../../src/capabilities/served-spec';

type Op = { parameters?: Array<{ name: string; in: string }> };
const paths = openapiSpec.paths as unknown as Record<string, Record<string, Op>>;
const names = (p: string) => (paths[p]!.get!.parameters ?? []).map((x) => `${x.in}:${x.name}`);

describe('GET /api/me/usage/funding declares its query', () => {
  test("the tenant breakdown's query parameters minus actor_id", () => {
    const tenant = names('/api/tenant/usage/breakdown');
    expect(tenant).toContain('query:actor_id');
    expect(names('/api/me/usage/funding')).toEqual(tenant.filter((n) => n !== 'query:actor_id'));
  });
});
