// fr-agui SPEC §13 P4d-2c — spec drain, the library group: the three GOVERNED asset kinds of the
// tenant library — requirements, principles, decisions (requirements_management) — the
// `/api/assets/{requirements,principles,decisions}` routes
// (routes/assets/{requirements,principles,decisions}.ts),
// re-expressed with NO behaviour change (`legacyHandler`). None had an operation in the served spec
// (LEGACY_UNDECLARED): every one is a NEW operation, operationId = camelCase(id).
//
// Ids: `library.*` — the AG-UI agent tools already own `requirements.list`, `principles.get`,
// … (agui/actions/*.ts); those are unchanged. None of these is agent-exposed
// (`out-of-agent-scope`); the project agent edits a project's copies through `project_assets.edit`.
// None is on the licence route allowlist (the licence door refuses a licence bearer 403 first).
//
// Gates (the handlers', declared as the closest rule — `validateAuth`, its licence / conveyor
// doors; the upstream clients are `requireTenant`, so a blank frame tenant is 409 MISSING_TENANT
// with nothing sent):
//   * READS and CREATES stay member-level (routes/assets/requirements.ts RBAC note). A create that
//     names `origin_project_id` must name a project of the caller's tenant (403
//     `origin_project_not_member`).
//   * PUT and DELETE of all three kinds take THE ONE write gate
//     (routes/assets/_lib/governed-asset-write-gate.ts, George 2026-10-16): a workspace-admin of the
//     active tenant, a super-admin, or a member on an asset CREATED in a project they belong to;
//     else 403 `{ error: 'workspace-admin role required', code: 'project_copy_member_only' }`. A PUT
//     keeps the stored provenance (`withPreservedOrigin`; a member changing it is 403
//     `origin_change_forbidden`). A SYSTEM-only row is a super-admin's (403 `system_asset_read_only`).
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import { LIBRARY_ASSET_MODELS as M } from '../admin/assets';
import type { Capability, ResponseSpec } from '../define';
import { isAuthenticatedUser } from '../rbac-rules';
import { pathId, routeRule, settingsCapabilities, standardResponses, type SettingsRoute } from '../account/_shared';

const RM = 'requirements_management';

const relayed = (service: string) =>
  `409: \`error.code\` 'MISSING_TENANT' (a blank request tenant: nothing is sent to ${service}). Any other status is ` +
  `${service}'s, relayed in the integration envelope (\`error.code\` 'UPSTREAM_…'; e.g. 404 'UPSTREAM_NOT_FOUND' for an ` +
  'unknown id, 422 for a body it refuses). ';

const NON_JSON = "400: `error.code` 'BAD_REQUEST' ('Invalid JSON request body'): the body is not JSON (nothing sent). ";
const ORIGIN_403 =
  "403: `code` 'origin_project_not_member' — `origin_project_id` names a project outside the caller's tenant. ";
const WRITE_GATE_403 =
  "403: `{ error: 'workspace-admin role required', code: 'project_copy_member_only' }` — neither a workspace-admin, a " +
  'super-admin, nor a member of the project the asset was created in (the shared governed-asset write gate); ' +
  "`code` 'origin_change_forbidden' (a member changing the asset's provenance); `code` 'system_asset_read_only' (a " +
  'SYSTEM-only row, by anyone but a super-admin). ';
const LIST_400 =
  "400: `error` 'project_id must be a UUID' (`project_id` present but empty / not a uuid), an unknown `origin`, or a bound-mode " +
  '(`bound_to` without `visible_in`) request with an `offset` or a malformed `bound_to`. ';

