// USER RULING 2026-10-02 — Telegram may APPROVE-ALL a bug-fix authorization (A1) and a
// feature-design approval (A3); reject / partial / question stay web-only.
//
// What this pins:
//   * chatSeatMayApproveAll (deblock-actions.ts): true for a marked execution.ready_signoff
//     row and a feature_design row; FALSE for a marked generic row (ruling a, 10-01: approving
//     it authorises nothing, so approve-all would promise a fix the gate refuses); FALSE whenever another web-only
//     reason applies — kind qa.coverage_signoff (even marked), stored deblock_action
//     RECLASSIFY / COVERAGE (even marked), an unparseable stored action — and for a plain row.
//   * buildChatApproveAllG12Body (u3-gates.ts) produces a body the REAL assertU3DecideGates
//     accepts with status 'approved', every item approve; A1 rejected_bug_ids is [].
//   * A tampered row still refuses: report_hash not the stored H_r, missing bug_ids, a design
//     hash changed after the body was built, a missing design id; and a marked GENERIC row is
//     refused by the builder (approving it authorises no fix — ruling a, 10-01).
//   * A3's body carries a3_inputs_hash (design_hash with the write-set seal folded in), never
//     the bare design_hash; a row with no sealed write_set, or a write_set that no longer
//     recomputes to its seal, is refused by the builder (write_set_missing / _seal_mismatch).
//   * execution.question (G-12 A6) is never approve-all: its approve must name a Q-id.
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { queryClient } from '../../../../src/db/client';
import { chatSeatMayApproveAll } from '../../../../src/domain/engagement/deblock-actions';
import { G12_RULES, g12CodesFor, g12RowKeyFor } from '../../../../src/services/approvals/g12-rule';
import {
  CHAT_APPROVE_ALL_NOT_AVAILABLE,
  FEATURE_DESIGN_APPROVAL_KIND,
  assertU3DecideGates,
  buildChatApproveAllG12Body,
} from '../../../../src/services/approvals/u3-gates';
import { createDbSuite } from '../../../integration/helpers/db-suite';
import { A3_INPUTS_HASH, U3_BUGS, bugFixMeta, designMetadata, sealedDesignMetadata, seedBugReport, HUMAN_DECIDER_ID } from './u3-fixtures';

const { itDb } = createDbSuite('u3-chat-approve-all');
const TENANT = randomUUID();
const LATEST_RULE = G12_RULES[G12_RULES.length - 1]!;
const LATEST = LATEST_RULE.rule_version;
// Row keys via the gate's own resolver — never hardcoded (the resolution may change).
const ROW_A1 = g12RowKeyFor(LATEST_RULE, 'bug_fix_authorization')!;
const ROW_A3 = g12RowKeyFor(LATEST_RULE, FEATURE_DESIGN_APPROVAL_KIND)!;

afterAll(async () => {
  try {
    await queryClient`DELETE FROM project_reports WHERE tenant_id = ${TENANT}::uuid`;
  } catch {
    /* no database — the DB arms already skipped visibly */
  }
}, 30_000);

/** Run `fn`, return the error code it throws, or fail. */
async function refusalCode(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  throw new Error('expected a refusal, got none');
}

const MARKER = { approval_kind: 'bug_fix_authorization' };

