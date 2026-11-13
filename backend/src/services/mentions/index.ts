// src/services/mentions/index.ts
// Public entry point for the mentions pipeline. Route handlers import from here.
import { parseMentions } from './parser';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { resolveMentions, type ResolvedMention } from './resolver';
import { dispatchMentions, type MentionContext } from './dispatcher';
import type { PlankaClient } from '../planka';
import { resolveBoardTenant } from '../../lib/board-tenant-access';

export { parseMentions } from './parser';
export {
  resolveMentions,
  type ResolvedMention,
  type KeycloakUserLite,
  type MentionScope,
} from './resolver';
export { dispatchMentions, type MentionContext } from './dispatcher';

/**
 * Handle one round of mention fan-out for a comment that was just created
 * or updated. Pure glue: parse → resolve → dispatch, with everything
 * best-effort (errors logged + swallowed — never break the comment write).
 */
export async function processCommentMentions(
  text: string,
  ctx: MentionContext,
  plankaAgent: PlankaClient,
): Promise<ResolvedMention[]> {
  try {
    const handles = parseMentions(text);
    if (handles.length === 0) return [];

    // The card's tenant is its BOARD's tenant — the same derivation the
    // comment route's gateCardWrite judged. Unknown board ⇒ null ⇒ only
    // board members get the WS highlight and nobody is notified.
    const tenantId = ctx.boardId ? await resolveBoardTenant(ctx.boardId) : null;
    const resolved = await resolveMentions(handles, plankaAgent, {
      boardId: ctx.boardId,
      tenantId,
    });
    await dispatchMentions(resolved, ctx);
    return resolved;
  } catch (err) {
    console.warn(
      '[mentions] processCommentMentions failed:',
      err instanceof Error ? err.message : String(err),
    );
    // Both callers discard the return value (fire-and-forget from
    // routes/kanban/comments.ts), so nothing renders this as an answer — but
    // the mentioned human is simply never notified, and a console.warn is not
    // something anyone reads afterwards. The comment save itself is unaffected.
    reportSwallowedFailure(err, {
      service: 'fr-db',
      degradedTo: 'mention notifications not delivered; the comment still saved',
    });
    return [];
  }
}
