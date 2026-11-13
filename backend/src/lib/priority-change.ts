// src/lib/priority-change.ts
//
// Priority writes (a project's priority is RM's `priority_level_id`, sent in
// the create POST — fr keeps no copy; a card's at Planka `Metadata.priority`)
// and their audit trail.
//
// Ruling (George via coordinator, 2026-10-03): setting priority and backlog
// reprioritisation are part of the conveyor system — people AND the conveyor's
// identities may set it. Who may edit is the project's ordinary edit rule
// (tenant-scoped + owner, see routes); nothing here narrows or widens it.
//
// Every EFFECTIVE change is recorded in `priority_change_events` (migration
// 160) by `recordPriorityChange`, inside the same transaction as the change,
// so a failed audit write means the change is not applied. A no-op (from = to)
// records nothing.

import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import { priorityChangeEvents } from '../db/schema';
import type { User } from '../types/api';
import { AppError, BadRequestError, ForbiddenError } from '../utils/errors';
import { PlankaTokenNotCachedError } from '../services/planka/errors';
import { isPlatformTenant } from '../middleware/internal-tenant-only';
import { CONVEYOR_RULES, isConveyorActor, type ConveyorRule } from './conveyor-identity';
import { CardPrioritySchema } from '../services/improvement-cards/request-schema';
import { INVALID_PRIORITY } from '../services/catalogue/priority-levels';

/**
 * A priority as STORED in the legacy text slot (Planka Metadata.priority,
 * priority_change_events.from/to_priority) — the RM level's
 * legacy text during the backfill window (services/catalogue/priority-levels.ts).
 */
export type Priority = string;

export { INVALID_PRIORITY } from '../services/catalogue/priority-levels';

/**
 * SHAPE gate for a body-borne `priority`, shared by PATCH /api/projects/:id and
 * PATCH /api/projects/:projectId/cards/:cardId/priority: a non-empty string (a
 * level id or name) or `null` (clear). Anything else — 1, '', {} — is 400
 * invalid_priority. Membership is the project TENANT's RM levels, resolved by
 * the route (priority-levels.ts resolveTenantPriority) once the project is known.
 */
export function parsePriorityWrite(value: unknown): string | null {
  const parsed = CardPrioritySchema.nullable().safeParse(value);
  if (!parsed.success) {
    throw new BadRequestError('priority must be a priority level (name or id) or null', {
      field: 'priority',
    }).withCode(INVALID_PRIORITY);
  }
  return parsed.data;
}

/**
 * SHAPE gate for a project CREATE body (POST /api/projects, each item of POST
 * /api/projects/bulk): `null` is refused (a create has nothing to clear) — 400
 * invalid_priority BEFORE the schema parse. Membership is resolved against the
 * OWNER tenant's RM levels in createSingleProject. Absent key → no-op.
 */
export function refuseInvalidCreatePriority(body: unknown): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;
  if (!('priority' in body)) return;
  const parsed = CardPrioritySchema.safeParse((body as Record<string, unknown>).priority);
  if (!parsed.success) {
    throw new BadRequestError('priority must be a priority level (name or id)', {
      field: 'priority',
    }).withCode(INVALID_PRIORITY);
  }
}

