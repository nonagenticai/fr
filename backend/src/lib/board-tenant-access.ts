// src/lib/board-tenant-access.ts
//
// Tenant-scoped authorization for reaching Planka board contents through the
// admin agent client — a READ gate and a WRITE gate, deliberately different.
//
// ⭐ THE READ/WRITE SPLIT, AND WHY IT IS NOT ONE PREDICATE. The read gate
// (`assertBoardTenantAuthorized`) allows a PLATFORM caller (14d-2: never a
// customer) onto a board owned by a platform tenant, because the stakeholder who must READ an
// AA / framework board is by construction never in the reserved tenant that
// owns it. That allow is correct for reads and WRONG for writes: handed to a
// write that runs as the admin agent, it lets any authenticated user in any
// tenant mutate membership on every internal-tenant board in the estate
// (12 of them, measured live). So the write gate
// (`assertBoardTenantWritable` / `assertCardTenantWritable`) is the same
// boundary MINUS that one branch. Everything else is shared code, not a copy.
//
// Why this exists
// ---------------
// fr acts in Planka as ONE configured account (George 2026-10-10: Planka use is
// per tenant, not per user), so Planka's own board membership never limits an
// fr caller. Every kanban route (routes/kanban/*) therefore gates by TENANT here
// BEFORE it touches Planka.
//
// This mirrors the production `/api/cards/:id` handler (routes/cards/get.ts):
// read with the ADMIN agent (bypassing Planka's board-membership check) and let
// FR gate by TENANT itself — a board's contents are readable iff the caller's
// active tenant owns the board (or it is an internal/system framework board).
// This is the SAME boundary handleListBoards already uses to decide which boards
// a user may see, so it grants no visibility beyond the board list.
//
// `resolveBoardTenant` is the single source of truth for board→tenant; the
// sibling read/write routes under routes/cards/ delegate to it so read and write
// agree on which tenant owns a board.

import { eq } from 'drizzle-orm';
import { db as defaultDb, projects, departments, streams } from '../db/client';
import {
  tryGetRequestContext,
  ctxTenantId,
  tryCtxTenantId,
} from '../middleware/request-context';
import { plankaAsAgent } from '../services/planka/with-auth';
import { isSuperAdmin } from './super-admin-gate';
import {
  isInternalTenant,
  isPlatformTenant,
} from '../middleware/internal-tenant-only';
import { NotFoundError } from '../utils/errors';
import {
  reportBoardTenantGateRefusal,
  type BoardTenantGate,
} from './board-tenant-gate-metrics';

type DbHandle = typeof defaultDb;
type ScopeUser = { id?: string; tenantId: string; roles?: readonly string[] };

function trimmedNonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * ⭐ THE PROJECT OWNER RULE, in one copy (fr#1437 condition c). A project's
 * owning tenant is its department's `workspace_id`, else its
 * `project_data.keycloak_tenant_id` tag, else none — each trimmed, blank meaning
 * absent. `resolveBoardTenant` (card kinds) and the orchestrator binding's
 * `projectOwner` (project kinds) both call it, so one project cannot have two
 * owners depending on route class.
 *
 * Trimming / blank-as-absent is the only change from the earlier inline rule;
 * prod had 0 padded or blank tags and 0 projects with a dept (measured
 * 2026-10-05), so it moves no live result.
 */
export function projectOwnerTenant(row: {
  workspace_id?: string | null;
  project_data?: unknown;
}): string | null {
  const workspace = trimmedNonEmpty(row.workspace_id);
  if (workspace) return workspace;
  const data = row.project_data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return trimmedNonEmpty((data as { keycloak_tenant_id?: unknown }).keycloak_tenant_id);
}

/**
 * Resolve a Planka board's owning fr tenant, keyed on `planka_board_id`. A board
 * belongs to EITHER an fr **project** (task boards) or an fr **stream**
 * (improvement / AA framework boards) — the same two visibility lanes as
 * `handleListBoards`:
 *   - project: `projects.planka_board_id` → `projectOwnerTenant` (dept
 *     `workspace_id`, else `project_data.keycloak_tenant_id`).
 *   - stream:  `streams.planka_board_id` → `streams.tenant_id`.
 * Returns `null` only for boards fr does not own (ad-hoc Planka boards).
 */
export async function resolveBoardTenant(
  boardId: string,
  db: DbHandle = defaultDb,
): Promise<string | null> {
  const [projectRow] = await db
    .select({
      tenant_id: departments.workspace_id,
      project_data: projects.project_data,
    })
    .from(projects)
    .leftJoin(departments, eq(departments.id, projects.dept_id))
    .where(eq(projects.planka_board_id, boardId))
    .limit(1);
  if (projectRow) {
    const projectTenant = projectOwnerTenant({
      workspace_id: projectRow.tenant_id,
      project_data: projectRow.project_data,
    });
    if (projectTenant) return projectTenant;
  }

  const [streamRow] = await db
    .select({ tenant_id: streams.tenant_id })
    .from(streams)
    .where(eq(streams.planka_board_id, boardId))
    .limit(1);
  return streamRow?.tenant_id ?? null;
}

/**
 * The fr PROJECT whose board this is (`projects.planka_board_id`), or null for
 * a board fr holds no project for (a stream board, an ad-hoc Planka board).
 *
 * fr-agui SPEC §7.5: the tenant URLs `/kanban?board=` and `/cards/[id]`
 * redirect into the project shell, and the board → project step is resolved
 * HERE, server-side, beside `resolveBoardTenant` — the same column, so the two
 * agree on which project owns a board. It answers WHICH project; it grants
 * nothing. Every caller runs it only after its own tenant gate has passed.
 */
export async function resolveBoardProjectId(
  boardId: string,
  db: DbHandle = defaultDb,
): Promise<string | null> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.planka_board_id, boardId))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The two branches that allow a caller WITHOUT consulting the database — branch
 * 1 and branch 2 of `assertBoardTenantAuthorized` below, lifted out so the
 * card-keyed sibling (`assertCardTenantAuthorized`) decides them from the SAME
 * code rather than from a copy.
 *
 * ⛔ Do not inline a second copy into the card gate. The card gate must
 * short-circuit on exactly these conditions and BEFORE it dials Planka, and a
 * duplicated predicate is precisely the thing that rots apart from this one.
 *
 *   1. AUTH_BYPASS without a tenant-header override. The kanban unit tests run
 *      under AUTH_BYPASS with NO request context and NO DB, so the gate must
 *      not issue a query there — and, for the card gate, must not dial Planka
 *      either: the hermetic kanban route tests assert on Planka call
 *      POSITIONS, so an extra card read would make it red. A live header
 *      override (integration tests, the super-admin switcher) still runs the
 *      full gate.
 *   2. Super-admin home/default view (preserves the pre-fix handleGetBoard
 *      super-admin agent-read). Under a header override a super-admin is scoped
 *      to the switched tenant like everyone else.
 */
function tenantGateShortCircuits(user: ScopeUser): boolean {
  const ctx = tryGetRequestContext();
  const headerOverride =
    ctx?.activeTenantSource === 'header' &&
    !!ctx.tenantId &&
    ctx.tenantId !== user.tenantId;

  if (process.env.AUTH_BYPASS === 'true' && !headerOverride) return true;
  if (isSuperAdmin(user) && !headerOverride) return true;
  return false;
}

/**
 * The shared board decision, in ONE copy, parameterised by the single branch
 * that legitimately differs between reading a board and writing to it.
 *
 * ⛔ Do not split this into two sibling functions. Everything except the
 * `allowInternal` branch — the short-circuits, the active-tenant resolution,
 * the fail-CLOSED catch, the 404-never-403 shape — must stay identical between
 * the read gate and the write gate, and two copies is exactly how they drift.
 * (This module already says the same thing about the card-keyed sibling.)
 *
 * Branch order (each guards an existing test path):
 *   1-2. `tenantGateShortCircuits` above — AUTH_BYPASS, then super-admin.
 *   3. `allowInternal` only: an internal/system-owned board is allowed
 *      outright.
 *   4. Otherwise the board's owning tenant must be the caller's active tenant.
 */
