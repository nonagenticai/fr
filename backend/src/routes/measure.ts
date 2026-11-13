// GET /api/measure?stream=<streamId>&window=<24h|7d|30d|90d>
//
// The T/I/OE measurement lens (control-plane roadmap Phase 7). One
// compose-endpoint that joins reads already in the codebase — it adds NO new
// upstream service and NO schema change:
//
//   • Inventory   — per-list non-DONE card counts on the stream's Planka
//                   board(s), bucketed by AA phase (READYING/DOING/INSPECTING)
//                   plus a BLOCKED side-count. Source: the same streams →
//                   lists → cards walk the operator dashboard uses
//                   (routes/dashboard.ts), minus the assignee filter.
//   • Throughput  — distinct cards that reached PUBLISHING (a DONE-family
//                   list) within the window, counted from Planka's own board
//                   action log (moveCard → DONE). fr never asks n8n for this:
//                   the lifecycle runs inside n8n and writes results to Planka
//                   (the blackboard); throughput is reconstructable from Planka
//                   alone — same decoupling as the Phase-6 phase journey.
//   • Operating-  — LLM tokens + USD cost over the window from the
//     Expense       analytics_rollups table (the same rows the /measure
//                   analytics KPIs read), plus a count of approval decisions
//                   made in the window (a proxy for human-review effort).
//
// A constraint call-out names the most-loaded WIP phase (or BLOCKED) — keeping
// T/I/OE a *measurement* lens, not a separate accounting loop (roadmap §6, READYING_REDESIGN Q9).
//
// Honest scope limits (degrade, don't fake):
//   • OE is tenant-scoped, not per-stream: analytics_rollups keys on the fr
//     project_id, which has no clean stream→project mapping, so cost/tokens
//     reflect the whole workspace regardless of the stream selector.
//   • Per-PHASE OE is NOT available — it would need phase-tagged executions,
//     which don't exist (n8n executions never carry a card_id; see the
//     Phase-6 correction). Surfaced as a single workspace figure.
//   • Throughput reads a bounded number of board-action pages; an extremely
//     busy board could under-count older moves in a long window.

import { and, eq, gte, isNull, sql } from 'drizzle-orm';

import { db } from '../db/client';
import {
  analyticsRollups,
  approvals,
  approvalDecisions,
  streams,
} from '../db/schema';
import { validateAuth } from '../middleware/auth';
import { isSuperAdmin } from '../lib/super-admin-gate';
import { ctxTenantId } from '../middleware/request-context';
import { UnauthorizedError } from '../utils/errors';
import { jsonResponse } from '../utils/response';
import { countCardsByList } from '../integrations/kanban';
import { findHumanOverrideCardIds, findHumanOverrideCardIdsOnBoard } from '../services/computed-checks';
import { plankaClient } from '../services/planka';
import type { PlankaClient } from '../services/planka';
import {
  type Phase,
  WIP_PHASES,
  phaseFromListName,
  isBlocked,
} from '../lib/phase';

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const WINDOWS = ['24h', '7d', '30d', '90d'] as const;
type Window = (typeof WINDOWS)[number];

const WINDOW_SECONDS: Record<Window, number> = {
  '24h': 86_400,
  '7d': 604_800,
  '30d': 2_592_000,
  '90d': 7_776_000,
};

function parseWindow(raw: string | null): Window {
  return (WINDOWS as readonly string[]).includes(raw ?? '')
    ? (raw as Window)
    : '7d';
}

function windowStart(window: Window): Date {
  return new Date(Date.now() - WINDOW_SECONDS[window] * 1000);
}

/** Cap on board-action pages walked per board (see throughput scope note). */
const MAX_ACTION_PAGES = 10;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

interface ListCount {
  listName: string;
  count: number;
  /**
   * false ⇒ `count` is a LOWER BOUND, because the list holds more cards than
   * the count walk was budgeted to read. See `integrations/kanban.countCardsByList`.
   */
  complete: boolean;
}

