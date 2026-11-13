// tests/unit/lib/approval-scope-decoder-mirror.test.ts
//
// WHY THIS TEST EXISTS
// --------------------
// On 2026-09-22 the approvals `scope` vocabulary was widened: the honest value
// `tenant_owned_or_rostered` replaced a `tenant` that had been asserting a
// tenant-wide population the query did not return. FOUR out-of-repo operator
// scripts were taught the new vocabulary first (readers-first, deliberately).
//
// The decoder in THIS repo was missed.
//
// `frontend/src/lib/api/unified-client.ts` decodes `/api/approvals/all` with
// `scope: optional(oneOf(['tenant', 'all']))`. `oneOf` FAILS CLOSED: it calls
// `fail()`, which throws `Mismatch`. `optional()` only short-circuits on
// `undefined`/`null`, so a PRESENT-but-unlisted string is a hard decode error.
// The whole response is rejected and /approvals renders its ErrorState.
//
// Measured live 2026-09-23 against the deployed pod:
//   GET /api/approvals/all -> scope = 'tenant_owned_or_rostered'
//   decoder allow-list      = ['tenant', 'all']
//   => Mismatch thrown on every load of the approvals page.
//
// The defect class: widening one fence hid the second. This test is the second
// fence, and it fails in CI instead of in production.
//
// WHY IT READS THE FILE INSTEAD OF IMPORTING IT
// ---------------------------------------------
// `frontend/` and `backend/` are separate packages with separate installs. A
// backend test that `import`ed a frontend module would resolve locally (one
// node_modules tree on a dev box) and FAIL in CI, which installs each package on
// its own. Reading the source as TEXT crosses no package boundary and needs no
// resolver — so this test is valid in exactly the environment that grades it.
//
// KILLING MUTATION
// ----------------
// Delete any value from the decoder's `oneOf([...])` list in
// `frontend/src/lib/api/unified-client.ts` (e.g. drop `tenant_owned_or_rostered`)
// => this test FAILS naming that value. Restore it => green.
// Second mutation: add a 5th key to `APPROVAL_SCOPE` without widening the
// decoder => this test FAILS naming the new key. That is the exact shape of the
// original defect, caught at PR time.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { APPROVAL_SCOPE } from '../../../src/lib/approval-roster-lane';

/** Repo root, from `backend/tests/unit/lib/` — four levels up. */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const DECODER_FILE = join(REPO_ROOT, 'frontend', 'src', 'lib', 'api', 'unified-client.ts');

/**
 * Pull the string literals out of the `scope: optional(oneOf([...]))` decoder.
 *
 * Deliberately anchored on `scope:` + `oneOf(` rather than "any oneOf in the
 * file" — `unified-client.ts` contains other `oneOf` decoders, and matching them
 * all would make this assertion pass for the wrong reason.
 */
function decoderScopeValues(source: string): string[] {
  const at = source.indexOf('scope: optional(');
  if (at === -1) {
    throw new Error(
      'ANTI-VACUITY: could not find `scope: optional(` in unified-client.ts. ' +
        'The decoder was renamed or restructured — this test cannot grade what it ' +
        'cannot find, and a silent pass here would restore the exact hole it exists ' +
        'to close. Re-anchor it deliberately.',
    );
  }
  const oneOfAt = source.indexOf('oneOf(', at);
  const open = source.indexOf('[', oneOfAt);
  const close = source.indexOf(']', open);
  if (oneOfAt === -1 || open === -1 || close === -1 || close < open) {
    throw new Error('ANTI-VACUITY: found `scope: optional(` but no `oneOf([...])` array after it.');
  }
  // Group 1 is not optional in the pattern, so it cannot actually be undefined —
  // but `noUncheckedIndexedAccess` types it as `string | undefined`, and a
  // non-null assertion would silence the checker rather than satisfy it. The
  // narrowing filter costs nothing and drops nothing.
  return [...source.slice(open, close).matchAll(/'([^']+)'/g)]
    .map((m) => m[1])
    .filter((v): v is string => v !== undefined);
}

describe('the frontend approvals-scope decoder mirrors the backend vocabulary', () => {
  const source = readFileSync(DECODER_FILE, 'utf8');
  const declared = decoderScopeValues(source);
  const backendValues = Object.values(APPROVAL_SCOPE);

  // ANTI-VACUITY. An extractor that returned [] would make the subset assertion
  // below vacuously... false, actually — but an extractor that returned every
  // string in the file would make it vacuously TRUE. Both floors are cheap.
  test('the extractor actually read a non-trivial allow-list', () => {
    expect(declared.length).toBeGreaterThanOrEqual(backendValues.length);
    expect(declared.length).toBeLessThan(20); // it grabbed ONE array, not the file
  });

  test('the backend emits at least one distinct scope value (the floor this guards)', () => {
    expect(new Set(backendValues).size).toBeGreaterThan(0);
  });

  // THE ASSERTION. Every value the backend can emit must be decodable.
  for (const value of Object.values(APPROVAL_SCOPE)) {
    test(`decoder accepts APPROVAL_SCOPE value '${value}'`, () => {
      expect(declared).toContain(value);
    });
  }

  test("the legacy 'tenant' value stays accepted so a rollback still decodes", () => {
    // Not emitted by any current backend path. Kept because dropping it would
    // turn a rollback to the previous image into a second outage.
    expect(declared).toContain('tenant');
  });
});
