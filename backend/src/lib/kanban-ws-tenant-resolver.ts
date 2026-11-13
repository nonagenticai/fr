// src/lib/kanban-ws-tenant-resolver.ts
//
// fr row 14d-2 — which tenant a kanban WebSocket event / topic belongs to.
//
// A card's tenant is its BOARD's tenant (`resolveBoardTenant`, the single
// board→tenant source of truth, lib/board-tenant-access.ts). A card id alone
// needs one Planka agent read to learn its board. Both answers are cached
// briefly: every kanban write publishes an event, and an uncached path would
// add a DB query (and for card-only events a Planka round trip) per mutation.
//
//   * board → tenant: 60 s TTL. A board changes tenant only when its project /
//     stream row is re-pointed, which is rare and operator-driven.
//   * card → board: 10 min TTL. Planka cards move between lists, not boards,
//     in this estate.
// Both caches are bounded (oldest entry evicted). `null` answers are cached
// for the short TTL too, so an unknown board does not hammer the DB.
//
// Wired into the WebSocketManager by server.ts; websocket.ts stays DB-free.

import { resolveBoardTenant } from './board-tenant-access';
import { plankaAsAgent } from '../services/planka/with-auth';
import type { KanbanTenantResolver } from '../domain/engagement/adapters/websocket';

const BOARD_TTL_MS = 60_000;
const CARD_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 5_000;

type Entry<V> = { value: V; at: number };

function boundedSet<V>(m: Map<string, Entry<V>>, k: string, v: V, at: number): void {
  if (m.size >= MAX_ENTRIES) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
  m.set(k, { value: v, at });
}

export function createKanbanWsTenantResolver(): KanbanTenantResolver {
  const boardTenantOf = (b: string) => resolveBoardTenant(b);
  const cardBoardOf = async (c: string) => (await plankaAsAgent().cards.get(c)).item?.boardId ?? null;
  const boards = new Map<string, Entry<string | null>>();
  const cards = new Map<string, Entry<string | null>>();

  async function boardTenant(boardId: string): Promise<string | null> {
    const hit = boards.get(boardId);
    if (hit && Date.now() - hit.at < BOARD_TTL_MS) return hit.value;
    const v = await boardTenantOf(boardId);
    boundedSet(boards, boardId, v, Date.now());
    return v;
  }

  async function cardTenant(cardId: string): Promise<string | null> {
    const hit = cards.get(cardId);
    let boardId: string | null;
    if (hit && Date.now() - hit.at < CARD_TTL_MS) {
      boardId = hit.value;
    } else {
      boardId = await cardBoardOf(cardId);
      // Only a POSITIVE card→board answer is cached for the long TTL; a miss
      // may be a card created a moment ago.
      if (boardId) boundedSet(cards, cardId, boardId, Date.now());
    }
    return boardId ? boardTenant(boardId) : null;
  }

  return { boardTenant, cardTenant };
}
