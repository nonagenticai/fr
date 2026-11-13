// src/services/katas/core.ts
//
// The kata record's state machine (docs/design/kata-super-admin.md §4, amended by the kata build
// contract). EVERY state transition is ONE transaction here, and every transition that enters or
// releases the cord runs inside the instance-cord lock (routes/andon.ts joinKataCordWith /
// leaveKataCordWith), so the invariant below (George 2026-11-04) holds at every commit,
// and `cord_held_seconds += now() - cord_engaged_at` on every release (cord_engaged_at is set
// while held, NULL otherwise).
//
//   running ─▶ qa ─▶ published ─▶ closed
//      ▲       │
//      └───────┘ (qa → running: a QA retry)
//   running | qa ──▶ failed            (fail-twice rule, or a super-admin Stop; KEEPS the cord)
//   published ──▶ failed               (a failure AFTER publish; its cord was already released)
//   failed (holding) ──▶ failed (released)   (super-admin Release only)
//   published | closed ──▶ rolled_back (only after a rollback was requested)
//
// This module holds no external call (Planka, RM, n8n): those live in services/katas/open.ts
// and the route, so every rule here is exercised against a real postgres.
//
// ⛔ GEORGE 2026-11-04: A FAILED KATA KEEPS THE CORD. A failing kata means both the execution
// system and the kata system failed, so a super-admin must look: entering `failed` (the
// fail-twice PATCH, a super-admin Stop, a dead open, a failed first-card move) never releases the
// hold, and nothing releases it on a timer. Only the super-admin Release ({@link releaseFailedKata},
// `POST /api/katas/:id/release`) does, recording who and when. So the invariant is
//
//   the kata's id is in andon_state.kata_holders  ⇔  state ∈ (running, qa)
//                                                   OR (state = failed AND cord_engaged_at IS NOT NULL)
//
// (`cord_engaged_at` is non-NULL exactly while the kata holds).
import { and, desc, eq, gt, inArray, ne, sql, type SQL } from 'drizzle-orm';

import { db } from '../../db/client';
import { andonState, katas, projects, type KataLinkedCard, type KataState } from '../../db/schema';
import { joinKataCordWith, leaveKataCordWith, type AndonDb } from '../../routes/andon';
import { AppError, NotFoundError } from '../../utils/errors';
import { closeRmProjectOrRefuse } from '../catalogue/project-state';

export type KataRow = typeof katas.$inferSelect;

export const KATA_HELD_STATES: ReadonlySet<KataState> = new Set<KataState>(['running', 'qa']);

/** A repeat signature on a kata closed within this window requests its rollback (amendment 7). */
export const KATA_REPEAT_CLOSED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The §4 transitions a PATCH may make. Anything else is 409 `kata_invalid_transition`. */
const ALLOWED: Readonly<Record<KataState, readonly KataState[]>> = {
  running: ['qa', 'failed'],
  qa: ['running', 'published', 'failed'],
  published: ['rolled_back', 'failed'],
  closed: ['rolled_back'],
  failed: [],
  rolled_back: [],
};

export function isKataTransitionAllowed(from: KataState, to: KataState): boolean {
  return ALLOWED[from].includes(to);
}

export function invalidTransition(from: KataState, to: string): AppError {
  return new AppError(409, `A kata in state '${from}' cannot move to '${to}'; nothing changed`, {
    from,
    to,
    allowed: ALLOWED[from],
  }).withCode('kata_invalid_transition');
}

function kataNotFound(): NotFoundError {
  return new NotFoundError('Kata not found').withCode('kata_not_found');
}

/** The SQLSTATE of a postgres.js error, also when drizzle wrapped it. */
function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  if (typeof e?.code === 'string') return e.code;
  return typeof e?.cause?.code === 'string' ? e.cause.code : undefined;
}

function signatureOpenElsewhere(): AppError {
  return new AppError(409, 'Another open kata already has this signature; nothing changed').withCode('kata_signature_open');
}

/** Read the row FOR UPDATE on `tx` (the transition's own connection). */
async function lockKata(tx: AndonDb, id: string): Promise<KataRow> {
  const [row] = await tx.select().from(katas).where(eq(katas.id, id)).for('update').limit(1);
  if (!row) throw kataNotFound();
  return row;
}

/** The release half of the cord accounting, as SET fragments (applied in the same UPDATE). */
const RELEASE_CORD = {
  cord_held_seconds: sql`${katas.cord_held_seconds} + GREATEST(0, COALESCE(EXTRACT(EPOCH FROM (now() - ${katas.cord_engaged_at})), 0))::int`,
  cord_engaged_at: sql`NULL`,
} as const;

