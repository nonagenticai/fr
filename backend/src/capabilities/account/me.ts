// fr-agui SPEC §13 P4b (part 3) — spec drain: the caller's own account surface
// under `/api/me`, re-expressed with NO behaviour change (`legacyHandler`):
//
//   * `/api/me/channels` (routes/me/channels.ts) — the caller's channel
//     preferences, keyed by the caller's id;
//   * `/api/me/licenses[/by-tenant|/:id/regenerate-token]` (routes/me/licenses.ts);
//   * `GET /api/me/workspace`, `GET /api/me/workspaces` (routes/me/workspace{,s}.ts);
//   * `GET /api/me/projects/artifacts` (routes/me/projects-artifacts.ts).
// Left pinned: me/approval-workspaces (the approvals inbox), me/project-workspaces
// (P1). P4c part 2 adds `GET /api/me/super-admin` (routes/admin/super-admin.ts; the
// handler catches the validateAuth throw itself) and `GET /api/me/dept-roles`
// (routes/me/dept-roles.ts; validateAuth thrown): `isAuthenticatedUser`, the caller's
// own facts (`self`).
//
// Gates, as the handlers enforce them:
//   * channel prefs, licences, workspaces — validateAuth only (its doors):
//     `isAuthenticatedUser`; the licence handlers and the workspace list catch the
//     throw themselves (see _shared.ts `caughtAuthResponses`);
//   * `/licenses/by-tenant` — + the `super_admin` realm role (403 'forbidden'):
//     `isAuthenticatedSuperAdmin`;
//   * `/workspace` — `ctxTenantId(user.tenantId)` (throws → 500 with neither a frame
//     nor a JWT tenant): `isAuthenticatedUserInResolvedTenant`;
//   * `/projects/artifacts` — artifact_service's client is `requireTenant` (the
//     frame tenant, non-blank after trim, else 409 MISSING_TENANT, nothing sent):
//     `isAuthenticatedUserInFrameTenant`.
//
// 🔐 `POST /api/me/licenses/:id/regenerate-token` RETURNS the new raw licence
// token (licenses `RegenerateTokenResponse.token`, shown once): `secrets.output`.
// The licence list carries no token: licenses' `LicenseResponse` (License.to_dict)
// emits no token, hash or key. Its `metadata` is a free-form object set by whoever
// created the licence — opaque here, with no guarantee it is secret-free.
import { z } from 'zod';

import { PrefSchema, ReplaceBodySchema } from '../../routes/me/channels-schemas';
import {
  isAuthenticatedSuperAdmin,
  isAuthenticatedUser,
  isAuthenticatedUserInFrameTenant,
  isAuthenticatedUserInResolvedTenant,
} from '../rbac-rules';
import { caughtAuthResponses, isoTime, pathId, routeRule, settingsCapabilities, standardResponses } from './_shared';

// ── channel preferences ──────────────────────────────────────────────────────

/** A `user_channel_prefs` row (domain/engagement/channel-prefs.ts `UserChannelPref`). */
const channelPref = z.object({
  id: z.string(),
  user_id: z.string(),
  channel: z.string(),
  address: z.string(),
  tenant_id: z.string().nullable(),
  enabled: z.boolean(),
  is_default: z.boolean(),
  created_at: isoTime,
  updated_at: isoTime,
});

const PREF_422 = "422: `error` 'Validation error' (the body fails the schema; `details`), or `code` 'channel_tenant_not_a_membership' (`tenant_id` is not one of the caller's workspaces). 400: `error` 'invalid JSON body'. ";

