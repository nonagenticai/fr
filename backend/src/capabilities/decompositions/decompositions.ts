// fr-agui SPEC §13 P4d-2a (part 2) — spec drain: the literal tag 'Decompositions' routes (split-family contracts, the PM
// execution-card minter and the Readying split) that ALREADY had an operation in the
// served spec (the openapi.ts literal), re-expressed as capabilities with NO behaviour change
// (`legacyHandler`), each literal operation VERBATIM in `openapi.frozen`
// (capabilities/frozen-routes.ts; the licence-door 403 and the pipeline's non-JSON 400 are the
// only edits, each where the literal declared neither that status nor a default).
//
// Gates (the handlers', declared as the rule):
//   * the family routes and the card contract (routes/decompositions.ts): validateAuth (its
//     doors), then the frame tenant (`requireTenant`: absent or empty → 409 MISSING_TENANT); the
//     two writes also need a family writer (`requireFamilyWriter`: a super_admin or a workspace
//     admin of that tenant), checked BEFORE the family lookup;
//   * deliverables / commit / minted / split: validateAuth, `ctxTenantId`, and the project the
//     caller resolves in that tenant (`resolveProjectForCaller`; 404 otherwise).
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import type { Capability } from '../define';
import { frozenRouteCapabilities, type FrozenRoute } from '../frozen-routes';
import { routeRule } from '../library/_shared';
import {
  isAuthenticatedUserInResolvedTenant,
  isAuthenticatedUserWithFrameTenant,
} from '../rbac-rules';

