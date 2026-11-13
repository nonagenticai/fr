// The Copilot reads each pack's instructions.md from disk on every turn. A root
// .dockerignore `**/*.md` rule kept them out of the image and every turn failed
// with ENOENT in prod (2026-10-27). Boot now asserts them; these tests pin both
// the assertion and the .dockerignore exception that keeps the files in the image.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { FR_PACKS, assertPackInstructionsPresent, packInstructions } from '../../../src/agent/packs';

describe('agent pack instructions', () => {
  test('every pack has non-empty instructions.md and the boot assertion passes', () => {
    for (const id of Object.keys(FR_PACKS) as (keyof typeof FR_PACKS)[]) {
      expect(packInstructions(id).length).toBeGreaterThan(0);
    }
    expect(() => assertPackInstructionsPresent()).not.toThrow();
  });

  test('the image build context keeps the pack markdown (root .dockerignore re-includes it after **/*.md)', () => {
    const lines = readFileSync(new URL('../../../../.dockerignore', import.meta.url), 'utf8')
      .split('\n')
      .map((l) => l.trim());
    const exclude = lines.indexOf('**/*.md');
    const include = lines.indexOf('!backend/src/agent/packs/**/*.md');
    expect(include).toBeGreaterThan(-1);
    expect(exclude === -1 || include > exclude).toBe(true);
  });
});
