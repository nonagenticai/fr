// tests/integration/approvals/one-open-gate-race.integration.test.ts
//
// PROVES THE RACE IS CLOSED — not that a helper exists.
//
// fr#1000: `one-open-gate.ts` answered "does this card already have a gate?" with
// a bare SELECT and every caller then INSERTed unconditionally. Two n8n executions
// for one card both read null and both minted. MEASURED on prod 2026-09-06/07:
// 39 consecutive mints on one (tenant_id, card_id) inside 60s, tightest pair 57ms
// apart, 352 duplicate gates carrying 352 duplicate notifications — a human paged
// twice, and asked to decide twice, about one stuck card.
//
// ⚠️ THE ONLY TEST THAT MATTERS HERE IS A CONCURRENT ONE. A sequential
// "mint twice, expect one row" passes against the OLD code too, because the second
// call's pre-check SELECT sees the first call's committed row. It measures the
// fast path and reports the race as closed. Every case below fires its mints with
// Promise.all so both are in flight before either commits.
//
// Deleting migration 114 must turn these red — verified by dropping the index:
// the insert then raises 42P10 (no arbiter index matches the ON CONFLICT
// predicate), which is loud, not silent.

import { expect, test, describe, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql as raw } from 'drizzle-orm';

import { db, approvals, queryClient } from '../../../src/db/client';
import { mintOneOpenGate, findOpenGateForCard } from '../../../src/domain/approvals/one-open-gate';

// ⛔ Probed at MODULE level, not in beforeAll. `test.skipIf` is evaluated when the
// test is REGISTERED, which happens before any beforeAll has run — reading a flag
// set there would skip the whole file forever, and a skipped file looks exactly
// like a passing one.
let reachable = false;
try {
  await queryClient`SELECT 1 FROM approvals LIMIT 1`;
  reachable = true;
} catch (err) {
  console.warn('[one-open-gate-race] postgres unreachable:', (err as Error).message);
}
const itDb = test.skipIf(!reachable);

const TENANT = '00000000-0000-0000-0000-00000000f001';
const cards: string[] = [];
const newCard = (): string => {
  const c = `race-test-${Date.now()}-${cards.length}`;
  cards.push(c);
  return c;
};
const gate = (cardId: string, d: string) =>
  ({
    tenant_id: TENANT,
    card_id: cardId,
    status: 'pending',
    kind: 'generic',
    description: d,
  }) as typeof approvals.$inferInsert;

afterAll(async () => {
  if (!reachable) return;
  for (const c of cards) {
    await db.delete(approvals).where(eq(approvals.card_id, c));
  }
});

