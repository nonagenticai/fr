// src/routes/repositories.ts
import { db, repositories, projects, projectRepositories } from '../db/client';
import { eq, and, isNotNull, type SQL } from 'drizzle-orm';
import { RepositoryCreateSchema, RepositoryUpdateSchema } from '../types/api';
import { validateAuth } from '../middleware/auth';
import { NotFoundError } from '../utils/errors';
import { isUuidShape } from '../lib/uuid-shape';
import { resolveRepositoryName } from '../lib/repository-name';
import { jsonResponse, createdResponse, noContentResponse } from '../utils/response';
import { ctxTenantId } from '../middleware/request-context';
import { platformRepoRefusalResponse } from './project-request-repo-gate';
import { PROJECT_KC_TENANT } from '../lib/project-access';
import { platformRepoRefusals } from '../services/repo-access';

/**
 * ⛔ PLATFORM-REPO OWNERSHIP GATE (ruling 2026-09-30) for the user's repository
 * catalog: judged against the caller's ACTIVE tenant (catalog rows are
 * user-scoped and carry no tenant). Attaching a catalog row to a project is
 * gated again against the project's tenant (routes/project-repositories.ts).
 */
function catalogRepoRefusal(url: string, user: { tenantId?: string | null }): Response | null {
  let tenant: string | null = null;
  try {
    tenant = ctxTenantId(user.tenantId);
  } catch {
    tenant = null; // unknown = not platform = refused (fail closed)
  }
  return platformRepoRefusalResponse([url], tenant);
}

// PUT's two reads.
const updateLoaders = {
  ownedRepo: async (repoId: string, userId: string) => {
    const [repo] = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.id, repoId), eq(repositories.user_id, userId)));
    return repo;
  },
  attachedProjectTenants: (repoId: string): Promise<Array<{ tenant: unknown }>> =>
    db
      .select({ tenant: PROJECT_KC_TENANT })
      .from(projectRepositories)
      .innerJoin(projects, eq(projects.id, projectRepositories.project_id))
      .where(eq(projectRepositories.repo_id, repoId)),
};

/**
 * Build the WHERE conditions for `GET /api/repositories`.
 *
 * Pure function exported for unit testing. Inspects `searchParams` and
 * stacks per-query-param filters on top of the mandatory user-scope clause.
 *
 *  - `onboarded_to=coding` → `container_name IS NOT NULL` (Wave-3 T7).
 *
 * Add more clauses here as the list endpoint grows. Keep this body free of
 * IO so tests don't need to mock the db.
 */
export function buildListRepositoriesConditions(
  userId: string,
  searchParams: URLSearchParams,
): SQL[] {
  const conditions: SQL[] = [eq(repositories.user_id, userId)];
  if (searchParams.get('onboarded_to') === 'coding') {
    conditions.push(isNotNull(repositories.container_name));
  }
  return conditions;
}

// GET /api/repositories - List user's repositories.
//
// Query params:
//   onboarded_to=coding  → filter to repos with `container_name IS NOT NULL`
//                          (i.e. provisioned to the coding-gateway). Powers
//                          the /tools/coding repo <select>; see Wave-3 T7.
export async function handleListRepositories(req: Request): Promise<Response> {
  const user = await validateAuth(req);

  const url = new URL(req.url);
  const conditions = buildListRepositoriesConditions(user.id, url.searchParams);

  const userRepos = await db.select()
    .from(repositories)
    .where(and(...conditions));

  return jsonResponse({
    items: userRepos,
    total: userRepos.length,
  });
}

// POST /api/repositories - Create new repository
export async function handleCreateRepository(req: Request): Promise<Response> {
  const user = await validateAuth(req);

  const body = await req.json();
  const validated = RepositoryCreateSchema.parse(body);
  const refused = catalogRepoRefusal(validated.url, user);
  if (refused) return refused;

  const [repo] = await db.insert(repositories).values({
    user_id: user.id,
    // `RepositoryCreateSchema.name` stays optional on the wire because the name
    // is always resolvable from the url (lib/repository-name.ts); this is the
    // one place that decides the stored value, and it cannot yield blank.
    name: resolveRepositoryName(validated.name, validated.url),
    url: validated.url,
    branch: validated.branch,
    path: validated.path,
    description: validated.description,
    secret_id: validated.secret_id,
  }).returning();

  return createdResponse(repo);
}

