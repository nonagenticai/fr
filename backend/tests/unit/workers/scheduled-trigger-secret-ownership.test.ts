// tests/unit/workers/scheduled-trigger-secret-ownership.test.ts
//
// fr#1030 — the scheduled-trigger tick must not decrypt a `user_secrets` row
// the trigger does not own.
//
// `scheduled_triggers.connector_config.secret_id` is a USER-SUPPLIED uuid:
// `POST/PATCH /api/scheduled-triggers` validates `connector_config` with
// `validateConnectorConfig` (routes/scheduled-triggers-shared.ts:65), a
// shape-only `safeParse` whose file contains zero occurrences of `secret_id`.
// Before this fix `resolveSecret` selected by `id` alone, so user B could name
// user A's secret and the next 60s tick would decrypt it and hand it to
// `connector.fetch()` — credential USE crossing an ownership boundary. The
// plaintext never returns to the caller, which makes it quieter, not smaller.
//
// Blast radius when this was written was ZERO rows (`scheduled_triggers` empty,
// `user_secrets` 1 row / 1 distinct user_id). This file exists so the trap
// cannot arm itself on adoption.
//
// BOTH DIRECTIONS ARE LOAD-BEARING. A guard that refuses everything would pass
// the cross-owner case alone, so the same-owner case is asserted with the SAME
// fixture and the SAME call, differing in exactly one field.
//
// ⚠️ No `reachable`/skip idiom on purpose. A seed failure here must be a RED
// test, not a silent vacuum — an unseeded fixture is indistinguishable from a
// passing guard. CI's unit lane bootstraps a
// real Postgres before `bun test tests/unit/`, so the throw is honest there too.

import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

import { db } from '../../../src/db/client';
import { userSecrets } from '../../../src/db/schema';
import { encryption } from '../../../src/services/encryption';
import { resolveSecret } from '../../../src/workers/scheduled-trigger-tick';
import { resolveSecretValue as resolveIntakeSecret } from '../../../src/routes/intake-webhook';

// Private to this file. The unit lane shares ONE database with every other
// suite, so a fixture keyed on a memorable uuid (all-zeros, 1111…) is a
// cross-file collision waiting to happen.
const OWNER_A = 'a1030000-0000-4000-8000-00000000000a';
const OWNER_B = 'b1030000-0000-4000-8000-00000000000b';
const SECRET_OF_A = 'c1030000-0000-4000-8000-00000000000c';
const SECRET_OF_B = 'd1030000-0000-4000-8000-00000000000d';
// Deliberately never inserted: the "no such row" arm of the opacity check.
const NO_SUCH_SECRET = 'e1030000-0000-4000-8000-00000000000e';

const PLAINTEXT_A = 'ghp_owner_a_personal_access_token';
const PLAINTEXT_B = 'ghp_owner_b_personal_access_token';

const ALL_IDS = [SECRET_OF_A, SECRET_OF_B];

async function seedSecret(id: string, userId: string, plaintext: string) {
  const { encrypted, iv } = await encryption.encrypt(plaintext);
  await db.insert(userSecrets).values({
    id,
    user_id: userId,
    name: `fixture-${id.slice(0, 8)}`,
    // NOT NULL with no default. Omitting it throws at seed time, which is
    // exactly why this file lets seed errors escape.
    secret_type: 'api_key',
    encrypted_value: Buffer.from(encrypted),
    iv,
  } as never);
}

beforeAll(async () => {
  // server.ts:932 does this at boot; a unit run never calls it, and without a
  // key `encrypt`/`decrypt` throw before the predicate under test is reached.
  // Keyed off the deterministic 32-byte SECRET_ENCRYPTION_KEY that
  // tests/setup-env.ts pins.
  await encryption.initialize();
  await db.delete(userSecrets).where(inArray(userSecrets.id, ALL_IDS));
  await seedSecret(SECRET_OF_A, OWNER_A, PLAINTEXT_A);
  await seedSecret(SECRET_OF_B, OWNER_B, PLAINTEXT_B);
});

afterAll(async () => {
  await db.delete(userSecrets).where(inArray(userSecrets.id, ALL_IDS));
});

