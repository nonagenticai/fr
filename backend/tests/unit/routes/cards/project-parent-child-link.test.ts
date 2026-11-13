import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';


/**
 * `POST /api/cards/project` used to write only the CHILD's `parent_card` pointer
 * and never touch the PARENT's `child_cards` array — the string `child_cards`
 * did not appear in the route file at all.
 *
 * That is not a cosmetic asymmetry. Every consumer that reasons about a parent's
 * children reads the PARENT's array:
 *
 *   - n8n `done-finalize.json :: Build Dep Check` reads `Relations.child_cards`,
 *     and `Compute Progression` advances the parent only when
 *     `blocking.length > 0` AND every child sits in DONE. With an empty array
 *     `blocking.length === 0`, so `advance` stays FALSE and the parent can NEVER
 *     progress — children complete and the parent waits forever.
 *   - `todo-pickup.json :: Read Card Deps` reads the same array.
 *
 * So a card created through this route was structurally invisible to the very
 * machinery meant to track it.
 */
describe('POST /api/cards/project — parent/child link', () => {
  const routeSrc = readFileSync(
    join(import.meta.dir, '../../../../src/routes/cards/project.ts'),
    'utf8',
  );

  it('links BOTH sides via linkParentChild, not a one-sided parent_card stamp', () => {
    // Strip comments before asserting. The first draft of this test failed
    // against its own fix, because the explanatory comment in the route quotes
    // the defective call verbatim ("this used to be stamp(relations, …)") and a
    // raw substring match cannot tell prose from code. Documenting the old shape
    // is exactly what you want next to a fix, so the test must read CODE.
    const code = routeSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(code).toContain('linkParentChild');
    // The precise defect: stamping parent_card directly writes the child's
    // pointer only. If this reappears, the parent's child_cards silently stops
    // being maintained and every consumer above goes blind.
    expect(code).not.toContain("stamp(relations, 'parent_card'");
  });
});