const listFilters = {
  project_id: z
    .string()
    .uuid()
    .optional()
    .describe("fr's effective-scope filter: the assets that apply to this project (an unknown project: an empty list, header X-Project-Resolved)."),
  bound_to: z.string().uuid().optional().describe('fr-local: only assets bound to this project (asset_bindings).'),
  visible_in: z.string().uuid().optional().describe('fr-local: assets bound to this project plus the unbound (tenant-wide) ones.'),
  limit: z.coerce.number().int().optional().describe('Page size (fr resolves it; a junk value degrades to the default, never refused).'),
};
const rmListFilters = {
  ...listFilters,
  rm_project_id: z
    .string()
    .uuid()
    .optional()
    .describe("requirements_management's own project_id filter (what the project PRODUCED), without fr's effective filter."),
  origin: z.enum(['tenant', 'project', 'workflow']).optional().describe("The row's provenance (sent upstream as `origin_kind`)."),
  offset: z.coerce.number().int().min(0).optional(),
};
const searchQuery = z.object({
  q: z.string().optional().describe('Search text.'),
  k: z.coerce.number().int().optional().describe('How many hits.'),
});

const dataOf = (row: z.ZodTypeAny) => z.object({ data: row });
const listOf = (row: z.ZodTypeAny) =>
  z.object({ data: z.array(row) }).describe('Headers: X-Project-Resolved (a `project_id` filter), the page-cap headers (X-Truncated, …).');

interface Kind {
  plural: 'requirements' | 'principles' | 'decisions';
  singular: string;
  Plural: string;
  Singular: string;
  key: string;
  service: string;
  out: z.ZodTypeAny;
  create: z.ZodTypeAny;
  update: z.ZodTypeAny;
  list: z.ZodTypeAny;
  search: z.ZodTypeAny;
  module: string;
  load: () => Promise<Record<string, unknown>>;
  /** Spelled out, so each id is greppable (define.test.ts). */
  ids: { list: Id; search: Id; create: Id; versions?: Id; get: Id; update: Id; delete: Id };
}

type Id = { id: `library.${string}` };

const rule = routeRule(isAuthenticatedUser);
const responses = (extra: string, service: string): ResponseSpec[] => standardResponses(extra + relayed(service));

function kindRoutes(k: Kind): SettingsRoute[] {
  const base = `/api/assets/${k.plural}`;
  const one = `${base}/:${k.key}`;
  const keyIn = { [k.key]: pathId(`${k.Singular} id`) };
  return [
    {
      id: k.ids.list.id, method: 'GET', path: base, handler: `handleList${k.Plural}`, effect: 'read',
      summary: `List the request tenant's ${k.plural} (the tenant library; member-level)`,
      description:
        'The SYSTEM tenant\'s rows are unioned in for every tenant (a customer never sees a system row it may not; ' +
        "routes/assets/_lib/system-union.ts). fr's binding / effective-scope filters run after the upstream read.",
      input: k.list,
      output: listOf(k.out),
      responses: responses(LIST_400, k.service),
    },
    {
      id: k.ids.search.id, method: 'GET', path: `${base}/search`, handler: `handleSearch${k.Plural}`, effect: 'read',
      summary: `Search the request tenant's ${k.plural}`,
      input: k.search,
      output: dataOf(z.unknown().describe(`${k.service}'s search answer, verbatim.`)),
      responses: responses('', k.service),
    },
    {
      id: k.ids.create.id, method: 'POST', path: base, handler: `handleCreate${k.Singular}`, effect: 'write',
      successStatus: 201,
      summary: `Create a ${k.singular} in the request tenant (member-level)`,
      description:
        `The body is forwarded to ${k.service} (fr checks only \`origin_project_id\`` +
        ').',
      input: k.create,
      output: dataOf(k.out),
      responses: responses(NON_JSON + ORIGIN_403, k.service),
    },
    ...(k.ids.versions === undefined
      ? []
      : [
          {
            id: k.ids.versions!.id, method: 'GET' as const, path: `${one}/versions`,
            handler: `handleList${k.Singular}Versions`, effect: 'read' as const,
            summary: `A ${k.singular}'s version history`,
            input: z.object(keyIn),
            output: dataOf(z.array(k.out)),
            responses: responses('', k.service),
          },
        ]),
    {
      id: k.ids.get.id, method: 'GET', path: one, handler: `handleGet${k.Singular}`, effect: 'read',
      summary: `One ${k.singular} of the request tenant (or the SYSTEM tenant's, through the system union)`,
      input: z.object(keyIn),
      output: dataOf(k.out),
      responses: responses('', k.service),
    },
    {
      id: k.ids.update.id, method: 'PUT', path: one, handler: `handleUpdate${k.Singular}`, effect: 'write',
      summary: `Edit a ${k.singular} in place (the governed-asset write gate)`,
      description:
        'A whole-body PUT forwarded upstream. An omitted provenance (`origin_kind` / `origin_project_id` / ' +
        '`origin_workflow_run_id`) is the STORED one, carried forward.' +
        ' The gate runs BEFORE the body is read.',
      input: z.object(keyIn).merge(k.update as z.AnyZodObject),
      output: dataOf(k.out),
      responses: responses(
        NON_JSON + WRITE_GATE_403 + ORIGIN_403,
        k.service,
      ),
    },
    {
      id: k.ids.delete.id, method: 'DELETE', path: one, handler: `handleDelete${k.Singular}`, effect: 'destructive',
      successStatus: 204,
      summary: `Delete a ${k.singular} (the governed-asset write gate)`,
      input: z.object(keyIn),
      output: z.null(),
      responses: responses(
        WRITE_GATE_403,
        k.service,
      ),
    },
  ];
}

