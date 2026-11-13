/**
 * Query-parameter schemas of the fr KAG read routes (`/api/assets/kag/*`).
 *
 * ⛔ SIDE-EFFECT FREE (zod only). Moved verbatim out of `integrations/kag.ts`
 * so the SAME schema object is both what the route parses with
 * (`parse*Params` in integrations/kag.ts) and what the capability declaration
 * (src/capabilities/kag/assets.ts) derives its OpenAPI parameters from — one
 * schema, so the served spec cannot disagree with the route (fr-agui SPEC §3.4).
 * `integrations/kag.ts` imports config and the http client, which a declaration
 * may not (src/capabilities/define.ts).
 */
import { z } from 'zod';

export const queryGraphNodesParamsSchema = z
  .object({
    label: z.string().optional(),
    properties: z.string().optional(),
  })
  .strip();

export const queryGraphEdgesParamsSchema = z
  .object({
    edge_type: z.string().optional(),
    source_id: z.string().optional(),
    target_id: z.string().optional(),
    properties: z.string().optional(),
  })
  .strip();

export const getGraphStatsParamsSchema = z
  .object({
    include_temporal: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  })
  .strip();

export const listScrapeSessionsParamsSchema = z
  .object({
    status: z.string().optional(),
    limit: z.coerce.number().int().max(1000).optional(),
  })
  .strip();

export const listKagDocumentsParamsSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    project_id: z.string().optional(),
  })
  .strip();
