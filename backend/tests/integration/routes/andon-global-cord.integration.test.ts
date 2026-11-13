// tests/integration/routes/andon-global-cord.integration.test.ts
//
// The GLOBAL cord's pull path against a REAL Postgres. No collaborator is faked: the
// k8s scale call is genuinely attempted and genuinely FAILS here — with no mounted
// ServiceAccount on a dev box, and with a 403 from the runner's own SA on ARC — which is
// exactly the "could not measure it" case the code has to stay honest about. The
// assertions therefore pin the INVARIANT (an attempt happened, it was recorded, and no 0
// was invented), never the shape a particular environment produces.
//
// Two defects this pins, both measured in production on 2026-11-01/02:
//
//   1. A MISSING `andon_state` row made the pull report `already_engaged` and do
//      NOTHING. The gate that guards the short-circuit fails CLOSED, so "the row is
//      gone" and "the cord is engaged" were the same answer — the estate was halted
//      with every gate refusing and the brake would not pull.
//   2. A RE-PULL on an engaged cord did not re-issue the scale. The admin page told
//      the operator to "pull again to retry the scale"; pulling again was a no-op,
//      and the only path that worked was release-then-pull, which opens every gate.

import { afterAll, beforeEach, expect } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db, queryClient as sql } from '../../../src/db/client';
import { andonState } from '../../../src/db/schema';
import { engageGlobalCord } from '../../../src/routes/andon';
import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('andon-global-cord');

const OPERATOR = 'ops@andon.test';

async function clearSingleton(): Promise<void> {
  await sql`DELETE FROM andon_state`;
}

async function row(): Promise<typeof andonState.$inferSelect | undefined> {
  const [r] = await db.select().from(andonState).where(eq(andonState.id, 1)).limit(1);
  return r;
}

beforeEach(async () => {
  if (!process.env.DATABASE_URL) return;
  await clearSingleton();
});

afterAll(async () => {
  if (!process.env.DATABASE_URL) return;
  // Leave the singleton behind: the rest of the suite (and the app) expects it to
  // exist, and this file is the only one that deletes it.
  await sql`INSERT INTO andon_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
});

itDb('⭐ a MISSING singleton is repaired by the pull — never reported as already engaged', async () => {
  const res = await engageGlobalCord(OPERATOR);

  // The defect: this used to be `true`, with `engaged: false` beside it and no write.
  expect(res.already_engaged).toBeUndefined();
  expect(res.engaged).toBe(true);

  const stored = await row();
  expect(stored).toBeDefined();
  expect(stored!.engaged).toBe(true);
  expect(stored!.engaged_by).toBe(OPERATOR);

  // The scale genuinely fails from a test process — and HOW it fails depends on the
  // environment, so assert the invariant rather than one shape of it:
  //   * a dev box has no mounted ServiceAccount → the read itself throws, so
  //     `worker_replicas` is null and the error says why;
  //   * an ARC runner DOES have a token, reaches the real API server and is REFUSED
  //     (403 on the PATCH), but the read-back succeeds — so `worker_replicas` is the
  //     REAL count and the error still records the refusal. That is the whole point of
  //     k8s-scale's "a refused write is not a failed measurement".
  // ⛔ Asserting `replicas === null` here would encode the DEV box as the contract.
  expect(stored!.worker_scale_error).not.toBeNull();
  expect(stored!.worker_scaled_at).not.toBeNull();
  // ⛔ NOT "never 0". This test runs against the SAME cluster whose global cord can be
  // engaged at any moment — and when it is, the worker really is at 0/0, so a 0 here is
  // a correct MEASUREMENT, not the invented one this line was written to catch. (It
  // was engaged on 2026-11-08 and this assertion turned fr's main red twice for
  // reporting the truth.) The invariant is that the row reports what was measured, so
  // compare it with the probe in this same response; a row that invented 0, or that
  // lost a real 0, still fails.
  const probed = res.n8n_live?.worker_replicas ?? null;
  if (probed !== null) expect(stored!.worker_replicas).toBe(probed);

  expect.hasAssertions();
});

itDb('⭐ a RE-PULL re-runs the scale and keeps the original pull’s provenance', async () => {
  const first = await engageGlobalCord(OPERATOR);
  const afterFirst = await row();
  expect(afterFirst!.engaged_at).not.toBeNull();

  // Real clock: the second pull must move `worker_scaled_at` without touching
  // `engaged_at`. Bun's fake timers are banned, so wait for the wall clock.
  await new Promise((r) => setTimeout(r, 5));

  const second = await engageGlobalCord(OPERATOR);
  const afterSecond = await row();

  // `engaged_at`/`engaged_by` describe WHEN AND BY WHOM the line was stopped; a
  // retry is not a new stop and must not rewrite them.
  expect(afterSecond!.engaged_at?.getTime()).toBe(afterFirst!.engaged_at?.getTime());
  expect(afterSecond!.engaged_by).toBe(OPERATOR);
  // …while the re-attempt's own evidence is refreshed ONLY when the scale was actually
  // re-issued. Which branch this is depends on what the probe could PROVE:
  //   * the probe failed (a dev box: no ServiceAccount) → nothing is proven stopped, so
  //     a re-pull is a RETRY: it re-scales and refreshes `worker_scaled_at`;
  //   * the probe read 1 → the stop did not land → also a RETRY;
  //   * the probe read 0 → the worker IS stopped, and the idempotent re-pull deliberately
  //     does NOT re-PATCH: a second PATCH would overwrite the evidence of the attempt
  //     that actually pulled the cord with a fresh — and possibly failed — measurement.
  // ⛔ This estate's own cord can be engaged while the suite runs (it was on 2026-11-08),
  // and then the third branch is the correct one; the old unconditional "always a retry"
  // encoded the dev box as the contract and reded main.
  if (first.n8n_live?.worker_replicas === 0) {
    expect(second.already_engaged).toBe(true);
    expect(afterSecond!.worker_scaled_at?.getTime()).toBe(afterFirst!.worker_scaled_at!.getTime());
  } else {
    expect(second.already_engaged).toBeUndefined();
    expect(afterSecond!.worker_scaled_at!.getTime()).toBeGreaterThan(
      afterFirst!.worker_scaled_at!.getTime(),
    );
  }

  // Whichever branch ran, both pulls report the cord as ENGAGED: the re-pull is never a
  // release, and it never reports the line as already released.
  expect(first.engaged).toBe(true);
  expect(second.engaged).toBe(true);

  expect.hasAssertions();
});
