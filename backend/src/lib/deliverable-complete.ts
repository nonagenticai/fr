// src/lib/deliverable-complete.ts
//
// When is ONE project deliverable complete? (U-PS-COMMIT; CONVEYOR-TAXONOMY
// D4: "Complete means: fixed cards are DONE; for a deferred deliverable,
// `minted_at` is set and every attached card is DONE (a 0-finding hunt has
// `minted_count=0` and exits).") Read by the plan read model (lib/plan-phase-exit.ts).
//
// PURE: the caller resolves which cards are attached to the deliverable and
// whether each is DONE; this function only decides. Two vacuous-pass guards,
// both deliberate:
//   * a FIXED deliverable with zero attached cards is NOT complete — "every
//     attached card is DONE" is trivially true of none, and a fixed deliverable
//     always mints >=1 card at commit, so zero means "not minted yet";
//   * a DEFERRED deliverable whose minter reported N cards but fewer than N are
//     attached is NOT complete — the attachment has not caught up.
// The ONLY way an empty card set is complete is the minter's own word:
// deferred AND minted_at set AND minted_count = 0.

export interface DeliverableMintState {
  deferred: boolean;
  minted_at: Date | string | null;
  minted_count: number | null;
}

export interface AttachedCardState {
  done: boolean;
}

export type DeliverableIncompleteReason =
  | 'no_cards_attached'
  | 'card_not_done'
  | 'minter_not_fired'
  | 'attached_fewer_than_minted';

export type DeliverableCompletion =
  | { complete: true }
  | { complete: false; reason: DeliverableIncompleteReason };

export function deliverableCompletion(
  d: DeliverableMintState,
  attached: ReadonlyArray<AttachedCardState>,
): DeliverableCompletion {
  if (d.deferred) {
    if (d.minted_at === null || d.minted_count === null) {
      return { complete: false, reason: 'minter_not_fired' };
    }
    if (attached.length < d.minted_count) {
      return { complete: false, reason: 'attached_fewer_than_minted' };
    }
  } else if (attached.length === 0) {
    return { complete: false, reason: 'no_cards_attached' };
  }
  if (attached.some((c) => !c.done)) return { complete: false, reason: 'card_not_done' };
  return { complete: true };
}