export const MY_CHANNEL_PREF_CAPABILITIES = settingsCapabilities(
  {
    area: 'me', tag: 'Account', tenancy: 'self',
    module: 'src/routes/me/channels.ts', load: () => import('../../routes/me/channels'),
    rule: routeRule(isAuthenticatedUser),
  },
  [
    {
      id: 'me.list_channel_prefs', method: 'GET', path: '/api/me/channels', handler: 'handleListMyChannels',
      summary: "The caller's own channel preferences (where to reach them)", effect: 'read',
      input: z.object({}), output: z.object({ data: z.array(channelPref) }), responses: standardResponses(),
    },
    {
      id: 'me.replace_channel_prefs', method: 'PUT', path: '/api/me/channels', handler: 'handleReplaceMyChannels',
      summary: "Replace all of the caller's channel preferences", effect: 'write',
      input: ReplaceBodySchema, output: z.object({ data: z.array(channelPref) }), responses: standardResponses(PREF_422),
    },
    {
      id: 'me.list_channel_commands', method: 'GET', path: '/api/me/channel-commands', handler: 'handleListChannelCommands',
      summary: 'The channels that can run fr commands, how to link each, the commands they accept, and the workspaces a link can act in', effect: 'read',
      input: z.object({}),
      output: z.object({
        data: z.object({
          channels: z.array(z.object({ channel: z.string(), label: z.string(), commands: z.boolean(), link: z.string() })),
          commands: z.array(z.object({ usage: z.string(), description: z.string(), capability: z.string(), confirms: z.boolean() })),
          workspaces: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
        }),
      }),
      responses: standardResponses(),
    },
    {
      id: 'me.add_channel_pref', method: 'POST', path: '/api/me/channels', handler: 'handleAddMyChannel',
      summary: 'Add one channel preference for the caller', effect: 'write', successStatus: 201,
      input: PrefSchema, output: z.object({ data: channelPref }), responses: standardResponses(PREF_422),
    },
    {
      id: 'me.delete_channel_pref', method: 'DELETE', path: '/api/me/channels/:id', handler: 'handleDeleteMyChannel',
      summary: 'Delete one of the caller\'s channel preferences', effect: 'destructive', successStatus: 204,
      input: z.object({ id: pathId('Channel preference id (uuid)') }), output: z.null(),
      responses: standardResponses("404: `error` 'Channel preference not found' (absent, another user's, or not a uuid). "),
    },
  ],
);

// ── licences ─────────────────────────────────────────────────────────────────

/** licenses `AppInfo`. */
const appInfo = z.object({ id: z.string(), key: z.string(), name: z.string() }).passthrough();
/** licenses `PlanInfo` (the per-subject list never fills it: null there). */
const planInfo = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    rate_limit_rpm: z.number().int().nullable().optional(),
    rate_limit_burst: z.number().int().nullable().optional(),
    quota_monthly: z.number().int().nullable().optional(),
    token_budget_monthly: z.number().int().nullable().optional(),
  })
  .passthrough();

/** licenses `LicenseResponse` (GET /licenses/user/{subject_id}), relayed unchanged; fr keeps the fr-app ones. */
const licence = z
  .object({
    id: z.string(),
    subject_id: z.string(),
    tenant_id: z.string(),
    app_id: z.string(),
    plan_id: z.string(),
    region_id: z.string().nullable(),
    status: z.string(),
    effective_status: z.string().nullable().optional().describe('active | pending | expired | revoked'),
    starts_at: z.string(),
    expires_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    revoked_at: z.string().nullable(),
    metadata: z
      .record(z.unknown())
      .nullable()
      .describe('Free-form, set by whoever created the licence. Opaque: not guaranteed to be free of sensitive values.'),
    app: appInfo.describe('Always set: fr keeps only the licences whose app is an fr app.'),
    plan: planInfo.nullable().optional(),
  })
  .passthrough();

const period = z.object({ from: z.string(), to: z.string() });
const myUsage = z.object({
  subject_id: z.string(),
  period,
  totals: z.object({ request_count: z.number(), denied_count: z.number(), budget_denied_count: z.number() }),
  by_service: z.array(
    z.object({ service_key: z.string(), request_count: z.number(), denied_count: z.number(), budget_denied_count: z.number() }),
  ),
});
const myCosts = z.object({
  subject_id: z.string(),
  period,
  totals: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    total_cost_usd: z.string().nullable().describe("Billed for a member, incurred for a super_admin; null when the tenant's markup is unknown."),
  }),
  cost_basis: z.enum(['incurred', 'billed', 'unavailable']),
  by_provider: z
    .array(z.object({ provider: z.string(), input_tokens: z.number(), output_tokens: z.number(), total_cost_usd: z.string() }))
    .describe('Incurred per-provider cost: a super_admin only (empty for everyone else).'),
});

