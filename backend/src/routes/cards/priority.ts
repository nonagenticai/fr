// PATCH /api/projects/:projectId/cards/:cardId/priority
//
// ── HEADROOM NOTE (row 13a) ─────────────────────────────────────────────────
// Each effective write holds ONE pooled Postgres connection (pgbouncer,
// TRANSACTION pooling) plus this card's advisory lock for the length of its
// transaction, which spans Planka HTTP calls. The hold is bounded:
//   * SET LOCAL lock_timeout = 2s       — waiting for the card's lock (then 409
//                                         priority_write_busy, retryable);
//   * SET LOCAL statement_timeout = 10s — any one SQL statement (lock wait is
//                                         capped by the 2 s above);
//   * Planka under the lock: ONE attempt per call, 5 s AbortSignal timeout, no
//     GET retry, no 401 refresh-retry, and NO LOGIN (LOCKED_PLANKA_POLICY,
//     cachedTokenOnly). The token is checked/refreshed BEFORE the lock by a
//     normal-policy card read through the SAME PlankaAuth cache; if it is gone
//     by the time a locked call runs (a concurrent request invalidated it), the
//     call fails fast → 503 priority_planka_token_unavailable (retryable),
//     never a 10 s login under the lock. Group resolution also happens before it.
// Worst case per write, transaction 1 ≈ lock wait ≤ 2 s + Planka (1 read +
// 3 writes) ≤ 4 × 5 s + SQL (normally ms; each statement capped at 10 s) ≈ 22 s;
// a write that fails mid-way adds ≤ 3 restore writes × 5 s ≈ 15 s more, still
// under the lock (≈ 37 s). A failed COMMIT runs a SECOND locked transaction
// (resolveFailedCommit): lock wait ≤ 2 s + 1 read + ≤ 3 restore writes ≤ 4 × 5 s
// + SQL ≈ 22 s more. End to end the worst case is therefore ≈ 22 s (txn 1,
// whose writes all landed — a failed COMMIT only follows a complete write) +
// ≈ 22 s (txn 2) ≈ 44 s, holding ONE connection at a time (txn 1's is
// returned before txn 2 takes one). The typical write is ~4 Planka
// round-trips (tens of ms).
// Pool: fr pool_size = 12 (deployment
// clusters/prod/services/pgbouncer/pgbouncer.ini, `fr =` entry, 0a02f99c8),
// measured demand ~3 active / ~7 queued at peak. So a burst of N concurrent
// priority writes can pin N of 12 connections for up to ~22 s each.
// ⛔ REQUIREMENT: conveyor callers (ncn reprioritize routine 9d) write
// SEQUENTIALLY — concurrency 1. The server also enforces it: a conveyor
// identity (isConveyorActor) must take the ONE global `priority-conveyor`
// slot with pg_try_advisory_xact_lock and gets an immediate 409
// priority_write_busy, never a wait, if another conveyor write holds it.
//
// The edit door for a card's `Metadata.priority` (P0–P3, or `null` to clear).
// Ruling (George via coordinator, 2026-10-03): setting priority and backlog
// reprioritisation are part of the conveyor system — people and the
// conveyor's identities may both set it, under the project's ordinary edit
// rule. In order:
//
//   1. `validateAuth` (which also refuses the conveyor identity on every write
//      route but this one and PATCH /api/projects/:id — lib/conveyor-identity.ts);
//   2. the CONVEYOR (isConveyorActor: azp + username + realm role, all three)
//      must name a PLATFORM tenant in X-Tenant-Id, else 403
//      `conveyor_tenant_required` / `conveyor_tenant_forbidden`;
//   3. vocabulary (`parsePriorityWrite`, shared with PATCH /api/projects/:id):
//      400 `invalid_priority` before anything is read; the conveyor's `rule`
//      (A1 | A2 | B1 | B2) is REQUIRED (400 `conveyor_rule_required`), anyone
//      else's is refused (400 `conveyor_rule_not_accepted`); the conveyor
//      writing P0 → 403 `conveyor_p0_forbidden`;
//   4. access: the CONVEYOR loads the project by id within its platform tenant
//      regardless of owner (`loadProjectForConveyor`); everyone else keeps the
//      project PATCH's rule: `loadTenantScopedProject` (404 for an unknown /
//      cross-tenant id). P1-TEAM-a (George 2026-10-15): NO owner check — any
//      member of the project's tenant may set a card's priority; a super-admin
//      SWITCHED view keeps the owner pin (`projectWritableByCaller`);
//   5. the card must be on THIS project's Planka board (`planka_board_id`),
//      else 404 `card_not_found` — for the conveyor too;
//   6. BEFORE the transaction (no connection, no lock): a normal-policy card
//      read (token check/refresh + fast 404 for a foreign card) and board
//      group resolution — through the same client/auth cache the locked
//      calls use (withRequestPolicy shares PlankaAuth);
//   7. ONE transaction, in this order: SET LOCAL lock_timeout/statement_timeout
//      → (conveyor only) the global try-slot → take the per-card lock
//      (`pg_advisory_xact_lock(hashtext('card-priority:<cardId>'))`,
//      lib/priority-change.ts — transaction-scoped, never session-level:
//      pgbouncer is in transaction pooling) → read the card's current
//      Metadata.priority + provenance from Planka → (conveyor only) 409
//      `human_override` when the current set_by is human:/operator: → insert ONE
//      `priority_change_events` row (from = that value, to = the requested
//      value, priority_set_by = the stamp) → write the SERVER-STAMPED
//      provenance to Runtime State (`priority_set_by` = prioritySetBy(user,
//      rule), `priority_base` = priorityBaseAfter: the new value for a
//      person/operator, the PRIOR value on the conveyor's first write, kept on
//      its later writes) → write
//      Metadata.priority → COMMIT (releases the lock). Two concurrent PATCHes
//      on one card therefore chain (A→B then B→C), never fork (A→B, A→C).
//      Provenance first: a crash between the two leaves a fresh human/operator
//      stamp over an unchanged value — the conveyor stands off (safe) — never a
//      changed value under a stale `conveyor:` stamp. A failed audit insert
//      means Planka is never written. A failed Planka write restores every
//      field that LANDED (still under the lock) and rolls the audit back → 502.
//      LANDED = the write returned, OR its outcome is unknown: a network
//      failure/timeout with no answer, or a 2xx status line followed by a
//      failed body read (PlankaWriteOutcomeUnknownError) — never "not applied".
//      A failed COMMIT re-takes the lock and restores only if the card still
//      holds exactly what this request wrote — after first checking that OUR
//      audit row (id allocated before the insert, allocatePriorityEventId) is
//      absent (else the COMMIT did succeed: 200, nothing restored) and that no
//      newer change of this card was recorded since this request started
//      (else 409 priority_superseded,
//      nothing restored; covers A→B→A). If a restore itself fails (or is
//      unsafe), the state is uncertain: 500 `priority_compensation_failed`
//      naming the card, plus fr_priority_compensation_failed_total and an
//      error log tagged `[priority-compensation-failed]`
//      (lib/priority-compensation-metrics.ts). A no-op (from = to) writes
//      nothing — neither Planka, provenance, nor the audit.
//
// Body: `{ priority: <level name or id> | null }` (exactly that key) — one of
// the PROJECT tenant's RM priority levels (services/catalogue/priority-levels.ts);
// the conveyor sends `{ priority, rule }` (exactly those two).
// `priority_set_by` / `priority_base` (or any other key) → 400
// invalid_priority; a rule tag from anyone but the conveyor (`rule`,
// `conveyor_rule`, any `*rule*` key) → 400 conveyor_rule_not_accepted.
// Response 200: `{ card_id, priority, priority_level_id }` (priority = the
// level's legacy text written to Metadata.priority; the id is the value of
// record in priority_change_events).

