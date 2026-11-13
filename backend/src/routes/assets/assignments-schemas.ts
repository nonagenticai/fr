// src/routes/assets/assignments-schemas.ts
//
// The query schema of GET /api/assets/_assignments (routes/assets/assignments.ts),
// moved here verbatim so the fr-agui capability declaration (P4c part 1,
// capabilities/observe/asset-assignments.ts) shares the route's own schema.
// ⛔ Side-effect free: zod and the drizzle enum declaration only.

import { z } from 'zod';

import { assetType } from '../../db/schema';

// Derived from the `asset_type` pgEnum: the SAME members in the
// SAME order as the hand-copied list this replaced, so the messages below are byte-identical.
export const ASSET_TYPES = assetType.enumValues;

export const QuerySchema = z
  .object({
    type: z.enum(ASSET_TYPES, {
      required_error: `type query param is required (one of: ${ASSET_TYPES.join(', ')})`,
      invalid_type_error: `type query param must be one of: ${ASSET_TYPES.join(', ')}`,
    }),
    scope_kind: z.enum(['workspace', 'department', 'project']).optional(),
    scope_id: z.string().uuid().optional(),
  })
  .refine(
    (q) =>
      q.scope_kind === undefined ||
      q.scope_kind === 'workspace' ||
      typeof q.scope_id === 'string',
    { message: 'scope_id is required when scope_kind is department|project' },
  );
