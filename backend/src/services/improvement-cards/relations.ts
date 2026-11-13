// Bidirectional relations enforcement for improvement cards.
//
// AA Card Substrate Phase 5 — when a `parent_card` is set on B, automatically
// add B to A's `child_cards`. Same pattern for `requires` ↔ `required_by`.
//
// Two-layer design:
//
//   1. Pure algorithm — `linkParentChild` / `linkRequires` operate on a
//      `RelationOps` interface (read + write a single named field on a card,
//      plus a lock that serialises one field's read-modify-write). This layer
//      is the unit-test target. No PlankaClient, no HTTP, no groupId/fieldId
//      resolution. Pure ID-shuffling + idempotency + concurrency control.
//
//   2. Adapter — `plankaRelationOps` implements `RelationOps` against a real
//      `PlankaClient` + a board-scoped customFieldGroup cache. It resolves
//      `Relations` group + `parent_card`/`child_cards`/`requires`/`required_by`
//      field IDs once per board (READ-ONLY, via `resolveBoardFieldGroups`) and reads
//      per-card values via GET /api/cards/:id (which includes
//      `customFieldValues` in `included`).
//
// Idempotency: re-running with the same args is a no-op (no PATCH). The pure
// helpers check the existing field state before issuing a write.
//
// NOTE on multi-parent: `parent_card` is single-valued by design (one slot
// per card in Planka customFields). `linkParentChild` does NOT enforce that
// only one parent exists — it just OVERWRITES the previous parent_card on
// the child. This matches Planka's storage shape; it's the caller's job to
// detect a parent change if it cares.

