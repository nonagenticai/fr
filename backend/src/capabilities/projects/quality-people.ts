// fr-agui SPEC §13 P2 (P2-c1) — the project's QUALITY and PEOPLE reads, declared.
//
//   projects.get_quality              GET /api/projects/:id/quality           (the Quality tab)
//   projects.get_quality_history      GET /api/projects/:id/quality/history   (one repo's runs)
//   projects.get_knowledge_allocation GET /api/projects/:id/knowledge-allocation
//
// Spec drain: these three routes were openapi.ts literal operations; they are now
// capability-derived with the SAME operationIds and the same handlers
// (`legacyHandler`), each literal operation carried VERBATIM in `openapi.frozen`
// (the knowledge-allocation read's authz sentences and 403 updated for the ruling). tenancy 'project', agent-exposed to the project
// agent: the project comes from the thread (`/api/projects/:id`, SPEC §5.7 rule 3
// — stripped from the model's schema and injected). The agent action runs the
// route itself as the human (agui/actions/project-scope-people-quality.ts), so it
// answers exactly what the page answers.
//
// The WRITES of this unit (`projects.analyze_quality`, `projects.set_knowledge_allocation`,
// `project_assets.bind` / `unbind` / `override` / `block`) are agent actions over the
// EXISTING routes, confirmed on a `capability-invoke` card; their routes keep their
// own declarations (the openapi literal, or LEGACY_UNDECLARED).
//
// Knowledge allocation, George 2026-10-16 ruling (b): readable and writable by ANY
// member of the project's tenant (tenant-wide collaboration); `execution_signoff`
// rows stay unreachable (routes/project-knowledge-allocation.ts).
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import { defineCapability, type Capability } from '../define';
import { lazyActionHandler, lazyHandler } from '../lazy';

const projectId = z.string().uuid().describe('The project id');

const allocationEntry = z
  .object({
    id: z.string(),
    email: z.string().nullable(),
    name: z.string().nullable(),
    resolved: z.boolean(),
    knowledge_areas: z.array(z.string()).describe("The member's STANDING, tenant-wide areas."),
    project_knowledge_areas: z.array(z.string()).describe('What the member is allocated ON THIS PROJECT.'),
  })
  .passthrough();

interface ProjectRead {
  id: `${string}.${string}`;
  path: string;
  operationId: string;
  module: string;
  load: () => Promise<Record<string, unknown>>;
  handler: string;
  readExport: string;
  summary: string;
  description: string;
  query: z.ZodRawShape;
  output: z.ZodTypeAny;
  /** The literal operation, VERBATIM (spec drain): the served document keeps it byte-identical. */
  frozen: Record<string, unknown>;
  tier: 'core' | 'searchable';
}

const qualityModule = { module: 'src/routes/project-quality.ts', load: () => import('../../routes/project-quality') };

