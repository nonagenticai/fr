// src/lib/start-events.ts
//
// U-PS-EVT (fr half) — the improvement signals project start emits (PSD §9, F-A6, AT10).
//
// Every event carries ONLY ids and enum codes: `tenant_id`, `project_id`, `template`
// (`template_id@body_hash`), `outline_version`, and a `code` from a CLOSED enum (or, for the
// plan.* events, card ids). Free text never leaves the requester's tenant: the schema is
// `.strict()` (an extra key such as `reason`/`message` is refused, never stripped) and every
// string is pattern-bound, so a sentence cannot ride in a code or an id.
//
// CONSUMPTION RULE (PSD §9): a reader consumes an event only when the event's `tenant_id` is a
// PLATFORM tenant, and only a PLATFORM reader consumes at all (same predicate as CAP §6.3 —
// fr's `isPlatformTenant`). {@link consumableStartEvents} is that filter; any fr route or
// stream that ever exposes these events reads through it.
//
// ⚠️ SCOPE (2026-10-09): fr has NO store or route for these events today (measured: no
// project-events table, no reader). This module is the schema + validator + filter the U-PS-EVT
// emitter (ncn) and the TIM §11.4 sensor bind to; persisting/exposing them is a later unit.

import { z } from 'zod';

import { isPlatformTenant } from '../middleware/internal-tenant-only';

/** PSD §7 — the computed plan-check codes (`start.check_failed`). */
export const START_CHECK_CODES = [
  'template_not_published',
  'template_discriminators_overlap',
  'request_bit_unknown',
  'card_type_unknown',
  'decomposition_deviation:b',
  'decomposition_deviation:c',
  'deliverable_count',
  'deferred_minter_missing',
  'ac_not_checkable',
  'gate_missing',
  'param_unbound',
  'repo_public',
  'repo_unreachable',
  'fence_missing',
  'baseline_red_undeclared',
] as const;

/** PSD §9 — `start.template_question` codes. */
export const TEMPLATE_QUESTION_CODES = ['no_candidate', 'multi_candidate'] as const;

/** PSD §9 — `start.outline_rejected` reject_reason (the requester picks one). */
export const OUTLINE_REJECT_REASONS = [
  'scope_wrong',
  'deliverables_wrong',
  'gates_wrong',
  'estimate_wrong',
  'template_wrong',
  'other',
] as const;

export const START_EVENT_TYPES = [
  'start.template_question',
  'start.param_question',
  'start.check_failed',
  'start.outline_rejected',
  'plan.gap_card',
  'plan.reclassify',
  'plan.split_beyond_plan',
] as const;
export type StartEventType = (typeof START_EVENT_TYPES)[number];

/** `param:<name>` — the name is a template binding slug, never prose. */
const PARAM_CODE = /^param:[a-z][a-z0-9_]{0,63}$/;
/** `template_id@body_hash` (pm TEMPLATE_ID shape relaxed to any slug.slug; sha256 hex). */
const TEMPLATE_REF = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*@[0-9a-f]{64}$/;
/** A Planka card id (numeric snowflake) or an fr-shaped id — ids, never text. */
const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

const Common = {
  tenant_id: z.string().uuid(),
  project_id: z.string().uuid(),
  /** NULL when no template is selected yet (e.g. a no_candidate question). */
  template: z.string().regex(TEMPLATE_REF).nullable(),
  /** NULL before an outline exists. */
  outline_version: z.number().int().min(1).nullable(),
};

/** plan.* events carry card ids only. */
const CardIds = z.array(z.string().regex(CARD_ID)).min(1).max(200);

export const StartEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('start.template_question'), ...Common, code: z.enum(TEMPLATE_QUESTION_CODES) }).strict(),
  z.object({ event: z.literal('start.param_question'), ...Common, code: z.string().regex(PARAM_CODE) }).strict(),
  z.object({ event: z.literal('start.check_failed'), ...Common, code: z.enum(START_CHECK_CODES) }).strict(),
  z.object({ event: z.literal('start.outline_rejected'), ...Common, code: z.enum(OUTLINE_REJECT_REASONS) }).strict(),
  z.object({ event: z.literal('plan.gap_card'), ...Common, card_ids: CardIds }).strict(),
  z.object({ event: z.literal('plan.reclassify'), ...Common, card_ids: CardIds }).strict(),
  z.object({ event: z.literal('plan.split_beyond_plan'), ...Common, card_ids: CardIds }).strict(),
]);
export type StartEvent = z.infer<typeof StartEventSchema>;

export type StartEventValidation =
  | { ok: true; event: StartEvent }
  | { ok: false; issues: z.ZodIssue[] };

/** Validate one event. Free text (an unknown key, a non-enum code, a prose id) is refused. */
export function validateStartEvent(raw: unknown): StartEventValidation {
  const r = StartEventSchema.safeParse(raw);
  return r.success ? { ok: true, event: r.data } : { ok: false, issues: r.error.issues };
}

/**
 * THE consumption filter (PSD §9; AT10). Returns the events `readerTenantId` may consume:
 *   - a NON-platform reader consumes nothing;
 *   - a platform reader consumes only VALID events whose own `tenant_id` is a platform tenant
 *     (a customer tenant's events never cross tenants).
 * Invalid events are dropped (never repaired) and counted, so a producer bug is visible.
 */
export function consumableStartEvents(
  readerTenantId: string | null | undefined,
  raws: readonly unknown[],
): { events: StartEvent[]; dropped: { invalid: number; non_platform_event: number; non_platform_reader: number } } {
  if (!isPlatformTenant(readerTenantId)) {
    return { events: [], dropped: { invalid: 0, non_platform_event: 0, non_platform_reader: raws.length } };
  }
  const events: StartEvent[] = [];
  let invalid = 0;
  let nonPlatform = 0;
  for (const raw of raws) {
    const v = validateStartEvent(raw);
    if (!v.ok) {
      invalid += 1;
      continue;
    }
    if (!isPlatformTenant(v.event.tenant_id)) {
      nonPlatform += 1;
      continue;
    }
    events.push(v.event);
  }
  return { events, dropped: { invalid, non_platform_event: nonPlatform, non_platform_reader: 0 } };
}
