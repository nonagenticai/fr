// U11 — card plan pins, plan events and the executed-activity log (migration 148).
//
// POST /api/cards/project and POST /api/cards/improvement accept an optional
// `plan_pin` object on CREATE. The FULL plan is stored in fr (`card_plan_pins`,
// one row per Planka card id, insert-once in the DATABASE); the card carries
// only a pointer in `Metadata.plan_pin`:
//
//     {"store":"fr","sha256":"<64 lowercase hex>"}
//
// where sha256 is computed SERVER-SIDE over the canonical JSON of the plan
// (object keys sorted recursively, array order kept) — the same canonicaliser
// and the same pointer shape as B13's version stamp (version-stamp.ts), so the
// two pointers are read the same way. A caller-supplied sha is never trusted.
//
// The pin is the plan the minter computed at mint time. Conformance is judged
// against THIS, never against whatever the plan ConfigMap says at check time.

import { createHash } from 'node:crypto';
import { z } from 'zod';

import { queryClient } from '../../db/client';
import { canonicalJson } from '../improvement/config-hash';

/** Same ceiling as VERSION_STAMP_POINTER_MAX_CHARS (Planka custom field wall). */
export const PLAN_PIN_POINTER_MAX_CHARS = 512;

/** Same cap as VERSION_STAMP_MAX_BYTES: 64 KiB serialised. Declared here, not imported, so the two caps move independently. */
export const PLAN_PIN_MAX_BYTES = 64 * 1024;

/** The Metadata field that carries the pointer. Written once, at mint. */
export const PLAN_PIN_METADATA_FIELD = 'plan_pin';

/**
 * The plan's own per-list keys, lowercase: ncn
 * `AA_IMPLEMENTATION/card_type_descriptions.json` ("plan: per list
 * (todo/ready/doing/qa/blocked/done)") and ncn `workflows/cells/<list>.json`.
 * Migration 148's `card_plan_events_list_check` carries the same set. It is the
 * CLOSED vocabulary for three things: a plan event's `list`, an executed
 * activity's `list`, and the keys of a pin's (or re-plan's) `plan`. Anything
 * else (a display label like `DOING`, a typo) is refused 422 — an unknown key
 * could never be matched against an activity list, so a pin keyed `DOING`
 * would make every doing activity deviate (or, in a re-plan, never govern).
 */
export const PLAN_EVENT_LISTS = ['todo', 'ready', 'doing', 'qa', 'blocked', 'done'] as const;
export type PlanEventList = (typeof PLAN_EVENT_LISTS)[number];
const PLAN_LIST_SET: ReadonlySet<string> = new Set(PLAN_EVENT_LISTS);
export const isPlanEventList = (v: string): v is PlanEventList => PLAN_LIST_SET.has(v);

/**
 * The accepted pin shape. `plan` mirrors the ncn roster cell
 * `card_types[ct].plan[list].activity_sequence` (scripts/lib/card-plan.mjs):
 * one entry per list, each with the ordered activity names the minter
 * computed. Other keys (rule_version, card_type, customisation sha, …) are kept
 * verbatim and covered by the sha. A pin with no readable per-list sequence is
 * refused at mint, because conformance could not be computed against it.
 */
export const PlanPinSchema = z
  .object({
    plan: z
      .record(
        z.string().min(1),
        z
          .object({ activity_sequence: z.array(z.string().min(1)) })
          .passthrough(),
      )
      .refine((p) => Object.keys(p).length > 0, 'plan must name at least one list')
      // Version-agnostic closed key set (zod v4's z.record(z.enum) would demand EVERY key).
      .refine((p) => Object.keys(p).every(isPlanEventList), {
        message: `plan keys must be lists in ${PLAN_EVENT_LISTS.join('/')} (lowercase)`,
      }),
  })
  .passthrough();

export type PlanPin = z.infer<typeof PlanPinSchema>;

export function planPinSerialisedBytes(pin: unknown): number {
  return Buffer.byteLength(JSON.stringify(pin), 'utf8');
}

/** Lowercase hex sha256 of the canonical JSON of the pin. */
export function planPinSha256(pin: unknown): string {
  return createHash('sha256').update(canonicalJson(pin)).digest('hex');
}

/** The serialised pointer written to `Metadata.plan_pin`. */
export function buildPlanPinPointer(sha256: string): string {
  return JSON.stringify({ store: 'fr', sha256 });
}

/** A validated, hashed pin ready to be written; built BEFORE any Planka call. */
export interface PreparedPlanPin {
  plan: PlanPin;
  sha256: string;
  pointer: string;
}

export type PreparePlanPinResult =
  | { ok: true; pin: PreparedPlanPin }
  | { ok: false; status: 422; body: Record<string, unknown> };

