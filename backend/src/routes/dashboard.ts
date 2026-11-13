// Operator-dashboard fallback endpoints.
//
// The home page (`/`) renders MyCardsCard, PendingApprovalsCard,
// RecentActivityCard. Each polls a cross-project endpoint and falls
// back to a "not available" message on non-200. PendingApprovalsCard
// shares `/api/approvals` with the existing handler (additive `data`
// field — see routes/approvals.ts handleListMyApprovals). This file
// owns the two endpoints that had no backend yet:
//
//   GET /api/cards?assignee=me&list=DOING,QA
//   GET /api/activity?limit=10
//
// Both are tenant-scoped to the calling user. Response envelope is
// `{ data: [...] }` to match the frontend's `body?.data ?? body ?? []`
// reader (frontend/src/lib/stores/navCounts.svelte.ts).

import { and, desc, eq } from 'drizzle-orm';
import { serializeCount } from '../lib/resolution';
import {
  db,
  streams,
  approvals,
  approvalDecisions,
  comments,
  projectReports,
} from '../db/client';
import { validateAuth } from '../middleware/auth';
import { loadProjectForRead } from '../lib/project-access';
import { ctxTenantId } from '../middleware/request-context';
import { UnauthorizedError } from '../utils/errors';
import { jsonResponse } from '../utils/response';
import { listCardsByList, PLANKA_CARD_PAGE_SIZE } from '../integrations/kanban';
import { plankaClient, encodePath, type PlankaClient } from '../services/planka';
import { keycloak } from '../services/keycloak';
import { isIntegrationError, reportSwallowedFailure } from '../integrations/_lib/errors';
import { PlankaNotFoundError, PlankaServerError } from '../services/planka/errors';
import {
  boardMetadataCache,
  type BoardMetadataList,
  type RawBoardDetail,
} from '../services/planka/board-metadata-cache';

// ── Fan-out bound (item 4) ───────────────────────────────────────────────────
// The streams query below had NO limit, and the loop that consumes it is a
// plain sequential `for…of await`. Live fan-out is small today — 18 active
// streams estate-wide, max 7 in one tenant (measured 2026-09-10,
// `select count(*) from streams where is_active`) — but "small today" is a
// property of the DATA, not of the code, and nothing stops a tenant creating
// hundreds. Each board contributes up to one board read plus one card read per
// matching list, each with its own multi-second timeout, all in series: the
// unbounded version's worst case is a request that never returns inside any
// gateway timeout while holding a Planka connection the whole way.
//
// 32 is ~4.5× the largest live tenant, so it cannot bite a real tenant today,
// and truncation is LOGGED rather than silent — a tenant that hits it is a
// signal that this endpoint needs pagination, not a bigger constant.
const MAX_DASHBOARD_BOARDS = 32;

// Below the 15 s default (`services/planka/http.ts REQUEST_TIMEOUT_MS`) because
// this is a dashboard tile, not a card view: N boards in series at 15 s each is
// how one slow board becomes a dead page. A board that cannot answer in 6 s is
// counted as a failed board read and contributes zero rows, which the
// partial/total accounting below already handles correctly.
const BOARD_READ_TIMEOUT_MS = 6_000;

/**
 * A board's list NAMES — the only thing this file ever wanted off a board.
 *
 * ── WHAT THIS REPLACED, AND WHAT IT COST ────────────────────────────────────
 * `planka.lists.listByBoard(boardId)` (services/planka/lists.ts) is
 * `GET /api/boards/:id` with everything but `included.lists` thrown away. That
 * endpoint has NO projection parameter, so `included` also carries every card
 * on the board and every customFieldValue of every card.
 *
 * ⭐ MEASURED 2026-09-10 on the live Planka database (worker4,
 * `postgres.example.com:5432`, db `kanban`), NOT taken on faith from the comment
 * that reported it for the card path:
 *
 *   board 1813235616851167013 "Asset Authoring — Requirements"
 *     8 lists · 3,949 cards · 45,618 custom_field_values
 *     sum(octet_length(row_to_json(card)))              = 28 MB
 *     sum(octet_length(row_to_json(custom_field_value))) = 13 MB
 *
 * ⛔ AND THAT BOARD IS ON THIS PATH. It is the FIRST active stream of tenant
 * 0195f48b-…-0001 (`select planka_board_id from streams where is_active`), so
 * every single `GET /api/cards?assignee=me` from that tenant made Planka
 * serialise ~41 MB of rows, pushed it over the wire, and fr parsed it to read
 * eight `{id,name}` pairs. The eight lists it wanted are ~400 bytes. That is
 * five orders of magnitude of waste, per request, per board — and the cost
 * lands on BOTH processes: Planka's V8 heap (`--max-old-space-size=2048`,
 * FATAL "Reached heap limit" at 1983 MB on 2026-09-10 09:54:02Z, before the
 * 3Gi cgroup limit can produce an OOMKilled) and fr's own.
 *
 * ── WHY THE EXISTING CACHE AND NOT A NEW ONE ────────────────────────────────
 * `services/planka/board-metadata-cache.ts` already solved exactly this for
 * `GET /api/cards/:id`, and its header records the search for a narrower Planka
 * endpoint: there is none. `/boards/:id/lists` is POST-only, Planka's lists
 * controller has NO index action at all, and `/lists/:id` eagerly loads that
 * list's cards and customFieldValues. So the board read cannot be made cheaper
 * — only RARER (TTL) and non-CONCURRENT (single-flight). A second cache here
 * would double the retained bytes and could disagree with the first about the
 * same board; this path shares the process-wide instance.
 *
 * ── INVALIDATION, AND WHETHER A STALE NAME CAN MISLEAD THE CONVEYOR ─────────
 * TTL is 60 s; the entry is a few KB (`{id,name}` per list) and the cards /
 * customFieldValues bags are never retained. Two staleness modes matter here,
 * and they are NOT the same as on the card path:
 *
 *   * The card path passes `probeListId` — the list id of the FRESH card — so a
 *     newly-created list self-invalidates the entry. THIS path has no fresh
 *     card to probe with: it is asking "which lists exist?", so it has nothing
 *     to prove the answer incomplete. A list CREATED or RENAMED-INTO
 *     DOING/QA is therefore invisible for up to 60 s.
 *   * A list renamed OUT of DOING/QA is still queried for up to 60 s; its cards
 *     arrive stamped with the stale name.
 *
 * Both are bounded by TTL and both self-heal. They cannot mislead the CONVEYOR:
 * this endpoint is read-only (it renders the operator dashboard's DOING/QA
 * counts and the sidebar badge) and moves no card, writes no field and makes no
 * authorization decision. The phase lists it matches are provisioned once per
 * board from `services/improvement-cards/field-groups.ts` and renamed
 * essentially never — the 8-list layout is identical on all 12 live boards.
 * A 60-second-late count on a dashboard tile is a strictly smaller defect than
 * the 41 MB read that produced it.
 *
 * ── TENANT SAFETY ──────────────────────────────────────────────────────────
 * The cache is process-wide and keyed by Planka board id. It cannot leak across
 * tenants because the KEYS asked for here come from `streams` already filtered
 * on `tenant_id` — the cache is consulted only for boards this caller's tenant
 * owns, and it returns list NAMES, never cards.
 */
