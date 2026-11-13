// A card must never land in BLOCKED without a reason.
//
// ── WHAT WAS MEASURED (2026-09-11) ──────────────────────────────────────────
// All 19 `workflow_statistics_analysis` cards on the improvement boards carried
// an EMPTY/NULL `block_reason`, and 15 of the 106 BLOCKED `workflow_development`
// cards carried none either — so this is not one card_type's bug, it is the
// absence of an invariant.
//
// ── WHY AN EMPTY block_reason IS NOT MERELY UNTIDY ──────────────────────────
// `blocked-escalate.json :: Merge Procedure Hint (__deriveReason)` reads this
// field back to classify the block. With nothing to read it classifies the card
// `unknown_no_reason_persisted`, the escalation proposition becomes a QUESTION,
// and `approval-callback :: Resolve Target List` treats a QUESTION as a
// DELIBERATE HOLD — so the card can never leave BLOCKED and the conveyor
// re-mints a fresh approval minutes later and asks a human again. The chain is
// already written up at `services/improvement-cards/field-groups.ts` beside the
// `block_reason` entry in the `Runtime State` group; read it before changing
// anything here.
//
// ⚠️ THAT WRITE-UP DESCRIBES A DIFFERENT BUG WITH THE SAME SYMPTOM, and the two
// must not be conflated. There, the field was UNDECLARED on every board, so
// writes that DID supply a reason were silently dropped by the kanban node. That
// was fixed by declaring the field. THIS module is about the other half: a
// writer that moves a card into BLOCKED and supplies no reason at all. Declaring
// a field cannot fix that, and a fallback reason cannot fix the other.
//
// ── WHAT THIS MODULE PROMISES, AND WHAT IT CANNOT ───────────────────────────
// It makes every in-repo writer that lands a card in BLOCKED stamp a reason.
// ⛔ It does NOT and cannot cover the n8n workflows, which are the dominant
// producer of BLOCKED transitions on this estate and live in another repo
// (`n8n_custom_nodes/workflows/**`). Do not read a green test here as "no card
// can reach BLOCKED unstated" — read it as "no card reaches BLOCKED unstated
// THROUGH fr".

import type { PlankaClient } from './planka';
import { warnBoardFieldMissing } from './planka/custom-fields';

/** The AA-spec group that owns `block_reason`. */
export const BLOCK_REASON_GROUP = 'Runtime State' as const;
export const BLOCK_REASON_FIELD = 'block_reason' as const;

/**
 * The machine-readable class prefix the fallback carries.
 *
 * ⚠️ Deliberately NOT `unknown` / `unknown_no_reason_persisted`. That string is
 * the degenerate class `__deriveReason()` already invents when it finds nothing,
 * and re-using it would make "fr stamped a fallback" indistinguishable from "fr
 * stamped nothing" — which is precisely the ambiguity this module exists to
 * remove. `blocked_reason_not_stated_by_mover` says something different and
 * true: the transition happened, we know who caused it, and that caller did not
 * say why.
 */
export const FALLBACK_BLOCK_REASON_CLASS =
  'blocked_reason_not_stated_by_mover' as const;

/**
 * Build the fallback reason.
 *
 * It must be ACTIONABLE, not decorative — "blocked" tells a reader nothing they
 * could not see from the list name. So it names three things a human or a
 * classifier can act on: the class, the exact code path that moved the card
 * (`source`), and where the real explanation will be if there is one.
 *
 * @param source a stable dotted id for the call site, e.g. `fr.kanban.move_card`.
 */
export function fallbackBlockReason(source: string): string {
  return (
    `${FALLBACK_BLOCK_REASON_CLASS}: moved to BLOCKED by ${source}, which supplied ` +
    `no reason. Nothing here diagnosed the card — the mover only parked it. ` +
    `Read the card's comments and Planka activity for the step that failed, put ` +
    `the real cause in this field, then move the card out of BLOCKED.`
  );
}

export type BlockReasonOutcome =
  /** The caller stated a reason; it was written. */
  | 'wrote_caller'
  /** No caller reason, but the card already carried one; left alone. */
  | 'kept_existing'
  /** No caller reason and none on the card; the fallback was written. */
  | 'wrote_fallback'
  /** The board (its RM template) has no `block_reason` field; nothing written, warning logged. */
  | 'skipped_unprovisioned';

export interface ResolvedBlockReason {
  outcome: Exclude<BlockReasonOutcome, 'skipped_unprovisioned'>;
  /** What should end up in the field. Never empty. */
  content: string;
}

