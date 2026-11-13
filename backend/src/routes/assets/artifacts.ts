/**
 * Artifacts asset routes — read-only browseable surface over `artifact_service`.
 *
 * Spec: docs/superpowers/specs/completed/2026-04-24-artifacts-browser.md §8.2.
 *
 * Six routes: list / get / manifest / mint download token / resolve+stream
 * download / inline preview. All routes go through `validateAuth`, share the
 * `handle()` integration-error wrapper, and emit a span per spec §11.
 *
 * Project authorization: every route requires `project_id`. The upstream
 * enforces tenant isolation via the bearer token; FR adds project-membership
 * gating in `assertProjectAccess()` (§10). For the classic routes the gate is
 * a permissive stub — upstream tenant isolation is the boundary, and most
 * artifact_service project ids are not fr `projects` rows (see the gate's
 * comment) — but every call site goes through the helper. The agent path's
 * bound-project check (fr-agui P2-c2) lives with the agent actions below.
 *
 * AG-UI: this module also calls `registerAction` for the five artifacts
 * actions in §"Agent-callable actions" at import time so the registry
 * picks them up before the server starts serving requests.
 */

import { z } from 'zod';
import { validateAuth } from '../../middleware/auth';
import { trackDetached } from '../../lib/detached-work';
import {
  ctxTenantId,
  tryCtxTenantId,
} from '../../middleware/request-context';
import { IntegrationError, clientSafeIntegrationErrorMessage } from '../../integrations/_lib/errors';
import { jsonResponse } from '../../utils/response';
import { handle } from './_lib/handler';
import {
  applyEffectiveFilter,
  projectExists,
  projectScopeHeaders,
} from './_lib/effective-query';
import { applyBindingFilter } from './_lib/binding-filter';
import {
  assertBoundToShape,
  fieldEquals,
  listBoundById,
  rejectOffsetInBoundMode,
} from './_lib/bound-by-id';
import {
  ASSET_LIST_DEFAULT_LIMIT,
  frameProbe,
  pageCapHeaders,
  resolveListLimit,
} from './_lib/page-cap';

/**
 * Wrap a route handler so that an IntegrationError thrown synchronously
 * during request parsing (e.g. missing project_id) is converted to the
 * standard `{ error: {...} }` JSON response, the same shape `handle()` uses
 * for upstream-thrown integration errors. Everything else re-throws so the
 * server's outer error path still logs / 500s.
 */
import { emitSpan } from '../../telemetry/spans';
import { registerAction } from '../../agui/registry';
import type { AgentCallableAction, ActionContext } from '../../agui/types';
import {
  fetchPreviewBytes,
  getArtifact,
  getArtifactById,
  getManifest,
  listArtifacts,
  listArtifactsCrossProject,
  listArtifactReviews,
  mintDownloadToken,
  resolveDownloadToken,
  streamArtifact,
  submitArtifactReview,
  DownloadTokenError,
  type ArtifactOut,
  type ListArtifactsParams,
  type Manifest,
  type ManifestScope,
  type ReviewIn,
} from '../../integrations/artifacts';
import { fireArtifactReviewCallback } from '../../services/artifact-review-callback';
import { ProjectMismatchError } from '../../agent/project-binding';
import { readJsonBody } from '../_lib';
import { db } from '../../db/client';
import { loadProjectForRead } from '../../lib/project-access';
import { assertNotLicenceDecider } from '../../lib/licence-door';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { isSuperAdminSwitchedInto } from '../../lib/super-admin-switch';
import { isPlatformTenant } from '../../middleware/internal-tenant-only';
import {
  isTenantMemberForDecision,
  readCompleteTenantMembership,
} from '../../services/tenant-member-recipients';
import { ForbiddenError, NotFoundError } from '../../utils/errors';
import { withIntegrationCatch } from '../_lib';

// ---------------------------------------------------------------------------
// Project-membership gate (FR-side, post-upstream)
// ---------------------------------------------------------------------------

/**
 * The CLASSIC routes' project gate (get, manifest, mint, preview, reviews, list) —
 * UNCHANGED from before fr-agui P2-c2: a permissive no-op in production.
 *
 * ⛔ EXCEPT the review DECISION (`POST …/:id/review`): a decision is not a read, so it
 * has its own decider gate (`assertArtifactReviewDecider`, R208) — project READ lane,
 * artifact-of-project, sign-off decide eligibility, self-review. Re-measured 2026-10-27
 * (artifact_registry on worker4, read-only): 62 artifacts, ZERO under the sentinel, every
 * one under an fr `projects` row — so the P2-carry objection below no longer applies to it.
 * Upstream tenant isolation (artifact_service's tenant bearer) is the enforcement
 * boundary for the classic Artifacts library, and it must stay so: an
 * artifact_service `project_id` need not be an fr `projects` row — measured in
 * prod 2026-10-17, 50,460 of 50,497 artifacts sit under the old-layer sentinel
 * project `00000000-0000-0000-0000-000000000001`, which has no fr row, so an fr
 * project gate here 404s Download / Review / Review-history for ~99.9% of the
 * library (P2-carry).
 *
 * The AGENT path's per-artifact bound-project check does NOT live here: it is in
 * the agent actions (`artifactOfBoundAgentProject` below, and
 * agui/actions/project-outputs.ts `artifactOfBoundProject`), and in the FileCard's
 * mint ONLY when the card names its bound project (`bound_project_id`, see
 * `assertFileCardMint`).
 */
async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  // Intentional no-op for the classic routes — see the block comment above.
}

/**
 * Filter an upstream artifact list down to artifacts whose `project_id` the
 * user can access. Today this is a pass-through (see `assertProjectAccess`),
 * but routing every list through the helper means future enforcement is one
 * function-body change.
 */
async function filterAccessibleArtifacts(
  userId: string,
  artifacts: ArtifactOut[],
): Promise<ArtifactOut[]> {
  const projectIds = new Set(artifacts.map((a) => a.project_id));
  const accessible = new Set<string>();
  for (const pid of projectIds) {
    try {
      await assertProjectAccess(userId, pid);
      accessible.add(pid);
    } catch {
      // Skip artifacts the user can't see; we don't 403 a list call when
      // mixed-project results would otherwise be partially visible.
    }
  }
  return artifacts.filter((a) => accessible.has(a.project_id));
}

/**
 * fr-agui P2-c2 — the AGENT path's per-artifact check: the artifact the upstream
 * answered must name the project the call is for, and in a project-bound
 * conversation that project is the BOUND one (`ctx.projectId`; project-binding
 * already refuses an input naming another project, and the `project-member` RBAC
 * rule gates membership of it). An answer naming any other project — an
 * upstream that did not scope the read — is `project_mismatch`, nothing returned.
 */