async function readBoardLists(
  planka: PlankaClient,
  boardId: string,
): Promise<BoardMetadataList[]> {
  const meta = await boardMetadataCache.get({
    boardId,
    fetchBoard: () =>
      planka.http.request<RawBoardDetail>(
        'GET',
        `/api/boards/${encodePath(boardId)}`,
        // Item 4's other half: a per-board deadline. N boards in series at the
        // 15 s default is how one slow board becomes a dead dashboard.
        { timeoutMs: BOARD_READ_TIMEOUT_MS },
      ),
    // No `probeListId` / `probeFieldIds` — see the staleness note above. There
    // is deliberately no probe: this path has no fresh card whose ids could
    // prove the entry incomplete, and inventing one would be a probe that
    // cannot fail, which is worse than no probe at all.
  });
  return meta.lists;
}

/**
 * ⭐ ITEM 2 — the ONE thing wrong with the total-failure refusal.
 *
 * The refusal itself is CORRECT and stays: when every board or every card read
 * fails, this endpoint rethrows rather than answering `200 []`, because a
 * confident empty during an outage is a lie the caller cannot detect
 * (#848/#912). And the "bare 502" half of the complaint is already fixed, in
 * the frontend, on this same branch: `MyCardsCard.svelte` now distinguishes
 * `unavailable` (404 ⇒ route not built) from `error` (any other non-200 ⇒ "the
 * board service could not be reached. Your cards are not gone; this count is
 * unknown, not zero"). That is the right place for it — only the client can
 * decide how to RENDER an outage, and the backend must not soften a 5xx into a
 * 200 to make rendering easier.
 *
 * ⛔ WHAT IS STILL BROKEN IS THE STATUS ITSELF, ON ONE PATH. The rethrown cause
 * is mapped by its OWN status, and a 404 is a status this endpoint can produce:
 *   * a stale `streams.planka_board_id` (an active stream pointing at a deleted
 *     board) ⇒ `PlankaNotFoundError` ⇒ `statusForPlankaError` ⇒ **404**;
 *   * `listCardsByList` on a deleted list ⇒ `IntegrationError
 *     UPSTREAM_NOT_FOUND` ⇒ `httpStatusFor` ⇒ **404**.
 * If that is the FIRST captured error and EVERY read failed, this endpoint
 * answers 404 — and 404 is precisely the code `MyCardsCard` reads as "this fr
 * endpoint has not been built yet". The operator is then told a feature is
 * unshipped when the truth is that fr's board pointers are stale or Planka lost
 * the board. That is the exact defect the frontend comment says it fixed,
 * re-entering through the status code instead of through the fallback branch.
 *
 * (Measured 2026-09-10: all 18 active `streams.planka_board_id` values do exist
 * in Planka's `board` table today, so this is a latent hazard, not a live
 * outage. It becomes live the moment anyone deletes a board without
 * deactivating its stream.)
 *
 * So: NOT-FOUND-ness of an UPSTREAM resource is never 404-ness of THIS route.
 * A total failure is restated as a gateway error, cause preserved for the log
 * and for `error.cause`. Every other error passes through untouched — an
 * agent-credential 401 must still surface as 502 UPSTREAM_UNAUTHORIZED and a
 * timeout as 504, which is why this narrows to the 404 case only rather than
 * blanket-wrapping.
 */
function asTotalOutage(err: unknown): unknown {
  const isUpstream404 =
    err instanceof PlankaNotFoundError ||
    (isIntegrationError(err) && err.code === 'UPSTREAM_NOT_FOUND');
  if (!isUpstream404) return err;
  return new PlankaServerError(
    'every board read for this tenant failed with 404 (stale streams.planka_board_id, ' +
      'or the board was deleted upstream)',
    { status: 502, path: '/api/cards?assignee=me', cause: err },
  );
}

function authErrorToResponse(e: unknown): Response {
  const code = (e as { code?: string }).code;
  const isJoseAuthError = typeof code === 'string' && code.startsWith('ERR_JWT_');
  if (e instanceof UnauthorizedError || isJoseAuthError) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  throw e;
}

