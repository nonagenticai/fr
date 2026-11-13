// src/services/asset-authoring/patch-to-in.ts
//
// Translation seam for POST /api/asset-authoring/publish.
//
// The LLM asset-authoring workers emit a `*Patch` shape (name / body / …),
// validated in output-schemas.ts. The upstream requirements-management
// create/update integrations take a different `*In` shape (title / statement /
// description / context / decision / effort / …). The publish route USED to
// cast `*Patch as unknown as *In` — an identity compile-time cast with no
// runtime transform — so every required `*In` field was absent on the wire and
// the upstream service 422'd. The three pure mappers below are that missing
// transform: Patch field names → In field names, supplying the required fields
// the Patch shape doesn't carry.
//
// Fields with no `*In` home are intentionally dropped (documented inline); they
// are trace metadata, not load-bearing for a successful create.

import type {
  PrincipleIn,
  RequirementIn,
  DecisionIn,
} from '@fr/service-client-requirements';

import type {
  PrinciplePatch,
  RequirementPatch,
  DecisionPatch,
} from './output-schemas';

/** Neutral default effort — `RequirementIn.effort` is required (>0.001) but the
 *  worker Patch has no effort field. A RICE-style unit is a safe placeholder a
 *  reviewer can re-estimate; it only needs to be a valid positive number. */
export const DEFAULT_REQUIREMENT_EFFORT = 1;

export function principlePatchToIn(p: PrinciplePatch): PrincipleIn {
  return {
    title: p.name,
    statement: p.body,
    rationale: p.rationale,
    tags: p.tags,
  };
}

export function requirementPatchToIn(p: RequirementPatch): RequirementIn {
  // Dropped (no RequirementIn field): `tags`, `derived_from_principle_ids`.
  // `links` is {[k]:string[]} for business_objectives/capabilities/services —
  // semantically wrong for principle refs, so we do not abuse it here.
  return {
    title: p.name,
    description: p.body,
    acceptance: p.acceptance_criteria,
    effort: p.effort ?? DEFAULT_REQUIREMENT_EFFORT,
  };
}

export function decisionPatchToIn(p: DecisionPatch): DecisionIn {
  // Dropped (no DecisionIn field): `derived_from_requirement_ids`
  // (`related_principles` expects principle ids, not requirement ids).
  return {
    title: p.name,
    context: p.body,
    decision: p.chosen_option,
    alternatives: p.considered_options,
    consequences: p.consequences,
    status: p.status ?? 'proposed',
  };
}
