// tests/unit/services/n8n-callback.test.ts
//
// Unit-tests the pure `buildCallbackPayload` helper used by deliverDecisionCallback.
// Asserts the new universal-receiver fields (approval_id, tenant_id,
// card_type, qaListId) are populated from the approval row + metadata.

import { describe, expect, test } from 'bun:test';
import {
  buildCallbackPayload,
  EXPIRY_CALLBACK_PATHS,
  VOIDED_CALLBACK_PATHS,
} from '../../../src/services/n8n-callback';

function fakeApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-1',
    tenant_id: 'tenant-1',
    project_id: null,
    requester_id: null,
    status: 'approved',
    kind: 'improvement.design',
    description: 'd',
    change_summary: null,
    impact_analysis: null,
    callback_path: 'improvement-approval-callback',
    card_id: 'card-1',
    source: 'n8n',
    metadata: {
      card_type: 'prompt_improvement',
      qaListId: 'list-qa',
      doingListId: 'list-doing',
      todoListId: 'list-todo',
      boardId: 'board-1',
    },
    action_id: null,
    action_name: null,
    action_input_json: null,
    action_correlation_id: null,
    action_channel: null,
    created_at: new Date(),
    expires_at: new Date(),
    completed_at: null,
    updated_at: new Date(),
    error_message: null,
    ...overrides,
  } as any;
}

function fakeDecision(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    approval_id: 'approval-1',
    approver_id: 'user-1',
    decision: 'approved',
    comment: 'lgtm',
    decided_at: new Date(),
    ...overrides,
  } as any;
}

