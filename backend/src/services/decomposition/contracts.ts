// src/services/decomposition/contracts.ts
//
// Read side of `card_contracts` (migration 128) — split-coherence-design.md §6
// `contracts.get(card_id)`. fr is the AUTHORITY for a card's contract; the
// ```json fence on the Planka description and the custom-field pointers are
// projections of this row.
//
// ONE WRITER: `POST /api/decompositions/commit` (routes/decomposition-commit.ts,
// C1-58), which records one contract per approved project deliverable and binds
// `card_id` after minting. Every other card still reads as "no contract" (404).
// ⚠️ `AA Activity - Integration` self-gates on that 404 (`not_a_split_parent`);
// the commit's children now have contracts, so that gate sees them.

import { and, eq } from 'drizzle-orm';

import { db } from '../../db/client';
import { cardContracts } from '../../db/schema';
import { isUuidShape } from '../../lib/uuid-shape';

export type CardContractRow = typeof cardContracts.$inferSelect;

/** The contract for `cardId` in `tenantId`, or null (absent OR another tenant's — indistinguishable). */
export async function getCardContract(
  cardId: string,
  tenantId: string,
): Promise<CardContractRow | null> {
  if (!isUuidShape(tenantId)) return null;
  const rows = await db
    .select()
    .from(cardContracts)
    .where(and(eq(cardContracts.card_id, cardId), eq(cardContracts.tenant_id, tenantId)))
    .limit(1);
  return rows[0] ?? null;
}
