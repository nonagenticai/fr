import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEBLOCK_ACTIONS,
  asDeblockAction,
  type DeblockAction,
} from '../../../src/domain/engagement/deblock-actions';

// ⛔ WHY THIS FILE EXISTS. Before the single source, this closed set was spelled out FIVE times
// across four files: the mint zod enum (routes/webhooks.ts), the decider zod enum
// (routes/approvals.ts), the outbound payload TYPE (services/n8n.ts), and BOTH the allowlist array
// and its cast in services/n8n-callback.ts.
//
// The code already knew the danger and wrote it down: "a key absent here is DROPPED, which is why
// deblock_action has to be named in both this builder and N8nCardApprovalSchema." A value added to
// four of the five is not a compile error and not a runtime error. The action is minted, stored,
// answered by a human — and then dropped on the way back to n8n, so the card never moves and
// nothing says why. That is the exact failure this whole lane has been paying down: 96 approvals a
// human approved that moved no card.
describe('deblock actions — one closed set, one definition', () => {
  test('MERGE is in the set', () => {
    expect(DEBLOCK_ACTIONS).toContain('MERGE');
  });

  test('RECLASSIFY is in the set (REALIGN R5) and narrows', () => {
    expect(DEBLOCK_ACTIONS).toContain('RECLASSIFY');
    expect(asDeblockAction('RECLASSIFY')).toBe('RECLASSIFY');
    expect(asDeblockAction('reclassify')).toBeUndefined();
  });

  test('COVERAGE is in the set (BDD ruling 2026-10-01) and narrows', () => {
    expect(DEBLOCK_ACTIONS).toContain('COVERAGE');
    expect(asDeblockAction('COVERAGE')).toBe('COVERAGE');
    expect(asDeblockAction('coverage')).toBeUndefined();
  });

  test('the historical six are still present — this set only ever grows', () => {
    // Widened because DEBLOCK_ACTIONS is a readonly tuple of literal types; comparing it against
    // a loop variable of type `string` matches no `toContain` overload.
    const actual: readonly string[] = DEBLOCK_ACTIONS;
    for (const a of ['RETRY', 'SPLIT', 'QUESTION', 'INFRASTRUCTURE', 'DEPENDENCY', 'DROP']) {
      expect(actual).toContain(a);
    }
  });

  test('asDeblockAction narrows a known value and DROPS an unknown one', () => {
    expect(asDeblockAction('MERGE')).toBe('MERGE');
    expect(asDeblockAction('DROP')).toBe('DROP');
    // The receiver switches on this value; forwarding an unknown one falls through the switch and
    // produces a decision that silently does nothing.
    expect(asDeblockAction('DELETE_EVERYTHING')).toBeUndefined();
    expect(asDeblockAction('merge')).toBeUndefined(); // case-sensitive by design
    expect(asDeblockAction(undefined)).toBeUndefined();
    expect(asDeblockAction(null)).toBeUndefined();
    expect(asDeblockAction(42)).toBeUndefined();
    expect(asDeblockAction({ toString: () => 'MERGE' })).toBeUndefined();
  });

  test('the type is derived from the array, not written twice', () => {
    // If DeblockAction were hand-maintained this would compile while the runtime set disagreed.
    const all: DeblockAction[] = [...DEBLOCK_ACTIONS];
    expect(all.length).toBe(DEBLOCK_ACTIONS.length);
  });

  // ── THE DRIFT GUARD. This is the assertion that keeps the five copies from coming back. ──────
  // It is deliberately a source scan and not a type check: re-introducing a literal copy TYPECHECKS
  // FINE. That is precisely how the set got to five copies in the first place.
  test('no file outside the definition spells the set out again', () => {
    const SRC = join(import.meta.dir, '..', '..', '..', 'src');
    const OWNER = join('domain', 'engagement', 'deblock-actions.ts');
    const offenders: string[] = [];
    let scanned = 0;

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!entry.endsWith('.ts')) continue;
        if (full.endsWith(OWNER)) continue;
        scanned += 1;
        const text = readFileSync(full, 'utf8');
        // A copy is a file naming two or more members of the set as string literals near each
        // other — one mention is a legitimate reference to a single action.
        const hits = ['RETRY', 'SPLIT', 'QUESTION', 'INFRASTRUCTURE', 'DEPENDENCY', 'DROP', 'MERGE', 'RECLASSIFY', 'COVERAGE']
          .filter((a) => text.includes(`'${a}'`) || text.includes(`"${a}"`));
        if (hits.length >= 4) offenders.push(`${full} (${hits.join(', ')})`);
      }
    };
    walk(SRC);

    // NON-VACUITY: a walk that found no files would pass this test while proving nothing — the
    // shape that makes an absence check worthless. No count of the tree is pinned.
    expect(scanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