/**
 * Validate + size-cap + hash + build the pointer. Pure. Refusals are 422 with
 * nothing written, mirroring B13's version_stamp_too_large /
 * version_stamp_pointer_too_long.
 */
export function preparePlanPin(
  raw: unknown,
  buildPointer: (sha256: string) => string = buildPlanPinPointer,
): PreparePlanPinResult {
  const bytes = planPinSerialisedBytes(raw);
  if (bytes > PLAN_PIN_MAX_BYTES) {
    return {
      ok: false,
      status: 422,
      body: {
        error: 'plan_pin_too_large',
        message: `plan_pin is ${bytes} bytes serialised (UTF-8 JSON); the limit is ${PLAN_PIN_MAX_BYTES} bytes. Nothing was created.`,
        field: 'plan_pin',
        max_bytes: PLAN_PIN_MAX_BYTES,
        bytes,
      },
    };
  }
  const parsed = PlanPinSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      status: 422,
      body: {
        error: 'plan_pin_invalid',
        message: 'plan_pin must be {plan: {<list>: {activity_sequence: string[]}}}. Nothing was created.',
        field: 'plan_pin',
        issues: parsed.error.issues,
      },
    };
  }
  // Hash the ORIGINAL object, not zod's output: passthrough keeps every key,
  // but hashing what the caller sent is the property the pointer certifies.
  const sha256 = planPinSha256(raw);
  const pointer = buildPointer(sha256);
  if (pointer.length > PLAN_PIN_POINTER_MAX_CHARS) {
    return {
      ok: false,
      status: 422,
      body: {
        error: 'plan_pin_pointer_too_long',
        message: `Metadata.plan_pin pointer is ${pointer.length} chars; the ceiling is ${PLAN_PIN_POINTER_MAX_CHARS}. Nothing was created.`,
        max_chars: PLAN_PIN_POINTER_MAX_CHARS,
        length: pointer.length,
      },
    };
  }
  return { ok: true, pin: { plan: raw as PlanPin, sha256, pointer } };
}

/**
 * Insert the pin row for a NEW card. ON CONFLICT (card_id) DO NOTHING — the
 * first pin for a card wins and can never be rewritten (the migration-148
 * trigger refuses UPDATE outright). Returns true when THIS call inserted.
 *
 * ⛔ Refuses an empty card id before touching the DB.
 */
export async function insertPlanPin(args: {
  cardId: string;
  tenantId: string;
  plan: unknown;
  sha256: string;
}): Promise<boolean> {
  if (typeof args.cardId !== 'string' || args.cardId.length === 0) {
    throw new Error('insertPlanPin: refusing to write a pin without a real card_id');
  }
  const rows = await queryClient`
    INSERT INTO card_plan_pins (card_id, tenant_id, plan, plan_sha256)
    VALUES (
      ${args.cardId}::text,
      ${args.tenantId}::uuid,
      ${JSON.stringify(args.plan)}::jsonb,
      ${args.sha256}::text
    )
    ON CONFLICT (card_id) DO NOTHING
    RETURNING card_id
  `;
  return rows.length > 0;
}

export interface PlanPinRow {
  card_id: string;
  tenant_id: string;
  plan: PlanPin;
  plan_sha256: string;
  /**
   * Date from loadPlanPin (display). loadPlanLedger reads it as a microsecond
   * ISO-8601 UTC string so the verdict compares it at postgres precision — a JS
   * Date would truncate to ms and could put a same-millisecond event "after" it.
   */
  created_at: Date | string;
}

/** The pin for a card UNDER THIS TENANT, or null (absent or foreign). */
export async function loadPlanPin(cardId: string, tenantId: string): Promise<PlanPinRow | null> {
  const rows = await queryClient<PlanPinRow[]>`
    SELECT card_id, tenant_id::text AS tenant_id, plan, plan_sha256, created_at
      FROM card_plan_pins
     WHERE card_id = ${cardId}::text
       AND tenant_id = ${tenantId}::uuid
  `;
  return rows[0] ?? null;
}

/**
 * The tenant a card's pin was minted under, as the plan-ledger webhook sees it
 * — ALWAYS scoped to the caller's tenant.
 *
 * ⛔ There is NO unscoped mode. The query always carries
 * `tenant_id = callerTenantId`, so a card pinned under ANOTHER tenant returns
 * null — exactly what an unpinned card returns — and the webhook answers both
 * with the same 409 `card_not_pinned`. An unscoped mode (callerTenantId null ⇒
 * look the pin up by card id alone and file the row under ITS tenant) used to
 * exist for writers that named no tenant; it let any secret holder write into
 * another tenant's card and learn whether a pin existed. Refuses an empty
 * tenant before touching the DB rather than widening the predicate.
 */