// ── reads ───────────────────────────────────────────────────────────────────

export async function readKata(id: string): Promise<KataRow | null> {
  const [row] = await db.select().from(katas).where(eq(katas.id, id)).limit(1);
  return row ?? null;
}

export async function readKataHolderSet(): Promise<Set<string>> {
  const [row] = await db.select({ holders: andonState.kata_holders }).from(andonState).where(eq(andonState.id, 1)).limit(1);
  return new Set((row?.holders ?? []).map((h) => String(h).toLowerCase()));
}

export interface KataCordView {
  held: boolean;
  since: string | null;
}

export function kataCordView(row: KataRow, holders: ReadonlySet<string>): KataCordView {
  const held = holders.has(row.id.toLowerCase());
  return { held, since: held && row.cord_engaged_at ? row.cord_engaged_at.toISOString() : null };
}

export interface KataListFilter {
  state?: KataState;
  project?: string;
  limit?: number;
}

export async function listKataRows(filter: KataListFilter): Promise<KataRow[]> {
  const where: SQL[] = [];
  if (filter.state) where.push(eq(katas.state, filter.state));
  if (filter.project) where.push(eq(katas.source_project_id, filter.project));
  return db
    .select()
    .from(katas)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(katas.opened_at))
    .limit(Math.min(Math.max(filter.limit ?? 200, 1), 500));
}

export interface KataWindowStats {
  opened: number;
  published: number;
  failed: number;
  rolled_back: number;
  paused_seconds: number;
}

/**
 * Totals for katas in a window: each count by its own timestamp, `paused_seconds` = the cord time
 * of katas OPENED in the window (a still-held kata counts its time so far).
 */