function artifactOfBoundAgentProject(
  action: string,
  inputProjectId: string,
  meta: { project_id?: unknown },
  ctx: Pick<ActionContext, 'projectId'>,
): void {
  const expected = (ctx.projectId ?? inputProjectId).toLowerCase();
  if (inputProjectId.toLowerCase() !== expected) {
    throw new ProjectMismatchError(action, 'project_id', ctx.projectId ?? inputProjectId);
  }
  if (typeof meta.project_id !== 'string' || meta.project_id.toLowerCase() !== expected) {
    throw new ProjectMismatchError(action, 'artifact_id', ctx.projectId ?? inputProjectId);
  }
}

/**
 * fr-agui P2-c2 — the FileCard's mint, when the card names the project its
 * conversation is BOUND to (`bound_project_id`; the classic library page never
 * sends it, so its mint is unchanged): that project must be the mint's
 * `project_id` (else 403 `project_mismatch`), readable by the caller through fr's
 * project READ lane (`loadProjectForRead`, else 404 before artifact_service is
 * asked), and the artifact must name it (checked after the upstream read).
 */
async function assertFileCardMint(
  user: Parameters<typeof loadProjectForRead>[1],
  projectId: string,
  boundProjectId: string,
): Promise<void> {
  if (boundProjectId.toLowerCase() !== projectId.toLowerCase()) {
    throw new ProjectMismatchError('artifacts.mint_download_token', 'project_id', boundProjectId);
  }
  await loadProjectForRead(db, user, boundProjectId);
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

const ARTIFACT_KIND_VALUES = ['doc', 'presentation', 'image', 'dataset', 'json', 'graph', 'other'] as const;
const SENSITIVITY_VALUES = ['public', 'internal', 'secret'] as const;
const MANIFEST_SCOPE_VALUES = ['project', 'card', 'step'] as const;

const listFiltersSchema = z
  .object({
    card_id: z.string().uuid().optional(),
    step: z.string().min(1).optional(),
    kind: z.enum(ARTIFACT_KIND_VALUES).optional(),
    sensitivity: z.enum(SENSITIVITY_VALUES).optional(),
    tags: z.union([z.string(), z.array(z.string())]).optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strip();

const projectIdSchema = z.string().uuid();

/**
 * MEASURED in production 2026-08-31, pod fr-79bb8c7465-6chrn:
 *   [http] GET /api/assets/artifacts/00000000-...-000000000000 502 14.7ms
 * A caller omitted `project_id`. This threw `UPSTREAM_BAD_BODY` -> 502, and
 * because it throws BEFORE `emitSpan`, the whole failure left one access-log
 * line with no code, no service and no cause.
 *
 * Its sibling `readOptionalProjectId` below already returned a 400 and said why
 * in its docstring — one file, two answers, and the wrong one on five live
 * endpoints (get, manifest, preview, review, reviews).
 */
function readProjectIdOrThrow(req: Request): string {
  const url = new URL(req.url);
  const raw = url.searchParams.get('project_id');
  if (!raw) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'project_id query parameter is required',
    });
  }
  const parsed = projectIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'project_id must be a UUID',
    });
  }
  return parsed.data;
}

/**
 * Read an optional `project_id` query param. Returns undefined when absent
 * (Library workspace tab) and the parsed UUID when present. Invalid UUIDs
 * surface as a 400 BAD_REQUEST so the caller can correct the input — this is
 * a client-input error, not an upstream-bad-body.
 */
function readOptionalProjectId(req: Request): string | undefined {
  const url = new URL(req.url);
  const raw = url.searchParams.get('project_id');
  if (!raw) return undefined;
  const parsed = projectIdSchema.safeParse(raw);
  if (!parsed.success) {
    // THROWS, like its sibling above, instead of returning `{ error: Response }`.
    // It used to hand-build its own 400 with `jsonResponse`, which meant this
    // one route produced a BAD_REQUEST envelope by a different path from every
    // other error in the file -- two control flows and two builders for one
    // outcome. Its only caller is already inside `withIntegrationCatch`, so the
    // throw lands on the same converter and the response body is unchanged.
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'project_id must be a UUID',
    });
  }
  return parsed.data;
}

function parseListFilters(req: Request): ListArtifactsParams | undefined {
  const url = new URL(req.url);
  const raw: Record<string, string | string[]> = {};
  for (const key of url.searchParams.keys()) {
    if (key === 'project_id') continue;
    if (key === 'tags') {
      raw.tags = url.searchParams.getAll('tags');
    } else {
      const v = url.searchParams.get(key);
      if (v !== null) raw[key] = v;
    }
  }
  if (Object.keys(raw).length === 0) return undefined;

  const parsed = listFiltersSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: `Invalid list filters: ${JSON.stringify(parsed.error.issues)}`,
    });
  }
  const out = parsed.data;
  // Normalize tags to string[] for the upstream URL builder.
  let tags: string[] | undefined;
  if (typeof out.tags === 'string') tags = [out.tags];
  else if (Array.isArray(out.tags)) tags = out.tags;
  return {
    card_id: out.card_id,
    step: out.step,
    kind: out.kind,
    sensitivity: out.sensitivity,
    tags,
    limit: out.limit,
    offset: out.offset,
  } as ListArtifactsParams;
}


// ---------------------------------------------------------------------------
// Preview MIME whitelist
// ---------------------------------------------------------------------------

export const PREVIEW_MAX_BYTES = 1024 * 1024; // 1 MiB hard cap per spec §8.2/§9.2.

