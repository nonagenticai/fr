// src/routes/kanban/break-glass-done.ts
//
//   POST /api/kanban/cards/:cardId/break-glass-done   { listId, reason }   super_admin only
//
// The BREAK-GLASS for the DONE-move guard (services/done-guard.ts; design row #7,
// coordinator ruling: break-glass ALLOWED, but recorded and scored NON-DONE).
//
// A super-admin may move a PROOF-SUBSET card into a DONE-family list without a computed pass,
// ONLY here, and ONLY with a non-blank reason. The route:
//   1. refuses a non-super-admin (403), a blank reason (400 `reason_required`), a destination
//      that is not a DONE-family list (400 `not_a_done_list`) and a card that is not in the
//      proof subset (400 `not_proof_subset` — use the ordinary move);
//   2. keeps the bug-fix PARK guard (a pending bug_fix_authorization still wins: 409);
//   3. writes the append-only `card_done_overrides` audit row (who, when, reason, card,
//      done_by='human_override') BEFORE the Planka move — a DONE nobody recorded is the
//      defect; an audit row for a move that then failed marks a non-DONE card as
//      non-DONE, which is harmless;
//   4. moves the card and answers `{ card, done_kind: 'human_override', override }`.
//
// ⛔ THIS IS NOT DONE. Every fr DONE consumer subtracts cards with an override row
// (services/computed-checks.ts findHumanOverrideCardIds): /api/measure throughput and
// done_current, and the cockpit phase rail. A human authorization is never a substitute for a
// computed check — it is recorded so it can be seen, never counted.

import { z } from 'zod';

import { validateAuth } from '../../middleware/auth';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { ForbiddenError } from '../../utils/errors';
import { jsonResponse } from '../../utils/response';
import { isDoneEquivalentListName } from '../../lib/done-equivalent';
import { isProofSubsetCardType } from '../../domain/engagement/proof-subset';
import { insertDoneOverride } from '../../services/computed-checks';
import { readCardTypeFromPlanka } from '../../services/done-guard';
import { plankaAsAgent } from '../../services/planka/with-auth';
import { PlankaError } from '../../services/planka/errors';
import {
  bugFixAuthorizationPendingBody,
  findBlockingBugFixGate,
} from '../../services/approvals/bug-fix-park-guard';
import { wsManager } from '../../domain/engagement/adapters/websocket';
import { toHttpError } from './_errors';
import { appendPositionOnList } from './cards';

const Body = z.object({
  listId: z.string().min(1),
  reason: z.string().max(2000).optional(),
  position: z.number().optional(),
});

export async function handleBreakGlassDone(req: Request, cardId: string): Promise<Response> {
  const user = await validateAuth(req);
  if (!isSuperAdmin(user)) throw new ForbiddenError('super-admin only');

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return jsonResponse({ error: 'invalid_payload', message: parsed.error.message }, 400);
  const reason = (parsed.data.reason ?? '').trim();
  if (!reason) {
    return jsonResponse(
      { error: 'reason_required', message: 'break-glass DONE requires a non-blank reason; it is audited' },
      400,
    );
  }

  try {
    const listName = (await plankaAsAgent().lists.get(parsed.data.listId))?.name ?? null;
    if (!isDoneEquivalentListName(listName)) {
      return jsonResponse({ error: 'not_a_done_list', list_name: listName }, 400);
    }
    const { boardId, cardType } = await readCardTypeFromPlanka(cardId);
    if (!isProofSubsetCardType(cardType)) {
      return jsonResponse(
        { error: 'not_proof_subset', card_type: cardType, message: 'use POST /api/kanban/cards/:cardId/move' },
        400,
      );
    }
    const gate = await findBlockingBugFixGate({ cardId, destListId: parsed.data.listId });
    if (gate) return jsonResponse(bugFixAuthorizationPendingBody(gate), 409);

    // No position ⇒ the END of the DONE list (as an ordinary move without one), not a fixed 65536
    // that lands the card at the top. Resolved BEFORE the audit row: a failed board read records
    // nothing.
    const position = parsed.data.position ?? (await appendPositionOnList(plankaAsAgent(), boardId, parsed.data.listId, cardId));
    const override = await insertDoneOverride({
      cardId,
      boardId,
      cardType: cardType!,
      actorId: user.id,
      reason,
    });
    console.warn(
      `[break-glass-done] card=${cardId} type=${cardType} actor=${user.id} override=${override.id} ` +
        'done_kind=human_override (scored NON-DONE)',
    );
    const moved = (await plankaAsAgent().cards.move(cardId, { listId: parsed.data.listId, position })) as {
      id: string;
      boardId?: string;
    };
    wsManager.publishKanbanEvent({
      kind: 'card_moved',
      boardId: moved.boardId ?? boardId,
      cardId: moved.id,
      card: moved,
      toListId: parsed.data.listId,
    });
    return jsonResponse({ card: moved, done_kind: 'human_override', override });
  } catch (err) {
    if (err instanceof PlankaError) throw toHttpError(err);
    throw err;
  }
}