/**
 * ⭐ THE READ PREDICATE, as a pure function (fr row 14d-2). The single place
 * that decides whether a caller whose ACTIVE tenant is `activeTenant` may READ
 * a card/board owned by `owningTenant`. `assertBoardTenant` (read side) and
 * `handleGetCard` (routes/cards/get.ts, which resolves the tenant through
 * `loadCardTenantByBoardId`) both call it, so the two read paths cannot drift.
 *
 *   - A PLATFORM-owned board/card (`isPlatformTenant`, the 6-tenant set) is
 *     readable by any PLATFORM caller and by nobody else. System/improvement
 *     data is never visible to a customer (owner ruling 2026-09-30;
 *     movies-13 14d-2 ruling 2026-10-04). Before 14d-2 this branch was
 *     `isInternalTenant(owning)` — the 4-tenant set — and allowed ANY caller,
 *     customers included.
 *   - Any other board/card: the owning tenant must BE the active tenant.
 *   - ⛔ Fail closed: an unresolved owner (`null`) is never readable.
 *
 * ⛔ Use the PLATFORM set (6), never `isInternalTenant` (4): the ruling names
 * the platform set explicitly, and the 4-set would keep EXEC (…0003) and the
 * conveyor tenant (019de842) cards unreachable to the other platform tenants.
 */
export function platformAwareTenantReadable(
  owningTenant: string | null | undefined,
  activeTenant: string | null | undefined,
): boolean {
  if (!owningTenant) return false;
  if (isPlatformTenant(owningTenant)) return isPlatformTenant(activeTenant);
  return owningTenant === activeTenant;
}

async function assertBoardTenant(
  user: ScopeUser,
  boardId: string,
  db: DbHandle,
  { allowInternal, gate }: { allowInternal: boolean; gate: BoardTenantGate },
): Promise<void> {
  if (tenantGateShortCircuits(user)) return;

  const activeTenant = ctxTenantId(user.tenantId);

  let owningTenant: string | null;
  try {
    owningTenant = await resolveBoardTenant(boardId, db);
  } catch (err) {
    console.error('[board-tenant-access] tenant gate lookup failed', err);
    // An OUTAGE, not an authorization event — see the reason's docstring. The
    // gate still fails CLOSED on the next line; this only names why.
    reportBoardTenantGateRefusal({
      gate,
      reason: 'board_lookup_failed',
      boardId,
      activeTenant,
      userId: user.id,
    });
    throw new NotFoundError('Board not found');
  }

  // Read side: the shared platform-aware predicate (14d-2). Write side: the
  // owning tenant must be the active tenant, nothing else.
  if (allowInternal && platformAwareTenantReadable(owningTenant, activeTenant)) return;
  if (owningTenant && owningTenant === activeTenant) return;

  // ⭐ INSTRUMENT ONLY — the verdict is already decided above and is unchanged.
  // Both branches below are PURE READS of values the gate has already computed;
  // neither can allow or refuse anything. The `throw` is the same single throw
  // that was here before.
  //
  // ⭐ `internal_board_write` IS THE NEW POPULATION, EXACTLY. Reaching this
  // line with an internal owning tenant is only possible when `allowInternal`
  // is false: when it is true, the `allowInternal && isInternalTenant(...)`
  // branch two lines up has already returned. So this test does not need to
  // consult `allowInternal` at all, and it is not a heuristic — it is the
  // deleted branch, evaluated at the moment it would have fired. Everything
  // else here refused identically before #1136.
  reportBoardTenantGateRefusal({
    gate,
    reason: allowInternal && isPlatformTenant(owningTenant)
      ? // 14d-2: a PLATFORM-owned board read refused to a non-platform caller.
        // Only reachable on the read side (the write side never consults the
        // platform set), so it can never collide with `internal_board_write`.
        'platform_board_foreign_read'
      : !allowInternal && isInternalTenant(owningTenant ?? undefined)
      ? 'internal_board_write'
      : owningTenant
        ? 'tenant_mismatch'
        : 'board_tenant_unknown',
    boardId,
    owningTenant,
    activeTenant,
    userId: user.id,
  });
  throw new NotFoundError('Board not found');
}

