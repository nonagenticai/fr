// src/routes/workspace/members-schemas.ts
//
// The workspace-member role vocabulary and the grant body, side-effect free (zod
// only) so the route (routes/workspace/members.ts, which re-exports them) and its
// capability declaration (fr-agui P4b part 3, capabilities/account/workspace-members.ts)
// share ONE schema.
import { z } from 'zod';

/**
 * The two roles a workspace admin may hand out — the same two values migration
 * 104's CHECK permits in `user_roles.role`. There is no DB-level `'admin'` role
 * (neither written nor read).
 */
export const WorkspaceRole = z.enum(['workspace-admin', 'workspace-member']);

/**
 * `.strict()` is load-bearing, not stylistic. A workspace admin must not be
 * able to name a tenant; with a permissive schema a `tenant_id` in the body
 * would be silently DROPPED, and the next person who "wires up that field"
 * creates a cross-tenant escalation without ever seeing a test fail. Strict
 * turns the attempt into a 422 today.
 *
 * Exported for tests: the vocabulary and the strictness ARE the contract, and
 * they can be verified without a database.
 */
export const GrantBody = z.object({ role: WorkspaceRole }).strict();