const PREVIEW_INLINE_MIMES = new Set<string>([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'text/xml',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

const TEXT_LIKE_MIMES = new Set<string>([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'text/xml',
  'image/svg+xml',
]);

function normalizeMime(mime: string | undefined): string | undefined {
  if (!mime) return undefined;
  const semi = mime.indexOf(';');
  return (semi >= 0 ? mime.slice(0, semi) : mime).trim().toLowerCase();
}

function isInlinePreviewable(mime: string | undefined): boolean {
  const norm = normalizeMime(mime);
  return norm !== undefined && PREVIEW_INLINE_MIMES.has(norm);
}

function isTextLike(mime: string | undefined): boolean {
  const norm = normalizeMime(mime);
  return norm !== undefined && TEXT_LIKE_MIMES.has(norm);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function handleListArtifacts(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
  const user = await validateAuth(req);
  const projectId = readOptionalProjectId(req);
  // ⛔ AN EMPTY SET MUST SAY WHY IT IS EMPTY. `applyEffectiveFilter` returns
  // `[]` for a well-formed-but-unknown project_id, and `effective-query.ts`
  // justifies that `[]` ONLY because the route reports the cause out of band:
  // "an empty set WITHOUT that header would be the defect that comment warns
  // about." This route applies that filter, so it owes that header.
  //
  // Resolved HERE rather than inside `handle` because `handle`'s response
  // mapper only receives `data` — it cannot see why the list is short.
  // `projectExists` is the SAME predicate the filter uses, so header and body
  // can never disagree; on a non-UUID it throws the identical
  // `BadRequestError('project_id must be a UUID')` the filter would have
  // thrown one layer down, only earlier and before any upstream call.
  const projectResolved =
    projectId === undefined ? undefined : await projectExists(projectId);
  const filters = parseListFilters(req);
  const url = new URL(req.url);
  const bound_to = url.searchParams.get('bound_to') ?? undefined;
  const visible_in = url.searchParams.get('visible_in') ?? undefined;
  // Ask for an explicit page. Sending no limit let the upstream apply its own
  // default of 100 — measured in production 2026-09-06, tenant ...0001 holds
  // 45,611 artifacts and this route returned 100 of them with no signal at
  // all. Both upstream endpoints honour `limit` (default 100, max 1000), so
  // the cap is ours to set and ours to report — see page-cap.ts.
  const limit = resolveListLimit(url.searchParams);
  const probe = frameProbe();
  const filtersWithLimit = { ...(filters ?? {}), limit };
  // BOUND MODE: `bound_to` without `visible_in` is served from asset_bindings,
  // id by id (bound-by-id.ts), so a bound artifact beyond upstream row 200 is
  // still returned and `X-Truncated` describes the BOUND set. Same split as
  // decisions.ts; `visible_in` keeps the upstream-page-then-filter path.
  const boundMode = !!bound_to && !visible_in;
  if (boundMode) {
    assertBoundToShape(bound_to!);
    rejectOffsetInBoundMode(filters?.offset);
  }
  let boundTruncated: boolean | undefined;

  return await emitSpan(
    'artifacts.list',
    {
      'user.id': user.id,
      'tenant.id': tryCtxTenantId() ?? null,
      'project.id': projectId ?? null,
      'filters.card_id.present': filters?.card_id !== undefined,
      'filters.kind': filters?.kind ?? null,
      'filters.sensitivity': filters?.sensitivity ?? null,
      'filters.tags.count': filters?.tags?.length ?? 0,
      outcome: 'ok',
    },
    () =>
      handle(
        async () => {
          if (boundMode) {
            if (projectId) await assertProjectAccess(user.id, projectId);
            // No upstream list ran, so its query filters are re-applied to the
            // fetched rows: column equality, the project scope the per-project
            // endpoint would have imposed, and the tag filter — ANY requested tag,
            // as upstream's `tag IN (...)` join matches.
            const eq = fieldEquals<ArtifactOut>({
              project_id: projectId,
              card_id: filters?.card_id,
              step: filters?.step,
              kind: filters?.kind,
              sensitivity: filters?.sensitivity,
            });
            const wantTags = filters?.tags ?? [];
            const bound = await listBoundById<ArtifactOut>(
              'artifact',
              bound_to!,
              limit,
              (aid) => getArtifactById(aid),
              (row) =>
                (eq ? eq(row) : true) &&
                (wantTags.length === 0 ||
                  wantTags.some((t) => (row.tags ?? []).includes(t))),
            );
            boundTruncated = bound.truncated;
            // The same access + effective-set filters the list path applies.
            // They run AFTER the fetch, so `truncated` keeps meaning "more ids
            // are bound than `limit`", never "more rows survived the filters".
            const accessible = await filterAccessibleArtifacts(user.id, bound.items);
            return await applyEffectiveFilter(
              ctxTenantId(user.tenantId),
              'artifact',
              accessible,
              projectId,
              user.tenantName,
            );
          }
          let items: ArtifactOut[];
          if (projectId) {
            await assertProjectAccess(user.id, projectId);
            items = await listArtifacts(projectId, filtersWithLimit);
          } else {
            // Library workspace tab: tenant-scoped list (upstream enforces
            // tenant isolation via visibility_scope).
            items = await listArtifactsCrossProject(filtersWithLimit);
          }
          // Raw upstream length, BEFORE the access/effective/binding filters
          // below: a filtered length cannot tell a capped page from a
          // genuinely short one.
          probe.record(items.length);
          const visibleAccess = await filterAccessibleArtifacts(user.id, items);
          // Foundation Plan 2 task 8: honour the effective-set scope
          // (workspace overrides/blocks) for the project context. With no
          // projectId, applyEffectiveFilter short-circuits to a passthrough.
          const visible = await applyEffectiveFilter(
            ctxTenantId(user.tenantId),
            'artifact',
            visibleAccess,
            projectId,
            user.tenantName,
          );
          return applyBindingFilter('artifact', visible, {
            bound_to,
            visible_in,
          });
        },
        // MERGED, never `{ ...pageCapHeaders(…), ...projectScopeHeaders(…) }`:
        // both helpers set `Access-Control-Expose-Headers` and `jsonResponse`
        // spreads header bags into ONE literal, so a second key would clobber
        // the `X-Applied-Limit, X-Truncated` list this route already publishes.
        (data) =>
          jsonResponse(
            { data },
            200,
            projectScopeHeaders(
              projectResolved,
              pageCapHeaders(limit, probe, boundTruncated),
            ),
          ),
      ),
  );
  });
}

export async function handleGetArtifact(req: Request, artifactId: string): Promise<Response> {
  return withIntegrationCatch(async () => {
  const user = await validateAuth(req);
  const projectId = readProjectIdOrThrow(req);

  return await emitSpan(
    'artifacts.get',
    {
      'user.id': user.id,
      'tenant.id': tryCtxTenantId() ?? null,
      'project.id': projectId,
      'artifact.id': artifactId,
      outcome: 'ok',
    },
    () =>
      handle(
        async () => {
          await assertProjectAccess(user.id, projectId);
          return await getArtifact(projectId, artifactId);
        },
        (data) => jsonResponse({ data }),
      ),
  );
  });
}

export async function handleGetArtifactManifest(
  req: Request,
  scope: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
  const user = await validateAuth(req);
  const projectId = readProjectIdOrThrow(req);

  if (!(MANIFEST_SCOPE_VALUES as readonly string[]).includes(scope)) {
    return jsonResponse(
      { error: { code: 'INVALID_SCOPE', message: `scope must be one of ${MANIFEST_SCOPE_VALUES.join(', ')}` } },
      400,
    );
  }
  const url = new URL(req.url);
  const ref = url.searchParams.get('ref') ?? undefined;

  return await emitSpan(
    'artifacts.manifest',
    {
      'user.id': user.id,
      'tenant.id': tryCtxTenantId() ?? null,
      'project.id': projectId,
      'manifest.scope': scope,
      'manifest.ref.present': ref !== undefined,
      outcome: 'ok',
    },
    () =>
      handle(
        async () => {
          await assertProjectAccess(user.id, projectId);
          return await getManifest(projectId, scope as ManifestScope, ref);
        },
        (data) => jsonResponse({ data }),
      ),
  );
  });
}

