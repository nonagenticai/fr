// src/services/planka/comment-attribution.ts
//
// fr writes every Planka comment as its ONE configured account (per tenant, not
// per user — George 2026-10-10), so Planka's own author field is always that
// account. This prefix keeps the HUMAN author in the comment text, readable in
// the card history without Planka admin access. Shared by the AG-UI action
// (agui/actions/kanban-comment.ts) and the kanban route
// (routes/kanban/comments.ts) so both write the same shape.

/**
 * Build the comment body with an author-attribution prefix: `via @<handle>: <text>`.
 *
 * @param email - the calling user's email, or null if unavailable.
 * @param text - original comment body supplied by the user.
 * @param fallbackUserId - used as handle when email is null.
 */
export function formatCommentBody(
  email: string | null,
  text: string,
  fallbackUserId?: string,
): string {
  const handle = email ?? fallbackUserId ?? 'unknown';
  return `via @${handle}: ${text}`;
}