// GET /api/repositories/:id - Get repository by ID
export async function handleGetRepository(req: Request, repoId: string): Promise<Response> {
  const user = await validateAuth(req);

  // `repositories.id` is a `uuid` column (schema.ts:307): a `:id` segment that
  // is not UUID-shaped aborts the query with 22P02 `invalid input syntax for
  // type uuid` instead of matching no row, escaping as a bare 500. Answer the
  // SAME 404 the owner-scoped miss below gives, so a malformed id is
  // indistinguishable from another user's repository. `isUuidShape`, not
  // `isValidUuid` (utils/tenant) — the latter pins the version/variant nibbles
  // and would 404 legal `uuid` literals that name real rows.
  if (!isUuidShape(repoId)) {
    throw new NotFoundError('Repository not found');
  }

  const [repo] = await db.select()
    .from(repositories)
    .where(and(
      eq(repositories.id, repoId),
      eq(repositories.user_id, user.id)
    ));

  if (!repo) {
    throw new NotFoundError('Repository not found');
  }

  return jsonResponse(repo);
}

// PUT /api/repositories/:id - Update repository
export async function handleUpdateRepository(req: Request, repoId: string): Promise<Response> {
  const user = await validateAuth(req);

  // Same `uuid`-shape guard as handleGetRepository (schema.ts:307) — same 404,
  // so malformed and not-yours stay indistinguishable on the mutation paths too.
  if (!isUuidShape(repoId)) {
    throw new NotFoundError('Repository not found');
  }

  const repo = await updateLoaders.ownedRepo(repoId, user.id);

  if (!repo) {
    throw new NotFoundError('Repository not found');
  }

  const body = await req.json();
  const validated = RepositoryUpdateSchema.parse(body);
  if (validated.url !== undefined) {
    const refused = catalogRepoRefusal(validated.url, user);
    if (refused) return refused;
    // ⛔ …and against EVERY project this catalog row is already attached to: a
    // platform user must not be able to re-point a row a CUSTOMER project uses
    // at a platform repo. Pure owner check first (null tenant = "is this url
    // platform-owned at all?"), so the join is only read when it matters.
    if (platformRepoRefusals([validated.url], null).length > 0) {
      const attached = await updateLoaders.attachedProjectTenants(repoId);
      for (const row of attached) {
        // A legacy project with no tenant stamp is unknown = not platform = refused.
        const t = typeof row.tenant === 'string' && row.tenant ? row.tenant : null;
        const byProject = platformRepoRefusalResponse([validated.url], t);
        if (byProject) return byProject;
      }
    }
  }

  const updates: any = {
    updated_at: new Date(),
  };

  if (validated.name !== undefined) updates.name = validated.name;
  if (validated.url !== undefined) updates.url = validated.url;
  if (validated.branch !== undefined) updates.branch = validated.branch;
  if (validated.path !== undefined) updates.path = validated.path;
  if (validated.description !== undefined) updates.description = validated.description;
  if (validated.secret_id !== undefined) updates.secret_id = validated.secret_id;

  const [updated] = await db.update(repositories)
    .set(updates)
    // Scope the mutation by owner too (defense-in-depth): the SELECT above
    // already proved ownership, but a self-protecting WHERE survives any future
    // refactor that drops or reorders that gate.
    .where(and(eq(repositories.id, repoId), eq(repositories.user_id, user.id)))
    .returning();

  return jsonResponse(updated);
}

// DELETE /api/repositories/:id - Delete repository
export async function handleDeleteRepository(req: Request, repoId: string): Promise<Response> {
  const user = await validateAuth(req);

  // Same `uuid`-shape guard as handleGetRepository (schema.ts:307) — same 404,
  // so malformed and not-yours stay indistinguishable on the mutation paths too.
  if (!isUuidShape(repoId)) {
    throw new NotFoundError('Repository not found');
  }

  const [repo] = await db.select()
    .from(repositories)
    .where(and(
      eq(repositories.id, repoId),
      eq(repositories.user_id, user.id)
    ));

  if (!repo) {
    throw new NotFoundError('Repository not found');
  }

  await db.delete(repositories)
    // Defense-in-depth: scope the delete by owner, not the gating SELECT alone.
    .where(and(eq(repositories.id, repoId), eq(repositories.user_id, user.id)));

  return noContentResponse();
}