export async function handleMintDownloadToken(
  req: Request,
  artifactId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
  const user = await validateAuth(req);
  const body = await readJsonBody<{ project_id?: string; bound_project_id?: unknown }>(req);
  if (!body.project_id) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'project_id is required in request body',
    });
  }
  const projectIdParse = projectIdSchema.safeParse(body.project_id);
  if (!projectIdParse.success) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'project_id must be a UUID',
    });
  }
  const projectId = projectIdParse.data;
  // fr-agui P2-c2: the agent FileCard names its conversation's bound project; the
  // classic library page does not (its mint is unchanged — see assertProjectAccess).
  let boundProjectId: string | undefined;
  if (body.bound_project_id !== undefined) {
    const boundParse = projectIdSchema.safeParse(body.bound_project_id);
    if (!boundParse.success) {
      throw new IntegrationError({
        code: 'BAD_REQUEST',
        message: 'bound_project_id must be a UUID',
      });
    }
    boundProjectId = boundParse.data;
  }

  return await emitSpan(
    'artifacts.download.mint',
    {
      'user.id': user.id,
      'tenant.id': tryCtxTenantId() ?? null,
      'project.id': projectId,
      'artifact.id': artifactId,
      outcome: 'ok',
    },
    () =>
      handle(
        async () => {
          await assertProjectAccess(user.id, projectId);
          if (boundProjectId) await assertFileCardMint(user, projectId, boundProjectId);
          // Verify the artifact actually exists / user has upstream access
          // before issuing a token. Otherwise we'd hand out tokens for
          // not-found artifacts and only fail at resolve time.
          const meta = await getArtifact(projectId, artifactId);
          if (boundProjectId) {
            artifactOfBoundAgentProject('artifacts.mint_download_token', projectId, meta, { projectId: boundProjectId });
          }
          const minted = await mintDownloadToken({
            userId: user.id,
            artifactId,
            projectId,
            // Captured HERE because the resolve route has no request context
            // to read it from — see DownloadTokenPayload.tenant_id.
            tenantId: tryCtxTenantId(),
          });
          const url = `/api/assets/artifacts/${encodeURIComponent(artifactId)}/download?t=${encodeURIComponent(minted.token)}`;
          return {
            url,
            token: minted.token,
            expires_at: new Date(minted.expiresAt * 1000).toISOString(),
            artifact: {
              id: meta.id,
              filename: meta.filename,
              size: meta.size,
              mime: meta.content_type,
            },
          };
        },
        (data) => jsonResponse({ data }, 201),
      ),
  );
  });
}

export async function handleResolveDownload(
  req: Request,
  artifactId: string,
): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get('t');
  if (!token) {
    return jsonResponse(
      { error: { code: 'DOWNLOAD_TOKEN_INVALID', message: 'Missing token query parameter' } },
      401,
    );
  }

  // Resolve early so we can surface DOWNLOAD_TOKEN_* errors with the right
  // status before we even start a span (the span starts after we know who
  // the resolved user is).
  let payload;
  let consumedBefore = false;
  try {
    payload = await resolveDownloadToken(token);
  } catch (err) {
    if (err instanceof DownloadTokenError) {
      if (err.code === 'DOWNLOAD_TOKEN_CONSUMED') consumedBefore = true;
      return jsonResponse(
        { error: { code: err.code, message: err.message } },
        401,
      );
    }
    throw err;
  }

  if (payload.artifact_id !== artifactId) {
    return jsonResponse(
      {
        error: {
          code: 'DOWNLOAD_TOKEN_INVALID',
          message: 'Token does not match requested artifact',
        },
      },
      401,
    );
  }

  const ttlRemaining = Math.max(
    0,
    payload.issued_at + 300 - Math.floor(Date.now() / 1000),
  );

  return await emitSpan(
    'artifacts.download.resolve',
    {
      'user.id': payload.user_id,
      'project.id': payload.project_id,
      'artifact.id': payload.artifact_id,
      'download.ttl_remaining_ms': ttlRemaining * 1000,
      'download.consumed_before': consumedBefore,
      outcome: 'ok',
    },
    async () => {
      // Build a streamed response: the upstream body is piped through 64 KiB
      // chunks into a ReadableStream we hand back to Bun's HTTP layer.
      let metaCT: string | undefined;
      let metaCL: number | undefined;
      let headersFired = false;
      let startError: unknown;

      // Probe headers via the adapter's stream helper. We can't separate the
      // header read from the chunk stream cleanly because both come from one
      // upstream response, so we use the deferred-construction pattern:
      // the response is constructed AFTER the first onHeaders call.
      //
      // To do that without buffering, we kick off the stream on a microtask
      // and synchronize via a Promise that resolves after onHeaders fires.
      let resolveHeaders: (info: { contentType?: string; contentLength?: number }) => void;
      const headersReady = new Promise<{ contentType?: string; contentLength?: number }>(
        (resolve) => {
          resolveHeaders = resolve;
        },
      );

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            await streamArtifact(
              payload.project_id,
              payload.artifact_id,
              {
                onHeaders: (info) => {
                  headersFired = true;
                  metaCT = info.contentType;
                  metaCL = info.contentLength;
                  resolveHeaders({
                    contentType: info.contentType,
                    contentLength: info.contentLength,
                  });
                },
                onChunk: (chunk) => {
                  controller.enqueue(chunk);
                },
                onEnd: () => {
                  controller.close();
                },
              },
              // This route has NO ambient tenant — it authenticates by signed
              // token, not by a bearer, so `getTenantId()` is undefined here.
              // Pass the tenant captured at mint time; it becomes the delegated
              // `X-Effective-Tenant-Id`. A token minted without one (outside
              // any tenant frame) is refused by the client as MISSING_TENANT
              // before anything is sent — artifact_service#52 would 401 a
              // header-less read anyway, and fr never substitutes a tenant.
              payload.tenant_id,
            );
          } catch (err) {
            // If headers never fired, unblock the awaiting code so it can
            // surface the integration-error response instead of hanging.
            // Recorded BEFORE resolving: `headersReady` only ever resolves, so
            // without this the JSON branch below was unreachable and a failed
            // upstream became a 200 with an errored body.
            if (!headersFired) startError = err;
            try {
              resolveHeaders({});
            } catch {
              /* already resolved */
            }
            controller.error(err);
          }
        },
        cancel() {
          // Caller closed the connection — nothing else to do; the upstream
          // fetch's AbortController will fire from the timeout if it must.
        },
      });

      await headersReady;
      if (startError !== undefined) {
        const err = startError;
        if (err instanceof IntegrationError) {
          const status =
            err.upstreamStatus && err.upstreamStatus >= 400 && err.upstreamStatus < 500
              ? err.upstreamStatus
              : 502;
          // Token-authenticated route: no bearer, so the caller is never a
          // verified super-admin and the raw "<service> GET <internal path>
          // returned <status>" sentence is replaced by the generic text.
          return jsonResponse(
            {
              error: {
                code: err.code,
                message: clientSafeIntegrationErrorMessage(err, status),
                upstream: err.upstreamStatus,
              },
            },
            status,
          );
        }
        throw err;
      }

      const headers = new Headers();
      if (metaCT) headers.set('content-type', metaCT);
      if (metaCL !== undefined) headers.set('content-length', String(metaCL));
      headers.set(
        'content-disposition',
        `attachment; filename="artifact-${payload.artifact_id}"`,
      );
      headers.set('cache-control', 'no-store');

      return new Response(stream, { status: 200, headers });
    },
  );
}