/**
 * READ gate. Throw `NotFoundError('Board not found')` unless the caller may
 * agent-read the given board's contents. 404 (never 403) mirrors handleGetBoard
 * so we never leak which board ids exist across tenants; fail-closed on any
 * lookup error.
 *
 * ⭐ fr row 14d-2: the cross-tenant allow is now PLATFORM-to-PLATFORM only
 * (`platformAwareTenantReadable`). A customer (non-platform active tenant) is
 * refused every platform-owned board, 404, counted as
 * `platform_board_foreign_read`. Measured before the change: Planka members of
 * platform boards are service accounts only, and no non-platform board holds
 * platform cards (M-14d-2 §2-3), so no legitimate customer read is lost.
 *
 * ⛔ DO NOT remove the platform allow from this function to fix a WRITE
 * problem. `handleGetBoard` and `handleGetCard`
 * depend on it: AA / framework boards are owned by the reserved
 * `0195f48b-d000-7000-8000-*` tenants, and a human stakeholder reading one is
 * by construction in a DIFFERENT tenant. Narrowing this breaks every read of a
 * system board. The write side has its own predicate — `assertBoardTenantWritable`
 * below — precisely so that the two can differ without either being a
 * regression for the other.
 */
export async function assertBoardTenantAuthorized(
  user: ScopeUser,
  boardId: string,
  db: DbHandle = defaultDb,
): Promise<void> {
  return assertBoardTenant(user, boardId, db, {
    allowInternal: true,
    gate: 'board_read',
  });
}

/**
 * WRITE gate. The same boundary as `assertBoardTenantAuthorized`, MINUS the
 * internal-tenant allow — and that one missing branch is the whole point.
 *
 * ⭐ WHY A SECOND PREDICATE RATHER THAN REUSING THE READ GATE. Reading a system
 * board and mutating one are not the same permission. The read gate allows any
 * authenticated caller onto an internal/system-owned board on purpose, because
 * the stakeholder who needs to READ an AA board is never in the tenant that
 * owns it. Handing that same allow to a WRITE means every authenticated user in
 * any tenant may grant board/card membership on `__system_workflow__`,
 * `__system_prompt__`, `__system_procedure__` and the internal asset-authoring
 * streams — and, because these routes write with `plankaClient.asAgent()`, they
 * do it with the admin identity that passes Planka's own board-membership check
 * unconditionally. MEASURED before this gate existed: an ordinary `power-user`
 * in an unrelated tenant got `status=201` with
 * `["POST /api/access-tokens","GET /api/cards/<id>","POST /api/cards/<id>/card-memberships"]`
 * — the write landed.
 *
 * ⚠️ This does NOT lock internal automation out of its own boards. A caller
 * whose ACTIVE tenant *is* the owning internal tenant still passes on the
 * ordinary `owningTenant === activeTenant` branch; only a FOREIGN tenant loses
 * the allow. Board provisioning does not come through here at all — it calls
 * `agent.members.addBoardMember` directly (services/planka/intake.ts), below
 * the route layer and below this gate.
 *
 * The short-circuits are deliberately IDENTICAL to the read gate's
 * (`tenantGateShortCircuits`): AUTH_BYPASS without a header override, and
 * super-admin without a header override. A super-admin who has SWITCHED tenant
 * via `X-Active-Tenant` runs the full gate and is therefore scoped to the tenant
 * they switched into — same as for reads, and the correct answer here too: the
 * switcher exists to let a super-admin see the estate AS a tenant, so it must
 * not also grant that tenant a write onto a system board.
 */
export async function assertBoardTenantWritable(
  user: ScopeUser,
  boardId: string,
  db: DbHandle = defaultDb,
): Promise<void> {
  return assertBoardTenant(user, boardId, db, {
    allowInternal: false,
    gate: 'board_write',
  });
}