/** A stored value as the audit's from-value: '' and non-strings read as unset. */
export function storedPriority(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Actor kind from the verified token (`User.isServiceAccount`, set by
 * keycloak.validateToken). ⚠️ `service_account` means a CLIENT-CREDENTIALS
 * token only; the conveyor's password-grant operators read as `user` — the
 * username column is what identifies them.
 */
export function actorKind(user: Pick<User, 'isServiceAccount'>): 'user' | 'service_account' | 'unknown' {
  if (user.isServiceAccount === true) return 'service_account';
  if (user.isServiceAccount === false) return 'user';
  return 'unknown';
}

// ── Provenance (design 20-designs/backlog-reprioritization.md, Amendment) ──
//
// `priority_set_by` / `priority_base` are STAMPED BY THE SERVER from the
// verified identity on every effective card priority change; a caller can never
// send them (the card route's body schema is strict).
//
// Semantics:
//   * `priority_set_by` = `<class>:<sub>` for a person/operator, or
//     `conveyor:<rule>` for the dedicated conveyor identity, of the LAST
//     EFFECTIVE change — the same events priority_change_events records,
//     one-to-one. A no-op write (from = to) changes nothing, provenance included.
//   * `priority_base` (priorityBaseAfter):
//       - a person/operator write RESETS it to the value written;
//       - the conveyor's FIRST write (previous set_by not `conveyor:*`) records
//         the PRIOR value — what B2 reverts to;
//       - a later conveyor write KEEPS it.
//     A person/operator clear (`null`) clears the priority AND the base.
//   * class: `conveyor` ONLY for the exact conveyor identity (isConveyorActor,
//     evaluated FIRST — the conveyor is also a service account); else
//     `operator` for a service account or a username starting with
//     `system-` / `claude-` / `aa-` (case-insensitive); else `human`.

/** Username prefixes of the automation fleet's password-grant identities. */
export const OPERATOR_USERNAME_PREFIXES = ['system-', 'claude-', 'aa-'] as const;

export type PriorityActorClass = 'human' | 'operator' | 'conveyor';

type ActorShape = Pick<User, 'id' | 'isServiceAccount' | 'username' | 'azp' | 'roles'>;

// The dedicated conveyor identity + its route allowlist live in
// lib/conveyor-identity.ts (dependency-free: middleware/auth.ts imports it).
export {
  CONVEYOR_AZP,
  CONVEYOR_ROLE,
  CONVEYOR_ROUTE_FORBIDDEN,
  CONVEYOR_RULES,
  CONVEYOR_USERNAME,
  assertConveyorRouteAllowed,
  isConveyorActor,
  isConveyorAllowedRequest,
  type ConveyorRule,
} from './conveyor-identity';

export function priorityActorClass(user: ActorShape): PriorityActorClass {
  // FIRST: the conveyor is also a client-credentials service account.
  if (isConveyorActor(user)) return 'conveyor';
  if (user.isServiceAccount === true) return 'operator';
  const name = (user.username ?? '').toLowerCase();
  return OPERATOR_USERNAME_PREFIXES.some((p) => name.startsWith(p)) ? 'operator' : 'human';
}

/**
 * The `priority_set_by` stamp: `conveyor:<rule>` for the conveyor (rule
 * REQUIRED), else `operator:<sub>` | `human:<sub>` (sub = User.id).
 */
export function prioritySetBy(user: ActorShape, rule?: ConveyorRule): string {
  const cls = priorityActorClass(user);
  if (cls === 'conveyor') {
    if (rule === undefined || !(CONVEYOR_RULES as readonly string[]).includes(rule)) {
      throw new Error('prioritySetBy: a conveyor stamp needs a validated rule');
    }
    return `conveyor:${rule}`;
  }
  return `${cls}:${user.id}`;
}

/**
 * The `priority_base` after an effective change (see the semantics above).
 * `prev` is what the card held BEFORE this write.
 */
export function priorityBaseAfter(
  user: ActorShape,
  prev: { priority: string | null; setBy: string | null; base: string | null },
  to: Priority | null,
): string | null {
  if (!isConveyorActor(user)) return to;
  if (prev.setBy !== null && prev.setBy.startsWith('conveyor:')) return prev.base;
  return prev.priority;
}

export const CONVEYOR_RULE_NOT_ACCEPTED = 'conveyor_rule_not_accepted';
export const CONVEYOR_RULE_REQUIRED = 'conveyor_rule_required';
export { CONVEYOR_TOP_PRIORITY_FORBIDDEN as CONVEYOR_P0_FORBIDDEN } from '../services/catalogue/priority-levels';
export const HUMAN_OVERRIDE = 'human_override';
/** 409: the project carries no tenant tag, so no priority write (and no audit row) is possible. */
export const PROJECT_TENANT_UNKNOWN = 'project_tenant_unknown';

/**
 * NON-conveyor callers: 400 `conveyor_rule_not_accepted` when the body carries
 * a rule tag (`rule`, `conveyor_rule`, any `*rule*` key). Only the conveyor
 * identity may send a rule.
 */
export function refuseRuleTag(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
  const tag = Object.keys(raw).find((k) => /rule/i.test(k));
  if (tag !== undefined) {
    throw new BadRequestError(
      'a priority rule tag is accepted only from the conveyor priority identity',
      { field: tag },
    ).withCode(CONVEYOR_RULE_NOT_ACCEPTED);
  }
}

/**
 * The CONVEYOR's `rule`: required, exactly one of CONVEYOR_RULES (closed set).
 * Missing → 400 `conveyor_rule_required`; any other value → 400 the same code.
 */
export function parseConveyorRule(raw: unknown): ConveyorRule {
  const rule = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).rule
    : undefined;
  if (typeof rule !== 'string' || !(CONVEYOR_RULES as readonly string[]).includes(rule)) {
    throw new BadRequestError(
      `the conveyor must send rule: one of ${CONVEYOR_RULES.join(', ')}`,
      { field: 'rule' },
    ).withCode(CONVEYOR_RULE_REQUIRED);
  }
  return rule as ConveyorRule;
}

