// src/lib/approval-card-state.ts
//
// ── A GATE ON A FINISHED CARD MAY NOT BE APPROVED (#1098), NOW SHARED ────────────
//
// MEASURED 2026-09-13 against the production db: 212 of 963 pending approvals — 22% —
// point at a card currently sitting in a Planka list named DONE. `approved` on one of
// those asks the receiver to move FINISHED work BACKWARD to TODO/READY.
//
// This was built and proven ONLY on `routes/approvals.ts` (the HTTP seat) and moved here
// unchanged so `routes/teams-webhook.ts` and `routes/telegram-webhook.ts` can
// call the SAME function instead of growing their own
// copies — the `domain/engagement/deblock-actions.ts` precedent (#1107) applied to this
// guard. See that file's own history for why the chat seats not having this is the
// identical "guard on one path, not its siblings" defect class as the answerless-approve
// gap #1107 closed.
//
// ⭐ ONE GUARD IS NOT A GUARD, AND THE ASYMMETRY OF COST IS WHY. n8n's `isFinished` arm
// (`approval-callback.json :: Resolve Target List`, shipped 2026-09-10 for fr#1080) fires
// AFTER fr has committed the `approval_decisions` row and completed the approval — so when
// it holds, the decider's one decision is already SPENT (`existingDecision` refuses any
// second attempt on every seat) and the row is terminal with the card unmoved. fr's refusal
// fires BEFORE the INSERT, so the row stays pending and the human can still reject it. Same
// fact, two places, and only the earlier one is recoverable — on EVERY seat, not only HTTP.
//
// ⛔ SCOPED TO `approved` AT EVERY CALL SITE, for the identical reason the #1064 broken-gate
// guard is: REJECT must stay open. Rejecting a gate on a finished card is the honest
// terminal — the work is done, the proposition is moot — and a guard that refused every
// decision would strand those rows pending for ever. Voiding (`lib/void-approvals.ts`) is
// untouched and remains the operator's exit.
//
// ⚠️ AND IT FAILS **OPEN** ON AN UNREADABLE CARD, on every seat. `services/planka-card-state.ts`
// throws on every unknown (404, 504, a 200 with no listId, a nameless list), and its header
// is explicit that a caller "must treat a throw as 'we do not know', never as 'not blocked'".
// Here, "we do not know" resolves to ALLOW: refusing on unknown would put every decide path
// behind Planka's availability, and the failure this closes is still refused independently
// by n8n's own arm — failing open here loses the EARLY refusal, not the refusal.
//
// ⛔ AND IT IS BOUNDED, on every seat. `currentCardListName` is one `cards.get` plus at most
// one `lists.get` against the service whose 504s under load are the reason
// `workers/deblock-callback-redelivery.ts` paces at 500 ms. An unbounded read here would
// hang a decider's request (or a Telegram/Teams webhook, which the sender retries on
// a slow response) on it, so the whole lookup races a deadline and a timeout is an unknown
// like any other — ALLOW, logged.

import { plankaClient } from '../services/planka';
import { plankaReaderFrom, type PlankaReader } from '../services/planka-card-state';

/**
 * Wall-clock ceiling for the card-state read on a DECISION request path.
 *
 * ⚠️ SMALLER THAN THE WORKER'S BUDGET ON PURPOSE. The redrive may spend 30s per row
 * because nobody is waiting; this sits inside a human's (or an agent's, or a chat
 * webhook's) request, and the whole call already owes time to whatever runs after it
 * (the n8n decision callback, on every seat). 3s is the p99 of the two Planka reads with
 * headroom, and overshooting it costs only the early refusal — never the decision.
 *
 * Env: APPROVAL_CARD_STATE_TIMEOUT_MS.
 */
export const DEFAULT_CARD_STATE_TIMEOUT_MS = 3_000;

