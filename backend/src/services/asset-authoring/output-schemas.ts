// src/services/asset-authoring/output-schemas.ts
//
// Plan 7 Stage 2.1 — output-schema contracts for the LLM workers backing
// the asset-authoring streams (principle / requirement / decision
// development). The /api/asset-authoring/publish route validates worker
// payloads against these before calling createPrinciple / createRequirement
// / createDecision in src/integrations/.
//
// These are intentionally NOT the full PrincipleIn / RequirementIn /
// DecisionIn shapes from the upstream integrations: they're a minimal
// "patch" shape the LLM is asked to produce, and the route widens to the
// upstream-create payload at call time. Adding fields here is a strict
// addition; tightening rules (e.g. min length, refine) is fine.

import { z } from 'zod';

export const PrinciplePatch = z.object({
  name: z.string().min(1).max(200),
  body: z.string().min(1),
  rationale: z.string().min(1),
  tags: z.array(z.string()).optional(),
});
export type PrinciplePatch = z.infer<typeof PrinciplePatch>;

export const RequirementPatch = z.object({
  name: z.string().min(1).max(200),
  body: z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  tags: z.array(z.string()).optional(),
  derived_from_principle_ids: z.array(z.string()).optional(),
  // Optional so the worker MAY estimate effort; the publish mapper supplies a
  // neutral default when absent (RequirementIn.effort is required upstream).
  effort: z.number().positive().max(999999).optional(),
});
export type RequirementPatch = z.infer<typeof RequirementPatch>;

export const DecisionPatch = z
  .object({
    name: z.string().min(1).max(200),
    body: z.string().min(1),
    considered_options: z.array(z.string().min(1)).min(2),
    chosen_option: z.string().min(1),
    consequences: z.string().min(1),
    derived_from_requirement_ids: z.array(z.string()).optional(),
    // Optional so the worker MAY set the ADR status; the publish mapper
    // defaults to 'proposed' (worker-authored asset surfaces for human accept).
    status: z
      .enum(['proposed', 'accepted', 'deprecated', 'superseded'])
      .optional(),
  })
  .refine((d) => d.considered_options.includes(d.chosen_option), {
    message: 'chosen_option must be one of considered_options',
    path: ['chosen_option'],
  });
export type DecisionPatch = z.infer<typeof DecisionPatch>;