// The conveyor never sets the tenant's HIGHEST level (was "never P0"):
// services/catalogue/priority-levels.ts assertConveyorNotTopPriority (403
// `conveyor_p0_forbidden`) — it needs the tenant's levels, so the routes call it
// once the project is known.

/**
 * The human always wins: the conveyor overwriting a value whose current
 * `priority_set_by` is `human:` / `operator:` → 409 `human_override`.
 */
export function assertNoHumanOverride(
  user: Pick<User, 'azp' | 'username' | 'roles'>,
  currentSetBy: string | null,
): void {
  if (!isConveyorActor(user)) return;
  if (currentSetBy !== null && /^(human|operator):/.test(currentSetBy)) {
    throw new AppError(409, 'the current priority was set by a person or operator; the conveyor may not override it').withCode(
      HUMAN_OVERRIDE,
    );
  }
}

// ── The conveyor's tenant (its token carries no tenant_id) ──────────────────

export const CONVEYOR_TENANT_REQUIRED = 'conveyor_tenant_required';
export const CONVEYOR_TENANT_FORBIDDEN = 'conveyor_tenant_forbidden';
/** The conveyor sent a key other than `priority` / `rule` to PATCH /api/projects/:id. */
export const CONVEYOR_FIELD_FORBIDDEN = 'conveyor_field_forbidden';

/**
 * The tenant a CONVEYOR priority write acts in: the `X-Tenant-Id` header, and
 * ONLY when it names a PLATFORM tenant (isPlatformTenant, exact membership).
 * Missing → 403 `conveyor_tenant_required`; anything else → 403
 * `conveyor_tenant_forbidden`. Read ONLY by the two priority routes, ONLY for
 * isConveyorActor — request-context never honours this header for the conveyor,
 * so every other route keeps its SA-sub frame (which owns nothing).
 */
export function conveyorTenantFromHeader(req: Request): string {
  const raw = req.headers.get('X-Tenant-Id');
  const value = raw?.trim() ?? '';
  if (value === '') {
    throw new ForbiddenError('the conveyor must name its platform tenant in X-Tenant-Id').withCode(
      CONVEYOR_TENANT_REQUIRED,
    );
  }
  if (!isPlatformTenant(value)) {
    throw new ForbiddenError('the conveyor may act only in a platform tenant').withCode(CONVEYOR_TENANT_FORBIDDEN);
  }
  return value;
}

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export type PriorityTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ── Per-card serialisation ──────────────────────────────────────────────────
//
// Priority is written by people AND the conveyor, so two PATCHes on one card
// can race. Without serialisation both read the same from-value (two audit rows
// A→B and A→C, never A→B then B→C), and one's compensation can revert the
// other's change. The card route therefore holds this lock across
// read-current → audit → provenance → Planka write → commit.