import { z } from 'zod';

import { db } from '../../db/client';
import { validateAuth } from '../../middleware/auth';
import { loadProjectForConveyor, loadTenantScopedProject, projectWritableByCaller } from '../../lib/project-access';
import {
  BadRequestError,
  NotFoundError,
  clientSafePlankaErrorMessage,
} from '../../utils/errors';
import { jsonResponse } from '../../utils/response';
import { PlankaError, plankaWriteMayHaveApplied } from '../../services/planka/errors';
import {
  CARD_PRIORITY_BASE_FIELD,
  CARD_PRIORITY_FIELD,
  CARD_PRIORITY_SET_BY_FIELD,
  writeCardPriority,
  writeCardPriorityProvenance,
  type CardPriority,
} from '../../services/improvement-cards/card-priority';
import { warnBoardFieldMissing, type BoardFieldGroup } from '../../services/planka/custom-fields';
import {
  assertConveyorNotTopPriority,
  legacyPriorityText,
  levelForLegacyText,
  resolveTenantPriority,
} from '../../services/catalogue/priority-levels';
import type { PlankaClient } from '../../services/planka';
import {
  reportPriorityCompensationFailure,
  type PriorityCompensationPhase,
} from '../../lib/priority-compensation-metrics';
import {
  INVALID_PRIORITY,
  PRIORITY_LOCK_TIMEOUT,
  PRIORITY_PLANKA_TOKEN_UNAVAILABLE,
  PRIORITY_SUPERSEDED,
  PRIORITY_WRITE_BUSY,
  allocatePriorityEventId,
  assertNoHumanOverride,
  boundPriorityTransaction,
  conveyorTenantFromHeader,
  parseConveyorRule,
  priorityBaseAfter,
  isConveyorActor,
  isLockTimeout,
  newerPriorityChangeExists,
  pgCardPriorityLock,
  priorityEventExists,
  priorityTokenUnavailable,
  type PriorityPlankaTokenUnavailableError,
  type CardPriorityLock,
  parsePriorityWrite,
  prioritySetBy,
  priorityEventTenantId,
  recordPriorityChange,
  refuseRuleTag,
  storedPriority,
  tryConveyorPriorityLock,
} from '../../lib/priority-change';
import { projectCardPlankaAgent, projectCardResolveGroups } from './project';

