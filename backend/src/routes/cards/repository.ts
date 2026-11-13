// GET /api/cards/:cardId/repository
//
// "Which repository does this card's work belong to, and if none, WHY none."
//
// ── WHY A SEPARATE ROUTE AND NOT A FIELD ON GET /api/cards/:id ──────────────
//
// The answer costs one `GET /api/cards/:id` per ancestry hop (median chain depth
// ~13, max 27 measured) plus a board-metadata read per distinct board crossed.
// `routes/cards/get.ts` exists to serve the /cards/[id] page in ONE round trip,
// and its own header records the 2026-09-09 OOMKill caused by putting an
// unbounded board read on that path. A 13-hop walk on a page load is the same
// mistake with a different shape. So this is opt-in: the conveyor asks for it
// when it is about to dispatch; the page never does.
//
// ── THE RESPONSE IS ALWAYS 200 WHEN THE CARD IS READABLE ────────────────────
//
// "This card cannot resolve a repository" is a COMPUTED ANSWER, not an error. It
// carries `resolved: false`, a named `reason`, and no `repository_url` key at
// all — so a consumer cannot read a blank and render it as an answer. Reserving
// a 4xx for it would put a real result in the same bucket as an auth refusal and
// a missing card, which is how an honest "no" gets retried as if it were a fault.
//
// The 404s are genuine: a card that does not exist, or one the caller's tenant
// does not own (`assertCardTenantAuthorized` collapses both to the same shape on
// purpose, so a foreign card id cannot be probed for existence).
//
// Envelope: `{data: …}` — one of the four shapes
// fr's response-envelope convention sanctions for a new GET route.

import { validateAuth } from '../../middleware/auth';
import {
  assertCardTenantAuthorized,
  isBoardReadableByCaller,
} from '../../lib/board-tenant-access';
import { jsonResponse } from '../../utils/response';
import { plankaAsAgent } from '../../services/planka/with-auth';
import { db } from '../../db/client';
import {
  dbProjectLookup,
  plankaCardGraphReader,
  resolveCardRepository,
  type CardRepositoryResolution,
} from '../../services/card-repository-resolution';

export async function handleGetCardRepository(
  req: Request,
  cardId: string,
): Promise<Response> {
  const user = await validateAuth(req);

  // Fail-closed, and identical to the gate `GET /api/cards/:id` applies: an
  // unreadable or foreign card is `404 Card not found`, never a resolution.
  await assertCardTenantAuthorized(user, cardId);

  const cards = plankaCardGraphReader(plankaAsAgent());
  const projects = dbProjectLookup(db);

  const resolution: CardRepositoryResolution = await resolveCardRepository(cardId, {
    cards,
    projects,
    // fr row 14d-2: every ancestor hop must be readable by THIS caller — the
    // same platform-aware read predicate as the start-card gate.
    hopAllowed: (boardId: string) => isBoardReadableByCaller(user, boardId),
  });

  return jsonResponse({ data: resolution }, 200);
}