/**
 * The advisory-lock key string for one card's priority. A `hashtext` string in
 * the per-row keyspace `db/advisory-lock-keys.ts` describes — the same shape as
 * `relationFieldLockKey` (`card-relations:<cardId>:<field>`,
 * services/improvement-cards/relations.ts), in its OWN namespace
 * (`card-priority:`) so a priority write never queues behind a relation write.
 */
export function cardPriorityLockKey(cardId: string): string {
  return `card-priority:${cardId}`;
}

/**
 * Acquire the per-card priority lock ON `tx`. Implementations must block until
 * the lock is held (mutual exclusion, never skip/retry) and must release it
 * when `tx` ends.
 */
export type CardPriorityLock = (tx: PriorityTx, cardId: string) => Promise<void>;

/**
 * The production lock: `pg_advisory_xact_lock`, TRANSACTION-scoped, taken on
 * the SAME transaction that inserts the audit row, so it is released by that
 * transaction's COMMIT/ROLLBACK and never outlives it.
 *
 * ⛔ Never the session-level `pg_advisory_lock` / `_unlock` (or `try_`): fr
 * reaches Postgres through pgbouncer in TRANSACTION pooling, so a session lock
 * stays on the server backend and is handed to the next client — the same class
 * as the 2026-09-22 session-SET incident. Pinned by
 * tests/unit/db/no-session-advisory-lock.test.ts.
 *
 * BLOCKING, not `try_`: the second writer must WAIT and then read the first's
 * committed value as its from-value.
 */