/**
 * `?max_bytes=` -> the preview byte budget, or `null` when the value is not a
 * positive integer. Absent -> `PREVIEW_MAX_BYTES`, the declared default.
 *
 * ⚠️ MEASURED 2026-09-08. The guard was `Number.parseInt(maxBytesRaw, 10)` +
 * `!Number.isFinite(n) || n <= 0`, and `parseInt` reads a PREFIX, so values
 * that are not integers at all sailed through it as small positive ones:
 *
 *     ?max_bytes=2.7    -> 2   (preview truncated to TWO bytes)
 *     ?max_bytes=1e400  -> 1   (preview truncated to ONE byte)
 *     ?max_bytes=1e9    -> 1   (the caller asked for ~1 GB and got one byte)
 *
 * Each answered 200 with `truncated: true` and a one- or two-byte body, which a
 * client cannot tell apart from a genuinely tiny artifact. Reading the WHOLE
 * string with `Number` fixes all three, by two different routes: '2.7' and
 * '1e400' (=== Infinity) are not integers and are now REFUSED with the existing
 * `INVALID_MAX_BYTES` 400, while `Number('1e9')` is exactly 1000000000 and IS
 * an integer, so it is honoured and clamped to `PREVIEW_MAX_BYTES` by the
 * `Math.min` below — the largest preview available, which is what was asked
 * for. Refusing '1e9' would be a different defect; it is a well-formed request.
 *
 * ⛔ `Math.min(n, PREVIEW_MAX_BYTES)` is KEPT, not replaced by a refusal above
 * the cap. An over-large `max_bytes` is a well-formed request that this route
 * has always honoured by serving the cap, and turning a live 200 into a 400 is
 * a behaviour change for callers who are not sending garbage. Only values that
 * are not integers are newly refused.
 *
 * ⚠️ An earlier draft of this paragraph justified the clamp by claiming "the
 * AG-UI twin's schema bounds it the same way
 * (`z.number().int().min(1).max(PREVIEW_MAX_BYTES)`)". MEASURED: no such schema
 * exists. `PREVIEW_MAX_BYTES` appears in no file but this one, there is no
 * `agui/actions/artifacts.ts`, and no `z.number().int().min(1).max(...)` in
 * backend/src bounds a byte count. The citation was fabricated, and a zod
 * `.max()` would REJECT rather than clamp in any case — the opposite of this
 * behaviour. The decision above stands on its own reasoning; it never needed
 * that support, and a comment inventing a sibling to lean on is worse than one
 * that simply argues.
 */
export function parsePreviewMaxBytes(raw: string | null): number | null {
  if (raw === null) return PREVIEW_MAX_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, PREVIEW_MAX_BYTES);
}

export async function handleArtifactPreview(
  req: Request,
  artifactId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
  const user = await validateAuth(req);
  const projectId = readProjectIdOrThrow(req);

  const url = new URL(req.url);
  const maxBytes = parsePreviewMaxBytes(url.searchParams.get('max_bytes'));
  if (maxBytes === null) {
    return jsonResponse(
      { error: { code: 'INVALID_MAX_BYTES', message: 'max_bytes must be a positive integer' } },
      400,
    );
  }

  return await emitSpan(
    'artifacts.preview',
    {
      'user.id': user.id,
      'tenant.id': tryCtxTenantId() ?? null,
      'project.id': projectId,
      'artifact.id': artifactId,
      'preview.max_bytes': maxBytes,
      outcome: 'ok',
    },
    () =>
      handle(
        async () => {
          await assertProjectAccess(user.id, projectId);
          // Pre-flight the artifact metadata so we can short-circuit the MIME
          // whitelist BEFORE pulling bytes off the upstream.
          const meta = await getArtifact(projectId, artifactId);
          if (!isInlinePreviewable(meta.content_type)) {
            // Spec §6 — non-whitelist MIMEs return 415 from the preview
            // endpoint so the UI can fall back to the download flow.
            throw new IntegrationError({
              code: 'UPSTREAM_BAD_STATUS',
              message: `Inline preview not available for content-type ${meta.content_type}; use the download endpoint`,
              service: 'artifacts',
              upstreamStatus: 415,
            });
          }

          const { mime, bytes, truncated } = await fetchPreviewBytes(
            projectId,
            artifactId,
            maxBytes,
          );

          const effectiveMime = normalizeMime(mime ?? meta.content_type) ?? 'application/octet-stream';
          const isText = isTextLike(effectiveMime);
          const body = isText
            ? new TextDecoder('utf-8', { fatal: false }).decode(bytes)
            : Buffer.from(bytes).toString('base64');

          return {
            mime: effectiveMime,
            encoding: isText ? 'utf-8' : 'base64',
            body,
            truncated,
            size_bytes: bytes.length,
            artifact: {
              id: meta.id,
              filename: meta.filename,
              size: meta.size,
            },
          };
        },
        (data) => jsonResponse({ data }),
      ),
  );
  });
}

// ---------------------------------------------------------------------------
// AG-UI action registry — five read-only actions per spec §"Agent-callable
// actions". All auto-approval; all idempotent reads. Handlers shell out to
// the same adapter functions the route handlers use, so behaviour stays in
// lockstep.
// ---------------------------------------------------------------------------

const listInputSchema = z.object({
  project_id: z.string().uuid(),
  card_id: z.string().uuid().optional(),
  step: z.string().optional(),
  kind: z.enum(ARTIFACT_KIND_VALUES).optional(),
  sensitivity: z.enum(SENSITIVITY_VALUES).optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});

// ⚠️ `total` is GONE, and it was wrong twice over. (1) The handler sent no
// `limit`, so the upstream applied its own default of 100 (openapi:
// `{"maximum": 1000, "minimum": 1, "default": 100}`) and one page became the
// "total" — tenant …0001 holds 45,611 artifacts and this action reported 100.
// (2) It was measured AFTER `filterAccessibleArtifacts`, so even uncapped it
// was "rows this user may see on this page", never a total of anything.
// `returned` says exactly what it is; `truncated` is the only completeness
// claim that stays true. Same contract as `_lib/page-cap.ts`, in a zod action
// output rather than HTTP headers.
const listOutputSchema = z.object({
  items: z.array(z.unknown()),
  meta: z.object({
    returned: z.number(),
    truncated: z.boolean(),
    limit: z.number().nullable(),
    offset: z.number(),
  }),
});

