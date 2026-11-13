// src/lib/service-card-tenant.ts
//
// SERVICE-IDENTITY card-move tenancy (coordinator movies-73, 2026-10-05). The card-move routes
// (POST /api/kanban/cards/:cardId/move, POST /api/assets/kanban/cards/:cardId/move, PATCH
// /api/assets/kanban/cards/:cardId with listId) are called by an n8n SERVICE identity through
// the n8n-nodes-fr `moveCard` op. For such a caller the card's tenant is DERIVED FROM THE CARD
// (its board → project/stream → tenant, `resolveBoardTenant`), NEVER taken from anything the
// caller can assert:
//
//   * every asserted tenant — the request context's header tenant (`X-Tenant-Id` on the
//     orchestrator branch, `X-Active-Tenant`), a raw `X-Tenant-Id` header, the token's
//     `tenant_id` claim — is only COMPARED to the derived owner; any mismatch is refused;
//   * the identity must be entitled to the DERIVED tenant: an `aa-orchestrator` holder (the
//     single system operator, the same trust root the orchestrator header branch rests on) may
//     act for any owner; any other service identity only for the tenant its token claims.
//
// Refusal is the existing idiom: `NotFoundError('Card not found')` — 404-never-403, so a
// foreign card id is indistinguishable from a missing one, and an unresolvable owner fails
// closed. A HUMAN caller never reaches this module (`isServiceIdentity` false): the routes keep
// their existing gate unchanged.

import { tryGetRequestContext } from '../integrations/_lib/context';
import { NotFoundError } from '../utils/errors';
import { resolveBoardTenant as defaultResolveBoardTenant } from './board-tenant-access';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ServiceCaller {
  roles?: readonly string[];
  isServiceAccount?: boolean;
  tenantClaim?: string;
}

function orchestratorRole(): string {
  return process.env.AA_ORCHESTRATOR_ROLE || 'aa-orchestrator';
}

/** A client-credentials token, or the system operator holding the orchestrator role. */
export function isServiceIdentity(user: ServiceCaller): boolean {
  return user.isServiceAccount === true || (user.roles ?? []).includes(orchestratorRole());
}


/** Every tenant the caller ASSERTED on this request (never trusted, only compared). */
export function assertedTenants(req: Request, user: ServiceCaller): string[] {
  const out = new Set<string>();
  const ctx = tryGetRequestContext();
  if (ctx?.activeTenantSource === 'header' && ctx.tenantId) out.add(ctx.tenantId);
  for (const h of ['X-Tenant-Id', 'X-Active-Tenant']) {
    const v = req.headers.get(h);
    if (v && UUID_RE.test(v.trim())) out.add(v.trim());
  }
  // A per-tenant service account's own claim is an assertion too. The orchestrator's claim is
  // its HOME tenant, not a statement about the card, so it is not compared.
  if (user.tenantClaim && !(user.roles ?? []).includes(orchestratorRole())) out.add(user.tenantClaim);
  return [...out];
}

/**
 * Throws NotFoundError unless this SERVICE caller may move a card on `boardId`. Returns the
 * derived owning tenant.
 */
export async function assertServiceCardTenant(
  req: Request,
  user: ServiceCaller,
  boardId: string,
): Promise<string> {
  let owner: string | null;
  try {
    owner = await defaultResolveBoardTenant(boardId);
  } catch {
    owner = null;
  }
  if (!owner) throw new NotFoundError('Card not found');
  const asserted = assertedTenants(req, user);
  if (asserted.some((t) => t !== owner)) throw new NotFoundError('Card not found');
  const isOrchestrator = (user.roles ?? []).includes(orchestratorRole());
  if (!isOrchestrator && user.tenantClaim !== owner) throw new NotFoundError('Card not found');
  return owner;
}