describe('buildCallbackPayload', () => {
  test('approved path: emits full universal-receiver payload', () => {
    const payload = buildCallbackPayload(fakeApproval(), fakeDecision());

    expect(payload.card_id).toBe('card-1');
    expect(payload.decision).toBe('approved');
    expect(payload.comment).toBe('lgtm');
    expect(payload.decided_by).toBe('user-1');
    expect(payload.approval_id).toBe('approval-1');
    expect(payload.tenant_id).toBe('tenant-1');
    expect(payload.card_type).toBe('prompt_improvement');
    expect(payload.qaListId).toBe('list-qa');
    expect(payload.doingListId).toBe('list-doing');
    expect(payload.todoListId).toBe('list-todo');
    expect(payload.boardId).toBe('board-1');
  });

  // ── approval_kind (P2-MINTCALL) ─────────────────────────────────────────────
  // An A3 carries no deblock_action, so the receiver can only recognise it by kind.
  test('approval_kind: the row kind is echoed verbatim', () => {
    const payload = buildCallbackPayload(
      fakeApproval({ kind: 'execution.feature_design_approval' }),
      fakeDecision(),
    );
    expect(payload.approval_kind).toBe('execution.feature_design_approval');
    expect(buildCallbackPayload(fakeApproval(), fakeDecision()).approval_kind).toBe('improvement.design');
  });

  test('approval_kind: a row without a kind omits the key (older payloads stay byte-identical)', () => {
    for (const kind of [null, undefined, '']) {
      const payload = buildCallbackPayload(fakeApproval({ kind }), fakeDecision());
      expect(payload.approval_kind).toBeUndefined();
      expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty('approval_kind');
    }
  });

  // ── BLOCKED-exit proposition ────────────────────────────────────────────────
  // Both N8nCardApprovalSchema (inbound) and buildCallbackPayload (outbound) are
  // CLOSED allowlists. A key added to only one of them is silently dropped, which is
  // why these two are pinned on the way OUT specifically.
  test('deblock approval: carries deblock_action + learning_card_id back to n8n', () => {
    const payload = buildCallbackPayload(
      fakeApproval({
        metadata: {
          card_type: 'decision_development',
          boardId: 'board-1',
          deblock_action: 'RETRY',
          learning_card_id: 'card-learning-9',
        },
      }),
      fakeDecision(),
    );
    expect(payload.deblock_action).toBe('RETRY');
    expect(payload.learning_card_id).toBe('card-learning-9');
  });

  test('an unrecognised deblock_action is DROPPED, not forwarded as a string', () => {
    // The receiver switches on this value. Forwarding an unknown one would fall through
    // the switch and produce a decision that silently does nothing — the exact failure
    // shape this whole workstream exists to remove.
    const payload = buildCallbackPayload(
      fakeApproval({ metadata: { boardId: 'board-1', deblock_action: 'DELETE_EVERYTHING' } }),
      fakeDecision(),
    );
    expect(payload.deblock_action).toBeUndefined();
  });

  // ── MERGE (2026-08-31): the deliverable landed, so let the card finish ──────
  // Measured: of 31 PRs the AA conveyor has ever produced, 28 backed a card that reached
  // DONE and exactly TWO had ever merged. DONE meant "a PR was opened". The landing gate
  // now holds such a card in BLOCKED with block_reason `awaiting_merge`, which makes
  // "should this be merged?" a real human question — and this is the action that answers it.
  test('MERGE is forwarded, with the pull request it is about', () => {
    const payload = buildCallbackPayload(
      fakeApproval({
        metadata: {
          card_type: 'development_chore',
          boardId: 'board-1',
          deblock_action: 'MERGE',
          pr_url: 'https://github.com/nonagenticai/enterprise_mcp_server/pull/95',
          pr_repo_owner: 'nonagenticai',
          pr_repo_name: 'enterprise_mcp_server',
          pr_number: 95,
        },
      }),
      fakeDecision(),
    );
    expect(payload.deblock_action).toBe('MERGE');
    expect(payload.pr_number).toBe(95);
    expect(payload.pr_repo_owner).toBe('nonagenticai');
    expect(payload.pr_repo_name).toBe('enterprise_mcp_server');
    expect(payload.pr_url).toContain('/pull/95');
  });

  // ⛔ THE REGRESSION THIS PINS. This builder is a closed allowlist: a field the mint stores
  // but this does not name is silently dropped. A MERGE that arrives without its PR is an
  // instruction to merge NOTHING, delivered as a success — so the reference must travel, and
  // its absence must be visible rather than defaulted.
  test('a MERGE with no PR reference forwards the action and NO invented reference', () => {
    const payload = buildCallbackPayload(
      fakeApproval({ metadata: { boardId: 'board-1', deblock_action: 'MERGE' } }),
      fakeDecision(),
    );
    expect(payload.deblock_action).toBe('MERGE');
    expect(payload.pr_url).toBeUndefined();
    expect(payload.pr_number).toBeUndefined();
  });

  test('PR fields do not leak onto a non-MERGE approval', () => {
    const payload = buildCallbackPayload(
      fakeApproval({ metadata: { boardId: 'board-1', deblock_action: 'RETRY' } }),
      fakeDecision(),
    );
    expect(payload.pr_url).toBeUndefined();
    expect(payload.pr_number).toBeUndefined();
  });

  test('a non-deblock approval carries neither field', () => {
    const payload = buildCallbackPayload(fakeApproval(), fakeDecision());
    expect(payload.deblock_action).toBeUndefined();
    expect(payload.learning_card_id).toBeUndefined();
  });

  test('non-canary approval: canary routing fields are undefined', () => {
    const payload = buildCallbackPayload(fakeApproval(), fakeDecision());
    expect(payload.canary_action).toBeUndefined();
    expect(payload.list).toBeUndefined();
    expect(payload.additional_minutes).toBeUndefined();
  });

  test('canary extend approval: carries canary_action + list + additional_minutes', () => {
    const payload = buildCallbackPayload(
      fakeApproval({
        kind: 'improvement.canary_action',
        metadata: {
          card_type: 'code_change',
          canary_action: 'extend',
          list: 'DOING',
          additional_minutes: 120,
        },
      }),
      fakeDecision(),
    );
    expect(payload.card_type).toBe('code_change');
    expect(payload.canary_action).toBe('extend');
    expect(payload.list).toBe('DOING');
    expect(payload.additional_minutes).toBe(120);
  });

  test('canary rollback approval: additional_minutes absent, action=rollback', () => {
    const payload = buildCallbackPayload(
      fakeApproval({
        kind: 'improvement.canary_action',
        metadata: { card_type: 'code_change', canary_action: 'rollback', list: 'DOING' },
      }),
      fakeDecision(),
    );
    expect(payload.canary_action).toBe('rollback');
    expect(payload.list).toBe('DOING');
    expect(payload.additional_minutes).toBeUndefined();
  });

  test('invalid canary_action value is dropped (not echoed)', () => {
    const payload = buildCallbackPayload(
      fakeApproval({
        kind: 'improvement.canary_action',
        metadata: { card_type: 'code_change', canary_action: 'bogus', list: 'DOING' },
      }),
      fakeDecision(),
    );
    expect(payload.canary_action).toBeUndefined();
    expect(payload.list).toBe('DOING');
  });

  // ── voided (deblock-callback-redelivery widening) ───────────────────────────
  // Pins that `decision` is a direct pass-through of `approval.status`, not a
  // mapping that defaults unknown statuses to 'approved'. Reverting the cast in
  // buildCallbackPayload back to `as 'approved' | 'rejected' | 'expired'` does
  // NOT change the runtime value here (it is a type assertion, not a coercion),
  // so this case alone cannot catch that revert — it exists to catch a FUTURE
  // change that special-cases 'voided' into 'approved' at the value level.
  test('voided path: decision reports voided, never approved', () => {
    const payload = buildCallbackPayload(
      fakeApproval({ status: 'voided' }),
      fakeDecision({ decision: 'voided', comment: 'duplicate request' }),
    );
    expect(payload.decision).toBe('voided');
    expect(payload.decision).not.toBe('approved');
  });

  // A restart's void must be tellable from an operator's (George 2026-10-31): the stored
  // voided_reason rides on a voided callback, and only there.
  test('voided path: carries the row\'s voided_reason; every other decision is byte-identical', () => {
    const reason = 'project restarted (project, attempt 2): every card in scope runs again, so this ask is withdrawn';
    const voided = JSON.parse(
      JSON.stringify(buildCallbackPayload(fakeApproval({ status: 'voided', voided_reason: reason }), undefined)),
    );
    expect(voided.decision).toBe('voided');
    expect(voided.voided_reason).toBe(reason);
    expect(voided.voided_reason.startsWith('project restarted')).toBe(true);
    expect(voided).not.toHaveProperty('comment');
    // A voided row with no stored reason sends no key.
    expect(JSON.parse(JSON.stringify(buildCallbackPayload(fakeApproval({ status: 'voided' }), undefined)))).not.toHaveProperty(
      'voided_reason',
    );
    // Any other decision: no key, even when the row somehow carries a reason; the JSON equals the reason-less row's.
    for (const status of ['approved', 'rejected', 'expired']) {
      const withReason = JSON.stringify(
        buildCallbackPayload(fakeApproval({ status, voided_reason: reason }), fakeDecision({ decision: status })),
      );
      const without = JSON.stringify(buildCallbackPayload(fakeApproval({ status }), fakeDecision({ decision: status })));
      expect(withReason).toBe(without);
      expect(withReason).not.toContain('voided_reason');
    }
  });

  test('rejected path: comment carries reviewer reason', () => {
    const payload = buildCallbackPayload(
      fakeApproval({ status: 'rejected' }),
      fakeDecision({ decision: 'rejected', comment: 'needs more evidence' }),
    );
    expect(payload.decision).toBe('rejected');
    expect(payload.comment).toBe('needs more evidence');
  });

  test('missing metadata fields: omits undefined keys (no empty strings)', () => {
    const payload = buildCallbackPayload(
      fakeApproval({ metadata: { card_type: 'prompt_improvement' } }),
      fakeDecision(),
    );
    expect(payload.card_type).toBe('prompt_improvement');
    expect(payload.qaListId).toBeUndefined();
    expect(payload.doingListId).toBeUndefined();
    expect(payload.todoListId).toBeUndefined();
    expect(payload.boardId).toBeUndefined();
  });

  test('null metadata: payload still valid, downstream fields undefined', () => {
    const payload = buildCallbackPayload(
      fakeApproval({ metadata: null }),
      fakeDecision(),
    );
    expect(payload.card_id).toBe('card-1');
    expect(payload.tenant_id).toBe('tenant-1');
    expect(payload.card_type).toBeUndefined();
    expect(payload.qaListId).toBeUndefined();
  });

  test('no decision row: decided_by defaults to "system"', () => {
    const payload = buildCallbackPayload(fakeApproval(), undefined);
    expect(payload.decided_by).toBe('system');
    expect(payload.comment).toBeUndefined();
  });
});

