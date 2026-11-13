// AA Card Substrate Phase 6 — zod schema for the
// `card_generation_request_template.v1` body that workers/n8n submit to
// POST /api/cards/improvement.
//
// Why this schema lives here (next to the substrate) and not under
// /routes: Phase 7 (detector workflow integration) and Phase 8 (backfill
// enhancement) both need to materialise the same shape from non-HTTP
// sources, so the validator is colocated with the other improvement-card
// substrate primitives. The route file is a thin adapter on top.
//
// The shape is intentionally permissive on the optional/expansion fields
// (e.g. `artifacts.uri` is a string, not a strict URL) — workflow nodes
// stuff free-form tracking ids in there and we don't want to wedge a
// production loop on a regex tweak. Required fields are validated
// strictly: every one of the 10 minimums must be present and non-empty.

import { z } from "zod";

import { ScopeLevelSchema } from "../../types/scope-level";

/**
 * A card/project priority in a request body: SHAPE only (a level id or name).
 * The vocabulary is the TENANT's requirements_management priority levels
 * (design "fr consumes RM vocabulary", Q3 = b); every door resolves the value
 * against the owning tenant (services/catalogue/priority-levels.ts) and answers
 * 400 `invalid_priority` with that tenant's levels. ONE declaration, shared by
 * every create/edit door so they cannot drift apart.
 */
export const CardPrioritySchema = z.string().trim().min(1).max(64);

export const CardGenerationRequest = z
  .object({
    // ---- 10 minimum required fields ---------------------------------
    card_type: z.string().min(1),
    project_id: z.string().min(1),
    parent_card_id: z.string().nullable(),
    target_list: z.enum(["TODO", "READY", "DOING", "QA", "BLOCKED", "DONE"]),
    requestor: z.string().min(1),
    problem_statement: z.string().min(1),
    desired_outcome: z.string().min(1),
    success_criteria: z.array(z.string().min(1)).min(1),
    acceptance_criteria: z.array(z.string().min(1)).min(1),
    // One canonical vocabulary, shared with ProjectCreateSchema (types/scope-level.ts).
    // Previously declared inline here, which let the project door drift to an
    // unvalidated free string — see scope-level.ts for the incident.
    scope_level: ScopeLevelSchema,

    // ---- Optional expansion fields ----------------------------------
    priority: CardPrioritySchema.optional(),
    in_scope: z.array(z.string()).optional(),
    out_of_scope: z.array(z.string()).optional(),
    dependencies: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    deadline: z.string().datetime().optional(),
    // ⛔ `stopwatch_policy` was REMOVED 2026-09-27 (vision ruling: "Time is not
    // any factor in the system as all work is pulled based on the WIP limit,
    // not because some clock ticks"). It advertised a deadline contract that
    // nothing ever enforced — its only consumer, scripts/stopwatch-tick.ts, was
    // never deployed. Pre-prod is forward-only: there is no compat shim, and an
    // incoming body that still carries the key is silently stripped by zod's
    // default unknown-key behaviour rather than rejected. Do not re-add it.
    artifacts: z
      .array(
        z.object({
          name: z.string(),
          uri: z.string(),
          type: z.string(),
          description: z.string(),
        }),
      )
      .optional(),
    secret_ids: z.array(z.string()).optional(),
    // Free-form context persisted verbatim into the card description JSON.
    // Accepts a string OR a structured object: the post-contract decomposition
    // approval card (WI-4 slice 2) carries `{ approval_kind, analysis_payload }`
    // here so done-finalize can read the tier child_cards back at DONE time.
    additional_context: z.union([z.string(), z.record(z.unknown())]).optional(),

    // ---- Workflow-internal scoring fields ---------------------------
    // Read by todo_pickup.json's priority sort. Detector populates
    // `detector_severity` from the violation kind; the manual-card paths
    // set `manual_trigger=true`.
    detector_severity: z.enum(["critical", "high", "medium", "low"]).optional(),
    manual_trigger: z.boolean().optional(),

    // ---- Stream binding (system-tenant context) ---------------------
    stream_id: z.string().uuid().optional(),
    stream_slug: z.string().min(1).optional(),
    asset_id: z.string().optional(),
    asset_kind: z.string().optional(),

    // Phase 1.3 closeout — for prompt_improvement / workflow_improvement
    // canary loops: identifies the EXISTING worker being improved. Read by
    // QA's "Resolve next canary version N+1" code node. Persisted on the
    // Metadata customFieldGroup so the n8n router's per-card payload
    // surfaces it as `custom_fields.worker_name`.
    worker_name: z.string().optional(),

    // U11 — the plan the minter computed for this card. On a NEW card it is
    // stored INSERT-ONCE in fr (`card_plan_pins`, migration 148) and the card
    // carries `Metadata.plan_pin = {"store":"fr","sha256":"<hex>"}`. Shape is
    // checked by services/improvement-cards/plan-pin.ts preparePlanPin (422).
    plan_pin: z.record(z.unknown()).optional(),
  });

export type CardGenerationRequestT = z.infer<typeof CardGenerationRequest>;