import type { PlankaClient } from '../planka';
import {
  PLANKA_CUSTOM_FIELD_MAX_CHARS,
  resolveBoardFieldGroups,
  warnBoardFieldMissing,
} from '../planka/custom-fields';
import type { BoardFieldGroup } from '../planka/custom-fields';
import { AppError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// WHERE THE DATA ACTUALLY LIVES, AND WHAT THAT RULES OUT
// ---------------------------------------------------------------------------
//
// `child_cards` / `requires` / `required_by` are NOT columns in fr's Postgres.
// Each one is a single Planka `customFieldValue.content` cell — one opaque
// string, capped at 512 chars (`PLANKA_CUSTOM_FIELD_MAX_CHARS`), holding a
// JSON-encoded array of card ids. fr reaches it only over Planka's REST API:
//
//   read   GET   /api/cards/:id                     -> included.customFieldValues
//   write  PATCH /api/cards/:id/custom-field-values/customFieldGroupId:G:customFieldId:F
//
// That PATCH is an UNCONDITIONAL full-cell upsert. It carries no version, no
// ETag, no If-Match, and there is no append endpoint. So the two textbook
// answers are architecturally unavailable, not merely unattractive:
//
//   * `SELECT … FOR UPDATE` — there is no row of ours to lock. The row lives in
//     Planka's database, which fr does not connect to.
//   * a JSON append operator (`jsonb_set`, `||`) — same reason: no SQL reaches
//     this cell, and the cell is `text` holding JSON, not `jsonb`.
//
// What IS available is fr's OWN Postgres, shared by every fr-backend replica.
// So the read-modify-write is serialised there, with a transaction-scoped
// advisory lock keyed on `hashtext('card-relations:<cardId>:<fieldName>')` —
// the same per-row idiom as
// `domain/engagement/idempotency.ts`, and the separate hashtext keyspace that
// `db/advisory-lock-keys.ts:57-69` documents.
//
// ⚠️ Be precise about what that buys, because it is not everything:
//
//   * Between fr writers (every replica, every route, every worker) it is
//     MUTUAL EXCLUSION, not a narrowed window. The second spawn BLOCKS in
//     Postgres until the first COMMITs, then re-reads the cell and sees the
//     first child already in it. Nothing is lost and nothing is retried.
//   * Against a writer OUTSIDE fr (a human editing the field in Planka's UI,
//     an n8n node PATCHing it directly) the lock is worthless — they never ask
//     fr for it. Planka offers no conditional write, so that clobber cannot be
//     PREVENTED from here. It is instead DETECTED, by reading the cell back
//     inside the lock and requiring it to equal exactly what we wrote. On
//     mismatch the caller gets a 409, not a 201 over a lost link.
//
// Transaction-scoped (not session-scoped) is mandatory: fr reaches Postgres
// through pgbouncer in transaction-pooling mode, where a session-scoped
// `pg_advisory_lock` and its later unlock can land on different backends and
// leak the lock forever. See `db/advisory-lock-keys.ts:82-88`.
//
// The cost of that choice, stated rather than hidden: the transaction is held
// open across the Planka round-trips it guards — at most three (read, write,
// read-back), each bounded by the Planka client's fixed 15s timeout, so ≤45s
// worst case on one pgbouncer transaction slot. This is the same deliberate
// hold-across-HTTP tradeoff documented for `deblockCallbackRedelivery`.

/**
 * A read-modify-write of one card's relation field, serialised across every
 * fr-backend replica.
 *
 * Implementations must provide MUTUAL EXCLUSION, not a retry. A caller that
 * blocks and then re-reads is correct; a caller that skips, or that retries a
 * lost write, is not.
 */
export type RelationFieldLock = <T>(
  cardId: string,
  fieldName: string,
  fn: () => Promise<T>,
) => Promise<T>;

/**
 * The existing content of a relation field cannot be read as a list of card
 * ids — and is therefore EVIDENCE, not garbage.
 *
 * The pre-fix behaviour was to map an unparseable cell to `[]` and then write a
 * one-element array back over it, destroying an unknown number of links while
 * returning `{ok:true} 200`. Refusing the write is the whole point of this
 * class: the malformed bytes stay exactly as they are, and `rawContent` carries
 * them to the operator so the state can be repaired from evidence rather than
 * guessed at.
 *
 * ⛔ Never "recover" by inferring the intended value. The correct repair is a
 * human (or a migration with a measured population) rewriting the cell.
 */
export class MalformedRelationFieldError extends AppError {
  constructor(
    public readonly cardId: string,
    public readonly fieldName: string,
    public readonly rawContent: string,
    public readonly reason: 'not_json' | 'not_an_array' | 'non_string_member',
  ) {
    super(
      409,
      `Relations.${fieldName} on card ${cardId} is not a JSON string array ` +
        `(${reason}); refusing to write over it`,
      { cardId, fieldName, reason, content: rawContent },
    );
    this.name = 'MalformedRelationFieldError';
    this.withCode('relation_field_malformed');
  }
}

/**
 * The cell did not contain what we just wrote.
 *
 * Two known causes, and the caller cannot tell them apart from here:
 *   * a writer outside fr (Planka UI, a direct n8n PATCH) overwrote the cell
 *     inside our lock — the lock does not bind them;
 *   * Planka accepted the PATCH but stored something else.
 *
 * Either way the link is NOT established, so this must never be reported as
 * success. There is deliberately no retry: a foreign writer racing us would be
 * raced again, and a retry loop over a non-CAS write narrows a window instead
 * of closing it.
 */
export class RelationWriteConflictError extends AppError {
  constructor(
    public readonly cardId: string,
    public readonly fieldName: string,
    public readonly expected: string,
    public readonly observed: string | undefined,
  ) {
    super(
      409,
      `Relations.${fieldName} on card ${cardId} did not round-trip: another ` +
        `writer changed it during the update`,
      { cardId, fieldName, expected, observed },
    );
    this.name = 'RelationWriteConflictError';
    this.withCode('relation_write_conflict');
  }
}

/**
 * The appended list would exceed Planka's 512-char cell.
 *
 * This is refused BEFORE the PATCH so the caller gets this relation-specific
 * error (`setCardCustomFieldValue` would also refuse it, fr#1494, with the
 * generic 422). A truncated JSON array is unparseable, so an over-long write
 * must never reach Planka. The cap is on the SERIALISED array (`JSON.stringify`
 * length, quotes, commas and brackets included), not on an id count: a member
 * costs its length + 3 chars, so 23 of Planka's 19-digit snowflake card ids
 * fit (23 × 22 + 1 = 507), the 24th is refused.
 */
export class RelationFieldCapacityError extends AppError {
  constructor(
    public readonly cardId: string,
    public readonly fieldName: string,
    public readonly attemptedChars: number,
  ) {
    super(
      409,
      `Relations.${fieldName} on card ${cardId} would need ${attemptedChars} ` +
        `chars, over Planka's ${PLANKA_CUSTOM_FIELD_MAX_CHARS}-char cell; ` +
        `writing it would truncate and corrupt the existing list`,
      {
        cardId,
        fieldName,
        attemptedChars,
        maxChars: PLANKA_CUSTOM_FIELD_MAX_CHARS,
      },
    );
    this.name = 'RelationFieldCapacityError';
    this.withCode('relation_field_capacity_exceeded');
  }
}

/**
 * Which `Relations` customFieldGroups a read sees.
 *
 * Planka holds a relation cell in one of TWO places: the BOARD-scoped
 * `Relations` group (what fr provisions and what `writeRelationField` writes),
 * or a CARD-scoped `Relations` group owned by the card itself (what the n8n
 * conveyor writes, e.g. doing-orchestrate `Write Requires Relation`
 * scope:"card"). The two groups have different ids.
 *
 * Default (board only) is REQUIRED for every read-modify-write path: those
 * write the board cell and then read it back to detect a clobber. If the read
 * preferred a card-scoped cell, the decision would be made on the card list,
 * the board cell would be overwritten with a COPY of it, and the read-back
 * would see the (unchanged) card value and 409 every time.
 *
 * `scope: 'card'` reads ONLY the card's own `Relations` group(s), for
 * READ-ONLY consumers that must see what the conveyor sees (fr#1400: the
 * one-level `requires` cycle check). It deliberately does not merge: a list
 * field can hold DIFFERENT members in each scope (fr appends board-side, the
 * conveyor writes card-side), so the caller reads both scopes and UNIONS the
 * parsed lists — see `dependenciesThatRequire`. Card-wins would hide every
 * board-only edge, and a missed edge lets a real cycle through.
 */
export interface RelationReadOptions {
  /** Default 'board'. */
  scope?: 'board' | 'card';
}

export interface RelationOps {
  /**
   * Read the card's Relations-group field values. Returns a map of field name
   * → string content. Missing fields return undefined.
   */
  readRelationFields(
    cardId: string,
    opts?: RelationReadOptions,
  ): Promise<Record<string, string | undefined>>;
  /** Write a single Relations-group field value on the card. */
  writeRelationField(cardId: string, fieldName: string, value: string): Promise<void>;
  /**
   * Serialise a read-modify-write of `(cardId, fieldName)` against every other
   * fr writer.
   *
   * REQUIRED, deliberately. It was tempting to make this optional with a
   * no-op default, and that would have reproduced the defect exactly: a
   * silently unlocked read-modify-write that reports success. Making it part
   * of the interface forces every implementation to state its concurrency
   * story out loud.
   */
  withFieldLock: RelationFieldLock;
}

/** What a single list-append actually did. Never inferred by the caller. */
export type AppendOutcome = 'appended' | 'already_present';
/** What a single-valued pointer write actually did. */
export type PointerOutcome = 'written' | 'already_set';

export interface ParentChildLinkResult {
  /** The PARENT's `child_cards` array — the side every consumer reads. */
  parent_child_cards: AppendOutcome;
  /** The CHILD's `parent_card` pointer. */
  child_parent_card: PointerOutcome;
}

export interface RequiresLinkResult {
  dependent_requires: AppendOutcome;
  dependency_required_by: AppendOutcome;
}

/**
 * Append `member` to a JSON string-array relation cell, atomically with
 * respect to every other fr writer.
 *
 * The whole read-modify-write — the read that DECIDES the value, the write,
 * and the read-back that verifies it — happens inside `ops.withFieldLock`.
 * Reading outside the lock and writing inside it would be the same defect with
 * more ceremony: the decision would still be made on stale state.
 *
 * On conflict:
 *   * fr vs fr — no conflict is observable. The loser of the lock blocks until
 *     the winner COMMITs, then reads the winner's value and appends to it.
 *     Both members survive; neither call retries or fails.
 *   * fr vs a writer outside fr — `RelationWriteConflictError` (409). Not
 *     retried; see that class.
 */
async function appendToRelationList(
  ops: RelationOps,
  args: { cardId: string; fieldName: string; member: string },
): Promise<AppendOutcome> {
  const { cardId, fieldName, member } = args;
  return ops.withFieldLock(cardId, fieldName, async (): Promise<AppendOutcome> => {
    const fields = await ops.readRelationFields(cardId);
    // Throws rather than returning [] — see MalformedRelationFieldError.
    const list = parseRelationList(cardId, fieldName, fields[fieldName]);
    if (list.includes(member)) return 'already_present';

    const next = JSON.stringify([...list, member]);
    // Refuse BEFORE the PATCH with the relation-specific error; a truncated
    // JSON array would be a destroyed list.
    if (next.length > PLANKA_CUSTOM_FIELD_MAX_CHARS) {
      throw new RelationFieldCapacityError(cardId, fieldName, next.length);
    }

    await ops.writeRelationField(cardId, fieldName, next);

    // Read-back verification. Planka's PATCH is an unconditional full-cell
    // upsert with no If-Match, so the lock cannot exclude a writer outside fr.
    // This does not prevent such a clobber — it detects it, and turns a
    // silently lost link into a loud 409.
    const after = (await ops.readRelationFields(cardId))[fieldName];
    if (after !== next) {
      throw new RelationWriteConflictError(cardId, fieldName, next, after);
    }
    return 'appended';
  });
}

/**
 * Remove `member` from a JSON string-array relation cell — the compensating
 * write for a link whose card was rolled back. Same lock, same parse-or-refuse
 * and same read-back as `appendToRelationList`; a member that is not there is
 * a no-op ('absent'), so a retry is safe.
 */
export async function removeFromRelationList(
  ops: RelationOps,
  args: { cardId: string; fieldName: string; member: string },
): Promise<'removed' | 'absent'> {
  const { cardId, fieldName, member } = args;
  return ops.withFieldLock(cardId, fieldName, async () => {
    const fields = await ops.readRelationFields(cardId);
    const list = parseRelationList(cardId, fieldName, fields[fieldName]);
    if (!list.includes(member)) return 'absent' as const;
    const next = JSON.stringify(list.filter((m) => m !== member));
    await ops.writeRelationField(cardId, fieldName, next);
    const after = (await ops.readRelationFields(cardId))[fieldName];
    if (after !== next) {
      throw new RelationWriteConflictError(cardId, fieldName, next, after);
    }
    return 'removed' as const;
  });
}

/**
 * Link a parent → child relation idempotently.
 *
 *   - Adds `childId` to parent's `child_cards` array (no-op if already present).
 *   - Sets child's `parent_card` to `parentId` (no-op if already that value).
 *
 * Re-running with the same args performs ZERO writes.
 *
 * Returns what each side actually did, so a caller can report the truth rather
 * than assume it. Throws on malformed existing state, on a lost write, and on
 * a list that no longer fits the cell — see the error classes above.
 */
export async function linkParentChild(
  ops: RelationOps,
  args: { parentId: string; childId: string },
): Promise<ParentChildLinkResult> {
  // The parent's array is the multi-valued side — the one a concurrent spawn
  // can lose, and the one `done-finalize :: Build Dep Check` reads.
  const parentOutcome = await appendToRelationList(ops, {
    cardId: args.parentId,
    fieldName: 'child_cards',
    member: args.childId,
  });

  // `parent_card` is single-valued BY DESIGN (see the multi-parent note at the
  // top of this file): the write is a whole-cell overwrite, not a
  // read-modify-write, so there is no set for a concurrent writer to shrink.
  // Two racing writers leave one of two intended values; neither loses data
  // that the other put there. It therefore needs no lock, and taking one here
  // would mean holding two locks per call and inviting a deadlock ordering
  // problem for nothing.
  const child = await ops.readRelationFields(args.childId);
  if (child.parent_card === args.parentId) {
    return { parent_child_cards: parentOutcome, child_parent_card: 'already_set' };
  }
  await ops.writeRelationField(args.childId, 'parent_card', args.parentId);
  return { parent_child_cards: parentOutcome, child_parent_card: 'written' };
}

/**
 * Link a dependent → dependency relation idempotently.
 *
 *   - Adds `dependencyId` to dependent's `requires` array.
 *   - Adds `dependentId` to dependency's `required_by` array.
 *
 * Both arrays are JSON-encoded strings (Planka customField content is a
 * single string column). Re-running is a no-op.
 *
 * Both sides are multi-valued, so both go through `appendToRelationList`. The
 * two locks are taken SEQUENTIALLY and never nested — the first is released at
 * COMMIT before the second is requested — so no lock-ordering deadlock is
 * possible even when two callers link A→B and B→A at the same instant.
 */
export async function linkRequires(
  ops: RelationOps,
  args: { dependentId: string; dependencyId: string },
): Promise<RequiresLinkResult> {
  const requires = await appendToRelationList(ops, {
    cardId: args.dependentId,
    fieldName: 'requires',
    member: args.dependencyId,
  });
  const requiredBy = await appendToRelationList(ops, {
    cardId: args.dependencyId,
    fieldName: 'required_by',
    member: args.dependentId,
  });
  return { dependent_requires: requires, dependency_required_by: requiredBy };
}

/**
 * Read a JSON-encoded string array out of a customField content cell, or
 * REFUSE.
 *
 * Only one input is treated as "no links": the cell being unset or empty. That
 * is a genuine absence — `relations-defaults.ts` seeds these fields as `'[]'`
 * and a never-touched card has no value row at all.
 *
 * ⚠️ Everything else THROWS, and that is the fix. The previous version mapped
 * non-JSON, non-array and non-string members to `[]` / filtered them out, with
 * the comment "don't throw — old hand-edited cards exist". Tolerating the read
 * was never the problem; the caller then wrote a fresh one-element array back
 * over the cell, so a hand-edited card did not survive the tolerance — it was
 * silently ERASED, under a 200. Non-string members are refused for the same
 * reason: filtering them and writing back drops them permanently.
 *
 * The malformed bytes are carried on the error so the operator can see the
 * evidence. They are never repaired by inference.
 */
export function parseRelationList(
  cardId: string,
  fieldName: string,
  raw: string | undefined,
): string[] {
  if (raw === undefined || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MalformedRelationFieldError(cardId, fieldName, raw, 'not_json');
  }
  if (!Array.isArray(parsed)) {
    throw new MalformedRelationFieldError(cardId, fieldName, raw, 'not_an_array');
  }
  const members: unknown[] = parsed;
  if (!members.every((x): x is string => typeof x === 'string')) {
    throw new MalformedRelationFieldError(
      cardId,
      fieldName,
      raw,
      'non_string_member',
    );
  }
  return members;
}

/**
 * A list-valued relation field read from BOTH Relations scopes (board + the
 * card's own group), parsed, and unioned in first-seen order with duplicates
 * removed. READ-ONLY: never feed this into a write — `writeRelationField`
 * writes the board cell only, so writing a union back would copy card-scoped
 * members into the board cell. A malformed cell in either scope throws
 * MalformedRelationFieldError.
 */
export async function readListAcrossScopes(
  ops: RelationOps,
  cardId: string,
  fieldName: string,
): Promise<string[]> {
  const board = await ops.readRelationFields(cardId);
  const card = await ops.readRelationFields(cardId, { scope: 'card' });
  return [
    ...new Set([
      ...parseRelationList(cardId, fieldName, board[fieldName]),
      ...parseRelationList(cardId, fieldName, card[fieldName]),
    ]),
  ];
}

/**
 * One-level cycle check: the dependencies (of `targetId`) whose OWN `requires`
 * already names `targetId`. Linking target → such a dependency would make each
 * wait for the other forever (todo-pickup never releases either).
 *
 * Only reachable on the dedupe path: a freshly created card id cannot be in
 * anyone's `requires` yet. One level only, and read outside the relation lock
 * — it closes the A↔B re-emit case, not every longer or racing cycle.
 * A malformed `requires` cell throws MalformedRelationFieldError (caller → 409).
 *
 * Reads BOTH Relations scopes and UNIONS them (fr#1400). The conveyor writes
 * `requires` card-scoped, fr appends board-scoped; a board-only read missed
 * most holds, and card-wins would miss the board ones. An extra edge costs a
 * visible 409; a missed edge lets a deadlock through. Same as n8n
 * `todo-pickup :: Read Card Deps` (Set union). Read-only — nothing written.
 */
export async function dependenciesThatRequire(
  ops: RelationOps,
  targetId: string,
  ids: readonly string[],
): Promise<string[]> {
  const cycling: string[] = [];
  for (const id of ids) {
    if ((await readListAcrossScopes(ops, id, 'requires')).includes(targetId)) {
      cycling.push(id);
    }
  }
  return cycling;
}

// ---------- Locks -----------------------------------------------------------

/**
 * The advisory-lock key string for one relation cell.
 *
 * A STRING, hashed by Postgres' `hashtext`, not a registered integer. That puts
 * it in the per-row keyspace `db/advisory-lock-keys.ts:57-69` describes
 * (alongside `domain/engagement/idempotency.ts:70` and
 * `routes/projects.ts:912`) rather than in `LOCK_KEYS`, because there is no
 * fixed set of card ids to register.
 */
export function relationFieldLockKey(cardId: string, fieldName: string): string {
  return `card-relations:${cardId}:${fieldName}`;
}

/**
 * The production lock: a transaction-scoped Postgres advisory lock in fr's own
 * database, shared by every fr-backend replica.
 *
 * BLOCKING, not `try_`. A concurrent spawn must WAIT and then see the other's
 * committed value; a `pg_try_advisory_xact_lock` that returned false would
 * leave the caller to either skip (losing the link — the defect) or retry
 * (racing again).
 *
 * `db` is imported lazily so that importing this module — which the pure
 * unit tests do — does not construct a Postgres client.
 */
export const pgRelationFieldLock: RelationFieldLock = async (
  cardId,
  fieldName,
  fn,
) => {
  const [{ db }, { sql }] = await Promise.all([
    import('../../db/client'),
    import('drizzle-orm'),
  ]);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${relationFieldLockKey(cardId, fieldName)}))`,
    );
    return fn();
  });
};

/**
 * ⛔ TESTS AND SINGLE-PROCESS SCRIPTS ONLY. Never in a request path.
 *
 * A promise-chain mutex keyed on `(cardId, fieldName)`. It serialises callers
 * inside ONE process, which is enough for a test that has no database and for
 * a one-shot backfill script, and is NOT enough for fr-backend: the deployment
 * runs multiple replicas, and two of them holding separate in-process mutexes
 * is exactly the unserialised read-modify-write this file exists to close.
 */
export function inProcessRelationFieldLock(): RelationFieldLock {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(cardId: string, fieldName: string, fn: () => Promise<T>) => {
    const key = relationFieldLockKey(cardId, fieldName);
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain alive on rejection so a failed call does not wedge the key.
    chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next as Promise<T>;
  };
}

// ---------- Adapter: PlankaClient → RelationOps -----------------------------

/**
 * Per-call cache. The Relations customFieldGroup + its fieldIds are resolved
 * once per board and reused across all reads/writes for that board. Card-level
 * values are NOT cached — readRelationFields always fetches fresh state so
 * idempotency checks see the latest values (matters when multiple links to
 * the same parent happen in one request).
 */
export interface PlankaRelationsCache {
  byBoard: Map<string, BoardFieldGroup>;
}

export function newPlankaRelationsCache(): PlankaRelationsCache {
  return { byBoard: new Map() };
}

const RELATIONS_GROUP_NAME = 'Relations';

interface CardCustomFieldValue {
  cardId: string;
  customFieldGroupId: string;
  customFieldId: string;
  content: string;
}

/** A customFieldGroup as GET /api/cards/:id includes it. Exactly one of
 * `boardId` / `cardId` is set: a card-scoped group has `boardId: null`. */
interface CardCustomFieldGroup {
  id: string;
  name: string;
  boardId?: string | null;
  cardId?: string | null;
}

interface CardCustomField {
  id: string;
  name: string;
  customFieldGroupId: string;
}

interface CardDetailWithCustomFields {
  item: unknown;
  included?: {
    customFieldGroups?: CardCustomFieldGroup[];
    customFields?: CardCustomField[];
    customFieldValues?: CardCustomFieldValue[];
  };
}

/**
 * Resolve the Relations customFieldGroup for the board, caching the result.
 */
async function resolveRelationsGroup(
  planka: PlankaClient,
  boardId: string,
  cache: PlankaRelationsCache,
): Promise<BoardFieldGroup> {
  const cached = cache.byBoard.get(boardId);
  if (cached) return cached;
  const groups = await resolveBoardFieldGroups(planka, boardId);
  // A board without the RM template's Relations group reads as no relations
  // and every write is skipped with a warning (v4 ruling 12: fr never creates
  // board fields).
  const relGroup = groups[RELATIONS_GROUP_NAME] ?? { groupId: '', fieldIds: {} };
  cache.byBoard.set(boardId, relGroup);
  return relGroup;
}

/**
 * Build a `RelationOps` backed by a real PlankaClient. Use one cache instance
 * per request — `newPlankaRelationsCache()` is cheap.
 *
 * `lock` defaults to the Postgres advisory lock. It is injectable ONLY so a
 * test can supply the same lock over a stubbed Planka; do not pass
 * `inProcessRelationFieldLock()` from a request path.
 */
export function plankaRelationOps(
  planka: PlankaClient,
  boardId: string,
  cache: PlankaRelationsCache = newPlankaRelationsCache(),
  lock: RelationFieldLock = pgRelationFieldLock,
): RelationOps {
  return {
    withFieldLock: lock,
    async readRelationFields(cardId: string, opts?: RelationReadOptions) {
      const relGroup = await resolveRelationsGroup(planka, boardId, cache);
      // GET /api/cards/:id includes customFieldValues in `included`. Use the
      // card-scoped fetch (cheaper than fetching the whole board).
      const detail = (await planka.http.request(
        'GET',
        `/api/cards/${encodeURIComponent(cardId)}`,
        {},
      )) as CardDetailWithCustomFields;
      const out: Record<string, string | undefined> = {};
      for (const name of Object.keys(relGroup.fieldIds)) out[name] = undefined;

      if (opts?.scope === 'card') {
        // fr#1400 — the card's OWN Relations group(s), resolved from the same
        // response. Only groups owned by THIS card: `included` may carry other
        // cards' groups, and reading those would attribute a foreign relation.
        const cardGroupIds = new Set(
          (detail.included?.customFieldGroups ?? [])
            .filter((g) => g.cardId === cardId && g.name === RELATIONS_GROUP_NAME)
            .map((g) => g.id),
        );
        const cardFieldName = new Map(
          (detail.included?.customFields ?? [])
            .filter((f) => cardGroupIds.has(f.customFieldGroupId))
            .map((f) => [f.id, f.name] as const),
        );
        for (const v of detail.included?.customFieldValues ?? []) {
          if (v.cardId !== cardId || !cardGroupIds.has(v.customFieldGroupId)) continue;
          const name = cardFieldName.get(v.customFieldId);
          if (name) out[name] = String(v.content ?? '');
        }
        return out;
      }

      const idToName = Object.fromEntries(
        Object.entries(relGroup.fieldIds).map(([name, id]) => [id, name]),
      );
      for (const v of detail.included?.customFieldValues ?? []) {
        if (v.cardId !== cardId || v.customFieldGroupId !== relGroup.groupId) continue;
        const name = idToName[v.customFieldId];
        if (name) out[name] = String(v.content ?? '');
      }
      return out;
    },
    async writeRelationField(cardId: string, fieldName: string, value: string) {
      const relGroup = await resolveRelationsGroup(planka, boardId, cache);
      const fieldId = relGroup.fieldIds[fieldName];
      if (!fieldId) {
        warnBoardFieldMissing({
          boardId,
          cardId,
          group: RELATIONS_GROUP_NAME,
          field: fieldName,
          context: 'relations.writeRelationField',
        });
        return;
      }
      await planka.customFields.setCardCustomFieldValue({
        cardId,
        customFieldGroupId: relGroup.groupId,
        customFieldId: fieldId,
        content: value,
      });
    },
  };
}