interface DashboardCardRow {
  id: string;
  list: string;
  name: string;
  boardId: string;
  listId: string;
  projectId: string | null;
  streamId: string;
  dueDate: string | null;
  position: number | null;
  type: string;
}

/**
 * Resolve the CALLING fr user to their Planka `user_account.id`.
 *
 * The two ids are in different spaces and nothing converts one to the other:
 * fr carries the Keycloak `sub` (UUID), Planka carries a snowflake integer.
 * The only shared key is the email address. We take the email off the
 * verified access token; the Keycloak admin lookup is kept purely as a
 * fallback for a token that carries no `email` claim.
 *
 * ⚠️ Since 2026-10-10 fr acts in Planka as ONE configured account (per tenant,
 * not per user) and no longer creates Planka users for fr users, so this
 * resolves only for people who have a Planka account of their own.
 *
 * ⚠️ TWO OUTCOMES, DELIBERATELY DIFFERENT — do not collapse them:
 *   - RESOLVED-TO-NOTHING (`undefined`): the lookup ran and this person simply
 *     has no Planka account. There are more Keycloak users than Planka users
 *     (16 live), so this is a normal case, not a fault. The caller then
 *     matches zero memberships and the endpoint answers zero rows, which is
 *     the TRUE answer: a user with no Planka account cannot be a card member.
 *     It must never fall back to comparing the raw ids again — that
 *     comparison is unsatisfiable, so a "fallback" to it would be a fallback
 *     to a guaranteed wrong answer.
 *   - LOOKUP FAILED (throws): Planka/Keycloak could not be read. That is an
 *     outage, and answering it with zero rows is the confident-empty defect
 *     this file already refuses on its board reads (#848/#912). It propagates
 *     and server.ts renders the IntegrationError's real status (502/504).
 */
/**
 * A one-line, human-readable name for an approval in the activity feed.
 *
 * `approvals.description` is producer-defined free text, and several producers
 * write a JSON blob or a multi-line block reason / procedure chain into it
 * (e.g. the project-start brief). Home's "Recent activity" printed that raw —
 * UI review 2026-10-07. Prose keeps its first line (capped); a structured blob
 * is replaced by the action name or kind, never echoed. Pure — unit-tested.
 */
export function summarizeApprovalTarget(
  description: string | null | undefined,
  kind: string | null | undefined,
  actionName: string | null | undefined,
): string {
  const fallback = (actionName && actionName.trim()) || (kind && kind !== 'generic' ? kind : null) || 'approval';
  const text = (description ?? '').trim();
  if (!text || text.startsWith('{') || text.startsWith('[{') || text.startsWith('```')) return fallback;
  const firstLine = text.split(/\r?\n/)[0]!.replace(/^\[[\w.-]+\]\s*/, '').trim();
  if (!firstLine) return fallback;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

export async function resolveCallerPlankaUserId(user: {
  id: string;
  email?: string | null;
}): Promise<string | undefined> {
  let email = user.email?.trim().toLowerCase() ?? '';
  if (!email) {
    const kcUser = await keycloak.getUserById(user.id);
    email = kcUser?.email?.trim().toLowerCase() ?? '';
  }
  if (!email) return undefined;

  // ⚠️ ABSENCE AND UNREACHABILITY ARE DIFFERENT, AND THIS CALL CAN PRODUCE BOTH.
  //
  // Resolving the caller's Planka id is a NEW dependency on this path — before
  // #1037 the handler never asked Planka who the caller was, it just compared
  // two ids that could never match. Letting every failure here propagate made a
  // 404 on `/api/users` fail the WHOLE dashboard, including the
  // genuinely-empty-board case, which is a strictly worse endpoint than the one
  // being fixed. CI caught it: three cases went red on
  // `PlankaNotFoundError: Planka 404 on /api/users`.
  //
  // So the two answers are separated, the same way the Planka and Keycloak
  // boundaries were separated earlier:
  //
  //   * NOT FOUND (404 / no matching email) — the caller has no Planka account.
  //     That is a FACT, not an outage: they own no Planka cards, and an empty
  //     result is the honest answer. Degrade to `undefined`.
  //   * ANYTHING ELSE (5xx, timeout, transport) — we could not ASK. Propagate,
  //     because answering "you have no cards" during an outage is the
  //     confident-empty defect this file already refuses (#848/#912). That
  //     refusal is the reason the strict version was written; it is kept for
  //     exactly the case it was written for, and no wider.
  let users: Array<{ id?: string | null; email?: string | null }>;
  try {
    users = await plankaClient.asAgent().members.listUsers();
  } catch (err) {
    if (err instanceof PlankaNotFoundError) return undefined;
    throw err;
  }
  return users.find((u) => u.email?.trim().toLowerCase() === email)?.id ?? undefined;
}

/**
 * Card ids the given PLANKA user is a member of.
 *
 * Extracted so the id space of the comparison is assertable on its own: the
 * defect in #1037 was not a wrong result, it was the wrong OPERAND, and with
 * one live `card_membership` row in the whole estate a test that graded this
 * by "rows came back" would have passed both before and after the fix.
 *
 * `undefined` (caller has no Planka account) yields an empty set — the same
 * zero rows the endpoint returns today, reached honestly.
 */
export function selectMyCardIds(
  memberships: ReadonlyArray<{ userId?: string | null; cardId?: string | null }>,
  plankaUserId: string | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!plankaUserId) return out;
  for (const m of memberships) {
    if (m.userId === plankaUserId && m.cardId) out.add(m.cardId);
  }
  return out;
}

