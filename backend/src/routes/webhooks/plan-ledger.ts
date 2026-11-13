// src/routes/webhooks/plan-ledger.ts
//
// U11 — the two append-only writers behind plan conformance (migration 148):
//
//   POST /api/webhooks/n8n/plan-event         → card_plan_events
//   POST /api/webhooks/n8n/executed-activity  → card_executed_activities
//
// Same auth as POST /api/webhooks/n8n/report (routes/reports.ts): an fr
// licence token ONLY (lib/licence-door.ts `licenceOnly`; the shared
// `X-Webhook-Secret` door was removed, G4 2026-10-10). Tenant handling is STRICTER than the report webhook's,
// because tenant_id is NOT NULL here and the subject is ANOTHER TENANT'S CARD
// as far as an unscoped lookup is concerned:
//
//   * ⛔ `tenant_id` (a uuid) is REQUIRED. Missing or not a uuid ⇒ 400
//     `tenant_id_required`, checked straight after the body is read — before
//     the schema, any lookup or any write. There is NO fallback: no
//     project_id/board_id resolution of a tenant, and no unscoped pin lookup.
//     Both used to exist (a writer that named no tenant, or named a hint that
//     resolved to none, had its row filed under whatever tenant the card's pin
//     carried), which let any secret holder WRITE into another tenant's card
//     and learn whether that card had a pin (201 vs 409).
//   * `project_id` / `board_id` are still accepted, but only as a CONSISTENCY
//     check against `tenant_id`: each one sent must resolve to that same
//     tenant. One that is unknown, or belongs to another tenant, is answered
//     exactly like an unpinned card (409 `card_not_pinned`, same body), so the
//     check is not an oracle for which tenant owns a project or board.
//   * ⛔ the card MUST carry a plan pin UNDER `tenant_id` (loadPlanPinTenant:
//     `card_id = $1 AND tenant_id = $2`, no other mode), or the write is
//     refused 409 `card_not_pinned`, nothing written. A card pinned under
//     ANOTHER tenant is indistinguishable from an unpinned one (same status,
//     body and headers). The ledger row is filed under the pin's tenant, which
//     is therefore always the caller's. Why the pin must exist first: a row
//     written before its pin could carry a tenant the pin is later minted
//     under differently, leaving it invisible to conformance; the pin is
//     minted in the SAME request as the Planka card, so ledger-before-pin is
//     never the legitimate order;
//   * a body that fails the schema (missing `list` included) ⇒ 422
//     `validation_failed` — fr's ValidationError status (utils/errors.ts);
//     a body that is not JSON at all stays 400;
//   * a plan event EXCUSING_PLAN_EVENTS admits (computed_by='rule' at an
//     excusing (kind, list)) RE-PLANS the card, so it must carry the plan it
//     re-plans to: `detail.new_plan` (pin-shaped) AND `new_plan_sha`, with
//     sha256(canonical JSON of new_plan) == new_plan_sha, verified HERE with the
//     pin's own hash. Missing ⇒ 422 `new_plan_required`; malformed ⇒ 422
//     `new_plan_invalid`; mismatched ⇒ 422 `new_plan_sha_mismatch`; nothing
//     written. Non-admitted events (llm, a DOING split, …) record without one.
//   * such an event must also carry `prev_plan_sha` — the sha of the plan it
//     replaces (the pin's, or the previous re-plan's). Missing ⇒ 422
//     `prev_plan_sha_required`. Whether it MATCHES the plan in force is judged
//     by the read model (plan-conformance.ts): a mismatch excuses nothing.
//   * `trace_id` (AA-TRACE §1, UUIDv7): the `X-AA-Trace-Id` header and/or a body
//     `trace_id`, resolved by lib/aa-trace (the report webhook's resolver):
//     malformed ⇒ 422 `trace_id_malformed`, header ≠ body ⇒ 400
//     `trace_id_conflict`, neither ⇒ stored NULL (orphan, never refused). A
//     join key only; conformance never reads it.
//   * `list` (both bodies) and the keys of a pin / `detail.new_plan` are the
//     CLOSED set PLAN_EVENT_LISTS (todo/ready/doing/qa/blocked/done, lowercase);
//     anything else ⇒ 422.
//   * `at` is accepted and stored as the caller's claim, INFORMATIONAL ONLY.
//     Both tables stamp `recorded_at` server-side (DB DEFAULT now()); no field
//     of either body can set it, and conformance orders and governs by it alone.
//
// Both writes are record-only. They never move, gate or halt a card.
//
// LICENCE DOOR (George 2026-10-10, lib/licence-door.ts): the ONLY door. The
// body `tenant_id` MUST be the licence's tenant (403 licence_tenant_mismatch,
// nothing written) — checked right after the 400 above, before the schema or
// any lookup — so the row is always filed under the licence's tenant.