const BodySchema = z.object({ priority: z.unknown() }).strict();
/** The conveyor's body: `priority` plus its REQUIRED rule tag, nothing else. */
const ConveyorBodySchema = z.object({ priority: z.unknown(), rule: z.unknown() }).strict();

interface CardDetailValues {
  item?: { boardId?: unknown } | null;
  included?: {
    customFieldValues?: Array<{
      cardId?: string;
      customFieldGroupId?: string;
      customFieldId?: string;
      content?: string | null;
    }>;
  };
}

function cardNotFound(cardId: string): Response {
  return jsonResponse(
    {
      error: 'card_not_found',
      message: "card not found on this project's board",
      card_id: cardId,
    },
    404,
  );
}

function planka502(error: string, err: PlankaError, cardId: string): Response {
  return jsonResponse(
    {
      error,
      message: clientSafePlankaErrorMessage(err, 'projects/cards/priority'),
      card_id: cardId,
    },
    502,
  );
}

/** Stable machine-readable code: the write failed AND its restore failed — state uncertain. */
const PRIORITY_COMPENSATION_FAILED = 'priority_compensation_failed';

export async function handlePatchProjectCardPriority(
  req: Request,
  projectId: string,
  cardId: string,
): Promise<Response> {
  const lock = pgCardPriorityLock;
  const user = await validateAuth(req);
  // The dedicated conveyor identity — evaluated FIRST, from the verified token.
  const conveyor = isConveyorActor(user);
  // The conveyor names its PLATFORM tenant in X-Tenant-Id (its token has no
  // tenant_id). 403 before the body is even read when it is missing or not a
  // platform tenant. Every other caller: the header is not read here.
  const conveyorTenant = conveyor ? conveyorTenantFromHeader(req) : null;

  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  // A rule tag is the conveyor's alone: anyone else gets its own code BEFORE
  // the strict schema's generic refusal; the conveyor MUST send a valid one.
  if (!conveyor) refuseRuleTag(raw);
  const rule = conveyor ? parseConveyorRule(raw) : undefined;
  const body = (conveyor ? ConveyorBodySchema : BodySchema).safeParse(raw);
  // `strict()` + `z.unknown()` would admit `{}`; a missing key is refused,
  // never read as a clear.
  if (!body.success || !('priority' in (raw as Record<string, unknown>))) {
    throw new BadRequestError(
      'body must be exactly { "priority": <priority level name or id> | null }',
    ).withCode(INVALID_PRIORITY);
  }
  const priorityInput = parsePriorityWrite(body.data.priority);

  // Access: the conveyor reaches any project of its platform tenant, regardless
  // of owner (loadProjectForConveyor — this route and the project PATCH only:
  // its SQL scope is `id = :id AND keycloak_tenant_id = X-Tenant-Id`, so an
  // untagged or other-tenant project is a 404 for it); everyone else keeps the
  // project PATCH's rule: tenant-scoped, any member of the caller's OWN tenant
  // (P1-TEAM-a). A caller acting OUTSIDE its own tenant (a super-admin switched
  // view) keeps the pre-P1-TEAM owner pin (`projectWritableByCaller`, the same
  // rule as the PATCH's `projectWriteSelfScope`): a non-owner gets the PATCH's 404.
  const project = conveyorTenant !== null
    ? await loadProjectForConveyor(db, conveyorTenant, projectId)
    : await loadTenantScopedProject(db, user, projectId);
  if (conveyorTenant === null && !projectWritableByCaller(user, project)) {
    throw new NotFoundError('Project not found');
  }
  // FAIL CLOSED before the lock (and the conveyor's try-slot) and any Planka
  // call, on EVERY path: an untagged project has no known tenant for its audit
  // row ⇒ 409 project_tenant_unknown, nothing written. The audit tenant is
  // ALWAYS the project's own tag (priorityEventTenantId) — for the conveyor it
  // must also equal the header tenant it was loaded under; a mismatch is the
  // same 404 the scope gives (defense-in-depth, unreachable through the scope).
  const projectTenant = priorityEventTenantId(project);
  if (conveyorTenant !== null && projectTenant !== conveyorTenant) throw new NotFoundError('Project not found');

  // The vocabulary is the PROJECT tenant's RM priority levels (Q3 = b): 400
  // invalid_priority outside them, 409 catalogue_not_initialised without any.
  // The conveyor never sets the highest level — refused before any Planka read.
  const { levels, level } = await resolveTenantPriority(projectTenant, priorityInput);
  assertConveyorNotTopPriority(user, levels, level);
  // Metadata.priority keeps the level's legacy TEXT (the template field n8n
  // sorts by); the id is recorded in the audit row.
  const priority: CardPriority | null = level ? legacyPriorityText(level) : null;
  const toLevelId = level?.id ?? null;

  const boardId = project.planka_board_id;
  if (!boardId) {
    return jsonResponse(
      {
        error: 'project_board_not_provisioned',
        message: 'this project has no Planka board yet',
        project_id: project.id,
      },
      409,
    );
  }

  const agent = projectCardPlankaAgent();

  // ── PRE-LOCK: nothing here holds a connection or a lock. ──────────────────
  // (1) The token check: an authenticated read with the client's NORMAL
  //     policy — a stale agent token 401s HERE and is re-minted by http.ts's
  //     refresh-once, so the single-attempt calls under the lock start with a
  //     token Planka just accepted. Also the fast 404 for a foreign card.
  const preDetail = await readCard(agent, cardId);
  if (preDetail instanceof Response) return preDetail;
  if (String(preDetail.item?.boardId ?? '') !== String(boardId)) return cardNotFound(cardId);
  // (2) Board group/field ids — READ-ONLY (never under the lock). A board
  //     whose RM template carries no Metadata.priority cannot take a priority:
  //     409 board_field_missing, nothing written (fr never creates the field).
  const groups = await resolveGroups(agent, boardId);
  if (!groups.metadata.fieldIds[CARD_PRIORITY_FIELD]) {
    warnBoardFieldMissing({ boardId, cardId, group: 'Metadata', field: CARD_PRIORITY_FIELD, context: 'cards.priority.patch' });
    return jsonResponse(
      {
        error: BOARD_FIELD_MISSING,
        message: `board ${boardId} has no Metadata.priority field (its RM board template defines none); nothing was written`,
        card_id: cardId,
      },
      409,
    );
  }
  const site = { boardId, context: 'cards.priority.patch' };

  // Every Planka call made while the lock is held: ONE attempt, 5 s.
  const locked = agent.withRequestPolicy(LOCKED_PLANKA_POLICY);
  // Fields whose Planka write SUCCEEDED, or timed out (may have applied) —
  // exactly what a compensation must restore. A write refused outright is
  // presumed not applied.
  const landed = new Set<string>();
  const recording = recordingPlanka(locked, landed);

  let prior: PriorState = { priority: null, setBy: null, base: null };
  let written: WrittenState | null = null;
  // The audit row id + this request's start mark (failed-COMMIT check).
  let event: { id: number; startedAt: string } | null = null;
  // True once the transaction callback returned: a throw after it is a COMMIT
  // failure (lock already released), a throw before it happened under the lock.
  let callbackDone = false;
  // Set when the restore under the lock (write path) itself failed.
  let writeCompensationError: { cause: unknown; compensationError: unknown } | null = null;
  try {
    const early = await db.transaction(async (tx): Promise<Response | null> => {
      // FIRST statements: bound this transaction's waits (SET LOCAL only).
      await boundPriorityTransaction(tx);
      // Conveyor concurrency 1, server-side: one global slot, never waited for.
      if (conveyor && !(await tryConveyorPriorityLock(tx))) {
        return writeBusy(cardId, 'another conveyor priority write is in progress');
      }
      // ── LOCK: everything below — read-current, audit, provenance, Planka
      // write, commit — runs while this card's lock is held. A wait beyond
      // PRIORITY_LOCK_TIMEOUT raises 55P03 → 409 priority_write_busy below.
      await lock(tx, cardId);

      // Read current UNDER the lock, so the from-value is what the previous
      // writer committed.
      const detail = await readCard(locked, cardId);
      if (detail instanceof Response) return detail;
      if (String(detail.item?.boardId ?? '') !== String(boardId)) return cardNotFound(cardId);

      prior = readState(detail, cardId, groups);
      const from = prior.priority;
      if (from === priority) return jsonResponse({ card_id: cardId, priority, priority_level_id: toLevelId });

      // The human always wins: the conveyor stands off a human/operator value.
      assertNoHumanOverride(user, prior.setBy);

      // SERVER-STAMPED provenance — derived here from the verified identity
      // (the rule only selects WHICH conveyor stamp), never read as a stamp.
      const setBy = prioritySetBy(user, rule);
      const base = priorityBaseAfter(user, prior, priority);
      // The audit row id, allocated BEFORE the insert and kept outside the
      // transaction: nextval is non-transactional, so after an uncertain
      // COMMIT this request can still ask whether ITS row exists. Allocated
      // under the lock (not before the transaction) so ids stay in lock = chain
      // order; startedAt (the DB clock, under the lock) precedes every later
      // writer's insert.
      event = await allocatePriorityEventId(tx);
      // Audit FIRST: if it cannot be written, Planka is never touched.
      await recordPriorityChange(tx, {
        user,
        project,
        cardId,
        from,
        to: priority,
        fromLevelId: levelForLegacyText(levels, from)?.id ?? null,
        toLevelId,
        setBy,
        id: event.id,
      });
      written = { priority, levelId: toLevelId, setBy, base };
      try {
        await writeCardPriorityProvenance(recording, cardId, groups.runtimeState, { setBy, base }, site);
        await writeCardPriority(recording, cardId, groups.metadata, priority, site);
      } catch (err) {
        // Still under the lock: restore what landed, then rethrow so the audit
        // row rolls back. No other writer can interleave with this restore.
        if (landed.size > 0) {
          try {
            await restore(locked, cardId, groups, prior, landed);
          } catch (compErr) {
            writeCompensationError = { cause: err, compensationError: compErr };
          }
        }
        throw err;
      }
      callbackDone = true;
      return null;
    });
    if (early) return early;
  } catch (err) {
    const writeComp = writeCompensationError as { cause: unknown; compensationError: unknown } | null;
    if (writeComp) {
      return compensationFailed('write_failed', project.id, cardId, writeComp.cause, writeComp.compensationError);
    }
    if (!callbackDone && isLockTimeout(err)) {
      return writeBusy(cardId, `the card's priority lock was not acquired within ${PRIORITY_LOCK_TIMEOUT}`);
    }
    const wroteOrNull = written as WrittenState | null;
    const eventOrNull = event as { id: number; startedAt: string } | null;
    if (callbackDone && wroteOrNull && eventOrNull && landed.size > 0) {
      const resolved = await resolveFailedCommit({
        lock,
        locked,
        cardId,
        projectId: project.id,
        groups,
        prior,
        wrote: wroteOrNull,
        landed,
        event: eventOrNull,
        cause: err,
      });
      if (resolved) return resolved;
    }
    const tokenErr = priorityTokenUnavailable(err, cardId);
    if (tokenErr) return tokenUnavailable(tokenErr);
    if (err instanceof PlankaError) return planka502('planka_priority_write_failed', err, cardId);
    throw err;
  }

  return jsonResponse({ card_id: cardId, priority, priority_level_id: toLevelId });
}

