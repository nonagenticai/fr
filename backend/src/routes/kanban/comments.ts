// src/routes/kanban/comments.ts
// Planka card comments — list + create only (George 2026-10-10: fr's kanban
// proxy is trimmed to the conveyor operations; users edit their board in their
// own Planka). Both run fr's tenant gate (./_gate.ts) BEFORE any Planka call and
// then act as fr's one configured Planka account; create prefixes the human
// author (`via @<email>: …`, services/planka/comment-attribution.ts) and
// publishes a KanbanEvent.
import { trackDetached } from '../../lib/detached-work';
import { z } from 'zod';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { validateAuthWithToken } from '../../middleware/auth';
import { plankaAsAgent } from '../../services/planka/with-auth';
import { PlankaError } from '../../services/planka/errors';
import { jsonResponse, createdResponse } from '../../utils/response';
import { wsManager } from '../../domain/engagement/adapters/websocket';
import { parseMentions, processCommentMentions } from '../../services/mentions';
import { formatCommentBody } from '../../services/planka/comment-attribution';
import { toHttpError } from './_errors';
import { gateCardRead, gateCardWrite } from './_gate';

// --- Zod schemas ---------------------------------------------------------
const CreateCommentBody = z.object({ text: z.string().min(1).max(8192) });

// --- GET /api/kanban/cards/:cardId/comments ------------------------------
export async function handleListComments(req: Request, cardId: string): Promise<Response> {
  const { user } = await validateAuthWithToken(req);
  await gateCardRead(req, user, cardId);
  const client = plankaAsAgent();
  try {
    const items = await client.comments.listForCard(cardId);
    return jsonResponse({ items });
  } catch (err) {
    if (err instanceof PlankaError) throw toHttpError(err);
    throw err;
  }
}

// --- POST /api/kanban/cards/:cardId/comments -----------------------------
export async function handleCreateComment(req: Request, cardId: string): Promise<Response> {
  const { user } = await validateAuthWithToken(req);
  const body = CreateCommentBody.parse(await req.json());
  await gateCardWrite(req, user, cardId);
  const client = plankaAsAgent();
  try {
    // Planka's author is fr's one account; the `via @<email>:` prefix keeps the
    // human author in the text (same shape as agui kanban.add_comment).
    const comment = await client.comments.create({
      cardId,
      text: formatCommentBody(user.email || null, body.text, user.id),
    });
    wsManager.publishKanbanEvent({
      kind: 'comment_created',
      cardId,
      commentId: comment.id,
      comment,
    });

    // Fire-and-forget mentions dispatch. We intentionally don't await this on
    // the response path — notification latency must not bound HTTP latency.
    const handles = parseMentions(body.text);
    if (handles.length > 0) {
      void trackDetached(
        Promise.resolve()
          .then(async () => {
            const agent = plankaAsAgent();
            const card = await agent.cards.get(cardId).catch((err) => {
              // Justified degrade: the mention still sends, it just names the
              // card by its raw id. Recorded because a Planka outage otherwise
              // renders as a notification that mysteriously shows a UUID, with
              // nothing anywhere saying why.
              reportSwallowedFailure(err, {
                service: 'planka',
                degradedTo: 'mention names the card by raw id',
              });
              return null;
            });
            const cardItem = card?.item;
            await processCommentMentions(body.text, {
              commenterName: user.name || user.email || user.id,
              commentId: comment.id,
              cardId,
              cardName: cardItem?.name ?? cardId,
              boardId: cardItem?.boardId ?? '',
              text: body.text,
            }, agent);
          })
          .catch((err) => {
            console.warn(
              '[comments] mention dispatch failed:',
              err instanceof Error ? err.message : String(err),
            );
          }),
      );
    }

    return createdResponse(comment);
  } catch (err) {
    if (err instanceof PlankaError) throw toHttpError(err);
    throw err;
  }
}
