// tests/integration/decomposition/family-decisions-claim.integration.test.ts
//
// PROVES THE TOPIC CLAIM IS ATOMIC — roadmap B1 gate (split-coherence-design.md
// §8 PR 4: "UNIQUE-topic concurrency test (8 concurrent claims → 1 winner)").
//
// ⚠️ THE ONLY CASE THAT MATTERS IS A CONCURRENT ONE. A sequential "claim twice,
// expect one row" also passes against a check-then-insert implementation,
// because the second call's check sees the first call's committed row. Every
// multi-claim case below fires with Promise.all so all claims are in flight
// before any commits (same reasoning as one-open-gate-race.integration.test.ts).
//
// MUTATIONS THAT MUST TURN THIS FILE RED:
//   1. Drop the unique index — in BOTH emitters, since CI's DB is built by
//      drizzle-kit push from src/db/schema.ts:
//        DROP INDEX family_decisions_one_active_topic_idx;
//      The claim's `ON CONFLICT (family_id, topic_slug) WHERE superseded_by IS
//      NULL` then has no arbiter index and every claim raises 42P10, so
//      Promise.all rejects and case (a) fails; the index-shape case fails too.
//   2. Replace the claim with SELECT-then-INSERT (no ON CONFLICT) and no index:
//      case (a) sees more than one winner.
//   3. Drop only the `WHERE superseded_by IS NULL` predicate (full UNIQUE):
//      the supersession case fails — a superseded topic can never be re-claimed.
//   4. Restore interface_validations' (family_id, run_at) PK in schema.ts
//      (pre-129): the two-runs-in-one-transaction case raises 23505.

import { expect, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inArray } from 'drizzle-orm';

import { db, queryClient } from '../../../src/db/client';
import { decompositions } from '../../../src/db/schema';
import {
  claimDecisionTopic,
  findFamilyForTenant,
  listFamilyDecisions,
} from '../../../src/services/decomposition/family-decisions';
import { getFamilyBundle, putFamilyBundle } from '../../../src/services/decomposition/family-bundles';
import { createDbSuite } from '../helpers/db-suite';

const { itDb, dbReachable } = createDbSuite('family-decisions-claim');

const TENANT = '00000000-0000-0000-0000-00000000b101';
const OTHER_TENANT = '00000000-0000-0000-0000-00000000b102';
const families: string[] = [];

async function newFamily(tenantId = TENANT): Promise<string> {
  const id = randomUUID();
  families.push(id);
  await db.insert(decompositions).values({
    id,
    tenant_id: tenantId,
    parent_card_id: `b1-test-parent-${id}`,
  });
  return id;
}

afterAll(async () => {
  if (!dbReachable || families.length === 0) return;
  // ON DELETE CASCADE removes family_decisions / family_bundles rows with it.
  await db.delete(decompositions).where(inArray(decompositions.id, families));
});

itDb('(a) 8 CONCURRENT claims of one topic → exactly 1 winner and 7 clean conflicts', async () => {
  const family = await newFamily();
  const claims = Array.from({ length: 8 }, (_, i) => ({
    familyId: family,
    topicSlug: 'app_id_empty_policy',
    decisionId: randomUUID(),
    childKey: `repo-child-${i + 1}`,
  }));

  // Promise.all REJECTS if any claim throws — so "7 clean conflicts, not
  // crashes" is asserted by this line resolving at all.
  const results = await Promise.all(claims.map((c) => claimDecisionTopic(c)));

  const winners = results.filter((r) => r.outcome === 'claimed');
  const conflicts = results.filter((r) => r.outcome === 'conflict');
  expect(winners.length).toBe(1);
  expect(conflicts.length).toBe(7);
  expect(results.filter((r) => r.outcome === 'replayed').length).toBe(0);

  // Every loser is told WHO won — the winner's decision_id, seq and child_key —
  // so it can read that decision and conform (design §3.2 "409 {decision_id}").
  const w = winners[0]!;
  for (const c of conflicts) {
    expect(c.decision_id).toBe(w.decision_id);
    expect(c.seq).toBe(w.seq);
    expect(c.child_key).toBe(w.child_key);
  }
  // The winner is one of the claimants, not an invented row.
  expect(claims.map((c): string => c.decisionId)).toContain(w.decision_id);

  // And the database agrees: exactly one row exists for the topic.
  const rows = await queryClient<{ n: string }[]>`
    SELECT count(*)::text AS n FROM family_decisions
    WHERE family_id = ${family} AND topic_slug = 'app_id_empty_policy'
  `;
  expect(rows[0]!.n).toBe('1');
});