export { PRIORITY_PLANKA_TOKEN_UNAVAILABLE };

/** 503 — retryable, same shape as writeBusy: no login is ever attempted under the lock. */
function tokenUnavailable(err: PriorityPlankaTokenUnavailableError): Response {
  return jsonResponse(
    {
      error: err.code ?? PRIORITY_PLANKA_TOKEN_UNAVAILABLE,
      message: err.message,
      card_id: err.cardId,
      retryable: true,
    },
    err.statusCode,
    { 'Retry-After': '1' },
  );
}

/** Per-call policy for every Planka call made while the lock is held. */
const LOCKED_PLANKA_POLICY = Object.freeze({ singleAttempt: true, timeoutMs: 5_000, cachedTokenOnly: true });

async function readCard(planka: PlankaClient, cardId: string): Promise<CardDetailValues | Response> {
  try {
    return (await planka.cards.get(cardId)) as unknown as CardDetailValues;
  } catch (err) {
    // Under the lock with no cached token: a retryable 503, not a 502.
    const tokenErr = priorityTokenUnavailable(err, cardId);
    if (tokenErr) throw tokenErr;
    if (err instanceof PlankaError && (err.status === 404 || err.status === 403)) {
      return cardNotFound(cardId);
    }
    if (err instanceof PlankaError) return planka502('planka_card_fetch_failed', err, cardId);
    throw err;
  }
}