export function cardStateTimeoutMs(): number {
  const raw = Number(process.env.APPROVAL_CARD_STATE_TIMEOUT_MS ?? DEFAULT_CARD_STATE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CARD_STATE_TIMEOUT_MS;
}

/**
 * `null` means "no reader can be built" (no Planka credentials) — the guard is skipped
 * entirely, exactly as `safeCardStateReader` in workers/approval-expiry.ts skips its
 * whole phase rather than guessing.
 */
function cardStateReader(): PlankaReader | null {
  try {
    return plankaReaderFrom(plankaClient);
  } catch (err) {
    console.error(
      '[approval-card-state] could not build the Planka card-state reader; the ' +
        'finished-card guard is SKIPPED (it fails open by design):',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * The card's CURRENT list name, or `null` for "we do not know".
 *
 * ⛔ THE THREE UNKNOWNS ARE ONE VALUE HERE, AND THAT IS SAFE ONLY BECAUSE EVERY CALLER
 * FAILS OPEN. No reader, a throw, and a deadline overshoot all answer `null`; a caller that
 * turned `null` into a REFUSAL would be reading "Planka is down" as "the card is finished".
 * Never throws and never rejects — a throw would fail a decision this function exists only
 * to SCREEN, on whichever seat called it.
 */
export async function currentCardListName(cardId: string): Promise<string | null> {
  const reader = cardStateReader();
  if (reader === null) return null;
  const deadlineMs = cardStateTimeoutMs();
  try {
    // `.catch` is attached to the ORIGINAL promise, not to the race, so a rejection
    // arriving after the deadline can never become an unhandled rejection.
    const read = reader
      .currentListName(cardId)
      .then((name) => ({ name }) as { name: string | null })
      .catch((err: unknown) => {
        console.warn(
          `[approval-card-state] could not read card ${cardId} for the finished-card ` +
            'guard; the approve is ALLOWED (fail-open):',
          err instanceof Error ? err.message : String(err),
        );
        return { name: null };
      });
    const timer = new Promise<{ name: string | null }>((resolve) => {
      setTimeout(() => {
        console.warn(
          `[approval-card-state] the card-state read for ${cardId} did not answer inside ` +
            `${deadlineMs}ms; the approve is ALLOWED (fail-open)`,
        );
        resolve({ name: null });
      }, deadlineMs).unref?.();
    });
    const { name } = await Promise.race([read, timer]);
    return name;
  } catch (err) {
    // Belt and braces: `reader()` is the only thing left that could throw.
    console.warn(
      `[approval-card-state] finished-card guard could not run for card ${cardId}; ALLOWED:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ── v4 CONVEYOR WAITS ARE NOT CARD MOVES — EXEMPT FROM THE FINISHED-CARD GUARD ───
// The guard above exists because a v3 approve asked the n8n receiver
// (`approval-callback.json`) to move the card to TODO/READY. A v4 conveyor ask
// (`sub.ask_fr`, George 2026-10-13: no event loop) is different: its callback only
// RESUMES the n8n Wait node that minted it; cards move solely by the flow's own
// `sub.card_action` after its gates. So a v4 question/sign-off asked while the card
// sits in DONE (e.g. the development_bug_fix DONE merge sign-off) must be decidable —
// refusing it strands the run (live 2026-10-14: approval 444d0e35… 422'd on a
// project_setup card in DONE).
//
// ⛔ KEYED ON WHAT A JWT CALLER CANNOT FORGE. All four must hold:
//   - `kind === 'execution.ready_signoff'` — minted only by POST /api/execution/approvals
//     (the improvement door spreads caller metadata but mints `improvement.*` kinds; the
//     webhooks door spreads none);
//   - `metadata.requested_via === 'licence'` — SERVER-written after the metadata spread
//     in routes/execution-approvals.ts, and refused as a caller key on both bearer kinds
//     (LICENCE_METADATA_FORBIDDEN_KEYS / JWT_METADATA_CONTROL_KEYS);
//   - `metadata.source === 'conveyor'` and `metadata.flow === 'sub.ask_fr'` — passthrough
//     on the licence lane only; the JWT door's allowlist DROPS both. So only the tenant's
//     conveyor seat can produce such a row — the same principal that owns the receiver
//     and is declaring that receiver is a Wait resume, not a card move.
// Every v3/legacy row (no flow, or a JWT row) keeps the guard unchanged.
export const V4_CONVEYOR_ASK_FLOW = 'sub.ask_fr';

export function isV4ConveyorWaitApproval(approval: {
  kind?: string | null;
  metadata?: unknown;
}): boolean {
  if (approval.kind !== 'execution.ready_signoff') return false;
  const md = approval.metadata;
  if (!md || typeof md !== 'object' || Array.isArray(md)) return false;
  const m = md as Record<string, unknown>;
  return (
    m.requested_via === 'licence' &&
    m.source === 'conveyor' &&
    m.flow === V4_CONVEYOR_ASK_FLOW
  );
}