import { z } from 'zod';

import {
  licenceTenantMismatch,
  licenceOnly,
  sameTenant as sameLicenceTenant,
  type LicenceDoor,
} from '../../lib/licence-door';
import { AA_TRACE_HEADER, resolveTraceId } from '../../lib/aa-trace';
import { jsonResponse, createdResponse } from '../../utils/response';
import { resolveReportTenant } from '../reports';
import { planEventCanExcuse } from '../../services/improvement-cards/plan-conformance';
import {
  PLAN_EVENT_COMPUTED_BY,
  PLAN_EVENT_KINDS,
  PLAN_EVENT_LISTS,
  insertExecutedActivity,
  insertPlanEvent,
  loadPlanPinTenant,
  preparePlanPin,
} from '../../services/improvement-cards/plan-pin';

const SHA = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex');
const CARD_ID = z.string().min(1).max(200);

/** REQUIRED on both writers; pre-checked by requireTenantId (400) before the schema runs. */
const TENANT_ID = z.string().uuid();

const TenantHints = {
  /** Format is checked by resolveTraceId (shared with the header), not here. */
  trace_id: z.string().optional(),
  tenant_id: TENANT_ID,
  /** Consistency check only: must resolve to tenant_id, never chooses a tenant. */
  project_id: z.string().uuid().optional(),
  /** Consistency check only: must resolve to tenant_id, never chooses a tenant. */
  board_id: z.string().min(1).optional(),
};

export const PlanEventSchema = z.object({
  card_id: CARD_ID,
  kind: z.enum(PLAN_EVENT_KINDS),
  computed_by: z.enum(PLAN_EVENT_COMPUTED_BY),
  // REQUIRED (RULING 10-01 movies-ab): whether the event can excuse a deviation
  // depends on the list it was emitted from. Missing or unknown ⇒ 422.
  list: z.enum(PLAN_EVENT_LISTS),
  actor_execution_id: z.string().min(1).max(200).optional(),
  prev_plan_sha: SHA.optional(),
  new_plan_sha: SHA.optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
  /** Informational only — never orders or governs anything (recorded_at does). */
  at: z.string().datetime({ offset: true }).optional(),
  ...TenantHints,
});

export const ExecutedActivitySchema = z.object({
  card_id: CARD_ID,
  // CLOSED set, same as a plan event's list and a pin's keys (PLAN_EVENT_LISTS,
  // lowercase). Unknown or upper-case ⇒ 422 validation_failed. Only `doing`
  // activities are logged today (ncn doing-orchestrate); the logger is
  // best-effort, so an OMITTED activity cannot be detected server-side.
  list: z.enum(PLAN_EVENT_LISTS),
  pattern: z.string().min(1).max(200),
  activity: z.string().min(1).max(200),
  execution_id: z.string().min(1).max(200).optional(),
  at: z.string().datetime({ offset: true }).optional(),
  ...TenantHints,
});

type TenantResolution =
  | { ok: true; tenantId: string }
  | { ok: false; response: Response };

