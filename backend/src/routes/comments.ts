// src/routes/comments.ts
import { trackDetached } from '../lib/detached-work';
import * as defaultDbClient from '../db/client';
import { comments, projects, departments } from '../db/client';
import { eq, and, or, desc, inArray, count } from 'drizzle-orm';
import {
  loadTenantScopedProject,
  loadProjectForRead,
  projectCommentsDeletableByTenantMember,
} from '../lib/project-access';
import { ctxTenantId } from '../middleware/request-context';
import { validateAuth } from '../middleware/auth';
import { NotFoundError } from '../utils/errors';
import { isUuidShape } from '../lib/uuid-shape';
import { jsonResponse, createdResponse, noContentResponse } from '../utils/response';
import { z } from 'zod';
import { keycloak } from '../services/keycloak';
import { parseMentions } from '../services/mentions/parser';
import { getCorrelationId } from '../integrations/_lib/context';
import {
  dispatchCommentMentions,
  buildSnippet,
  type CommentMentionContext,
} from './_comments-mentions';

const commentsDb = defaultDbClient.db;

// Validation schemas
const CreateCommentSchema = z.object({
  content: z.string().min(1).max(2000),
  mentions: z.array(z.object({
    user_id: z.string().uuid(),
    username: z.string(),
  })).optional(),
});

const UpdateCommentSchema = z.object({
  content: z.string().min(1).max(2000),
});

// Pagination bounds for the comments list (cap idiom mirrors me/notifications.ts).
const DEFAULT_COMMENTS_LIMIT = 50;
const MAX_COMMENTS_LIMIT = 200;

/**
 * GET /api/projects/:projectId/comments
 * Get all comments for a project
 */
export async function handleListComments(
  req: Request,
  projectId: string
): Promise<Response> {
  const user = await validateAuth(req);

  // Verify the project exists and is reachable in the requester's active
  // tenant (owner-AND-tenant gate, same as routes/projects.ts get/delete).
  // READ lane: cross-tenant for a super-admin in HOME view only.
  // ⛔ The mutating handlers in this file stay on `loadTenantScopedProject`.
  await loadProjectForRead(commentsDb, user, projectId);

  // Get comments with pagination. Clamp limit to a sane ceiling and floor
  // page at 1 so a hostile `?limit=1e9&page=-5` can't trigger an unbounded
  // scan / negative offset — matches the cap idiom in me/notifications.ts.
  const url = new URL(req.url);
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Math.min(
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_COMMENTS_LIMIT,
    MAX_COMMENTS_LIMIT,
  );
  const offset = (page - 1) * limit;

  const projectComments = await commentsDb.select()
    .from(comments)
    .where(eq(comments.project_id, projectId))
    .orderBy(desc(comments.created_at))
    .limit(limit)
    .offset(offset);

  // Count total comments in SQL — the old form fetched every row of the
  // thread (all columns) just to read `.length`. Same predicate, same number.
  const [totalRow] = await commentsDb.select({ n: count() })
    .from(comments)
    .where(eq(comments.project_id, projectId));
  const total = totalRow?.n ?? 0;

  // Enrich with author info from Keycloak admin API. We dedupe author ids
  // first so a long thread by 5 people only fires 5 lookups, not 50. A
  // miss (Keycloak unreachable, user deleted) falls back to
  // `name='Unknown User'` rather than 5xx-ing the whole list — comment
  // history must remain readable when Keycloak is degraded.
  const uniqueAuthorIds = Array.from(
    new Set(projectComments.map((c) => c.author_id).filter((id): id is string => Boolean(id))),
  );
  const authorEntries = await Promise.all(
    uniqueAuthorIds.map(async (id) => [id, await keycloak.getUserById(id)] as const),
  );
  const authorMap = new Map(authorEntries);

  const enrichedComments = projectComments.map((comment) => {
    const profile = comment.author_id ? authorMap.get(comment.author_id) ?? null : null;
    return {
      ...comment,
      author: profile
        ? {
            id: profile.id,
            name: profile.name || 'Unknown User',
            email: profile.email,
            avatar_url: profile.avatar_url,
          }
        : {
            id: comment.author_id,
            name: 'Unknown User',
            email: null,
            avatar_url: null,
          },
    };
  });

  return jsonResponse({
    items: enrichedComments,
    total,
    page,
    limit,
  });
}

/**
 * POST /api/projects/:projectId/comments
 * Add a comment to a project
 */