const getInputSchema = z.object({
  project_id: z.string().uuid(),
  artifact_id: z.string().uuid(),
});

// Output for get/manifest is the upstream payload; we don't re-validate it
// (the upstream has its own schema).
const passthroughOutputSchema = z.unknown();

const manifestInputSchema = z.object({
  project_id: z.string().uuid(),
  scope: z.enum(MANIFEST_SCOPE_VALUES),
  scope_ref: z.string().optional(),
});

const downloadInputSchema = z.object({
  project_id: z.string().uuid(),
  artifact_id: z.string().uuid(),
});

/**
 * fr-agui SPEC §5.5 / F15 — `artifacts.download` is a FILECARD. The download
 * token (`POST /api/assets/artifacts/:id/download-token`, `secrets.output`) is
 * NEVER minted for, returned to, or stored in the agent's transcript: the agent
 * learns which file it is and that it is `revealable`; the card in the user's
 * browser mints the single-use URL under the HUMAN's session and fetches the file.
 */
const downloadOutputSchema = z.object({
  file: z.object({
    artifact_id: z.string(),
    project_id: z.string(),
    filename: z.string().nullable(),
    size: z.number().nullable(),
    mime: z.string().nullable(),
  }),
  revealable: z.literal(true),
  fetched_by: z.literal('file-card'),
});

const previewInputSchema = z.object({
  project_id: z.string().uuid(),
  artifact_id: z.string().uuid(),
  max_bytes: z.number().int().min(1).max(PREVIEW_MAX_BYTES).optional(),
});

const previewOutputSchema = z.object({
  mime: z.string(),
  body: z.string(),
  truncated: z.boolean(),
});

type ListInput = z.infer<typeof listInputSchema>;
type GetInput = z.infer<typeof getInputSchema>;
type ManifestInput = z.infer<typeof manifestInputSchema>;
type DownloadInput = z.infer<typeof downloadInputSchema>;
type PreviewInput = z.infer<typeof previewInputSchema>;

const artifactsListAction: AgentCallableAction<
  ListInput,
  z.infer<typeof listOutputSchema>
> = {
  name: 'artifacts.list',
  kind: 'read',
  description: 'List artifacts produced for a project, with optional filters by card / step / kind / sensitivity / tags.',
  input: listInputSchema,
  output: listOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `artifacts.list:${input.project_id}:${input.card_id ?? ''}:${input.step ?? ''}:${
      input.kind ?? ''
    }:${input.sensitivity ?? ''}:${(input.tags ?? []).join(',')}:${input.limit ?? ''}:${
      input.offset ?? 0
    }`,
  handler: async (input, ctx: ActionContext) => {
    // Decide the page rather than letting the upstream decide it silently —
    // the same reason handleListArtifacts calls resolveListLimit(). The HTTP
    // route reads the value out of the query string; here it arrives already
    // typed and range-checked by listInputSchema, so the default is applied
    // directly. ASSET_LIST_DEFAULT_LIMIT is the shared owner of that number.
    const limit = input.limit ?? ASSET_LIST_DEFAULT_LIMIT;
    const filters: ListArtifactsParams = {
      card_id: input.card_id,
      step: input.step,
      kind: input.kind,
      sensitivity: input.sensitivity,
      tags: input.tags,
      limit,
      offset: input.offset,
    };
    const items = await listArtifacts(input.project_id, filters);
    const visible = await filterAccessibleArtifacts(ctx.userId, items);
    return {
      items: visible,
      meta: {
        // ⚠️ `returned` counts the VISIBLE rows (what the caller got), but
        // `truncated` MUST probe the raw upstream frame. `filterAccessibleArtifacts`
        // drops rows, so probing `visible.length` would report "complete" for
        // a full upstream page whenever the ACL filter removed even one row —
        // under-reporting truncation exactly when filtering is active.
        returned: visible.length,
        truncated: items.length >= limit,
        limit,
        offset: input.offset ?? 0,
      },
    };
  },
  rbac: { type: 'project-member' },
};

const artifactsGetAction: AgentCallableAction<GetInput, ArtifactOut> = {
  name: 'artifacts.get',
  kind: 'read',
  description: 'Fetch the metadata record for a single artifact.',
  input: getInputSchema,
  output: passthroughOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) => `artifacts.get:${input.project_id}:${input.artifact_id}`,
  handler: async (input, ctx: ActionContext) => {
    const meta = await getArtifact(input.project_id, input.artifact_id);
    artifactOfBoundAgentProject('artifacts.get', input.project_id, meta, ctx);
    return meta;
  },
  rbac: { type: 'project-member' },
};

const artifactsManifestAction: AgentCallableAction<ManifestInput, Manifest> = {
  name: 'artifacts.manifest',
  kind: 'read',
  description: 'Fetch a manifest of artifacts grouped by project / card / step scope.',
  input: manifestInputSchema,
  output: passthroughOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `artifacts.manifest:${input.project_id}:${input.scope}:${input.scope_ref ?? ''}`,
  handler: async (input, ctx: ActionContext) => {
    // No artifact to check; the project is the bound one (project-binding + RBAC).
    if (ctx.projectId && ctx.projectId.toLowerCase() !== input.project_id.toLowerCase()) {
      throw new ProjectMismatchError('artifacts.manifest', 'project_id', ctx.projectId);
    }
    return await getManifest(input.project_id, input.scope, input.scope_ref);
  },
  rbac: { type: 'project-member' },
};

const artifactsDownloadAction: AgentCallableAction<
  DownloadInput,
  z.infer<typeof downloadOutputSchema>
> = {
  name: 'artifacts.download',
  kind: 'read',
  description:
    "Offer the user one of this project's artifacts as a file to download: a download card appears in the chat and the " +
    'user downloads it from there. You never receive a download link or token (it is minted in the browser, single-use).',
  input: downloadInputSchema,
  output: downloadOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) => `artifacts.download:${input.project_id}:${input.artifact_id}`,
  handler: async (input, ctx: ActionContext) => {
    // The artifact must exist for THIS (bound) project and name it; nothing is
    // minted here — the FileCard mints under the human's session.
    const meta = await getArtifact(input.project_id, input.artifact_id);
    artifactOfBoundAgentProject('artifacts.download', input.project_id, meta, ctx);
    return {
      file: {
        artifact_id: meta.id,
        project_id: meta.project_id,
        filename: meta.filename ?? null,
        size: typeof meta.size === 'number' ? meta.size : null,
        mime: meta.content_type ?? null,
      },
      revealable: true,
      fetched_by: 'file-card',
    };
  },
  rbac: { type: 'project-member' },
};