export const MY_LICENCE_CAPABILITIES = settingsCapabilities(
  {
    area: 'me', tag: 'Account', tenancy: 'self',
    module: 'src/routes/me/licenses.ts', load: () => import('../../routes/me/licenses'),
    rule: routeRule(isAuthenticatedUser),
  },
  [
    {
      id: 'me.list_licenses', method: 'GET', path: '/api/me/licenses', handler: 'handleListMyLicenses',
      summary: "The caller's fr licences (fr / kanban / n8n), with the active workspace's month-to-date usage and cost", effect: 'read',
      description:
        'One upstream failing does not fail the answer: its card is empty and `upstream_errors` names it. All three of ' +
        'licences, usage and costs failing is a 503.',
      // The licences are the caller's own, but `usage` / `costs` are the ACTIVE WORKSPACE's month-to-date rollup
      // (the whole tenant, not the subject; no active workspace → empty): `tenant`, like me.get_usage_summary.
      tenancy: 'tenant',
      input: z.object({}),
      output: z.object({
        subject_id: z.string(),
        licenses: z.array(licence),
        usage: myUsage,
        costs: myCosts,
        upstream_errors: z.record(z.literal('unavailable')).optional().describe('Which card is degraded (licenses / usage / costs / markup).'),
      }),
      responses: caughtAuthResponses(
        { status: '401' },
        "503: `error` 'upstream_unavailable', `detail` the failed cards (licences, usage and costs all failed). ",
      ),
    },
    {
      id: 'me.list_licenses_by_tenant', method: 'GET', path: '/api/me/licenses/by-tenant', handler: 'handleListMyLicensesByTenant',
      summary: "Super-admin: the caller's fr licences in every workspace they can act in", effect: 'read',
      description: 'A tenant whose licence read fails is listed with `licenses: []` (recorded, not answered).',
      input: z.object({}),
      output: z.object({
        items: z.array(z.object({ tenant_id: z.string(), tenant_name: z.string().nullable(), licenses: z.array(licence) })),
      }),
      responses: caughtAuthResponses({ status: '401' }, "403: `error` 'forbidden' (not a super_admin). "),
      rule: routeRule(isAuthenticatedSuperAdmin),
      tenancy: 'platform',
    },
    {
      id: 'me.regenerate_license_token', method: 'POST', path: '/api/me/licenses/:id/regenerate-token', handler: 'handleRegenerateMyLicenseToken',
      summary: "Rotate the token of one of the caller's licences (the new token is returned once)", effect: 'write',
      description:
        "🔐 The answer carries the NEW raw licence token (secrets.output): never hand it to an agent. The licence must be one " +
        "of the caller's own (else 404); at most 10 rotations a minute per caller (429).",
      input: z.object({ id: pathId('Licence id') }),
      output: z
        .object({
          token: z.string().describe('🔐 SECRET: the new raw licence token (shown once).'),
          message: z.string(),
          expires_at: z.string().nullable().optional().describe('null: the token never expires.'),
        })
        .passthrough(),
      responses: caughtAuthResponses(
        { status: '401', write: true },
        "404: `error` 'license not found' (not one of the caller's licences). 429: `error` 'rate limited', `retry_after_seconds`. " +
          "Any licenses refusal keeps its status (`error.code` 'UPSTREAM_…', `error.upstream.body` its `detail`: e.g. 409 " +
          "license_not_active / all_tokens_revoked / all_tokens_expired, 403 not your license); its 5xx or no answer is 502. ",
      ),
      secrets: { output: ['/token'] },
    },
  ],
);

// ── workspaces ───────────────────────────────────────────────────────────────

export const MY_WORKSPACE_CAPABILITIES = settingsCapabilities(
  {
    area: 'me', tag: 'Account', tenancy: 'self',
    module: 'src/routes/me/workspace.ts', load: () => import('../../routes/me/workspace'),
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
  },
  [
    {
      id: 'me.get_workspace', method: 'GET', path: '/api/me/workspace', handler: 'handleGetMyWorkspace',
      summary: 'The workspace the caller is acting in (the request tenant)', effect: 'read',
      input: z.object({}),
      output: z.object({
        tenant_id: z.string(),
        tenant_name: z.string().nullable(),
      }),
      responses: standardResponses('', { noTenant500: true }),
    },
  ],
);

export const MY_WORKSPACES_CAPABILITIES = settingsCapabilities(
  {
    area: 'me', tag: 'Account', tenancy: 'self',
    module: 'src/routes/me/workspaces.ts', load: () => import('../../routes/me/workspaces'),
    rule: routeRule(isAuthenticatedUser),
  },
  [
    {
      id: 'me.list_workspaces', method: 'GET', path: '/api/me/workspaces', handler: 'handleListMyWorkspaces',
      summary: 'Every workspace the caller can act in (the workspace switcher)', effect: 'read',
      input: z.object({}),
      output: z.object({
        workspaces: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            kind: z.enum(['system', 'kata', 'execution', 'customer']),
            role: z.string().describe("A user_roles role, 'own_workspace', or 'super_admin_scope'. On a Non-Agentic AI super-admin session every row but the caller's own is 'workspace-admin' (tenant-admin once switched in)."),
            source: z.enum(['membership', 'super_admin_scope', 'own_workspace']),
            archived_at: z.string().nullable(),
          }),
        ),
      }),
      responses: caughtAuthResponses({ status: 'own' }, ''),
    },
  ],
);

// ── cross-project artifacts ──────────────────────────────────────────────────