/**
 * GET /api/cards?assignee=me&list=DOING,QA
 *
 * Cross-project listing of cards assigned to the calling user, scoped
 * to lists whose Planka name matches one of the comma-separated names
 * in `?list=`. Used by the operator-dashboard MyCardsCard and the
 * navCounts sidebar badge (DOING-only variant).
 *
 * Approach: enumerate every active stream in the user's tenant
 * (each stream owns a Planka board), pull the lists for each board,
 * keep the lists whose `name` matches the requested set, then fetch
 * cards on each matching list and filter by Planka card-membership
 * where `userId` equals the caller's PLANKA user id — resolved first,
 * via `resolveCallerPlankaUserId`.
 *
 * ⛔ THIS DOCBLOCK USED TO SAY "fr+Planka share user UUIDs via OIDC".
 * That was FALSE, it was written down as fact, and two separate call
 * sites were then built on it (#1037). fr and Planka do NOT share an id
 * space: `user.id` is the Keycloak `sub` (a UUID —
 * services/keycloak.ts:~305 reads it off `claims.sub`), while
 * `CardMembership.userId` is a Planka `user_account.id` (a snowflake
 * integer, e.g. `1560328737491256322`). Measured 2026-09-08: 0 of 16
 * live Planka user ids are UUID-shaped, so `m.userId === user.id` was
 * not merely usually-false, it was STRUCTURALLY unsatisfiable and this
 * endpoint could only ever answer `[]`.
 *
 * The join that actually exists is EMAIL: `resolveCallerPlankaUserId`
 * below matches the verified access token's `email` against the Planka
 * users the agent client lists.
 *
 * Response envelope: `{ data: [{id, list, name, boardId, ...}],
 * total }`. Each card row is stamped with the uppercase list name
 * (e.g. "DOING"/"QA") so the frontend can split counts without a
 * second lookup. ONE bad Planka board contributes zero rows so it cannot
 * nuke the whole tile; EVERY board failing rethrows the captured cause
 * instead of answering a confident zero (#912). This docblock said "errors
 * per-board are swallowed" for a while after that stopped being true — a
 * comment describing behaviour the code no longer has is how the next reader
 * reintroduces the bug.
 *
 * Tenant isolation: the streams query is filtered on
 * `tenant_id = user.tenantId` and `is_active = true`. Only `assignee=me`
 * is supported today; anything else returns 400.
 */
