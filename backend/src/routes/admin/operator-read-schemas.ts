// src/routes/admin/operator-read-schemas.ts
//
// The query schemas of the super-admin read models GET /api/admin/verification/*
// (routes/admin/verification.ts), moved here verbatim so the fr-agui capability
// declarations (P4c part 1, capabilities/admin/*) share the routes' own schemas.
// ⛔ Side-effect free: zod only.

import { z } from 'zod';

// Upstream bound (api-contract: `days` max 180). Validated here so a bad value
// is fr's 400, not a proxied 422 rendered as "source unavailable".
export const days = z.coerce.number().int().min(1).max(180).optional();

export const daysOnly = z.object({ days });
