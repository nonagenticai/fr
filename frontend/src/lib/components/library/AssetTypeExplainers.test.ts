// Smoke test: every AssetType key in /library/[type]/+page.svelte's
// VALID_TYPES must have an explainer. If a new type is added there
// without a copy entry, this test catches it.

import { describe, it, expect } from 'vitest';
import { ASSET_EXPLAINERS, type AssetTypeKey } from './AssetTypeExplainers';

const REQUIRED_KEYS: AssetTypeKey[] = [
  'requirement',
  'principle',
  'decision',
  'kag_document',
  'workflow',
  'trigger',
  'artifact',
  'channel',
];

describe('ASSET_EXPLAINERS', () => {
  it('has an entry for every AssetType', () => {
    for (const k of REQUIRED_KEYS) {
      expect(ASSET_EXPLAINERS[k]).toBeDefined();
      expect(ASSET_EXPLAINERS[k].what).toMatch(/\S/);
      expect(ASSET_EXPLAINERS[k].how).toMatch(/\S/);
      expect(ASSET_EXPLAINERS[k].agentPrompt).toMatch(/\S/);
    }
  });

  it('agentPrompt ends with a trailing space (so caller can append target text)', () => {
    for (const k of REQUIRED_KEYS) {
      expect(ASSET_EXPLAINERS[k].agentPrompt.endsWith(' ')).toBe(true);
    }
  });
});
