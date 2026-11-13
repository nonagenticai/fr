// The body / query schemas of POST and DELETE /api/admin/users/:userId/roles, moved
// verbatim out of routes/admin/user-roles.ts (fr-agui P4c part 2) so the capability
// declarations describe the SAME contract. Side-effect free: zod + utils/tenant only.
import { z } from 'zod';

import { isValidUuid } from '../../utils/tenant';

// `isValidUuid`, not zod's `.uuid()`. The bootstrap/system tenants
// (`00000000-0000-0000-0000-XXXXXXXXXXXX`) carry version nibble 0 and the
// RFC-shaped check rejects them, but they are real rows and `grantRole` accepts
// them — validating more strictly than the service would 422 a grant the
// database would have taken.
const TenantId = z.string().refine(isValidUuid, {
  message: 'tenant_id must be a UUID',
});

// The `role` column is free-form TEXT so a future platform role needs no
// migration. The HTTP surface is deliberately narrower: a typo'd role reaching
// the table is an access grant that gates nothing and looks like access.
export const Role = z.enum(['workspace-admin', 'workspace-member']);

export const GrantBody = z.object({ tenant_id: TenantId, role: Role });

// Revoke is deliberately WIDER than grant. The `role` column is free TEXT, so
// rows exist that this enum can no longer produce — a seeder or an out-of-band
// INSERT wrote them before the enum narrowed. Validating revoke against the
// grant enum made those rows permanent: the UI listed each one with a Revoke
// button that refused it, and the only remedy was hand-written SQL against
// prod. Measured 2026-08-28: 1 such row of 14 (`role:'admin'`, nil-UUID user,
// tenant "AA Trilogy Demo").
//
// You must be able to undo a state you can no longer create. Widening grant
// too would be the actual hazard the enum guards against — a typo'd role
// reaching the table is an access grant that gates nothing and looks like
// access — so grant keeps the strict two-value enum and only revoke accepts
// what is already stored. Revoking a role that does not exist deletes nothing
// and is reported as such, so a permissive value here cannot destroy anything.
// Since migration 104 (`CHECK (role IN ('workspace-admin','workspace-member'))`)
// no such row can exist; a revoke of e.g. 'admin' is a non-admin role that
// takes no guard and no lock, and answers 404 'no such grant'.
const StoredRole = z
  .string()
  .min(1, { message: 'role must not be empty' })
  .max(64, { message: 'role must be at most 64 characters' });

export const RevokeParams = z.object({ tenant_id: TenantId, role: StoredRole });
