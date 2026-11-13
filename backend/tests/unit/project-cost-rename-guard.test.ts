// tests/unit/project-cost-rename-guard.test.ts
//
// A RENAME, not an alias. The per-project cost response used to carry a field
// named as a total that was not one: billing only ever knew the spend that
// arrived carrying this project's id, and that id is emitted only for a project
// whose `keycloak_tenant_id` tag matches the caller's tenant. The field is now
// `attributed_usd`, and the old name must not survive anywhere — an alias kept
// "for compatibility" is precisely a supported way to keep reading the lie, and
// it would be invisible to every behavioural test in this PR because nothing
// would have to read it for it to exist.
//
// ⚠️ THIS FILE NEVER SPELLS THE FORBIDDEN TOKEN. It is assembled at runtime, so
// the guard cannot match its own source and report itself as a violation — the
// one-directional blindness that makes a self-matching guard either permanently
// red or quietly excluded.
//
// ⚠️ It also must not catch `monthly_total_usd`, a DIFFERENT and legitimate field
// on the plan/usage surface (routes/me/usage.ts). `\b` treats `_` as a word
// character, so a word-boundary match cannot fire inside that longer name — and
// the positive control below proves the instrument still discriminates.

import { test, expect, describe } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Assembled, never written literally — see the header. */
const FORBIDDEN = ['total', 'usd'].join('_');
const FORBIDDEN_RE = new RegExp(`\\b${FORBIDDEN}\\b`);

/** repo root: .../backend/tests/unit → up three. */
const REPO = join(import.meta.dir, '..', '..', '..');
const ROOTS = [
  join(REPO, 'backend', 'src'),
  join(REPO, 'backend', 'tests'),
  join(REPO, 'frontend', 'src'),
];
const EXT = ['.ts', '.svelte'];
const SELF = relative(REPO, import.meta.path);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

describe('the old project-cost field name is gone from the tree', () => {
  test('no source or test file mentions it', () => {
    const files = ROOTS.flatMap((r) => walk(r));
    // Sanity: a walk that found nothing would pass vacuously. Non-vacuity only —
    // no count of the tree is pinned.
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(REPO, f);
      if (rel === SELF) continue;
      if (FORBIDDEN_RE.test(readFileSync(f, 'utf8'))) offenders.push(rel);
    }
    // KILLED BY: re-adding the field to `ProjectCostResponse`, to the cockpit
    // `ProjectCost` payload, or to either frontend type mirror — whether as the
    // real field or as a deprecated alias.
    expect(offenders).toEqual([]);
  });

  test('positive control: the instrument fires, and spares the plan-surface field', () => {
    // Without this, an always-empty `offenders` would be indistinguishable from a
    // broken regex or a mis-rooted walk.
    expect(FORBIDDEN_RE.test(`const x = { ${FORBIDDEN}: 1 };`)).toBe(true);
    expect(FORBIDDEN_RE.test(`const x = { monthly_${FORBIDDEN}: '0.00' };`)).toBe(false);
    expect(FORBIDDEN_RE.test('const x = { attributed_usd: 1 };')).toBe(false);
    expect(FORBIDDEN_RE.test('const x = { total_cost_usd: 1 };')).toBe(false);
  });
});
