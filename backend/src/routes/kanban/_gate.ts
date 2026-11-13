// src/routes/kanban/_gate.ts
//
// The tenant gates every KEPT kanban route runs BEFORE it touches Planka.
//
// fr acts in Planka as ONE configured account (George 2026-10-10: per tenant,
// not per user), so Planka's own board membership never limits an fr caller —
// these gates are the whole boundary. Each fails CLOSED with a 404 (never 403),
// so a foreign card/list id is indistinguishable from one that does not exist.
//
// A SERVICE identity (n8n-nodes-fr) is gated by `assertServiceCardTenant`: the
// tenant is DERIVED from the board, and any tenant the caller asserts is only
// compared (lib/service-card-tenant.ts) — the same split `handleMoveCard` uses.
import {
  assertCardTenantAuthorized,
  assertCardTenantWritable,
  assertListTenantWritable,
  resolveCardBoardOrRefuse,
  resolveListBoardOrRefuse,
} from '../../lib/board-tenant-access';
import { assertServiceCardTenant, isServiceIdentity } from '../../lib/service-card-tenant';
import type { User } from '../../types/api';

/** Card-keyed WRITE gate (update / duplicate / delete / comment / label attach). */
export async function gateCardWrite(req: Request, user: User, cardId: string): Promise<void> {
  if (isServiceIdentity(user)) {
    await assertServiceCardTenant(req, user, await resolveCardBoardOrRefuse(cardId, 'card_write'));
    return;
  }
  await assertCardTenantWritable(user, cardId);
}

/** Card-keyed READ gate (comment list). A service identity gets the write predicate: it has no read allow. */
export async function gateCardRead(req: Request, user: User, cardId: string): Promise<void> {
  if (isServiceIdentity(user)) {
    await assertServiceCardTenant(req, user, await resolveCardBoardOrRefuse(cardId, 'card_read'));
    return;
  }
  await assertCardTenantAuthorized(user, cardId);
}

/** List-keyed WRITE gate (card create). Resolves the list's board via Planka GET /api/lists/:id. */
export async function gateListWrite(req: Request, user: User, listId: string): Promise<void> {
  if (isServiceIdentity(user)) {
    await assertServiceCardTenant(req, user, await resolveListBoardOrRefuse(listId));
    return;
  }
  await assertListTenantWritable(user, listId);
}
