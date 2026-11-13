// src/routes/project-repositories.ts
//
// Multi-repo per project — task #25 scope B PR 2/3. The N:M membership
// surface that sits on top of migration 072 (`project_repositories` join
// table). The existing `projects.repository_url/branch/container_name`
// stay as a denormalised primary so every existing reader keeps working;
// these handlers own the join row and (on primary-promote) the cache
// columns.
//
// Routes:
//   GET    /api/projects/:id/repositories             — list (primary first)
//   POST   /api/projects/:id/repositories             — attach existing or
//                                                       create-or-attach by url
//   DELETE /api/projects/:id/repositories/:repo_id    — detach (not the primary)
//   PUT    /api/projects/:id/repositories/:repo_id/primary
//                                                     — promote (transactional swap)
//
// ACL: every handler 404s the project unless it is owner-owned AND reachable
// in the requester's active tenant (`loadTenantScopedProject`, same gate as
// routes/projects.ts get/delete). Attach + promote-by-id only accept
// `repositories.user_id == user.id` repos — matches `handleListRepositories`'
// scope. All three repo-row handlers (attach, promote, detach) enforce that
// ownership self-protectingly in their OWN lookup/mutation WHERE (attach: the
// existing-repo select; promote: the join lookup; detach: the join lookup + a
// self-protecting subquery on the delete), so the repo-ownership check survives
// even if the project gate is ever dropped (#402 pattern). Tenant-rescope of
// the `repositories` rows themselves is a separate deferred lane (repositories
// are user-scoped only — no dept/workspace/tenant column — so we scope the
// project, not the repo rows).
//
// Validator hop: on attach (soft) + primary-promote (hard) we call
// requirements_management's `GET /architecture/containers/{name}?projectId=…`.
// Attach 404 → 200 + warning; promote 404 → 409 `container_not_bound_to_project`.

import {
  clientSafeIntegrationMessage,
  shouldRedactUpstreamDetailForCaller,
} from '../integrations/_lib/errors';
import {
  db as defaultDb,
  projects,
  repositories,
  projectRepositories,
} from '../db/client';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { ProjectRepositoryAttachSchema } from '../types/api';
import { loadTenantScopedProject, loadProjectForRead } from '../lib/project-access';
import { resolveRepositoryName } from '../lib/repository-name';
import { validateAuth } from '../middleware/auth';
import { BadRequestError, NotFoundError } from '../utils/errors';
import {
  jsonResponse,
  createdResponse,
  noContentResponse,
} from '../utils/response';
import {
  getContainerBinding,
  type ContainerBindingResult,
} from '../integrations/requirements-management';
import { ctxTenantId } from '../middleware/request-context';
import { platformRepoRefusalResponse } from './project-request-repo-gate';
import { isRepoPlatformTenant } from '../services/repo-access';

/**
 * The tenant the platform-repo ownership gate judges for a project: the
 * project's own `project_data.keycloak_tenant_id` (stamped at create).
 *
 * A row with NO stamp (legacy: the retired AG-UI `agent.create_project`
 * path did not stamp one) has no owner we can read, so the caller must be
 * platform on BOTH axes: the ACTIVE tenant (request context) AND the HOME
 * tenant (`user.tenantId`, the token's own workspace — see lib/project-access.ts
 * activeTenantId vs homeTenantId). Otherwise a user holding membership in a
 * customer AND a platform workspace could attach a platform repo to the
 * customer's unstamped project by switching to the platform workspace first.
 * Anything short of both → null = not platform = refused (fail closed).
 */
function projectRepoGateTenant(
  project: { project_data: unknown },
  user: { tenantId?: string | null },
): string | null {
  const pd = project.project_data as Record<string, unknown> | null;
  const own = pd && typeof pd.keycloak_tenant_id === 'string' ? pd.keycloak_tenant_id : '';
  if (own) return own;
  let active: string | null;
  try {
    active = ctxTenantId(user.tenantId);
  } catch {
    return null; // unknown = not platform = the gate refuses (fail closed)
  }
  const home = user.tenantId ?? null;
  return isRepoPlatformTenant(active) && isRepoPlatformTenant(home) ? active : null;
}