/** 409 `priority_write_busy` — retryable: the card's lock (or the conveyor slot) is held. */
function writeBusy(cardId: string, message: string): Response {
  return jsonResponse(
    { error: PRIORITY_WRITE_BUSY, message, card_id: cardId, retryable: true },
    409,
    { 'Retry-After': '1' },
  );
}

/**
 * A COMMIT failed after every Planka write landed. Re-take the lock in a
 * fresh (equally bounded) transaction, then, in order:
 *   (a) OUR audit row (pre-allocated id) exists → the COMMIT did succeed and
 *       only its acknowledgement was lost: restore nothing, answer 200;
 *   (b) another change of this card was recorded after this request started →
 *       a newer writer holds the card (covers A→B→A, whose values alone look
 *       untouched): restore nothing, 409 `priority_superseded`;
 *   (c) restore only if the card still holds exactly this request's
 *       (priority, set_by, base); anything else is uncertain state.
 * Returns the response for (a)/(b)/a failed restore, or null after a
 * successful restore (the caller then reports the original failure).
 */
async function resolveFailedCommit(args: {
  lock: CardPriorityLock;
  locked: PlankaClient;
  cardId: string;
  projectId: string;
  groups: ResolvedGroups;
  prior: PriorState;
  wrote: WrittenState;
  landed: Set<string>;
  event: { id: number; startedAt: string };
  cause: unknown;
}): Promise<Response | null> {
  const { lock, locked, cardId, groups, prior, wrote, landed, event } = args;
  let outcome: 'committed' | 'superseded' | 'restored';
  try {
    outcome = await db.transaction(async (tx) => {
      await boundPriorityTransaction(tx);
      await lock(tx, cardId);
      if (await priorityEventExists(tx, event.id)) return 'committed' as const;
      if (await newerPriorityChangeExists(tx, cardId, event.startedAt, event.id)) return 'superseded' as const;
      const detail = (await locked.cards.get(cardId)) as unknown as CardDetailValues;
      const now = readState(detail, cardId, groups);
      if (now.priority !== wrote.priority || now.setBy !== wrote.setBy || now.base !== wrote.base) {
        throw new Error(
          `card ${cardId} changed after the failed commit (now ${JSON.stringify(now)}); refusing to restore over it`,
        );
      }
      await restore(locked, cardId, groups, prior, landed);
      return 'restored' as const;
    });
  } catch (compErr) {
    return compensationFailed('commit_failed', args.projectId, cardId, args.cause, compErr);
  }
  if (outcome === 'committed') {
    return jsonResponse({ card_id: cardId, priority: wrote.priority, priority_level_id: wrote.levelId });
  }
  if (outcome === 'superseded') {
    return jsonResponse(
      {
        error: PRIORITY_SUPERSEDED,
        message:
          `the priority write on card ${cardId} did not commit and a newer priority write has since landed; ` +
          'nothing was restored — re-read the card',
        card_id: cardId,
      },
      409,
    );
  }
  return null;
}