const ARTIFACT_KINDS = ['doc', 'presentation', 'image', 'dataset', 'json', 'graph', 'other'] as const;

/** artifact_service `ArtifactOut` (GET /api/artifacts), relayed unchanged. */
const artifact = z
  .object({
    id: z.string(),
    version: z.number().int(),
    filename: z.string(),
    content_type: z.string(),
    kind: z.enum(ARTIFACT_KINDS),
    project_id: z.string(),
    card_id: z.string().nullable().optional(),
    step: z.string().nullable().optional(),
    container_name: z.string().nullable().optional(),
    sensitivity: z.enum(['public', 'internal', 'secret']),
    size: z.number().int(),
    sha256: z.string(),
    storage_key: z.string(),
    created_at: z.string(),
    created_by: z.string(),
    tags: z.array(z.string()),
    status: z.enum(['pending', 'approved', 'rejected', 'needs_revision']),
    publish_status: z.enum(['draft', 'published']),
    is_system: z.boolean(),
    review_callback_url: z.string().nullable().optional(),
    origin_kind: z.string(),
    origin_project_id: z.string().nullable().optional(),
    origin_workflow_run_id: z.string().nullable().optional(),
    created_by_user_id: z.string(),
  })
  .passthrough();

export const MY_ARTIFACT_CAPABILITIES = settingsCapabilities(
  {
    area: 'me', tag: 'Account', tenancy: 'tenant',
    module: 'src/routes/me/projects-artifacts.ts', load: () => import('../../routes/me/projects-artifacts'),
    rule: routeRule(isAuthenticatedUserInFrameTenant),
  },
  [
    {
      id: 'me.list_project_artifacts', method: 'GET', path: '/api/me/projects/artifacts', handler: 'handleGetMyProjectsArtifacts',
      summary: "Artifacts across the request tenant's projects, newest first (offset-paged)", effect: 'read',
      description: 'artifact_service scopes the rows to the request tenant. `next_offset` is set when the page is full.',
      input: z.object({
        limit: z.number().int().min(1).max(200).optional().describe('Page size, 1-200, default 50.'),
        offset: z.number().int().min(0).optional().describe('Rows to skip, default 0.'),
        kind: z.string().optional().describe(`One of ${ARTIFACT_KINDS.join(', ')}; forwarded to artifact_service, which refuses any other (422, relayed).`),
      }),
      output: z.object({ items: z.array(artifact), next_offset: z.number().int().nullable() }),
      responses: standardResponses(
        "422: `error` 'Validation error' (`limit` not 1-200, `offset` negative; `details`). 409: `error.code` 'MISSING_TENANT' " +
          "(no request tenant: nothing is sent to artifact_service). Any other status is artifact_service's, relayed " +
          "(`error.code` 'UPSTREAM_…'; its 4xx pass through, its 401 / 5xx or no answer is 502, a timeout 504). ",
      ),
    },
  ],
);

// ── P4c part 2: the caller's own role bits ───────────────────────────────────

export const MY_SUPER_ADMIN_CAPABILITIES = settingsCapabilities(
  {
    area: 'me', tag: 'Account', tenancy: 'self',
    module: 'src/routes/admin/super-admin.ts', load: () => import('../../routes/admin/super-admin'),
    rule: routeRule(isAuthenticatedUser),
  },
  [
    {
      id: 'me.get_super_admin_status', method: 'GET', path: '/api/me/super-admin', handler: 'handleGetSuperAdminStatus', effect: 'read',
      summary: 'Whether the caller holds the super_admin realm role (the frontend gates the super-admin nav on it)',
      input: z.object({}),
      output: z.object({ is_super_admin: z.boolean() }),
      responses: caughtAuthResponses({ status: 'own' }, ''),
    },
  ],
);

export const MY_DEPT_ROLE_CAPABILITIES = settingsCapabilities(
  {
    area: 'me', tag: 'Account', tenancy: 'self',
    module: 'src/routes/me/dept-roles.ts', load: () => import('../../routes/me/dept-roles'),
    rule: routeRule(isAuthenticatedUser),
  },
  [
    {
      id: 'me.list_dept_roles', method: 'GET', path: '/api/me/dept-roles', handler: 'handleListMyDeptRoles', effect: 'read',
      summary: "The caller's department roles, keyed by department id (every workspace)",
      description: "`{}` when the caller belongs to no department. Not scoped to the request tenant: filter by the department's workspace client-side.",
      input: z.object({}),
      output: z.object({ data: z.record(z.enum(['dept-admin', 'dept-manager', 'dept-member', 'dept-viewer'])) }),
      responses: standardResponses(),
    },
  ],
);
