// RECLASSIFY (REALIGN R5) — the decider changes a BLOCKED card's type and sends it back
// to TODO, so it re-enters READY under the new type's pattern.
//
// ⚠️ A MIRROR OF THE SERVER, WHICH IS THE ONE THAT DECIDES.
// `backend/src/domain/engagement/deblock-actions.ts :: classifyReclassifyDecision`
// refuses (400) a RECLASSIFY approve whose `new_card_type` is missing, not on the
// roster, or equal to the card's current type. These helpers only keep the UI from
// offering a click the server will refuse; they never stand in for that check.

import { authFetch } from '$lib/api/auth-fetch';
import type { Approval } from '$lib/types/api';
import { DEBLOCK_ACTIONS } from './action-facets';
import { deblockActionOf } from './question';

/** What the decision bar hands back when the decider chose RECLASSIFY. */
export interface ReclassifyChoice {
  newCardType: string;
}

/**
 * May this row be reclassified? Only a BLOCKED-exit proposition — a row whose stored
 * `deblock_action` is in the closed set — and never an `execution.ready_signoff` row,
 * whose receiver does not execute a decider-supplied action (the server refuses an
 * override there). Conservative by design: a row this says `false` for gets no control,
 * which is the honest default for a decision the receiver might not honour.
 */
export function reclassifyEligible(a: Pick<Approval, 'metadata' | 'kind'>): boolean {
  if (a.kind === 'execution.ready_signoff') return false;
  const action = deblockActionOf(a);
  // A COVERAGE row's criteria are minted, not chosen: the server refuses any override out of it.
  if (action === 'COVERAGE') return false;
  return action !== null && (DEBLOCK_ACTIONS as readonly string[]).includes(action);
}

/** The card's current type as the approval recorded it at mint, or null. */
export function currentCardTypeOf(a: Pick<Approval, 'metadata'>): string | null {
  const raw = ((a.metadata ?? {}) as Record<string, unknown>).card_type;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Why a chosen type cannot be submitted, or null when it can. Same three refusals
 * as the server, in the same order.
 */
export function validateReclassify(
  newCardType: string,
  currentCardType: string | null,
  roster: readonly string[] | null,
): string | null {
  const t = newCardType.trim();
  if (t.length === 0) return 'Choose the card type to reclassify this card to.';
  if (roster && !roster.includes(t)) return `"${t}" is not a known card type.`;
  if (currentCardType && t === currentCardType) {
    return `"${t}" is already this card's type — reclassifying to it would only retry.`;
  }
  return null;
}

// One roster fetch per page, not one per mounted decision surface (the
// needs-you queue mounts one per eligible row). A failed read is not memoised,
// so a later surface retries.
let rosterPromise: Promise<string[] | null> | null = null;

/** The card-type roster (`GET /api/card-types`), or null when it cannot be read. */
export function loadCardTypeRoster(): Promise<string[] | null> {
  if (!rosterPromise) {
    rosterPromise = fetchCardTypeRoster().then((roster) => {
      if (roster === null) rosterPromise = null;
      return roster;
    });
  }
  return rosterPromise;
}

async function fetchCardTypeRoster(): Promise<string[] | null> {
  try {
    const res = await authFetch('/api/card-types');
    if (!res.ok) return null;
    const body = (await res.json()) as { card_types?: unknown };
    return Array.isArray(body.card_types)
      ? body.card_types.filter((t): t is string => typeof t === 'string')
      : null;
  } catch {
    return null;
  }
}