itDb('(b) a DIFFERENT topic in the same family gets its own independent winner', async () => {
  const family = await newFamily();
  const [t1, t2] = await Promise.all([
    claimDecisionTopic({ familyId: family, topicSlug: 'topic_one', decisionId: randomUUID(), childKey: 'c1' }),
    claimDecisionTopic({ familyId: family, topicSlug: 'topic_two', decisionId: randomUUID(), childKey: 'c2' }),
  ]);
  expect(t1.outcome).toBe('claimed');
  expect(t2.outcome).toBe('claimed');
  expect(t1.seq).not.toBe(t2.seq);

  // Contention on topic_one does not touch topic_two's winner.
  const late = await Promise.all(
    [1, 2, 3].map((i) =>
      claimDecisionTopic({ familyId: family, topicSlug: 'topic_one', decisionId: randomUUID(), childKey: `x${i}` }),
    ),
  );
  expect(late.every((r) => r.outcome === 'conflict' && r.decision_id === t1.decision_id)).toBe(true);
  const log = await listFamilyDecisions(family);
  expect(log.map((r) => r.topic_slug).sort()).toEqual(['topic_one', 'topic_two']);
});

itDb('(b2) the SAME topic in a DIFFERENT family is independent', async () => {
  const f1 = await newFamily();
  const f2 = await newFamily();
  const [a, b] = await Promise.all([
    claimDecisionTopic({ familyId: f1, topicSlug: 'shared_topic', decisionId: randomUUID(), childKey: 'c1' }),
    claimDecisionTopic({ familyId: f2, topicSlug: 'shared_topic', decisionId: randomUUID(), childKey: 'c1' }),
  ]);
  expect(a.outcome).toBe('claimed');
  expect(b.outcome).toBe('claimed');
});

itDb('a retry of the WINNING claim is replayed, not reported as a rival', async () => {
  const family = await newFamily();
  const claim = { familyId: family, topicSlug: 'retry_topic', decisionId: randomUUID(), childKey: 'c1' };
  const first = await claimDecisionTopic(claim);
  const again = await claimDecisionTopic(claim);
  expect(first.outcome).toBe('claimed');
  expect(again.outcome).toBe('replayed');
  expect(again.seq).toBe(first.seq);
  // Same decision, different child: that IS a rival.
  const rival = await claimDecisionTopic({ ...claim, childKey: 'c2' });
  expect(rival.outcome).toBe('conflict');
});

itDb('a superseded decision releases its topic (the index is PARTIAL on superseded_by IS NULL)', async () => {
  const family = await newFamily();
  const first = await claimDecisionTopic({
    familyId: family, topicSlug: 'superseded_topic', decisionId: randomUUID(), childKey: 'c1',
  });
  expect(first.outcome).toBe('claimed');

  // No supersede route exists yet (see the service header); simulate the stamp
  // a supersession writes onto the OLD row.
  const successor = randomUUID();
  await queryClient`
    UPDATE family_decisions SET superseded_by = ${successor}
    WHERE family_id = ${family} AND seq = ${first.seq}
  `;

  const second = await claimDecisionTopic({
    familyId: family, topicSlug: 'superseded_topic', decisionId: successor, childKey: 'c2',
  });
  expect(second.outcome).toBe('claimed');
  expect(second.seq).toBeGreaterThan(first.seq);
});

itDb('listFamilyDecisions honours after_seq and returns oldest first', async () => {
  const family = await newFamily();
  const a = await claimDecisionTopic({ familyId: family, topicSlug: 'log_a', decisionId: randomUUID(), childKey: 'c1' });
  const b = await claimDecisionTopic({ familyId: family, topicSlug: 'log_b', decisionId: randomUUID(), childKey: 'c2' });
  const c = await claimDecisionTopic({ familyId: family, topicSlug: 'log_c', decisionId: randomUUID(), childKey: 'c3' });

  const all = await listFamilyDecisions(family);
  expect(all.map((r) => r.seq)).toEqual([a.seq, b.seq, c.seq]);
  const afterA = await listFamilyDecisions(family, a.seq);
  expect(afterA.map((r) => r.topic_slug)).toEqual(['log_b', 'log_c']);
  expect(await listFamilyDecisions(family, c.seq)).toEqual([]);
});

itDb('a family is invisible to another tenant (don\'t-leak-existence)', async () => {
  const family = await newFamily(TENANT);
  expect(await findFamilyForTenant(family, TENANT)).not.toBeNull();
  expect(await findFamilyForTenant(family, OTHER_TENANT)).toBeNull();
  // A non-uuid id names no row and must not raise 22P02.
  expect(await findFamilyForTenant('not-a-uuid', TENANT)).toBeNull();
});

