// One-time backfill: re-send the EXPIRY re-queue callback for `execution.ready_signoff`
// approvals that expired BEFORE the receiver could route `expired`.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
// ═══════════════════════════════════════════════════════════════════════════════
// `execution-ready-signoff-callback` used to handle `decision: 'expired'` by
// COMMENTING on the card and never moving it — the workflow's `Route by decision`
// switch had no `expired` output and `fallbackOutput: none`, so an expiry landed
// nowhere. fr's own sender contract says an expiry must "put the card back in TODO
// to be re-raised" (services/n8n-callback.ts), and the sibling rail
// (`kanban/approval-callback`, taught by n8n_custom_nodes #1193) has that path.
// This one did not.
//
// n8n_custom_nodes #1316 added it. VERIFIED LIVE, not assumed — n8n db on worker4:
//
//   SELECT id, name, active, "versionId"="activeVersionId", "updatedAt"
//     FROM workflow_entity WHERE id = 'uoMx5WYBrxR4TPYT';
//   -- exec::ready-signoff-callback | active t | versions match t
//   -- updatedAt 2026-09-07 11:33:55.564+00
//
// and the active version now carries `Planka: move card to TODO` +
// `Planka: add expired comment` behind an `expired` output key.
//
// ⛔ THE FIX IS FORWARD-ONLY. `workers/approval-expiry.ts` fires the notice ONLY
// for the ids its own tick's `RETURNING` just transitioned — its header says so in
// as many words ("There is no backfill of the historical expired rows"). An
// `expired` row can never re-match `status = 'pending'`, so nothing will EVER
// re-drive the rows that expired before 11:33:55Z. They are stranded permanently.
// This script is that one-time drive, and nothing else in fr can be.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE POPULATION — MEASURED, SELECT-ONLY, 2026-09-07T13:52Z (worker4 `fr` + `kanban`)
// ═══════════════════════════════════════════════════════════════════════════════
// ⚠️ EVERY NUMBER BELOW IS A SNAPSHOT AND CARRIES ITS TIMESTAMP FOR A REASON. Between
// two readings 20 minutes apart, `pending` on this rail moved 171 -> 180 and the rail
// total 845 -> 854. The expired bucket is the stable part (120 rows / 101 cards / 0
// markers in both readings) and is the only part this script depends on.
//
// ⚠️ "120 expired approvals" IS NOT "120 stuck cards", and the difference is 2.4x.
// Every bucket below sums to its denominator; a negative control (a callback_path
// and a card id that cannot exist) returned 0, and a positive control returned the
// full denominator, so an empty bucket here is a measurement and not a dead query.
//
//   ready-signoff rail, all statuses ......... 854  (approved 456 / pending 180 /
//                                                    expired 120 / voided 98) = 854 ✓
//   expired rows ............................. 120  ALL with completed_at before
//                                                    11:33:55Z; 0 after. 0 delivered,
//                                                    0 acked, 0 resolved.
//   distinct cards behind them ............... 101  (120 rows - 19 duplicates)
//
//   Live Planka list of those 101 cards:
//     BLOCKED ..... 76 cards / 91 rows   <-- the only ones that are stuck
//     DONE ........ 22 cards / 22 rows   <-- already released
//     TODO ......... 3 cards /  7 rows   <-- already re-queued by hand
//                    ---              ---
//                   101 cards / 120 rows ✓  (0 deleted, 0 with no list)
//
//   Of the 76 BLOCKED cards, 26 already carry a LIVE `pending` approval (27 pending
//   rows; all 26 confirmed BLOCKED). 50 cards / 51 rows do not.
//
//   ⭐ SO THE REAL TARGET IS 50 CARDS (51 rows, one card holds two). Not 120.
//
// ⛔ AND THE `live-pending-gate` SKIP IS NOT A ZERO-COST SKIP. CORRECTED 2026-09-07 —
// this used to say those 26 cards have "something already coming to release them",
// full stop. Measured, split by the rail the pending approval is actually ON:
//
//     pending on THIS rail (execution-ready-signoff-callback) ....  4 cards
//     pending ONLY on kanban/approval-callback (a DIFFERENT rail) . 22 cards
//                                                                  ---
//                                                    26 cards / 27 rows ✓
//
// Only 4 of the 26 have a gate on the rail this script drives. For the other 22 the
// release depends on a DIFFERENT rail firing, which nothing here has proven. So the
// accepted risk of this skip is "UP TO 22 CARDS MAY STAY BLOCKED", not zero. It is
// still the right call — moving a card to TODO under an open gate strands the gate,
// and the skip is reversible by deleting GUARD 3 — but the number is 22, not 0, and a
// comment that implies otherwise is a misstatement, not a simplification.
//
// ⭐ THE 91 IS CORROBORATED FROM A SECOND, INDEPENDENT SOURCE. The live receiver's
// own `Validate payload` node records the natural experiment that proved the
// receiver was the defect: "of 120 already-expired ready_signoff rows, 47 of the 59
// whose callback SUCCEEDED were still sitting in BLOCKED, indistinguishable from the
// 44 of 61 whose callback FAILED." 47 + 44 = 91 — the same number this census
// measured from the other end, months of drift apart. (That 59/61 split lives in
// `approvals.error_message`, NOT in `callback_delivered_at`; every one of the 120 has
// `callback_delivered_at IS NULL`, because the expiry path never writes it. Reading
// the delivery columns would have said "0 of 120 were ever sent", which is false.)
//
// ═══════════════════════════════════════════════════════════════════════════════
// ⛔ WHY THE PLANKA BLOCKED GATE IS MANDATORY AND NOT A REFINEMENT
// ═══════════════════════════════════════════════════════════════════════════════
// Read off the LIVE active version of `exec::ready-signoff-callback`, the expired
// branch is:
//
//     Planka: move card to TODO  =  card.update { listId: {{ $json.todo_list_id }} }
//
// UNCONDITIONAL. It never reads the card's current list. So a send for one of the
// 22 DONE cards moves a finished card back to TODO. That is not a hypothetical: it
// is the exact class `workers/deblock-callback-redelivery.ts` was refused twice for
// until it added a live card-state join — "a naive re-delivery would have dragged
// 110 DONE cards back into DOING". This script takes the same option, for the same
// reason, and the gate is the entire reason it is allowed to exist:
//
//   ⭐ IT SENDS ONLY FOR A CARD PLANKA CURRENTLY REPORTS IN THE BLOCKED LIST.
//
// The residual race is identical and is stated rather than hidden: a card can leave
// BLOCKED between the read and the POST. Planka has no compare-and-set on listId, so
// this cannot be made atomic. Bounded to one card, needs a human to move that exact
// card inside a ~1s window.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHAT IT DOES NOT DO
// ═══════════════════════════════════════════════════════════════════════════════
//   ⛔ It does not MOVE CARDS ITSELF. It re-drives `sendN8nExpiryCallback`, the
//      existing sender, so the receiver #1316 fixed does the work. Hand-moving the
//      cards would repair the board while leaving the fix unexercised, and the
//      whole point is to prove the fix end to end.
//   ⛔ It does not DECIDE ANY APPROVAL. It writes no `status`, no `completed_at`,
//      no `approval_decisions` row, and no `triage_*` field. An expiry is the
//      ABSENCE of a decision and re-announcing it manufactures nothing. The only
//      columns it writes are `error_message` (append-only), `callback_send_attempts`
//      and `updated_at`.
//   ⛔ It does not touch a row on any other rail, in any other status, or one that
//      expired after the receiver was fixed. See `CANDIDATE_SQL` — those three
//      predicates are literals, not parameters, so no flag can widen them.
//   ⛔ It does not RETIRE A ROW IT DID NOT SEND FOR. A skip, a failed send and a
//      sender refusal are all NON-TERMINAL: the row is selected again next run. So
//      RE-RUNNING IS THE CORRECT RESPONSE TO A PARTIAL RUN. See the send-then-retire
//      block in `runBackfill` — this ordering is the whole reason that is true.
//
// ═══════════════════════════════════════════════════════════════════════════════
// USAGE
// ═══════════════════════════════════════════════════════════════════════════════
//   # DRY RUN (the default) — reads Planka, decides every row, writes NOTHING:
//   bun run scripts/backfill-expired-signoff-requeue.ts
//
//   # ARM IT:
//   bun run scripts/backfill-expired-signoff-requeue.ts --apply --limit 10
//
// Run it inside the fr-backend pod, which carries DATABASE_URL and the Planka and
// n8n credentials.
//
// EXIT CODES — "ran" and "did something" are different questions and get different
// answers:
//   0  dry run completed, or an --apply run that actually sent at least one notice
//   3  an --apply run that had candidates and sent NOTHING (all skipped/failed).
//      ⭐ This is the code that exists so an all-skipped run cannot read as healthy.
//   1  the run itself failed