// The `{repo_id}` row load (ATTACH) and the attached-target load (PROMOTE).
async function loadRepoRowById(repoId: string) {
  const [existing] = await defaultDb
    .select({
      id: repositories.id,
      container_name: repositories.container_name,
      url: repositories.url,
      user_id: repositories.user_id,
    })
    .from(repositories)
    .where(eq(repositories.id, repoId));
  return existing;
}
async function loadPromoteTarget(projectId: string, repoId: string, userId: string) {
  const [target] = await defaultDb
    .select({
      repo_id: repositories.id,
      url: repositories.url,
      branch: repositories.branch,
      container_name: repositories.container_name,
    })
    .from(projectRepositories)
    .innerJoin(repositories, eq(projectRepositories.repo_id, repositories.id))
    .where(
      and(
        eq(projectRepositories.project_id, projectId),
        eq(projectRepositories.repo_id, repoId),
        // Self-protecting: only promote repos the caller owns (#402 pattern,
        // mirrors handleAttachProjectRepository's user_id check). Without this
        // a repo owned by another user that somehow landed in this project's
        // join table could be promoted to primary.
        eq(repositories.user_id, userId),
      ),
    );
  return target;
}
interface ListedRow {
  repo_id: string;
  url: string;
  branch: string | null;
  name: string | null;
  container_name: string | null;
  is_primary: boolean;
  added_at: Date;
}

async function listProjectRepoRows(projectId: string): Promise<ListedRow[]> {
  const rows = await defaultDb
    .select({
      repo_id: repositories.id,
      url: repositories.url,
      branch: repositories.branch,
      name: repositories.name,
      container_name: repositories.container_name,
      is_primary: projectRepositories.is_primary,
      added_at: projectRepositories.added_at,
    })
    .from(projectRepositories)
    .innerJoin(repositories, eq(projectRepositories.repo_id, repositories.id))
    .where(eq(projectRepositories.project_id, projectId))
    .orderBy(desc(projectRepositories.is_primary), asc(projectRepositories.added_at));
  return rows;
}

function serialiseRow(row: ListedRow) {
  return {
    repo_id: row.repo_id,
    url: row.url,
    branch: row.branch,
    name: row.name,
    container_name: row.container_name,
    is_primary: row.is_primary,
    added_at: row.added_at instanceof Date ? row.added_at.toISOString() : String(row.added_at),
  };
}

// --- GET --------------------------------------------------------------
export async function handleListProjectRepositories(
  req: Request,
  projectId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  // READ lane: cross-tenant for a super-admin in HOME view only.
  // ⛔ The mutating handlers in this file stay on `loadTenantScopedProject`.
  await loadProjectForRead(defaultDb, user, projectId);
  const rows = await listProjectRepoRows(projectId);
  const items = rows.map(serialiseRow);
  return jsonResponse({
    items,
    total: items.length,
    primary_repository_id: items.find((r) => r.is_primary)?.repo_id ?? null,
  });
}

