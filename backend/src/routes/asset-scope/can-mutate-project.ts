// src/routes/asset-scope/can-mutate-project.ts
//
// The project-member rule of the asset-scope WRITES (block + override at a
// project, Spec 1 §11), ONE definition for both routes (P1-TEAM-a).
//
//   - A member acting in its OWN tenant: any project of that tenant (George
//     2026-10-15). The registered membership provider answers `editor`
//     (agui/tenant-member-provider.ts); the fallback is the shared tenant-scoped
//     seam (`findTenantScopedProject`: the project's own tag == active tenant).
//   - A caller acting OUTSIDE its own tenant (a super-admin `X-Active-Tenant`
//     switched view): only a project it OWNS — the pre-P1-TEAM owner pin, the
//     same rule as `projectWriteSelfScope`. The provider answers a read-only
//     `viewer` there, which is not enough to write; the fallback applies
//     `projectWritableByCaller`.
//
// A role below `editor` never admits a write, whichever provider is registered.

import { db } from '../../db/client';
import { getProjectMembershipProvider } from '../../agui/rbac';
import { findTenantScopedProject, projectWritableByCaller } from '../../lib/project-access';
import { ctxTenantId } from '../../middleware/request-context';
import type { User } from '../../types/api';

export async function canMutateProject(
  projectId: string,
  user: Pick<User, 'id' | 'tenantId' | 'roles' | 'authKind'>,
): Promise<boolean> {
  const role = await getProjectMembershipProvider().getRole(
    projectId,
    user.id,
    ctxTenantId(user.tenantId),
    user.tenantId,
  );
  if (role === 'editor' || role === 'owner') return true;
  const project = await findTenantScopedProject(db, user, projectId);
  return Boolean(project) && projectWritableByCaller(user, project!);
}
