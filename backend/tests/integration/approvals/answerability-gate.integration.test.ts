// tests/integration/approvals/answerability-gate.integration.test.ts
//
// PROVES THE CHOKEPOINT REFUSES — AND, JUST AS IMPORTANTLY, PROVES IT RESOLVES.
//
// `domain/approvals/one-open-gate.ts :: ensureAnswerable` is the ONE gate every
// `source='n8n'` producer passes through (four routes; see that file's header
// for the list and for the four non-n8n inserts deliberately out of scope). It
// ships in OBSERVE mode: `FR_APPROVAL_ANSWERABILITY_MODE` default `observe`
// mints exactly as before and only counts, `=enforce` refuses.
//
// ⭐ THE HALF THAT IS EASY TO SHIP WRONG IS THE RESOLUTION, NOT THE REFUSAL.
// "A refusal that could have been a resolution is a worse outcome than the
// defect" — so the cases below assert, against a real Postgres, that a
// stream-only approval (105 of the 106 measured `generic` rows) gets a real
// `requester_id` derived through `streams.project_id -> projects.owner_id` and
// is MINTED, in enforce mode, rather than refused. A gate that refused those
// would stop the conveyor while claiming to fix it.
//
// ⛔ `createDbSuite`/`itDb`, NOT a hand-rolled `reachable` probe. A file that
// reports `N pass, 0 fail, 0 expect()` when Postgres is missing is the defect
// fr#1006 exists to kill, and this file is the proof that a refusal fires at
// all — a vacuous green here is worse than no test.
//
// MUTATION CONTROLS (each should turn exactly the named test red):
//   * delete the `resolveRequesterId` stream arm            -> "resolvable" tests
//   * change `answerabilityEnforces()` to `false`           -> every "enforce" test
//   * make `approverIsTenantMember` return `true` on throw  -> approver arm
//   * drop the `expires_at` resolution                      -> deadline test
//   * make `policyKeyTenantMismatch` return null            -> policy_key test

import { afterAll, afterEach, beforeEach, expect } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

import {
  db,
  queryClient,
  approvals,
  projects,
  streams,
  userRoles,
} from '../../../src/db/client';
import { mintOneOpenGate } from '../../../src/domain/approvals/one-open-gate';
import {
  ANSWERABILITY_MODE_ENV,
  ANSWERABILITY_REFUSAL_CODE,
} from '../../../src/lib/approval-answerability';
import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('approval-answerability-gate');

const TENANT = '00000000-0000-4000-8000-0000a11ab101';
const OTHER_TENANT = '00000000-0000-4000-8000-0000a11ab102';
const OWNER = '00000000-0000-4000-8000-0000a11ab110';
const IN_TENANT_APPROVER = '00000000-0000-4000-8000-0000a11ab111';
const FOREIGN_APPROVER = '00000000-0000-4000-8000-0000a11ab112';

const PROJECT_ID = '00000000-0000-4000-8000-0000a11ab201';
const STREAM_ID = '00000000-0000-4000-8000-0000a11ab301';

const cards: string[] = [];
/** A fresh card id per mint — `mintOneOpenGate` dedupes on (tenant, card). */
const newCard = (tag: string): string => {
  const c = `answerability-${tag}-${process.pid}-${Date.now()}-${cards.length}`;
  cards.push(c);
  return c;
};

/**
 * A row that is ANSWERABLE on every arm, so each case below can knock out ONE
 * property and attribute the result to it. A baseline that is already failing
 * two arms cannot tell you which one the assertion caught.
 */
const answerable = (cardId: string): typeof approvals.$inferInsert =>
  ({
    tenant_id: TENANT,
    card_id: cardId,
    status: 'pending',
    kind: 'generic',
    source: 'n8n',
    description: 'answerable baseline',
    requester_id: OWNER,
    approver_user_id: IN_TENANT_APPROVER,
    expires_at: new Date(Date.now() + 86_400_000),
    metadata: { card_type: 'workflow_statistics_analysis' },
  }) as typeof approvals.$inferInsert;

let savedMode: string | undefined;

beforeEach(() => {
  savedMode = process.env[ANSWERABILITY_MODE_ENV];
  delete process.env[ANSWERABILITY_MODE_ENV];
});

afterEach(() => {
  if (savedMode === undefined) delete process.env[ANSWERABILITY_MODE_ENV];
  else process.env[ANSWERABILITY_MODE_ENV] = savedMode;
});

