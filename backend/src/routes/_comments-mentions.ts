// src/routes/_comments-mentions.ts
//
// Project-comment @mention fan-out.
//
// The kanban-comment route uses `services/mentions/processCommentMentions`
// which routes through Planka's user list. Project comments live entirely
// inside fr (table `comments`) and do not have a Planka cardId, so we use a
// thinner pipeline:
//
//   parse handles  →  Keycloak username/email lookup  →  per-user fan-out
//                                                        via channel preferences
//
// `notificationService.fanOutToUser` is approval-shaped (it expects an
// `ApprovalWithDetails`), and a comment mention isn't an approval — so we
// fan out by hand: `resolveRecipients(userId)` plus each channel's
// `sendMessage(address, ChannelMessage)` API. This keeps `engagementType`
// out of the audit log churn for non-approval events; we still log a
// per-attempt row in `engagement_deliveries` so dropped mentions are
// visible.
//
// ⛔ TENANT SCOPE. Keycloak's user search is realm-wide: the same @handle can
// be a different person in another tenant, who must never receive this
// project's comment content. A match is kept only when its `tenant_id`
// attribute equals the PROJECT's owning tenant (`projectOwnerTenant` — the
// same owner rule every project route judges). An unknown project tenant, or
// a lookup that fails, keeps NO match (fail closed) — mirrors the card-comment
// resolver in services/mentions/resolver.ts.
//
// All errors are caught and logged. Mention dispatch must NEVER break
// comment creation — the response is already in flight by the time this
// runs (the route fires it via `void Promise.resolve().then(...)`).
import { eq } from 'drizzle-orm';
import { db, departments, engagementDeliveries, projects } from '../db/client';
import { projectOwnerTenant } from '../lib/board-tenant-access';
import { reportSwallowedFailure } from '../integrations/_lib/errors';
import { resolveRecipients } from '../domain/engagement/channel-prefs';
import {
  notificationService,
  type ChannelMessage,
} from '../domain/engagement/notifications';
import {
  keycloakLookupByUsernameOrEmail,
  type KeycloakUserLookupResult,
} from '../services/keycloak';

async function recordDelivery(row: {
  engagement_id: string;
  engagement_type: string;
  channel: string;
  recipient_user_id: string;
  recipient_address: string;
  status: string;
  error?: string;
}): Promise<void> {
  await db.insert(engagementDeliveries).values(row).catch((err) => {
    // ⚠️ A swallowed WRITE, and the ONLY write there is for a project-comment
    // mention. The header above states the row exists "so dropped mentions are
    // visible" — an empty catch deletes precisely that. Nothing retries these
    // (approval-redelivery's NO_CONFIRMED_DELIVERY arm filters
    // engagement_type='approval'), and the route fires this via
    // `void Promise.resolve().then(...)` once the response is already in
    // flight, so there is no caller, no HTTP status and no operator signal.
    reportSwallowedFailure(err, {
      service: 'fr-db',
      degradedTo: `mention delivery on '${row.channel}' to ${row.recipient_user_id} for comment ${row.engagement_id} (status '${row.status}') leaves no audit row — a dropped mention reads as a mention that was never triggered`,
    });
  });
}

/** The project's owning tenant by the one project-owner rule; null when none. */
async function resolveProjectTenant(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ workspace_id: departments.workspace_id, project_data: projects.project_data })
    .from(projects)
    .leftJoin(departments, eq(departments.id, projects.dept_id))
    .where(eq(projects.id, projectId));
  return row ? projectOwnerTenant(row) : null;
}

export interface CommentMentionContext {
  commenterName: string;
  commenterId: string;
  commentId: string;
  projectId: string;
  correlationId: string;
  /** First ~140 chars of the comment body, used for the SMS / Teams body. */
  snippet: string;
}

const SNIPPET_MAX = 140;

export function buildSnippet(text: string): string {
  if (text.length <= SNIPPET_MAX) return text;
  return text.slice(0, SNIPPET_MAX) + '…';
}