/**
 * The same boundary, keyed on a CARD. fr owns no card→tenant mapping — a card's
 * tenant is its BOARD's tenant — so this resolves the board through the admin
 * agent and then delegates, unchanged, to `assertBoardTenantAuthorized`.
 *
 * Reading the board id with the AGENT is deliberate and is not a privilege the
 * caller gains: the agent read happens inside the gate, its only output is a
 * board id the gate immediately judges, and the caller learns nothing from it
 * that the gate does not authorize. fr has no other Planka identity: it acts as
 * its one configured account (per tenant, not per user — George 2026-10-10).
 *
 * ⭐ FAIL-CLOSED, AND WHY 404 RATHER THAN THE UPSTREAM'S OWN STATUS.
 * If the card cannot be read at all — Planka 404s, 403s, 500s, times out, the
 * agent login fails, or the payload carries no `boardId` — there is no board,
 * therefore nothing to authorize, therefore no authorization to grant. Every
 * one of those collapses to `NotFoundError('Card not found')` and the caller
 * never reaches the write.
 *
 * ⛔ The tempting alternative — rethrowing the upstream status via
 * `toHttpError(err)` — is WRONG HERE: the read is the GATE. A Planka 500 is not "the caller may not do
 * this", it is "fr does not know", and an authorization check that propagates
 * "I do not know" as anything other than a refusal is fail-OPEN on the upstream
 * being sick. It is also the only shape that keeps a foreign card id
 * indistinguishable from one that does not exist — the same non-leak property
 * `assertBoardTenantAuthorized` maintains for boards.
 *
 * ⚠️ Deliberately NOT a swallow-and-continue: there is no `catch` that returns.
 * The single `throw` below is the only exit from the failure path, so this
 * cannot fall through to "allowed" by omission.
 */
export async function assertCardTenantAuthorized(
  user: ScopeUser,
  cardId: string,
  db: DbHandle = defaultDb,
): Promise<void> {
  // Before Planka, not after: under AUTH_BYPASS / super-admin-home the gate
  // allows outright, and dialling Planka to compute an answer that is already
  // decided would both cost a round trip and change the call shape every
  // hermetic kanban unit test asserts on.
  if (tenantGateShortCircuits(user)) return;
  const boardId = await resolveCardBoardOrRefuse(cardId, 'card_read');
  // Identical to `assertBoardTenantAuthorized(user, boardId, db)` — that
  // function's whole body is this call with `allowInternal: true`. Named
  // directly so the refusal is attributed to the CARD gate the caller actually
  // entered rather than to `board_read`; the decision is byte-for-byte the one
  // the delegation made, and there is still exactly one copy of it.
  await assertBoardTenant(user, boardId, db, {
    allowInternal: true,
    gate: 'card_read',
  });
}

/**
 * The card gate's Planka half, in one copy: resolve a card's board with the
 * admin agent, or refuse. Split out so the read and write card gates below
 * share the fail-CLOSED behaviour documented above rather than each carrying a
 * copy of the try/catch — the same reason `assertBoardTenant` is shared.
 */
export async function resolveCardBoardOrRefuse(
  cardId: string,
  gate: BoardTenantGate,
): Promise<string> {
  let boardId: string | undefined;
  try {
    const card = await plankaAsAgent().cards.get(cardId);
    boardId = card.item?.boardId;
  } catch (err) {
    console.error('[board-tenant-access] card gate board lookup failed', err);
    reportCardLookupRefusal(gate, cardId);
    throw new NotFoundError('Card not found');
  }
  // The payload-carried-no-boardId arm. Counted under the SAME reason as the
  // throwing arm on purpose: both mean "fr could not learn which board this
  // card is on", both fail closed, and both are an upstream fault rather than a
  // judgement about the caller.
  if (!boardId) {
    reportCardLookupRefusal(gate, cardId);
    throw new NotFoundError('Card not found');
  }
  return boardId;
}