async function seed(): Promise<void> {
  await db
    .insert(projects)
    .values({
      id: PROJECT_ID,
      owner_id: OWNER,
      name: 'answerability fixture',
      repository_url: 'https://example.invalid/answerability',
    } as typeof projects.$inferInsert)
    .onConflictDoNothing();
  await db
    .insert(streams)
    .values({
      id: STREAM_ID,
      tenant_id: TENANT,
      // 'principle' is unconstrained by `streams_kind_tenant_check`; 'workflow'
      // and 'prompt' are pinned to specific system tenants and would fail the
      // CHECK under this fixture tenant.
      kind: 'principle',
      name: 'answerability fixture stream',
      slug: `answerability-fixture-${process.pid}`,
      planka_project_id: 'p-fixture',
      planka_board_id: 'b-fixture',
      // ⭐ MIGRATION 120's COLUMN — the whole point of the stream arm. Without
      // it a stream-only approval has no owner to derive and the resolution
      // correctly fails.
      project_id: PROJECT_ID,
    } as typeof streams.$inferInsert)
    .onConflictDoNothing();
  await db
    .insert(userRoles)
    .values({
      user_id: IN_TENANT_APPROVER,
      tenant_id: TENANT,
      role: 'workspace-admin',
    } as typeof userRoles.$inferInsert)
    .onConflictDoNothing();
  // The foreign approver is a REAL user with a REAL role — in ANOTHER tenant.
  // ⚠️ Without this row the test would pass for the wrong reason ("the user
  // does not exist"), which is not the defect: the measured approver is a
  // reachable, configured human with no standing in the row's tenant.
  await db
    .insert(userRoles)
    .values({
      user_id: FOREIGN_APPROVER,
      tenant_id: OTHER_TENANT,
      role: 'workspace-admin',
    } as typeof userRoles.$inferInsert)
    .onConflictDoNothing();
}

async function cleanup(): Promise<void> {
  if (cards.length > 0) {
    await db.delete(approvals).where(inArray(approvals.card_id, cards));
  }
  await db.delete(streams).where(eq(streams.id, STREAM_ID));
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await db.delete(userRoles).where(eq(userRoles.user_id, IN_TENANT_APPROVER));
  await db.delete(userRoles).where(eq(userRoles.user_id, FOREIGN_APPROVER));
}

afterAll(cleanup);


async function refusal(
  values: typeof approvals.$inferInsert,
  cardId: string,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await mintOneOpenGate({ tenantId: TENANT, cardId, values });
    return { code: undefined, message: 'NO REFUSAL — the gate minted the row' };
  } catch (err) {
    return {
      code: (err as { code?: string }).code,
      message: (err as Error).message,
    };
  }
}

// ── ARM 1 — NO RESOLVABLE REQUESTER ─────────────────────────────────────────

itDb('requester_unresolvable: observe MINTS and counts; enforce REFUSES', async () => {
  await seed();

  const observeCard = newCard('req-observe');
  const { gate } = await mintOneOpenGate({
    tenantId: TENANT,
    cardId: observeCard,
    values: {
      ...answerable(observeCard),
      requester_id: null,
      // No project_id, no project_request_id, no metadata.stream_id and no
      // metadata.requested_by_user_id — every derivation source is absent, so
      // this is genuinely unresolvable rather than merely unresolved.
      metadata: { card_type: 'workflow_statistics_analysis' },
    } as typeof approvals.$inferInsert,
  });
  expect(gate.requester_id).toBeNull();

  process.env[ANSWERABILITY_MODE_ENV] = 'enforce';
  const enforceCard = newCard('req-enforce');
  const out = await refusal(
    {
      ...answerable(enforceCard),
      requester_id: null,
      metadata: { card_type: 'workflow_statistics_analysis' },
    } as typeof approvals.$inferInsert,
    enforceCard,
  );
  expect(out.code).toBe(ANSWERABILITY_REFUSAL_CODE);
  expect(out.message).toContain('requester_unresolvable');

  // ⭐ THE REFUSAL MUST LEAVE NO ROW. Refusing after the insert would fail the
  // response and still strand the unanswerable approval — the inverse of intent.
  const rows = await db.select().from(approvals).where(eq(approvals.card_id, enforceCard));
  expect(rows).toHaveLength(0);
});

