// src/services/planka-card-state.ts
//
// THE LIVE CARD-STATE READ — "where is this card RIGHT NOW", asked of Planka.
//
// ⛔ THIS FILE IS A MOVE, NOT A REWRITE. `PlankaReader` and `plankaReaderFrom`
// below (and the four private helpers they need) were lifted VERBATIM from
// `backend/scripts/repair-legacy-deblock-delivered-stamp.ts`, which still
// re-exports them so its own tests and call sites are untouched. Nothing about
// their behaviour changed in the move; every comment is the original author's.
//
// WHY IT MOVED. `backend/scripts/` is not in the server build, so nothing that
// runs inside fr-backend could import it. The reader is now needed by
// `workers/approval-expiry.ts`, which is a WORKER — see the redrive block in
// that file. A second spelling of this read would be the third one in the repo
// (the de-block worker carries its own, with its own `CardReadFailure`
// classification), and this repo's whole deblock-actions story is what happens
// when one predicate acquires five spellings.
//
// ⭐ WHAT THIS READ COSTS, AND WHY THE OTHER METHOD IS NOT THE ONE TO CALL.
// `currentListName` is ONE `cards.get` plus at most one `lists.get` (memoised
// per reader instance). `blockedSince` pages the card's ACTION LOG and costs up
// to `MAX_ACTION_PAGES` (10) requests PER CARD against the service whose 504s
// under load are the reason the de-block worker paces at 500 ms. A per-tick
// worker must call `currentListName`. `blockedSince` exists for the one-shot
// repair script that needs to know WHEN a block began, not merely THAT one is
// in force.
//
// ⛔ AND THE FAILURE DIRECTION IS THE POINT. Every unknown here THROWS rather
// than answering: a 200 with no `listId`, a list with no name, an empty first
// action page, an undatable move into BLOCKED. A caller must treat a throw as
// "we do not know", never as "not blocked" — the two are opposite licences.

import { encodePath, plankaClient } from './planka';
import { isBlockedList } from './toc-hooks';

/**
 * ⛔ BUILT WITH PLANKA'S OWN `encodePath`, not a hand-written template — the same
 * construction `services/planka/cards.ts::get` uses, so the two strings cannot
 * drift. Drift here fails in the dangerous direction, where a genuine 404 stops
 * being recognisable as one. Same argument as
 * `workers/deblock-callback-redelivery.ts` and
 * `scripts/backfill-expired-signoff-requeue.ts`; the reasoning lives there at length.
 */
function cardReadPath(cardId: string): string {
  return `/api/cards/${encodePath(cardId)}`;
}

/**
 * The card's ACTIVITY LOG. Same construction argument as `cardReadPath`.
 *
 * ⚠️ THERE IS NO `actions` RESOURCE ON `PlankaClient` AND THIS FILE DOES NOT ADD
 * ONE. `routes/kanban/reads.ts` and `routes/cards/get.ts` both reach this endpoint
 * through `client.http.request` directly, with the comment "no resource for actions
 * yet"; a third spelling invented here would be a third thing to drift. When that
 * resource lands, all three move together.
 */
function cardActionsPath(cardId: string): string {
  return `/api/cards/${encodePath(cardId)}/actions`;
}

/** The only Planka action type that can start a block. */
export const BLOCK_ACTION_TYPE = 'moveCard';

/**
 * HOW FAR BACK `blockedSince` WILL PAGE BEFORE IT GIVES UP.
 *
 * ⛔ EXHAUSTING THIS BOUND IS AN ERROR, NOT AN ANSWER. Paging out without having
 * seen a move into BLOCKED means "we did not look far enough", which is NOT the
 * same fact as "this card was never moved into BLOCKED" — and the two must not
 * collapse, because one of them would silently license a repair. `blockedSince`
 * THROWS on the bound and returns `null` only when Planka itself said the history
 * was exhausted (a page AFTER the first came back empty — an empty FIRST page is
 * an outage, see there).
 *
 * ⚠️ 10 IS `routes/measure.ts`'s VALUE, RE-DECLARED. That constant is module-private
 * (`const MAX_ACTION_PAGES = 10`, not exported), so there is nothing to import; if
 * it is ever exported, both call sites should bind to the one constant.
 */