import { sql } from 'drizzle-orm';

import { closeConnection, db as defaultDb } from '../src/db/client';
import { encodePath, plankaClient } from '../src/services/planka';
import { PlankaError } from '../src/services/planka/errors';
import { sendN8nExpiryCallback } from '../src/services/n8n-callback';
import { isBlockedList } from '../src/services/toc-hooks';

// ---------------------------------------------------------------------------
// Bounds. All three are compile-time constants for a reason: a bound a caller
// can widen is not a bound.
// ---------------------------------------------------------------------------

/**
 * The ONLY receiver this script will ever drive.
 *
 * ⛔ Not a parameter and not a LIKE pattern. The measured population was found
 * with `callback_path LIKE '%ready-signoff%'`, and that pattern returned exactly
 * one distinct value across all 845 rows — so the literal is not a narrowing of
 * the census, it IS the census. A pattern here would let a future rail with a
 * similar name silently join a population nobody measured.
 */
export const RAIL_CALLBACK_PATH = 'execution-ready-signoff-callback';

/**
 * Default rows per run, and the hard ceiling on `--limit`.
 *
 * ⚠️ The ceiling is the SIZE OF THE MEASURED POPULATION, not a round number. 120
 * expired rows exist; a limit above that could only be asking for rows the census
 * never saw. The default is deliberately far below it so the first armed run is a
 * small, observable one.
 */
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 120;

/** Pace between sends. Same 500ms the de-block redelivery worker paces at. */
export const PACE_MS = 500;

