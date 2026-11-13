// src/routes/me/budget-topup-schemas.ts
//
// The `POST /api/me/budget/topup` body schema, side-effect free (zod only) so the
// route (routes/me/budget-topup.ts) and its capability declaration (fr-agui P4b
// part 3, capabilities/account/usage.ts) share ONE schema.
import { z } from 'zod';

// `idempotency_key` is REQUIRED, not optional. This is a money endpoint: an
// unkeyed write cannot be deduped, and an OPTIONAL key is one the caller is free
// to omit on exactly the retry that needed it. Pre-prod is forward-only, so the
// one frontend caller was updated alongside rather than shimmed.
export const TopupBody = z
  .object({
    package_id: z.string().min(1),
    idempotency_key: z.string().min(8).max(200),
  })
  .strict();