export const MAX_ACTION_PAGES = 10;

/** The fields of a Planka action this file reads. `data` is `Record<string, never>` in the generated spec. */
interface CardAction {
  id?: string;
  type?: string;
  createdAt?: string | null;
  data?: { toList?: { name?: string | null } | null } | null;
}

/** The card reads the callers need from Planka. */
export interface PlankaReader {
  currentListName(cardId: string): Promise<string>;
  /**
   * WHEN THE CARD'S CURRENT BLOCK BEGAN — the instant of the MOST RECENT
   * `moveCard` whose `data.toList.name` is BLOCKED.
   *
   * THREE OUTCOMES, ALL DIFFERENT, NONE FOLDED INTO ANOTHER:
   *   a `Date` — the block start, measured.
   *   `null`   — Planka served the card's WHOLE history and it contains no move
   *              into BLOCKED. A fact, not a failure, and still not a licence.
   *   a throw  — we could not find out (404 / 504 / dead token / paged out, or a
   *              move into BLOCKED carrying a timestamp we cannot read).
   *
   * ⛔ ONLY THE `Date` CASE CAN EVER LICENSE A REPAIR. See `gateByBlockStart`.
   */
  blockedSince(cardId: string): Promise<Date | null>;
}

export function plankaReaderFrom(planka: typeof plankaClient): PlankaReader {
  // ⛔ SUCCESSFUL NAMES ONLY. Memoising a failure would let one bad `lists.get`
  // answer for every card on that list at once.
  const listNameCache = new Map<string, string>();
  return {
    async currentListName(cardId: string): Promise<string> {
      const detail = await planka.asAgent().cards.get(cardId);
      const listId = detail?.item?.listId ?? null;
      // A 200 with no listId is Planka answering without answering. It is NOT
      // "the card is in no list, therefore not blocked".
      if (!listId) throw new Error(`card ${cardId} came back with no listId (read ${cardReadPath(cardId)})`);
      const cached = listNameCache.get(listId);
      if (cached !== undefined) return cached;
      const list = await planka.asAgent().lists.get(listId);
      const name = list?.name ?? null;
      if (!name) throw new Error(`list ${listId} of card ${cardId} came back with no name`);
      listNameCache.set(listId, name);
      return name;
    },

    async blockedSince(cardId: string): Promise<Date | null> {
      // ⭐ PAGING WALKS STRICTLY BACKWARDS IN TIME, which is what makes the early
      // return below correct rather than lucky. `beforeId` is documented as "ID to
      // get actions before"; every page after the first is therefore OLDER than the
      // one before it. So the FIRST page that carries a move into BLOCKED carries
      // the MOST RECENT one, and nothing unread can be newer.
      let beforeId: string | undefined;
      let lastCursor: string | undefined;
      for (let page = 0; page < MAX_ACTION_PAGES; page += 1) {
        const res = await planka
          .asAgent()
          .http.request<unknown>(
            'GET',
            cardActionsPath(cardId),
            beforeId === undefined ? {} : { query: { beforeId } },
          );
        // Planka answers `{ items: [...] }`; `routes/cards/get.ts` also tolerates a
        // bare array, so this does too rather than disagreeing with it.
        const items: CardAction[] = Array.isArray(res)
          ? (res as CardAction[])
          : ((res as { items?: CardAction[] } | null)?.items ?? []);

        // ⛔ AN EMPTY *LATER* PAGE IS THE ONLY THING THAT MEANS "NO BLOCK START".
        // Planka has served the whole history and there is no move into BLOCKED.
        //
        // ⛔ AN EMPTY **FIRST** PAGE IS AN OUTAGE, NOT A HISTORY, and the two must
        // not collapse. `routes/kanban/reads.ts` states the invariant in as many
        // words: "every card has at least a `createCard` action, so an empty action
        // list is not something Planka can legitimately return" — which is why that
        // route reports `null` there rather than `[]`. Returning `null` here would
        // put the row in `noBlockStart`, a bucket that EXCLUDES silently; a Planka
        // serving `{items: []}` to every read would then produce a whole batch of
        // "no block start", `0 eligible`, no refusal and EXIT 0 — a total outage
        // wearing the report of a healthy, finished repair. It belongs in
        // `unreadable`, the bucket that can raise `block-gate-unavailable`.
        if (items.length === 0) {
          if (page === 0) {
            throw new Error(
              `card ${cardId}: ${cardActionsPath(cardId)} returned an EMPTY first page — ` +
                'every card has at least a `createCard` action, so this is an unreadable ' +
                'history, NOT a card that was never blocked',
            );
          }
          return null;
        }

        let newest: Date | null = null;
        for (const action of items) {
          if (action?.type !== BLOCK_ACTION_TYPE) continue;
          if (!isBlockedList(action?.data?.toList?.name)) continue;
          const at = action?.createdAt ? new Date(action.createdAt) : null;
          // ⛔ AN UNDATABLE MOVE INTO BLOCKED THROWS. IT USED TO `continue`, AND THAT
          // SKIP FAILED **OPEN**.
          //
          // `CardAction.createdAt` is `string | null`, so this is reachable from the
          // wire, not just in theory. Skipping it does not remove the move — it
          // removes only our knowledge of WHEN it happened, and then keeps scanning
          // OLDER actions. A card with an older, already-CLOSED block episode
          // therefore answers with the OLDER instant: `blockedSince` returns
          // 2026-08-10 for a card whose real, current block is the undatable newest
          // move. An EARLIER `blockStart` makes `completed_at > blockStart` MORE
          // likely true, so the skip hands the gate a licence it did not earn and
          // the row is repaired — re-delivering a stale decision against a card that
          // is blocked RIGHT NOW, which is exactly the 234 this gate exists to
          // refuse. The direction of the accident is what matters: every other
          // unknown in this function excludes, and this one INCLUDED.
          //
          // ⭐ SO IT GETS THE TREATMENT THE EMPTY FIRST PAGE ALREADY HAS: throw, into
          // `unreadable` — the bucket that REFUSES. "There is a move into BLOCKED and
          // we cannot date it" is the definition of "block start UNKNOWN", and this
          // file's whole rule is that unknown never licenses a write.
          if (at === null || Number.isNaN(at.getTime())) {
            throw new Error(
              `card ${cardId}: an UNDATABLE move into BLOCKED (action ${action?.id ?? '?'}, ` +
                `createdAt ${JSON.stringify(action?.createdAt ?? null)}) in ` +
                `${cardActionsPath(cardId)} — it cannot be dated and it cannot be ` +
                'ignored, because an older CLOSED episode would then answer in its ' +
                'place. Block start UNKNOWN, not absent, and NEVER older.',
            );
          }
          if (newest === null || at.getTime() > newest.getTime()) newest = at;
        }
        if (newest !== null) return newest;

        const last = items[items.length - 1]?.id;
        // A page of actions with no id to page from: we cannot advance, and we have
        // not answered. That is "we do not know", not "no block".
        if (!last) {
          throw new Error(
            `card ${cardId}: actions page ${page + 1} carried no id to page from ` +
              `(read ${cardActionsPath(cardId)}) — block start UNKNOWN`,
          );
        }
        // ⛔ NO-PROGRESS GUARD, the same one `routes/measure.ts::loadBoardThroughput`
        // carries. A Planka that ignores `beforeId` serves page 1 forever; without
        // this the loop would spend all `MAX_ACTION_PAGES` reads re-reading one page
        // against the very service whose 504s are this file's reason for existing.
        // ⭐ IT THROWS RATHER THAN BREAKING. `measure.ts` may `break` because its
        // answer is a REPORT and an undercount is still worth printing; this is a
        // GATE, and "we stopped early" is not "there is no block start".
        if (last === lastCursor) {
          throw new Error(
            `card ${cardId}: ${cardActionsPath(cardId)} did not advance past ${last} ` +
              '— paging made no progress, block start UNKNOWN, not absent',
          );
        }
        lastCursor = last;
        beforeId = last;
      }
      throw new Error(
        `card ${cardId}: no move into BLOCKED within ${MAX_ACTION_PAGES} pages of ` +
          `${cardActionsPath(cardId)} — block start UNKNOWN, not absent`,
      );
    },
  };
}