describe('chatSeatMayApproveAll', () => {
  test('true: marked execution.ready_signoff row, feature_design row', () => {
    expect(chatSeatMayApproveAll({ kind: 'execution.ready_signoff', metadata: MARKER })).toBe(true);
    expect(chatSeatMayApproveAll({ kind: FEATURE_DESIGN_APPROVAL_KIND, metadata: designMetadata() })).toBe(true);
  });

  test('false: a MARKED generic row — approving it authorises no fix (ruling a, 10-01), so it stays web-only', () => {
    expect(chatSeatMayApproveAll({ kind: 'generic', metadata: MARKER })).toBe(false);
    expect(chatSeatMayApproveAll({ kind: 'generic', metadata: { ...MARKER, deblock_action: 'RETRY' } })).toBe(false);
  });

  test('false: a row whose bare approve OWES AN ANSWER (web refuses the empty approve)', () => {
    expect(chatSeatMayApproveAll({ kind: 'execution.ready_signoff', metadata: { ...MARKER, deblock_action: 'QUESTION' } })).toBe(false);
    expect(chatSeatMayApproveAll({ kind: 'execution.ready_signoff', metadata: { ...MARKER, deblock_action: 'INFRASTRUCTURE' } })).toBe(false);
    expect(chatSeatMayApproveAll({ kind: 'execution.ready_signoff', metadata: { ...MARKER, open_questions: ['which env?'] } })).toBe(false);
    expect(chatSeatMayApproveAll({ kind: FEATURE_DESIGN_APPROVAL_KIND, metadata: { ...designMetadata(), open_questions: ['which env?'] } })).toBe(false);
  });

  test('true: an EMPTY open_questions array owes nothing (663 of 914 prod ready_signoff rows, 2026-10-02)', () => {
    expect(chatSeatMayApproveAll({ kind: 'execution.ready_signoff', metadata: { ...MARKER, open_questions: [] } })).toBe(true);
    expect(chatSeatMayApproveAll({ kind: FEATURE_DESIGN_APPROVAL_KIND, metadata: { ...designMetadata(), open_questions: [] } })).toBe(true);
  });

  test('false: qa.coverage_signoff — plain AND bug-fix-marked (the kind exclusion wins over the marker)', () => {
    expect(chatSeatMayApproveAll({ kind: 'qa.coverage_signoff', metadata: {} })).toBe(false);
    expect(chatSeatMayApproveAll({ kind: 'qa.coverage_signoff', metadata: MARKER })).toBe(false);
    // U4 A5 merge sign-off: never approve-all from chat (marked or not, any metadata).
    expect(chatSeatMayApproveAll({ kind: 'execution.landing_signoff', metadata: {} })).toBe(false);
    expect(chatSeatMayApproveAll({ kind: 'execution.landing_signoff', metadata: MARKER })).toBe(false);
  });

  test('false: stored RECLASSIFY / COVERAGE — unmarked, marked, and on a feature_design row', () => {
    for (const action of ['RECLASSIFY', 'COVERAGE']) {
      expect([action, chatSeatMayApproveAll({ kind: 'generic', metadata: { deblock_action: action } })]).toEqual([action, false]);
      expect([action, chatSeatMayApproveAll({ kind: 'generic', metadata: { ...MARKER, deblock_action: action } })]).toEqual([
        action,
        false,
      ]);
      expect([
        action,
        chatSeatMayApproveAll({ kind: 'execution.ready_signoff', metadata: { ...MARKER, deblock_action: action } }),
      ]).toEqual([action, false]);
      expect([
        action,
        chatSeatMayApproveAll({ kind: FEATURE_DESIGN_APPROVAL_KIND, metadata: { ...designMetadata(), deblock_action: action } }),
      ]).toEqual([action, false]);
      // a top-level deblock_action on the row is honoured too (fail closed) — on an otherwise
      // ELIGIBLE row, so the exclusion is what makes it false
      expect([action, chatSeatMayApproveAll({ kind: 'execution.ready_signoff', metadata: MARKER, deblock_action: action })]).toEqual([
        action,
        false,
      ]);
    }
  });

  test('false: plain generic / ready_signoff rows, a non-marker approval_kind, an unparseable stored action', () => {
    expect(chatSeatMayApproveAll({ kind: 'generic', metadata: {} })).toBe(false);
    expect(chatSeatMayApproveAll({ kind: 'generic', metadata: { deblock_action: 'RETRY' } })).toBe(false);
    expect(chatSeatMayApproveAll({ kind: 'execution.ready_signoff', metadata: null })).toBe(false);
    expect(chatSeatMayApproveAll({ kind: 'generic', metadata: { approval_kind: 'bug_fix' } })).toBe(false);
    expect(chatSeatMayApproveAll({ kind: 'generic', metadata: { ...MARKER, deblock_action: 'coverage' } })).toBe(false);
  });

});