/**
 * The TERMINAL marker. Appended to `error_message` when — and ONLY when — a notice
 * was actually SENT. A row carrying it is never selected again.
 *
 * ⛔ IT IS NEVER WRITTEN FOR A SKIP OR FOR A FAILED SEND, DELIBERATELY. Marking a
 * row terminal without repairing it is the "retire a row without repairing it" defect
 * that migration 113 had to undo on the sibling worker. Every skip reason here is a
 * fact about LIVE state — the card's list, whether a gate is open, whether Planka is
 * answering — and live state changes. So skips and failures are re-derived from
 * scratch on every run, which is also what makes the dry run a truthful preview
 * rather than a one-shot.
 *
 * ⭐ There is a SECOND, INDEPENDENT idempotency layer and it is not this one, and it
 * is what makes SEND-THEN-RETIRE (see `runBackfill`) the safe ordering: the
 * receiver's `Idempotency check` node lists the card's Planka comments, looks for
 * `execution-signoff:{approval_id}:{decision}`, and `Route by decision` admits the
 * `expired` output ONLY on `is_duplicate === false`. VERIFIED LIVE against the n8n db
 * on worker4, 2026-09-07, not taken from a PR — `workflow_entity` `uoMx5WYBrxR4TPYT`,
 * active version, `Idempotency check` jsCode and the switch's four rule objects. It
 * also THROWS on an unreadable comment list rather than folding it into
 * `is_duplicate: false`, so it cannot fail open. Neither layer is relied on alone.
 */
export const BACKFILL_MARKER = 'n8n re-queue backfill(#1316)';

/**
 * The NON-TERMINAL note, written when a send was ATTEMPTED and did not succeed.
 *
 * ⛔ IT MUST NOT CONTAIN `BACKFILL_MARKER` AS A SUBSTRING, and that is not a style
 * preference — `candidateSql` and the retire UPDATE both exclude on
 * `LIKE '%<BACKFILL_MARKER>%'`, so any text sharing that substring RETIRES THE ROW.
 * Writing "…backfill(#1316) attempt FAILED" onto a failed row would be indistinguish-
 * able, to every later reader, from a successful send. `assertNonTerminal` below turns
 * that from a comment into a check, and `scrubMarker` stops a hostile error string
 * from smuggling the marker in through interpolation.
 */
export const BACKFILL_ATTEMPT_NOTE = 'n8n re-queue backfill attempt';

/**
 * ⛔ Free text on the NON-TERMINAL path is scrubbed before it is concatenated.
 *
 * The failure note interpolates `sendN8nExpiryCallback`'s error string — text this
 * script does not author and cannot constrain. An error that happened to quote the
 * marker (an n8n echo of a previous run's `error_message`, say) would retire the row
 * it is reporting the FAILURE of. The scrub is one line and removes the whole class.
 */
export function scrubMarker(text: string): string {
  return text.split(BACKFILL_MARKER).join('[marker-elided]');
}

/**
 * Fails loudly at import time if the non-terminal note ever grows the terminal marker.
 * A constant edited months from now cannot quietly re-open the retire-on-failure hole.
 */
function assertNonTerminal(): void {
  if (BACKFILL_ATTEMPT_NOTE.includes(BACKFILL_MARKER)) {
    throw new Error(
      `BACKFILL_ATTEMPT_NOTE ("${BACKFILL_ATTEMPT_NOTE}") contains BACKFILL_MARKER ` +
        `("${BACKFILL_MARKER}"), so writing it would RETIRE a row that was never sent for.`,
    );
  }
}
assertNonTerminal();

/**
 * Candidate selection.
 *
 * ⛔ THE THREE SCOPING PREDICATES ARE LITERALS INLINE, NOT BOUND PARAMETERS. This
 * is the property "a filter that cannot select rows outside the identified
 * population", and it is only true if no argument can reach them. `limit` is the
 * one bound value, and it is clamped to MAX_LIMIT before it gets here.
 *
 * `card_id IS NOT NULL` is a belt-and-braces predicate: 120/120 of the population
 * carry one. Without a card there is nothing to re-queue and the receiver 400s.
 *
 * ORDER BY completed_at — oldest stranding first. A partial run therefore repairs
 * the longest-stuck cards, and re-running continues from where it stopped.
 */
