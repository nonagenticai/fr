// fr-agui SPEC §13 P2 (P2-c2) — the project's OUTPUTS and lifecycle, declared.
//
//   artifacts.mint_download_token   POST /api/assets/artifacts/:id/download-token —
//                               declared (moved out of LEGACY_UNDECLARED) so its
//                               single-use URL + token are `secrets.output` (SPEC §5.5,
//                               review F15). It is the FileCard's route, called by the
//                               browser under the HUMAN's session; never agent-exposed
//                               (`artifacts.download` returns the file, never a token).
//                               The classic library's mint is unchanged (tenant-
//                               scoped upstream; most artifact project ids are not
//                               fr rows). The FileCard sends `bound_project_id`: then
//                               the bound project must be the mint's, readable by the
//                               caller (fr's read lane, 404 before artifact_service is
//                               asked), and the artifact must name it (P2-c2).
//
// The artifact review and the project-settings writes (provision, archive) are agent
// actions over EXISTING routes (agui/actions/project-outputs.ts): their routes keep
// their own declarations (the openapi literal, or LEGACY_UNDECLARED).
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import { defineCapability, type Capability, type ResponseSpec } from '../define';
import { lazyHandler } from '../lazy';
import { frErrorBody, pathId, routeRule } from '../library/_shared';
import { isAuthenticatedUser } from '../rbac-rules';

const PROJECT_NOT_FOUND_404: ResponseSpec = { status: 404, description: "`error` 'Project not found': absent, not readable by the caller (another tenant's), or not a uuid — one answer.", schema: frErrorBody };

// ---------------------------------------------------------------------------
// The FileCard's route: mint a single-use artifact download URL (F15)
// ---------------------------------------------------------------------------

const MINT_ROUTE = { method: 'POST' as const, path: '/api/assets/artifacts/:id/download-token' };

export const ARTIFACT_DOWNLOAD_TOKEN_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  defineCapability({
    id: 'artifacts.mint_download_token',
    area: 'projects',
    summary: "Mint a single-use, 5-minute download URL for one of a project's artifacts (the FileCard's route)",
    description:
      "Checks the artifact exists for `project_id` (the upstream read is project-scoped) and mints a signed, single-use " +
      "token bound to the caller, the artifact, the project and the request tenant. 🔐 `url` and `token` are SECRET OUTPUT: " +
      "the browser fetches GET `url` once, under the human's session; never hand them to an agent. Without `bound_project_id` " +
      "(the Artifacts library) the project is not checked by fr: artifact_service's tenant scope is the boundary. With it " +
      "(the agent FileCard) it must equal `project_id` (else 403 'project_mismatch'), be a project the caller can read (fr's " +
      "project read lane: any member of its tenant; else 404 'Project not found' and nothing is asked of artifact_service), " +
      "and the artifact must name it (else 403 'project_mismatch', nothing minted).",
    http: { ...MINT_ROUTE, operationId: 'artifactsMintDownloadToken', successStatus: 201 },
    input: z.object({
      id: pathId('The artifact id'),
      project_id: z.string().uuid().describe("Required (else 400 BAD_REQUEST): the artifact's project."),
      bound_project_id: z
        .string()
        .uuid()
        .optional()
        .describe("The agent FileCard's bound project (else 400 BAD_REQUEST if not a uuid); absent from the library page's mint."),
    }),
    output: z.object({
      data: z.object({
        url: z.string().describe('🔐 SECRET (secrets.output): /api/assets/artifacts/{id}/download?t=<token>, single use, 5 minutes.'),
        token: z.string().describe('🔐 SECRET (secrets.output): the signed download token.'),
        expires_at: z.string(),
        artifact: z.object({ id: z.string(), filename: z.string(), size: z.number(), mime: z.string() }).passthrough(),
      }),
    }),
    errors: [],
    auth: { principal: 'user', rbac: routeRule(isAuthenticatedUser)(MINT_ROUTE) },
    tenancy: 'tenant',
    effect: 'read',
    confirm: 'none',
    secrets: { output: ['/data/url', '/data/token'] },
    agent: { expose: false, reason: 'out-of-agent-scope' },
    openapi: {
      tags: ['Projects'],
      responses: [
        { status: 401, description: "validateAuth's 401 (`error`: 'Missing or invalid Authorization header' / 'Invalid or expired token').", schema: z.object({ error: z.string() }) },
        PROJECT_NOT_FOUND_404,
        {
          status: 'default',
          description:
            "400: `error.code` 'BAD_REQUEST' (`project_id` missing or not a uuid; `bound_project_id` not a uuid; the body is not JSON). " +
            "403: `code` 'project_mismatch' (FileCard: `bound_project_id` is not `project_id`, or the artifact names another project); " +
            "validateAuth's route doors (`code` 'licence_route_not_allowed', 'conveyor_route_forbidden'). 409: `error.code` 'MISSING_TENANT'. Any other status is " +
            "artifact_service's, relayed (`error.code` 'UPSTREAM_…', e.g. its 404 for an artifact not in that project), or fr's own 500.",
          schema: frErrorBody,
        },
      ],
    },
    legacyHandler: lazyHandler(() => import('../../routes/assets/artifacts'), {
      module: 'src/routes/assets/artifacts.ts',
      exportName: 'handleMintDownloadToken',
    }),
  }),
];