const artifactsPreviewAction: AgentCallableAction<
  PreviewInput,
  z.infer<typeof previewOutputSchema>
> = {
  name: 'artifacts.preview',
  kind: 'read',
  description: 'Return inline bytes of an artifact (≤ 1 MiB) for renderable MIMEs (markdown / json / csv / xml / png|jpeg|gif|webp / svg).',
  input: previewInputSchema,
  output: previewOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `artifacts.preview:${input.project_id}:${input.artifact_id}:${input.max_bytes ?? PREVIEW_MAX_BYTES}`,
  handler: async (input, ctx: ActionContext) => {
    const meta = await getArtifact(input.project_id, input.artifact_id);
    artifactOfBoundAgentProject('artifacts.preview', input.project_id, meta, ctx);
    if (!isInlinePreviewable(meta.content_type)) {
      throw new IntegrationError({
        code: 'UPSTREAM_BAD_STATUS',
        message: `Preview not supported for content-type ${meta.content_type}`,
        service: 'artifacts',
        upstreamStatus: 415,
      });
    }
    const { mime, bytes, truncated } = await fetchPreviewBytes(
      input.project_id,
      input.artifact_id,
      input.max_bytes ?? PREVIEW_MAX_BYTES,
    );
    const effectiveMime = normalizeMime(mime ?? meta.content_type) ?? 'application/octet-stream';
    const isText = isTextLike(effectiveMime);
    return {
      mime: effectiveMime,
      body: isText
        ? new TextDecoder('utf-8', { fatal: false }).decode(bytes)
        : Buffer.from(bytes).toString('base64'),
      truncated,
    };
  },
  rbac: { type: 'project-member' },
};