export async function handleListMyCardsAcrossProjects(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    return authErrorToResponse(e);
  }

  const url = new URL(req.url);
  const assignee = url.searchParams.get('assignee');
  if (assignee !== 'me') {
    // Distinguish ABSENT from PRESENT-BUT-WRONG. Both are 400 and both keep the
    // stable machine code `unsupported_assignee`, but a bare
    // "only assignee=me is supported" told a caller who sent no `assignee` at
    // all that their value was rejected — leaving them to guess that the param
    // is required rather than optional-with-a-default.
    return jsonResponse(
      {
        error: 'unsupported_assignee',
        detail:
          assignee === null
            ? 'assignee query param is required; only assignee=me is supported'
            : 'only assignee=me is supported',
      },
      400,
    );
  }
  const listParam = url.searchParams.get('list') ?? '';
  const requested = new Set(
    listParam
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
  if (requested.size === 0) {
    // `total_kind` on the empty branches too: a handler's shape is the
    // UNION of its 200-shapes, so one branch
    // omitting the key would pin this route as `multi:` — and, more to the
    // point, a caller must not have to guess whether a missing kind means
    // "exact" or "we forgot".
    return jsonResponse({ data: [], total: 0, total_kind: 'exact' as const });
  }

  // ⚠️ `.limit(MAX_DASHBOARD_BOARDS + 1)` — one MORE than the bound, deliberately.
  // A query limited to exactly N cannot tell "N boards" from "N of many", so the
  // truncation warning below would be unwritable: `length === N` is true in both
  // cases. Fetching N+1 makes the overflow OBSERVABLE, and the extra row is
  // dropped before the loop so the fan-out bound still holds at N.
  //
  // ORDER BY created_at is what makes the truncation DETERMINISTIC. Without an
  // ORDER BY, Postgres may return a different N rows on each call, so a tenant
  // over the bound would see its card counts flicker between page loads with no
  // change in the data — a far worse failure than a stable, logged truncation.
  const loadStreams = (async (tenantId: string) =>
      db
        .select({
          id: streams.id,
          planka_board_id: streams.planka_board_id,
          planka_project_id: streams.planka_project_id,
        })
        .from(streams)
        .where(and(eq(streams.tenant_id, tenantId), eq(streams.is_active, true)))
        .orderBy(streams.created_at, streams.id)
        .limit(MAX_DASHBOARD_BOARDS + 1));

  const fetchedStreams = await loadStreams(ctxTenantId(user.tenantId));

  if (fetchedStreams.length === 0) {
    // `total_kind` on the empty branches too: a handler's shape is the
    // UNION of its 200-shapes, so one branch
    // omitting the key would pin this route as `multi:` — and, more to the
    // point, a caller must not have to guess whether a missing kind means
    // "exact" or "we forgot".
    return jsonResponse({ data: [], total: 0, total_kind: 'exact' as const });
  }

  const truncated = fetchedStreams.length > MAX_DASHBOARD_BOARDS;
  const tenantStreams = truncated
    ? fetchedStreams.slice(0, MAX_DASHBOARD_BOARDS)
    : fetchedStreams;
  if (truncated) {
    // Loud, because the answer below is now a PARTIAL one and the caller cannot
    // see that from the envelope. If this ever fires in production the fix is
    // pagination on this endpoint, not a larger MAX_DASHBOARD_BOARDS.
    console.warn(
      `[dashboard] tenant has more than ${MAX_DASHBOARD_BOARDS} active streams; ` +
        `card counts are computed over the ${MAX_DASHBOARD_BOARDS} oldest boards only`,
    );
  }

  const planka = plankaClient.asAgent();
  const rows: DashboardCardRow[] = [];
  let anyCardPageFull = false;

  // Resolved ONCE, after the no-streams early return (so a tenant with no
  // boards still costs zero upstream calls) and BEFORE the loop (so N lists do
  // not become N identity lookups). `undefined` here means "no Planka account",
  // not "lookup failed" — see resolveCallerPlankaUserId. The loop is still
  // entered in that case, deliberately: short-circuiting to `[]` would restore
  // the exact ambiguity the board-read accounting below exists to remove,
  // where a Planka outage and an empty board give the same answer.
  const callerPlankaUserId = await resolveCallerPlankaUserId(user);

  // A read that FAILED and a board that is genuinely EMPTY produced the same
  // answer here — `200 []` — which is how a four-month Planka outage stayed
  // invisible: every `listCardsByList` call 401'd from 2026-04-24 until #848,
  // and this loop reported "you have no cards" the whole time. Per-list
  // resilience is still right (one bad list must not blank the page), so what
  // changes is only that TOTAL failure is no longer indistinguishable from
  // emptiness: it is counted, and if nothing at all could be read the cause is
  // rethrown rather than answered with a confident zero.
  //
  // ⚠️ `boardsAttempted` now counts boards whose list names came from the
  // metadata cache without an upstream read. That does NOT weaken the outage
  // detection: during a Planka outage a warm cache lets the board half succeed,
  // but every `readCardsByList` still fails, so the SECOND guard
  // (`cardReadsFailed === cardReadsAttempted`) fires and the request still
  // refuses rather than answering a confident zero. The two counters were
  // already independent; keeping them independent is what preserves #912 across
  // the caching change.
  let boardsAttempted = 0;
  let boardsFailed = 0;
  let cardReadsAttempted = 0;
  let cardReadsFailed = 0;
  let firstReadError: unknown;

  for (const stream of tenantStreams) {
    if (!stream.planka_board_id) continue;
    let lists: BoardMetadataList[];
    boardsAttempted++;
    try {
      lists = await readBoardLists(planka, stream.planka_board_id);
    } catch (err) {
      boardsFailed++;
      firstReadError ??= err;
      continue;
    }
    const matching = lists.filter((l) => {
      const name = (l.name ?? '').trim().toUpperCase();
      return requested.has(name);
    });
    for (const l of matching) {
      let cardsResp;
      cardReadsAttempted++;
      try {
        cardsResp = await listCardsByList(l.id);
      } catch (err) {
        cardReadsFailed++;
        firstReadError ??= err;
        continue;
      }
      // A FULL Planka page means that list was cut, not exhausted
      // (`integrations/kanban.ts` pins PLANKA_CARD_PAGE_SIZE and its own JSDoc
      // says `items.length` is "a page size, never a list size"). One such list
      // anywhere in the fan-out makes the whole row count a lower bound.
      if (cardsResp.items.length >= PLANKA_CARD_PAGE_SIZE) anyCardPageFull = true;
      const memberships = cardsResp.included.cardMemberships ?? [];
      const myCardIds = selectMyCardIds(memberships, callerPlankaUserId);
      for (const c of cardsResp.items) {
        if (!myCardIds.has(c.id)) continue;
        rows.push({
          id: c.id,
          list: (l.name ?? '').trim().toUpperCase(),
          name: c.name,
          boardId: c.boardId,
          listId: c.listId,
          projectId: stream.planka_project_id,
          streamId: stream.id,
          dueDate: c.dueDate ?? null,
          position: c.position ?? null,
          type: c.type,
        });
      }
    }
  }

  // Judged over the whole request, not per stream: "everything we tried to
  // read failed" is an outage, and answering it with an empty list would be a
  // lie the caller cannot detect. The captured cause is rethrown rather than a
  // synthesised code, so a Planka credential failure surfaces as the
  // UPSTREAM_UNAUTHORIZED it actually is (502 via httpStatusFor) and a timeout
  // as UPSTREAM_TIMEOUT (504). server.ts's handleError converts an escaping
  // IntegrationError to its real status since #908.
  if (boardsAttempted > 0 && boardsFailed === boardsAttempted) {
    throw asTotalOutage(firstReadError);
  }
  if (cardReadsAttempted > 0 && cardReadsFailed === cardReadsAttempted) {
    throw asTotalOutage(firstReadError);
  }
  if (boardsFailed > 0 || cardReadsFailed > 0) {
    console.warn(
      `[dashboard] partial card read: ${boardsFailed}/${boardsAttempted} board list reads and ` +
        `${cardReadsFailed}/${cardReadsAttempted} card reads failed; returning ${rows.length} rows`,
    );
  }

  // ⚠️ `total` USED TO BE `rows.length` over a set cut in THREE independent
  // places, none of which reached the envelope: the `MAX_DASHBOARD_BOARDS`
  // board cap (whose own comment above says "the answer below is now a PARTIAL
  // one and the caller cannot see that from the envelope"), any board/card read
  // that failed and was `continue`d past, and Planka's own per-list page size.
  //
  // ⛔ NO `COUNT(*)` IS POSSIBLE HERE and that is not a cost decision. The "my
  // cards" predicate is applied in JS over Planka HTTP responses; there is no
  // table to count and no upstream count endpoint, so the only way to get a
  // true total is to redo the entire uncapped fan-out.
  //
  // ⚠️ `at_least`, NOT `unknown`, and that correction has its own incident.
  // This site first shipped as `unknownReason`, which turned EVERY cut into
  // `total: null` — and a one-list 401 is a cut. That inverted the property
  // ("PARTIAL -> still tolerated: one bad list must not blank
  // the page"): the page kept its rows and lost its count, which is the same
  // four-month-outage defect wearing the other mask — one partial failure
  // rendered as total failure.
  //
  // ⭐ All four cuts below share ONE property: every row in `rows` matched the
  // predicate, so `rows.length` is a TRUE FLOOR under the real total. That is
  // the definition of `at_least`, and it is what `integrations/kanban.ts`
  // already prescribes for this very data ("a caller can render '1,000+'
  // honestly"). `unknown` here would discard a number we measured.
  //
  // ⛔ AND `unknown` IS NOT NEEDED, because the only state in which no floor
  // exists is TOTAL failure — and that is rethrown above, before this point.
  // The floor-of-zero case (a cut that left no rows at all) degrades to
  // `unknown` inside `resolveCount`, so a bare `0` still cannot ship.
  const { total, total_kind, headers } = serializeCount({
    rows,
    // Not a row cap on `rows` — hence `null` — the three real cuts are named
    // explicitly below, because each one is invisible to a page-length probe.
    appliedLimit: null,
    lowerBoundReason:
      truncated || boardsFailed > 0 || cardReadsFailed > 0 || anyCardPageFull
        ? [
            truncated && `only the ${MAX_DASHBOARD_BOARDS} oldest boards were read`,
            boardsFailed > 0 && `${boardsFailed}/${boardsAttempted} board list reads failed`,
            cardReadsFailed > 0 && `${cardReadsFailed}/${cardReadsAttempted} card reads failed`,
            anyCardPageFull && 'at least one list returned a full Planka page',
          ]
            .filter(Boolean)
            .join('; ')
        : null,
  });
  return jsonResponse({ data: rows, total, total_kind }, 200, headers);
}