/**
 * 400 `tenant_id_required` unless the raw body carries `tenant_id` as a uuid.
 * Runs on the parsed JSON BEFORE the schema, any lookup and any write.
 */
function requireTenantId(body: unknown): Response | null {
  const tenantId =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as { tenant_id?: unknown }).tenant_id
      : undefined;
  if (TENANT_ID.safeParse(tenantId).success) return null;
  return jsonResponse(
    {
      error: 'tenant_id_required',
      message: 'tenant_id (a uuid) is required on plan-ledger writes; there is no fallback. Nothing was written',
    },
    400,
  );
}

/**
 * Licence door: the body `tenant_id` (already proven a uuid by requireTenantId)
 * must be the licence's tenant.
 */
function assertLicenceLedgerTenant(door: LicenceDoor, body: unknown): void {
  const tenantId = (body as { tenant_id?: unknown }).tenant_id;
  if (!sameLicenceTenant(typeof tenantId === 'string' ? tenantId : null, door.tenantId)) {
    throw licenceTenantMismatch('tenant_id');
  }
}

/** The single "no" for every refusal below — byte-identical whatever the cause. */
function cardNotPinned(cardId: string): Response {
  return jsonResponse(
    {
      error: 'card_not_pinned',
      message:
        'this card has no plan pin; plan-ledger rows are filed under the pin\'s tenant and are only accepted once the card is pinned (at mint). Nothing was written',
      card_id: cardId,
    },
    409,
  );
}

const sameTenant = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

/**
 * The tenant a ledger row is filed under: the caller's `tenant_id`, provided
 * every hint sent is CONSISTENT with it and the card is pinned under it. Any
 * other outcome is the one 409 `card_not_pinned`.
 */
async function resolveCardLedgerTenant(body: {
  card_id: string;
  tenant_id: string;
  project_id?: string;
  board_id?: string;
}): Promise<TenantResolution> {
  // Each hint is resolved ON ITS OWN (never as a fallback chain) and must name
  // the caller's tenant. Unknown and foreign read the same: 409.
  if (body.project_id !== undefined) {
    const t = await resolveReportTenant(undefined, body.project_id, undefined);
    if (!sameTenant(t, body.tenant_id)) return { ok: false, response: cardNotPinned(body.card_id) };
  }
  if (body.board_id !== undefined) {
    const t = await resolveReportTenant(undefined, undefined, body.board_id);
    if (!sameTenant(t, body.tenant_id)) return { ok: false, response: cardNotPinned(body.card_id) };
  }
  // Scoped to the caller's tenant: a foreign pin reads as null, i.e. as unpinned.
  const pinTenant = await loadPlanPinTenant(body.card_id, body.tenant_id);
  if (!pinTenant) return { ok: false, response: cardNotPinned(body.card_id) };
  return { ok: true, tenantId: pinTenant };
}

async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false };
  }
}

/**
 * An admitted (excusing) event must carry a verifiable new plan; returns the
 * 422 to send, or null when the event may be recorded.
 */
function checkReplan(b: z.infer<typeof PlanEventSchema>): Response | null {
  if (!planEventCanExcuse(b)) return null;
  const newPlan = b.detail?.new_plan;
  if (newPlan === undefined || newPlan === null || b.new_plan_sha === undefined) {
    return jsonResponse(
      {
        error: 'new_plan_required',
        message:
          'a rule split/reclassify at an excusing list re-plans the card: detail.new_plan and new_plan_sha are both required; nothing was written',
        card_id: b.card_id,
      },
      422,
    );
  }
  if (b.prev_plan_sha === undefined) {
    return jsonResponse(
      {
        error: 'prev_plan_sha_required',
        message:
          'a rule split/reclassify at an excusing list re-plans the card: prev_plan_sha (the sha of the plan it replaces) is required; nothing was written',
        card_id: b.card_id,
      },
      422,
    );
  }
  const prepared = preparePlanPin(newPlan);
  if (!prepared.ok) {
    return jsonResponse(
      { error: 'new_plan_invalid', message: 'detail.new_plan is not a valid plan; nothing was written', card_id: b.card_id, detail: prepared.body },
      422,
    );
  }
  if (prepared.pin.sha256 !== b.new_plan_sha) {
    return jsonResponse(
      {
        error: 'new_plan_sha_mismatch',
        message: 'new_plan_sha is not sha256(canonical JSON of detail.new_plan); nothing was written',
        card_id: b.card_id,
        new_plan_sha: b.new_plan_sha,
        computed_sha: prepared.pin.sha256,
      },
      422,
    );
  }
  return null;
}