describe('redelivery: the sender half of the receiver guard', () => {
  // ⭐ WHY THIS ASSERTS THE PAYLOAD AND NOT A CALL COUNT. The receiver's guard
  // (`approval-callback.json :: Resolve Target List`) has existed since #1285 and
  // shipped deliberately INERT — its header says it "must land BEFORE any sender may
  // re-deliver". Nothing ever armed it: measured 2026-09-10, `redelivery` appeared
  // NOWHERE in this repo, so `isRedelivery` was always false and a re-send moved the
  // card unconditionally. A test that asserts the worker "called the sender" passes
  // just as happily with the field dropped, which is exactly how that gap survived.
  // The only assertion that can fail for the real defect is one on the BODY.

  test('a first delivery does NOT put the key on the wire at all', () => {
    const payload = buildCallbackPayload(fakeApproval(), fakeDecision());
    // `undefined`, not `false`. The receiver's Parse Decision runs a closed allowlist
    // and defaults the field itself, so omitting it keeps the first-delivery payload
    // byte-identical to what it has always been — the property that makes arming the
    // re-delivery half safe to ship.
    expect(payload.redelivery).toBeUndefined();
    // Asserted on the WIRE, not on key presence. A builder that omits the key entirely
    // is behaviourally identical here, and pinning `hasOwnProperty` would red a
    // legitimate refactor while proving nothing a caller can observe.
    expect(JSON.stringify(payload)).not.toContain('redelivery');
  });

  test('an explicit re-delivery sets it to true', () => {
    const payload = buildCallbackPayload(fakeApproval(), fakeDecision(), { redelivery: true });
    expect(payload.redelivery).toBe(true);
    expect(JSON.parse(JSON.stringify(payload)).redelivery).toBe(true);
  });

  test('only the boolean true arms it — a truthy non-boolean does not', () => {
    // Mirrors the receiver, whose Parse Decision accepts `=== true` and nothing else.
    // If these two disagreed, a caller could believe it armed a guard that stayed inert.
    const payload = buildCallbackPayload(
      fakeApproval(), fakeDecision(), { redelivery: 'yes' as unknown as boolean },
    );
    expect(payload.redelivery).toBeUndefined();
  });

  test('redelivery=false is treated as a first delivery, key omitted', () => {
    const payload = buildCallbackPayload(fakeApproval(), fakeDecision(), { redelivery: false });
    expect(payload.redelivery).toBeUndefined();
  });
});