// ── THE RESOLUTION CASE — the one that proves "resolve before refuse" ────────

itDb(
  'a stream-only approval is RESOLVED through streams.project_id and minted, even under enforce',
  async () => {
    await seed();
    // Enforce ON for the whole case: a gate that merely "does not refuse in
    // observe mode" proves nothing, because observe mode never refuses anything.
    process.env[ANSWERABILITY_MODE_ENV] = 'enforce';

    const card = newCard('req-resolvable');
    const { gate } = await mintOneOpenGate({
      tenantId: TENANT,
      cardId: card,
      values: {
        ...answerable(card),
        requester_id: null,
        project_id: null,
        // Exactly the shape of the 105 measured rows: stream-only, so
        // `resolveCardApprovalRequesterId(projectId)` in routes/webhooks.ts is
        // handed a null project and returns null.
        metadata: {
          card_type: 'workflow_statistics_analysis',
          stream_id: STREAM_ID,
        },
      } as typeof approvals.$inferInsert,
    });

    expect(gate.requester_id).toBe(OWNER);

    // And the row is really there — a resolution that did not reach the INSERT
    // would count identically and write NULL.
    const [row] = await db.select().from(approvals).where(eq(approvals.card_id, card));
    expect(row?.requester_id).toBe(OWNER);
  },
);

// ── ARM 2 — APPROVER OUTSIDE THE ROW'S TENANT ───────────────────────────────

itDb('approver_foreign_tenant: observe MINTS and counts; enforce REFUSES', async () => {
  await seed();

  const observeCard = newCard('appr-observe');
  await mintOneOpenGate({
    tenantId: TENANT,
    cardId: observeCard,
    values: {
      ...answerable(observeCard),
      approver_user_id: FOREIGN_APPROVER,
    } as typeof approvals.$inferInsert,
  });

  process.env[ANSWERABILITY_MODE_ENV] = 'enforce';
  const enforceCard = newCard('appr-enforce');
  const out = await refusal(
    {
      ...answerable(enforceCard),
      approver_user_id: FOREIGN_APPROVER,
    } as typeof approvals.$inferInsert,
    enforceCard,
  );
  expect(out.code).toBe(ANSWERABILITY_REFUSAL_CODE);
  expect(out.message).toContain('approver_foreign_tenant');
});

itDb('an IN-TENANT approver is not flagged — the control that makes the arm mean something', async () => {
  await seed();
  process.env[ANSWERABILITY_MODE_ENV] = 'enforce';

  const card = newCard('appr-control');
  const { gate } = await mintOneOpenGate({
    tenantId: TENANT,
    cardId: card,
    // IN_TENANT_APPROVER holds `workspace-admin` under TENANT. Same code path,
    // same enforce mode, opposite verdict — without this the arm could be
    // refusing every approver and still look correct.
    values: answerable(card),
  });
  expect(gate.id).toBeTruthy();
});

// ── ARM 3 — NO DEADLINE ─────────────────────────────────────────────────────

itDb(
  'deadline_absent is ALWAYS RESOLVED, never refused — and the reaper predicate can then match',
  async () => {
    await seed();
    // ⭐ Enforce ON, and the assertion is still "minted". This arm has a
    // correct answer (lib/approval-deadline.ts's tenant default), so refusing
    // it would be exactly the "refusal that could have been a resolution" the
    // gate is forbidden to ship. Asserting it under `enforce` is what stops a
    // future edit from quietly moving it into the refusable set.
    process.env[ANSWERABILITY_MODE_ENV] = 'enforce';

    const card = newCard('deadline');
    const values = { ...answerable(card) } as Record<string, unknown>;
    delete values.expires_at;

    const { gate } = await mintOneOpenGate({
      tenantId: TENANT,
      cardId: card,
      values: values as typeof approvals.$inferInsert,
    });

    expect(gate.expires_at).not.toBeNull();

    // ⭐ THE PREDICATE, NOT THE COLUMN — and this is the assertion that
    // matters. `expires_at IS NOT NULL` is necessary but does not say the row
    // is reapable; `workers/approval-expiry.ts` selects on
    // `status = 'pending' AND expires_at <= now()`, and for NULL that
    // comparison evaluates to NULL at EVERY future instant, so the row can
    // never be selected by that worker at any time. Asked at a horizon past
    // the 14-day default, a resolved row matches — a NULL one never would.
    // The predicate text below is the worker's, verbatim, plus the horizon.
    const matched = await queryClient<{ id: string }[]>`
      SELECT id FROM approvals
       WHERE card_id = ${card}
         AND status = 'pending'
         AND expires_at <= now() + interval '15 days'
    `;
    expect(matched).toHaveLength(1);
  },
);