describe('one card gets one open gate, under concurrency', () => {
  itDb('five simultaneous mints produce ONE pending gate', async () => {
    const card = newCard();

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        mintOneOpenGate({ tenantId: TENANT, cardId: card, values: gate(card, `r${i}`) }),
      ),
    );

    const rows = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.tenant_id, TENANT),
          eq(approvals.card_id, card),
          eq(approvals.status, 'pending'),
        ),
      );

    expect(rows.length).toBe(1);
    // Every caller is handed the SAME gate — the one that actually holds the card.
    expect(new Set(results.map((r) => r.gate.id)).size).toBe(1);
    // Exactly one minted; the rest are told they did not.
    expect(results.filter((r) => !r.deduplicated).length).toBe(1);
    expect(results.filter((r) => r.deduplicated).length).toBe(4);
  });

  itDb('the winner is reported as the gate, not a null', async () => {
    const card = newCard();
    const results = await Promise.all([1, 2].map((i) =>
      mintOneOpenGate({ tenantId: TENANT, cardId: card, values: gate(card, `w${i}`) }),
    ));
    for (const r of results) {
      expect(r.gate).toBeTruthy();
      expect(r.gate.card_id).toBe(card);
      expect(r.gate.status).toBe('pending');
    }
  });

  itDb('a resolved gate does not block a genuinely new one', async () => {
    // The guard is "one OPEN gate", not a cooldown. Once the first is decided the
    // card may legitimately be gated again — if this failed, a card could never be
    // re-gated after its first sign-off.
    const card = newCard();
    const first = await mintOneOpenGate({ tenantId: TENANT, cardId: card, values: gate(card, 'a') });
    await db.update(approvals).set({ status: 'approved' }).where(eq(approvals.id, first.gate.id));

    const second = await mintOneOpenGate({ tenantId: TENANT, cardId: card, values: gate(card, 'b') });
    expect(second.deduplicated).toBe(false);
    expect(second.gate.id).not.toBe(first.gate.id);
  });

  itDb('a gate with NO card_id is never deduplicated against another', async () => {
    // The index is partial on `card_id IS NOT NULL`. Two card-less approvals in one
    // tenant are unrelated rows, not duplicates — if the predicate were dropped from
    // either the index or the helper, these would collide.
    const values = { tenant_id: TENANT, card_id: null, status: 'pending', kind: 'generic' };
    const a = await mintOneOpenGate({ tenantId: TENANT, cardId: null, values: { ...values, description: 'n1' } as typeof approvals.$inferInsert });
    const b = await mintOneOpenGate({ tenantId: TENANT, cardId: null, values: { ...values, description: 'n2' } as typeof approvals.$inferInsert });
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(false);
    expect(a.gate.id).not.toBe(b.gate.id);
    await db.delete(approvals).where(eq(approvals.id, a.gate.id));
    await db.delete(approvals).where(eq(approvals.id, b.gate.id));
  });

  itDb('findOpenGateForCard returns the OLDEST, which is the row 114 keeps', async () => {
    // The reader and the migration must agree on WHICH row holds the card. If the
    // helper's order were dropped, this returns an arbitrary row and the migration
    // would be voiding the one the application considers authoritative.
    const card = newCard();
    const older = await db.insert(approvals)
      .values({ ...gate(card, 'older'), created_at: new Date('2026-01-01T00:00:00Z') })
      .returning();
    // A second pending row can only be created with the index bypassed, which is
    // exactly the pre-114 state this asserts the reader is robust to.
    await db.execute(raw`INSERT INTO approvals (tenant_id, card_id, status, kind, description, created_at)
      SELECT ${TENANT}::uuid, ${card}, 'pending', 'generic', 'newer', '2026-06-01T00:00:00Z'
      WHERE NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'approvals_one_open_gate_per_card_idx')`);

    const found = await findOpenGateForCard({ tenantId: TENANT, cardId: card });
    expect(found?.id).toBe(older[0]!.id);
  });
});

describe('the arbiter predicate and the index predicate are the same predicate', () => {
  test('mintOneOpenGate ON CONFLICT matches migration 114 exactly', () => {
    // ⚠️ Postgres matches an ON CONFLICT arbiter to a partial index BY PREDICATE.
    // If these two drift, no arbiter is found and EVERY mint raises 42P10 — not
    // just the racing ones. Measured by dropping the index: the insert throws.
    const helper = readFileSync(
      join(import.meta.dir, '../../../src/domain/approvals/one-open-gate.ts'), 'utf8');
    const migration = readFileSync(
      join(import.meta.dir, '../../../migrations/114_approvals_one_open_gate_per_card.sql'), 'utf8');

    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    expect(norm(helper)).toContain(norm("status = 'pending' AND card_id IS NOT NULL"));
    expect(norm(migration)).toContain(
      norm("ON approvals (tenant_id, card_id) WHERE status = 'pending' AND card_id IS NOT NULL"));
  });

  test('no route mints an approval gate outside the helper', () => {
    // The third door (POST /api/webhooks/n8n/approval-request) was found only
    // because the index constrains EVERY writer, not the two the issue named. A
    // fourth would 23505 in production rather than fail here, so it fails here.
    // (A fourth door, routes/improvement-approvals.ts, was deleted 2026-11-03 with
    // the v3 improvement loop.)
    for (const f of [
      'src/routes/webhooks.ts',
      'src/routes/execution-approvals.ts',
    ]) {
      const src = readFileSync(join(import.meta.dir, '../../..', f), 'utf8');
      expect(src).not.toContain('insert(approvals)');
      expect(src).toContain('mintOneOpenGate');
    }
  });
});