export const pgCardPriorityLock: CardPriorityLock = async (tx, cardId) => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${cardPriorityLockKey(cardId)}))`);
};

/**
 * The tenant a priority_change_events row is scoped to: ALWAYS the tenant that
 * OWNS the project being changed — `project_data.keycloak_tenant_id` of that
 * project row — never the acting user's workspace.
 *
 * ⛔ The acting tenant is NOT the project's tenant in general. On a promoted
 * project (owner_id = the deciding user, dept_id NULL, tag = the CUSTOMER
 * tenant) the decider reaches it from their EXEC/platform workspace through the
 * owner-based home-view filter (lib/project-access.ts tenantScopedProjectFilter),
 * so stamping the acting tenant would file customer project history under the
 * platform tenant (strict tenant separation).
 *
 * ⛔ FAIL CLOSED: a project with no (or blank / non-string) tag has NO known
 * tenant, so its priority cannot be written at all — 409
 * `project_tenant_unknown`. Falling back to the acting tenant would be a GUESS
 * that files the history under whoever acts, which is exactly the defect class
 * this rule removes. Callers check BEFORE they change the project (PATCH: under
 * the row lock, before the UPDATE; card route: before the lock / any Planka
 * call), and recordPriorityChange re-derives it inside the transaction as
 * defense-in-depth so a missed pre-check still rolls the change back.
 */
export function priorityEventTenantId(project: { project_data: unknown }): string {
  const tag = (project.project_data as { keycloak_tenant_id?: unknown } | null)?.keycloak_tenant_id;
  if (typeof tag === 'string' && tag.trim() !== '') return tag;
  throw new AppError(
    409,
    'this project has no tenant tag (project_data.keycloak_tenant_id); its priority cannot be changed until it is tagged',
  ).withCode(PROJECT_TENANT_UNKNOWN);
}

/**
 * Append one audit row for an effective priority change. Returns false (and
 * writes nothing) for a no-op. Throws on a failed insert — callers run it in
 * the transaction of the change so the throw rolls the change back.
 *
 * `project` is REQUIRED and is the project ROW being changed (id +
 * project_data): the row's tenant is derived from it (priorityEventTenantId),
 * so no caller can forget to scope it or scope it to the actor's workspace.
 * The actor columns stay the acting user.
 */
export async function recordPriorityChange(
  conn: DbOrTx,
  args: {
    user: User;
    /** The project row being changed — its own tenant tag scopes the audit row. */
    project: { id: string; project_data: unknown };
    cardId: string | null;
    from: string | null;
    to: Priority | null;
    /**
     * The RM priority-level ids of from / to — the values of record (design Q3 = b).
     * `from`/`to` are the legacy text, still written for the backfill window
     * (FOLLOW-UP: drop with the columns once scripts/backfill-priority-level-ids.ts
     * measures 100%).
     */
    fromLevelId?: string | null;
    toLevelId?: string | null;
    /** The stamped provenance (prioritySetBy) — recorded as priority_set_by. */
    setBy: string;
    /**
     * A pre-allocated row id (allocatePriorityEventId), so the caller can ask
     * after an uncertain COMMIT whether THIS row exists. When given,
     * `changed_at` is `clock_timestamp()` — the moment of the insert, under the
     * card lock — instead of the column default `now()` (transaction start),
     * so a later writer's row is always later than this request's start.
     */
    id?: number;
  },
): Promise<boolean> {
  if (args.from === args.to) return false;
  const { user, project } = args;
  await conn.insert(priorityChangeEvents).values({
    ...(args.id === undefined ? {} : { id: args.id, changed_at: sql`clock_timestamp()` }),
    tenant_id: priorityEventTenantId(project),
    project_id: project.id,
    card_id: args.cardId,
    from_priority: args.from,
    to_priority: args.to,
    from_priority_level_id: args.fromLevelId ?? null,
    to_priority_level_id: args.toLevelId ?? null,
    actor_id: user.id,
    actor_username: user.username ?? null,
    actor_name: user.name || null,
    actor_kind: actorKind(user),
    priority_set_by: args.setBy,
  });
  return true;
}

// ── Bounding the hold (row 13a) ─────────────────────────────────────────────
//
// The card route holds ONE pooled connection (pgbouncer transaction pooling,
// fr pool_size=12) and the per-card lock across Planka HTTP calls. These
// bound how long a single write can hold them. See the HEADROOM NOTE at the
// top of routes/cards/priority.ts.

/** Longest the per-card lock is waited for before the write is refused 409 `priority_write_busy`. */
export const PRIORITY_LOCK_TIMEOUT = '2s';
/** Longest any one SQL statement of a priority transaction may run. */
export const PRIORITY_STATEMENT_TIMEOUT = '10s';

/**
 * The FIRST statements of every card-priority transaction. ⛔ SET LOCAL only —
 * a session-level `SET lock_timeout` / `SET statement_timeout` would survive
 * the transaction on the pgbouncer SERVER backend and be inherited by the next
 * client (the 2026-09-22 session-SET incident class). Pinned by
 * tests/unit/db/no-session-advisory-lock.test.ts.
 */
export async function boundPriorityTransaction(tx: PriorityTx): Promise<void> {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${PRIORITY_LOCK_TIMEOUT}'`));
  await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${PRIORITY_STATEMENT_TIMEOUT}'`));
}