describe('buildChatApproveAllG12Body → assertU3DecideGates', () => {
  const BUG_IDS = U3_BUGS.map((b) => b.id);

  test('A3: the built body is accepted as approved; one item, the design, approved with the first approve code', async () => {
    const approval = { id: randomUUID(), tenant_id: TENANT, kind: FEATURE_DESIGN_APPROVAL_KIND, metadata: sealedDesignMetadata() };
    const rawBody = await buildChatApproveAllG12Body(approval);
    const out = await assertU3DecideGates({ approval, rawBody, status: 'approved', deciderId: HUMAN_DECIDER_ID });
    expect(out?.rule_row).toBe(ROW_A3);
    expect(out?.rule_version).toBe(LATEST);
    // the seal-folded hash, NOT the bare design_hash
    expect(out?.inputs_hash).toBe(A3_INPUTS_HASH);
    expect(out?.inputs_hash).not.toBe('d'.repeat(64));
    expect(out?.items).toEqual([
      { item_id: 'design-1', decision: 'approve', reason_code: g12CodesFor(LATEST, ROW_A3)!.approve[0]! },
    ]);
  });

  test('A3 tampered: design_hash changed after the body was built → 409 inputs_hash_mismatch', async () => {
    const approval = { id: randomUUID(), tenant_id: TENANT, kind: FEATURE_DESIGN_APPROVAL_KIND, metadata: sealedDesignMetadata() };
    const rawBody = await buildChatApproveAllG12Body(approval);
    const tampered = { ...approval, metadata: sealedDesignMetadata({ design_hash: 'e'.repeat(64) }) };
    expect(await refusalCode(() => assertU3DecideGates({ approval: tampered, rawBody, status: 'approved', deciderId: HUMAN_DECIDER_ID }))).toBe(
      'inputs_hash_mismatch',
    );
  });

  test('A3 with no sealed write_set → the builder refuses 409 write_set_missing (nothing to approve-all)', async () => {
    for (const missing of ['write_set', 'write_set_seal', 'a3_inputs_hash']) {
      const metadata = sealedDesignMetadata();
      delete metadata[missing];
      expect([
        missing,
        await refusalCode(() =>
          buildChatApproveAllG12Body({ id: randomUUID(), tenant_id: TENANT, kind: FEATURE_DESIGN_APPROVAL_KIND, metadata }),
        ),
      ]).toEqual([missing, 'write_set_missing']);
    }
  });

  test('A3 with a stored write_set that no longer recomputes to its seal → the builder refuses write_set_seal_mismatch', async () => {
    const metadata = { ...sealedDesignMetadata(), write_set: ['src/design.ts', 'src/other.ts'] };
    expect(
      await refusalCode(() =>
        buildChatApproveAllG12Body({ id: randomUUID(), tenant_id: TENANT, kind: FEATURE_DESIGN_APPROVAL_KIND, metadata }),
      ),
    ).toBe('write_set_seal_mismatch');
  });

  test('execution.question (A6) is never approve-all: chat cannot say WHICH registered answer', async () => {
    const metadata = { question_id: 'Q2', question_text: 'deps?', question_text_sha256: 'a'.repeat(64) };
    expect(chatSeatMayApproveAll({ kind: 'execution.question', metadata })).toBe(false);
    expect(
      await refusalCode(() => buildChatApproveAllG12Body({ id: randomUUID(), tenant_id: TENANT, kind: 'execution.question', metadata })),
    ).toBe(CHAT_APPROVE_ALL_NOT_AVAILABLE);
  });

  test('A3 without a design id / hash → the builder refuses (never guesses an item)', async () => {
    for (const missing of ['design_artifact_id', 'design_hash']) {
      const metadata = designMetadata();
      delete metadata[missing];
      expect([
        missing,
        await refusalCode(() =>
          buildChatApproveAllG12Body({ id: randomUUID(), tenant_id: TENANT, kind: FEATURE_DESIGN_APPROVAL_KIND, metadata }),
        ),
      ]).toEqual([missing, CHAT_APPROVE_ALL_NOT_AVAILABLE]);
    }
  });

  test('a row that is neither A1 nor A3 → the builder refuses', async () => {
    expect(
      await refusalCode(() => buildChatApproveAllG12Body({ id: randomUUID(), tenant_id: TENANT, kind: 'generic', metadata: {} })),
    ).toBe(CHAT_APPROVE_ALL_NOT_AVAILABLE);
  });

  itDb('A1 (marked ready_signoff): accepted as approved; every bug approved, rejected_bug_ids []', async () => {
    const rep = await seedBugReport(TENANT);
    const approval = { id: randomUUID(), tenant_id: TENANT, kind: 'execution.ready_signoff', metadata: bugFixMeta(rep) };
    const rawBody = await buildChatApproveAllG12Body(approval);
    expect(rawBody).not.toHaveProperty('rejected_bug_ids');
    const out = await assertU3DecideGates({ approval, rawBody, status: 'approved', deciderId: HUMAN_DECIDER_ID });
    expect(out?.rule_row).toBe(ROW_A1);
    expect(out?.rule_version).toBe(LATEST);
    expect(out?.inputs_hash).toBe(rep.hash);
    expect(out?.rejected_bug_ids).toEqual([]);
    expect(out?.items.map((i) => i.item_id)).toEqual(BUG_IDS);
    expect(out?.items.every((i) => i.decision === 'approve' && i.reason_code === g12CodesFor(LATEST, ROW_A1)!.approve[0])).toBe(
      true,
    );
  });

  itDb('A1 tampered: report_hash not the stored H_r → 409 report_hash_mismatch', async () => {
    const rep = await seedBugReport(TENANT);
    const approval = {
      id: randomUUID(),
      tenant_id: TENANT,
      kind: 'execution.ready_signoff',
      metadata: bugFixMeta(rep, { report_hash: 'e'.repeat(64) }),
    };
    const rawBody = await buildChatApproveAllG12Body(approval);
    expect(await refusalCode(() => assertU3DecideGates({ approval, rawBody, status: 'approved', deciderId: HUMAN_DECIDER_ID }))).toBe('report_hash_mismatch');
  });

  itDb('A1 tampered: bug_ids missing → 409 approval_items_missing', async () => {
    const rep = await seedBugReport(TENANT);
    const approval = {
      id: randomUUID(),
      tenant_id: TENANT,
      kind: 'execution.ready_signoff',
      metadata: bugFixMeta(rep, { bug_ids: [] }),
    };
    const rawBody = await buildChatApproveAllG12Body(approval);
    expect(await refusalCode(() => assertU3DecideGates({ approval, rawBody, status: 'approved', deciderId: HUMAN_DECIDER_ID }))).toBe(
      'approval_items_missing',
    );
  });

  test('A1 on a marked GENERIC row → the builder refuses: approving it authorises no fix (ruling a, 10-01)', async () => {
    for (const deblock_action of [undefined, 'RETRY', 'DROP']) {
      const metadata = { ...MARKER, report_id: randomUUID(), report_hash: 'a'.repeat(64), bug_ids: ['b1'], bug_card_id: 'c', deblock_action };
      expect([
        deblock_action,
        await refusalCode(() => buildChatApproveAllG12Body({ id: randomUUID(), tenant_id: TENANT, kind: 'generic', metadata })),
      ]).toEqual([deblock_action, CHAT_APPROVE_ALL_NOT_AVAILABLE]);
    }
  });
});