/** POST /api/webhooks/n8n/plan-event */
export async function handlePlanEventWebhook(req: Request): Promise<Response> {
  const door = await licenceOnly(req);
  const raw = await readJson(req);
  if (!raw.ok) return jsonResponse({ error: 'validation_failed', issues: [{ message: 'body is not JSON' }] }, 400);
  const noTenant = requireTenantId(raw.body);
  if (noTenant) return noTenant;
  assertLicenceLedgerTenant(door, raw.body);
  const parsed = PlanEventSchema.safeParse(raw.body);
  if (!parsed.success) {
    return jsonResponse({ error: 'validation_failed', issues: parsed.error.issues }, 422);
  }
  const b = parsed.data;
  const traceId = resolveTraceId(req.headers.get(AA_TRACE_HEADER), b.trace_id);
  const planRefusal = checkReplan(b);
  if (planRefusal) return planRefusal;
  const tenant = await resolveCardLedgerTenant(b);
  if (!tenant.ok) return tenant.response;
  const row = await insertPlanEvent({
    cardId: b.card_id,
    tenantId: tenant.tenantId,
    kind: b.kind,
    computedBy: b.computed_by,
    list: b.list,
    actorExecutionId: b.actor_execution_id ?? null,
    prevPlanSha: b.prev_plan_sha ?? null,
    newPlanSha: b.new_plan_sha ?? null,
    detail: b.detail ?? {},
    at: b.at ?? null,
    traceId,
  });
  return createdResponse({
    id: row.id,
    card_id: row.card_id,
    kind: row.kind,
    computed_by: row.computed_by,
    list: row.list,
    at: row.at,
    recorded_at: row.recorded_at,
    trace_id: row.trace_id,
  });
}

/** POST /api/webhooks/n8n/executed-activity */
export async function handleExecutedActivityWebhook(req: Request): Promise<Response> {
  const door = await licenceOnly(req);
  const raw = await readJson(req);
  if (!raw.ok) return jsonResponse({ error: 'validation_failed', issues: [{ message: 'body is not JSON' }] }, 400);
  const noTenant = requireTenantId(raw.body);
  if (noTenant) return noTenant;
  assertLicenceLedgerTenant(door, raw.body);
  const parsed = ExecutedActivitySchema.safeParse(raw.body);
  if (!parsed.success) {
    return jsonResponse({ error: 'validation_failed', issues: parsed.error.issues }, 422);
  }
  const b = parsed.data;
  const traceId = resolveTraceId(req.headers.get(AA_TRACE_HEADER), b.trace_id);
  const tenant = await resolveCardLedgerTenant(b);
  if (!tenant.ok) return tenant.response;
  const row = await insertExecutedActivity({
    cardId: b.card_id,
    tenantId: tenant.tenantId,
    list: b.list,
    pattern: b.pattern,
    activity: b.activity,
    executionId: b.execution_id ?? null,
    at: b.at ?? null,
    traceId,
  });
  return createdResponse({
    id: row.id,
    card_id: row.card_id,
    list: row.list,
    activity: row.activity,
    at: row.at,
    recorded_at: row.recorded_at,
    trace_id: row.trace_id,
  });
}