describe('scheduled-trigger tick: a trigger may only decrypt secrets it owns', () => {
  test("a trigger authored by B cannot resolve A's secret", async () => {
    // The confused deputy, stated literally: B's trigger, A's secret uuid.
    const got = await resolveSecret(SECRET_OF_A, {
      created_by_user_id: OWNER_B,
      tenant_id: OWNER_B,
    });
    expect(got).toBeNull();
  });

  test('"not yours" is indistinguishable from "no such row" — no existence oracle', async () => {
    // If the refusal ever became distinguishable (a different return shape, a
    // thrown error, a log only on one path), the worker would answer "does
    // secret X exist?" for any uuid a user cares to name. Both must be the
    // same `null`.
    const notYours = await resolveSecret(SECRET_OF_A, {
      created_by_user_id: OWNER_B,
      tenant_id: OWNER_B,
    });
    const missing = await resolveSecret(NO_SUCH_SECRET, {
      created_by_user_id: OWNER_B,
      tenant_id: OWNER_B,
    });
    expect(notYours).toEqual(missing);
    expect(missing).toBeNull();
  });

  test("a trigger authored by B still resolves B's OWN secret", async () => {
    // The control. Without it a guard that returns null unconditionally passes
    // every other test in this file.
    const got = await resolveSecret(SECRET_OF_B, {
      created_by_user_id: OWNER_B,
      tenant_id: OWNER_B,
    });
    expect(got?.value).toBe(PLAINTEXT_B);
  });

  test('a pre-migration-068 row (created_by_user_id NULL) falls back to tenant_id', async () => {
    // Migration 068's backfill left `created_by_user_id` NULL on every row that
    // predates it ("we cannot recover the historical author from the row
    // alone"), so NULL must not mean "match nothing" for a workspace-scope
    // secret stored under the tenant uuid — nor "match anything".
    const ownScope = await resolveSecret(SECRET_OF_A, {
      created_by_user_id: null,
      tenant_id: OWNER_A,
    });
    expect(ownScope?.value).toBe(PLAINTEXT_A);

    const foreign = await resolveSecret(SECRET_OF_A, {
      created_by_user_id: null,
      tenant_id: OWNER_B,
    });
    expect(foreign).toBeNull();
  });

  test('no secret_id configured resolves to null without a query', async () => {
    expect(await resolveSecret(null, { created_by_user_id: OWNER_B, tenant_id: OWNER_B })).toBeNull();
  });
});

// ⚠️ THE SECOND CALL SITE, found by an adversarial audit of the first fix.
// `routes/intake-webhook.ts` had the SAME by-id-alone lookup, reading the same
// `trigger.connector_config.secret_id`, on a route that deliberately loads the
// trigger with NO tenant scope ("trigger_id is the auth token"). It is the
// louder of the two: the 200-vs-400 the caller sees is an oracle against a
// secret they do not own — submit a body, learn whether it verified against A's
// key. Fixing only the worker would have left the class alive on the live HTTP
// route while this PR's own docblock claimed it was closed.
describe('intake webhook: a trigger may only decrypt secrets it owns', () => {
  test("a trigger authored by B cannot resolve A's secret", async () => {
    const got = await resolveIntakeSecret(SECRET_OF_A, {
      created_by_user_id: OWNER_B,
      tenant_id: OWNER_B,
    });
    expect(got).toBeNull();
  });

  test("a trigger authored by B still resolves B's OWN secret", async () => {
    const got = await resolveIntakeSecret(SECRET_OF_B, {
      created_by_user_id: OWNER_B,
      tenant_id: OWNER_B,
    });
    expect(got).toBe(PLAINTEXT_B);
  });

  test('"not yours" is indistinguishable from "no such row"', async () => {
    const notYours = await resolveIntakeSecret(SECRET_OF_A, {
      created_by_user_id: OWNER_B,
      tenant_id: OWNER_B,
    });
    const noSuchRow = await resolveIntakeSecret(NO_SUCH_SECRET, {
      created_by_user_id: OWNER_B,
      tenant_id: OWNER_B,
    });
    expect(notYours).toBe(noSuchRow as never);
  });
});
