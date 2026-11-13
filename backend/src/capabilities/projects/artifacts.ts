// fr-agui SPEC §13 P4d-2e — spec drain, the LAST routes: the artifact browser
// (routes/assets/artifacts.ts), which had NO operation in the served spec (pinned in
// LEGACY_UNDECLARED), re-expressed with NO behaviour change (`legacyHandler`). Every one is
// a NEW operation (operationId = camelCase(id)), `out-of-agent-scope`, none on the licence
// route allowlist (a licence bearer is refused 403 `licence_route_not_allowed` right after
// routing, before the handler).
//
// The ids are NOT the AG-UI action names: `artifacts.list` / `.get` / `.manifest` /
// `.download` / `.preview` / `.review` are the project agent's hand-written actions
// (routes/assets/artifacts.ts registerAction, agui/actions/project-outputs.ts), unchanged.
// `artifacts.mint_download_token` (the FileCard's route) was declared in P2-c2
// (capabilities/projects/outputs.ts).
//
// Gates (the handlers', declared as the rule): validateAuth (its licence / conveyor doors)
// on every route but the download, which authenticates by the single-use signed token in
// `?t=` (no bearer: `security: []`). Project scoping is artifact_service's tenant isolation
// (the classic `assertProjectAccess` is a deliberate pass-through, see the route module).
// Refusals before the upstream is asked are the integration envelope `{ error: { code,
// message } }` (`withIntegrationCatch`); validateAuth's 401 is `{ error }`.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import { defaultConfirm, defineCapability, type Capability, type HttpMethod, type ResponseSpec } from '../define';
import { lazyHandler } from '../lazy';
import { DOOR_403, VALIDATE_AUTH_401, frErrorBody, pathId, routeRule, unauthorizedBody } from '../library/_shared';
import { isAuthenticatedUser } from '../rbac-rules';
import { LICENCE_ROUTE_DOOR_403, preHandlerRefusalBody } from '../settings/_shared';

/**
 * The server's licence route door: none of these is allowlisted, so a licence bearer is refused
 * 403 before the handler — the download too (the door runs before its own `?t=` check; measured
 * in the P4d-2e audit).
 */
const LICENCE_DOOR: ResponseSpec = {
  status: 403,
  description: `${LICENCE_ROUTE_DOOR_403} Or a request-context refusal (\`code\`), before routing.`,
  schema: preHandlerRefusalBody,
};

const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

const MODULE = { module: 'src/routes/assets/artifacts.ts', load: () => import('../../routes/assets/artifacts') } as const;

const PROJECT_ID_REQUIRED = z
  .string()
  .describe("The artifact's project (a uuid). Missing: 400 `error.code` 'BAD_REQUEST' 'project_id query parameter is required'; not a uuid: 400 'project_id must be a UUID'.");

const UPSTREAM =
  "Any other status is artifact_service's, relayed (`error.code` 'UPSTREAM_…'; its 4xx pass through, its 401 / 5xx or no " +
  "answer is 502, a timeout 504), or fr's own 500. 409: `error.code` 'MISSING_TENANT' (no request tenant: nothing sent).";