// ── ARM 4 — NOTHING SAYS WHAT IS BEING ASKED ────────────────────────────────

itDb(
  'no_card_type_and_no_gate_terms: observe MINTS and counts; enforce REFUSES',
  async () => {
    await seed();

    const observeCard = newCard('terms-observe');
    await mintOneOpenGate({
      tenantId: TENANT,
      cardId: observeCard,
      values: {
        ...answerable(observeCard),
        metadata: { boardId: 'b-fixture' },
      } as typeof approvals.$inferInsert,
    });

    process.env[ANSWERABILITY_MODE_ENV] = 'enforce';
    const enforceCard = newCard('terms-enforce');
    const out = await refusal(
      {
        ...answerable(enforceCard),
        // ⚠️ An EMPTY gate_terms array must not buy a pass. It states no
        // condition, so it is the same finding as an absent key for THIS
        // question — a vacuous gate would otherwise satisfy the guard.
        metadata: { boardId: 'b-fixture', gate_terms: [] },
      } as typeof approvals.$inferInsert,
      enforceCard,
    );
    expect(out.code).toBe(ANSWERABILITY_REFUSAL_CODE);
    expect(out.message).toContain('no_card_type_and_no_gate_terms');
  },
);

itDb('gate_terms ALONE satisfies the arm — card_type is not required', async () => {
  await seed();
  process.env[ANSWERABILITY_MODE_ENV] = 'enforce';

  const card = newCard('terms-control');
  const { gate } = await mintOneOpenGate({
    tenantId: TENANT,
    cardId: card,
    values: {
      ...answerable(card),
      metadata: { gate_terms: ['the canary error rate stayed under 2% for 30 min'] },
    } as typeof approvals.$inferInsert,
  });
  expect(gate.id).toBeTruthy();
});

// ── ARM 5 — tenant_id VS metadata.policy_key ────────────────────────────────

itDb(
  'a policy_key naming another tenant is RECORDED on the row and counted, never obeyed and never refused',
  async () => {
    await seed();
    // Enforce ON deliberately: this row IS answerable — a human can read and
    // decide it — so the mislabelling must not stop it. Refusing here would
    // block 9 decidable sign-offs a week to punish a label.
    process.env[ANSWERABILITY_MODE_ENV] = 'enforce';

    const card = newCard('policy-key');
    const { gate } = await mintOneOpenGate({
      tenantId: TENANT,
      cardId: card,
      values: {
        ...answerable(card),
        kind: 'execution.ready_signoff',
        callback_path: 'execution-ready-signoff-callback',
        metadata: {
          card_type: 'workflow_statistics_analysis',
          // The measured shape: a composite key whose embedded tenant is NOT
          // the tenant fr resolved for the board.
          policy_key: `ready-prefetch:${OTHER_TENANT}:v3`,
        },
      } as typeof approvals.$inferInsert,
    });

    // ⛔ THE ROW'S TENANT IS UNCHANGED. The producer's string must never be
    // able to move a gate into a tenant that never owned the work.
    expect(gate.tenant_id).toBe(TENANT);

    const meta = gate.metadata as Record<string, unknown>;
    expect(meta.policy_key_tenant_mismatch).toEqual({
      policy_key_tenant: OTHER_TENANT,
      row_tenant: TENANT,
    });
  },
);

itDb('an AGREEING policy_key leaves metadata untouched', async () => {
  await seed();
  const card = newCard('policy-key-agree');
  const { gate } = await mintOneOpenGate({
    tenantId: TENANT,
    cardId: card,
    values: {
      ...answerable(card),
      kind: 'execution.ready_signoff',
      metadata: {
        card_type: 'workflow_statistics_analysis',
        policy_key: `ready-prefetch:${TENANT}:v3`,
      },
    } as typeof approvals.$inferInsert,
  });
  const meta = gate.metadata as Record<string, unknown>;
  expect(meta.policy_key_tenant_mismatch).toBeUndefined();
});