// --- POST -------------------------------------------------------------
//
// Two shapes (refined by Zod): `{repo_id}` attaches an existing repo;
// `{url, branch?, name?}` upserts a repositories row first (idempotent
// via the (user_id, url) unique) then attaches. Either way, the join
// insert uses ON CONFLICT DO NOTHING so a repeat POST is a no-op +
// returns the existing row.
export async function handleAttachProjectRepository(
  req: Request,
  projectId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const project = await loadTenantScopedProject(defaultDb, user, projectId);
  const gateTenant = projectRepoGateTenant(project, user);

  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  const body = ProjectRepositoryAttachSchema.parse(raw);

  // ⛔ PLATFORM-REPO OWNERSHIP GATE (ruling 2026-09-30) on a `{url}` body,
  // BEFORE the repositories upsert below writes it. The `{repo_id}` shape is
  // gated on the RESOLVED row's url further down, before the join insert.
  if (!body.repo_id && body.url) {
    const refused = platformRepoRefusalResponse([body.url], gateTenant);
    if (refused) return refused;
  }

  // 1. Resolve or create the repositories row.
  let repoRow: { id: string; container_name: string | null; url: string };
  if (body.repo_id) {
    const existing = await loadRepoRowById(body.repo_id);
    if (!existing || existing.user_id !== user.id) {
      // ACL hide-existence — same 404 either way.
      throw new NotFoundError('Repository not found');
    }
    repoRow = { id: existing.id, container_name: existing.container_name, url: existing.url };
  } else {
    if (!body.url) {
      throw new BadRequestError('url required when repo_id is absent');
    }
    const upserted = await defaultDb
      .insert(repositories)
      .values({
        user_id: user.id,
        // Never `?? null`: the name is derived from the url when the caller
        // omits it (lib/repository-name.ts), and an underivable url is a 400
        // naming the field rather than a blank row.
        name: resolveRepositoryName(body.name, body.url),
        url: body.url,
        branch: body.branch ?? 'main',
      })
      .onConflictDoUpdate({
        target: [repositories.user_id, repositories.url],
        // No-op update so RETURNING gives us the existing row.
        // Bumping updated_at is the closest thing to "touch" the
        // existing row without overwriting user-set fields.
        set: { updated_at: new Date() },
      })
      .returning({
        id: repositories.id,
        container_name: repositories.container_name,
        url: repositories.url,
      });
    const created = upserted[0];
    if (!created) {
      throw new Error('Failed to upsert repository');
    }
    repoRow = created;
  }

  // ⛔ PLATFORM-REPO OWNERSHIP GATE on the RESOLVED repository url — covers the
  // `{repo_id}` shape (a repo row created while in a platform workspace cannot
  // be attached to a non-platform project) before any join write.
  {
    const refused = platformRepoRefusalResponse([repoRow.url], gateTenant);
    if (refused) return refused;
  }

  // 2. Soft validator hop. 404 (or upstream-down) returns a warning but
  //    does NOT block. Only consult the validator when we have a
  //    container_name to validate — repos that haven't been provisioned
  //    yet are perfectly valid to attach.
  let warning: string | null = null;
  let bindingInfo: ContainerBindingResult | null = null;
  if (repoRow.container_name) {
    bindingInfo = await getContainerBinding({
      projectId,
      containerName: repoRow.container_name,
    });
    if (!bindingInfo.ok) {
      warning =
        bindingInfo.reason === 'not_bound'
          ? 'container_not_bound_to_project'
          : 'binding_validator_unavailable';
    }
  }

  // 3. Attach. ON CONFLICT DO NOTHING keeps re-attach idempotent.
  await defaultDb
    .insert(projectRepositories)
    .values({
      project_id: projectId,
      repo_id: repoRow.id,
      is_primary: false, // promote is its own route — never silently demote
    })
    .onConflictDoNothing({
      target: [projectRepositories.project_id, projectRepositories.repo_id],
    });

  const rows = await listProjectRepoRows(projectId);
  const attached = rows.find((r) => r.repo_id === repoRow.id);
  if (!attached) {
    throw new Error('Attached row not found after insert');
  }

  return createdResponse({
    repository: serialiseRow(attached),
    warning,
    binding: bindingInfo,
  });
}

// --- DELETE -----------------------------------------------------------
//
// Cannot detach the current primary — the project carries a denormalised
// primary on `projects.repository_url`; silently detaching that row would
// leave the project pointing at a repo nothing in the join table knows
// about. Caller must promote a different repo first.
export async function handleDetachProjectRepository(
  req: Request,
  projectId: string,
  repoId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  await loadTenantScopedProject(defaultDb, user, projectId);

  // Scope the join lookup by repo ownership too (mirrors attach + promote) —
  // a repo not owned by the caller is treated as not-attached (404).
  const [join] = await defaultDb
    .select({
      is_primary: projectRepositories.is_primary,
    })
    .from(projectRepositories)
    .innerJoin(repositories, eq(projectRepositories.repo_id, repositories.id))
    .where(
      and(
        eq(projectRepositories.project_id, projectId),
        eq(projectRepositories.repo_id, repoId),
        eq(repositories.user_id, user.id),
      ),
    );
  if (!join) {
    throw new NotFoundError('Repository not attached to this project');
  }
  if (join.is_primary) {
    return jsonResponse(
      {
        error: 'cannot_detach_primary_repository',
        message: 'Promote a different repository to primary first.',
      },
      409,
    );
  }

  // Self-protecting WHERE (#402): the delete only removes a join row whose repo
  // the caller owns, so it stays safe even if the lookup above is later dropped.
  await defaultDb
    .delete(projectRepositories)
    .where(
      and(
        eq(projectRepositories.project_id, projectId),
        eq(projectRepositories.repo_id, repoId),
        inArray(
          projectRepositories.repo_id,
          defaultDb
            .select({ id: repositories.id })
            .from(repositories)
            .where(eq(repositories.user_id, user.id)),
        ),
      ),
    );
  return noContentResponse();
}

