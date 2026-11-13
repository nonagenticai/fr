// fr-agui SPEC §13 P4d-2c — spec drain, the library group: the cross-kind asset surfaces of the
// tenant library, re-expressed with NO behaviour change (`legacyHandler`). None had an operation in
// the served spec (LEGACY_UNDECLARED): every one is a NEW operation, operationId = camelCase(id),
// `out-of-agent-scope` (the project agent binds / overrides / blocks through its own agent-native
// capabilities, P2-c1 — unchanged), and none is on the licence route allowlist.
//
//   * the Library page's list surfaces (routes/assets/{channels,triggers,workflows,kag-documents}.ts):
//     `{ id, title }` rows of each kind, through fr's effective-scope + binding filters;
//   * an asset's quality history (routes/assets/quality-history.ts);
//   * asset bindings (routes/assets/bindings.ts): bind an asset to projects of the caller's tenant,
//     list / remove those bindings. ⛔ Binding is NOT ownership (George 2026-10-16): any member may
//     bind, and the governed-asset write gate ignores it;
//   * the project-scope override / block edges (routes/asset-scope/{override,block}.ts);
//   * the KAG document registry reads (routes/assets/kag.ts — the two routes P4a1 reserved for P2).
//
// Gates (the handlers', declared as the closest rule): validateAuth (its licence / conveyor doors),
// then the resolved tenant (`ctxTenantId`: the frame tenant, else the JWT one):
//   * lists, history, bindings, the KAG list: member-level (the KAG document DELETE:
//     workspace-admin, `requireWorkspaceAdmin`, like the other destructive KAG verbs); every row read is the caller's tenant's
//     (bindings: only projects of that tenant; an unknown / foreign project is the same 400 / no-op);
//   * the workflow list: platform callers only (`canReadProductionWorkflows`) — a customer tenant
//     gets an EMPTY 200;
//   * override / block: a workspace-admin, or (project scope) a member who may mutate that project
//     (`canMutateProject`), or (department scope) that department's manager; a member may record as
//     a project's override only a copy CREATED in that project (403 `project_copy_member_only`).
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import { assetType } from '../../db/schema';
import { ASSET_TYPES } from '../../routes/assets/assignments-schemas';
import type { Capability } from '../define';
import { isAuthenticatedUser, isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { pathId, routeRule, settingsCapabilities, standardResponses, workspaceAdminRule } from '../account/_shared';

const rule = routeRule(isAuthenticatedUserInResolvedTenant);

const titled = z.object({ id: z.string(), title: z.string() }).passthrough();
const scopeQuery = {
  project_id: z
    .string()
    .optional()
    .describe("fr's effective-scope filter (a uuid; anything else is 400). An unknown project: an empty list, header X-Project-Resolved."),
  bound_to: z.string().uuid().optional().describe('Only rows bound to this project (asset_bindings).'),
  visible_in: z.string().uuid().optional().describe('Rows bound to this project plus the unbound (tenant-wide) ones.'),
};
const LIST_400 = "400: `error` 'project_id must be a UUID'. ";
const listOutput = z.object({ data: z.array(titled) }).describe('Header X-Project-Resolved when a `project_id` filter is sent.');

const mod = (m: string, load: () => Promise<Record<string, unknown>>) => ({ module: `src/routes/${m}.ts`, load });

const assetKindPath = z.enum(assetType.enumValues).describe('The asset kind (else 400).');
const assetIdPath = pathId('The asset id');

export const ASSET_SURFACE_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  // ── the Library page's list surfaces ─────────────────────────────────────────
  ...settingsCapabilities({ area: 'library', tag: 'Library', tenancy: 'tenant', rule, ...mod('assets/channels', () => import('../../routes/assets/channels')) }, [
    {
      id: 'library.list_channels', method: 'GET', path: '/api/assets/channels', handler: 'handleListChannelsAsset', effect: 'read',
      summary: "The request tenant's channels as library rows (`{ id, title, dept_id }`)",
      input: z.object({ ...scopeQuery, origin: z.enum(['tenant', 'workflow']).optional().describe('Channels are never project-scoped.') }),
      output: z.object({ data: z.array(titled.extend({ dept_id: z.string().nullable() })) }),
      responses: standardResponses(LIST_400 + "400: an unknown `origin`. ", { noTenant500: true }),
    },
  ]),
  ...settingsCapabilities({ area: 'library', tag: 'Library', tenancy: 'tenant', rule, ...mod('assets/triggers', () => import('../../routes/assets/triggers')) }, [
    {
      id: 'library.list_triggers', method: 'GET', path: '/api/assets/triggers', handler: 'handleListTriggers', effect: 'read',
      summary: "The scheduled triggers the caller can see, as library rows (`{ id, title, project_id, dept_id }`)",
      input: z.object(scopeQuery),
      output: z.object({ data: z.array(titled.extend({ project_id: z.string(), dept_id: z.string().nullable() })) }),
      responses: standardResponses(LIST_400, { noTenant500: true }),
    },
  ]),
  ...settingsCapabilities({ area: 'library', tag: 'Library', tenancy: 'tenant', rule, ...mod('assets/workflows', () => import('../../routes/assets/workflows')) }, [
    {
      id: 'library.list_workflows', method: 'GET', path: '/api/assets/workflows', handler: 'handleListWorkflows', effect: 'read',
      summary: 'The production n8n workflows as library rows (`{ id, title }`; platform callers only — anyone else an empty list)',
      input: z.object(scopeQuery),
      output: listOutput,
      responses: standardResponses(LIST_400 + "The n8n catalogue failing: the integration envelope (`error.code`). ", { noTenant500: true }),
    },
  ]),
  ...settingsCapabilities({ area: 'library', tag: 'Library', tenancy: 'tenant', rule, ...mod('assets/kag-documents', () => import('../../routes/assets/kag-documents')) }, [
    {
      id: 'library.list_kag_documents', method: 'GET', path: '/api/assets/kag-documents', handler: 'handleListKagDocumentsAsset', effect: 'read',
      summary: "The request tenant's KAG documents as library rows (`{ id, title }`; not paged)",
      description: 'A `limit` is ignored (the registry read is not paged upstream); no `total` and no cursor are emitted.',
      input: z.object({ ...scopeQuery, label: z.string().optional() }).passthrough(),
      output: listOutput,
      responses: standardResponses(LIST_400 + "The KAG gateway failing: the integration envelope (`error.code`). ", { noTenant500: true }),
    },
  ]),
  // ── per-asset reads: quality history ──────────────────────────────────────────
  ...settingsCapabilities({ area: 'library', tag: 'Library', tenancy: 'tenant', rule: routeRule(isAuthenticatedUser), ...mod('assets/quality-history', () => import('../../routes/assets/quality-history')) }, [
    {
      id: 'library.get_asset_quality_history', method: 'GET', path: '/api/assets/:kind/:id/quality/history', handler: 'handleGetAssetQualityHistory', effect: 'read',
      summary: "An asset's recorded quality evaluations (requirements_management), as a read-model block",
      description: 'A requirements_management failure degrades the block (`meta`), not the answer.',
      input: z.object({
        kind: z.enum(['principle', 'decision', 'architectureElement', 'architectureView']).describe('Else 400 BAD_REQUEST.'),
        id: assetIdPath,
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
      output: z.object({ data: z.unknown(), meta: z.unknown() }),
      responses: standardResponses("400: `error.code` 'BAD_REQUEST' (an unknown kind, a malformed id escape, a `limit` outside 1-500). "),
    },
  ]),
  // ── asset bindings ───────────────────────────────────────────────────────────
  ...settingsCapabilities({ area: 'asset_bindings', tag: 'Asset Bindings', tenancy: 'tenant', rule, ...mod('assets/bindings', () => import('../../routes/assets/bindings')) }, [
    {
      id: 'asset_bindings.bind', method: 'POST', path: '/api/assets/:kind/:id/bindings', handler: 'handleBindAsset', effect: 'write',
      summary: "Bind an asset to projects of the request tenant (idempotent; member-level — binding is NOT ownership)",
      input: z.object({
        kind: assetKindPath,
        id: assetIdPath,
        project_ids: z.array(z.string().uuid()).min(1).describe('Projects of the request tenant (a foreign or unknown one: 400, existence never leaks).'),
      }),
      output: z.object({ added: z.array(z.string()), already_bound: z.array(z.string()) }),
      responses: standardResponses(
        "400: `error.code` 'BAD_REQUEST' — an unknown kind, 'project_ids: non-empty array required' (also a non-JSON body), an invalid " +
          "uuid, or 'unknown project_id(s): …'. 404: `error.code` 'NOT_FOUND' — 'asset <kind>:<id> not found in tenant' (an fr-local " +
          "trigger / channel, or an upstream requirement / principle / decision the caller tenant cannot read — unknown or " +
          "another tenant's alike; kag_document / workflow / artifact are not verified here). 409: `code` 'project_archived' (a target " +
          "project is archived) or 'asset_archived' (an archived channel, an inactive principle); nothing is written. An " +
          'upstream read failing otherwise is its relayed error (nothing is written). ',
        { noTenant500: true },
      ),
    },
    {
      id: 'asset_bindings.list', method: 'GET', path: '/api/assets/:kind/:id/bindings', handler: 'handleListAssetBindings', effect: 'read',
      summary: "The projects of the request tenant an asset is bound to",
      input: z.object({ kind: assetKindPath, id: assetIdPath }),
      output: z.object({ data: z.array(z.object({ project_id: z.string(), bound_at: z.string(), bound_by_user_id: z.string().nullable() }).passthrough()) }),
      responses: standardResponses("400: `error.code` 'BAD_REQUEST' (an unknown kind). ", { noTenant500: true }),
    },
    {
      id: 'asset_bindings.unbind', method: 'DELETE', path: '/api/assets/:kind/:id/bindings/:project_id', handler: 'handleUnbindAsset', effect: 'destructive',
      successStatus: 204,
      summary: 'Remove an asset binding from a project of the request tenant (idempotent: a missing or foreign one is the same 204)',
      input: z.object({ kind: assetKindPath, id: assetIdPath, project_id: z.string().uuid().describe('Else 400.') }),
      output: z.null(),
      responses: standardResponses("400: `error.code` 'BAD_REQUEST' (an unknown kind, 'invalid project_id'). ", { noTenant500: true }),
    },
  ]),
  // ── project / department scope edges ─────────────────────────────────────────
  ...settingsCapabilities({ area: 'asset_scope', tag: 'Asset Scope', tenancy: 'tenant', rule, ...mod('asset-scope/override', () => import('../../routes/asset-scope/override')) }, [
    {
      id: 'asset_scope.override', method: 'POST', path: '/api/asset-scope/:assetType/:assetId/override', handler: 'handleOverride', effect: 'write',
      summary: "Record, at a project or department, which asset replaces one owned at a higher scope (an OQ-16 override edge)",
      description:
        'Exactly one of `project_id` / `dept_id`. The override row says which asset a project USES, never who may write it.',
      input: z.object({
        assetType: z.enum(ASSET_TYPES).describe('The asset kind (else 400).'),
        assetId: pathId('The asset being overridden'),
        candidate_asset_id: z.string().min(1).describe('The replacing asset (must differ from `assetId`).'),
        project_id: z.string().optional(),
        dept_id: z.string().optional(),
      }),
      output: z.object({ ok: z.literal(true) }),
      responses: standardResponses(
        "400: `error` 'invalid JSON body', 'body must be an object', 'candidate_asset_id is required', 'exactly one of project_id or " +
          "dept_id must be provided', 'candidate_asset_id must differ from the asset it overrides', 'unknown asset_type: …', or 'no " +
          "higher-scope owns row exists for this asset; nothing to override'. 403: `error` 'dept-manager role required', " +
          "'project-member role required', or `code` 'project_copy_member_only' (a member naming a candidate not created in that " +
          "project). 404: `error` 'department not found'. ",
        { noTenant500: true },
      ),
    },
  ]),
  ...settingsCapabilities({ area: 'asset_scope', tag: 'Asset Scope', tenancy: 'tenant', rule, ...mod('asset-scope/promotion-request', () => import('../../routes/asset-scope/promotion-request')) }, [
    {
      id: 'asset_scope.get_promotion', method: 'GET', path: '/api/asset-scope/:assetType/:assetId/promotion-request', handler: 'handleGetAssetPromotion', effect: 'read',
      summary: "The latest promotion request for a project copy in the request tenant (pending, approved or rejected), or null",
      input: z.object({
        assetType: z.enum(['requirement', 'principle', 'decision']).describe('The asset kind (else 404).'),
        assetId: pathId('The project copy'),
      }),
      output: z.object({
        data: z.object({ approval_id: z.string(), status: z.string(), promotion: z.unknown() }).nullable(),
      }),
      responses: standardResponses('404: an unknown kind. ', { noTenant500: true }),
    },
    {
      id: 'asset_scope.request_promotion', method: 'POST', path: '/api/asset-scope/:assetType/:assetId/promotion-request', handler: 'handleRequestAssetPromotion', effect: 'write',
      successStatus: 201,
      summary: "Ask the workspace's tenant admins to promote a project copy of a requirement, principle or decision to the whole workspace (G8 / R313)",
      description:
        'Raises one `asset.promotion` approval per copy (a repeat returns the pending one with 200). Only a tenant admin decides it; ' +
        'every workspace member is told. On approve the workspace original takes the copy\'s content as a new version; on reject the copy stays in its project. ' +
        'Not the same as `/promote`, which widens an ownership edge without approval.',
      input: z.object({
        assetType: z.enum(['requirement', 'principle', 'decision']).describe('The asset kind (else 404).'),
        assetId: pathId('The project copy'),
        original_id: z.string().min(1).max(255).optional().describe('The workspace original, when known (else read from the project override).'),
        note: z.string().max(2000).optional(),
      }),
      output: z.object({
        data: z.object({
          approval_id: z.string(),
          status: z.string(),
          deduplicated: z.boolean(),
          metadata: z.record(z.unknown()),
        }),
      }),
      responses: standardResponses(
        "400: 'invalid JSON body' / 'invalid body: …'. 403: `code` 'promotion_requires_project_member'. 404: an unknown kind or copy. " +
          "409: `code` 'not_a_project_copy', 'asset_superseded', 'promotion_original_unknown' or 'promotion_no_approver'. ",
        { noTenant500: true },
      ),
    },
  ]),
  ...settingsCapabilities({ area: 'asset_scope', tag: 'Asset Scope', tenancy: 'tenant', rule, ...mod('asset-scope/block', () => import('../../routes/asset-scope/block')) }, [
    {
      id: 'asset_scope.block', method: 'POST', path: '/api/asset-scope/:assetType/:assetId/block', handler: 'handleBlock', effect: 'write',
      summary: 'Block an asset at a project or department (a block edge: it no longer applies there)',
      description: 'Exactly one of `project_id` / `dept_id`.',
      input: z.object({
        assetType: z.enum(ASSET_TYPES).describe('The asset kind (else 400).'),
        assetId: pathId('The asset to block'),
        project_id: z.string().optional(),
        dept_id: z.string().optional(),
      }),
      output: z.object({ ok: z.literal(true) }),
      responses: standardResponses(
        "400: `error` 'invalid JSON body', 'body must be an object', 'exactly one of project_id or dept_id must be provided', or " +
          "'unknown asset_type: …'. 403: `error` 'dept-manager role required' or 'project-member role required'. 404: `error` " +
          "'department not found'. ",
        { noTenant500: true },
      ),
    },
  ]),
  // ── the KAG document registry (P4a1 reserved these two for P2) ───────────────
  ...settingsCapabilities({ area: 'kag', tag: 'KAG', tenancy: 'tenant', rule, ...mod('assets/kag', () => import('../../routes/assets/kag')) }, [
    {
      id: 'kag.list_documents', method: 'GET', path: '/api/assets/kag/documents', handler: 'handleKagListDocuments', effect: 'read',
      summary: "The request tenant's KAG documents (`{ items, total }`; through fr's effective-scope filter)",
      description:
        '`total` is passed through verbatim (null today); `next_cursor` is NOT forwarded (graph-adapter ignores the page, so a ' +
        'cursor would loop).',
      input: z.object({ project_id: scopeQuery.project_id }).passthrough(),
      output: z.object({ data: z.object({ items: z.array(z.unknown()), total: z.number().int().nullable().optional() }).passthrough() }),
      responses: standardResponses(LIST_400 + "The KAG gateway failing: the integration envelope (`error.code`). ", { noTenant500: true }),
    },
    {
      id: 'kag.delete_document', method: 'DELETE', path: '/api/assets/kag/documents/:nodeId', handler: 'handleDeleteKagDocument', effect: 'destructive',
      summary: 'Delete a KAG document (graph node) through the KAG gateway (workspace-admin)',
      // The handler's `requireWorkspaceAdmin` (routes/assets/kag.ts) — the same bar as the
      // other destructive KAG verbs (capabilities/kag/assets.ts `admin: true`).
      rule: workspaceAdminRule(),
      input: z.object({ nodeId: pathId('The document node id') }),
      output: z.object({ data: z.object({ id: z.string(), deleted: z.literal(true) }) }),
      responses: [
        {
          status: 401,
          description:
            "Unauthorized, `{ error }` with no `code`. `error` is one of: 'Missing or invalid Authorization header' " +
            "(no `Bearer` header); 'Invalid or expired token' or 'unauthorized' (the bearer failed verification); " +
            "'workspace-admin role required' (authenticated, but not a workspace-admin of the request tenant).",
          schema: z.object({ error: z.string() }),
        },
        ...standardResponses("The KAG gateway refusing or failing: the integration envelope (`error.code`). ").filter((r) => r.status !== 401),
      ],
    },
  ]),
];
