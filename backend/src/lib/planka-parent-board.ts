// src/lib/planka-parent-board.ts
//
// "Which board is this card / list on?" — the Planka parent lookup behind fr's
// card-binding checks (routes/execution-approvals.ts: fr#1163's JWT door binds
// the gated card to the authorised board). The card→project lookup that the
// retired wip-slot route used is removed with it (2026-10-13).
//
// It answers through the admin agent with one GET (the same read
// routes/cards/get.ts uses). A 404 or ANY error is `null`, and every caller
// treats null as "not yours" — fail closed.

import { PlankaClient } from '../services/planka';
import { PlankaError } from '../services/planka/errors';

export type PlankaParentBoardResolver = (
  kind: 'card' | 'list',
  id: string,
) => Promise<string | null>;

async function getParentId(path: string, field: 'boardId', what: string): Promise<string | null> {
  try {
    const planka = PlankaClient.fromConfig().asAgent();
    const res = (await planka.http.request('GET', path, {})) as {
      item?: Record<string, string | number | null | undefined>;
    };
    const v = res?.item?.[field];
    return v === undefined || v === null || v === '' ? null : String(v);
  } catch (e) {
    if (!(e instanceof PlankaError && e.status === 404)) {
      console.error(`[planka-parent-board] ${what} lookup failed:`, e);
    }
    return null;
  }
}

/** The board a Planka card or list is on, or null (unknown / any error). */
export const defaultParentBoardResolver: PlankaParentBoardResolver = (kind, id) =>
  getParentId(
    `/api/${kind === 'card' ? 'cards' : 'lists'}/${encodeURIComponent(id)}`,
    'boardId',
    `${kind} board (${id})`,
  );