itDb('the arbiter index exists on THIS database with the partial predicate', async () => {
  // CI builds this database with drizzle-kit push from src/db/schema.ts, so
  // this case is what proves schema.ts — not only migration 128 — declares it.
  const rows = await queryClient<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
    WHERE tablename = 'family_decisions' AND indexname = 'family_decisions_one_active_topic_idx'
  `;
  expect(rows.length).toBe(1);
  const def = rows[0]!.indexdef;
  expect(def).toContain('UNIQUE');
  expect(def).toMatch(/\(family_id, topic_slug\)/);
  expect(def).toMatch(/WHERE \(superseded_by IS NULL\)/);
});

// ── the two emitters ─────────────────────────────────────────────────────────
// CI builds `public` with drizzle-kit push from schema.ts and stamps migration
// 128 applied WITHOUT executing it, so without this case a syntax error or a
// dropped constraint in the .sql would ship to production with CI green. The
// file is executed verbatim into a throwaway schema inside a rolled-back
// transaction and its shape compared with `public`'s.

const MIGRATION_128 = readFileSync(
  join(import.meta.dir, '../../../migrations/128_card_contract_substrate.sql'),
  'utf8',
);
// 129 re-keys interface_validations (surrogate bigserial PK). public is push-built
// from the CURRENT schema.ts, so the file-built side must be 128 THEN 129.
const MIGRATION_129 = readFileSync(
  join(import.meta.dir, '../../../migrations/129_interface_validations_surrogate_pk.sql'),
  'utf8',
);
// 150 adds decompositions.computed_by + reason and their CHECKs (ncn#1960, the
// Readying split). Same reason: public is push-built from the CURRENT schema.ts.
const MIGRATION_150 = readFileSync(
  join(import.meta.dir, '../../../migrations/150_decomposition_split_provenance.sql'),
  'utf8',
);
const B1_TABLES = [
  'decompositions',
  'card_contracts',
  'contract_dependencies',
  'family_bundles',
  'family_decisions',
  'interface_validations',
];
// Constant table names only — inlined as literals rather than bound as an array.
const B1_IN = B1_TABLES.map((t) => `'${t}'`).join(', ');
class Rollback extends Error {}

itDb('migrations 128 + 129 + 150 execute verbatim and match the push-built shape (columns, CHECK/UNIQUE names, indexes)', async () => {
  let failure: unknown;
  try {
    await queryClient.begin(async (tx) => {
      const schema = `mig128_${process.pid}_${Date.now()}`;
      await tx.unsafe(`CREATE SCHEMA ${schema}`);
      await tx.unsafe(`SET LOCAL search_path TO ${schema}, public`);
      await tx.unsafe(MIGRATION_128);
      await tx.unsafe(MIGRATION_129);
      await tx.unsafe(MIGRATION_150);
      // 233 drops card_contracts.procedure_pins (procedures removed). The file itself
      // addresses public.* and the public enums, so only its card_contracts statement
      // is replayed here.
      await tx.unsafe('ALTER TABLE card_contracts DROP COLUMN IF EXISTS procedure_pins');
      await tx.unsafe(`SET LOCAL search_path TO public`);

      const columns = async (s: string) =>
        (await tx.unsafe(
          `SELECT table_name, column_name, data_type, udt_name, is_nullable
             FROM information_schema.columns
            WHERE table_schema = $1::text AND table_name IN (${B1_IN})
            ORDER BY table_name, column_name`,
          [s],
        )) as unknown as Record<string, string>[];
      const fileCols = await columns(schema);
      // Non-vacuity: the file really created all six tables here.
      expect(new Set(fileCols.map((c) => c.table_name)).size).toBe(B1_TABLES.length);
      expect(fileCols.map((c) => ({ ...c }))).toEqual((await columns('public')).map((c) => ({ ...c })));

      // CHECK + UNIQUE constraints by NAME (PK / FK / NOT NULL names legitimately
      // differ between the emitters and are excluded).
      const constraints = async (s: string) =>
        (
          (await tx.unsafe(
            `SELECT c.conname
               FROM pg_constraint c
               JOIN pg_class t ON t.oid = c.conrelid
               JOIN pg_namespace n ON n.oid = t.relnamespace
              WHERE n.nspname = $1::text AND t.relname IN (${B1_IN})
                AND c.contype IN ('c', 'u')
              ORDER BY c.conname`,
            [s],
          )) as unknown as { conname: string }[]
        ).map((r) => r.conname);
      const fileCons = await constraints(schema);
      expect(fileCons).toContain('card_contracts_leaf_class_check');
      expect(fileCons).toEqual(await constraints('public'));

      // Non-PK indexes, definition included (schema qualifier stripped).
      const indexes = async (s: string) =>
        (
          (await tx.unsafe(
            `SELECT indexname, indexdef FROM pg_indexes
              WHERE schemaname = $1::text AND tablename IN (${B1_IN})
                AND indexname NOT LIKE '%\\_pkey' AND indexname NOT LIKE '%\\_pk'
              ORDER BY indexname`,
            [s],
          )) as unknown as { indexname: string; indexdef: string }[]
        ).map((r) => `${r.indexname} :: ${r.indexdef.replaceAll(`${s}.`, '')}`);
      const fileIdx = await indexes(schema);
      expect(fileIdx.some((d) => d.startsWith('family_decisions_one_active_topic_idx'))).toBe(true);
      expect(fileIdx.some((d) => d.startsWith('interface_validations_family_id_idx'))).toBe(true);
      expect(fileIdx).toEqual(await indexes('public'));

      // PRIMARY KEY columns (names excluded above) — 129's whole point, so compared
      // explicitly: both emitters must key interface_validations on `id` alone.
      const pkCols = async (s: string) =>
        (
          (await tx.unsafe(
            `SELECT t.relname || '(' || string_agg(a.attname, ',' ORDER BY k.ord) || ')' AS pk
               FROM pg_constraint c
               JOIN pg_class t ON t.oid = c.conrelid
               JOIN pg_namespace n ON n.oid = t.relnamespace
               CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
              WHERE n.nspname = $1::text AND t.relname IN (${B1_IN}) AND c.contype = 'p'
              GROUP BY t.relname
              ORDER BY t.relname`,
            [s],
          )) as unknown as { pk: string }[]
        ).map((r) => r.pk);
      const filePks = await pkCols(schema);
      expect(filePks).toContain('interface_validations(id)');
      expect(filePks).toEqual(await pkCols('public'));

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) failure = err;
  }
  if (failure) throw failure;
});

itDb('family bundle versions are write-once: same hash is idempotent, a new hash is refused', async () => {
  const family = await newFamily();
  const put = (hash: string) =>
    putFamilyBundle({ familyId: family, version: 1, bundleHash: hash, items: [{ kind: 'requirement', id: 'r1' }] });

  expect((await put('hash-one')).outcome).toBe('created');
  expect((await put('hash-one')).outcome).toBe('unchanged');
  const refused = await put('hash-two');
  expect(refused.outcome).toBe('conflict');
  if (refused.outcome === 'conflict') expect(refused.existing_bundle_hash).toBe('hash-one');

  // The stored row still carries the ORIGINAL hash.
  expect((await getFamilyBundle(family, 1))?.bundle_hash).toBe('hash-one');
  // Latest-version read.
  expect((await putFamilyBundle({ familyId: family, version: 2, bundleHash: 'hash-v2', items: [] })).outcome).toBe(
    'created',
  );
  expect((await getFamilyBundle(family))?.version).toBe(2);
});

itDb('two interface-validation runs for one family inside ONE transaction both land (migration 129)', async () => {
  // THE DEFECT 129 FIXES: 128 keyed interface_validations on (family_id, run_at)
  // with run_at DEFAULT NOW(), and NOW() is the TRANSACTION start time — so the
  // second run in one transaction raised 23505. Mutation: restore the composite
  // PK in schema.ts (the CI DB is push-built from it) ⇒ this case goes red.
  const family = await newFamily();
  const ids = await queryClient.begin(async (tx) => {
    const a = await tx<{ id: string; run_at: string }[]>`
      INSERT INTO interface_validations (family_id, violations) VALUES (${family}, '[]'::jsonb)
      RETURNING id::text, run_at::text`;
    const b = await tx<{ id: string; run_at: string }[]>`
      INSERT INTO interface_validations (family_id, violations) VALUES (${family}, '[{"k":"v"}]'::jsonb)
      RETURNING id::text, run_at::text`;
    // Non-vacuity: the two runs really do share run_at — the collision condition.
    expect(a[0]!.run_at).toBe(b[0]!.run_at);
    return [a[0]!.id, b[0]!.id];
  });
  expect(BigInt(ids[1]!)).toBeGreaterThan(BigInt(ids[0]!));

  // "latest row per family is the current verdict" stays decidable on a tie.
  const latest = await queryClient<{ violations: unknown[] }[]>`
    SELECT violations FROM interface_validations WHERE family_id = ${family} ORDER BY id DESC LIMIT 1`;
  expect(latest[0]!.violations).toEqual([{ k: 'v' }]);
});
