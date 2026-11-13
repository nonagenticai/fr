// src/routes/kanban/labels.ts
// Attach / detach an EXISTING board label on a card. Label create/update/delete
// were removed (George 2026-10-10: fr's kanban proxy is trimmed to the conveyor
// operations; users manage labels in their own Planka).
//
// Note: Planka's detach URL uses a matrix-param shape
// (`/api/cards/:cardId/card-labels/labelId:<id>`). That quirk is handled
// inside the plankaClient LabelsResource — the FR HTTP layer exposes the
// clean RESTish path `/api/kanban/cards/:cardId/labels/:labelId`.
import { validateAuthWithToken } from '../../middleware/auth';
import { plankaAsAgent } from '../../services/planka/with-auth';
import type { PlankaClient } from '../../services/planka';
import { PlankaError } from '../../services/planka/errors';
import { NotFoundError } from '../../utils/errors';
import { noContentResponse } from '../../utils/response';
import { wsManager } from '../../domain/engagement/adapters/websocket';
import { toHttpError } from './_errors';
import { gateCardWrite } from './_gate';

/**
 * The label must be one of the card's OWN board's labels. fr's tenant gate
 * authorised the card's board only; a label id from another board is refused
 * with the same 404 as a missing one, before any write reaches Planka.
 */
async function assertLabelOnCardBoard(client: PlankaClient, cardId: string, labelId: string): Promise<void> {
  const card = await client.cards.get(cardId);
  const board = await client.boards.get(card.item.boardId);
  if (!(board.included?.labels ?? []).some((l) => l.id === labelId)) {
    throw new NotFoundError('Label not found');
  }
}

// POST /api/kanban/cards/:cardId/labels/:labelId
export async function handleAttachLabel(
  req: Request,
  cardId: string,
  labelId: string,
): Promise<Response> {
  const { user } = await validateAuthWithToken(req);
  await gateCardWrite(req, user, cardId);
  const client = plankaAsAgent();
  try {
    await assertLabelOnCardBoard(client, cardId, labelId);
    await client.labels.attach(cardId, labelId);
    wsManager.publishKanbanEvent({ kind: 'label_attached', cardId, labelId });
    return noContentResponse();
  } catch (err) {
    if (err instanceof PlankaError) throw toHttpError(err);
    throw err;
  }
}

// DELETE /api/kanban/cards/:cardId/labels/:labelId
export async function handleDetachLabel(
  req: Request,
  cardId: string,
  labelId: string,
): Promise<Response> {
  const { user } = await validateAuthWithToken(req);
  await gateCardWrite(req, user, cardId);
  const client = plankaAsAgent();
  try {
    await assertLabelOnCardBoard(client, cardId, labelId);
    await client.labels.detach(cardId, labelId);
    wsManager.publishKanbanEvent({ kind: 'label_detached', cardId, labelId });
    return noContentResponse();
  } catch (err) {
    if (err instanceof PlankaError) throw toHttpError(err);
    throw err;
  }
}