const KINDS: Kind[] = [
  {
    plural: 'requirements', singular: 'requirement', Plural: 'Requirements', Singular: 'Requirement', key: 'rid', service: RM,
    out: M.requirementOut, create: M.requirementIn, update: M.requirementIn,
    list: z.object(rmListFilters), search: searchQuery,
    module: 'src/routes/assets/requirements.ts', load: () => import('../../routes/assets/requirements'),
    ids: {
      list: { id: 'library.list_requirements' },
      search: { id: 'library.search_requirements' },
      create: { id: 'library.create_requirement' },
      get: { id: 'library.get_requirement' },
      update: { id: 'library.update_requirement' },
      delete: { id: 'library.delete_requirement' },
    },
  },
  {
    plural: 'principles', singular: 'principle', Plural: 'Principles', Singular: 'Principle', key: 'pid', service: RM,
    out: M.principleOut, create: M.principleIn, update: M.principleIn,
    list: z.object({ ...rmListFilters, active_only: z.enum(['true', 'false']).optional() }), search: searchQuery,
    module: 'src/routes/assets/principles.ts', load: () => import('../../routes/assets/principles'),
    ids: {
      list: { id: 'library.list_principles' },
      search: { id: 'library.search_principles' },
      create: { id: 'library.create_principle' },
      versions: { id: 'library.list_principle_versions' },
      get: { id: 'library.get_principle' },
      update: { id: 'library.update_principle' },
      delete: { id: 'library.delete_principle' },
    },
  },
  {
    plural: 'decisions', singular: 'decision', Plural: 'Decisions', Singular: 'Decision', key: 'did', service: RM,
    out: M.decisionOut, create: M.decisionIn, update: M.decisionIn,
    list: z.object({ ...rmListFilters, card_id: z.string().optional(), status: z.string().optional() }), search: searchQuery,
    module: 'src/routes/assets/decisions.ts', load: () => import('../../routes/assets/decisions'),
    ids: {
      list: { id: 'library.list_decisions' },
      search: { id: 'library.search_decisions' },
      create: { id: 'library.create_decision' },
      versions: { id: 'library.list_decision_versions' },
      get: { id: 'library.get_decision' },
      update: { id: 'library.update_decision' },
      delete: { id: 'library.delete_decision' },
    },
  },
];

export const GOVERNED_ASSET_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = KINDS.flatMap((k) =>
  settingsCapabilities({ area: 'library', tag: 'Library', tenancy: 'tenant', rule, module: k.module, load: k.load }, kindRoutes(k)),
);