export async function loadPlanPinTenant(cardId: string, callerTenantId: string): Promise<string | null> {
  if (typeof callerTenantId !== 'string' || callerTenantId.length === 0) {
    throw new Error('loadPlanPinTenant: refusing an unscoped pin lookup (no tenant)');
  }
  const rows = await queryClient<{ tenant_id: string }[]>`
    SELECT tenant_id::text AS tenant_id
      FROM card_plan_pins
     WHERE card_id = ${cardId}::text
       AND tenant_id = ${callerTenantId}::uuid
  `;
  return rows[0]?.tenant_id ?? null;
}

export const PLAN_EVENT_KINDS = ['split', 'reclassify'] as const;
export const PLAN_EVENT_COMPUTED_BY = ['rule', 'llm'] as const;
export type PlanEventComputedBy = (typeof PLAN_EVENT_COMPUTED_BY)[number];
export type PlanEventKind = (typeof PLAN_EVENT_KINDS)[number];

export interface PlanEventRow {
  id: string;
  card_id: string;
  kind: PlanEventKind;
  computed_by: PlanEventComputedBy;
  list: PlanEventList;
  actor_execution_id: string | null;
  prev_plan_sha: string | null;
  new_plan_sha: string | null;
  detail: Record<string, unknown>;
  /**
   * Caller-supplied (or now()). Never used to ORDER or to decide which plan
   * governs; conformance reads it only for the late-recorded check. Every
   * reader here selects it as a microsecond ISO-8601 UTC string (the same
   * to_char as recorded_at), never as a driver-parsed value: postgres.js hands
   * timestamptz back as a ms-truncated Date OR as raw postgres text depending
   * on which connection serves the query (drizzle swaps the 1184 parser), and
   * comparing either against a µs recorded_at is wrong. Date stays in the type
   * for in-memory callers (unit tests).
   */
  at: string | Date;
  /**
   * Server-stamped (DB DEFAULT now(); no writer sets it). The ONLY clock
   * conformance uses. The ledger reads it as a microsecond ISO-8601 UTC string
   * (`RECORDED_AT_SQL`) so ordering keeps postgres's full precision.
   */
  recorded_at: string | Date;
  /** AA-TRACE §1 join key (UUIDv7) of the writing run; null = orphan. Never read by conformance. */
  trace_id: string | null;
}

export interface ExecutedActivityRow {
  id: string;
  card_id: string;
  list: string;
  pattern: string;
  activity: string;
  execution_id: string | null;
  /**
   * Caller-supplied (or now()). Never used to ORDER or to decide which plan
   * governs; conformance reads it only for the late-recorded check. Every
   * reader here selects it as a microsecond ISO-8601 UTC string (the same
   * to_char as recorded_at), never as a driver-parsed value: postgres.js hands
   * timestamptz back as a ms-truncated Date OR as raw postgres text depending
   * on which connection serves the query (drizzle swaps the 1184 parser), and
   * comparing either against a µs recorded_at is wrong. Date stays in the type
   * for in-memory callers (unit tests).
   */
  at: string | Date;
  /**
   * Server-stamped (DB DEFAULT now(); no writer sets it). The ONLY clock
   * conformance uses. The ledger reads it as a microsecond ISO-8601 UTC string
   * (`RECORDED_AT_SQL`) so ordering keeps postgres's full precision.
   */
  recorded_at: string | Date;
  /** AA-TRACE §1 join key (UUIDv7) of the writing run; null = orphan. Never read by conformance. */
  trace_id: string | null;
}

export async function insertPlanEvent(args: {
  cardId: string;
  tenantId: string;
  kind: PlanEventRow['kind'];
  computedBy: PlanEventComputedBy;
  list: PlanEventList;
  actorExecutionId: string | null;
  prevPlanSha: string | null;
  newPlanSha: string | null;
  detail: Record<string, unknown>;
  /**
   * The caller's ISO-8601 claim; null ⇒ now(). Stored for information only:
   * `recorded_at` is always the DB clock and is never bound from here.
   */
  at: string | null;
  /** Already resolved + validated by lib/aa-trace resolveTraceId; null = orphan. */
  traceId: string | null;
}): Promise<PlanEventRow> {
  const rows = await queryClient<PlanEventRow[]>`
    INSERT INTO card_plan_events
      (card_id, tenant_id, kind, computed_by, list, actor_execution_id, prev_plan_sha, new_plan_sha, detail, at, trace_id)
    VALUES (
      ${args.cardId}::text, ${args.tenantId}::uuid, ${args.kind}::text, ${args.computedBy}::text, ${args.list}::text,
      ${args.actorExecutionId}::text, ${args.prevPlanSha}::text, ${args.newPlanSha}::text,
      ${JSON.stringify(args.detail)}::jsonb, COALESCE(${args.at}::timestamptz, now()), ${args.traceId}::uuid
    )
    RETURNING id::text AS id, card_id, kind, computed_by, list, actor_execution_id,
              prev_plan_sha, new_plan_sha, detail,
              to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, trace_id::text AS trace_id,
              to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at
  `;
  return rows[0]!;
}