export async function kataWindowStats(since: Date): Promise<KataWindowStats> {
  // A raw `sql` template binds through postgres.js, which cannot serialize a JS Date (only
  // drizzle's column-typed builders map it): bind the ISO string, cast in SQL.
  const t = sql`${since.toISOString()}::timestamptz`;
  const rows = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE opened_at >= ${t})::int AS opened,
      count(*) FILTER (WHERE published_at >= ${t})::int AS published,
      count(*) FILTER (WHERE failed_at >= ${t})::int AS failed,
      count(*) FILTER (WHERE rolled_back_at >= ${t})::int AS rolled_back,
      COALESCE(sum(
        cord_held_seconds
        + CASE WHEN cord_engaged_at IS NULL THEN 0
               ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - cord_engaged_at)))::int END
      ) FILTER (WHERE opened_at >= ${t}), 0)::int AS paused_seconds
    FROM katas
    WHERE opened_at >= ${t} OR published_at >= ${t} OR failed_at >= ${t} OR rolled_back_at >= ${t}
  `)) as unknown as Array<Record<string, number>>;
  const r = rows[0] ?? {};
  return {
    opened: Number(r.opened ?? 0),
    published: Number(r.published ?? 0),
    failed: Number(r.failed ?? 0),
    rolled_back: Number(r.rolled_back ?? 0),
    paused_seconds: Number(r.paused_seconds ?? 0),
  };
}

/** The kata holding the cord longest (oldest `cord_engaged_at`), or null. */
export async function holdingKata(holders: ReadonlySet<string>): Promise<{ kata_id: string; since: string | null } | null> {
  if (holders.size === 0) return null;
  const rows = await db
    .select({ id: katas.id, since: katas.cord_engaged_at })
    .from(katas)
    .where(inArray(katas.id, [...holders]))
    .orderBy(katas.cord_engaged_at)
    .limit(1);
  const r = rows[0];
  if (r) return { kata_id: r.id, since: r.since ? r.since.toISOString() : null };
  // A holder with no kata row (e.g. a pre-katas holder): still the truth about the cord.
  return { kata_id: [...holders][0]!, since: null };
}

/** The holders that are FAILED katas (George 2026-11-04: only a super-admin Release frees them). */
export async function failedHolderIds(holders: ReadonlySet<string>): Promise<string[]> {
  if (holders.size === 0) return [];
  const rows = await db
    .select({ id: katas.id })
    .from(katas)
    .where(and(inArray(katas.id, [...holders]), eq(katas.state, 'failed')))
    .orderBy(katas.failed_at);
  return rows.map((r) => r.id);
}

/**
 * Who pauses the conveyor right now: the operator's flag and/or any kata holder (failed ones
 * included). A super-admin hand-open is refused while either is set — kata.open would only queue
 * behind worker=0.
 */
export async function conveyorPause(): Promise<{ operator: boolean; kata_holders: string[] } | null> {
  const [row] = await db
    .select({ engaged: andonState.engaged, holders: andonState.kata_holders })
    .from(andonState)
    .where(eq(andonState.id, 1))
    .limit(1);
  if (!row) return null;
  const holders = (row.holders ?? []).map((h) => String(h).toLowerCase());
  return row.engaged || holders.length > 0 ? { operator: row.engaged, kata_holders: holders } : null;
}

// ── the open decision (one open kata per signature, K1; amendment 7) ───────

export interface LinkCardInput {
  card_id: string;
  board_id?: string | null;
  phase?: string | null;
}

function appendLinkedCard(existing: readonly KataLinkedCard[], card: LinkCardInput | null, now: Date): KataLinkedCard[] {
  const list = [...existing];
  if (!card || list.some((c) => c.card_id === card.card_id)) return list;
  list.push({ card_id: card.card_id, board_id: card.board_id ?? null, phase: card.phase ?? null, linked_at: now.toISOString() });
  return list;
}

export type OpenDecision =
  | { action: 'open' }
  | { action: 'linked'; kata: KataRow }
  | { action: 'rollback_requested'; kata: KataRow; newlyRequested: boolean }
  /** The repeat would roll back, but the rollback guard refuses it (no base / superseded): nothing requested. */
  | { action: 'rollback_refused'; kata: KataRow; refusal: RollbackRefusal }
  | { action: 'stale'; kata: KataRow; reason: string };

/** A running kata whose first card has not reached READY this long after it opened is a dead open. */
export const KATA_CARD_READY_GRACE_MS = 5 * 60 * 1000;

/**
 * Why a RUNNING kata is a dead open (null when it is live): its project was archived (an open's
 * failure path archives it), or its first card never reached READY within the grace (the open
 * died, or could not fail it, after the row committed). Nothing drives such a kata, yet it holds
 * the whole conveyor.
 */
async function staleRunningReason(tx: AndonDb, row: KataRow, now: Date): Promise<string | null> {
  const [p] = await tx.select({ status: projects.status }).from(projects).where(eq(projects.id, row.id)).limit(1);
  if (p?.status === 'archived') return 'its kata project is archived';
  if (row.card_ready_at === null && now.getTime() - row.opened_at.getTime() >= KATA_CARD_READY_GRACE_MS) {
    return `its first card never reached READY within ${KATA_CARD_READY_GRACE_MS / 60000} minutes`;
  }
  return null;
}

/**
 * What a `POST /api/katas` with this signature does, decided on `tx` (which must hold the
 * signature's advisory lock — see {@link withSignatureLock}). Reads the MOST RECENT kata with the
 * signature:
 *   * running, a dead open                → `stale` (nothing written): {@link decideOpenSelfHealing}
 *     fails it, releases the cord and decides again;
 *   * running | qa                        → `linked`: the card joins `linked_cards` (deduped);
 *   * published, or closed < 7 days ago   → `rollback_requested`: the fix did not hold. Sets
 *     `rollback_requested_at` (once) and links the card. The caller posts the rollback webhook
 *     AFTER this commits, while `rollback_delivered_at` is NULL ({@link markRollbackDelivered});
 *   * none, failed, rolled_back, or closed ≥ 7 days ago → `open` a fresh kata.
 */
export async function decideOpen(
  tx: AndonDb,
  signature: string,
  card: LinkCardInput | null,
  now: Date = new Date(),
): Promise<OpenDecision> {
  const [latest] = await tx
    .select()
    .from(katas)
    .where(eq(katas.signature, signature))
    .orderBy(desc(katas.opened_at))
    .for('update')
    .limit(1);
  if (!latest) return { action: 'open' };
  if (latest.state === 'running') {
    const reason = await staleRunningReason(tx, latest, now);
    if (reason) return { action: 'stale', kata: latest, reason };
  }
  if (latest.state === 'running' || latest.state === 'qa') {
    const [kata] = await tx
      .update(katas)
      .set({ linked_cards: appendLinkedCard(latest.linked_cards, card, now), updated_at: now })
      .where(eq(katas.id, latest.id))
      .returning();
    return { action: 'linked', kata: kata! };
  }
  const recentClose =
    latest.state === 'closed' && latest.closed_at !== null && now.getTime() - latest.closed_at.getTime() < KATA_REPEAT_CLOSED_WINDOW_MS;
  if (latest.state === 'published' || recentClose) {
    const newlyRequested = latest.rollback_requested_at === null;
    // The same guard as the super-admin Rollback: a fresh request that would restore nothing, or
    // undo a later fix on the same flow, is refused — recorded on the row, the card linked.
    const refusal = newlyRequested ? await rollbackRefusal(tx, latest) : null;
    if (refusal) {
      const [kata] = await tx
        .update(katas)
        .set({
          linked_cards: appendLinkedCard(latest.linked_cards, card, now),
          rollback_refused_at: now,
          rollback_refused_reason: refusal.code,
          updated_at: now,
        })
        .where(eq(katas.id, latest.id))
        .returning();
      return { action: 'rollback_refused', kata: kata!, refusal };
    }
    const [kata] = await tx
      .update(katas)
      .set({
        linked_cards: appendLinkedCard(latest.linked_cards, card, now),
        ...(newlyRequested ? { rollback_requested_at: now } : {}),
        updated_at: now,
      })
      .where(eq(katas.id, latest.id))
      .returning();
    return { action: 'rollback_requested', kata: kata!, newlyRequested };
  }
  return { action: 'open' };
}

/**
 * Run `fn` holding the signature's TRANSACTION-scoped advisory lock (pgbouncer transaction
 * pooling: never a session lock, and the timeout is `SET LOCAL`, never a session SET). A
 * concurrent open of the same signature WAITS (the coach does not retry, so a 409 here lost the
 * card): the holder's transaction is only the short decision, never the project create. The
 * wait is bounded by `lock_timeout = 10s`; past it, 409 `kata_open_in_progress`, nothing changed.
 */
export const KATA_SIGNATURE_LOCK_TIMEOUT = '10s';

export async function withSignatureLock<T>(signature: string, fn: (tx: AndonDb) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${KATA_SIGNATURE_LOCK_TIMEOUT}'`));
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fr.kata.signature:${signature}`}))`);
      return fn(tx);
    });
  } catch (err) {
    if (pgErrorCode(err) === '55P03') {
      throw new AppError(409, 'A kata with this signature is still being opened; nothing changed. Retry.').withCode('kata_open_in_progress');
    }
    throw err;
  }
}

