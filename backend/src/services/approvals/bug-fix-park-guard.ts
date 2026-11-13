// src/services/approvals/bug-fix-park-guard.ts
//
// Guard 2 of the bug-fix PARK design. A card that raised a MARKED
// (`metadata.approval_kind = 'bug_fix_authorization'`) approval is parked in BLOCKED until
// that gate is decided. The ONLY sanctioned exit is the gate's decision callback. Three fr
// routes call `findBlockingBugFixGate` and answer 409 `{ error: 'bug_fix_authorization_pending',
// approval_id }` when it returns an id:
//   - `POST /api/kanban/cards/:cardId/move` (routes/kanban/cards.ts);
//   - `POST /api/assets/kanban/cards/:cardId/move` (routes/assets/kanban.ts);
//   - `PATCH /api/assets/kanban/cards/:cardId` (routes/assets/kanban.ts) when its raw
//     passthrough body carries `listId` — it reaches the same Planka PATCH /api/cards/:id.
// (`PATCH /api/kanban/cards/:cardId` needs no check: its zod body has no listId and strips it.)
//
// Refused: a move whose SOURCE list is BLOCKED and whose DESTINATION is any non-BLOCKED list
// — TODO / READY / DOING, and DONE too (DONE is reached only through the callback's approved
// path), while the card holds a PENDING marked approval in the card's OWN tenant.
// Allowed, exactly as before: every card without such a row; a BLOCKED→BLOCKED reposition; a
// move with no destination list; a row that is approved / rejected / expired / voided; an
// UNMARKED pending approval; a marked pending row in ANOTHER tenant.
//
// AUTHORITY: the approvals table, never the card's Runtime State / block_reason.
//
// TENANT: the card's tenant is its BOARD's owning tenant (`resolveBoardTenant`), derived
// server-side from fr's own projects/streams tables. Nothing caller-supplied is read.
//
// COST: the normal path is ONE indexed DB read (card_id + pending + marker) and NO Planka
// call. Planka is consulted (card location, list names) only when a pending marked row exists
// for this card id. A lookup failure propagates (the route fails closed), never a silent allow.

import { and, eq, sql } from 'drizzle-orm';

import { approvals, db } from '../../db/client';
import { resolveBoardTenant } from '../../lib/board-tenant-access';
import { isBlocked } from '../../lib/phase';
import { plankaAsAgent } from '../planka/with-auth';
import { BUG_FIX_AUTHORIZATION_MARKER } from './u3-gates';

const BUG_FIX_AUTHORIZATION_PENDING = 'bug_fix_authorization_pending' as const;

type PendingMarkedGate = { id: string; tenant_id: string };
type CardLocation = { boardId: string; listId: string };

/** PENDING rows carrying the marker (any kind) whose `card_id` is this card. */
async function findPendingMarkedGates(cardId: string): Promise<PendingMarkedGate[]> {
  return db
    .select({ id: approvals.id, tenant_id: approvals.tenant_id })
    .from(approvals)
    .where(
      and(
        eq(approvals.card_id, cardId),
        eq(approvals.status, 'pending'),
        sql`${approvals.metadata} ->> 'approval_kind' = ${BUG_FIX_AUTHORIZATION_MARKER}`,
      ),
    );
}

async function getCardLocation(cardId: string): Promise<CardLocation> {
  const card = await plankaAsAgent().cards.get(cardId);
  return { boardId: card.item.boardId, listId: card.item.listId };
}

async function getListName(listId: string): Promise<string | null> {
  const list = await plankaAsAgent().lists.get(listId);
  return list?.name ?? null;
}

/**
 * The id of the pending marked approval that forbids this move, or null when the move is
 * allowed. `known` is the card's current location when the route already holds it (saves a
 * Planka read on the gated path); otherwise it is read lazily.
 */
export async function findBlockingBugFixGate(input: {
  cardId: string;
  destListId: string | undefined | null;
  known?: Partial<CardLocation>;
}): Promise<string | null> {
  const rows = await findPendingMarkedGates(input.cardId);
  if (rows.length === 0) return null;

  const loc: CardLocation =
    input.known?.boardId && input.known?.listId
      ? { boardId: input.known.boardId, listId: input.known.listId }
      : await getCardLocation(input.cardId);

  const cardTenant = await resolveBoardTenant(loc.boardId);
  if (!cardTenant) return null;
  const gate = rows.find((r) => r.tenant_id === cardTenant);
  if (!gate) return null;

  // Only a move OUT of BLOCKED is refused.
  if (!input.destListId || input.destListId === loc.listId) return null;
  if (!isBlocked(await getListName(loc.listId))) return null;
  if (isBlocked(await getListName(input.destListId))) return null;
  return gate.id;
}

export function bugFixAuthorizationPendingBody(approvalId: string): {
  error: typeof BUG_FIX_AUTHORIZATION_PENDING;
  approval_id: string;
} {
  return { error: BUG_FIX_AUTHORIZATION_PENDING, approval_id: approvalId };
}