/** SQLSTATE 55P03 lock_not_available — what `lock_timeout` raises. Walks drizzle's `cause` chain. */
export function isLockTimeout(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth += 1) {
    if (typeof e === 'object' && (e as { code?: unknown }).code === '55P03') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Stable machine-readable code: the card's lock (or the conveyor slot) is busy — retry. */
export const PRIORITY_WRITE_BUSY = 'priority_write_busy';
/** Stable machine-readable code: a newer priority write landed after this one's failed COMMIT. */
export const PRIORITY_SUPERSEDED = 'priority_superseded';
/** Stable code: the Planka agent token was not cached when a locked call ran (nothing sent). */
export const PRIORITY_PLANKA_TOKEN_UNAVAILABLE = 'priority_planka_token_unavailable';

/**
 * 503 `priority_planka_token_unavailable` — retryable. A Planka call made under
 * the card's priority lock found no cached agent token and, by policy
 * (`cachedTokenOnly`), attempted no login there; nothing was sent to Planka.
 * The status is fr's decision (retry later), not an upstream's, so it lives on
 * this type; the route renders it with `card_id` + `Retry-After`.
 */
export class PriorityPlankaTokenUnavailableError extends AppError {
  constructor(
    public readonly cardId: string,
    cause?: unknown,
  ) {
    super(
      503,
      'the Planka token was not available under the priority lock (no login is attempted there); retry',
    );
    this.name = 'PriorityPlankaTokenUnavailableError';
    this.withCode(PRIORITY_PLANKA_TOKEN_UNAVAILABLE);
    if (cause !== undefined) (this as unknown as { cause?: unknown }).cause = cause;
  }
}

/**
 * The priority route's view of a Planka-layer token refusal: returns the
 * AppError for a `PlankaTokenNotCachedError` (or the AppError itself, if it
 * was already translated), else null. Keeps the Planka class out of the route.
 */
export function priorityTokenUnavailable(err: unknown, cardId: string): PriorityPlankaTokenUnavailableError | null {
  if (err instanceof PriorityPlankaTokenUnavailableError) return err;
  if (err instanceof PlankaTokenNotCachedError) return new PriorityPlankaTokenUnavailableError(cardId, err);
  return null;
}

/**
 * The ONE global key serialising conveyor priority writes (conveyor
 * concurrency 1, enforced server-side). Same hashtext keyspace as
 * cardPriorityLockKey; its own namespace, so it never collides with a card's.
 */
export const PRIORITY_CONVEYOR_LOCK_KEY = 'priority-conveyor';

/**
 * Try — never wait — for the conveyor slot on `tx`. TRANSACTION-scoped
 * (`pg_try_advisory_xact_lock`), released by the transaction's end. false =
 * another conveyor write holds it → the caller answers 409 priority_write_busy.
 */
export async function tryConveyorPriorityLock(tx: PriorityTx): Promise<boolean> {
  const rows = (await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${PRIORITY_CONVEYOR_LOCK_KEY})) AS ok`,
  )) as unknown as Array<{ ok: boolean }>;
  return rows[0]?.ok === true;
}

/**
 * Allocate the audit row id BEFORE its insert (the id column is a bigserial —
 * migration 160 — so its sequence is caller-usable and no migration is
 * needed; a uuid would not fit it). nextval is NON-transactional: the id is
 * known to the caller and never reused even when the transaction rolls back or
 * its COMMIT outcome is unknown. Also returns the database clock at that
 * moment — the "this request started" mark the failed-COMMIT check compares
 * later rows against.
 */
export async function allocatePriorityEventId(conn: DbOrTx = db): Promise<{ id: number; startedAt: string }> {
  const rows = (await conn.execute(sql`
    SELECT nextval(pg_get_serial_sequence('priority_change_events', 'id'))::bigint AS id,
           clock_timestamp()::text AS started_at`)) as unknown as Array<{ id: string | number; started_at: string }>;
  const row = rows[0];
  if (!row) throw new Error('could not allocate a priority_change_events id');
  return { id: Number(row.id), startedAt: row.started_at };
}

/** True when the audit row with this id exists — i.e. that transaction DID commit. */
export async function priorityEventExists(tx: PriorityTx, id: number): Promise<boolean> {
  const rows = (await tx.execute(
    sql`SELECT 1 FROM priority_change_events WHERE id = ${id}`,
  )) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * True when another priority change of `cardId` was recorded after `since`
 * (excluding row `ownId`): a newer writer took the lock after this request —
 * covers A→B→A, where the card's values alone look untouched.
 */
export async function newerPriorityChangeExists(
  tx: PriorityTx,
  cardId: string,
  since: string,
  ownId: number,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT 1 FROM priority_change_events
    WHERE card_id = ${cardId} AND changed_at > ${since}::timestamptz AND id <> ${ownId}
    LIMIT 1`)) as unknown as unknown[];
  return rows.length > 0;
}