/**
 * The open decision with the dead-open self-heal: a `stale` running kata is failed, its cord
 * released and its project archived in ONE transaction ({@link failStaleKata}), then the
 * signature is decided again (normally → `open`). Bounded: a heal that keeps finding a stale
 * kata is 409 `kata_open_in_progress` (retryable), never a loop.
 */
export async function decideOpenSelfHealing(
  signature: string,
  card: LinkCardInput | null,
): Promise<Exclude<OpenDecision, { action: 'stale' }>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const d = await withSignatureLock(signature, (tx) => decideOpen(tx, signature, card));
    if (d.action !== 'stale') return d;
    console.error(`[katas] kata ${d.kata.id} is running but is a dead open (${d.reason}); failing it (it keeps the cord until a super-admin releases it)`);
    try {
      await failStaleKata(d.kata.id, `dead open, failed by the next open of its signature: ${d.reason}`);
    } catch (err) {
      // Someone else moved it (another heal, or the kata progressed): decide again.
      if ((err as { code?: unknown })?.code !== 'kata_state_changed') throw err;
    }
  }
  throw new AppError(409, 'A dead kata of this signature could not be cleared; nothing else changed. Retry.').withCode('kata_open_in_progress');
}

/**
 * Every kata archive closes the kata project's RM pm_project first, like every other archive
 * (R351, services/project-archive.ts step 0): an RM failure throws 502 `rm_project_close_failed`
 * and nothing is archived (the caller's transaction rolls back); no RM project ⇒ logged, archived
 * anyway. A project already archived, or gone, is not asked about.
 */
async function closeRmOfKataProject(on: AndonDb, id: string): Promise<void> {
  const [p] = await on
    .select({ id: projects.id, name: projects.name, project_data: projects.project_data })
    .from(projects)
    .where(and(eq(projects.id, id), sql`${projects.status} <> 'archived'`))
    .limit(1);
  if (p) await closeRmProjectOrRefuse(p);
}

/** Archive the kata project on `tx` (status `archived`), when it is not already. */
async function archiveKataProjectOn(tx: AndonDb, id: string): Promise<void> {
  await closeRmOfKataProject(tx, id);
  await tx
    .update(projects)
    .set({ status: 'archived', updated_at: new Date() })
    .where(and(eq(projects.id, id), sql`${projects.status} <> 'archived'`));
}