// fr#1481 (U-PS-PHASEEXIT): the approval-completion phase target and its card-type fallback
// were DELETED — no approval advances a phase from its metadata. Their behaviour is now
// an absence (its integration pin, the plan-phase-exit suite's legacy controls,
// was deleted 2026-10-29). The contract-gate sign-off route that minted such rows was deleted
// 2026-10-09.

// ─────────────────────────────────────────────────────────────────────────────────────
// DUAL EXIT — a row carrying BOTH a lane marker and a usable `deblock_action`.
//
// ⛔ THIS IS THE CASE NO TEST IN THIS REPO CONSTRUCTED, AND THAT IS WHY IT SHIPPED.
// `tests/unit/domain/deblock-exit-classifier.test.ts` already pinned that a lane exemption
// outranks a usable action IN THE CLASSIFIER. Nothing asserted what THIS builder does with
// the same row — and the answer was "sends the action anyway", because it never consulted
// the classifier at all. One row, two code paths, opposite conclusions.
//
// ⚠️ NOTE `fakeApproval`'s DEFAULT `kind` IS `improvement.design`, which is itself a lane
// carve-out. Every fixture below therefore states its `kind` explicitly: inheriting the
// default would have made these tests measure the improvement lane while claiming to
// measure the phase lane, and the two are handled deliberately differently.
// ─────────────────────────────────────────────────────────────────────────────────────
describe('a dual-exit row: the phase advance survives, the card move is withheld', () => {
  /** BOTH exits asserted on one row. `project_id` + approved so the phase half is live too. */
  const dualExitRow = (action: string) =>
    fakeApproval({
      kind: 'generic',
      project_id: 'project-1',
      status: 'approved',
      metadata: {
        boardId: 'board-1',
        doingListId: 'list-doing',
        todoListId: 'list-todo',
        advance_phase_on_approve: 'deep_analysis',
        deblock_action: action,
      },
    });

  test('the deblock_action is WITHHELD from the payload — TWO different keys', () => {
    // Two keys, not one: a builder that special-cased the string 'RETRY' would pass the
    // first assertion and fail the second.
    expect(buildCallbackPayload(dualExitRow('RETRY'), undefined).deblock_action).toBeUndefined();
    expect(buildCallbackPayload(dualExitRow('MERGE'), undefined).deblock_action).toBeUndefined();
  });

  test('⭐ THE CONTROL: the SAME row without the phase marker still sends the action', () => {
    // Without this the test above passes for a builder that dropped `deblock_action`
    // unconditionally — which would strand every one of the 1,763 prod rows that carry one.
    const soloExit = fakeApproval({
      kind: 'generic',
      metadata: {
        boardId: 'board-1',
        doingListId: 'list-doing',
        todoListId: 'list-todo',
        deblock_action: 'RETRY',
      },
    });
    expect(buildCallbackPayload(soloExit, undefined).deblock_action).toBe('RETRY');
  });

  test('a phase marker with an UNRECOGNISED action withholds nothing extra', () => {
    // 'UNBLOCK' is not in the closed set, so there is no usable action to conflict with and
    // no dual exit. The field was already dropped by `asDeblockAction` for its own reason,
    // and this must not be mistaken for the new behaviour.
    const row = fakeApproval({
      kind: 'generic',
      metadata: { boardId: 'board-1', advance_phase_on_approve: 'deep_analysis', deblock_action: 'UNBLOCK' },
    });
    expect(buildCallbackPayload(row, undefined).deblock_action).toBeUndefined();
  });

  test('⛔ the improvement lane is NOT withheld — 32 of its 34 prod rows carry an action', () => {
    // The load-bearing exclusion. `improvement.design` + a usable action is the NORMAL
    // shape of a live lane, not a defect, so it keeps sending the action. Sweeping it into
    // the same refusal for symmetry would stop 32 live rows' cards from moving.
    const improvementRow = fakeApproval({
      kind: 'improvement.design',
      metadata: { boardId: 'board-1', doingListId: 'list-doing', deblock_action: 'QUESTION' },
    });
    expect(buildCallbackPayload(improvementRow, undefined).deblock_action).toBe('QUESTION');
  });

  // ⭐ NARROWED 2026-09-14. This used to read "the signoff rail IS withheld — measured 0 of
  // 844, so this costs nothing today" and assert `undefined` on a single-exit signoff row.
  // That was headroom, not a premise: once the producer started writing `deblock_action`
  // into signoff metadata, withholding it meant the n8n signoff answer rail could never
  // fire. The rail is now withheld ONLY when the row carries `advance_phase_on_approve`
  // (since fr#1481 the `decision_development` card-type phase signal no longer exists).
  const signoffRow = (action: string, extra: Record<string, unknown> = {}) =>
    fakeApproval({
      kind: 'execution.ready_signoff',
      metadata: { boardId: 'board-1', doingListId: 'list-doing', deblock_action: action, ...extra },
    });

  test('⭐ a SINGLE-exit signoff row SENDS its deblock_action — TWO different keys', () => {
    // RED on the un-narrowed classifier (`signoff_rail` + any usable action = conflict).
    expect(buildCallbackPayload(signoffRow('RETRY'), undefined).deblock_action).toBe('RETRY');
    expect(
      buildCallbackPayload(signoffRow('QUESTION', { card_type: 'code_change' }), undefined)
        .deblock_action,
    ).toBe('QUESTION');
  });

  test('fr#1481: a contract-gate card_type no longer makes a signoff row dual-exit — it SENDS', () => {
    // Before fr#1481 `decision_development` also advanced the macro phase, so this row
    // exited twice and the card move was withheld. That phase advance was deleted, so the
    // card move is the row's ONLY exit and must travel (withholding it would be a silent
    // drop of the decision's single effect).
    const row = signoffRow('RETRY', { card_type: 'decision_development' });
    expect(buildCallbackPayload(row, undefined).deblock_action).toBe('RETRY');
    expect(buildCallbackPayload(row, undefined).card_type).toBe('decision_development');
  });

  test('a signoff row with advance_phase_on_approve is still withheld (phase_advance wins)', () => {
    const row = signoffRow('MERGE', { advance_phase_on_approve: 'deep_analysis' });
    expect(buildCallbackPayload(row, undefined).deblock_action).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// VOIDED_CALLBACK_PATHS — fr must not fire `decision: 'voided'` at a receiver
// that cannot route it.
//
// `buildCallbackPayload` passes the row's status THROUGH (`decision:
// approval.status`), so a voided approval puts the literal string `voided` on
// the wire. Measured 2026-09-07 against the live n8n `workflow_entity` on
// worker4: `execution-ready-signoff-callback` routes exactly
// `idempotent,approved,rejected,expired` with `fallbackOutput: "none"` — an
// unmatched item is DROPPED while the webhook still answers 200. fr routes 98
// voided approvals at it.
//
// ⚠️ THE UNTAUGHT PATH BELOW IS A REAL, LIVE, MEASURED-UNTAUGHT RECEIVER, and
// it must stay one. If
// `execution-ready-signoff-callback` is ever taught `voided` and admitted to
// the allowlist, this constant must be repointed at another genuinely untaught
// receiver, NOT updated to match — otherwise the refusal test silently becomes
// a duplicate of the delivery test and the safety property loses its only
// guard.
// ---------------------------------------------------------------------------

const TAUGHT_PATH = 'kanban/approval-callback';
const UNTAUGHT_PATH = 'execution-ready-signoff-callback';

describe('VOIDED_CALLBACK_PATHS — the allowlist itself', () => {
  test('holds the taught receiver and REFUSES the measured-untaught one', () => {
    expect(VOIDED_CALLBACK_PATHS.has(TAUGHT_PATH)).toBe(true);
    expect(VOIDED_CALLBACK_PATHS.has(UNTAUGHT_PATH)).toBe(false);
  });

  test('is STRICTLY SMALLER than EXPIRY_CALLBACK_PATHS — the two are not interchangeable', () => {
    // Two of the three receivers taught `expired` were never taught `voided`.
    // Merging the lists (or seeding this one from that one) reintroduces the bug.
    for (const path of VOIDED_CALLBACK_PATHS) {
      expect(EXPIRY_CALLBACK_PATHS.has(path)).toBe(true);
    }
    expect(VOIDED_CALLBACK_PATHS.size).toBeLessThan(EXPIRY_CALLBACK_PATHS.size);
    expect(EXPIRY_CALLBACK_PATHS.has(UNTAUGHT_PATH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// project_id — George 2026-10-08: every conveyor call carries the projectId and
// a missing one fails loudly. n8n's `approval-callback.json :: Check Merge Base`
// refuses to merge without it, so fr must put it on EVERY callback body: the
// row's own column, else the project its board/card maps to, else an explicit
// null (never a placeholder, never the tenant id).
// ---------------------------------------------------------------------------

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';

describe('buildCallbackPayload carries project_id', () => {
  test("the row's own project_id goes on the wire", () => {
    const payload = buildCallbackPayload(fakeApproval({ project_id: PROJECT_A }), fakeDecision());
    expect(payload.project_id).toBe(PROJECT_A);
  });

  test('no project anywhere: an explicit null key, never the tenant id', () => {
    const payload = buildCallbackPayload(fakeApproval(), fakeDecision());
    expect(payload.project_id).toBeNull();
    expect(JSON.parse(JSON.stringify(payload))).toHaveProperty('project_id', null);
    expect(payload.project_id).not.toBe(payload.tenant_id);
  });

  test('a resolved project fills a NULL column but never overrides a set one', () => {
    expect(
      buildCallbackPayload(fakeApproval(), fakeDecision(), { projectId: PROJECT_B }).project_id,
    ).toBe(PROJECT_B);
    expect(
      buildCallbackPayload(fakeApproval({ project_id: PROJECT_A }), fakeDecision(), {
        projectId: PROJECT_B,
      }).project_id,
    ).toBe(PROJECT_A);
  });
});