/**
 * The whole decision, as a pure function — so the rule is testable without a
 * Planka client, and so the I/O wrapper below has no judgement in it.
 *
 * ⚠️ THE CALLER'S REASON WINS OVER AN EXISTING VALUE, and that ordering is
 * load-bearing. A card can be blocked, released, and blocked again; the value
 * left over from the PREVIOUS block would then describe the wrong event, and a
 * stale-but-specific reason is more misleading than an empty one because it
 * reads as an answer. An existing value is preserved only when this caller has
 * nothing to say — where it is the best information available.
 */
export function resolveBlockReason(input: {
  /** What the mover says. Empty/whitespace/absent counts as nothing said. */
  callerReason?: string | null;
  /** What the card already carries. */
  existingReason?: string | null;
  /** Dotted id of the call site, for the fallback text. */
  source: string;
}): ResolvedBlockReason {
  const caller = (input.callerReason ?? '').trim();
  if (caller) return { outcome: 'wrote_caller', content: caller };

  const existing = (input.existingReason ?? '').trim();
  if (existing) return { outcome: 'kept_existing', content: existing };

  return { outcome: 'wrote_fallback', content: fallbackBlockReason(input.source) };
}

export interface StampBlockReasonInput {
  boardId: string;
  cardId: string;
  /** The mover's reason. Omit when the mover genuinely has none. */
  reason?: string | null;
  /** Dotted id of the call site, e.g. `fr.kanban.move_card`. */
  source: string;
}

/**
 * Ensure `cardId` carries a non-empty `block_reason`.
 *
 * Over-length content is not truncated here: `setCardCustomFieldValue` bounds it
 * at Planka's 512-char cap and leaves a visible marker (this call opts in with
 * `truncateHumanText`, fr#1494), and duplicating that rule is how copies drift.
 *
 * The board read is the same `GET /api/boards/:id` the rest of this service
 * layer uses; it is what lets us see the EXISTING value, which is the whole
 * reason this is not a blind PATCH.
 */
export async function stampBlockReason(
  planka: PlankaClient,
  input: StampBlockReasonInput,
): Promise<BlockReasonOutcome> {
  const view = await planka.customFields.getBoardCustomFields(input.boardId);

  const group =
    view.customFieldGroups.find(
      (g) => g.boardId === input.boardId && g.name === BLOCK_REASON_GROUP,
    ) ?? null;
  const fieldId =
    group === null
      ? undefined
      : view.customFields.find(
          (f) => f.customFieldGroupId === group.id && f.name === BLOCK_REASON_FIELD,
        )?.id;
  const groupId = group?.id;

  // A board whose RM template lacks Runtime State.block_reason: skipped with a
  // warning. fr never creates the field (v4 ruling 12).
  if (!groupId || !fieldId) {
    warnBoardFieldMissing({
      boardId: input.boardId,
      cardId: input.cardId,
      group: BLOCK_REASON_GROUP,
      field: BLOCK_REASON_FIELD,
      context: `block_reason:${input.source}`,
    });
    return 'skipped_unprovisioned';
  }

  const existingReason = view.customFieldValues.find(
    (v) => v.cardId === input.cardId && v.customFieldId === fieldId,
  )?.content;

  const resolved = resolveBlockReason({
    callerReason: input.reason,
    existingReason: typeof existingReason === 'string' ? existingReason : null,
    source: input.source,
  });

  if (resolved.outcome === 'kept_existing') return 'kept_existing';

  await planka.customFields.setCardCustomFieldValue({
    cardId: input.cardId,
    customFieldGroupId: groupId,
    customFieldId: fieldId,
    content: resolved.content,
    // Human text: a long reason is truncated with a visible marker rather than
    // leaving the card BLOCKED with no reason at all (fr#1494 opt-in).
    truncateHumanText: true,
  });
  return resolved.outcome;
}

/**
 * Best-effort variant for the MOVE paths.
 *
 * ⛔ A failure here must never turn a SUCCESSFUL move into an error response.
 * The card is already in BLOCKED by the time we are called; 500-ing would
 * invite the retry, and the retry moves an already-moved card. Logged, never
 * thrown — the same policy `toc-hooks.ts` applies to its post-move hooks.
 */
export async function stampBlockReasonQuietly(
  planka: PlankaClient,
  input: StampBlockReasonInput,
): Promise<BlockReasonOutcome | 'failed'> {
  try {
    return await stampBlockReason(planka, input);
  } catch (err) {
    console.warn(
      `[block-reason] failed to stamp block_reason on card ${input.cardId} ` +
        `(board ${input.boardId}, source ${input.source}); the card is in BLOCKED ` +
        `with no stated reason`,
      err,
    );
    return 'failed';
  }
}