interface PriorState {
  priority: string | null;
  setBy: string | null;
  base: string | null;
}

interface WrittenState {
  priority: string | null;
  /** The RM priority-level id of `priority` (null for a clear). */
  levelId: string | null;
  setBy: string;
  base: string | null;
}

interface ResolvedGroups {
  metadata: BoardFieldGroup;
  runtimeState: BoardFieldGroup;
}

/** 500 `priority_compensation_failed` + the loud signal (counter + tagged error log). */
function compensationFailed(
  phase: PriorityCompensationPhase,
  projectId: string,
  cardId: string,
  cause: unknown,
  compensationError: unknown,
): Response {
  reportPriorityCompensationFailure({ phase, projectId, cardId, cause, compensationError });
  return jsonResponse(
    {
      error: PRIORITY_COMPENSATION_FAILED,
      message:
        `the priority write on card ${cardId} failed and restoring the previous value also failed: ` +
        'the card may hold a priority change with no audit row — re-read the card before retrying',
      card_id: cardId,
      project_id: projectId,
    },
    500,
  );
}

/** The 409 code of a priority write on a board whose RM template has no Metadata.priority. */
const BOARD_FIELD_MISSING = 'board_field_missing';

const EMPTY_GROUP: BoardFieldGroup = { groupId: '', fieldIds: {} };