export async function insertExecutedActivity(args: {
  cardId: string;
  tenantId: string;
  list: string;
  pattern: string;
  activity: string;
  executionId: string | null;
  /**
   * The caller's ISO-8601 claim; null ⇒ now(). Stored for information only:
   * `recorded_at` is always the DB clock and is never bound from here.
   */
  at: string | null;
  /** Already resolved + validated by lib/aa-trace resolveTraceId; null = orphan. */
  traceId: string | null;
}): Promise<ExecutedActivityRow> {
  const rows = await queryClient<ExecutedActivityRow[]>`
    INSERT INTO card_executed_activities (card_id, tenant_id, list, pattern, activity, execution_id, at, trace_id)
    VALUES (
      ${args.cardId}::text, ${args.tenantId}::uuid, ${args.list}::text, ${args.pattern}::text,
      ${args.activity}::text, ${args.executionId}::text, COALESCE(${args.at}::timestamptz, now()), ${args.traceId}::uuid
    )
    RETURNING id::text AS id, card_id, list, pattern, activity, execution_id,
              to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, trace_id::text AS trace_id,
              to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at
  `;
  return rows[0]!;
}

const RECORDED_AT_FMT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/**
 * Every row the conformance read model needs, all predicated on the tenant.
 * ⛔ ORDER BY the QUALIFIED input columns (`e.recorded_at, e.id`): a bare `id`
 * would resolve to the `id::text` OUTPUT alias and sort "10" before "9".
 * ONE snapshot: the three reads run in a single READ ONLY transaction at
 * REPEATABLE READ, so a row committed between them cannot appear in one read
 * and be missing from another (e.g. an event without the activity it follows).
 * pin.created_at, every recorded_at and every `at` are read at microsecond
 * precision (to_char → ISO-8601 UTC string), never via a driver-parsed value.
 * `SET TRANSACTION` is transaction-scoped (BEGIN ISOLATION LEVEL …), so it is
 * safe through pgbouncer's transaction pooling.
 */
export async function loadPlanLedger(
  cardId: string,
  tenantId: string,
): Promise<{
  pin: PlanPinRow | null;
  events: PlanEventRow[];
  executed: ExecutedActivityRow[];
}> {
  return queryClient.begin('isolation level repeatable read read only', async (tx) => {
    const pins = await tx<PlanPinRow[]>`
      SELECT p.card_id, p.tenant_id::text AS tenant_id, p.plan, p.plan_sha256,
             to_char(p.created_at AT TIME ZONE 'UTC', ${RECORDED_AT_FMT}) AS created_at
        FROM card_plan_pins p
       WHERE p.card_id = ${cardId}::text AND p.tenant_id = ${tenantId}::uuid
    `;
    const events = await tx<PlanEventRow[]>`
      SELECT e.id::text AS id, e.card_id, e.kind, e.computed_by, e.list, e.actor_execution_id,
             e.prev_plan_sha, e.new_plan_sha, e.detail,
             to_char(e.at AT TIME ZONE 'UTC', ${RECORDED_AT_FMT}) AS at, e.trace_id::text AS trace_id,
             to_char(e.recorded_at AT TIME ZONE 'UTC', ${RECORDED_AT_FMT}) AS recorded_at
        FROM card_plan_events e
       WHERE e.card_id = ${cardId}::text AND e.tenant_id = ${tenantId}::uuid
       ORDER BY e.recorded_at, e.id
    `;
    const executed = await tx<ExecutedActivityRow[]>`
      SELECT a.id::text AS id, a.card_id, a.list, a.pattern, a.activity, a.execution_id,
             to_char(a.at AT TIME ZONE 'UTC', ${RECORDED_AT_FMT}) AS at,
             a.trace_id::text AS trace_id,
             to_char(a.recorded_at AT TIME ZONE 'UTC', ${RECORDED_AT_FMT}) AS recorded_at
        FROM card_executed_activities a
       WHERE a.card_id = ${cardId}::text AND a.tenant_id = ${tenantId}::uuid
       ORDER BY a.recorded_at, a.id
    `;
    return { pin: pins[0] ?? null, events: [...events], executed: [...executed] };
  });
}