interface ResolvedMentionTarget {
  handle: string;
  userId: string;
}

/**
 * Parse handles → resolve to Keycloak user ids → fan out a per-user
 * mention notification through each user's stored channel preferences.
 *
 * Never throws. Returns the list of resolved targets (handle + userId
 * pairs) so the caller can include them in the API response or audit
 * entry.
 */
export async function dispatchCommentMentions(
  handles: string[],
  ctx: CommentMentionContext,
): Promise<ResolvedMentionTarget[]> {
  if (handles.length === 0) return [];

  // The project's owning tenant. Unknown (or unresolvable) ⇒ nobody is
  // notified: a realm-wide match cannot be proven to be the same person.
  let projectTenant: string | null = null;
  try {
    projectTenant = await resolveProjectTenant(ctx.projectId);
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'fr-db',
      degradedTo: `project tenant for ${ctx.projectId} unresolvable — comment ${ctx.commentId}'s @mentions notify nobody (fail closed), indistinguishable from a comment with no valid handles`,
    });
    return [];
  }
  if (!projectTenant) return [];

  // Resolve handles → user ids. We probe Keycloak by username first; if a
  // handle doesn't resolve, we silently drop it (no error log — invalid
  // handles in user input are normal noise, not an alert-worthy event).
  const resolved: ResolvedMentionTarget[] = [];
  for (const handle of handles) {
    if (handle === ctx.commenterId) continue; // never self-mention
    let kcUser: KeycloakUserLookupResult | null = null;
    try {
      kcUser = await keycloakLookupByUsernameOrEmail({ username: handle });
    } catch (err) {
      console.warn(
        `[comments] keycloak lookup failed for @${handle}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    if (!kcUser) continue;
    if (kcUser.tenantId !== projectTenant) continue; // other tenant ⇒ other person
    if (kcUser.sub === ctx.commenterId) continue;
    resolved.push({ handle, userId: kcUser.sub });
  }

  if (resolved.length === 0) return [];

  const message: ChannelMessage = {
    kind: 'text',
    correlationId: ctx.correlationId,
    text: `${ctx.commenterName} mentioned you in a comment: ${ctx.snippet}`,
    meta: {
      projectId: ctx.projectId,
      commentId: ctx.commentId,
      eventKind: 'comment_mentioned',
    },
  };

  await Promise.allSettled(
    resolved.map(async ({ userId }) => {
      let recipients: Awaited<ReturnType<typeof resolveRecipients>> = [];
      try {
        // A mentioned member's link pinned to another workspace never gets this project's text.
        recipients = await resolveRecipients(userId, projectTenant);
      } catch (err) {
        console.warn(
          `[comments] resolveRecipients(${userId}) failed:`,
          err instanceof Error ? err.message : String(err),
        );
        return;
      }

      if (recipients.length === 0) {
        await recordDelivery({
          engagement_id: ctx.commentId,
          engagement_type: 'comment_mention',
          channel: '*',
          recipient_user_id: userId,
          recipient_address: '',
          status: 'skipped_disabled',
        });
        return;
      }

      await Promise.allSettled(
        recipients.map(async ({ channel: channelName, address }) => {
          const channel = notificationService.getChannel(channelName);
          if (!channel) {
            await recordDelivery({
              engagement_id: ctx.commentId,
              engagement_type: 'comment_mention',
              channel: channelName,
              recipient_user_id: userId,
              recipient_address: address,
              status: 'failed',
              error: `channel '${channelName}' not registered`,
            });
            return;
          }
          let result: { success: boolean; error?: string };
          try {
            result = await channel.sendMessage(address, message);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result = { success: false, error: msg };
          }
          await recordDelivery({
            engagement_id: ctx.commentId,
            engagement_type: 'comment_mention',
            channel: channelName,
            recipient_user_id: userId,
            recipient_address: address,
            status: result.success ? 'sent' : 'failed',
            error: result.error,
          });
        }),
      );
    }),
  );

  return resolved;
}