async function resolveGroups(agent: PlankaClient, boardId: string): Promise<ResolvedGroups> {
  const groups = await projectCardResolveGroups()(agent, boardId);
  return { metadata: groups.Metadata ?? EMPTY_GROUP, runtimeState: groups['Runtime State'] ?? EMPTY_GROUP };
}

function readState(detail: CardDetailValues, cardId: string, groups: ResolvedGroups): PriorState {
  const values = detail.included?.customFieldValues ?? [];
  const read = (group: BoardFieldGroup, field: string) => {
    const fieldId = group.fieldIds[field];
    return storedPriority(
      values.find(
        (v) =>
          v.cardId === cardId &&
          v.customFieldGroupId === group.groupId &&
          v.customFieldId === fieldId,
      )?.content,
    );
  };
  return {
    priority: read(groups.metadata, CARD_PRIORITY_FIELD),
    setBy: read(groups.runtimeState, CARD_PRIORITY_SET_BY_FIELD),
    base: read(groups.runtimeState, CARD_PRIORITY_BASE_FIELD),
  };
}

/** Wrap the agent's custom-field writers so each SUCCESSFUL write is recorded in `landed`. */
function recordingPlanka(agent: PlankaClient, landed: Set<string>): Pick<PlankaClient, 'customFields'> {
  const cf = agent.customFields;
  // A network failure / timeout (PlankaNetworkError: status 0, no HTTP
  // answer) is AMBIGUOUS — the PATCH may have applied — so the field joins the
  // restore set (restoring an unapplied field rewrites the value already
  // there). A 2xx whose body then failed (PlankaWriteOutcomeUnknownError,
  // statusReceived) is presumed APPLIED and joins it too. Anything else that
  // is NOT a PlankaError (no HTTP classification at all) is also treated as
  // unknown-applied: only a typed Planka refusal means "not applied". Always
  // rethrows.
  const markIfAmbiguous = (e: unknown, fieldId: string): never => {
    if (plankaWriteMayHaveApplied(e)) landed.add(fieldId);
    throw e;
  };
  return {
    customFields: {
      ...cf,
      setCardCustomFieldValue: async (a: Parameters<typeof cf.setCardCustomFieldValue>[0]) => {
        const r = await cf.setCardCustomFieldValue(a).catch((e: unknown) => markIfAmbiguous(e, a.customFieldId));
        landed.add(a.customFieldId);
        return r;
      },
      clearCardCustomFieldValue: async (a: Parameters<typeof cf.clearCardCustomFieldValue>[0]) => {
        const r = await cf.clearCardCustomFieldValue(a).catch((e: unknown) => markIfAmbiguous(e, a.customFieldId));
        landed.add(a.customFieldId);
        return r;
      },
    } as PlankaClient['customFields'],
  };
}

