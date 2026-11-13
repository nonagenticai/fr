// src/services/mentions/resolver.ts
// Resolve @handle tokens to Planka + Keycloak identities.
//
// Matching order (handle → Planka):
//   1. exact `username` match
//   2. fallback: case-insensitive match on email local-part (before the `@`)
//
// Keycloak lookup order:
//   1. by username
//   2. fallback: by email (using the Planka email we just found)
//
// ⛔ TENANT SCOPE. Planka's /api/users and Keycloak's realm user search are
// both instance-wide: the same @handle can be a different person in another
// tenant. So (a) only members of the card's BOARD are Planka candidates, and
// (b) a Keycloak match is kept only when its `tenant_id` attribute equals the
// card's tenant. An unknown card tenant keeps NO Keycloak match (fail closed).
//
// Keep this module deterministic — do NOT call into WS from here.
import type { PlankaClient } from '../planka';
import { keycloakLookupByUsernameOrEmail } from '../keycloak';

export interface ResolvedMention {
  handle: string;
  plankaUserId?: string;
  keycloakSub?: string;
  email?: string;
}

export interface KeycloakUserLite {
  sub: string;
  email?: string;
  phone?: string;
  /** The user's Keycloak `tenant_id` attribute. Absent ⇒ never matches a tenant. */
  tenantId?: string | null;
}

/** Where the mention was made: the card's board and that board's owning tenant. */
export interface MentionScope {
  boardId: string;
  /** null when fr cannot derive the board's tenant — then no Keycloak match is kept. */
  tenantId: string | null;
}

export async function resolveMentions(
  handles: string[],
  plankaClient: PlankaClient,
  scope: MentionScope,
): Promise<ResolvedMention[]> {
  if (handles.length === 0) return [];

  // Board members only. No board id ⇒ no Planka candidates at all.
  const boardMemberIds = scope.boardId
    ? new Set(
        (await plankaClient.members.listBoardMembers(scope.boardId)).map((m) => m.userId),
      )
    : new Set<string>();
  const plankaUsers =
    boardMemberIds.size === 0
      ? []
      : (await plankaClient.members.listUsers()).filter((u) => boardMemberIds.has(u.id));
  const inTenant = (u: KeycloakUserLite | null): KeycloakUserLite | null =>
    u && scope.tenantId !== null && u.tenantId === scope.tenantId ? u : null;

  const resolved: ResolvedMention[] = [];
  for (const handle of handles) {
    const handleLower = handle.toLowerCase();

    const pkUser =
      plankaUsers.find((u) => u.username === handle) ??
      plankaUsers.find(
        (u) => (u.email?.split('@')[0] ?? '').toLowerCase() === handleLower,
      );

    const plankaUserId = pkUser?.id;
    const plankaEmail = pkUser?.email ?? undefined;

    let kc = inTenant(await keycloakLookupByUsernameOrEmail({ username: handle }));
    if (!kc && plankaEmail) {
      kc = inTenant(await keycloakLookupByUsernameOrEmail({ email: plankaEmail }));
    }

    resolved.push({
      handle,
      plankaUserId,
      keycloakSub: kc?.sub,
      email: kc?.email ?? plankaEmail,
    });
  }
  return resolved;
}