interface InventoryAgg {
  /** WIP counts for the three non-DONE phases. */
  by_phase: Record<'READYING' | 'DOING' | 'INSPECTING', number>;
  /** Cards parked on a BLOCKED list (side-flag, not a phase). */
  blocked: number;
  /** Sum of the three WIP phases (excludes DONE and BLOCKED). */
  total: number;
  /** Current cards on a DONE-family list — context, not WIP. */
  done_current: number;
  /**
   * false ⇒ at least one contributing list was truncated, so EVERY number
   * above is a lower bound. Mirrors `throughput.complete`: the caller must be
   * able to tell "12 cards" from "at least 12 cards".
   */
  complete: boolean;
}

interface Constraint {
  phase: Phase | null;
  wip: number;
  reason: string;
}

/** Minimal Planka action shape we read (mirrors routes/cards/get.ts). */
interface RawAction {
  id: string;
  type: string;
  cardId?: string | null;
  createdAt?: string | null;
  data?: {
    toList?: { name?: string | null } | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Pure aggregation helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Fold per-list card counts into the inventory buckets. BLOCKED lists are
 * counted into `blocked` (they don't map to a phase); everything else is
 * bucketed by `phaseFromListName`. DONE/PUBLISHING is reported as
 * `done_current` and excluded from the WIP `total`.
 */
export function aggregateInventory(lists: ListCount[]): InventoryAgg {
  const by_phase = { READYING: 0, DOING: 0, INSPECTING: 0 };
  let blocked = 0;
  let done_current = 0;
  // ⚠️ Only lists that CONTRIBUTE can make the answer partial. A truncated list
  // outside the AA pipeline is discarded below, and letting it flip this flag
  // would mark every board partial for a number it never touched — a false
  // "partial" is its own species of misreport.
  let complete = true;
  for (const { listName, count, contributesIncomplete } of lists.map((l) => ({
    ...l,
    contributesIncomplete: !l.complete,
  }))) {
    if (isBlocked(listName)) {
      blocked += count;
      if (contributesIncomplete) complete = false;
      continue;
    }
    const phase = phaseFromListName(listName);
    if (phase === 'PUBLISHING') {
      done_current += count;
      if (contributesIncomplete) complete = false;
    } else if (phase && phase in by_phase) {
      by_phase[phase as 'READYING' | 'DOING' | 'INSPECTING'] += count;
      if (contributesIncomplete) complete = false;
    }
    // lists outside the AA pipeline (phase === null, not blocked) are ignored
  }
  return {
    by_phase,
    blocked,
    total: by_phase.READYING + by_phase.DOING + by_phase.INSPECTING,
    done_current,
    complete,
  };
}

/**
 * Count DISTINCT cards moved into a PUBLISHING-family list at or after
 * `windowStartMs`, from a flat list of board actions. Dedupe is by cardId so
 * a card bounced in/out of DONE counts once; actions lacking a cardId fall
 * back to the action id (still counted once).
 */
export function countThroughput(
  actions: RawAction[],
  windowStartMs: number,
  /**
   * Break-glass DONE cards (`done_kind: 'human_override'`, card_done_overrides). Recorded,
   * never scored: a card in this set never counts as throughput (liveness-DONE design #7).
   */
  excludeCardIds: ReadonlySet<string> = new Set(),
): number {
  const reached = new Set<string>();
  for (const a of actions) {
    if (a.type !== 'moveCard') continue;
    const tMs = a.createdAt ? Date.parse(a.createdAt) : NaN;
    if (!Number.isFinite(tMs) || tMs < windowStartMs) continue;
    if (a.cardId && excludeCardIds.has(a.cardId)) continue;
    if (phaseFromListName(a.data?.toList?.name ?? null) === 'PUBLISHING') {
      reached.add(a.cardId ?? a.id);
    }
  }
  return reached.size;
}

/** Card ids that moved into a PUBLISHING list in the window — the override lookup's input. */
export function throughputCandidateCardIds(actions: RawAction[], windowStartMs: number): string[] {
  const ids = new Set<string>();
  for (const a of actions) {
    if (a.type !== 'moveCard' || !a.cardId) continue;
    const tMs = a.createdAt ? Date.parse(a.createdAt) : NaN;
    if (!Number.isFinite(tMs) || tMs < windowStartMs) continue;
    if (phaseFromListName(a.data?.toList?.name ?? null) === 'PUBLISHING') ids.add(a.cardId);
  }
  return [...ids];
}

/**
 * Throughput minus break-glass DONE cards. A failed override lookup is reported, never
 * ignored: the count would otherwise include human overrides.
 */
async function countThroughputExcludingOverrides(
  actions: RawAction[],
  windowStartMs: number,
): Promise<number | null> {
  try {
    const excluded = await findHumanOverrideCardIds(throughputCandidateCardIds(actions, windowStartMs));
    return countThroughput(actions, windowStartMs, excluded);
  } catch (err) {
    console.warn('[measure] break-glass override lookup failed; throughput UNKNOWN', err);
    return null;
  }
}

/**
 * Identify the bottleneck. BLOCKED cards dominate (an engaged andon is the
 * constraint by definition); otherwise the WIP phase holding the most cards
 * is the likely constraint. Returns null on an empty board.
 */
export function pickConstraint(inv: InventoryAgg): Constraint | null {
  if (inv.blocked > 0) {
    return {
      phase: null,
      wip: inv.blocked,
      reason: `${inv.blocked} card(s) BLOCKED — clear the andon before pushing more work`,
    };
  }
  if (inv.total === 0) return null;
  let top: Phase | null = null;
  let max = -1;
  for (const p of WIP_PHASES) {
    const n = inv.by_phase[p as 'READYING' | 'DOING' | 'INSPECTING'];
    if (n > max) {
      max = n;
      top = p;
    }
  }
  if (!top || max <= 0) return null;
  return {
    phase: top,
    wip: max,
    reason: `${top} holds the most work-in-progress (${max}) — the likely constraint`,
  };
}

// ---------------------------------------------------------------------------
// Planka reads (I/O) — best-effort PER LIST, but a total failure is reported
// ---------------------------------------------------------------------------

// This function used to swallow every failure and return `[]`, which defeated
// the caller's own `meta.degraded` flag: the outer catch at the call site can
// only count a stream as degraded if something is thrown at it. From
// 2026-04-24 to #848 every `listCardsByList` call 401'd, so this returned an
// empty array for every board and `/api/measure` answered with all-zero
// inventory and `degraded: false` — the flag was armed and unreachable for the
// exact failure it existed to report.
//
// The per-list tolerance is kept: one bad list among many must not blank the
// board. What is no longer tolerated is reading NOTHING and calling it zero.
async function loadBoardListCounts(
  planka: PlankaClient,
  boardId: string,
): Promise<ListCount[]> {
  // Not caught: a board whose list index cannot be read yields no counts at
  // all, so returning [] here is the same lie in miniature.
  const lists = await planka.lists.listByBoard(boardId);
  const out: ListCount[] = [];
  let attempted = 0;
  let failed = 0;
  let firstError: unknown;
  for (const l of lists) {
    const name = (l.name ?? '').trim();
    if (!name) continue;
    attempted++;
    try {
      // ⚠️ `countCardsByList`, NOT `listCardsByList(...).items.length`. The
      // latter is ONE 50-card page of a cursor-paginated endpoint, so this
      // reported "50" for a list of 2,842 and called it the inventory. The
      // `complete` flag travels all the way to `meta.inventory_complete`.
      const cards = await countCardsByList(l.id);
      out.push({ listName: name, count: cards.count, complete: cards.complete });
    } catch (err) {
      // One bad list must not blank the whole board — but it must not vanish
      // either. ⛔ A skipped list is a SECOND, different reason the published
      // inventory is not the whole inventory: it is smaller than the truth by
      // an amount nobody measured. Contributing a `count: 0, complete: false`
      // row carries exactly that and nothing more — it adds no cards, and it
      // makes the aggregate say "at least". Before this the row was dropped
      // silently and `complete` stayed true, so a partially-unreadable board
      // published an exact-looking number.
      failed++;
      firstError ??= err;
      out.push({ listName: name, count: 0, complete: false });
    }
  }
  if (attempted > 0 && failed === attempted) throw firstError;
  await subtractHumanOverridesFromDone(planka, boardId, lists, out);
  if (failed > 0) {
    console.warn(
      `[measure] partial list read on board ${boardId}: ${failed}/${attempted} card reads failed`,
    );
  }
  return out;
}

/**
 * ⛔ A break-glass DONE (`done_kind: 'human_override'`) is NOT done work. `done_current` is a
 * COUNT read, so the override cards recorded on this board are located (one Planka card read
 * each — overrides are rare by construction) and subtracted from the DONE-family list they sit
 * in. Any failure marks those lists `complete: false` rather than silently overcounting.
 */
async function subtractHumanOverridesFromDone(
  planka: PlankaClient,
  boardId: string,
  lists: { id: string; name?: string | null }[],
  out: ListCount[],
): Promise<void> {
  const doneListNames = new Map<string, string>();
  for (const l of lists) {
    const name = (l.name ?? '').trim();
    if (name && phaseFromListName(name) === 'PUBLISHING') doneListNames.set(l.id, name);
  }
  if (doneListNames.size === 0) return;
  const markIncomplete = () => {
    for (const row of out) if (phaseFromListName(row.listName) === 'PUBLISHING') row.complete = false;
  };
  try {
    for (const cardId of await findHumanOverrideCardIdsOnBoard(boardId)) {
      const card = await planka.cards.get(cardId);
      const listName = doneListNames.get(card.item.listId);
      if (!listName) continue;
      const row = out.find((r) => r.listName === listName);
      if (row && row.count > 0) row.count -= 1;
    }
  } catch (err) {
    console.warn(`[measure] board ${boardId}: break-glass override subtraction failed`, err);
    markIncomplete();
  }
}

/**
 * A board's throughput, and whether we actually managed to read it.
 *
 * `value: null` means the walk never got a single page — we know NOTHING about
 * this board's throughput. That is categorically different from `value: 0`,
 * which means we read the actions and none of them crossed into PUBLISHING.
 * `complete: false` with a non-null value means the walk started and then broke
 * off, so the number is real but an UNDERCOUNT.
 *
 * Until this type existed all three cases collapsed to the number `0`, and a
 * total Planka outage was reported to the UI as an idle board — the same
 * confident zero that hid a four-month credential outage in the sibling
 * readers (#912). The `catch { break }` this replaces is why the caller's
 * `partial_streams` and `degraded` could never see an actions-endpoint failure.
 */
interface BoardThroughput {
  value: number | null;
  complete: boolean;
}

async function loadBoardThroughput(
  planka: PlankaClient,
  boardId: string,
  windowStartMs: number,
): Promise<BoardThroughput> {
  const collected: RawAction[] = [];
  let beforeId: string | undefined;
  let lastCursor: string | undefined;
  for (let page = 0; page < MAX_ACTION_PAGES; page++) {
    const path = `/api/boards/${encodeURIComponent(boardId)}/actions${
      beforeId ? `?beforeId=${encodeURIComponent(beforeId)}` : ''
    }`;
    let res: { items?: RawAction[] } | RawAction[];
    try {
      res = (await planka.http.request('GET', path, {})) as
        | { items?: RawAction[] }
        | RawAction[];
    } catch (err) {
      // Page 0 failing means we read nothing at all: report "unknown", never 0.
      // A later page failing means the count so far is real but truncated.
      console.warn(
        `[measure] board ${boardId}: actions read failed on page ${page}; ` +
          `throughput is ${page === 0 ? 'UNKNOWN' : 'an undercount'}`,
        err,
      );
      return page === 0
        ? { value: null, complete: false }
        : { value: await countThroughputExcludingOverrides(collected, windowStartMs), complete: false };
    }
    const items = Array.isArray(res) ? res : (res.items ?? []);
    if (items.length === 0) break;
    collected.push(...items);
    // Stop once this page's oldest action predates the window.
    let oldestMs = Infinity;
    for (const a of items) {
      const tMs = a.createdAt ? Date.parse(a.createdAt) : NaN;
      if (Number.isFinite(tMs)) oldestMs = Math.min(oldestMs, tMs);
    }
    if (oldestMs < windowStartMs) break;
    const next = items[items.length - 1]?.id;
    if (!next || next === lastCursor) break; // no-progress guard
    lastCursor = next;
    beforeId = next;
  }
  const value = await countThroughputExcludingOverrides(collected, windowStartMs);
  return { value, complete: value !== null };
}

// ---------------------------------------------------------------------------
// DB reads (OE)
// ---------------------------------------------------------------------------

/**
 * What the grouped rollup read can tell us about ONE metric.
 *
 * `null` ⇒ UNKNOWN: `analytics_rollups` holds no row for this metric in this
 * window, so nobody ever measured it. A number ⇒ measured, and `0` is then a
 * genuine zero.
 */
export interface OperatingExpenseRollup {
  tokens: number | null;
  cost_usd: number | null;
}

/**
 * Fold the grouped `SUM(value) GROUP BY metric_name` rows into per-metric
 * answers that distinguish ZERO from UNKNOWN.
 *
 * ⭐ THE DISCRIMINATOR NEEDS NO EXTRA QUERY, which is what makes it shippable.
 * `GROUP BY metric_name` emits a row for a metric ONLY if that metric has
 * rollup rows in the window. So:
 *   • metric ABSENT from these rows  ⇒ nothing was ever written ⇒ UNKNOWN
 *   • row PRESENT whose SUM is 0     ⇒ we measured, and it is a real ZERO
 *
 * ⛔ The seed is `null`, not `0`. It used to be `0`, and the loop below only
 * ever OVERWROTE it — so a window with no rollup rows at all returned `0` and
 * `/measure` rendered `$0.00 · 0 tokens`, indistinguishable from a workspace
 * that genuinely spent nothing. That is not a hypothetical state: the rollup
 * worker writes NOTHING when Prometheus returns no series
 * (`workers/analytics-rollup.ts`, the `promSeries === 0` "upstream slice has
 * not landed" path), which is exactly the fr whose metering counters are not
 * wired yet.
 *
 * ⛔ The two metrics are folded SEPARATELY and must stay that way. They are
 * independent rows: tokens can be written while cost is not. A single shared
 * "we saw nothing" flag would report a known token count as unknown, or print
 * a `0` for a cost nobody measured — the same conflation one level down.
 */
export function foldOperatingExpenseRollups(
  rows: ReadonlyArray<{ metric: string; total: string | number | null }>,
): OperatingExpenseRollup {
  // A row exists ⇒ this metric WAS measured, so `'0'` becomes 0 and STAYS 0:
  // the presence of the row is the authority, not the truthiness of the sum.
  // What is not honoured is a sum that is not a measurement — ⚠️ a bare
  // `Number()` turns BOTH `null` and `''` into 0, which would re-create the
  // exact invented zero this function exists to remove, so they are screened
  // out before the conversion and stay UNKNOWN.
  const measured = (raw: string | number | null): number | null => {
    const n =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
          ? Number(raw)
          : NaN;
    return Number.isFinite(n) ? n : null;
  };

  const out: OperatingExpenseRollup = { tokens: null, cost_usd: null };
  for (const r of rows) {
    // Two separate assignments, deliberately: see the note above. A row for one
    // metric must never answer for the other.
    if (r.metric === 'tokens') out.tokens = measured(r.total);
    else if (r.metric === 'cost_usd') out.cost_usd = measured(r.total);
  }
  return out;
}

async function loadOperatingExpense(
  tenantId: string,
  start: Date,
): Promise<{
  /** `null` ⇒ no rollup row for this metric in this window: UNKNOWN, not 0. */
  tokens: number | null;
  /** `null` ⇒ no rollup row for this metric in this window: UNKNOWN, not 0. */
  cost_usd: number | null;
  /** A `COUNT(*)` always has an answer, so this is never widened to null. */
  approvals_decided: number;
}> {
  // Tokens + USD from the tenant-wide (project_id NULL) analytics rollups.
  const rollupRows = await db
    .select({
      metric: analyticsRollups.metric_name,
      total: sql<string>`SUM(${analyticsRollups.value})::text`,
    })
    .from(analyticsRollups)
    .where(
      and(
        eq(analyticsRollups.tenant_id, tenantId),
        isNull(analyticsRollups.project_id),
        gte(analyticsRollups.bucket_ts, start),
        sql`${analyticsRollups.metric_name} IN ('tokens', 'cost_usd')`,
      ),
    )
    .groupBy(analyticsRollups.metric_name);

  const { tokens, cost_usd } = foldOperatingExpenseRollups(rollupRows);

  // Human-review activity: approval decisions made in the window.
  const decisionRows = await db
    .select({ c: sql<string>`COUNT(*)::text` })
    .from(approvalDecisions)
    .innerJoin(approvals, eq(approvals.id, approvalDecisions.approval_id))
    .where(
      and(
        eq(approvals.tenant_id, tenantId),
        gte(approvalDecisions.decided_at, start),
      ),
    );
  const approvals_decided = Number(decisionRows[0]?.c ?? 0);

  return { tokens, cost_usd, approvals_decided };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function authErrorToResponse(e: unknown): Response {
  const code = (e as { code?: string }).code;
  const isJoseAuthError = typeof code === 'string' && code.startsWith('ERR_JWT_');
  if (e instanceof UnauthorizedError || isJoseAuthError) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  throw e;
}

export async function handleGetMeasure(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    return authErrorToResponse(e);
  }

  const url = new URL(req.url);
  const window = parseWindow(url.searchParams.get('window'));
  const streamFilter = url.searchParams.get('stream');
  const tenantId = ctxTenantId(user.tenantId);
  const start = windowStart(window);

  // All active streams (for the selector); then scope the heavy walk.
  const allStreams = await db
    .select({
      id: streams.id,
      name: streams.name,
      planka_board_id: streams.planka_board_id,
    })
    .from(streams)
    .where(and(eq(streams.tenant_id, tenantId), eq(streams.is_active, true)));

  const inScope =
    streamFilter && streamFilter !== 'all'
      ? allStreams.filter((s) => s.id === streamFilter)
      : allStreams;

  const planka = plankaClient.asAgent();
  const windowStartMs = start.getTime();

  const allListCounts: ListCount[] = [];
  let throughput = 0;
  // Any stream whose answer is less than fully trustworthy — a failed list read
  // OR a failed/truncated throughput read. Drives `degraded`.
  let partialStreams = 0;
  // The strictly narrower case: a stream that yielded NOTHING usable, i.e. its
  // inventory read failed. Only this drives the hard rethrow below.
  let unusableStreams = 0;
  // Streams that produced a throughput number at all (complete or truncated).
  let throughputStreams = 0;

  let boardStreams = 0;
  let firstStreamError: unknown;

  // The two reads are issued SEPARATELY on purpose. They were a single
  // `Promise.all` inside one try/catch, which meant a failure of either one
  // discarded the other's result. An actions-endpoint outage would then throw
  // away a perfectly good inventory reading and answer 502 with no data —
  // strictly worse for the caller than reporting the inventory and admitting
  // the throughput is unknown.
  for (const stream of inScope) {
    if (!stream.planka_board_id) continue;
    boardStreams++;

    // `allSettled`, not two sequential awaits: the two reads must fail
    // INDEPENDENTLY (that is the fix) but they were also PARALLEL before, and
    // serialising them would double this loop's wall-clock across every stream
    // for no benefit. allSettled buys the independence without paying that.
    const [listRes, tpRes] = await Promise.allSettled([
      loadBoardListCounts(planka, stream.planka_board_id),
      loadBoardThroughput(planka, stream.planka_board_id, windowStartMs),
    ]);

    let listCounts: ListCount[] | null = null;
    if (listRes.status === 'fulfilled') listCounts = listRes.value;
    else firstStreamError ??= listRes.reason;

    // NOTE: this rejected branch is UNREACHABLE today — loadBoardThroughput
    // handles its own read errors and returns rather than throws, so no test
    // can kill it and none pretends to. It is kept so that a future edit which
    // does let an error escape cannot turn it back into a silent zero.
    let tp: BoardThroughput = { value: null, complete: false };
    if (tpRes.status === 'fulfilled') tp = tpRes.value;
    else firstStreamError ??= tpRes.reason;

    if (listCounts !== null) allListCounts.push(...listCounts);
    if (tp.value !== null) {
      throughput += tp.value;
      throughputStreams++;
    }

    if (listCounts === null) unusableStreams += 1;
    if (listCounts === null || !tp.complete) partialStreams += 1;
  }

  // `degraded: true` on EVERY stream is not a degraded answer, it is a failed
  // one: inventory, throughput and the constraint would all be zero and a
  // caller cannot tell that from a genuinely idle board. Rethrow the captured
  // cause rather than a synthesised code, so a Planka credential failure
  // surfaces as UPSTREAM_UNAUTHORIZED (502) and a timeout as UPSTREAM_TIMEOUT
  // (504) — handleError converts an escaping IntegrationError since #908.
  //
  // The predicate is `unusableStreams`, NOT `partialStreams`: throughput is now
  // allowed to fail on its own, and a throughput-only outage must not escalate
  // an answer that still carries real inventory into a 502 carrying nothing.
  // While throughput could not fail independently these two counters were the
  // same number, so this preserves the pre-existing behaviour exactly.
  if (boardStreams > 0 && unusableStreams === boardStreams) throw firstStreamError;

  const inventory = aggregateInventory(allListCounts);
  const loadedOe = await loadOperatingExpense(tenantId, start);
  // `analytics_rollups.cost_usd` is INCURRED cost (metering's
  // `metering_cost_event_cost_usd_total`, provider price, pre-markup). This is
  // an operations lens, not a bill — the tenant's billed figures live on
  // /settings/usage — so the incurred number is withheld from anyone who is not
  // a super-admin rather than re-derived per window. `null` is the documented
  // "unavailable" state every renderer already handles.
  const oe = isSuperAdmin(user) ? loadedOe : { ...loadedOe, cost_usd: null };
  const constraint = pickConstraint(inventory);

  return jsonResponse({
    data: {
      window,
      stream: streamFilter && streamFilter !== 'all' ? streamFilter : null,
      streams: allStreams.map((s) => ({ id: s.id, name: s.name })),
      inventory,
      // `null`, never 0, when not one board yielded a throughput number: the
      // caller must be able to tell "we could not read this" from "nothing
      // moved". Renderers are expected to show it as unavailable.
      throughput: {
        to_done: boardStreams > 0 && throughputStreams === 0 ? null : throughput,
        window,
      },
      // Same rule as `throughput.to_done` above, applied PER METRIC:
      // `tokens`/`cost_usd` are `null`, never 0, when `analytics_rollups` holds
      // no row for that metric in this window — the caller must be able to tell
      // "nobody measured this" from "we measured, and it was zero". That state
      // is the normal one on an fr whose metering counters have not landed:
      // `workers/analytics-rollup.ts` writes NOTHING for a tick where
      // Prometheus returned no series (`promSeries === 0`). `approvals_decided`
      // is a COUNT(*) and always has an answer, so it stays a plain number.
      // Renderers are expected to show a null as unavailable, with no currency.
      oe,
      constraint,
    },
    meta: {
      stream_count: inScope.length,
      partial_streams: partialStreams,
      degraded: partialStreams > 0,
      throughput_complete: boardStreams === 0 || throughputStreams === boardStreams,
      // false ⇒ at least one list that FEEDS the inventory held more cards than
      // the count walk read, so every `inventory.*` number is a lower bound.
      // Before this existed the numbers were capped at Planka's 50-card page
      // and reported as exact, so there was no flag to raise and no way for a
      // renderer to say "at least".
      inventory_complete: inventory.complete,
    },
  });
}