const DECOMPOSITION_ROUTES: FrozenRoute[] = [
  {
    id: 'decompositions.claim_decision_topic', method: 'POST', path: '/api/decompositions/:familyId/decisions', handler: 'handleClaimDecisionTopic', effect: 'write',
    rule: routeRule(isAuthenticatedUserWithFrameTenant),
    frozen: {
      summary: 'Claim a family decision topic (atomic; one active decision per topic)',
      description:
        'Records that `child_key` decided `topic_slug` in this family, with the decision content ' +
        'already authored in requirements_management as `decision_id` (stable_key ' +
        '`fam:<family_id>:<topic_slug>`). ATOMIC: `INSERT … ON CONFLICT (family_id, topic_slug) ' +
        'WHERE superseded_by IS NULL DO NOTHING` on the partial unique index ' +
        '`family_decisions_one_active_topic_idx`, so N concurrent claims of one topic produce ' +
        'exactly one **201**; every other caller gets **409** with the WINNING `decision_id`, and ' +
        'must read that decision and conform. A retry whose `decision_id` and `child_key` match ' +
        'the active claim is **200** `replayed: true`. `seq` is monotonic within a family but NOT ' +
        'dense. Superseding is NOT supported by this route: a body carrying `supersedes` (or any ' +
        'unknown key) is **400**.',
      tags: ['Decompositions'],
      operationId: 'claimDecisionTopic',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'familyId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['topic_slug', 'decision_id', 'child_key'],
              properties: {
                topic_slug: { type: 'string', pattern: '^[a-z0-9_]{3,40}$' },
                decision_id: { type: 'string', format: 'uuid' },
                child_key: { type: 'string', minLength: 1, maxLength: 200 },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'This call claimed the topic',
          content: { 'application/json': { schema: { type: 'object', properties: {
            seq: { type: 'integer', format: 'int64' },
            topic_slug: { type: 'string' },
            decision_id: { type: 'string', format: 'uuid' },
            child_key: { type: 'string' },
            replayed: { type: 'boolean', enum: [false] },
          } } } },
        },
        '200': {
          description: 'The active claim is already this caller\'s (idempotent retry)',
          content: { 'application/json': { schema: { type: 'object', properties: {
            seq: { type: 'integer', format: 'int64' },
            topic_slug: { type: 'string' },
            decision_id: { type: 'string', format: 'uuid' },
            child_key: { type: 'string' },
            replayed: { type: 'boolean', enum: [true] },
          } } } },
        },
        '400': { description: 'Invalid body (including any `supersedes` field)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Authenticated but not a workspace-admin of the active tenant (or super_admin) — split-family writes are role-gated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'No such family in the caller\'s tenant', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '409': {
          description: 'Another child holds the topic; conform to `decision_id`',
          content: { 'application/json': { schema: { type: 'object', properties: {
            error: { type: 'string', enum: ['topic_already_decided'] },
            topic_slug: { type: 'string' },
            decision_id: { type: 'string', format: 'uuid' },
            seq: { type: 'integer', format: 'int64' },
            child_key: { type: 'string' },
          } } } },
        },
      },
    },
  },
  {
    id: 'decompositions.list_decisions', method: 'GET', path: '/api/decompositions/:familyId/decisions', handler: 'handleListFamilyDecisions', effect: 'read',
    rule: routeRule(isAuthenticatedUserWithFrameTenant),
    frozen: {
      summary: 'List the family decision log after a watermark',
      description:
        'Every family decision with `seq > after_seq` (default 0), oldest first, INCLUDING ' +
        'superseded rows (append-only log; `superseded_by` marks them). Callers resolve content ' +
        'with `decisions.getDecision` per id.',
      tags: ['Decompositions'],
      operationId: 'listFamilyDecisions',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'familyId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'after_seq', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
      ],
      responses: {
        '200': {
          description: 'Decision log slice',
          content: { 'application/json': { schema: { type: 'object', properties: { data: {
            type: 'array',
            items: { type: 'object', properties: {
              seq: { type: 'integer', format: 'int64' },
              topic_slug: { type: 'string' },
              decision_id: { type: 'string', format: 'uuid' },
              child_key: { type: 'string' },
              supersedes: { type: 'string', format: 'uuid', nullable: true },
              superseded_by: { type: 'string', format: 'uuid', nullable: true },
              created_at: { type: 'string', format: 'date-time' },
            } },
          } } } } },
        },
        '400': { description: 'Invalid after_seq', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'No such family in the caller\'s tenant', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    id: 'decompositions.put_bundle', method: 'PUT', path: '/api/decompositions/:familyId/bundle', handler: 'handlePutFamilyBundle', effect: 'write',
    rule: routeRule(isAuthenticatedUserWithFrameTenant),
    frozen: {
      summary: 'Store a frozen family context bundle version (write-once)',
      description:
        'Writes `family_bundles(family_id, version)`. A version is FROZEN once written: the same ' +
        '`bundle_hash` again is **200** (idempotent retry, nothing written); a different ' +
        '`bundle_hash` for an existing version is **409** `bundle_version_frozen` — a changed ' +
        'bundle is a new version.',
      tags: ['Decompositions'],
      operationId: 'putFamilyBundle',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'familyId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['version', 'bundle_hash', 'items'],
              properties: {
                version: { type: 'integer', minimum: 1 },
                bundle_hash: { type: 'string', minLength: 1, maxLength: 200 },
                items: { type: 'array', items: {} },
                retrieval_trace: { type: 'object' },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Version created',
          content: { 'application/json': { schema: { type: 'object', properties: {
            version: { type: 'integer' }, bundle_hash: { type: 'string' }, created: { type: 'boolean', enum: [true] },
          } } } },
        },
        '200': {
          description: 'Version already stored with the same hash (nothing written)',
          content: { 'application/json': { schema: { type: 'object', properties: {
            version: { type: 'integer' }, bundle_hash: { type: 'string' }, created: { type: 'boolean', enum: [false] },
          } } } },
        },
        '400': { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Authenticated but not a workspace-admin of the active tenant (or super_admin) — split-family writes are role-gated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'No such family in the caller\'s tenant', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '409': {
          description: 'Version exists with a different bundle_hash',
          content: { 'application/json': { schema: { type: 'object', properties: {
            error: { type: 'string', enum: ['bundle_version_frozen'] },
            version: { type: 'integer' },
            existing_bundle_hash: { type: 'string' },
          } } } },
        },
      },
    },
  },
  {
    id: 'decompositions.get_bundle', method: 'GET', path: '/api/decompositions/:familyId/bundle', handler: 'handleGetFamilyBundle', effect: 'read',
    rule: routeRule(isAuthenticatedUserWithFrameTenant),
    frozen: {
      summary: 'Read a family context bundle (latest, or a given version)',
      tags: ['Decompositions'],
      operationId: 'getFamilyBundle',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'familyId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'version', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
      ],
      responses: {
        '200': {
          description: 'The bundle',
          content: { 'application/json': { schema: { type: 'object', properties: { data: {
            type: 'object',
            properties: {
              version: { type: 'integer' },
              bundle_hash: { type: 'string' },
              items: { type: 'array', items: {} },
              retrieval_trace: { type: 'object' },
              created_at: { type: 'string', format: 'date-time' },
            },
          } } } } },
        },
        '400': { description: 'Invalid version', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'No such family in the caller\'s tenant, or no bundle (version)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    id: 'decompositions.get_project_deliverables', method: 'GET', path: '/api/projects/:id/deliverables', handler: 'handleGetProjectDeliverables', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["decompositions.getProjectDeliverables"],
    source: { module: 'src/routes/decomposition-commit.ts', load: () => import('../../routes/decomposition-commit') },
    tenancy: 'project',
    frozen: {
      summary: "A project's approved deliverables, machine-readable",
      description:
        'Rows of `project_deliverables` for the project, ordered by `position`. A row exists only when ' +
        'the project was promoted from an APPROVED outline, so row presence IS approval: an empty ' +
        '`items` means nothing is approved. Same auth and tenant scope as POST /api/cards/project ' +
        '(404 for a project not visible under the active tenant; 403 ' +
        '`project_cards_only_on_exec_tenant` off EXEC unless the aa-orchestrator cross-tenant identity).',
      tags: ['Decompositions'],
      operationId: 'getProjectDeliverables',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'The approved deliverables, ordered by position',
          content: { 'application/json': { schema: { type: 'object', required: ['items', 'total'], properties: {
            items: { type: 'array', items: { type: 'object', properties: {
              id: { type: 'string', format: 'uuid' },
              position: { type: 'integer' },
              kind: { type: 'string', enum: ['deliverable', 'intermediate'] },
              title: { type: 'string' },
              description: { type: 'string', nullable: true },
              acceptance_criteria: { type: 'array', items: { type: 'string' } },
              source_outline_id: { type: 'string', format: 'uuid', nullable: true },
              repos: {
                type: 'array',
                items: { type: 'string' },
                nullable: true,
                description:
                  'fr#1332 / migration 151: the repositories this deliverable changes, verbatim from the ' +
                  'approved outline (ncn#1939 attribution), carried at promote. null = not attributed ' +
                  '(never []). Read by the C1-58 intake minter to choose a per-child `repo` on commit.',
              },
              deferred: { type: 'boolean', description: 'U-PS-COMMIT (migration 169): present (true) only on a deferred deliverable — no card at commit; its minter attaches cards.' },
              minter: { type: 'string', nullable: true, description: 'Present only when deferred: the pm template minter.' },
              minted_at: { type: 'string', format: 'date-time', nullable: true, description: 'Present only when deferred: null until the minter reports.' },
              minted_count: { type: 'integer', nullable: true, description: 'Present only when deferred: the reported card count (0 = nothing to mint ⇒ complete).' },
            } } },
            total: { type: 'integer' },
          } } } },
        },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'project_cards_only_on_exec_tenant: not on the EXEC tenant', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
        '404': { description: 'project_not_found: project not found under the active tenant', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
      },
    },
  },
  {
    id: 'decompositions.commit', method: 'POST', path: '/api/decompositions/commit', handler: 'handleCommitDecomposition', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["decompositions.commitDecomposition"],
    source: { module: 'src/routes/decomposition-commit.ts', load: () => import('../../routes/decomposition-commit') },
    frozen: {
      summary: 'Commit a project decomposition and mint one TODO card per approved deliverable',
      description:
        'Validates `children` against the project\'s approved deliverables, records ONE ' +
        '`decompositions` row (id = `decomposition_id`), one `card_contracts` row per deliverable ' +
        '(`child_key` = `deliv:<deliverable_id>`, `covers` = [deliverable_id], criteria from ' +
        '`acceptance_criteria`) and `contract_dependencies` (every kind=deliverable child requires every ' +
        'kind=intermediate child — the approved scope carries no finer edges), then mints each card through ' +
        'the POST /api/cards/project path into TODO with `asset_id` = the child_key, `parent_card_id` = the ' +
        'intake card, and deliverable cards `requires` the intermediate cards. Idempotent: the same ' +
        '`decomposition_id` again is a **200** with the same card ids and 0 new cards; a `deliv:` asset ' +
        'dedupes onto an existing card in ANY list including DONE. No transaction is held across a Planka ' +
        'call; a retry after a partial failure converges. Same auth and tenant scope as POST ' +
        '/api/cards/project (not the family-writer gate). Each minted card\'s description JSON carries ' +
        '`gherkin_scenarios` (C1-58 D14): one `{scenario_id: "scn_<8hex>", criterion_id: "crit_<8hex>", ' +
        'title: <criterion text>, gherkin: null, status: "pending"}` per DISTINCT acceptance criterion, 1:1 and in ' +
        'order (a repeated criterion text is one criterion, so scenario_id is unique), the 8 hex being the ' +
        'criterion\'s own `sha1(text)[0:8]` — deterministic, so identical on replay.',
      tags: ['Decompositions'],
      operationId: 'commitDecomposition',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['decomposition_id', 'project_id', 'parent_card_id', 'children'],
              properties: {
                decomposition_id: { type: 'string', format: 'uuid', description: 'Caller-generated; the family id.' },
                project_id: { type: 'string', format: 'uuid' },
                parent_card_id: { type: 'string', pattern: '^[\\x21-\\x7E]{1,200}$', description: 'The intake card.' },
                children: {
                  type: 'array',
                  minItems: 1,
                  description: 'Exactly one entry per approved deliverable (both kinds).',
                  items: {
                    type: 'object',
                    required: ['deliverable_id', 'card_type'],
                    properties: {
                      deliverable_id: { type: 'string', format: 'uuid' },
                      card_type: { type: 'string', description: 'One of the POST /api/cards/project card_type enum values; anything else is a 422.' },
                      repo: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 2048,
                        description:
                          'fr#1332. OPTIONAL — the one repository this child\'s card works in. Must be one of the ' +
                          'deliverable\'s attributed `repos` (GET /api/projects/{id}/deliverables; compared ' +
                          'trimmed, case-insensitive, without trailing `/` or `.git`), else 422 ' +
                          '`repo_not_attributed` with nothing recorded. Written as `repository_url` in the minted ' +
                          'card\'s description JSON (n8n hydration\'s `card_inputs.repository_url`), using the ' +
                          'ATTRIBUTED spelling. Only cards created by the call carry it; a replay rewrites nothing. ' +
                          'Absent: unchanged.',
                      },
                      priority: {
                        type: 'string',
                        description:
                          "A priority level of the owning tenant (requirements_management `priority-levels`): its id, or its name case-insensitively (e.g. `P1`). Any other value is 400 `invalid_priority` with the tenant levels in `details.allowed`." + ' ' +
                          'fr#1397. OPTIONAL — this child card\'s `Metadata.priority`, stamped exactly as POST ' +
                          '/api/cards/project does. Any other value is a 400 `validation_failed` naming ' +
                          '`children.<i>.priority`, nothing recorded or minted. Only cards created by the call ' +
                          'carry it; a replay rewrites nothing. Absent: no priority written.',
                      },
                    },
                  },
                },
                version_stamp: {
                  type: 'object',
                  additionalProperties: true,
                  description:
                    'B13. OPTIONAL — the same `version_stamp` POST /api/cards/project accepts (C1-46), passed ' +
                    'through UNCHANGED to every card this commit CREATES: stored in fr (`card_version_stamps`) ' +
                    'with the pointer `Metadata.version_stamp = {"store":"fr","sha256":"<hex>"}` on the card. ' +
                    'Not an object is a 400 `validation_failed`; over 64 KiB serialised is a 422 ' +
                    '`version_stamp_too_large` with nothing recorded. NOT part of the decomposition identity: ' +
                    'a replay of the same `decomposition_id` with a different stamp is not a conflict, returns ' +
                    'the existing cards and leaves their stamps unchanged (a dedupe hit writes no stamp); only ' +
                    'cards created by that call carry it. Absent: unchanged.',
                },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Replay: every card already existed, 0 created, same card ids' },
        '201': { description: 'Recorded and at least one card created. Body: {decomposition_id, project_id, parent_card_id, replayed, created_count, cards:[{deliverable_id, kind, child_key, card_type, card_id, created}]}' },
        '400': { description: 'validation_failed (malformed body)', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'project_cards_only_on_exec_tenant: not on the EXEC tenant', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
        '404': { description: 'project_not_found: project not found under the active tenant', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
        '409': { description: 'deliverables_already_decomposed | decomposition_id_conflict (nothing recorded) | mint_incomplete (retry)', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
        '422': { description: 'version_stamp_too_large | card_type_not_in_catalogue (a child card_type is not a card type of the project tenant\'s RM catalogue; carries the tenant\'s list) | deliverable_count_out_of_range ("N deliverables; revise to 3-7") | intermediate_count_out_of_range | unknown_deliverable | coverage_duplicate | coverage_incomplete | repo_not_attributed | deliverable_deferred (a child named a deferred deliverable) — nothing recorded or minted; mint_refused — recorded, but the minter refused a card on its input (not retryable as-is)', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
        '502': { description: 'mint_failed: recorded, a card could not be minted (upstream/5xx); retry the same call', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
      },
    },
  },
  {
    id: 'decompositions.report_deliverable_minted', method: 'POST', path: '/api/projects/:id/deliverables/:did/minted', handler: 'handleDeliverableMinted', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    source: { module: 'src/routes/deliverable-minted.ts', load: () => import('../../routes/deliverable-minted') },
    tenancy: 'project',
    frozen: {
      summary: "A deferred deliverable's minter reports its last create (idempotent)",
      description:
        'U-PS-COMMIT. Stamps `minted_at` + `minted_count` on a DEFERRED `project_deliverables` row exactly ' +
        'once. The same count again is a 200 no-op; a different count is 409 `minted_count_conflict`. ' +
        'count=0 (e.g. a 0-finding hunt) makes the deliverable complete. Same auth and tenant scope as ' +
        'GET /api/projects/{id}/deliverables (EXEC pin; aa-orchestrator cross-tenant identity).',
      tags: ['Decompositions'],
      operationId: 'reportDeliverableMinted',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'did', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['count'], additionalProperties: false, properties: {
          count: { type: 'integer', minimum: 0, maximum: 10000 },
        } } } },
      },
      responses: {
        '200': { description: 'Replay: already stamped with this count (replayed: true)', content: { 'application/json': { schema: { type: 'object' } } } },
        '201': { description: 'First stamp (replayed: false)', content: { 'application/json': { schema: { type: 'object' } } } },
        '400': { description: 'validation_failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'project_cards_only_on_exec_tenant: not a platform caller', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
        '404': { description: 'project_not_found | deliverable_not_found', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
        '409': { description: 'minted_count_conflict | minted_retry | project_archived', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
        '422': { description: 'deliverable_not_deferred: a fixed deliverable is minted at commit', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
      },
    },
  },
  {
    id: 'decompositions.split', method: 'POST', path: '/api/decompositions/split', handler: 'handleSplitDecomposition', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["decompositions.splitDecomposition"],
    source: { module: 'src/routes/decomposition-split.ts', load: () => import('../../routes/decomposition-split') },
    frozen: {
      summary: 'Split one card at Readying into 2-5 TODO child cards (ncn#1960)',
      description:
        'Records ONE `decompositions` family per parent card (id = `decomposition_id`, with ' +
        '`computed_by` and `reason`), one `card_contracts` row per child (`child_key` = ' +
        '`split:<decomposition_id>:<i>`, `depth` = parent_split_depth + 1, criteria from the child\'s ' +
        '`acceptance_criteria`), then mints each child through the POST /api/cards/project path into TODO ' +
        'with `asset_id` = the child_key and `parent_card_id` = the split card (both relation sides). Each ' +
        'child description carries a ```json fence {project_id, split_depth, acceptance_criteria} and the ' +
        '`<!-- aa:decomposition:start -->` ```decomposition fence {parent_card, split_depth}. The parent card ' +
        'must be on the project\'s board. Idempotent: the same `decomposition_id` with the same children is a ' +
        '**200** with the same card ids; a `split:` asset dedupes onto an existing card in ANY list including ' +
        'DONE. No transaction is held across a Planka call; a retry after a partial failure converges. Same ' +
        'auth and tenant scope as POST /api/decompositions/commit.',
      tags: ['Decompositions'],
      operationId: 'splitDecomposition',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['decomposition_id', 'project_id', 'parent_card_id', 'parent_split_depth', 'children', 'computed_by', 'reason'],
              properties: {
                decomposition_id: { type: 'string', format: 'uuid', description: 'Caller-generated; the family id.' },
                project_id: { type: 'string', format: 'uuid' },
                parent_card_id: { type: 'string', pattern: '^[\\x21-\\x7E]{1,200}$', description: 'The card being split.' },
                parent_split_depth: { type: 'integer', minimum: 0, description: 'Children land at this + 1; above 2 is a 422. When the parent is itself a split child its recorded card_contracts depth is authoritative, and a disagreeing value is a 422 parent_split_depth_mismatch {stored, sent}.' },
                children: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 5,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['title', 'description', 'acceptance_criteria', 'card_type'],
                    properties: {
                      title: { type: 'string', minLength: 1, maxLength: 200 },
                      description: { type: 'string', maxLength: 8000 },
                      acceptance_criteria: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1 } },
                      card_type: { type: 'string', description: 'One of the POST /api/cards/project card_type enum values; anything else is a 422.' },
                    },
                  },
                },
                computed_by: { type: 'string', enum: ['rule', 'invest_t'] },
                reason: { type: 'string', maxLength: 200 },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Replay: every child already existed. Body: {decomposition_id, child_card_ids, replayed:true}' },
        '201': { description: 'Recorded and at least one child created. Body: {decomposition_id, child_card_ids, replayed:false}' },
        '400': { description: 'validation_failed (malformed body)', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'project_cards_only_on_exec_tenant: not on the EXEC tenant', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
        '404': { description: 'project_not_found | parent_card_not_found (not on this project\'s board)', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
        '409': { description: 'parent_not_splittable_in_list {list} — the parent is not on TODO/READY (DOING never splits; nothing recorded) | parent_already_split (body names the existing decomposition_id) | decomposition_id_conflict (nothing recorded) | mint_incomplete (retry)', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
        '422': { description: 'split_depth_exceeded | parent_split_depth_mismatch {stored, sent} | card_type_not_in_catalogue (carries the tenant\'s list) — nothing recorded or minted; mint_refused — recorded, the minter refused a child (not retryable as-is)', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
        '502': { description: 'planka_parent_card_fetch_failed | planka_list_fetch_failed (nothing recorded) | mint_failed (recorded; retry the same call)', content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } } },
      },
    },
  },
  {
    id: 'decompositions.get_card_contract', method: 'GET', path: '/api/cards/:cardId/contract', handler: 'handleGetCardContract', effect: 'read',
    rule: routeRule(isAuthenticatedUserWithFrameTenant),
    frozen: {
      summary: 'Read a card\'s split contract (card_contracts)',
      description:
        'fr is the authority for a card\'s contract; the Planka ```json fence and custom fields are ' +
        'projections. **404** means the card has no contract in the caller\'s tenant — which is ' +
        'the true answer for every card no decomposition commit has bound.',
      tags: ['Decompositions'],
      operationId: 'getCardContract',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'cardId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'The contract row',
          content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object' } } } } },
        },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'No contract for this card in the caller\'s tenant', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
];

export const DECOMPOSITION_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = frozenRouteCapabilities({ area: 'decompositions', tenancy: 'tenant', module: 'src/routes/decompositions.ts', load: () => import('../../routes/decompositions') }, DECOMPOSITION_ROUTES);
