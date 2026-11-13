// src/lib/broken-gate.ts
//
// ── A GATE THAT COULD NEVER HAVE BEEN CONSTRUCTED MUST NOT BE APPROVED (#1064) ──
//
// Extracted from `routes/approvals.ts` so the two chat seats
// (`routes/telegram-webhook.ts`, `routes/teams-webhook.ts`) can enforce the SAME
// predicate instead of growing their own copy. Before this,
// `git grep gate_terms|BROKEN_GATE|brokenGate` over the chat seats returned ZERO hits:
// a broken-gate row was refused on the web and via `PUT /api/approvals/:id`, but
// approved outright by replying `1` on Telegram or pressing approve on Teams. 178
// pending rows carried a broken
// term at the time this was found (0 exploited so far — latent, not yet abused).
//
// The predicate and its constants are unchanged from `routes/approvals.ts`; only
// the location moved. `routes/approvals.ts` re-exports `BROKEN_GATE_TERMS` and
// `BROKEN_GATE_OVERRIDE_MIN_REASON` for backward compatibility with anything
// already importing them from that file.

/**
 * ── A GATE THAT COULD NEVER HAVE BEEN CONSTRUCTED MUST NOT BE APPROVED ───────
 *
 * These `metadata.gate_terms` values do not describe a decision a human could
 * take; they describe a DEFECT in the thing that raised the approval — no
 * evidence was gathered, the brief never got written, the procedure does not
 * exist. There is no reading of the proposition that makes "approved" a true
 * statement, because there is no proposition. Approving one launders a broken
 * upstream into a signed-off outcome.
 *
 * MEASURED 2026-08-31: a bulk approve put 175 approvals through in 1.14s
 * (~6.5ms apart), 115 of them carrying defect terms. The ONLY thing that
 * stopped more was `MIN_DECISION_INTERVAL_MS` — a RATE limit, which is not a
 * correctness gate: it slows the same wrong answer down, it does not refuse it.
 * Before Claude agents decide approvals at volume, the server itself must hold
 * this line; a client-side predicate cannot, because the server accepts PUTs
 * from clients that never ran it.
 *
 * ⚠️ THIS IS DELIBERATELY *NARROWER* THAN THE CLIENT-SIDE LIST, AND THE GAP IS
 * THE POINT. `claude-fleet/scripts/lib/approvals-predicate.py :: DEFECT_TERMS`
 * holds SIX terms — these five plus `risk_block` — and it is right to, because
 * it decides what an AGENT may auto-decide (a conservative "do not touch"). This
 * set decides what the SERVER will REFUSE from every caller, which is a much
 * heavier hammer: a term here does not make a row un-auto-decidable, it makes
 * the row un-approvable by anyone. The two lists answer different questions and
 * must not be "reconciled" into one.
 *
 * ⛔ `risk_block` IS DELIBERATELY NOT IN THIS LIST — DO NOT ADD IT.
 * It is the conveyor's dominant LEGITIMATE gate (179 pending as measured), and
 * 857 of 995 pending rows carry a substantive `BLOCK REASON [...]` body in
 * `description` — i.e. the proposition IS constructed and a human genuinely can
 * answer it. Adding `risk_block` here does not tighten the guard; it halts the
 * conveyor. If you are here because a `risk_block` row was approved and you
 * think it should not have been, the answer is upstream content quality, not
 * this constant.
 *
 * ⚠️ ENV MAY ONLY EXTEND, NEVER REPLACE OR EMPTY.
 * `APPROVAL_BROKEN_GATE_TERMS` is UNIONed into the built-in set. It is
 * deliberately not a replace-or-clear knob: a guard that any pod env can switch
 * off is a killswitch, not a guard, and the failure mode is silent — an empty
 * env var would restore exactly the 2026-08-31 behaviour with every test still
 * green. The escape hatch is per-decision and attributable (super-admin plus a
 * recorded reason, below), never ambient and fleet-wide.
 */
const BROKEN_GATE_TERMS_BUILTIN = [
  'evidence_gap',
  'brief_write_failed',
  'authoring_gap',
  'decision_authoring_gap',
  'no_procedure',
] as const;

export const BROKEN_GATE_TERMS: ReadonlySet<string> = new Set<string>([
  ...BROKEN_GATE_TERMS_BUILTIN,
  ...(process.env.APPROVAL_BROKEN_GATE_TERMS ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
]);

/**
 * The minimum length of the `reason` a super-admin must supply to approve a
 * broken gate anyway. Not a magic number so much as a floor under which the
 * field cannot carry an argument: "ok", "fine", "approved" all fit in under 30
 * characters, and a one-word reason is indistinguishable from an empty one when
 * someone reads the row back in six months.
 *
 * ⚠️ NO CHAT SEAT MAY OFFER THIS OVERRIDE. It is attributable only because a
 * super-admin states it in writing, on the row, and it is recorded as
 * `metadata.broken_gate_override`. A chat reply is not that record — Telegram
 * and Teams have no `reason` field on an approve at all (the grammar is
 * `1` / `2 reason` / `3 question` on Telegram, a fixed button payload on
 * Teams) — so there is no chat override path, by construction, not by omission.
 */
export const BROKEN_GATE_OVERRIDE_MIN_REASON = 30;

/**
 * The `gate_terms` a stored approval declares, defensively.
 *
 * `approvals.metadata` is untyped JSON written by n8n, so `gate_terms` may be
 * absent, null, a string, or an array holding non-strings. Anything that is not
 * an array of strings reads as NO declared terms — the guard below then does
 * not fire, which is the correct direction for THIS guard (it refuses; it must
 * not refuse on a shape it cannot read). ⚠️ Note the asymmetry deliberately:
 * the CLIENT-side predicate treats "no gate_terms at all" as un-decidable and
 * refuses; this server-side guard only refuses terms it can positively read as
 * broken. They are different questions and must not be collapsed.
 */
export function declaredGateTerms(metadata: Record<string, unknown>): string[] {
  const raw = metadata.gate_terms;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === 'string');
}