/**
 * running → failed + kata project archived — ONE transaction. The kata KEEPS the cord (George
 * 2026-11-04): only a super-admin Release frees it.
 */
export async function failStaleKata(id: string, detail: string): Promise<KataChange> {
  // The `failed` transition archives the project (applyPatch); the kata keeps the cord.
  const kata = await db.transaction((tx) => applyPatch(tx, id, { state: 'failed', state_detail: detail }, 'running'));
  return { kata };
}

// ── open: the row + the cord, one transaction ──────────────────────────────

export interface NewKataInput {
  id: string;
  source_project_id: string;
  source_tenant_id: string;
  source_card_id?: string | null;
  source_execution_id?: string | null;
  source_board_id?: string | null;
  source_phase?: string | null;
  symptom: string;
  opened_by: string;
  signature: string;
  root_cause_class?: string | null;
  target_flow?: string | null;
  target_flow_id?: string | null;
  base_version_id?: string | null;
  evidence?: Record<string, unknown>;
  /** The kata project's board and first card (services/katas/open.ts creates the card first). */
  kata_board_id?: string | null;
  kata_card_id?: string | null;
}

/**
 * Insert the kata in `running` AND join the holder set (worker → 0), in one transaction. With a
 * signature it first takes that signature's transaction lock (waiting: a decision holds it only
 * for its one short transaction) and re-checks that no kata of the signature is open (running,
 * qa, published) — a lost race is 409 `kata_signature_open`, as the partial unique index would
 * answer, and nothing changed.
 */