interface ActivityRow {
  id: string;
  actor: string | null;
  verb: string;
  target: string;
  ts: string;
}

/**
 * Run every activity source, tolerate a partial failure, refuse a total one.
 *
 * Each source used to `catch { return [] }`, so a database outage rendered as
 * an empty feed — a confident "nothing has happened here" that a caller cannot
 * tell from a genuinely quiet tenant. The intent (one bad table must not blank
 * the tile) is right and is preserved verbatim; what changes is that the
 * implementation can now tell one bad table from ALL of them.
 *
 * Unlike the Planka readers in this codebase, these are OUR OWN database, so a
 * total failure is a genuine internal fault: the captured cause is rethrown as
 * itself and renders 500, rather than the 502/504 an upstream outage earns.
 */
async function gatherActivitySources(
  surface: string,
  sources: Array<() => Promise<ActivityRow[]>>,
  // ⭐ ADDED so a partial read can reach the RESPONSE, not just the log.
  // A degraded source used to be `console.warn`-only, which meant the caller
  // reported a `total` over a set it could not know was short — the same trap
  // `page-cap.ts` records ("a frame that THREW is not measured, so a short page
  // reads as complete"). Optional, so the two existing call sites and both unit
  // tests keep working unchanged.
  onPartial?: (failedCount: number, sourceCount: number) => void,
): Promise<ActivityRow[]> {
  const settled = await Promise.allSettled(sources.map((fn) => fn()));
  const failed = settled.filter((r) => r.status === 'rejected');
  if (sources.length > 0 && failed.length === sources.length) {
    throw (failed[0] as PromiseRejectedResult).reason;
  }
  if (failed.length > 0) {
    console.warn(
      `[dashboard] partial activity read on ${surface}: ${failed.length}/${sources.length} sources failed`,
      (failed[0] as PromiseRejectedResult).reason,
    );
    onPartial?.(failed.length, sources.length);
  }
  return settled
    .filter((r): r is PromiseFulfilledResult<ActivityRow[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value);
}

/**
 * GET /api/activity?limit=10
 *
 * Tenant-scoped recent activity feed for the operator dashboard
 * RecentActivityCard. Reads one source, scoped to the calling user's
 * tenant (the kaizen_log source went with the v3 kaizen loop, 2026-11-03):
 *
 *   - approval_decisions  → "approved/rejected <approval description>"
 *
 * Comments are NOT included: the `projects` table has no tenant_id
 * column today, so a cross-tenant feed couldn't safely scope them
 * without a multi-hop join (dept→workspace→…) that has no canonical
 * tenant pin. Add comments here once projects.tenant_id lands.
 *
 * Each row is normalized to {id, actor, verb, target, ts}, sorted by
 * ts DESC, capped at min(limit, 50). `actor` is the resolved Keycloak
 * display name when available, else the raw actor UUID, else null
 * (system-emitted rows). Resolution goes through `keycloak.resolveUsers`
 * — NOT Planka, whose user ids are in a different space entirely and
 * could never match an fr actor id (#1037). An actor the directory
 * cannot name falls back to its UUID and the feed still renders.
 *
 * One bad source contributes zero rows — one bad table must not blank the
 * tile. But EVERY source failing is not an empty feed, it is a failed one, and
 * is rethrown (500: unlike the Planka readers, this is our own database, so a
 * total failure really is an internal fault).
 */
export async function handleListRecentActivity(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    return authErrorToResponse(e);
  }

  const url = new URL(req.url);
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '10', 10);
  const limit = Math.min(
    50,
    Math.max(1, Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 10),
  );

  const fetchApprovalDecisions = async (): Promise<ActivityRow[]> => {
    try {
      const rows = await db
        .select({
          id: approvalDecisions.id,
          decision: approvalDecisions.decision,
          decided_at: approvalDecisions.decided_at,
          approver_id: approvalDecisions.approver_id,
          description: approvals.description,
          kind: approvals.kind,
          action_name: approvals.action_name,
        })
        .from(approvalDecisions)
        .innerJoin(approvals, eq(approvals.id, approvalDecisions.approval_id))
        .where(eq(approvals.tenant_id, ctxTenantId(user.tenantId)))
        .orderBy(desc(approvalDecisions.decided_at))
        .limit(limit);
      return rows.map((r) => ({
        id: `approval-decision:${r.id}`,
        actor: r.approver_id,
        verb: r.decision,
        target: summarizeApprovalTarget(r.description, r.kind, r.action_name),
        ts: r.decided_at instanceof Date ? r.decided_at.toISOString() : String(r.decided_at),
      }));
    } catch (err) {
      // Rethrow. The gatherer below decides whether ONE bad source is
      // tolerable (it is) or whether EVERY source failing should still be
      // rendered as "no activity" (it must not be).
      throw err;
    }
  };

  let partialReason: string | null = null;
  const gathered = await gatherActivitySources(
    '/api/activity',
    [fetchApprovalDecisions],
    (failedCount, sourceCount) => {
      partialReason = `${failedCount} of ${sourceCount} activity sources failed — the set is incomplete`;
    },
  );

  const merged = [...gathered]
    .sort((a, b) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0))
    .slice(0, limit);

  const actorIds = new Set<string>();
  for (const r of merged) {
    if (r.actor) actorIds.add(r.actor);
  }
  if (actorIds.size > 0) {
    const nameMap = await resolveActorNames(actorIds);
    for (const r of merged) {
      if (r.actor && nameMap.has(r.actor)) {
        r.actor = nameMap.get(r.actor) ?? r.actor;
      }
    }
  }

  // ⚠️ `total` USED TO BE `merged.length`, which is `limit` whenever the feed
  // is busy — default 10, ceiling 50. Both sources are ALSO `.limit(limit)`-ed
  // individually, so a tenant with thousands of decisions read `total: 10`.
  //
  // ⛔ A `COUNT(*)` was considered and REJECTED here. This is a UNION of two
  // independently-capped sources that `gatherActivitySources` may degrade to
  // `[]` on a partial failure, so a summed count can exceed what the list can
  // ever show — which moves the lie rather than removing it (the reasoning
  // `routes/assets/_lib/page-cap.ts` already records). The probe compares the
  // PRE-slice union length against the cap; a degraded read is `unknown`.
  const { total, total_kind, headers } = serializeCount({
    rows: merged,
    appliedLimit: limit,
    sourceRowCount: gathered.length,
    unknownReason: partialReason,
  });
  return jsonResponse({ data: merged, total, total_kind }, 200, headers);
}

