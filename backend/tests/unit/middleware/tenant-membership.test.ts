// tests/unit/middleware/tenant-membership.test.ts
//
// fr#1385 Option 1 — the shared tenant-membership predicate. The vector file is
// a CONTRACT with worker_management: it must stay byte-identical on both sides,
// so its sha256 is pinned here. A change to the vectors is a change to BOTH
// repos, never to one.

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tokenProvesTenant } from '../../../src/middleware/tenant-membership';

const FIXTURE = join(
  import.meta.dir,
  '../../fixtures/tenant-membership/tenant_membership_vectors.json',
);
const FIXTURE_SHA256 = '65f15aa451bf31c966453c0eddf2a04efc3c1a247f6536631607b049eb74a478';

type Vector = {
  name: string;
  claims: Record<string, unknown>;
  effective: string | null;
  proven: boolean;
};

const raw = readFileSync(FIXTURE);
const vectors = (JSON.parse(raw.toString('utf8')) as { vectors: Vector[] }).vectors;

describe('tenant_membership_vectors.json (shared with worker_management)', () => {
  test('is byte-identical to the pinned contract', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(FIXTURE_SHA256);
  });

  test('carries both verdicts (non-vacuity)', () => {
    // No vector count: the sha256 pin above fails on any change to the file.
    expect(vectors.some((v) => v.proven)).toBe(true);
    expect(vectors.some((v) => !v.proven)).toBe(true);
  });

  for (const v of vectors) {
    test(`vector: ${v.name} → ${v.proven}`, () => {
      expect(tokenProvesTenant(v.claims, v.effective)).toBe(v.proven);
    });
  }
});

describe('tokenProvesTenant — inputs outside the vector file', () => {
  test('missing claims or undefined effective is never proven', () => {
    expect(tokenProvesTenant(undefined, 'a')).toBe(false);
    expect(tokenProvesTenant(null, 'a')).toBe(false);
    expect(tokenProvesTenant({ tenant_id: 'a' }, undefined)).toBe(false);
  });

  test('a non-string tenant_id is never proven, even with a matching member', () => {
    expect(tokenProvesTenant({ tenant_id: 42, member_tenant_ids: ['b'] }, 'b')).toBe(false);
  });

  test('a non-string / non-array member claim grants nothing', () => {
    expect(tokenProvesTenant({ tenant_id: 'a', member_tenant_ids: { b: true } }, 'b')).toBe(false);
  });
});