// Eager import-time registration so the AG-UI catalog includes artifacts.*
// before the server starts serving requests. Wrapping in try/catch so a
// hot-reload that re-imports this module doesn't crash on
// ActionAlreadyRegisteredError; in that case the existing entry stays.
function safeRegister<I, O>(action: AgentCallableAction<I, O>): void {
  try {
    registerAction(action);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

safeRegister(artifactsListAction);
safeRegister(artifactsGetAction);
safeRegister(artifactsManifestAction);
safeRegister(artifactsDownloadAction);
safeRegister(artifactsPreviewAction);

// ---------------------------------------------------------------------------
// Human-in-the-loop review (approve / reject / revise)
// ---------------------------------------------------------------------------

const REVIEW_DECISIONS = new Set(['approve', 'reject', 'revise']);

/** 403 `error.code` when the caller is not an eligible decider of this artifact's review. */
const ARTIFACT_REVIEW_NOT_ELIGIBLE_CODE = 'artifact_review_not_eligible' as const;
/** The approvals path's self-decision code (`routes/approvals.ts :: APPROVER_IS_REQUESTER_CODE`). */
const ARTIFACT_REVIEW_SELF_REVIEW_CODE = 'APPROVER_IS_REQUESTER' as const;

/**
 * May the caller record a review DECISION on an artifact? The pure verdict, so the
 * mapping is unit-pinned without a database. The I/O lives in `assertArtifactReviewDecider`.
 *
 * ⭐ THE RIGHTS RULE IS THE SIGN-OFF RULE, NOT A NEW ONE (George R208, 2026-10-14: "sign-off
 * approver rights are enforced by fr"). An artifact review has NO `approvals` row and so no
 * `required_approvers` roster, which is what `routes/approvals.ts :: resolveDecideEligibility`
 * evaluates. Its arms map onto a roster-less decision as follows:
 *
 *   approvals arm (resolveDecideEligibility)        → artifact review
 *   ─────────────────────────────────────────────────────────────────────────────────────
 *   licence caller refused at the door              → same: `assertNotLicenceDecider`
 *     (`assertNotLicenceDecider`, minting ≠ deciding)  (403 `licence_cannot_decide`)
 *   approval loaded TENANT-PINNED                   → the artifact is read under the request
 *                                                     tenant (artifact_service scopes by the
 *                                                     tenant bearer) AND its project must pass
 *                                                     fr's READ gate (`loadProjectForRead`) AND
 *                                                     the artifact must name that project —
 *                                                     each miss is 404 (no existence oracle)
 *   super-admin arm: `isSuperAdmin` + PLATFORM      → `superAdminDecider` (same predicate), or a
 *     active tenant                                   super-admin SWITCHED into this tenant
 *                                                     (`isSuperAdminSwitchedInto`, George
 *                                                     2026-10-27: acts there as a tenant-admin)
 *   P1-TEAM-b 1-of-any tenant-MEMBER arm            → `isTenantMemberForDecision(active tenant)`
 *     (`tenantMemberArmPrecondition`: row tenant ==    with the project tagged for that same
 *     caller's request tenant)                         tenant (a super-admin HOME-VIEW
 *                                                     cross-tenant READ never becomes a write)
 *   roster user_id / realm-role arms                → no analogue: there is no roster to name
 *                                                     the caller or ask for a role. A role
 *                                                     holder still decides through the member
 *                                                     arm, exactly as an un-rostered one does.
 *   requester may not decide own HUMAN-raised row   → the PRODUCER may not review own HUMAN-
 *     (`isHumanRequesterDecidingOwnApproval`;          produced artifact (`created_by_user_id`);
 *     system/n8n-raised rows exempt)                   `origin_kind === 'workflow'` is the
 *                                                     system-raised analogue and is exempt
 *                                                     (P1-TEAM-b: a conveyor output must not
 *                                                     lock its owner out); unknown/absent
 *                                                     origin fails CLOSED (guard applies)
 *   solo-tenant-god self-decision exemption          → same (`readCompleteTenantMembership` is
 *                                                     exactly the caller; fail closed)
 *   one decision per approver / quorum              → no analogue: artifact_service records
 *                                                     every review as history (re-review is a
 *                                                     product feature, not a second vote)
 */
export interface ArtifactReviewDeciderFacts {
  superAdminDecider: boolean;
  isTenantMember: boolean;
  /** The project's `keycloak_tenant_id` tag, or null when untagged. */
  projectTenantId: string | null;
  activeTenantId: string | null;
  callerId: string;
  originKind: string | null;
  producerUserId: string | null;
  callerIsSoloTenantGod: boolean;
}

type ArtifactReviewDeciderVerdict =
  | { ok: true }
  | { ok: false; refusal: 'not_found' | 'not_eligible' | 'self_review' };

export function artifactReviewDeciderVerdict(f: ArtifactReviewDeciderFacts): ArtifactReviewDeciderVerdict {
  // A project tagged for ANOTHER tenant than the one this request acts in: the read lane
  // may show it (super-admin home view) but a decision is a write — answered as absent.
  if (f.projectTenantId && f.activeTenantId && f.projectTenantId !== f.activeTenantId) {
    return { ok: false, refusal: 'not_found' };
  }
  if (!f.superAdminDecider && !f.isTenantMember) return { ok: false, refusal: 'not_eligible' };
  const systemProduced = f.originKind === 'workflow';
  const selfReview = !systemProduced && !!f.producerUserId && f.producerUserId === f.callerId;
  if (selfReview && !f.callerIsSoloTenantGod) return { ok: false, refusal: 'self_review' };
  return { ok: true };
}

function strField(o: unknown, k: string): string | null {
  if (!o || typeof o !== 'object') return null;
  const v = (o as Record<string, unknown>)[k];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * The review decision's gate — every check BEFORE anything is posted upstream. Throws
 * 404 (project unreadable / artifact not of this project), 403 `licence_cannot_decide`,
 * 403 `artifact_review_not_eligible`, 403 `APPROVER_IS_REQUESTER`. Reads the artifact once
 * (`GET` under the route's project; an upstream 404 surfaces as 404).
 */
async function assertArtifactReviewDecider(
  user: Awaited<ReturnType<typeof validateAuth>>,
  projectId: string,
  artifactId: string,
): Promise<void> {
  assertNotLicenceDecider(user);
  const project = await loadProjectForRead(db, user, projectId);
  const meta = await getArtifact(projectId, artifactId);
  if (typeof meta.project_id !== 'string' || meta.project_id.toLowerCase() !== projectId.toLowerCase()) {
    throw new NotFoundError('Artifact not found');
  }
  const activeTenantId = ctxTenantId(user.tenantId) ?? null;
  const superAdminDecider =
    (isSuperAdmin(user) && isPlatformTenant(activeTenantId)) || isSuperAdminSwitchedInto(user, activeTenantId);
  const isTenantMember = superAdminDecider ? false : await isTenantMemberForDecision(activeTenantId, user.id);
  const originKind = strField(meta, 'origin_kind');
  const producerUserId = strField(meta, 'created_by_user_id');
  const needsSolo = originKind !== 'workflow' && producerUserId === user.id;
  let callerIsSoloTenantGod = false;
  if (needsSolo && activeTenantId) {
    const members = await readCompleteTenantMembership(activeTenantId);
    callerIsSoloTenantGod = !!members && members.size === 1 && members.has(user.id);
  }
  const verdict = artifactReviewDeciderVerdict({
    superAdminDecider,
    isTenantMember,
    projectTenantId: strField(project.project_data, 'keycloak_tenant_id'),
    activeTenantId,
    callerId: user.id,
    originKind,
    producerUserId,
    callerIsSoloTenantGod,
  });
  if (verdict.ok) return;
  switch (verdict.refusal) {
    case 'not_found':
      throw new NotFoundError('Project not found');
    case 'not_eligible':
      throw new ForbiddenError(
        'You are not authorized to review this artifact. Recording a review decision requires being a ' +
          'member of the tenant this project belongs to, acting in that tenant (or a super-admin in a ' +
          'platform workspace) — the same rule as deciding approvals. Your membership could not be ' +
          'verified here (or could not be read right now — try again shortly). Nothing was recorded.',
      ).withCode(ARTIFACT_REVIEW_NOT_ELIGIBLE_CODE);
    case 'self_review':
      throw new ForbiddenError(
        'The producer of an artifact may not record its review. Ask another member of this tenant to ' +
          'review it. (A tenant with exactly one member may review its own artifacts, and an artifact a ' +
          'workflow produced is never treated as yours.) Nothing was recorded.',
      ).withCode(ARTIFACT_REVIEW_SELF_REVIEW_CODE);
  }
}

/**
 * POST /api/assets/artifacts/:id/review
 *
 * Body: { decision: 'approve' | 'reject' | 'revise', comment?: string }
 * Required query: project_id=<uuid>
 *
 * Records the decision upstream + best-effort fires the producer's webhook
 * (artifact.review_callback_url) so the n8n workflow can branch on it.
 */
export async function handleSubmitArtifactReview(
  req: Request,
  artifactId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const projectId = readProjectIdOrThrow(req);
    const body = await readJsonBody<Partial<ReviewIn>>(req);
    const decision = typeof body.decision === 'string' ? body.decision : '';
    if (!REVIEW_DECISIONS.has(decision)) {
      throw new IntegrationError({
        code: 'BAD_REQUEST',
        message: '`decision` must be one of: approve, reject, revise',
      });
    }
    const comment = typeof body.comment === 'string' ? body.comment : undefined;
    if (comment && comment.length > 4000) {
      throw new IntegrationError({
        code: 'BAD_REQUEST',
        message: '`comment` must be 4000 characters or fewer',
      });
    }

    return await emitSpan(
      'artifacts.review',
      {
        'user.id': user.id,
        'tenant.id': tryCtxTenantId() ?? null,
        'project.id': projectId,
        'artifact.id': artifactId,
        'review.decision': decision,
        outcome: 'ok',
      },
      () =>
        handle(
          async () => {
            // The decider gate (R208) — project READ lane, artifact-of-project, decide
            // eligibility, self-review. See `artifactReviewDeciderVerdict`.
            await assertArtifactReviewDecider(user, projectId, artifactId);
            const res = await submitArtifactReview(projectId, artifactId, {
              decision: decision as ReviewIn['decision'],
              comment,
            });

            // Fire the producer's webhook AFTER the upstream commits. Pure
            // best-effort — never throws into the user's response.
            const callbackUrl = res.artifact.review_callback_url ?? null;
            if (callbackUrl) {
              void trackDetached(
                fireArtifactReviewCallback(callbackUrl, {
                  artifact_id: artifactId,
                  project_id: projectId,
                  decision: res.review.decision,
                  comment: res.review.comment ?? null,
                  reviewer_id: res.review.reviewer_id,
                  reviewer_tenant_id: res.review.reviewer_tenant_id,
                  reviewed_at: res.review.reviewed_at,
                }),
              );
            }

            return res;
          },
          (data) => jsonResponse({ data }),
        ),
    );
  });
}

/**
 * GET /api/assets/artifacts/:id/reviews
 *
 * Required query: project_id=<uuid>
 * Returns the artifact's review history, oldest-first.
 */
export async function handleListArtifactReviews(
  req: Request,
  artifactId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const projectId = readProjectIdOrThrow(req);

    return await emitSpan(
      'artifacts.reviews.list',
      {
        'user.id': user.id,
        'tenant.id': tryCtxTenantId() ?? null,
        'project.id': projectId,
        'artifact.id': artifactId,
        outcome: 'ok',
      },
      () =>
        handle(
          async () => {
            await assertProjectAccess(user.id, projectId);
            return await listArtifactReviews(projectId, artifactId);
          },
          (data) => jsonResponse({ data }),
        ),
    );
  });
}