/**
 * GET /api/projects/:projectId/activity?limit=20
 *
 * Project-scoped recent activity feed for the Project Workspace cockpit
 * (`/projects/[id]`). Unlike the tenant-wide `/api/activity` (which is
 * stream/kaizen + tenant-approvals), this is scoped to ONE project via
 * the per-row `project_id` that three sources already carry:
 *
 *   - approval_decisions (via approvals.project_id) → "approved/rejected …"
 *   - comments           (comments.project_id)       → "commented …"
 *   - project_reports    (project_reports.project_id)→ "<type> report …"
 *
 * Kaizen is deliberately excluded: kaizen_log is keyed by `stream_id`
 * (continuous-improvement boards), not by a regular project, so it has
 * no faithful project scope. Access is gated by `loadTenantScopedProject`
 * (owner-AND-tenant + super-admin switched view — same gate as the
 * project's comments/metrics endpoints), so a caller only sees the feed
 * for a project reachable in their active tenant.
 *
 * Rows are normalized to {id, actor, verb, target, ts}, merged, sorted
 * ts DESC, capped at min(limit, 50). One bad source contributes zero rows
 * (and a total failure rethrows — see gatherActivitySources) so one bad table can't
 * blank the whole feed. UUID actors resolve to Keycloak display names
 * (see resolveActorNames — Planka is the wrong directory for these ids,
 * #1037); non-UUID actors (report `generated_by` = 'n8n'/'manual') do not
 * resolve and pass through unchanged.
 */
