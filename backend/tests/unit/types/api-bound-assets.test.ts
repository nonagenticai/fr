// tests/unit/types/api-bound-assets.test.ts
//
// ProjectCreateSchema.bound_assets — picker selections sent from
// /projects/new.

import { describe, expect, test } from 'bun:test';
import {
  ProjectCreateSchema,
  BoundAssetsSchema,
  PROJECT_BOUND_ASSET_KINDS,
} from '../../../src/types/api';

describe('ProjectCreateSchema.bound_assets', () => {
  test('is optional when omitted', () => {
    const parsed = ProjectCreateSchema.parse({
      name: 'p',
      repository_url: 'https://example.com/repo',
    });
    expect(parsed.bound_assets).toBeUndefined();
  });

  test('accepts per-kind id arrays for every supported kind', () => {
    const all = Object.fromEntries(
      PROJECT_BOUND_ASSET_KINDS.map((k, i) => [k, [`id-${i}`]]),
    );
    const parsed = ProjectCreateSchema.parse({
      name: 'p',
      repository_url: 'https://example.com/repo',
      bound_assets: all,
    });
    expect(parsed.bound_assets).toBeDefined();
    for (const k of PROJECT_BOUND_ASSET_KINDS) {
      expect(parsed.bound_assets![k]).toEqual([`id-${PROJECT_BOUND_ASSET_KINDS.indexOf(k)}`]);
    }
  });

  test('rejects unknown asset kinds (strict)', () => {
    expect(() =>
      BoundAssetsSchema.parse({
        requirement: ['r1'],
        bogus_kind: ['x'],
      } as unknown),
    ).toThrow();
  });

  test('rejects empty string ids', () => {
    expect(() =>
      BoundAssetsSchema.parse({
        requirement: [''],
      }),
    ).toThrow();
  });

  test('allows partial selection (one kind only)', () => {
    const parsed = ProjectCreateSchema.parse({
      name: 'p',
      repository_url: 'https://example.com/repo',
      bound_assets: { kag_document: ['doc-1', 'doc-2'] },
    });
    expect(parsed.bound_assets?.kag_document).toEqual(['doc-1', 'doc-2']);
    expect(parsed.bound_assets?.requirement).toBeUndefined();
  });
});
