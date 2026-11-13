// tests/setup-db-guard.ts
// Bun test preload — the third and last one, loaded after `setup-env.ts` and
// `setup.ts` (see `bunfig.toml`).
//
// What this kills
// ---------------
// 79 of the 107 files under `tests/integration/` are written in this shape:
//
//     let reachable = false;
//     try { await db.select()…; reachable = true; } catch { /* no db */ }
//     test('archiving a project purges PHI', async () => {
//       if (!reachable) return;          // <-- the whole body is skipped
//       …
//     });
//
// With no Postgres, Bun reports that file as `N pass, 0 fail, 0 expect() calls`.
// That is not a skip and it is not a pass — it is a green light on nothing. A
// HIPAA right-to-delete proof that "passes" without ever executing the code
// under test is strictly worse than having no test at all, because it
// advertises coverage nobody is enforcing. (`tests/integration/helpers/
// db-suite.ts` was written to fix this one file at a time; this preload closes
// the same hole for every file at once, without editing 79 of them.)
//
// The mechanism: `expect.hasAssertions()` registered in a GLOBAL `beforeEach`
// applies to every test in every collected file. A body that early-returns
// before asserting then FAILS with "received 0 assertions" instead of passing.
// You cannot fake-pass a test that is required to assert.
//
// Why the activation flag is deliberately explicit
// ------------------------------------------------
// `FR_TEST_REQUIRE_DB=1` and nothing else. Specifically NOT `CI` and NOT
// `DATABASE_URL`:
//
//   * Keying on either would arm every invocation that happens to have a
//     DATABASE_URL, whether or not a migrated Postgres is behind it.
//   * Locally, plenty of developers have `DATABASE_URL` exported in their
//     shell for `bun run migrate` / psql. Keying on it would break a plain
//     `bun test tests/unit` for them, on a machine where nothing is wrong.
//
// So this file is INERT by default. It is armed only by the CI steps that
// set the flag (the unit lane and the integration lane), each right after
// `scripts/require-db-reachable.ts` has proven there is a migrated Postgres to
// run against. Two halves of one guarantee: require-db-reachable proves the
// database is THERE, this preload proves the tests actually TOUCHED it.
//
// Nothing here can turn a run red on its own — with the flag unset it does not
// even import `beforeEach`'s registration path.
//
// WHAT THIS DOES NOT CATCH — read before trusting a green run
// ----------------------------------------------------------
// This is a RATCHET, not a proof. `expect.hasAssertions()` asserts that at
// least one assertion was CALLED during the test, and that is a much weaker
// statement than "the test exercised the database". Four holes are proven, by
// adversarial test, to satisfy it:
//
//   1. AN ASSERTION IN A `beforeEach` HOOK COUNTS. The hook runs inside the
//      test's assertion frame, so a file whose `beforeEach` asserts anything at
//      all satisfies the requirement for EVERY test in that file — and each
//      body may then still `if (!reachable) return;` with no assertion of its
//      own and pass. `tests/integration/services/streams-repository.integration.
//      test.ts:99` is exactly this shape. This is the biggest hole.
//   2. `expect.assertions(0)` SATISFIES IT. An explicit count of zero is a
//      legal declaration and overrides the hasAssertions requirement.
//   3. IT COUNTS CALLS, NOT SUCCESSES. An `expect()` whose failure is swallowed
//      by a surrounding `try {} catch {}` still increments the counter, so the
//      test passes while the assertion it made was false.
//   4. `test.skip` / `test.todo` ARE UNAFFECTED. A skipped test never runs the
//      hook, so marking a vacuous test `.skip` removes it from this guard's
//      reach entirely.
//
// What it DOES catch is the single dominant idiom: a plain `test()` whose body
// early-returns before asserting, in a file with no asserting hook. That was 79
// files. `beforeAll` assertions correctly do NOT count (they run outside the
// per-test frame), which is why the hook hole is specifically `beforeEach`.
//
// The real fix for each hole is per-file conversion to
// `tests/integration/helpers/db-suite.ts createDbSuite`, which fails at import
// when CI/DATABASE_URL are set and Postgres is unreachable — a structural
// guarantee rather than a counting one. Until a file is converted, treat its
// green as "it asserted something", not "it touched the database".

import { beforeEach, expect } from 'bun:test';

if (process.env.FR_TEST_REQUIRE_DB === '1') {
  beforeEach(() => {
    // Registered globally from a preload, so it applies to every test in every
    // file the current `bun test` invocation collects. A test whose body
    // returns without asserting fails with "expected at least one assertion to
    // be called but received 0 assertions".
    expect.hasAssertions();
  });
}