/** One spelling of the card-lookup refusal, shared by the two arms above. */
function reportCardLookupRefusal(gate: BoardTenantGate, cardId: string): void {
  reportBoardTenantGateRefusal({
    gate,
    reason: 'card_lookup_failed',
    cardId,
    // `ctxTenantId` is deliberately NOT called here: it THROWS when there is no
    // frame and no fallback, and this path must never turn a 404 into a 500.
    activeTenant: tryCtxTenantId() ?? null,
  });
}

/**
 * WRITE gate, keyed on a CARD. Exactly `assertCardTenantAuthorized` with
 * `assertBoardTenantWritable` as the board decision — so a card on an
 * internal/system-owned board is NOT writable by a foreign tenant, while a
 * caller in the owning tenant is unaffected.
 *
 * Everything the read gate's docstring says about the agent card read, the
 * fail-CLOSED collapse to `NotFoundError('Card not found')`, and why the
 * upstream status is deliberately not propagated, applies here unchanged — the
 * Planka half is literally the same function.
 *
 * ⚠️ The call SHAPE is identical to the read gate's (agent login, then one
 * `GET /api/cards/:id`), which is what lets the refusal tests assert an exact
 * call list: the gate must read the card to learn the board, so "no write
 * reached Planka" is the property to assert, not "nothing reached Planka".
 */
export async function assertCardTenantWritable(
  user: ScopeUser,
  cardId: string,
  db: DbHandle = defaultDb,
): Promise<void> {
  if (tenantGateShortCircuits(user)) return;
  const boardId = await resolveCardBoardOrRefuse(cardId, 'card_write');
  // Identical to `assertBoardTenantWritable(user, boardId, db)` — see the note
  // in `assertCardTenantAuthorized`. Only the refusal's `gate` label differs.
  await assertBoardTenant(user, boardId, db, {
    allowInternal: false,
    gate: 'card_write',
  });
}

/**
 * The list half of the list-keyed write gate: resolve a list's board with the
 * agent (`GET /api/lists/:id`), or refuse. Fail-CLOSED exactly like the card
 * resolver — no board, nothing to authorize — and a foreign list id stays
 * indistinguishable from one that does not exist (404).
 */
export async function resolveListBoardOrRefuse(listId: string): Promise<string> {
  let boardId: string | undefined;
  try {
    boardId = (await plankaAsAgent().lists.get(listId)).boardId;
  } catch (err) {
    console.error('[board-tenant-access] list gate board lookup failed', err);
    throw new NotFoundError('List not found');
  }
  if (!boardId) throw new NotFoundError('List not found');
  return boardId;
}

/**
 * WRITE gate keyed on a LIST (POST /api/kanban/lists/:listId/cards): resolve the
 * list's board, then the same board decision as `assertBoardTenantWritable`.
 */
export async function assertListTenantWritable(
  user: ScopeUser,
  listId: string,
  db: DbHandle = defaultDb,
): Promise<void> {
  if (tenantGateShortCircuits(user)) return;
  const boardId = await resolveListBoardOrRefuse(listId);
  await assertBoardTenant(user, boardId, db, {
    allowInternal: false,
    gate: 'board_write',
  });
}

/**
 * fr row 14d-2: the READ gate as a boolean, for the per-hop ancestry check in
 * `GET /api/cards/:cardId/repository` (services/card-repository-resolution.ts).
 * Exactly `assertBoardTenantAuthorized`'s decision (same short-circuits, same
 * platform-aware predicate, same fail-CLOSED lookup), with the refusal counted
 * under `card_read`. A `NotFoundError` refusal becomes `false`; any other error
 * propagates (the walk treats a throw as a refusal too).
 */
export async function isBoardReadableByCaller(
  user: ScopeUser,
  boardId: string,
  db: DbHandle = defaultDb,
): Promise<boolean> {
  try {
    await assertBoardTenant(user, boardId, db, {
      allowInternal: true,
      gate: 'card_read',
    });
    return true;
  } catch (err) {
    if (err instanceof NotFoundError) return false;
    throw err;
  }
}