function responses(extra: string): ResponseSpec[] {
  return [
    { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
    LICENCE_DOOR,
    { status: 'default', description: `${extra}${DOOR_403} ${UPSTREAM}`, schema: frErrorBody },
  ];
}

const artifactRow = z
  .object({
    id: z.string(),
    project_id: z.string(),
    filename: z.string(),
    content_type: z.string().optional(),
    size: z.number().optional(),
    kind: z.string().optional(),
    sensitivity: z.string().optional(),
    tags: z.array(z.string()).optional(),
    card_id: z.string().nullable().optional(),
    step: z.string().nullable().optional(),
    review_callback_url: z
      .string()
      .nullable()
      .optional()
      .describe("🔐 SECRET (secrets.output): the producer's review webhook (an n8n webhook path), as artifact_service stores it."),
  })
  .passthrough()
  .describe("artifact_service's artifact metadata, unchanged.");

const reviewRow = z
  .object({
    decision: z.enum(['approve', 'reject', 'revise']),
    comment: z.string().nullable().optional(),
    reviewer_id: z.string(),
    reviewer_tenant_id: z.string().nullable().optional(),
    reviewed_at: z.string(),
  })
  .passthrough();

interface ArtifactRoute {
  id: `${string}.${string}`;
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  handler: string;
  effect: Capability['effect'];
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
  responses: ResponseSpec[];
  queryFields?: string[];
  responseContentType?: string;
  /** `[]`: no bearer (the download's signed token). Default: the document-level bearerAuth. */
  security?: Array<Record<string, string[]>>;
  principal?: Capability['auth']['principal'];
  secrets?: { input?: string[]; output?: string[] };
}

const rule = routeRule(isAuthenticatedUser);

function artifactCapabilities(routes: ReadonlyArray<ArtifactRoute>): ReadonlyArray<Capability<unknown, unknown>> {
  return routes.map((r) =>
    defineCapability({
      id: r.id,
      area: 'projects',
      summary: r.summary,
      ...(r.description !== undefined ? { description: r.description } : {}),
      http: {
        method: r.method,
        path: r.path,
        operationId: camel(r.id),
        ...(r.queryFields !== undefined ? { queryFields: r.queryFields } : {}),
        ...(r.responseContentType !== undefined ? { responseContentType: r.responseContentType } : {}),
      },
      input: r.input,
      output: r.output,
      errors: [],
      auth: { principal: r.principal ?? 'user', rbac: rule({ method: r.method, path: r.path }) },
      tenancy: 'tenant',
      effect: r.effect,
      confirm: defaultConfirm(r.effect),
      ...(r.secrets !== undefined ? { secrets: r.secrets } : {}),
      agent: { expose: false, reason: 'out-of-agent-scope' },
      openapi: {
        tags: ['Artifacts'],
        responses: [...r.responses],
        ...(r.security !== undefined ? { security: r.security } : {}),
      },
      legacyHandler: lazyHandler(MODULE.load, { module: MODULE.module, exportName: r.handler }),
    }),
  );
}

export const ARTIFACT_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = artifactCapabilities([
  {
    id: 'artifacts.list_artifacts', method: 'GET', path: '/api/assets/artifacts', handler: 'handleListArtifacts', effect: 'read',
    summary: "The request tenant's artifacts (the Artifacts library): one project's, or across the tenant's projects",
    description:
      'With `project_id`: that project\'s artifacts (an unknown but well-formed id is an empty list, reported by the project-scope ' +
      'headers). Without: the tenant-scoped list across projects. `bound_to` without `visible_in` serves the artifacts BOUND to that ' +
      'project id by id (asset_bindings), so a bound artifact past the upstream page is still returned. The page is capped ' +
      '(`limit`, default 200, max 1000): `X-Applied-Limit` / `X-Truncated` say whether more rows exist.',
    input: z.object({
      project_id: z.string().optional().describe('A uuid; not a uuid is 400 BAD_REQUEST. Absent: the cross-project list.'),
      card_id: z.string().optional().describe('A uuid (else 400 BAD_REQUEST "Invalid list filters").'),
      step: z.string().optional(),
      kind: z.enum(['doc', 'presentation', 'image', 'dataset', 'json', 'graph', 'other']).optional(),
      sensitivity: z.enum(['public', 'internal', 'secret']).optional(),
      tags: z.union([z.string(), z.array(z.string())]).optional().describe('Repeatable: an artifact matches ANY of them.'),
      limit: z.coerce.number().int().optional().describe('1..1000 (else 400 BAD_REQUEST); default 200.'),
      offset: z.coerce.number().int().optional().describe('>= 0; refused (400) in bound mode.'),
      bound_to: z.string().optional().describe('A project id: only the artifacts bound to it.'),
      visible_in: z.string().optional().describe('A project id: the artifacts visible in it (bindings + effective set).'),
    }),
    output: z.object({ data: z.array(artifactRow) }),
    responses: responses(
      "400: `error.code` 'BAD_REQUEST' (`project_id` / `card_id` not a uuid, an invalid filter, a malformed `bound_to`, `offset` in bound mode). ",
    ),
    secrets: { output: ['/data/review_callback_url'] },
  },
  {
    id: 'artifacts.get_manifest', method: 'GET', path: '/api/assets/artifacts/manifest/:scope', handler: 'handleGetArtifactManifest', effect: 'read',
    summary: "The artifact manifest of a project, a card or a step",
    input: z.object({
      scope: z.string().min(1).describe("'project' | 'card' | 'step' (else 400 `error.code` 'INVALID_SCOPE')."),
      project_id: PROJECT_ID_REQUIRED,
      ref: z.string().optional().describe('The card id / step name the scope names.'),
    }),
    output: z.object({ data: z.unknown().describe("artifact_service's manifest, unchanged.") }),
    responses: responses("400: `error.code` 'BAD_REQUEST' (project_id) or 'INVALID_SCOPE'. "),
  },
  {
    id: 'artifacts.resolve_download', method: 'GET', path: '/api/assets/artifacts/:id/download', handler: 'handleResolveDownload', effect: 'read',
    summary: 'Download an artifact with a single-use signed token (the URL the download-token mint returned)',
    description:
      'No bearer: the signed token in `t` (minted by POST /api/assets/artifacts/{id}/download-token, 5 minutes, single use) names the ' +
      "caller, the artifact, the project and the tenant. The body is the artifact's bytes, streamed (`content-disposition: " +
      'attachment`). 🔐 `t` is a SECRET INPUT.',
    input: z.object({
      id: pathId('The artifact id (must equal the one the token was minted for)'),
      t: z.string().describe('🔐 SECRET (secrets.input): the signed download token. Missing: 401 DOWNLOAD_TOKEN_INVALID.'),
    }),
    output: z.unknown().describe("The artifact's bytes (application/octet-stream or its stored content type)."),
    responseContentType: 'application/octet-stream',
    security: [],
    principal: 'public',
    secrets: { input: ['/t'] },
    responses: [
      {
        status: 401,
        description:
          "`error.code` 'DOWNLOAD_TOKEN_INVALID' (missing, malformed, bad signature, or minted for another artifact), " +
          "'DOWNLOAD_TOKEN_EXPIRED' or 'DOWNLOAD_TOKEN_CONSUMED' (already used).",
        schema: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
      },
      LICENCE_DOOR,
      {
        status: 'default',
        description:
          "artifact_service failing before the first byte: `error.code` 'UPSTREAM_…' with its 4xx relayed, else 502 (a generic " +
          "message: no bearer, so never the raw upstream sentence). A licence-shaped bearer: 403 `code` 'licence_route_not_allowed'. " +
          "fr's own 500.",
        schema: frErrorBody,
      },
    ],
  },
  {
    id: 'artifacts.preview_artifact', method: 'GET', path: '/api/assets/artifacts/:id/preview', handler: 'handleArtifactPreview', effect: 'read',
    summary: "An artifact's inline preview (text as utf-8, an image as base64), capped at 1 MiB",
    description:
      'Only whitelisted content types preview (text/plain, markdown, csv, json, xml, png, jpeg, gif, webp, svg); any other is 415 ' +
      "(`error.code` 'UPSTREAM_BAD_STATUS': use the download). `truncated` says the body was cut at `max_bytes`.",
    input: z.object({
      id: pathId('The artifact id'),
      project_id: PROJECT_ID_REQUIRED,
      max_bytes: z.string().optional().describe("A positive integer, clamped to 1048576 (else 400 `error.code` 'INVALID_MAX_BYTES'). Default 1048576."),
    }),
    output: z.object({
      data: z.object({
        mime: z.string(),
        encoding: z.enum(['utf-8', 'base64']),
        body: z.string(),
        truncated: z.boolean(),
        size_bytes: z.number().int(),
        artifact: z.object({ id: z.string(), filename: z.string(), size: z.number().optional() }).passthrough(),
      }),
    }),
    responses: responses("400: `error.code` 'BAD_REQUEST' (project_id) or 'INVALID_MAX_BYTES'. 415: not previewable. "),
  },
  {
    id: 'artifacts.submit_review', method: 'POST', path: '/api/assets/artifacts/:id/review', handler: 'handleSubmitArtifactReview', effect: 'write',
    summary: 'Record a human review decision on an n8n-produced artifact (approve / reject / revise)',
    description:
      'Gated first by fr (project READ gate, artifact-of-project, the sign-off decide rule, no self-review), then ' +
      "recorded by artifact_service; then fr fires the producer's review webhook (the artifact's `review_callback_url`) best-effort, " +
      'so the workflow resumes — a failed callback never fails this answer.',
    input: z.object({
      id: pathId('The artifact id'),
      project_id: PROJECT_ID_REQUIRED,
      decision: z.enum(['approve', 'reject', 'revise']).describe("Else 400 `error.code` 'BAD_REQUEST'."),
      comment: z.string().optional().describe('At most 4000 characters (else 400 BAD_REQUEST).'),
    }),
    queryFields: ['project_id'],
    output: z.object({ data: z.object({ artifact: artifactRow, review: reviewRow }).passthrough() }),
    responses: responses(
      "400: `error.code` 'BAD_REQUEST' (project_id; the body is not JSON; `decision` not approve / reject / revise; `comment` over 4000). " +
        "404: the project is not readable by the caller (fr's project READ gate), the artifact is not in the request tenant, or it " +
        'does not name this project — one answer, no existence oracle; nothing recorded. ' +
        "403 `code` 'artifact_review_not_eligible': not an eligible decider (the approvals rule, R208: a member of the project's " +
        'tenant acting in it, or a super-admin in a platform workspace). ' +
        "403 `code` 'APPROVER_IS_REQUESTER': the producer of a human-produced artifact reviewing it (a workflow-produced artifact " +
        "and a one-member tenant are exempt). ",
    ),
    secrets: { output: ['/data/artifact/review_callback_url'] },
  },
  {
    id: 'artifacts.list_reviews', method: 'GET', path: '/api/assets/artifacts/:id/reviews', handler: 'handleListArtifactReviews', effect: 'read',
    summary: "An artifact's review history, oldest first",
    input: z.object({ id: pathId('The artifact id'), project_id: PROJECT_ID_REQUIRED }),
    output: z.object({ data: z.array(reviewRow) }),
    responses: responses("400: `error.code` 'BAD_REQUEST' (project_id). "),
  },
  {
    id: 'artifacts.get_artifact', method: 'GET', path: '/api/assets/artifacts/:id', handler: 'handleGetArtifact', effect: 'read',
    summary: "One artifact's metadata",
    input: z.object({ id: pathId('The artifact id'), project_id: PROJECT_ID_REQUIRED }),
    output: z.object({ data: artifactRow }),
    responses: responses("400: `error.code` 'BAD_REQUEST' (project_id). "),
    secrets: { output: ['/data/review_callback_url'] },
  },
]);