// --- PUT primary ------------------------------------------------------
//
// Transactional swap: clear the old is_primary, set the new one, and
// re-stamp `projects.repository_url/branch/container_name` so the
// denormalised cache the existing readers see stays in sync.
//
// Hard validator hop: 404 → 409. A project whose container isn't bound
// to any architecture element must not become the dispatched-from-primary.
export async function handlePromoteProjectRepository(
  req: Request,
  projectId: string,
  repoId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const project = await loadTenantScopedProject(defaultDb, user, projectId);

  const target = await loadPromoteTarget(projectId, repoId, user.id);
  if (!target) {
    throw new NotFoundError('Repository not attached to this project');
  }

  // ⛔ PLATFORM-REPO OWNERSHIP GATE: promoting stamps `projects.repository_url`,
  // so a pre-gate join row naming an internal-owner repo must not become the
  // primary of a non-platform project.
  {
    const refused = platformRepoRefusalResponse(
      [target.url],
      projectRepoGateTenant(project, user),
    );
    if (refused) return refused;
  }

  // Hard validator hop. Only consult if the target has a container_name
  // — a repo that hasn't been provisioned cannot dispatch architecture
  // queries, which is exactly the case we're guarding against, so 422.
  if (!target.container_name) {
    return jsonResponse(
      {
        error: 'repository_not_provisioned',
        message:
          'Provision the repository to coding-containers before promoting it to primary.',
      },
      422,
    );
  }
  const binding = await getContainerBinding({
    projectId,
    containerName: target.container_name,
    fresh: true,
  });
  if (!binding.ok && binding.reason === 'not_bound') {
    return jsonResponse(
      {
        error: 'container_not_bound_to_project',
        message:
          'No architecture element in this project binds the container — model the architecture first.',
      },
      409,
    );
  }
  if (!binding.ok) {
    const status = binding.status >= 400 && binding.status < 600 ? binding.status : 502;
    // `binding.message` is requirements_management's raw body (or the
    // http-client sentence naming its internal path): super-admin only.
    if (shouldRedactUpstreamDetailForCaller()) {
      console.warn('[project-repositories] binding validator failed:', binding.message);
    }
    return jsonResponse(
      {
        error: 'binding_validator_unavailable',
        message: shouldRedactUpstreamDetailForCaller()
          ? clientSafeIntegrationMessage(status)
          : binding.message,
      },
      status,
    );
  }

  // Transactional swap of (a) the partial-unique-protected is_primary
  // flag, (b) the denormalised cache columns. The partial unique on
  // (project_id) WHERE is_primary means we MUST clear the old row
  // before setting the new one within the same tx (otherwise two
  // is_primary=true rows trip the index).
  await defaultDb.transaction(async (tx) => {
    await tx
      .update(projectRepositories)
      .set({ is_primary: false })
      .where(
        and(
          eq(projectRepositories.project_id, projectId),
          eq(projectRepositories.is_primary, true),
        ),
      );
    await tx
      .update(projectRepositories)
      .set({ is_primary: true })
      .where(
        and(
          eq(projectRepositories.project_id, projectId),
          eq(projectRepositories.repo_id, repoId),
        ),
      );
    await tx
      .update(projects)
      .set({
        repository_url: target.url,
        branch: target.branch ?? 'main',
        container_name: target.container_name,
        updated_at: new Date(),
      })
      .where(eq(projects.id, projectId));
  });

  const rows = await listProjectRepoRows(projectId);
  return jsonResponse({
    items: rows.map(serialiseRow),
    primary_repository_id: repoId,
    binding,
  });
}