export async function insertRunningKata(input: NewKataInput) {
  try {
    return await joinKataCordWith(input.id, async (tx) => {
      {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fr.kata.signature:${input.signature}`}))`);
        const open = await tx
          .select({ id: katas.id })
          .from(katas)
          .where(and(eq(katas.signature, input.signature), inArray(katas.state, ['running', 'qa', 'published'])))
          .limit(1);
        if (open.length > 0) throw signatureOpenElsewhere();
      }
      const now = new Date();
      const [row] = await tx
        .insert(katas)
        .values({
          id: input.id,
          source_project_id: input.source_project_id,
          source_tenant_id: input.source_tenant_id,
          source_card_id: input.source_card_id ?? null,
          source_execution_id: input.source_execution_id ?? null,
          source_board_id: input.source_board_id ?? null,
          source_phase: input.source_phase ?? null,
          symptom: input.symptom,
          opened_by: input.opened_by,
          signature: input.signature,
          root_cause_class: input.root_cause_class ?? null,
          target_flow: input.target_flow ?? null,
          target_flow_id: input.target_flow_id ?? null,
          base_version_id: input.base_version_id ?? null,
          evidence: input.evidence ?? {},
          kata_board_id: input.kata_board_id ?? null,
          kata_card_id: input.kata_card_id ?? null,
          linked_cards: input.source_card_id
            ? [{ card_id: input.source_card_id, board_id: input.source_board_id ?? null, phase: input.source_phase ?? null, linked_at: now.toISOString() }]
            : [],
          state: 'running',
          opened_at: now,
          cord_engaged_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    });
  } catch (err) {
    if (pgErrorCode(err) === '23505') throw signatureOpenElsewhere();
    throw err;
  }
}

/** Archive the kata project (status `archived`): an open that failed after the project existed. */
export async function archiveKataProjectRow(id: string): Promise<number> {
  await closeRmOfKataProject(db, id);
  const rows = await db
    .update(projects)
    .set({ status: 'archived', updated_at: new Date() })
    .where(and(eq(projects.id, id), sql`${projects.status} <> 'archived'`))
    .returning({ id: projects.id });
  return rows.length;
}

/** The first card reached READY: the open's last step (see {@link staleRunningReason}). */
export async function markKataCardReady(id: string): Promise<void> {
  await db.update(katas).set({ card_ready_at: new Date(), updated_at: new Date() }).where(eq(katas.id, id));
}

// ── PATCH ───────────────────────────────────────────────────────────────────

export interface KataPatch {
  state?: KataState;
  state_detail?: string | null;
  signature?: string;
  root_cause_class?: string | null;
  target_flow?: string | null;
  target_flow_id?: string | null;
  base_version_id?: string | null;
  published_version_id?: string | null;
  replay_passed?: number | null;
  replay_total?: number | null;
  ops?: unknown;
  replays?: unknown;
  linked_card_rerun?: string[];
}

/**
 * What the kata IS — its signature and the flow + base version it changes. Settable only while
 * the kata is `running` (also in the call that moves it on from running); 409 `kata_field_frozen`
 * in any other state, so a later PATCH cannot rewrite a published kata's identity or the version
 * its rollback restores.
 */
const RUNNING_ONLY_FIELDS = ['base_version_id', 'target_flow', 'target_flow_id'] as const;

/** The non-state fields of a patch, as an UPDATE set (only the keys the caller sent). */
function fieldSet(row: KataRow, patch: KataPatch, now: Date): Record<string, unknown> {
  const set: Record<string, unknown> = { updated_at: now };
  for (const k of [
    'state_detail',
    'root_cause_class',
    'target_flow',
    'target_flow_id',
    'base_version_id',
    'published_version_id',
    'replay_passed',
    'replay_total',
    'ops',
    'replays',
  ] as const) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  if (patch.linked_card_rerun && patch.linked_card_rerun.length > 0) {
    const rerun = new Set(patch.linked_card_rerun);
    set.linked_cards = row.linked_cards.map((c) => (rerun.has(c.card_id) && !c.rerun_at ? { ...c, rerun_at: now.toISOString() } : c));
  }
  return set;
}

/** The timestamp a state stamps when entered. */
function stateStamp(to: KataState, now: Date): Record<string, unknown> {
  switch (to) {
    case 'qa':
      return { qa_at: now };
    case 'published':
      return { published_at: now };
    case 'failed':
      return { failed_at: now };
    case 'rolled_back':
      return { rolled_back_at: now };
    default:
      return {};
  }
}

/** Check + apply one patch on a LOCKED row. Throws 409 on an invalid transition. */
async function applyPatch(tx: AndonDb, id: string, patch: KataPatch, expectFrom: KataState): Promise<KataRow> {
  const row = await lockKata(tx, id);
  // The state moved between the caller's read and this lock: decide again (nothing written).
  if (row.state !== expectFrom) throw new AppError(409, 'The kata changed while this update ran; nothing changed. Retry.').withCode('kata_state_changed');
  // The signature is the kata's identity (K1): set once at open, never changed or cleared.
  if (patch.signature !== undefined && patch.signature !== row.signature) {
    throw new AppError(400, "A kata's signature cannot be changed or cleared; nothing changed").withCode('kata_signature_immutable');
  }
  const frozen = RUNNING_ONLY_FIELDS.filter((k) => patch[k] !== undefined);
  if (frozen.length > 0 && row.state !== 'running') {
    throw new AppError(409, `A kata in state '${row.state}' cannot change ${frozen.join(', ')} (only while running); nothing changed`, {
      state: row.state,
      fields: frozen,
    }).withCode('kata_field_frozen');
  }
  const now = new Date();
  const set = fieldSet(row, patch, now);
  const to = patch.state;
  if (to !== undefined && to !== row.state) {
    if (!isKataTransitionAllowed(row.state, to)) throw invalidTransition(row.state, to);
    if (to === 'rolled_back' && row.rollback_requested_at === null) {
      throw new AppError(409, 'No rollback was requested for this kata; nothing changed').withCode('kata_rollback_not_requested');
    }
    if (to === 'published') {
      // A published kata must be rollback-able: the version it replaced AND the one it published.
      const base = patch.base_version_id !== undefined ? patch.base_version_id : row.base_version_id;
      const published = patch.published_version_id !== undefined ? patch.published_version_id : row.published_version_id;
      const missing = [...(base ? [] : ['base_version_id']), ...(published ? [] : ['published_version_id'])];
      if (missing.length > 0) {
        throw new AppError(409, `A kata cannot be published without ${missing.join(' and ')}; nothing changed`, { fields: missing }).withCode(
          'kata_versions_missing',
        );
      }
    }
    Object.assign(set, { state: to }, stateStamp(to, now));
    if (releasesOnTransition(row.state, to)) Object.assign(set, RELEASE_CORD);
  }
  try {
    const [updated] = await tx.update(katas).set(set).where(eq(katas.id, id)).returning();
    // A kata that ENTERS `failed` archives its project in the SAME transaction, whichever path set
    // the state (a conveyor PATCH, Stop, the stale sweep): otherwise the project keeps reading
    // `active` and the UI shows a kata project "Running" forever. It still KEEPS the cord
    // (George 2026-11-04) — archiving touches `projects.status` only.
    if (to === 'failed' && row.state !== 'failed') await archiveKataProjectOn(tx, id);
    return updated!;
  } catch (err) {
    if (pgErrorCode(err) === '23505') throw signatureOpenElsewhere();
    throw err;
  }
}

/** Leaving running/qa releases the cord — EXCEPT into failed, which keeps it (George 2026-11-04). */
function releasesOnTransition(from: KataState, to: KataState): boolean {
  return KATA_HELD_STATES.has(from) && !KATA_HELD_STATES.has(to) && to !== 'failed';
}

export interface KataChange {
  kata: KataRow;
  /** Set when the change released the kata's hold on the cord (publish, or a super-admin Release). */
  cord?: { released: boolean; worker_scaled_up: boolean; worker_scale_error: string | null };
}

/**
 * `PATCH /api/katas/:id`. A patch WITHOUT `state` (or with the current state) updates fields in
 * any state — replays while in qa, `linked_card_rerun` after publish — except the
 * {@link RUNNING_ONLY_FIELDS}, which only a running kata changes. A supplied different
 * `state` is transition-checked; leaving running/qa releases the cord in the SAME transaction.
 */
export async function patchKata(id: string, patch: KataPatch): Promise<KataChange> {
  const current = await readKata(id);
  if (!current) throw kataNotFound();
  const to = patch.state;
  if (to !== undefined && to !== current.state && !isKataTransitionAllowed(current.state, to)) {
    throw invalidTransition(current.state, to);
  }
  const releases = to !== undefined && releasesOnTransition(current.state, to);
  if (releases) {
    const r = await leaveKataCordWith(id, (tx) => applyPatch(tx, id, patch, current.state));
    return { kata: r.result, cord: { released: r.released, worker_scaled_up: r.worker_scaled_up, worker_scale_error: r.worker_scale_error } };
  }
  const kata = await db.transaction((tx) => applyPatch(tx, id, patch, current.state));
  return { kata };
}

/**
 * `POST /api/katas/:id/stop` (super-admin break-glass): running | qa → failed AND the kata project
 * archived (so kata-n8n's flows find the kata out of their stage), ONE transaction. The kata KEEPS
 * the cord (George 2026-11-04); the super-admin releases it with {@link releaseFailedKata}.
 */
export async function stopKata(id: string, by: string): Promise<KataChange> {
  const current = await readKata(id);
  if (!current) throw kataNotFound();
  if (!KATA_HELD_STATES.has(current.state)) throw invalidTransition(current.state, 'failed');
  // The `failed` transition archives the project (applyPatch), in this same transaction.
  const kata = await db.transaction((tx) =>
    applyPatch(tx, id, { state: 'failed', state_detail: `stopped by super-admin ${by}` }, current.state),
  );
  return { kata };
}

/**
 * `POST /api/katas/:id/release` (super-admin only; George 2026-11-04): a FAILED kata lets go of the
 * cord, recorded with who (`cord_released_by`) and when (`cord_released_at`), and its held time
 * accrued. The worker returns to 1 only when nobody else holds — the operator's flag or any other
 * kata ({@link leaveKataCordWith}). 409 `kata_invalid_transition` for a kata that is not failed,
 * 409 `kata_already_released` for one already released.
 */
export async function releaseFailedKata(id: string, by: string): Promise<KataChange> {
  const current = await readKata(id);
  if (!current) throw kataNotFound();
  if (current.state !== 'failed') {
    throw new AppError(409, `Only a failed kata is released by hand; this one is '${current.state}'. Nothing changed`, {
      state: current.state,
    }).withCode('kata_invalid_transition');
  }
  const r = await leaveKataCordWith(id, async (tx) => {
    const row = await lockKata(tx, id);
    if (row.state !== 'failed') throw new AppError(409, 'The kata changed while this release ran; nothing changed. Retry.').withCode('kata_state_changed');
    if (row.cord_released_at !== null) {
      throw new AppError(409, `This kata's cord was already released by ${row.cord_released_by ?? 'someone'}; nothing changed`).withCode(
        'kata_already_released',
      );
    }
    const now = new Date();
    const [updated] = await tx
      .update(katas)
      .set({ ...RELEASE_CORD, cord_released_at: now, cord_released_by: by, updated_at: now })
      .where(eq(katas.id, id))
      .returning();
    return updated!;
  });
  return { kata: r.result, cord: { released: r.released, worker_scaled_up: r.worker_scaled_up, worker_scale_error: r.worker_scale_error } };
}

/**
 * `POST /api/katas/:id/close`: published → closed, and the kata project is archived (status
 * `archived`; no PHI purge — a kata project holds none) in the SAME transaction. Refused while
 * the kata still holds the cord (409 `kata_cord_held`).
 */
export async function closeKata(id: string): Promise<KataRow> {
  return db.transaction(async (tx) => {
    const row = await lockKata(tx, id);
    if (row.state !== 'published') throw invalidTransition(row.state, 'closed');
    const [cord] = await tx.select({ holders: andonState.kata_holders }).from(andonState).where(eq(andonState.id, 1)).limit(1);
    if ((cord?.holders ?? []).map((h) => String(h).toLowerCase()).includes(id.toLowerCase())) {
      throw new AppError(409, 'The kata still holds the conveyor cord; nothing changed').withCode('kata_cord_held');
    }
    const now = new Date();
    await closeRmOfKataProject(tx, id);
    await tx.update(projects).set({ status: 'archived', updated_at: now }).where(eq(projects.id, id));
    const [updated] = await tx.update(katas).set({ state: 'closed', closed_at: now, updated_at: now }).where(eq(katas.id, id)).returning();
    return updated!;
  });
}

/**
 * Mark a rollback REQUESTED (published | closed; the super-admin Rollback, and the coach's repeat
 * signature via {@link decideOpen}). Idempotent: an earlier request keeps its timestamp.
 *
 * Refused (409, nothing changed) when restoring would be wrong: no `base_version_id` to restore
 * (`kata_rollback_no_base`), or a LATER kata published on the same `target_flow`
 * (`kata_rollback_superseded`) — restoring this kata's base would silently undo that fix too.
 */
export async function requestKataRollback(id: string): Promise<{ kata: KataRow; newlyRequested: boolean }> {
  return db.transaction(async (tx) => {
    const row = await lockKata(tx, id);
    if (row.state !== 'published' && row.state !== 'closed') throw invalidTransition(row.state, 'rolled_back');
    const refusal = await rollbackRefusal(tx, row);
    if (refusal) {
      throw new AppError(409, `${refusal.message}; nothing changed`, refusal.later_kata_id ? { later_kata_id: refusal.later_kata_id } : undefined).withCode(
        refusal.code,
      );
    }
    if (row.rollback_requested_at !== null) return { kata: row, newlyRequested: false };
    const now = new Date();
    const [updated] = await tx.update(katas).set({ rollback_requested_at: now, updated_at: now }).where(eq(katas.id, id)).returning();
    return { kata: updated!, newlyRequested: true };
  });
}

export interface RollbackRefusal {
  code: 'kata_rollback_no_base' | 'kata_rollback_superseded';
  message: string;
  later_kata_id?: string;
}

/**
 * Why rolling `row` back would be wrong (null when it is safe): no `base_version_id` to restore,
 * or a kata published LATER (by `published_at`) and still published/closed on the same `target_flow` (restoring this base would silently
 * undo that fix too). One rule for the super-admin Rollback and the coach's repeat.
 */
async function rollbackRefusal(tx: AndonDb, row: KataRow): Promise<RollbackRefusal | null> {
  if (!row.base_version_id) {
    return { code: 'kata_rollback_no_base', message: 'This kata recorded no base version, so there is nothing to roll back to' };
  }
  if (!row.target_flow) return null;
  const [later] = await tx
    .select({ id: katas.id })
    .from(katas)
    .where(
      and(
        eq(katas.target_flow, row.target_flow),
        inArray(katas.state, ['published', 'closed']),
        // Later by PUBLISH time (the order the fixes landed on the flow), not by open time.
        row.published_at ? gt(katas.published_at, row.published_at) : gt(katas.opened_at, row.opened_at),
        ne(katas.id, row.id),
      ),
    )
    .limit(1);
  if (!later) return null;
  return {
    code: 'kata_rollback_superseded',
    message: `A later kata (${later.id}) published on ${row.target_flow}; rolling this one back would undo it`,
    later_kata_id: later.id,
  };
}

/**
 * kata-n8n accepted the `kata.rollback` webhook: stamp `rollback_delivered_at` (once). Until then
 * a coach repeat or a Rollback click resends it. Returns the row.
 */
export async function markRollbackDelivered(id: string): Promise<KataRow> {
  const now = new Date();
  const [row] = await db
    .update(katas)
    .set({ rollback_delivered_at: sql`COALESCE(${katas.rollback_delivered_at}, now())`, updated_at: now })
    .where(eq(katas.id, id))
    .returning();
  if (!row) throw kataNotFound();
  return row;
}

/** Since-UTC-midnight and 7-day windows for the header strip. */
export function kataStatsWindows(now: Date = new Date()): { today: Date; last7d: Date } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { today, last7d: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) };
}