export async function handleCreateComment(
  req: Request,
  projectId: string
): Promise<Response> {
  const user = await validateAuth(req);

  // Verify the project exists and is reachable in the requester's active
  // tenant (owner-AND-tenant gate, same as routes/projects.ts get/delete).
  await loadTenantScopedProject(commentsDb, user, projectId);

  const body = await req.json();
  const validated = CreateCommentSchema.parse(body);

  // Create comment
  const [comment] = await commentsDb.insert(comments).values({
    project_id: projectId,
    author_id: user.id,
    content: validated.content,
    mentions: validated.mentions ? JSON.stringify(validated.mentions) : null,
    edited: false,
  }).returning();

  if (!comment) {
    throw new Error('Failed to create comment');
  }

  // Mention fan-out: parse `@handle` tokens from the body, resolve via
  // Keycloak, dispatch through each user's stored channel preferences.
  // Fire-and-forget — Telegram/Teams/email latency must not bound HTTP
  // latency. Errors are caught inside `dispatchCommentMentions`. We use
  // the parsed handles (NOT `validated.mentions`) as the source of truth
  // because the client-side hint can be stale or lie.
  const handles = parseMentions(validated.content);
  if (handles.length > 0) {
    const ctx: CommentMentionContext = {
      commenterName: user.name || user.email || user.id,
      commenterId: user.id,
      commentId: comment.id,
      projectId,
      correlationId: getCorrelationId() ?? '',
      snippet: buildSnippet(validated.content),
    };
    void trackDetached(
      Promise.resolve()
        .then(() => dispatchCommentMentions(handles, ctx))
        .catch((err) => {
          console.warn(
            '[comments] mention dispatch failed:',
            err instanceof Error ? err.message : String(err),
          );
        }),
    );
  }

  return createdResponse({
    id: comment.id,
    project_id: comment.project_id,
    author: {
      id: user.id,
      name: user.name,
      email: user.email,
    },
    content: comment.content,
    mentions: validated.mentions || [],
    created_at: comment.created_at,
  });
}

/**
 * PUT /api/comments/:commentId
 * Update a comment
 */
export async function handleUpdateComment(
  req: Request,
  commentId: string
): Promise<Response> {
  const user = await validateAuth(req);

  // `comments.id` is a `uuid` column (schema.ts:584): a `:commentId` that is not
  // UUID-shaped aborts the query with 22P02 `invalid input syntax for type uuid`
  // instead of matching no row, escaping as a bare 500. Same 404 as both misses
  // below (row absent, and non-author) — this handler deliberately answers the
  // identical "Comment not found" for "does not exist" and "not yours", and a
  // distinct status for "malformed" would hand a prober the oracle that pairing
  // exists to deny. `isUuidShape`, not `isValidUuid` (utils/tenant), which pins
  // the version/variant nibbles and would 404 legal `uuid` literals.
  if (!isUuidShape(commentId)) {
    throw new NotFoundError('Comment not found');
  }

  // Get comment
  const [comment] = await commentsDb.select()
    .from(comments)
    .where(eq(comments.id, commentId));

  if (!comment) {
    throw new NotFoundError('Comment not found');
  }

  // Verify user is the author
  if (comment.author_id !== user.id) {
    throw new NotFoundError('Comment not found');
  }

  const body = await req.json();
  const validated = UpdateCommentSchema.parse(body);

  // Update comment. The author check above already 404s non-authors; the
  // WHERE is also scoped to author_id so the mutation is self-protecting if a
  // future refactor drops/reorders that SELECT (defense-in-depth, mirrors #402).
  const [updated] = await commentsDb.update(comments)
    .set({
      content: validated.content,
      edited: true,
      updated_at: new Date(),
    })
    .where(and(eq(comments.id, commentId), eq(comments.author_id, user.id)))
    .returning();

  if (!updated) {
    throw new NotFoundError('Comment not found');
  }

  return jsonResponse({
    id: updated.id,
    content: updated.content,
    edited: updated.edited,
    updated_at: updated.updated_at,
  });
}

/**
 * DELETE /api/comments/:commentId
 * Delete a comment
 */
export async function handleDeleteComment(
  req: Request,
  commentId: string
): Promise<Response> {
  const user = await validateAuth(req);

  // Same `uuid`-shape guard as handleUpdateComment (schema.ts:584) — same 404, so
  // malformed stays indistinguishable from absent/not-yours on delete too.
  if (!isUuidShape(commentId)) {
    throw new NotFoundError('Comment not found');
  }

  // Get comment
  const [comment] = await commentsDb.select()
    .from(comments)
    .where(eq(comments.id, commentId));

  if (!comment) {
    throw new NotFoundError('Comment not found');
  }

  // ⭐ P1-TEAM-a (George 2026-10-15): the author, OR any member of the
  // project's tenant — an explicit, named gate (`projectCommentsDeletableByTenantMember`),
  // not an inheritance from the read lane. A member of another tenant gets the
  // same 404 as a missing comment.
  const activeTenantId = ctxTenantId(user.tenantId);
  const [deletableProject] = await commentsDb
    .select({ id: projects.id })
    .from(projects)
    .leftJoin(departments, eq(projects.dept_id, departments.id))
    .where(and(
      eq(projects.id, comment.project_id),
      projectCommentsDeletableByTenantMember(user, activeTenantId),
    ));

  if (comment.author_id !== user.id && !deletableProject) {
    throw new NotFoundError('Comment not found');
  }

  // Delete comment. The WHERE encodes the same rule (author, or a project the
  // caller may delete comments on) so the mutation can't delete someone else's
  // comment even if the SELECT above is later dropped/reordered
  // (defense-in-depth, mirrors #402).
  await commentsDb.delete(comments)
    .where(and(
      eq(comments.id, commentId),
      or(
        eq(comments.author_id, user.id),
        inArray(
          comments.project_id,
          commentsDb.select({ id: projects.id })
            .from(projects)
            .leftJoin(departments, eq(projects.dept_id, departments.id))
            .where(projectCommentsDeletableByTenantMember(user, activeTenantId)),
        ),
      ),
    ));

  return noContentResponse();
}
