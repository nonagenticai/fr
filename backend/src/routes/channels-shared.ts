// src/routes/channels-shared.ts
//
// Shared schema for channels, so the human-authored route
// (routes/channels.ts) and the n8n internal-create route
// (routes/assets/internal-create.ts) stay in lockstep. Mirrors the
// scheduled-triggers-shared.ts pattern: the two callers differ only in
// their authz gate and origin provenance; the create body shape + kind
// enum live here so they can't drift.

import { z } from 'zod';

import type { ChannelKind } from '../services/channels-registry';

export const ChannelKindEnum = z.enum([
  'teams',
  'email',
  'web',
  'inapp',
  'voice',
]) satisfies z.ZodType<ChannelKind>;

// Shared channel create body. The human route extends this with the
// optional `tenant_id` workspace alias (the FE sends it once it carries
// multi-workspace state); the n8n internal-create path uses it as-is —
// the SA token's tenant is authoritative there.
export const ChannelCreateSchema = z
  .object({
    kind: ChannelKindEnum,
    name: z.string().min(1).max(200),
    dept_id: z.string().uuid().optional().nullable(),
    config: z.record(z.unknown()).optional(),
    credentials: z.string().min(1).max(8192).optional().nullable(),
  })
  .strip();

export type ChannelCreateBody = z.infer<typeof ChannelCreateSchema>;

// The HUMAN route's bodies (routes/channels.ts), shared with the fr-agui P4b
// capability declarations (capabilities/settings/channels.ts).
//
// `tenant_id` is accepted on input as an alias for the workspace id, but
// the route always resolves the effective workspace from `ctxTenantId(user.tenantId)`
// — clients can't create cross-tenant rows by supplying a different id.
// Including it in the schema keeps the FE wrapper's payload (which sends
// `tenant_id` only when the FE eventually carries multi-workspace state)
// from being rejected as `unrecognized_keys`. The internal-create path
// doesn't accept it (the SA token's tenant is authoritative), so it's added
// here on the human schema only.
export const CreateBodySchema = ChannelCreateSchema.extend({
  tenant_id: z.string().uuid().optional(),
}).strip();

export const UpdateBodySchema = z
  .object({
    kind: ChannelKindEnum.optional(),
    name: z.string().min(1).max(200).optional(),
    dept_id: z.string().uuid().nullable().optional(),
    config: z.record(z.unknown()).optional(),
    credentials: z.string().min(1).max(8192).nullable().optional(),
  })
  .strip();
