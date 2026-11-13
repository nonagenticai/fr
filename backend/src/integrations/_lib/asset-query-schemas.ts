// Side-effect-free schemas of the requirements_management asset reads (zod only; no
// config, no client).
//
// Moved verbatim out of integrations/{principles,requirements,decisions}.ts
// (fr-agui P4c part 2) so the capability declarations of /api/admin/assets/* can
// describe the SAME query / body the handlers parse: a declaration may not import a
// module that loads config (capabilities/define.ts). The integrations import them
// back; behaviour is unchanged.
import { z } from 'zod';

export const listPrinciplesParamsSchema = z
  .object({
    active_only: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strip();

// `project_id` is a cross-link filter added by Wave 6.10. The generated
// `ListRequirementsParams` type doesn't declare it (orval is strict about
// the OpenAPI spec), but the generated URL builder forwards every defined
// key via URLSearchParams, so we can pass it through transparently.
export const listRequirementsParamsSchema = z
  .object({
    project_id: z.string().optional(),
    bound_to: z.string().uuid().optional(),
    visible_in: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strip();

export const listDecisionsParamsSchema = z
  .object({
    project_id: z.string().optional(),
    card_id: z.string().optional(),
    status: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strip();