export async function handleProjectActivity(
  req: Request,
  projectId: string,
): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    return authErrorToResponse(e);
  }

  // Authorize: project must be reachable in the requester's active tenant.
  // Throws NotFoundError (→ 404) when out of scope — fail-closed.
  await loadProjectForRead(db, user, projectId);

  const url = new URL(req.url);
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
  const limit = Math.min(
    50,
    Math.max(1, Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20),
  );

  const snippet = (s: string): string =>
    s.length > 80 ? `${s.slice(0, 77)}…` : s;

  const fetchDecisions = async (): Promise<ActivityRow[]> => {
    try {
      const rows = await db
        .select({
          id: approvalDecisions.id,
          decision: approvalDecisions.decision,
          decided_at: approvalDecisions.decided_at,
          approver_id: approvalDecisions.approver_id,
          description: approvals.description,
        })
        .from(approvalDecisions)
        .innerJoin(approvals, eq(approvals.id, approvalDecisions.approval_id))
        // ⛔ The project gate (tag == active) does NOT pin the approvals: an
        // approval's tenant_id can differ from its project's tag (webhooks
        // card-approval lets a body tenant_id win). Same house pattern as
        // domain/reporting — tag check AND approvals.tenant_id (fr row 14d).
        .where(
          and(
            eq(approvals.project_id, projectId),
            eq(approvals.tenant_id, ctxTenantId(user.tenantId)),
          ),
        )
        .orderBy(desc(approvalDecisions.decided_at))
        .limit(limit);
      return rows.map((r) => ({
        id: `approval-decision:${r.id}`,
        actor: r.approver_id,
        verb: r.decision,
        target: r.description,
        ts: r.decided_at instanceof Date ? r.decided_at.toISOString() : String(r.decided_at),
      }));
    } catch (err) {
      // Rethrow. The gatherer below decides whether ONE bad source is
      // tolerable (it is) or whether EVERY source failing should still be
      // rendered as "no activity" (it must not be).
      throw err;
    }
  };

  const fetchComments = async (): Promise<ActivityRow[]> => {
    try {
      const rows = await db
        .select({
          id: comments.id,
          author_id: comments.author_id,
          content: comments.content,
          created_at: comments.created_at,
        })
        .from(comments)
        .where(eq(comments.project_id, projectId))
        .orderBy(desc(comments.created_at))
        .limit(limit);
      return rows.map((r) => ({
        id: `comment:${r.id}`,
        actor: r.author_id,
        verb: 'commented',
        target: snippet(r.content),
        ts: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      }));
    } catch (err) {
      // Rethrow. The gatherer below decides whether ONE bad source is
      // tolerable (it is) or whether EVERY source failing should still be
      // rendered as "no activity" (it must not be).
      throw err;
    }
  };

  const fetchReports = async (): Promise<ActivityRow[]> => {
    try {
      const rows = await db
        .select({
          id: projectReports.id,
          report_type: projectReports.report_type,
          title: projectReports.title,
          generated_by: projectReports.generated_by,
          created_at: projectReports.created_at,
        })
        .from(projectReports)
        .where(eq(projectReports.project_id, projectId))
        .orderBy(desc(projectReports.created_at))
        .limit(limit);
      return rows.map((r) => ({
        id: `report:${r.id}`,
        actor: r.generated_by,
        verb: `${r.report_type} report`,
        target: r.title,
        ts: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      }));
    } catch (err) {
      // Rethrow. The gatherer below decides whether ONE bad source is
      // tolerable (it is) or whether EVERY source failing should still be
      // rendered as "no activity" (it must not be).
      throw err;
    }
  };

  let partialReason: string | null = null;
  const gathered = await gatherActivitySources(
    `/api/projects/${projectId}/activity`,
    [fetchDecisions, fetchComments, fetchReports],
    (failedCount, sourceCount) => {
      partialReason = `${failedCount} of ${sourceCount} activity sources failed — the set is incomplete`;
    },
  );

  const merged = [...gathered]
    .sort((a, b) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0))
    .slice(0, limit);

  const actorIds = new Set<string>();
  for (const r of merged) {
    if (r.actor) actorIds.add(r.actor);
  }
  if (actorIds.size > 0) {
    const nameMap = await resolveActorNames(actorIds);
    for (const r of merged) {
      if (r.actor && nameMap.has(r.actor)) {
        r.actor = nameMap.get(r.actor) ?? r.actor;
      }
    }
  }

  // ⚠️ Same defect and same reasoning as `/api/activity` above — `total` was
  // `merged.length`, i.e. `limit` (default 20, ceiling 50) on any active
  // project, over a THREE-source union each of which is separately
  // `.limit(limit)`-ed. A summed `COUNT(*)` is rejected for the same reason: a
  // degraded source makes it unreachable by the list.
  const { total, total_kind, headers } = serializeCount({
    rows: merged,
    appliedLimit: limit,
    sourceRowCount: gathered.length,
    unknownReason: partialReason,
  });
  return jsonResponse({ data: merged, total, total_kind }, 200, headers);
}

/**
 * Resolve a set of actor ids to display names. Returns a map keyed by the
 * SAME id that was passed in; ids that don't resolve are simply absent and
 * the caller leaves those rows on their raw-UUID fallback.
 *
 * ⛔ THIS USED TO ASK PLANKA, AND COULD NEVER ANSWER (#1037). `ids` are fr
 * actor ids — `approval_decisions.decided_by`, `kaizen_log`/`comments`
 * authors, `project_reports.generated_by` — i.e. Keycloak `sub` UUIDs. It
 * compared them against `plankaClient…listUsers()[].id`, a Planka snowflake
 * integer. Nothing was ever added to the map: `/api/activity` and
 * `/api/projects/:id/activity` rendered a bare UUID on `/dashboard` for
 * EVERY row, in every tenant, since the endpoint shipped. Measured
 * 2026-09-08: 1,083 of 1,087 `approval_decisions` actor rows are real people
 * whose sub resolves; the other 4 are the all-zeros sentinel, not a person.
 *
 * Resolution now happens in the id space the ids are actually in. Keycloak
 * IS fr's user directory, and `keycloak.resolveUsers` exists for precisely
 * this shape — its own docblock says "for turning a licenses table's raw
 * subject_id column into names/emails". Going sub → email → Planka instead
 * (the join `resolveCallerPlankaUserId` needs above, because THERE the
 * comparison target is genuinely a Planka row) would add a hop that can only
 * lose actors: an fr user who has never been provisioned in Planka would go
 * back to rendering a UUID for no gain.
 *
 * `resolveUsers` is bounded (cap 50 admin calls; `limit` is itself capped at
 * 50 upstream, so at most one actor per row) and best-effort per id: an id
 * that 404s or errors is omitted rather than throwing. The outer catch keeps
 * this function's non-throwing contract — a directory hiccup must not blank
 * the feed — but no longer does so silently.
 */
export async function resolveActorNames(ids: Set<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.size === 0) return out;
  try {
    const resolved = await keycloak.resolveUsers([...ids]);
    for (const [sub, u] of Object.entries(resolved)) {
      const name = u.name?.trim() || u.email?.trim() || '';
      if (name) out.set(sub, name);
    }
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'keycloak',
      method: 'GET',
      path: '/admin/realms/{realm}/users/{id}',
      degradedTo:
        'empty name map — every activity row keeps its raw actor UUID and the feed still renders',
    });
    return out;
  }
  return out;
}