function candidateSql(limit: number) {
  // The completed_at cutoff is when n8n_custom_nodes #1316 became the ACTIVE
  // receiver — measured, not taken from the PR: `workflow_entity."updatedAt"` for
  // `uoMx5WYBrxR4TPYT` on the live n8n db. Every row that expired at or after it
  // already got a working notice from `workers/approval-expiry.ts` and must NOT be
  // re-sent (that would move a card that is already where it belongs).
  return sql`
    SELECT id, card_id, metadata, tenant_id, completed_at, error_message
      FROM approvals
     WHERE callback_path = 'execution-ready-signoff-callback'
       AND status        = 'expired'
       AND completed_at  < timestamp '2026-09-07 11:33:55.564'
       AND card_id IS NOT NULL
       AND coalesce(error_message, '') NOT LIKE ${'%' + BACKFILL_MARKER + '%'}
     ORDER BY completed_at
     LIMIT ${limit}
  `;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * Why a row was not sent for.
 *
 * ⛔ THESE ARE KEPT DISTINCT ON PURPOSE and a single "skipped" counter would be a
 * regression. A reader must be able to tell "the card is already fine" from "we
 * cannot see the card" from "we would have had to invent a target" — the same
 * argument migration 113 makes for keeping four `callback_resolution` values
 * rather than one boolean.
 */
export type SkipReason =
  /** `metadata.todoListId` missing/blank. ⛔ THE REFUSAL THAT MATTERS MOST — see below. */
  | 'no-todo-list-id'
  /** Planka answered 404 on the CARD'S OWN read path. Deleted, or access lost. */
  | 'card-read-gone'
  /** Planka failed to tell us anything. Evidence about Planka, not about the row. */
  | 'card-read-degraded'
  /** The card is readable and is NOT in BLOCKED. Nothing to repair. */
  | 'not-blocked'
  /** An earlier row in this run already covered this card. */
  | 'duplicate-card'
  /** The card already has a live `pending` approval — a gate is already open on it. */
  | 'live-pending-gate'
  /**
   * The pre-send LAST LOOK found the terminal marker: another run retired this row
   * between our candidate SELECT and our send. ⚠️ NOT an exclusive claim — see the
   * send-then-retire block in `runBackfill`. The name is kept because it is what a
   * reader of an existing report will be looking for.
   */
  | 'already-claimed'
  /** `sendN8nExpiryCallback` refused: the row is not expired / has no path / bad receiver. */
  | 'sender-refused';

export interface RowVerdict {
  approvalId: string;
  cardId: string;
  /** 'send' means it WOULD be sent (dry run) or WAS sent (apply). */
  action: 'send' | 'skip' | 'fail';
  reason?: SkipReason;
  /** Human detail — the observed list name, the Planka error, the sender's error. */
  detail?: string;
}

export interface BackfillResult {
  mode: 'dry-run' | 'apply';
  /** Rows the SQL returned. */
  candidates: number;
  /** Rows that reached a decision (every candidate does). */
  attempted: number;
  /** Notices n8n accepted (apply), or that WOULD be sent (dry run). */
  sent: number;
  /** Sends that were attempted and failed. */
  failed: number;
  /** Skips, by reason. Every key present so an absent reason reads as 0, not as missing. */
  skipped: Record<SkipReason, number>;
  verdicts: RowVerdict[];
}

function emptySkips(): Record<SkipReason, number> {
  return {
    'no-todo-list-id': 0,
    'card-read-gone': 0,
    'card-read-degraded': 0,
    'not-blocked': 0,
    'duplicate-card': 0,
    'live-pending-gate': 0,
    'already-claimed': 0,
    'sender-refused': 0,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Planka reads
// ---------------------------------------------------------------------------

type ReadFailureKind = 'gone' | 'degraded';

class CardReadFailure extends Error {
  readonly kind: ReadFailureKind;
  constructor(kind: ReadFailureKind, message: string) {
    super(message);
    this.name = 'CardReadFailure';
    this.kind = kind;
  }
}

/**
 * The one request path whose 404 is evidence about THIS card.
 *
 * ⛔ BUILT WITH PLANKA'S OWN `encodePath`, NOT A HAND-WRITTEN TEMPLATE — the same
 * construction `services/planka/cards.ts::get` uses, so the two strings cannot
 * drift. `workers/deblock-callback-redelivery.ts` states why at length: drift here
 * fails in the dangerous direction, where every genuine 404 reads as `degraded`.
 */
function cardReadPath(cardId: string): string {
  return `/api/cards/${encodePath(cardId)}`;
}

/**
 * ⭐ FAILS TOWARDS 'degraded'. An error we do not recognise is not evidence about
 * the card. Guessing 'degraded' wrongly costs one wasted read on the next run;
 * guessing 'gone' wrongly abandons a stuck card in silence.
 *
 * ⛔ `definitivePath` IS LOAD-BEARING. Planka raises 404 from three call sites —
 * the card read, the LIST read (reached only AFTER the card read returned 200, i.e.
 * after Planka said the card EXISTS), and `loginAgent`'s access-token POST (an AUTH
 * failure, e.g. a misrouted PLANKA_BASE_URL). Testing `status === 404` alone strikes
 * on all three, so a wrong base URL would classify every candidate as `gone`. The
 * comparison is `===` and not `endsWith`: `loginAgent` passes an ABSOLUTE url, and
 * a suffix test would re-admit exactly the misrouting case.
 *
 * ⚠️ AND 'gone' STILL DOES NOT MEAN "DELETED". This estate's Planka fork answers
 * 404 for a card that EXISTS on a board the token can no longer see
 * (`cards/show.js` throws CARD_NOT_FOUND when `!boardMembership`). Nothing can tell
 * the two apart, so `card-read-gone` claims only "Planka answered 404 for this
 * card's own path" — which is why this script SKIPS such a row rather than writing
 * anything terminal onto it.
 */
function classifyReadFailure(err: unknown, what: string, definitivePath?: string): CardReadFailure {
  if (err instanceof CardReadFailure) return err;
  if (err instanceof PlankaError && err.status === 404) {
    if (definitivePath !== undefined && err.path === definitivePath) {
      return new CardReadFailure('gone', `${what} not found (404 on its own read path)`);
    }
    return new CardReadFailure(
      'degraded',
      `${what}: Planka answered 404 for ${err.path ?? '(no path recorded)'}, which is not the ` +
        `card read ${definitivePath ?? '(this read may never strike)'} — evidence about Planka ` +
        'or another object, not about the card',
    );
  }
  return new CardReadFailure('degraded', `${what} unreadable: ${errMessage(err)}`);
}

/** The card read this backfill needs from Planka. */
export interface PlankaReader {
  currentListName(cardId: string): Promise<string>;
}

export function plankaReaderFrom(planka: typeof plankaClient): PlankaReader {
  // Successful names only. ⛔ A FAILURE IS NEVER CACHED: memoising a null would let
  // one bad `lists.get` answer for every row on that list and skip the whole
  // backlog at once — the blast radius of a blip multiplied by the population.
  const listNameCache = new Map<string, string>();
  return {
    async currentListName(cardId: string): Promise<string> {
      let detail;
      try {
        detail = await planka.asAgent().cards.get(cardId);
      } catch (err) {
        // The ONLY call site that may produce 'gone'; it says so by passing the path.
        throw classifyReadFailure(err, `card ${cardId}`, cardReadPath(cardId));
      }
      const listId = detail?.item?.listId ?? null;
      // A 200 with no listId is Planka answering without answering. It is NOT
      // "the card is in no list, therefore not blocked".
      if (!listId) throw new CardReadFailure('degraded', `card ${cardId} came back with no listId`);
      const cached = listNameCache.get(listId);
      if (cached !== undefined) return cached;
      let list;
      try {
        list = await planka.asAgent().lists.get(listId);
      } catch (err) {
        // ⛔ NO `definitivePath`, DELIBERATELY. We are only here because the card
        // read returned 200 with a listId — Planka just said the card EXISTS.
        // Whatever `/api/lists/:id` answers cannot be evidence that it is deleted.
        throw classifyReadFailure(err, `list ${listId} of card ${cardId}`);
      }
      const name = list?.name ?? null;
      if (!name) throw new CardReadFailure('degraded', `list ${listId} came back with no name`);
      listNameCache.set(listId, name);
      return name;
    },
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface CandidateRow extends Record<string, unknown> {
  id: string;
  card_id: string;
  metadata: Record<string, unknown> | null;
  completed_at: unknown;
}

export interface BackfillOptions {
  apply: boolean;
  limit: number;
}

export async function runBackfill(
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const db = defaultDb;
  const planka = plankaReaderFrom(plankaClient);
  const send = sendN8nExpiryCallback;
  const pace = sleep;

  // ⛔ Clamped HERE, before it can reach the SQL. A caller cannot widen the bound.
  const limit = Math.max(1, Math.min(Math.trunc(opts.limit), MAX_LIMIT));

  const result: BackfillResult = {
    mode: opts.apply ? 'apply' : 'dry-run',
    candidates: 0,
    attempted: 0,
    sent: 0,
    failed: 0,
    skipped: emptySkips(),
    verdicts: [],
  };

  const rows = (await db.execute<CandidateRow>(candidateSql(limit))) as unknown as CandidateRow[];
  const candidates = Array.isArray(rows) ? rows : [];
  result.candidates = candidates.length;

  const skip = (row: CandidateRow, reason: SkipReason, detail?: string): void => {
    result.attempted += 1;
    result.skipped[reason] += 1;
    result.verdicts.push({
      approvalId: row.id,
      cardId: row.card_id,
      action: 'skip',
      reason,
      detail,
    });
  };

  /** Cards this run has already decided to send for — the duplicate suppressor. */
  const cardsSentFor = new Set<string>();

  for (const row of candidates) {
    // ── GUARD 1: never invent a target ──────────────────────────────────────
    // ⛔ THIS IS THE REFUSAL THE WHOLE ESTATE KEEPS RE-LEARNING. #1193's header:
    // "a null listId makes the Planka update a silent no-op, the marker comment is
    // still written, success is reported, and every retry then idempotency-skips —
    // a fix that looks like it worked while the card strands anyway." The receiver
    // has its own backstop (`Validate payload` refuses `expired` without
    // todoListId), and this is a second one on the sending side, because a row we
    // cannot target must be COUNTED here, not 400'd there where nobody reads it.
    // ⚠️ Measured 120/120 non-null, so this is a backstop and not a filter — which
    // is exactly why it must never be dropped as "unreachable".
    const todoListIdRaw = (row.metadata ?? {})['todoListId'];
    const todoListId = typeof todoListIdRaw === 'string' ? todoListIdRaw.trim() : '';
    if (!todoListId) {
      skip(row, 'no-todo-list-id', 'metadata.todoListId is missing or blank');
      continue;
    }

    // ── GUARD 2: one send per CARD ──────────────────────────────────────────
    // 120 rows sit on 101 cards. Firing four notices at one card is four
    // unconditional list moves for one repair.
    if (cardsSentFor.has(row.card_id)) {
      skip(row, 'duplicate-card', 'an earlier row in this run already covers this card');
      continue;
    }

    // ── GUARD 3: do not yank a card out from under a live gate ──────────────
    // 26 of the 76 blocked cards carry a `pending` approval; moving one to TODO
    // underneath an open gate would strand the gate instead of the card.
    // ⚠️ THE COST OF THIS SKIP IS NOT ZERO — only 4 of those 26 have their gate on
    // THIS rail. The other 22 wait on `kanban/approval-callback`, and that it will
    // ever release them is UNPROVEN. Accepted risk: up to 22 cards stay blocked. See
    // the header. Deleting this guard is the reversal, if that trade is ever refused.
    const openGate = (await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM approvals
       WHERE card_id = ${row.card_id} AND status = 'pending'
    `)) as unknown as Array<{ n: number }>;
    const pendingCount = Array.isArray(openGate) && openGate[0] ? Number(openGate[0].n) : 0;
    if (pendingCount > 0) {
      skip(row, 'live-pending-gate', `${pendingCount} pending approval(s) already open on this card`);
      continue;
    }

    // ── GUARD 4: the card must be in BLOCKED, live ──────────────────────────
    // See the header. Without this, 22 DONE cards get dragged back to TODO.
    let listName: string;
    try {
      listName = await planka.currentListName(row.card_id);
    } catch (err) {
      const failure =
        err instanceof CardReadFailure
          ? err
          : new CardReadFailure('degraded', errMessage(err));
      skip(
        row,
        failure.kind === 'gone' ? 'card-read-gone' : 'card-read-degraded',
        failure.message,
      );
      continue;
    }
    if (!isBlockedList(listName)) {
      skip(row, 'not-blocked', `card is in "${listName}", not BLOCKED — nothing to re-queue`);
      continue;
    }

    // ── DRY RUN STOPS HERE ──────────────────────────────────────────────────
    if (!opts.apply) {
      result.attempted += 1;
      result.sent += 1;
      cardsSentFor.add(row.card_id);
      result.verdicts.push({
        approvalId: row.id,
        cardId: row.card_id,
        action: 'send',
        detail: `WOULD send decision=expired -> todoListId ${todoListId} (card in ${listName})`,
      });
      continue;
    }

    // ── SEND, *THEN* RETIRE ─────────────────────────────────────────────────
    //
    // ⛔ THE ORDER IS THE FIX. THIS USED TO CLAIM FIRST AND IT WAS THE DEFECT THIS
    // FILE'S OWN HEADER CONDEMNS. The claim wrote `BACKFILL_MARKER` into
    // `error_message` BEFORE the send. `candidateSql` excludes every row whose
    // `error_message` matches that marker — so on a FAILED send the marker STAYED and
    // the row could never be selected again. Permanently retired, unrepaired, and the
    // next run then printed "NOTHING TO DO — no unbackfilled expired ready-signoff
    // rows remain." while the cards were still stuck. That is not theoretical on this
    // population: 61 of the 120 historical sends on this rail FAILED
    // (`error_message LIKE '%n8n re-queue callback FAIL%'`, measured on prod
    // 2026-09-07T13:52Z), so roughly half of it would have been silently retired on
    // the first armed run.
    //
    // ⚠️ The crash window ran the same way, not the other way: a process death between
    // the claim and the send left the marker with no notice ever sent — a SILENT DROP,
    // not a double-send. One re-ordering closes both.
    //
    // ⭐ WHY NOT THE OTHER FIX — "strip the marker on failure". REJECTED, and the
    // reason has to live here because a rejected alternative is invisible in a diff.
    // Stripping is a COMPENSATING WRITE, and a compensating write cannot run for the
    // failure mode that kills the process: SIGKILL, an OOM, a pod eviction, or the DB
    // connection dying between the claim and the strip all leave the marker in place
    // forever. It repairs the half of the bug that is polite enough to return an
    // error and leaves the half that isn't. A fix that depends on the failing path
    // still getting to run is not a fix.
    //
    // ⭐ AND WHY NOT A LEASE (marker + expiry, re-claimable after N minutes). Rejected
    // as over-engineering with a new failure mode: it turns a text marker into a state
    // machine with a clock, and picking the TTL is picking between re-sending too soon
    // and stranding rows for the TTL. This is a ONE-TIME script over 120 rows.
    //
    // ⚠️ THE RE-ORDERING'S OWN HAZARD, STATED RATHER THAN HIDDEN: the retire write can
    // now fail AFTER a successful send (`retireRow` swallows and returns false). The
    // row then stays selectable and the NEXT run re-sends for it. That is bounded, and
    // the bound was verified live rather than assumed — the receiver's `Idempotency
    // check` node finds its own `execution-signoff:{approval_id}:expired` comment from
    // the first send and `Route by decision` admits `expired` only on
    // `is_duplicate === false`, so the second notice moves NO card. The trade is
    // therefore: a bounded, self-cancelling duplicate versus an unbounded permanent
    // silence. Take the bounded one.
    //
    // ⚠️ AND THE PRICE: the pre-send claim was also the CONCURRENCY guard, and
    // send-then-retire gives that up — two simultaneous runs can both send for one
    // row. Same bound absorbs it. The cheap LAST LOOK below narrows the window to the
    // duration of one send without writing anything, so `already-claimed` still means
    // something; it just no longer pretends to be exclusive.
    const fresh = (await db.execute<{ marked: boolean }>(sql`
      SELECT (coalesce(error_message, '') LIKE ${'%' + BACKFILL_MARKER + '%'}) AS marked
        FROM approvals
       WHERE id = ${row.id}::uuid
    `)) as unknown as Array<{ marked: boolean }>;
    if (Array.isArray(fresh) && fresh[0]?.marked === true) {
      skip(row, 'already-claimed', 'another run retired this row between the SELECT and the send');
      continue;
    }

    result.attempted += 1;
    let outcome: Awaited<ReturnType<typeof sendN8nExpiryCallback>>;
    try {
      outcome = await send(row.id, { db });
    } catch (err) {
      // The sender is documented never to throw; if it ever does, the run must not abort.
      outcome = { outcome: 'failed', error: errMessage(err) };
    }

    if (outcome.outcome === 'sent') {
      result.sent += 1;
      cardsSentFor.add(row.card_id);
      // ⭐ THE ONLY WRITER OF THE TERMINAL MARKER, AND IT IS DOWNSTREAM OF A `sent`.
      const retired = await retireRow(db, row.id);
      result.verdicts.push({
        approvalId: row.id,
        cardId: row.card_id,
        action: 'send',
        detail:
          `sent decision=expired -> todoListId ${todoListId} (card was in ${listName})` +
          (retired
            ? ''
            : ' ⚠️ NOT retired — the marker write matched no row. The notice WAS sent; ' +
              'a later run may re-send, which the receiver idempotency-skips.'),
      });
    } else if (outcome.outcome === 'failed') {
      result.failed += 1;
      // ⛔ NON-TERMINAL. No marker, so the row is selected again next run.
      await noteAttempt(db, row.id, `FAILED: ${(outcome.error ?? 'unknown error').slice(0, 300)}`);
      result.verdicts.push({
        approvalId: row.id,
        cardId: row.card_id,
        action: 'fail',
        detail: outcome.error ?? 'unknown error',
      });
    } else {
      // skipped-not-found / not-expired / no-callback-path / unsupported-receiver.
      // The candidate SQL should make all four impossible; if one happens, the
      // premise is wrong and that is worth surfacing, not swallowing.
      // ⛔ ALSO NON-TERMINAL: a refusal means the premise was wrong, and a wrong
      // premise is a reason to look again, never a reason to retire the row.
      result.skipped['sender-refused'] += 1;
      await noteAttempt(db, row.id, `sender refused: ${outcome.outcome}`);
      result.verdicts.push({
        approvalId: row.id,
        cardId: row.card_id,
        action: 'skip',
        reason: 'sender-refused',
        detail: outcome.outcome,
      });
    }

    await pace(PACE_MS);
  }

  return result;
}

/**
 * RETIRE a row: the one and only write of `BACKFILL_MARKER`, issued only after the
 * sender reported `sent`.
 *
 * Still guarded by the same `NOT LIKE` predicate the pre-send claim used to carry —
 * not as a claim now, but so a concurrent run that already retired this row does not
 * get a second marker appended. `RETURNING id` is therefore the answer to "was I the
 * one who retired it", which the verdict reports.
 *
 * ⚠️ NEVER THROWS, and that is now load-bearing in the OTHER direction: the notice is
 * already out on the wire. Losing the whole run over the bookkeeping would strand the
 * remaining rows to fix a stamp. The cost of the swallow is one bounded re-send on a
 * later run, which the receiver's own idempotency layer cancels — and the verdict says
 * so out loud rather than reporting a clean send.
 */
async function retireRow(db: typeof defaultDb, approvalId: string): Promise<boolean> {
  try {
    const rows = (await db.execute<{ id: string }>(sql`
      UPDATE approvals
         SET error_message = coalesce(error_message, '')
                             || ${' | ' + BACKFILL_MARKER + ' sent at '}
                             || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             callback_send_attempts = callback_send_attempts + 1,
             updated_at = now()
       WHERE id = ${approvalId}::uuid
         AND coalesce(error_message, '') NOT LIKE ${'%' + BACKFILL_MARKER + '%'}
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    console.error(`[backfill] could not retire ${approvalId} after a SENT notice:`, errMessage(err));
    return false;
  }
}

/**
 * Record an attempt that did NOT succeed. Visibility without terminality.
 *
 * ⛔ THIS WRITE MUST NOT MATCH `candidateSql`'s EXCLUSION. It uses
 * `BACKFILL_ATTEMPT_NOTE` (asserted at import to be marker-free) and scrubs the
 * interpolated free text, so a failed row stays RE-SELECTABLE — which is the entire
 * point of the send-then-retire ordering above. `callback_send_attempts` still moves,
 * so "how many times has this been tried" is a number and not a text search.
 */
async function noteAttempt(
  db: typeof defaultDb,
  approvalId: string,
  note: string,
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE approvals
         SET error_message = coalesce(error_message, '')
                             || ${' | ' + BACKFILL_ATTEMPT_NOTE + ' at '}
                             || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                             || ${' -> ' + scrubMarker(note)},
             callback_send_attempts = callback_send_attempts + 1,
             updated_at = now()
       WHERE id = ${approvalId}::uuid
    `);
  } catch (err) {
    console.error(`[backfill] could not stamp attempt on ${approvalId}:`, errMessage(err));
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * ⛔ AN ALL-SKIPPED RUN MUST NOT READ AS A HEALTHY ONE. The report says
 * "SENT NOTHING" in as many words and `main` exits 3, because "the script ran" and
 * "the board changed" are different claims and a summary that blurs them is how a
 * no-op ships as a repair.
 */
export function formatReport(result: BackfillResult): string {
  const lines: string[] = [];
  const verb = result.mode === 'apply' ? 'sent' : 'WOULD send';
  lines.push('');
  lines.push('═'.repeat(78));
  lines.push(`  expired ready-signoff re-queue backfill — ${result.mode.toUpperCase()}`);
  lines.push('═'.repeat(78));
  lines.push(`  candidates selected : ${result.candidates}`);
  lines.push(`  decided             : ${result.attempted}`);
  lines.push(`  ${verb.padEnd(20)}: ${result.sent}`);
  lines.push(`  send failed         : ${result.failed}`);
  const skipTotal = Object.values(result.skipped).reduce((a, b) => a + b, 0);
  lines.push(`  skipped             : ${skipTotal}`);
  for (const [reason, n] of Object.entries(result.skipped)) {
    if (n > 0) lines.push(`      ${reason.padEnd(22)} ${n}`);
  }
  // The buckets must sum to the denominator, in the report as well as in the census.
  const sum = result.sent + result.failed + skipTotal;
  lines.push(`  ── sent+failed+skipped = ${sum}, decided = ${result.attempted}` +
    (sum === result.attempted ? ' ✓' : ' ✗ MISMATCH — a row escaped accounting'));
  lines.push('');
  if (result.candidates === 0) {
    lines.push('  NOTHING TO DO — no unbackfilled expired ready-signoff rows remain.');
  } else if (result.sent === 0) {
    lines.push(
      `  ⛔ SENT NOTHING. ${result.candidates} candidate(s) were selected and not one ` +
        'produced a notice.',
    );
    lines.push('     This run did NOT repair anything. Read the skip reasons above.');
  }
  if (result.mode === 'apply' && result.failed > 0) {
    // ⭐ Say the property out loud. A reader must not have to infer from the absence
    // of a marker that the failed rows are coming back; the whole blocker this file
    // was rejected for was a failed send that LOOKED terminal.
    lines.push(
      `  ↻ ${result.failed} send(s) FAILED and were NOT retired — those rows are still ` +
        'selectable and the next run will try them again.',
    );
  }
  lines.push('');
  for (const v of result.verdicts) {
    const tag = v.action === 'send' ? 'SEND' : v.action === 'fail' ? 'FAIL' : `SKIP ${v.reason}`;
    lines.push(`  [${tag}] approval ${v.approvalId} card ${v.cardId}${v.detail ? ` — ${v.detail}` : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

function parseLimit(argv: string[]): number {
  const i = argv.indexOf('--limit');
  if (i === -1) return DEFAULT_LIMIT;
  const raw = Number(argv[i + 1]);
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error(`--limit needs a positive number, got "${argv[i + 1] ?? '(nothing)'}"`);
  }
  return Math.trunc(raw);
}

/**
 * Everything `main` needs from the outside world, so the CLI itself is testable.
 *
 * ⛔ `main` RETURNS the exit code rather than calling `process.exit`, and takes its
 * argv, its runner, its streams and its connection-closer as arguments. Before this,
 * `main` was the one function no test could reach: `bun test` cannot call
 * `process.exit(3)` and survive, and driving it as a subprocess would need a real
 * `DATABASE_URL` — i.e. production. So the `exit 3` branch, the whole reason exit
 * codes were split at all, had NO coverage. A mutant that deleted it survived.
 */
/**
 * @returns the process exit code. 0 = ran (dry run, or an apply that sent something);
 *          3 = an apply run with candidates that sent NOTHING; 1 = `--limit` refused.
 *          A thrown error is mapped to 1 by the entrypoint below.
 */
export async function main(argv: string[]): Promise<number> {
  const log = (m: string) => console.log(m);
  const err = (m: string) => console.error(m);
  const run = runBackfill;
  const close = closeConnection;

  const apply = argv.includes('--apply');
  const limit = parseLimit(argv);

  if (limit > MAX_LIMIT) {
    err(
      `--limit ${limit} exceeds MAX_LIMIT ${MAX_LIMIT}. The measured population is ${MAX_LIMIT} ` +
        'rows; a larger limit could only be asking for rows nobody measured.',
    );
    return 1;
  }

  log(
    `[backfill] mode: ${apply ? 'APPLY (WILL send re-queue notices)' : 'DRY-RUN (reports only, writes nothing)'}` +
      `, limit ${limit}`,
  );
  if (!apply) {
    log('[backfill] re-run with --apply to arm. Nothing below is written.');
  }

  try {
    const result = await run({ apply, limit });
    log(formatReport(result));
    if (apply && result.candidates > 0 && result.sent === 0) return 3;
    return 0;
  } finally {
    await close();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((error) => {
      console.error('[backfill] run failed:', error);
      process.exit(1);
    });
}