const READS: ProjectRead[] = [
  {
    id: 'projects.get_quality',
    path: '/api/projects/:id/quality',
    operationId: 'getProjectQuality',
    ...qualityModule,
    handler: 'handleGetProjectQuality',
    readExport: 'getQualityRead',
    summary: "This project's stored code-quality result and CI per repository (the Quality tab)",
    description:
      'Reads STORED coding-analysis results only — never re-lints. `latest.status` is complete | partial | inconclusive | ' +
      'failed | not_analyzed; a score is present only for complete/partial and a letter grade only for complete. `ci.state` is ' +
      'success | failure | pending | none | unknown for `latest.commit_sha` (zero workflow runs is `none`, never success). ' +
      '`analysis` is the in-flight Analyze state, or null. Report what is stored; never invent a grade.',
    query: {},
    output: z.object({
      data: z
        .object({
          project_id: z.string().uuid().describe('The bound project — every answer carries it'),
          repositories: z.array(z.record(z.unknown())),
          analyze_repo_cap: z.number(),
          analysis: z.unknown(),
        })
        .passthrough(),
    }),
    frozen: {
      summary: 'Stored quality result + CI (for that same commit) per project repository',
      description:
        'Reads STORED coding-analysis results only — never re-lints. `latest.status` is complete | partial | inconclusive | failed | not_analyzed; a score is present only for complete/partial and a letter grade only for complete. `ci.state` is success | failure | pending | none | unknown for `latest.commit_sha`; a null sha is `unknown` and zero workflow runs is `none`, never success. `latest` is null (with `latest_error`) when the stored-result read itself failed. `analysis` is the in-flight Analyze state, or null.',
      tags: ['Projects'],
      operationId: 'getProjectQuality',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': { description: '{ data: { project_id, repositories[], analyze_repo_cap, analysis } }' },
        '403': { description: "validateAuth's route doors (`code` 'licence_route_not_allowed', 'conveyor_route_forbidden')" },
        '404': { description: 'Project not found in the active tenant' },
      },
    },
    tier: 'core',
  },
  {
    id: 'projects.get_quality_history',
    path: '/api/projects/:id/quality/history',
    operationId: 'getProjectQualityHistory',
    ...qualityModule,
    handler: 'handleGetProjectQualityHistory',
    readExport: 'getQualityHistoryRead',
    summary: 'The stored quality-run history of one of this project\'s repositories (newest first)',
    description: 'One repository attached to this project (`repo_id`, from projects.get_quality or projects.list_repositories).',
    query: { repo_id: z.string().uuid().describe("Required (else 400): a repository attached to this project.") },
    output: z.object({
      data: z.object({ repo_id: z.string(), container_name: z.string().nullable(), status: z.unknown(), results: z.array(z.unknown()) }).passthrough(),
    }),
    frozen: {
      summary: 'Stored quality-run history for one project repository (newest first)',
      tags: ['Projects'],
      operationId: 'getProjectQualityHistory',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'repo_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': { description: '{ data: { repo_id, container_name, status, results[] } }' },
        '400': { description: '`repo_id` missing' },
        '403': { description: "validateAuth's route doors (`code` 'licence_route_not_allowed', 'conveyor_route_forbidden')" },
        '404': { description: 'Project not found, or repo not attached to it' },
      },
    },
    tier: 'searchable',
  },
  {
    id: 'projects.get_knowledge_allocation',
    path: '/api/projects/:id/knowledge-allocation',
    operationId: 'getProjectKnowledgeAllocation',
    module: 'src/routes/project-knowledge-allocation.ts',
    load: () => import('../../routes/project-knowledge-allocation'),
    handler: 'handleGetProjectKnowledgeAllocation',
    readExport: 'getKnowledgeAllocationRead',
    summary: "Who is allocated to which knowledge areas on this project (the whole tenant roster as candidates)",
    description:
      "Every member of the project's tenant, with their STANDING areas and their allocation ON THIS PROJECT " +
      "(`project_knowledge_areas`; empty = not allocated yet). `items` is the whole roster, not only allocated members. " +
      "The execution sign-off roster (`execution_signoff`) is never part of this answer. Any member of the project's " +
      'tenant may read it (George 2026-10-16, tenant-wide collaboration).',
    query: {},
    output: z.object({ items: z.array(allocationEntry) }),
    // The literal operation, with ONLY its authz sentences and the 403 updated for the
    // George 2026-10-16 widening (an accurate document, same operationId and shape).
    // (All three: the 403 the route doors answer is now declared — the P4d-1
    // real-pipeline licence sweep requires it of every routed capability.)
    frozen: {
      summary: 'List candidates and their knowledge allocation on a project',
      description:
        'The tenant roster folded together with each member’s STANDING areas and their ' +
        'allocation ON THIS PROJECT. The rows live in `project_stakeholders` (migration 074), ' +
        'whose primary key already includes `role`.\n\n' +
        '⛔ Rows with role `execution_signoff` are UNREACHABLE from here, by construction: both ' +
        'the read and the write are scoped to the tenant\'s area vocabulary (its RM capability ' +
        'names, minus reserved stakeholder roles). That roster is what `required_approvers` is built from and changing ' +
        'it is a different decision with a different blast radius.\n\n' +
        'Authz (George 2026-10-16, fr-agui P2-c1): ANY member of the project’s tenant, through the ' +
        'project READ lane (`findProjectForRead`), bounded by the project’s own ' +
        '`project_data.keycloak_tenant_id` tag equalling the caller’s active tenant; a licence ' +
        'caller is refused. A project whose tenant cannot be established REFUSES rather than ' +
        'guesses, and answers the same 404 as a missing project.\n\n' +
        '⚠️ `{items}`, **no `total`**, and `items` is the whole roster rather than only allocated ' +
        'members: see ProjectAllocationEntry. When no item carries any area at all, a consumer ' +
        'that ranks or routes has nothing to rank and must REFUSE — coverage starts at zero and ' +
        'that state stays visible rather than being papered over.',
      tags: ['Knowledge Areas'],
      operationId: 'getProjectKnowledgeAllocation',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          description: 'Project id. A malformed id answers 404, not 400 — existence is not probeable.',
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description:
            'Candidates, resolved members first then unresolved ids, each sorted by name / email / id',
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['items'],
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/ProjectAllocationEntry' } },
            },
          } } },
        },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: "`licence_caller_refused` (a licence caller is not a member); validateAuth's route doors (`code` 'licence_route_not_allowed', 'conveyor_route_forbidden')", content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': {
          description:
            'Project not found. "Another tenant’s", "untagged", "syntactically impossible" and "genuinely missing" all collapse to this shape so existence cannot be probed',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
    tier: 'searchable',
  },
];

/** The exact path → reader table (exported for the agent actions and the tests). */
export const QUALITY_PEOPLE_READ_TABLE: ReadonlyArray<{ id: string; path: string; handler: string; readExport: string; query: string[] }> =
  READS.map((r) => ({ id: r.id, path: r.path, handler: r.handler, readExport: r.readExport, query: Object.keys(r.query) }));

export const PROJECT_QUALITY_PEOPLE_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = READS.map((r) =>
  defineCapability({
    id: r.id,
    area: 'projects',
    summary: r.summary,
    description: r.description,
    http: { method: 'GET', path: r.path, operationId: r.operationId },
    input: z.object({ id: projectId, ...r.query }),
    output: r.output,
    errors: [],
    // The route's gate is validateAuth + the project READ lane (any member of the
    // project's tenant); the agent's is the bound project's membership AND the
    // route itself, which the agent action runs as the human.
    auth: { principal: 'user', rbac: { type: 'project-member' } },
    tenancy: 'project',
    effect: 'read',
    confirm: 'none',
    agent: {
      expose: true,
      tier: r.tier,
      cronSafe: false,
      idempotencyKey: (i: unknown) => `${r.id}:${JSON.stringify(i ?? {})}`,
    },
    openapi: { frozen: r.frozen },
    handler: lazyActionHandler(() => import('../../agui/actions/project-scope-people-quality'), {
      module: 'src/agui/actions/project-scope-people-quality.ts',
      exportName: r.readExport,
    }),
    legacyHandler: lazyHandler(r.load, { module: r.module, exportName: r.handler }),
  }),
);