/**
 * Put back what was read, for every field whose write LANDED. Restored
 * verbatim (even an out-of-vocabulary legacy string) — the writers only forward
 * `content`. Value first, provenance last (reverse of the write); each step is
 * attempted even if another failed, then the first failure is rethrown.
 */
async function restore(
  agent: PlankaClient,
  cardId: string,
  groups: ResolvedGroups,
  prior: PriorState,
  landed: Set<string>,
): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (fieldId: string | undefined, fn: () => Promise<void>) => {
    if (fieldId === undefined || !landed.has(fieldId)) return;
    await fn().catch((e) => failures.push(e));
  };
  await attempt(groups.metadata.fieldIds[CARD_PRIORITY_FIELD], () =>
    writeCardPriority(agent, cardId, groups.metadata, prior.priority as CardPriority | null, {
      boardId: 'restore',
      context: 'cards.priority.restore',
    }).then(() => undefined),
  );
  const rs = groups.runtimeState;
  const setById = rs.fieldIds[CARD_PRIORITY_SET_BY_FIELD];
  const baseId = rs.fieldIds[CARD_PRIORITY_BASE_FIELD];
  if ((setById && landed.has(setById)) || (baseId && landed.has(baseId))) {
    await writeCardPriorityProvenance(
      agent,
      cardId,
      rs,
      { setBy: prior.setBy, base: prior.base },
      { boardId: 'restore', context: 'cards.priority.restore' },
    ).catch((e) =>
      failures.push(e),
    );
  }
  if (failures.length > 0) throw failures[0];
}
