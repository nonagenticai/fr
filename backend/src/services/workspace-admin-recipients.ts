// src/services/workspace-admin-recipients.ts
//
// "Who are this workspace's admins?" for NOTIFICATION / APPROVER lists.
//
// Authorization gates answer "is THIS user an admin of T" from the signed
// token (`services/user-roles.ts :: isWorkspaceAdminVia`), which includes the
// Keycloak realm role `tenant_admin` pinned to the raw `tenant_id` claim. A
// recipient list cannot read anybody's token, so it has to ask the directory:
// the union of
//   1. `user_roles` rows with role `workspace-admin` in T, and
//   2. Keycloak users holding realm role `tenant_admin` whose `tenant_id`
//      attribute is T (`keycloak.listRealmTenantAdminIds`).
//
// DB ids come first (stable, the pre-existing order), then directory ids not
// already present. Deduped by user id.
//
// FAIL-SOFT on the directory half only: a Keycloak outage degrades to the DB
// list and is RETURNED as `realmError` (and reported), so a caller whose DB
// list is empty can tell "nobody to notify" from "could not ask" — the two
// must not collapse into the same silent 200. A DB failure still throws, as
// `listUsersByRole` always did.

import { listUsersByRole } from './user-roles';
import { keycloak } from './keycloak';
import { reportSwallowedFailure } from '../integrations/_lib/errors';

export interface WorkspaceAdminRecipients {
  userIds: string[];
  /** Set when the Keycloak half could not be read; `userIds` is then DB-only. */
  realmError?: unknown;
}

export async function listWorkspaceAdminRecipients(
  tenantId: string,
): Promise<WorkspaceAdminRecipients> {
  const dbIds = await listUsersByRole(tenantId, 'workspace-admin');
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of dbIds) add(id);

  try {
    for (const id of await keycloak.listRealmTenantAdminIds(tenantId)) add(id);
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'keycloak',
      method: 'GET',
      // Fallback only: an IntegrationError from listRealmTenantAdminIds carries its
      // own path (users search or per-user role-mappings), which wins.
      path: '/admin/realms/{realm}/users?q=tenant_id:{tenant}',
      degradedTo: `workspace-admin recipients for tenant ${tenantId} = user_roles only (${dbIds.length})`,
    });
    return { userIds: out, realmError: err };
  }
  return { userIds: out };
}
