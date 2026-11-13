// fr-agui SPEC §13 P4d-2a (part 2) — spec drain: the literal tag 'Cards' routes (AA cards and the finding-suppression ledger) that ALREADY had an operation in the
// served spec (the openapi.ts literal), re-expressed as capabilities with NO behaviour change
// (`legacyHandler`), each literal operation VERBATIM in `openapi.frozen`
// (capabilities/frozen-routes.ts; the licence-door 403 and the pipeline's non-JSON 400 are the
// only edits, each where the literal declared neither that status nor a default).
//
// Gates (the handlers', declared as the rule):
//   * validateAuth (its licence / conveyor doors) then `ctxTenantId` — the card's tenant
//     (board → project) must be the request tenant (`resolveCardRouteProject` and kin; a card in
//     another tenant is a 404), the suppressions' project likewise (DELETE and a security-category
//     PUT also need the project owner or a super_admin);
//   * `POST /api/cards/improvement`: the frame tenant (asset card types); every other type an opaque 404.
// The project agent reads a card through its own action (agui/actions/project-core.ts
// `cards.get`), which runs `GET /api/cards/:cardId` as the human — unchanged.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import type { Capability } from '../define';
import { frozenRouteCapabilities, type FrozenRoute } from '../frozen-routes';
import { routeRule } from '../library/_shared';
import {
  isAuthenticatedUserInResolvedTenant,
  isAuthenticatedUserWithFrameTenant,
} from '../rbac-rules';

const CARD_ROUTES: FrozenRoute[] = [
  {
    id: 'cards.create_improvement', method: 'POST', path: '/api/cards/improvement', handler: 'handleCreateImprovementCard', effect: 'write',
    rule: routeRule(isAuthenticatedUserWithFrameTenant),
    licenceOps: ["improvementCard.create"],
    source: { module: 'src/routes/cards/improvement.ts', load: () => import('../../routes/cards/improvement') },
    frozen: {
      summary: 'Create an improvement card from a card_generation_request body',
      description:
        'Validates a fully-qualified `card_generation_request_template.v1` body ' +
        '(services/improvement-cards/request-schema.ts), maps it onto the 8 AA-spec ' +
        'customFieldGroups and mints the Planka card. Two tenant gates, chosen by `card_type`: ' +
        'the six asset-authoring types (`principle_development`, `requirement_development`, ' +
        '`decision_development`, `change_principle_development`, `change_requirement_development`, ' +
        '`change_decision_development`) and the three governor-emitted asset-analysis types ' +
        '(`principle_statistics_analysis`, `requirement_statistics_analysis`, ' +
        '`decision_statistics_analysis`) accept ANY authenticated tenant and lazily provision the ' +
        "per-(tenant, kind) asset stream, so `stream_slug` is not needed; EVERY other `card_type` " +
        'is refused with **404, not 403** (it was admitted only on the v3 improvement tenants, deleted ' +
        '2026-11-03) — the surface stays private. The stream is ' +
        "always resolved from the DB under the authenticated tenant; the body's `stream_id` / " +
        '`stream_slug` are never trusted to name a board. ' +
        '⚠️ TWO SUCCESS STATUSES. **201** means a card was created. **200 with `deduped: true`** ' +
        'means an already-open card for this (board, asset_id) was returned instead, or a ' +
        'concurrent create holds the lease. Under n8n retries the 200 path is the COMMON one — ' +
        'a client MUST handle it as success, not as an error, and must read `card_id` from the ' +
        'body rather than assuming 201. On the lease-loser path `card_id` can be `null` with ' +
        '`create_in_progress: true`: the winner is still minting, so poll rather than retrying ' +
        'the create. Dedup applies only when `asset_id` is present AND `card_type` is in one of ' +
        'the deduped families (detector/sweep `*_analysis`, AA-intake `*_development` ' +
        'parent-approval, blocked-escalate learning cards); a card that is only in DONE does not ' +
        'suppress a new mint. ' +
        'One constraint this schema cannot express: `stream_slug` is required only on the ' +
        'internal-tenant (non-asset `card_type`) branch — omitting it there returns 400 ' +
        '`stream_slug_required_for_internal_tenant`. ' +
        '`stream_membership` in the 201 body is a deliberate graceful degrade: the write runs ' +
        'AFTER the card exists and never fails the request, so its outcome is reported instead ' +
        'of thrown.',
      tags: ['Cards'],
      operationId: 'createImprovementCard',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: [
                'card_type',
                'project_id',
                'parent_card_id',
                'target_list',
                'requestor',
                'problem_statement',
                'desired_outcome',
                'success_criteria',
                'acceptance_criteria',
                'scope_level',
              ],
              properties: {
                card_type: {
                  type: 'string',
                  minLength: 1,
                  description:
                    'Free string, NOT an enum. Decides the tenant gate (asset vs internal), the ' +
                    'customFieldGroup mapping and whether open-card dedup applies.',
                },
                project_id: { type: 'string', minLength: 1 },
                parent_card_id: {
                  type: 'string',
                  nullable: true,
                  description:
                    'The KEY is required; the value may be null for a root card.',
                },
                target_list: {
                  type: 'string',
                  enum: ['TODO', 'READY', 'DOING', 'QA', 'BLOCKED', 'DONE'],
                  description:
                    "Resolved by NAME against the stream's Planka board; an unprovisioned list " +
                    'is a 404 `target_list_not_found`. A card minted straight into BLOCKED gets a ' +
                    'block_reason stamped best-effort.',
                },
                requestor: { type: 'string', minLength: 1 },
                problem_statement: {
                  type: 'string',
                  minLength: 1,
                  description: 'Becomes the card name, truncated to 200 characters.',
                },
                desired_outcome: { type: 'string', minLength: 1 },
                success_criteria: {
                  type: 'array',
                  minItems: 1,
                  items: { type: 'string', minLength: 1 },
                },
                acceptance_criteria: {
                  type: 'array',
                  minItems: 1,
                  items: { type: 'string', minLength: 1 },
                },
                scope_level: {
                  type: 'string',
                  enum: [
                    'multi_repo',
                    'repo',
                    'app',
                    'module',
                    'component',
                    'file',
                    'class',
                    'function',
                  ],
                  description:
                    'Code GRANULARITY, the single canonical vocabulary (types/scope-level.ts). ' +
                    "Legacy t-shirt sizes ('small'/'medium'/'large'/'enterprise') and the AA " +
                    "drive scripts' 'single_repo' are REJECTED here, never coerced.",
                },
                plan_pin: {
                  type: 'object',
                  additionalProperties: true,
                  required: ['plan'],
                  properties: {
                    plan: {
                      type: 'object',
                      // OAS 3.0 has no `propertyNames`; the key constraint is documented here
                      // and enforced at runtime by the handler's zod schema.
                      description:
                        'Map keyed by list name. Keys MUST be one of: todo, ready, doing, qa, blocked, done ' +
                        '(lowercase; at least one key). Any other key is a 422 `plan_pin_invalid`.',
                      additionalProperties: {
                        type: 'object',
                        required: ['activity_sequence'],
                        properties: { activity_sequence: { type: 'array', items: { type: 'string' } } },
                      },
                    },
                  },
                  description:
                    'U11. The plan the minter computed for this card, `{plan: {<list>: {activity_sequence: string[]}}, …}`. ' +
                    'On a NEW card only, it is stored INSERT-ONCE in fr (`card_plan_pins`, migration 148; UPDATE/DELETE ' +
                    'refused by a DB trigger) and the card gets the pointer `Metadata.plan_pin = {"store":"fr","sha256":"<hex>"}`, ' +
                    'sha256 computed SERVER-SIDE over the canonical JSON (keys sorted). A dedupe hit / lease loser / suppressed ' +
                    'fingerprint writes neither. If a pin already exists for the new card id the create is refused and rolled ' +
                    'back (the pointer is never rewritten). A rolled-back create KEEPS its pin row (it cannot be deleted). ' +
                    'Over 64 KiB → 422 `plan_pin_too_large`; wrong shape → 422 `plan_pin_invalid`. Absent: unchanged.',
                },
                priority: { type: 'string', description: "A priority level of the owning tenant (requirements_management `priority-levels`): its id, or its name case-insensitively (e.g. `P1`). Any other value is 400 `invalid_priority` with the tenant levels in `details.allowed`." },
                in_scope: { type: 'array', items: { type: 'string' } },
                out_of_scope: { type: 'array', items: { type: 'string' } },
                dependencies: { type: 'array', items: { type: 'string' } },
                constraints: { type: 'array', items: { type: 'string' } },
                deadline: { type: 'string', format: 'date-time' },
                artifacts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['name', 'uri', 'type', 'description'],
                    properties: {
                      name: { type: 'string' },
                      uri: {
                        type: 'string',
                        description:
                          'Deliberately a free string, not a URL — workflow nodes put tracking ' +
                          'ids here.',
                      },
                      type: { type: 'string' },
                      description: { type: 'string' },
                    },
                  },
                },
                secret_ids: { type: 'array', items: { type: 'string' } },
                additional_context: {
                  oneOf: [{ type: 'string' }, { type: 'object' }],
                  description:
                    'Free-form context persisted verbatim into the card description JSON. ' +
                    'Accepts a string OR an object (the decomposition approval card carries ' +
                    '`{ approval_kind, analysis_payload }` here).',
                },
                detector_severity: {
                  type: 'string',
                  enum: ['critical', 'high', 'medium', 'low'],
                  description: "Read by todo_pickup.json's priority sort.",
                },
                manual_trigger: {
                  type: 'boolean',
                  description:
                    "Marks the manual-card paths; becomes the mint ledger's " +
                    "trigger_reason 'manual' vs 'detector'.",
                },
                stream_id: {
                  type: 'string',
                  format: 'uuid',
                  description:
                    'Informational only — the stream is always re-resolved server-side.',
                },
                stream_slug: {
                  type: 'string',
                  minLength: 1,
                  description:
                    'Optional in the schema, but REQUIRED for every non-asset `card_type` ' +
                    '(internal-tenant branch).',
                },
                asset_id: {
                  type: 'string',
                  description:
                    'Free string, NOT constrained to a uuid: the parent-approval and ' +
                    'blocked-escalate flows stamp synthetic ids. A non-uuid value is skipped by ' +
                    'name for stream membership and the mint ledger. Required for open-card ' +
                    'dedup to apply.',
                },
                asset_kind: {
                  type: 'string',
                  description:
                    'Not constrained to the asset_kind enum here; an unknown value skips the ' +
                    'membership write with `skipped_unknown_asset_kind`.',
                },
                worker_name: {
                  type: 'string',
                  description:
                    'Identifies the EXISTING worker being improved, for the ' +
                    'prompt_improvement / workflow_improvement canary loops.',
                },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Card created',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  card_id: { type: 'string' },
                  stream_membership: {
                    type: 'string',
                    enum: [
                      'recorded',
                      'skipped_no_asset',
                      'skipped_non_uuid_asset_id',
                      'skipped_unknown_asset_kind',
                      'failed',
                    ],
                  },
                },
              },
            },
          },
        },
        '200': {
          description:
            'Deduped — an open card for this asset already exists, or a concurrent create holds ' +
            'the lease. The COMMON outcome under n8n retries; treat as success.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  card_id: {
                    type: 'string',
                    nullable: true,
                    description:
                      'The existing open card. `null` only on the lease-loser path, together ' +
                      'with `create_in_progress: true`.',
                  },
                  deduped: { type: 'boolean', enum: [true] },
                  create_in_progress: {
                    type: 'boolean',
                    description:
                      'Present only when the lease winner is still minting — poll, do not retry ' +
                      'the create.',
                  },
                  evidence_appended: {
                    type: 'boolean',
                    description:
                      'U7 — present ONLY on a dedupe hit for an evidence-bearing request ' +
                      '(`additional_context` is an object carrying `source_card_id`); any other ' +
                      'dedupe hit answers `{ card_id, deduped: true }` with no evidence fields. ' +
                      "Whether this request's evidence is on the open card: one Planka " +
                      'comment with a human summary plus a fenced `fr.improvement_evidence.v1` ' +
                      'JSON record. `true` also on an idempotent replay (`evidence_reason: ' +
                      '"already_appended"`). `false` never fails the request; `evidence_reason` ' +
                      'names why (`tenant_mismatch`, `tenant_unknown`, `no_open_card_visible`, ' +
                      '`board_read_failed`, `comment_scan_failed`, `comment_write_failed`).',
                  },
                  evidence_reason: { type: 'string' },
                  evidence_key: {
                    type: 'string',
                    description:
                      'Idempotency key: `ev1:src:<source_card_id>:exec:<source_execution_id>`, or ' +
                      '`ev1:sha256:<hex>` when the request carries no source execution id.',
                  },
                  evidence_key_basis: {
                    type: 'string',
                    enum: ['source_execution', 'content_hash'],
                  },
                },
              },
            },
          },
        },
        '400': {
          description:
            "Body failed validation (`{ error: 'validation_failed', issues }` — zod issues), or " +
            '`stream_slug_required_for_internal_tenant`, or `unknown_asset_card_type`',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '401': {
          description:
            'Missing or invalid bearer token, or `tenant_required` (no tenant in context on the ' +
            'asset-card_type branch)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '404': {
          description:
            '`stream_not_found`, `target_list_not_found` (the body carries the requested `list`), ' +
            'or a non-internal tenant on a non-asset `card_type` — refused as 404, not 403',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '409': {
          description:
            "`stream_board_not_provisioned` — the stream has no Planka board yet (or still the " +
            "'planka-tbd' placeholder)",
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
      },
    },
  },
  {
    id: 'cards.create_project_card', method: 'POST', path: '/api/cards/project', handler: 'handleCreateProjectCard', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["card.createFromProject"],
    frozen: {
      summary: 'Spawn the next card in a project card-type chain',
      description:
        'Creates a project-chain card on the board of an existing project and stamps its Metadata ' +
        'custom fields (`card_type`, `work_type`/`card_group` = `project_management`, `project_id`, ' +
        "`keycloak_tenant_id` = the caller's active tenant). Called by the DONE-phase n8n workflows " +
        'to hand off to the next `card_type`. Tenant-scoped: the project must be visible under the ' +
        "caller's active tenant, and the project must live on the EXEC tenant — the only exception " +
        'is the trusted cross-tenant service identity (the `aa-orchestrator` role asserted via the ' +
        'X-Tenant-Id override), which may spawn into another tenant’s project. The project is ' +
        'resolved BEFORE the EXEC check, so an invisible or missing project returns 404, not 403. ' +
        '`target_list` names a list by name on the project board and defaults to READY so the ' +
        'router fires immediately; note the enum here is TODO/READY/DOING/QA/BLOCKED with **no ' +
        'DONE**, unlike the improvement-card route. Creating straight into BLOCKED also stamps a ' +
        'fallback `block_reason` so the card is not classified `unknown_no_reason_persisted`. When ' +
        '`parent_card_id` is given, BOTH sides of the relation are written (the parent’s ' +
        '`child_cards` array under an advisory lock, and the child’s `parent_card` pointer), ' +
        'and the outcome is reported on the 201 as `parent_link`. If any stamp or the relation link ' +
        'fails the freshly created card is deleted again; `spawned_card_rolled_back` reports ' +
        'whether that delete succeeded. When `requires_card_ids` is given, every id is first ' +
        'checked to be a card on THIS project’s board (else 404 `requires_card_not_found` / 422 ' +
        '`requires_card_not_on_project_board`, nothing created); then both sides of each ' +
        'dependency are written (the new card’s `requires`, each dependency’s `required_by`, under ' +
        'the same advisory lock) and reported as `requires_link` on the 201 — or on a deduped 200, ' +
        'where the existing open card is linked idempotently.',
      tags: ['Cards'],
      operationId: 'createProjectCard',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['project_id', 'card_type'],
              properties: {
                project_id: { type: 'string', format: 'uuid' },
                card_type: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 200,
                  description:
                    'A card type of the PROJECT tenant\'s PM catalogue in requirements_management. Any other ' +
                    'name is a 422 `card_type_not_in_catalogue` carrying `invalid` and the tenant\'s `allowed` list; ' +
                    'a tenant with no catalogue is a 409 `catalogue_not_initialised`. Nothing is created.',
                },
                card_name: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 200,
                  description:
                    'Card title. Defaults to `{card_type} — {project name}` when omitted.',
                },
                description: {
                  type: 'string',
                  description:
                    'Card body. Workflows pass a structured JSON payload here for the next ' +
                    'workflow to parse. fr#1338: if the card document (the first ```json fence, else the ' +
                    'whole body when it starts with `{`) carries `gherkin_scenarios`, every entry is ' +
                    'validated STRICTLY — keys: scenario_id (`scn_<8hex>`), criterion_id (`crit_<hex>`), ' +
                    'title, gherkin (≤20000, nullable), status, scenario_hash (64 hex), and the repro ' +
                    'contract v2 evidence failing_test, test_path (under `tests/`), test_file_sha256 (64 hex), ' +
                    'test_file_content (≤32768 UTF-8 bytes), base_sha (40 hex), expect_red, runner. Any other ' +
                    'key, an over-cap file, a bad shape, a duplicate scenario_id or a test_file_sha256 that ' +
                    'is not the content\'s sha256 is a **400** (`gherkin_scenario_unknown_key` / ' +
                    '`gherkin_scenario_test_file_too_large` / `gherkin_scenarios_invalid` / ' +
                    '`gherkin_scenario_test_file_sha256_mismatch` / `gherkin_scenario_text_not_storable` (NUL or a ' +
                    'lone UTF-16 surrogate in an entry string) / `gherkin_scenario_evidence_outside_document` (a ' +
                    '`test_file_content` key the parsed card document does not account for: no ```json document ' +
                    'parses, a second fence, prose, a nested object — fail closed), body ' +
                    '`qa_needs_info: "repro_malformed"`), ' +
                    'nothing created — never stripped. `test_file_content` is NEVER sent to Planka: it is ' +
                    'removed from the description and stored in fr (`card_scenario_evidence`), returned by ' +
                    'GET /api/cards/:id as `scenario_evidence`; the card keeps `test_file_sha256` as the pointer. ' +
                    'B4: a scenario hash is never trusted as sent — `scenarios_check.scenario_hash` must equal the ' +
                    'canonical-scenarios-hash v1 fr recomputes over `gherkin_scenarios` (`[]` when absent), and an ' +
                    'entry\'s `scenario_hash` the hash of `[that entry]`; otherwise **422** `scenario_hash_mismatch`, ' +
                    'nothing created. Absent ⇒ nothing is computed or stamped.',
                },
                parent_card_id: {
                  type: 'string',
                  description:
                    'Spawning card id. Links both sides of the parent/child relation when present.',
                },
                target_list: {
                  type: 'string',
                  enum: ['TODO', 'READY', 'DOING', 'QA', 'BLOCKED'],
                  default: 'READY',
                  description:
                    'List name on the project board. No DONE — unlike the improvement-card route.',
                },
                asset_id: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 200,
                  pattern: '^[\\x21-\\x7E]{1,200}$',
                  description:
                    'Stable finding fingerprint: 1..200 printable ASCII characters, no whitespace ' +
                    'anywhere (the conveyor emits `<16 hex>.<ordinal>`); a padded or blank value is ' +
                    'a 400. Same validator as PUT /api/findings/suppressions `fingerprint`. When present: a fingerprint in the ' +
                    'finding_suppressions ledger answers 200 `{suppressed: true, card_id: null}` and ' +
                    'creates nothing; otherwise an OPEN card (any list but DONE; a BLOCKED card only ' +
                    'within FR_BLOCKED_SUPPRESSION_TTL_DAYS) on the project board already carrying ' +
                    'this `Metadata.asset_id` answers 200 `{card_id, deduped: true}`. Concurrent ' +
                    'creates for one asset are serialised by a create lease; a loser answers with ' +
                    'the winner\'s card, or `{card_id: null, deduped: true, create_in_progress: ' +
                    'true}`. A created card is stamped `Metadata.asset_id`. Absent: unchanged.',
                },
                deliverable_id: {
                  type: 'string',
                  maxLength: 200,
                  description:
                    'fr#1481. The DEFERRED project deliverable this card belongs to: its plan slug ' +
                    '(`plan_deliverable_id`, pm Deliverable.id, `^[a-z][a-z0-9_]*$`) or its row uuid. ' +
                    'The card is attached with a `card_contracts` row whose `covers` names the row ' +
                    '(the decomposition commit\'s shape), written with the create — a failed link rolls ' +
                    'the card back. A deduped 200 attaches the existing card. Idempotent: a card already ' +
                    'covering the deliverable links nothing new (`result: "already"`). Refused with nothing ' +
                    'created: 404 `deliverable_not_found` (not on this project), 422 `deliverable_not_deferred`, ' +
                    '409 `deliverable_mint_closed` (minted_count reported and that many cards already attached), ' +
                    '409 `card_already_contracted`. The minter reports its total via ' +
                    'POST /api/projects/{id}/deliverables/{did}/minted with `deliverable_link.deliverable_id`. ' +
                    'Absent: unchanged (no `deliverable_link` key in any response).',
                },
                requires_card_ids: {
                  type: 'array',
                  maxItems: 20,
                  items: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[\\x21-\\x7E]{1,200}$' },
                  description:
                    'Card ids this card must wait for (`Relations.requires`). Duplicates are collapsed. ' +
                    'Each must be a card on this project’s board. Both sides are linked (this card’s ' +
                    '`requires`, each dependency’s `required_by`) idempotently; the outcome is reported ' +
                    'as `requires_link`. On a deduped 200 the EXISTING open card is linked; naming that ' +
                    'card itself is a 400 `requires_card_self_reference`, and naming a card whose own `requires` ' +
                    'already contains that card is a 409 `requires_cycle` (one level; nothing written). ' +
                    'Absent: unchanged.',
                },
                plan_pin: {
                  type: 'object',
                  additionalProperties: true,
                  required: ['plan'],
                  properties: {
                    plan: {
                      type: 'object',
                      // OAS 3.0 has no `propertyNames`; the key constraint is documented here
                      // and enforced at runtime by the handler's zod schema.
                      description:
                        'Map keyed by list name. Keys MUST be one of: todo, ready, doing, qa, blocked, done ' +
                        '(lowercase; at least one key). Any other key is a 422 `plan_pin_invalid`.',
                      additionalProperties: {
                        type: 'object',
                        required: ['activity_sequence'],
                        properties: { activity_sequence: { type: 'array', items: { type: 'string' } } },
                      },
                    },
                  },
                  description:
                    'U11. The plan the minter computed for this card, `{plan: {<list>: {activity_sequence: string[]}}, …}`. ' +
                    'On a NEW card only, it is stored INSERT-ONCE in fr (`card_plan_pins`, migration 148; UPDATE/DELETE ' +
                    'refused by a DB trigger) and the card gets the pointer `Metadata.plan_pin = {"store":"fr","sha256":"<hex>"}`, ' +
                    'sha256 computed SERVER-SIDE over the canonical JSON (keys sorted). A dedupe hit / lease loser / suppressed ' +
                    'fingerprint writes neither. If a pin already exists for the new card id the create is refused and rolled ' +
                    'back (the pointer is never rewritten). A rolled-back create KEEPS its pin row (it cannot be deleted). ' +
                    'Over 64 KiB → 422 `plan_pin_too_large`; wrong shape → 422 `plan_pin_invalid`. Absent: unchanged.',
                },
                version_stamp: {
                  type: 'object',
                  additionalProperties: true,
                  description:
                    'C1-46. The card\'s full version stamp. On a NEW card only, it is stored in fr ' +
                    '(`card_version_stamps`, migration 140) and the card gets the pointer ' +
                    '`Metadata.version_stamp = {"store":"fr","sha256":"<hex>"}` (sha256 of the canonical ' +
                    'JSON, keys sorted). A dedupe hit, a create_in_progress loser and a suppressed ' +
                    'fingerprint write neither. A rolled-back create deletes the row. A pointer over 512 ' +
                    'chars is a 422 `version_stamp_pointer_too_long` (guard; not reachable by construction). ' +
                    'GET /api/cards/:id returns the full stamp. Absent: unchanged.',
                },
                priority: {
                  type: 'string',
                  description:
                    'A priority level of the owning tenant (requirements_management `priority-levels`): its id, or its name case-insensitively (e.g. `P1`). Any other value is 400 `invalid_priority` with the tenant levels in `details.allowed`. ' +
                    'B7. Written to `Metadata.priority` on a NEW card, only when supplied (no default). ' +
                    'Same vocabulary as POST /api/cards/improvement. Any other value is a 400 ' +
                    '`validation_failed`, nothing created.',
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description:
            'Nothing created (only when `asset_id` was sent): the fingerprint is suppressed ' +
            '(`suppressed: true`, `card_id: null`), or an OPEN card for it already exists ' +
            '(`deduped: true`, `card_id`), or a concurrent create holds the lease ' +
            '(`deduped: true`, `card_id: null`, `create_in_progress: true`).',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  card_id: { type: 'string', nullable: true },
                  deduped: { type: 'boolean' },
                  suppressed: { type: 'boolean' },
                  create_in_progress: { type: 'boolean' },
                  requires_link: {
                    allOf: [{ $ref: '#/components/schemas/ProjectCardRequiresLink' }],
                    description:
                      'Present only when `requires_card_ids` was sent (not on `suppressed`). With ' +
                      '`create_in_progress` nothing is linked yet: `linked` and `already` are empty.',
                  },
                },
              },
            },
          },
        },
        '201': {
          description: 'Card created and stamped',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  card_id: { type: 'string' },
                  board_id: { type: 'string' },
                  list_id: { type: 'string' },
                  card_type: { type: 'string' },
                  parent_card_id: {
                    type: 'string',
                    nullable: true,
                    description: 'Echo of the request value; null when none was requested.',
                  },
                  parent_link: {
                    type: 'object',
                    nullable: true,
                    description:
                      'What the parent/child link actually did. Null when no parent was requested.',
                    properties: {
                      parent_child_cards: {
                        type: 'string',
                        enum: ['appended', 'already_present'],
                      },
                      child_parent_card: {
                        type: 'string',
                        enum: ['written', 'already_set'],
                      },
                    },
                  },
                  asset_id: {
                    type: 'string',
                    nullable: true,
                    description:
                      'Echo of the request `asset_id` (stamped as `Metadata.asset_id`); null when none was sent.',
                  },
                  requires_link: {
                    allOf: [{ $ref: '#/components/schemas/ProjectCardRequiresLink' }],
                    nullable: true,
                    description: 'What the requires link did. Null when `requires_card_ids` was omitted.',
                  },
                  deliverable_link: {
                    type: 'object',
                    nullable: true,
                    description:
                      'fr#1481 — present only when `deliverable_id` was sent; null when no card was ' +
                      'attached (suppressed / create_in_progress — retry).',
                    properties: {
                      deliverable_id: { type: 'string', format: 'uuid', description: 'The row id (for /minted).' },
                      plan_deliverable_id: { type: 'string', nullable: true },
                      result: { type: 'string', enum: ['attached', 'already'] },
                    },
                  },
                  plan_pin_sha256: {
                    type: 'string',
                    nullable: true,
                    description: 'U11 — sha256 of the stored plan pin (= the Metadata.plan_pin pointer\'s sha256). Null when none was sent.',
                  },
                  version_stamp_sha256: {
                    type: 'string',
                    nullable: true,
                    description:
                      'sha256 of the stored `version_stamp` (= the Metadata.version_stamp pointer\'s sha256). Null when none was sent.',
                  },
                  scenario_evidence_stored: {
                    type: 'integer',
                    description:
                      'fr#1338 — how many gherkin_scenarios entries had their test_file_content stored in fr ' +
                      '(card_scenario_evidence) instead of Planka. 0 when none carried one.',
                  },
                },
              },
            },
          },
        },
        '400': {
          description:
            'Body is not JSON or failed schema validation (`validation_failed`, with `issues`) — ' +
            'including a blank, padded or whitespace-containing `asset_id`, or more than 20 ' +
            '`requires_card_ids` — or the project has no `planka_board_id` so no card can be ' +
            'spawned, or (`requires_card_self_reference`) the deduped open card is itself named ' +
            'in `requires_card_ids`.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '401': {
          description: 'Missing or invalid bearer token',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '403': {
          description:
            '`project_cards_only_on_exec_tenant` — the project is not on the EXEC tenant and the ' +
            'caller is not the trusted cross-tenant service identity.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '404': {
          description:
            'Project not visible under the active tenant (`Project not found`), or no list on the ' +
            'board matches `target_list` (`target_list_not_found`, echoing `list`), or a ' +
            '`requires_card_ids` entry is not a card Planka can find (`requires_card_not_found`, ' +
            'echoing the missing `requires_card_ids`). Nothing is created.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '409': {
          description:
            'The card was created but the parent link was REFUSED (malformed relation field, ' +
            'write conflict, or field capacity). The parent’s existing value is untouched and ' +
            'the caller must not conclude the child is tracked. Body: `error`, `message`, ' +
            '`parent_card_id`, `field`, `details`, `parent_link: "not_made"`, ' +
            '`spawned_card_rolled_back`. The same applies to the requires link: body carries ' +
            '`requires_card_ids`, `requires_link: "not_made"` and, on the create path, ' +
            '`spawned_card_rolled_back` (on a deduped call the existing card is kept, `deduped: true`). ' +
            'On the create path the requires link runs BEFORE the parent link, so a requires failure ' +
            'leaves the parent untouched; any dependency `required_by` this request wrote is stripped ' +
            'again on rollback (`required_by_rolled_back`, plus `dangling_required_by` if that failed). ' +
            '`requires_cycle` (deduped path): a named dependency already requires the deduped card; ' +
            'echoes the cycling `requires_card_ids`, nothing written.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '502': {
          description:
            'Upstream Planka failure: `planka_list_fetch_failed`, `planka_card_create_failed`, ' +
            '`planka_requires_card_fetch_failed`, `planka_requires_link_failed` (deduped path), ' +
            '`requires_link_failed` (create path: Planka failed while linking `requires_card_ids`; ' +
            'carries `requires_link: "not_made"`), or `planka_field_stamp_failed` (the last two also ' +
            'carry `spawned_card_rolled_back`).',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '422': {
          description:
            '`requires_card_not_on_project_board` — a `requires_card_ids` entry is a card on another ' +
            'board (another project or tenant); echoes the offending `requires_card_ids`. Nothing is ' +
            'created. Or `version_stamp_pointer_too_long` — the `Metadata.version_stamp` pointer would ' +
            'exceed 512 chars (a guard; not reachable by construction). Nothing is created or written.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
      },
    },
  },
  {
    id: 'cards.put_finding_suppression', method: 'PUT', path: '/api/findings/suppressions', handler: 'handlePutFindingSuppression', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["findingSuppression.put"],
    source: { module: 'src/routes/findings/suppressions.ts', load: () => import('../../routes/findings/suppressions') },
    frozen: {
      summary: 'Mark a finding fingerprint false-positive for a project',
      description:
        'Records that the finding identified by `fingerprint` (the `asset_id` an analysis card ' +
        'passes to POST /api/cards/project) is a false positive for `project_id`. Idempotent: ' +
        'the first decision wins and is never overwritten; a repeat returns the existing row ' +
        'with `created: false`. Same auth and tenant scope as POST /api/cards/project (project ' +
        'visible under the active tenant; EXEC tenant or the trusted cross-tenant service ' +
        'identity). The ledger is keyed on (project_id, fingerprint), NOT on the caller\'s ' +
        'tenant: a suppression recorded from any permitted tenant view of the project (e.g. the ' +
        'EXEC owner, or the orchestrator acting for the project\'s customer tenant) suppresses ' +
        'for all of them, and a repeat from another permitted caller is `created: false`. ' +
        '`suppression.recorded_tenant_id` is the recording caller\'s active tenant (audit only).',
      tags: ['Cards'],
      operationId: 'putFindingSuppression',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['project_id', 'fingerprint', 'reason'],
              properties: {
                project_id: { type: 'string', format: 'uuid' },
                fingerprint: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 200,
                  pattern: '^[\\x21-\\x7E]{1,200}$',
                  description:
                    'Finding fingerprint: 1..200 printable ASCII characters, no whitespace anywhere ' +
                    '(the conveyor emits `<16 hex>.<ordinal>`); a padded or blank value is a 400. ' +
                    'Same validator as POST /api/cards/project `asset_id`, so every recordable ' +
                    'suppression is matchable.',
                },
                reason: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 2000,
                  pattern: '\\S',
                  description:
                    'Trimmed server-side; must contain at least one non-whitespace character (blank or whitespace-only is a 400).',
                },
                card_id: { type: 'string', minLength: 1, maxLength: 200 },
                category: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 100,
                  description:
                    'Optional finding category, stored trimmed and lower-cased. A security category ' +
                    '(`security`, `sast`, `dast`, `sca`, `iac`, `cve`, or anything containing ' +
                    '`secur`/`vuln`/`secret`/`cve`) requires the project owner or a super_admin (else 403 ' +
                    '`suppression_requires_elevated_rights`).',
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Suppressed (`created` says whether this call wrote the row).',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  suppressed: { type: 'boolean' },
                  created: { type: 'boolean' },
                  suppression: { $ref: '#/components/schemas/FindingSuppression' },
                },
              },
            },
          },
        },
        '400': {
          description:
            'Body is not JSON, or failed schema validation (`validation_failed`, with `issues`) — ' +
            'including a blank, padded or whitespace-containing `fingerprint`.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        '403': {
          description:
            '`project_cards_only_on_exec_tenant`, or `suppression_requires_elevated_rights` (security ' +
            '`category` from a caller who is neither the project owner nor a super_admin).',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        '404': {
          description: 'Project not visible under the active tenant.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },
  },
  {
    id: 'cards.list_finding_suppressions', method: 'GET', path: '/api/findings/suppressions', handler: 'handleListFindingSuppressions', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["findingSuppression.list"],
    source: { module: 'src/routes/findings/suppressions.ts', load: () => import('../../routes/findings/suppressions') },
    frozen: {
      summary: 'List suppressed finding fingerprints for a project',
      description:
        'Every suppression for the project, whichever permitted tenant view recorded it (the ' +
        'ledger is keyed on the project, not the caller\'s tenant). Same auth as the PUT.',
      tags: ['Cards'],
      operationId: 'listFindingSuppressions',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'project_id',
          in: 'query',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Suppressions, newest first.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/FindingSuppression' },
                  },
                  total: { type: 'integer' },
                },
              },
            },
          },
        },
        '400': {
          description: '`project_id` missing or not a uuid.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        '403': {
          description: '`project_cards_only_on_exec_tenant`.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        '404': {
          description: 'Project not visible under the active tenant.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },
  },
  {
    id: 'cards.delete_finding_suppression', method: 'DELETE', path: '/api/findings/suppressions', handler: 'handleDeleteFindingSuppression', effect: 'destructive',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    source: { module: 'src/routes/findings/suppressions.ts', load: () => import('../../routes/findings/suppressions') },
    frozen: {
      summary: 'Remove a finding suppression (un-suppress a fingerprint)',
      description:
        'Deletes the suppression for (`project_id`, `fingerprint`), so POST /api/cards/project ' +
        'may mint that finding again, and records an `unsuppress` event with `reason` in ' +
        'finding_suppression_events. Same auth and tenant scope as the PUT, AND the caller must be ' +
        'the project owner or a super_admin. Not idempotent-silent: deleting an absent ' +
        'suppression (including a second DELETE) is a 404 `suppression_not_found`.',
      tags: ['Cards'],
      operationId: 'deleteFindingSuppression',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['project_id', 'fingerprint', 'reason'],
              properties: {
                project_id: { type: 'string', format: 'uuid' },
                fingerprint: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 200,
                  pattern: '^[\\x21-\\x7E]{1,200}$',
                  description: 'Same validator as the PUT `fingerprint`.',
                },
                reason: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 2000,
                  pattern: '\\S',
                  description:
                    'Why the suppression is withdrawn. Trimmed; blank or whitespace-only is a 400.',
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Removed; `removed` is the deleted ledger row.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  suppressed: { type: 'boolean' },
                  removed: { $ref: '#/components/schemas/FindingSuppression' },
                },
              },
            },
          },
        },
        '400': {
          description: 'Body is not JSON, or failed schema validation (`validation_failed`).',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        '403': {
          description:
            '`project_cards_only_on_exec_tenant`, or `suppression_requires_elevated_rights` (caller ' +
            'is neither the project owner nor a super_admin).',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        '404': {
          description:
            'Project not visible under the active tenant, or `suppression_not_found` (no such ' +
            'suppression — including a repeat DELETE).',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },
  },
  {
    id: 'cards.write_seeker_links', method: 'POST', path: '/api/cards/:cardId/seeker-links', handler: 'handleWriteSeekerLinks', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["cardSeekerLink.write"],
    source: { module: 'src/routes/cards/seeker-links.ts', load: () => import('../../routes/cards/seeker-links') },
    frozen: {
      summary: 'Write KAG seeker links for a card',
      description:
        'Upserts the entity list the KAG Gaps worker computed for a card into `card_seeker_links`; ' +
        'the rows are surfaced by GET /api/cards/{cardId} under `kag_seeker`. Idempotent on ' +
        '(card_id, kag_entity_id) — a retry updates `score` and `created_at` rather than ' +
        'double-inserting. The write is tenant-gated BEFORE the body is read: the card is fetched ' +
        "with the admin Planka agent, its owning tenant resolved from its board, and required to " +
        "equal the caller's active tenant. Fail-closed — a card belonging to a FOREIGN TENANT, a " +
        'board whose tenant cannot be attributed, or a tenant-lookup error all return the SAME 404 ' +
        '`card_not_found` as a genuinely missing card, so a foreign card id leaks nothing. This is ' +
        'stricter than the GET read gate, which deliberately allows cross-tenant reads of shared ' +
        'framework cards. Because the gate runs first, a malformed body on a foreign card yields ' +
        '404, not 400. `written` echoes the number of links SUBMITTED, not the number of rows ' +
        'actually changed; an empty `links` array is accepted and writes nothing.',
      tags: ['Cards'],
      operationId: 'writeCardSeekerLinks',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'cardId',
          in: 'path',
          required: true,
          description: 'Planka card id the links are attached to.',
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['links'],
              properties: {
                links: {
                  type: 'array',
                  maxItems: 500,
                  items: {
                    type: 'object',
                    required: ['kag_entity_id'],
                    properties: {
                      kag_entity_id: { type: 'string', format: 'uuid' },
                      score: {
                        type: 'number',
                        description:
                          'Relevance score. Omitted stores NULL; must be finite when present.',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Links upserted',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  card_id: { type: 'string' },
                  written: {
                    type: 'integer',
                    description: 'Number of links in the request body.',
                  },
                },
              },
            },
          },
        },
        '400': {
          description:
            'Empty path segment (`card_id_required`), unparseable body (`invalid_json`), or ' +
            'schema violation (`validation_failed`, with a `issues` array from zod).',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '401': {
          description: 'Missing or invalid bearer token',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '404': {
          description:
            'Card not found — also returned, deliberately and indistinguishably, for a card owned ' +
            "by another tenant or a board whose tenant cannot be resolved. Body carries " +
            '`error: "card_not_found"` and the requested `card_id`.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '500': {
          description: 'Insert failed (`seeker_links_insert_failed`, with `detail`)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
      },
    },
  },
  {
    id: 'cards.add_scenario_evidence', method: 'POST', path: '/api/cards/:cardId/scenario-evidence', handler: 'handleAddScenarioEvidence', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["cards.addScenarioEvidence"],
    source: { module: 'src/routes/cards/scenario-evidence.ts', load: () => import('../../routes/cards/scenario-evidence') },
    frozen: {
      summary: 'Append repro evidence (gherkin_scenarios entries) to an EXISTING card',
      description:
        'n8n node op `fr:cards.addScenarioEvidence`. Adds bug-path `gherkin_scenarios` entries, each ' +
        'carrying `test_file_content` (≤ 32768 UTF-8 bytes) and `test_file_sha256` (sha256 of those ' +
        'bytes), to a card that already exists. Entries are validated by the SAME strict schema and ' +
        'refusal codes as POST /api/cards/project; every refusal is 400 with `qa_needs_info: ' +
        '"repro_malformed"`. Evidence is stored in fr (`card_scenario_evidence`) and returned by ' +
        'GET /api/cards/{cardId} as `scenario_evidence`; each NEW entry is appended to the card ' +
        "document's `gherkin_scenarios` WITHOUT `test_file_content` and WITH `test_file_sha256` as the " +
        'pointer. WRITE-ONCE per (card, scenario_id): a new entry is `created`; an existing one with ' +
        'the SAME sha256 is `unchanged` (no write, never duplicated on the card); a DIFFERENT sha256 ' +
        'is 409 `scenario_evidence_conflict`, never an overwrite. All or nothing: any refusal or ' +
        "conflict rejects the whole batch with nothing written. The tenant is the authenticated " +
        "principal's (as POST /api/cards/project derives it) — never the body or a header; the body " +
        'is strict, so any key besides `entries` (e.g. a tenant) is refused. Same principals as POST ' +
        '/api/cards/project (EXEC pin → 403 `project_cards_only_on_exec_tenant`). The card must sit on ' +
        "the board of a project visible under the caller's tenant; a foreign or unknown card is 404 " +
        '`card_not_found`, never 403. If the Planka description update fails, ONLY the rows this ' +
        'request created are deleted and the response reports `scenario_evidence_rolled_back`. Appends to ' +
        'one card are serialised by a per-card lease: a contender that cannot take it answers 503 ' +
        '`scenario_evidence_card_busy`, and a holder whose lease expired before its description update ' +
        'answers 503 `scenario_evidence_lease_lost` without writing the card; both are retryable after ' +
        '`retry_after_ms`.',
      tags: ['Cards'],
      operationId: 'addScenarioEvidence',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'cardId',
          in: 'path',
          required: true,
          description: 'Planka card id to append the evidence to.',
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['entries'],
              properties: {
                entries: {
                  type: 'array',
                  minItems: 1,
                  description:
                    'GherkinScenarioEntry objects (strict: an undeclared key is refused). Each MUST carry ' +
                    '`test_file_content` and `test_file_sha256`; duplicate `scenario_id` is refused.',
                  items: {
                    type: 'object',
                    required: ['scenario_id', 'criterion_id', 'test_file_content', 'test_file_sha256'],
                    properties: {
                      scenario_id: { type: 'string', pattern: '^scn_[0-9a-f]{8}$' },
                      criterion_id: { type: 'string', pattern: '^crit_[0-9a-f]{1,64}$' },
                      title: { type: 'string' },
                      gherkin: { type: 'string', nullable: true, maxLength: 20000 },
                      status: { type: 'string' },
                      scenario_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                      failing_test: { type: 'string', maxLength: 1024 },
                      test_path: { type: 'string', maxLength: 1024 },
                      test_file_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                      test_file_content: {
                        type: 'string',
                        description: 'The test file, inline; ≤ 32768 UTF-8 bytes.',
                      },
                      base_sha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
                      expect_red: { type: 'boolean' },
                      runner: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description:
            'Every entry stored or already stored with the same sha256. An `unchanged` entry whose card ' +
            'pointer was MISSING from the card document (a crash between the row commit and the description ' +
            'update) has its pointer re-appended from the stored row and carries `pointer_repaired: true`.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['card_id', 'project_id', 'entries', 'created_count', 'unchanged_count', 'description_updated'],
                properties: {
                  card_id: { type: 'string' },
                  project_id: { type: 'string', format: 'uuid' },
                  entries: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['scenario_id', 'test_file_sha256', 'result'],
                      properties: {
                        scenario_id: { type: 'string' },
                        test_file_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                        result: { type: 'string', enum: ['created', 'unchanged'] },
                        pointer_repaired: {
                          type: 'boolean',
                          enum: [true],
                          description:
                            'Present (always `true`) only on an `unchanged` entry whose missing card pointer this ' +
                            'request re-appended; absent otherwise.',
                        },
                      },
                    },
                  },
                  created_count: { type: 'integer' },
                  unchanged_count: { type: 'integer' },
                  description_updated: {
                    type: 'boolean',
                    description: 'True when the card description was PATCHed (new pointers and/or repaired pointers).',
                  },
                },
              },
            },
          },
        },
        '400': {
          description:
            'Body refused, nothing written: `validation_failed` (not `{entries:[…]}`, or an extra key), ' +
            '`gherkin_scenario_test_file_too_large`, `gherkin_scenario_test_file_sha256_mismatch`, ' +
            '`gherkin_scenario_unknown_key`, `gherkin_scenario_text_not_storable`, ' +
            '`gherkin_scenarios_invalid` (incl. an entry without evidence). All carry ' +
            '`qa_needs_info: "repro_malformed"`. Also `gherkin_scenario_evidence_outside_document` when the ' +
            'Planka write chokepoint refuses the description update; that body additionally carries ' +
            '`card_id` and the rollback fields (`scenario_evidence_rolled_back`, ' +
            '`scenario_evidence_rows_removed`, `scenario_ids`).',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/CodedError' },
                  {
                    type: 'object',
                    required: ['qa_needs_info'],
                    properties: {
                      qa_needs_info: { type: 'string', enum: ['repro_malformed'] },
                      issues: { type: 'array', items: { type: 'object' } },
                      card_id: { type: 'string' },
                      scenario_evidence_rolled_back: { type: 'boolean' },
                      scenario_evidence_rows_removed: { type: 'integer' },
                      scenario_ids: { type: 'array', items: { type: 'string' } },
                    },
                  },
                ],
              },
            },
          },
        },
        '401': {
          description: 'Missing or invalid bearer token',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        '403': {
          description: 'Caller is not on the EXEC tenant nor the trusted cross-tenant service view (`project_cards_only_on_exec_tenant`).',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } },
        },
        '404': {
          description:
            "`card_not_found` — unknown card, a card on another tenant's board, a card on a board that " +
            'is not a project board, or a card that moved to another board between the gate and the ' +
            'per-card lease; indistinguishable by design. Nothing written.',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/CodedError' },
                  { type: 'object', required: ['card_id'], properties: { card_id: { type: 'string' } } },
                ],
              },
            },
          },
        },
        '409': {
          description:
            '`scenario_evidence_conflict` — a scenario_id already holds DIFFERENT evidence (stored row: ' +
            '`where: "card_scenario_evidence"` + `conflicts`; card document entry: `where: "card_document"`). ' +
            'The whole batch is refused; nothing written.',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/CodedError' },
                  {
                    type: 'object',
                    required: ['card_id', 'scenario_ids', 'where'],
                    properties: {
                      card_id: { type: 'string' },
                      scenario_ids: { type: 'array', items: { type: 'string' } },
                      where: { type: 'string', enum: ['card_scenario_evidence', 'card_document'] },
                      conflicts: { type: 'array', items: { type: 'object' } },
                    },
                  },
                ],
              },
            },
          },
        },
        '422': {
          description:
            "`card_document_unparseable` / `card_document_not_appendable` — the card's description " +
            'carries a card document that cannot take the append. Nothing written.',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/CodedError' },
                  { type: 'object', required: ['card_id'], properties: { card_id: { type: 'string' } } },
                ],
              },
            },
          },
        },
        '500': {
          description:
            '`scenario_evidence_description_update_failed` — the description update failed with an ' +
            'unclassified error. The rows this request created are deleted; `scenario_evidence_rolled_back` ' +
            'reports whether that succeeded.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ScenarioEvidenceRollback' } } },
        },
        '502': {
          description:
            'Planka card read (`planka_card_fetch_failed`, body `card_id` + `message`) or description update ' +
            '(`planka_description_update_failed`) failed. On an update failure the rows this request ' +
            'created are deleted; `scenario_evidence_rolled_back` reports whether that succeeded.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ScenarioEvidenceRollback' } } },
        },
        '503': {
          description:
            'RETRYABLE; nothing is on the card. Retry after `retry_after_ms`. ' +
            '`scenario_evidence_card_busy` — another append to this card holds its per-card lease and did ' +
            'not release it within the wait budget; nothing was written. ' +
            "`scenario_evidence_lease_lost` — this request's own lease expired (or had too little time left) " +
            'before the description update, so a second writer may hold it; Planka was NOT written and the ' +
            'rows this request created were deleted (`scenario_evidence_rolled_back` reports whether that ' +
            'succeeded).',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/CodedError' },
                  {
                    type: 'object',
                    required: ['card_id', 'retry_after_ms'],
                    properties: {
                      code: { type: 'string', enum: ['scenario_evidence_card_busy', 'scenario_evidence_lease_lost'] },
                      card_id: { type: 'string' },
                      retry_after_ms: {
                        type: 'integer',
                        minimum: 0,
                        description: 'Milliseconds to wait before retrying the same request.',
                      },
                      scenario_evidence_rolled_back: {
                        type: 'boolean',
                        description: '`scenario_evidence_lease_lost` only.',
                      },
                      scenario_evidence_rows_removed: {
                        type: 'integer',
                        description: '`scenario_evidence_lease_lost` only.',
                      },
                      scenario_ids: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '`scenario_evidence_lease_lost` only: the scenario_ids this request had created.',
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  {
    id: 'cards.freeze_scenarios', method: 'POST', path: '/api/cards/:cardId/scenarios/freeze', handler: 'handleFreezeScenarios', effect: 'write',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["cards.freezeScenarios"],
    source: { module: 'src/routes/cards/scenarios-freeze.ts', load: () => import('../../routes/cards/scenarios-freeze') },
    frozen: {
      summary: "Freeze a card's Gherkin scenario set (server-side compare-and-set, write-once)",
      description:
        'Called by ncn READY (`r.ready.scenarios`). fr recomputes canonical-scenarios-hash v1 over ' +
        '`scenarios` and refuses a body whose `scenario_hash` differs (422 `scenario_hash_mismatch`). ' +
        'WRITE-ONCE per card: the first freeze writes `scenarios_check.scenario_hash` into the card ' +
        'document head (the `readied_brief` region after the head is preserved byte-for-byte) and ' +
        'answers `frozen`; the SAME hash again is 200 `unchanged` with no write; a DIFFERENT hash is ' +
        '409 `scenarios_frozen`, never an overwrite. Entries are validated by the SAME strict ' +
        'GherkinScenarioEntry schema and refusal codes as POST /api/cards/{cardId}/scenario-evidence, ' +
        'except that `test_file_content` is not accepted here. The tenant is the authenticated ' +
        "principal's (as POST /api/cards/project derives it) — never the body or a header; the body " +
        'is strict, so any key besides `scenarios` and `scenario_hash` is refused. Same principals as ' +
        'POST /api/cards/project (EXEC pin → 403 `project_cards_only_on_exec_tenant`). The card must ' +
        "sit on the board of a project visible under the caller's tenant; a foreign or unknown card is " +
        '404 `card_not_found`, never 403. Freezes of one card are serialised by a per-card lease: a ' +
        'contender that cannot take it answers 503 `scenarios_freeze_card_busy`, and a holder whose ' +
        'lease expired before its description update answers 503 `scenarios_freeze_lease_lost` without ' +
        'writing the card; both are retryable after `retry_after_ms`.',
      tags: ['Cards'],
      operationId: 'freezeCardScenarios',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'cardId',
          in: 'path',
          required: true,
          description: 'Planka card id whose scenario set is frozen.',
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['scenarios', 'scenario_hash'],
              properties: {
                scenarios: {
                  type: 'array',
                  minItems: 1,
                  description:
                    'GherkinScenarioEntry objects (strict: an undeclared key is refused; ' +
                    '`test_file_content` is not accepted here); duplicate `scenario_id` is refused.',
                  items: {
                    type: 'object',
                    required: ['scenario_id', 'criterion_id'],
                    properties: {
                      scenario_id: { type: 'string', pattern: '^scn_[0-9a-f]{8}$' },
                      criterion_id: { type: 'string', pattern: '^crit_[0-9a-f]{1,64}$' },
                      title: { type: 'string' },
                      gherkin: { type: 'string', nullable: true, maxLength: 20000 },
                      status: { type: 'string' },
                      scenario_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                      failing_test: { type: 'string', maxLength: 1024 },
                      test_path: { type: 'string', maxLength: 1024 },
                      test_file_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                      base_sha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
                      expect_red: { type: 'boolean' },
                      runner: { type: 'string' },
                    },
                  },
                },
                scenario_hash: {
                  type: 'string',
                  pattern: '^[0-9a-f]{64}$',
                  description: 'canonical-scenarios-hash v1 over `scenarios`, as computed by the caller.',
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description:
            '`frozen` — this request wrote `scenarios_check.scenario_hash` into the card document head; ' +
            '`unchanged` — the card already holds the SAME hash, nothing written.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['card_id', 'project_id', 'result', 'scenario_hash', 'scenario_count', 'description_updated'],
                properties: {
                  card_id: { type: 'string' },
                  project_id: { type: 'string', format: 'uuid' },
                  result: { type: 'string', enum: ['frozen', 'unchanged'] },
                  scenario_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                  scenario_count: { type: 'integer' },
                  description_updated: {
                    type: 'boolean',
                    description: 'True only when the card description was PATCHed (`frozen`).',
                  },
                },
              },
            },
          },
        },
        '400': {
          description:
            'Body refused, nothing written: `validation_failed` (not `{scenarios:[…], scenario_hash}`, or ' +
            'an extra key), `gherkin_scenario_unknown_key` (incl. `test_file_content`, not accepted here), ' +
            '`gherkin_scenario_text_not_storable`, `gherkin_scenarios_invalid`.',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/CodedError' },
                  {
                    type: 'object',
                    properties: {
                      issues: { type: 'array', items: { type: 'object' } },
                    },
                  },
                ],
              },
            },
          },
        },
        '401': {
          description: 'Missing or invalid bearer token',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        '403': {
          description: 'Caller is not on the EXEC tenant nor the trusted cross-tenant service view (`project_cards_only_on_exec_tenant`).',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CodedError' } } },
        },
        '404': {
          description:
            "`card_not_found` — unknown card, a card on another tenant's board, a card on a board that " +
            'is not a project board, or a card that moved to another board between the gate and the ' +
            'per-card lease; indistinguishable by design. Nothing written.',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/CodedError' },
                  { type: 'object', required: ['card_id'], properties: { card_id: { type: 'string' } } },
                ],
              },
            },
          },
        },
        '409': {
          description:
            'Nothing written. `scenarios_frozen` — the card already holds a DIFFERENT scenario hash ' +
            '(`stored_scenario_hash`, `sent_scenario_hash`); never overwritten. `card_not_in_ready` — the ' +
            'card is not in the READY list (`list` names where it is). `scenarios_skeleton_missing` — the ' +
            'card document carries no scenario skeleton to freeze. `scenarios_brief_conflict` — the ' +
            "card's ncn ```readied_brief fence carries its own non-empty `gherkin_scenarios`, or a " +
            '`scenarios_check.scenario_hash` other than the one being frozen; ncn QA reads the brief FIRST, ' +
            'so it would grade a second set / a different hash (`message` says which). Also refused on an ' +
            'idempotent replay: a replay never reports success over a shadowing brief. ' +
            "`scenarios_stored_hash_mismatch` — on a replay (stored hash === sent), the card's stored " +
            'scenario set (missing, empty, or edited outside fr) no longer hashes to its frozen ' +
            '`scenario_hash`; QA would read mismatch.',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/CodedError' },
                  {
                    type: 'object',
                    required: ['card_id'],
                    properties: {
                      code: {
                        type: 'string',
                        enum: [
                          'scenarios_frozen',
                          'card_not_in_ready',
                          'scenarios_skeleton_missing',
                          'scenarios_brief_conflict',
                          'scenarios_stored_hash_mismatch',
                        ],
                      },
                      card_id: { type: 'string' },
                      stored_scenario_hash: {
                        type: 'string',
                        pattern: '^[0-9a-f]{64}$',
                        description: '`scenarios_frozen` only.',
                      },
                      sent_scenario_hash: {
                        type: 'string',
                        pattern: '^[0-9a-f]{64}$',
                        description: '`scenarios_frozen` only.',
                      },
                      list: { type: 'string', description: '`card_not_in_ready` only.' },
                    },
                  },
                ],
              },
            },
          },
        },
        '422': {
          description:
            'Nothing written. `scenario_hash_mismatch` — the recomputed canonical-scenarios-hash v1 ' +
            '(`expected`) differs from the sent `scenario_hash` (`sent`). `scenario_freeze_pairs_differ`, ' +
            '`scenario_freeze_title_changed`, `scenario_freeze_field_changed`, ' +
            '`scenario_freeze_criterion_id_not_canonical` — the sent set does not match the card ' +
            "document's scenario skeleton. `card_document_unparseable` / `card_document_not_appendable` " +
            "— the card's description carries a card document that cannot take the write. " +
            '`card_document_ambiguous` — the description starts with a raw JSON head but a later ```json ' +
            "fence also looks like the card document (ncn reads the head, fr's locator the fence); refused " +
            'rather than freeze the wrong one. Two body shapes: ' +
            'the PRE-I/O refusals — a sent entry whose own `scenario_hash` is not its recomputed hash ' +
            '(`scenario_hash_mismatch` with `issues` + `qa_needs_info`, NO `card_id`), and the whole-set ' +
            'recompute (`scenario_hash_mismatch` with `card_id`, `expected`, `sent`) — and the refusals ' +
            'after the card read, which always carry `card_id` (+ `issues` on a stored-hash recheck).',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/CodedError' },
                  {
                    type: 'object',
                    properties: {
                      code: {
                        type: 'string',
                        enum: [
                          'scenario_hash_mismatch',
                          'scenario_freeze_pairs_differ',
                          'scenario_freeze_title_changed',
                          'scenario_freeze_field_changed',
                          'scenario_freeze_criterion_id_not_canonical',
                          'card_document_unparseable',
                          'card_document_not_appendable',
                          'card_document_ambiguous',
                        ],
                      },
                      card_id: {
                        type: 'string',
                        description: 'Absent ONLY on the pre-I/O per-entry `scenario_hash_mismatch` refusal.',
                      },
                      expected: {
                        type: 'string',
                        pattern: '^[0-9a-f]{64}$',
                        description: '`scenario_hash_mismatch` (whole-set recompute) only.',
                      },
                      sent: {
                        type: 'string',
                        pattern: '^[0-9a-f]{64}$',
                        description: '`scenario_hash_mismatch` (whole-set recompute) only.',
                      },
                      issues: { type: 'array', items: { type: 'object' } },
                      qa_needs_info: {
                        type: 'string',
                        enum: ['repro_malformed'],
                        description: 'Pre-I/O per-entry refusal only.',
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        '502': {
          description:
            'Planka card read (`planka_card_fetch_failed`), list read (`planka_list_fetch_failed`) or ' +
            'description update (`planka_description_update_failed`) failed. Body carries `card_id` + ' +
            '`message`.',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/CodedError' },
                  {
                    type: 'object',
                    required: ['card_id'],
                    properties: {
                      code: {
                        type: 'string',
                        enum: [
                          'planka_card_fetch_failed',
                          'planka_list_fetch_failed',
                          'planka_description_update_failed',
                        ],
                      },
                      card_id: { type: 'string' },
                      message: { type: 'string' },
                    },
                  },
                ],
              },
            },
          },
        },
        '500': {
          description:
            '`scenarios_freeze_description_update_failed` — the description update failed with an ' +
            'unexpected (non-Planka, non-coded) error; reported, no `message`. Whether Planka applied the ' +
            'write is unknown: re-read the card before retrying.',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/CodedError' },
                  {
                    type: 'object',
                    required: ['card_id'],
                    properties: {
                      code: { type: 'string', enum: ['scenarios_freeze_description_update_failed'] },
                      card_id: { type: 'string' },
                    },
                  },
                ],
              },
            },
          },
        },
        '503': {
          description:
            'RETRYABLE; nothing is on the card. Retry after `retry_after_ms`. ' +
            '`scenarios_freeze_card_busy` — another freeze of this card holds its per-card lease and did ' +
            'not release it within the wait budget; nothing was written. ' +
            "`scenarios_freeze_lease_lost` — this request's own lease expired (or had too little time " +
            'left) before the description update, so a second writer may hold it; Planka was NOT written.',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/CodedError' },
                  {
                    type: 'object',
                    required: ['card_id', 'retry_after_ms'],
                    properties: {
                      code: { type: 'string', enum: ['scenarios_freeze_card_busy', 'scenarios_freeze_lease_lost'] },
                      card_id: { type: 'string' },
                      retry_after_ms: {
                        type: 'integer',
                        minimum: 0,
                        description: 'Milliseconds to wait before retrying the same request.',
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  {
    id: 'cards.get', method: 'GET', path: '/api/cards/:cardId', handler: 'handleGetCard', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    licenceOps: ["cards.getCard","cards.getScenarioEvidence"],
    source: { module: 'src/routes/cards/get.ts', load: () => import('../../routes/cards/get') },
    frozen: {
      summary: 'Get an AA card, whole',
      description:
        'The Planka card plus its AA custom-field groups normalised into one shape (routes/cards/get.ts ' +
        'handleGetCard): list_name (the phase), groups, tasks, decisions (Planka decision slots + approval ' +
        'outcomes), open_approvals, phase_journey, tenant/is_system, kag_seeker, version_stamp, ' +
        'scenario_evidence and related_titles. Tenant-gated: a card owned by another regular tenant is a 404 ' +
        'identical to a missing card; internal/system cards are readable across tenants. A null ' +
        '`open_approvals`, `kag_seeker`, `phase_journey`, `version_stamp` or `scenario_evidence` means that read ' +
        'FAILED (never "none"); `decisions_available: false` means the approvals half of `decisions` could not ' +
        'be read. related_titles is best-effort: an id absent there is an unknown title, not a missing card.',
      tags: ['Cards'],
      operationId: 'getCard',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'cardId', in: 'path', required: true, description: 'Planka card id', schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'The card',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string', nullable: true },
                  list_id: { type: 'string' },
                  list_name: { type: 'string', nullable: true },
                  board_id: { type: 'string' },
                  type: { type: 'string', nullable: true },
                  position: { type: 'number', nullable: true },
                  due_date: { type: 'string', nullable: true },
                  is_closed: { type: 'boolean' },
                  created_at: { type: 'string', nullable: true },
                  updated_at: { type: 'string', nullable: true },
                  tenant: { type: 'string', nullable: true },
                  is_system: { type: 'boolean' },
                  tenant_is_platform: { type: 'boolean' },
                  groups: {
                    type: 'object',
                    additionalProperties: { type: 'object', additionalProperties: { type: 'string' } },
                  },
                  tasks: { type: 'array', items: { type: 'object' } },
                  decisions: { type: 'array', items: { type: 'object' } },
                  decisions_available: { type: 'boolean' },
                  kag_seeker: { type: 'array', nullable: true, items: { type: 'object' } },
                  open_approvals: { type: 'array', nullable: true, items: { type: 'object' } },
                  phase_journey: { type: 'array', nullable: true, items: { type: 'object' } },
                  phase_journey_complete: { type: 'boolean' },
                  phase_journey_oldest_at: { type: 'string', nullable: true },
                  version_stamp: { type: 'object', nullable: true },
                  version_stamp_available: { type: 'boolean' },
                  scenario_evidence: { type: 'object', nullable: true },
                  scenario_evidence_available: { type: 'boolean' },
                  related_titles: { type: 'object', additionalProperties: { type: 'string' } },
                },
              },
            },
          },
        },
        '401': { description: 'Missing or invalid bearer token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Card not found, or owned by another regular tenant (card_not_found), or its board is gone (board_not_found)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    id: 'cards.get_repository', method: 'GET', path: '/api/cards/:cardId/repository', handler: 'handleGetCardRepository', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    source: { module: 'src/routes/cards/repository.ts', load: () => import('../../routes/cards/repository') },
    frozen: {
      summary: 'Resolve which repository a card\'s work belongs to',
      description:
        'Walks the card, then its `Relations.parent_card` ancestry, taking the FIRST of ' +
        '`Metadata.project_id` (card-scoped assertion) or the card\'s board via ' +
        '`projects.planka_board_id` (board-scoped assertion) at each hop. ' +
        '**Opt-in, and deliberately NOT a field on GET /api/cards/{cardId}**: the answer costs one ' +
        'card read per ancestry hop (median depth ~13, max 27 measured) plus a board-metadata read ' +
        'per board crossed, and putting an unbounded board read on the page-load path is what ' +
        'OOMKilled fr-backend on 2026-09-09. The conveyor asks for this when it is about to ' +
        'dispatch; the page never does.\n\n' +
        '⭐ **"This card cannot resolve a repository" is a 200, not a 4xx.** It is a COMPUTED ' +
        'ANSWER carrying `resolved: false`, a named `reason` and NO `repository_url` key at all, so ' +
        'a consumer cannot read a blank and render it as an answer. Reserving a 4xx for it would ' +
        'put a real result in the same bucket as an auth refusal, which is how an honest "no" gets ' +
        'retried as a fault.\n\n' +
        '⚠️ `resolved: true` with `derived: true` means the answer came from an ANCESTOR — an ' +
        'inference from workflow lineage, not something written down about this card. A consumer ' +
        'that will provision a container or push a commit should decide explicitly whether it acts ' +
        'on a derived pairing (fr#1138: of 661 derivable cards only ~35 are code work).',
      tags: ['Cards'],
      operationId: 'getCardRepository',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'cardId',
          in: 'path',
          required: true,
          description: 'Planka card id the walk starts at (`hop` 0 of the trail).',
          schema: { type: 'string' },
        },
      ],
      responses: {
        '200': {
          description: 'The resolution — `resolved: true` or `resolved: false` with a reason',
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['data'],
            properties: { data: { oneOf: [
              {
                title: 'Resolved',
                type: 'object',
                required: ['card_id', 'resolved', 'via', 'derived', 'hops', 'project', 'repository_url', 'branch', 'trail'],
                properties: {
                  card_id: { type: 'string' },
                  resolved: { type: 'boolean', enum: [true] },
                  via: { type: 'string', enum: ['card_project_id', 'card_board', 'ancestor_project_id', 'ancestor_board'] },
                  derived: { type: 'boolean', description: 'TRUE when the answer came from an ancestor, i.e. an inference.' },
                  hops: { type: 'integer', description: 'Parent edges traversed. 0 = the card itself.' },
                  project: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', format: 'uuid' },
                      name: { type: 'string' },
                      status: { type: 'string' },
                      planka_board_id: { type: 'string', nullable: true },
                      repository_provisioned: { type: 'boolean' },
                      container_name: { type: 'string', nullable: true },
                    },
                  },
                  repository_url: { type: 'string' },
                  branch: { type: 'string' },
                  trail: { type: 'array', items: {
                    type: 'object',
                    properties: {
                      hop: { type: 'integer' },
                      card_id: { type: 'string' },
                      board_id: { type: 'string' },
                    },
                  } },
                },
              },
              {
                title: 'Unresolved',
                type: 'object',
                required: ['card_id', 'resolved', 'reason', 'detail', 'hops_walked', 'trail'],
                properties: {
                  card_id: { type: 'string' },
                  resolved: { type: 'boolean', enum: [false] },
                  reason: { type: 'string', enum: [
                    'card_not_found',
                    'no_project_in_ancestry',
                    'ancestry_parent_missing',
                    'ancestry_cycle',
                    'ancestry_depth_exceeded',
                    'project_id_orphan',
                    'project_archived',
                    'ancestry_tenant_boundary',
                    'project_has_no_repository',
                  ] },
                  detail: { type: 'string', description: 'One sentence a human can act on. Never "unknown", never empty.' },
                  hops_walked: { type: 'integer' },
                  trail: { type: 'array', items: { type: 'object' } },
                  stopped_at_card_id: { type: 'string', description: 'Present when the reason names a card.' },
                  project_id: { type: 'string', description: 'Present for `project_id_orphan` / `project_archived` / `project_has_no_repository`.' },
                  project_name: { type: 'string', description: 'Present for `project_archived` / `project_has_no_repository`.' },
                },
              },
            ] } },
          } } },
        },
        '401': { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Card not found — a genuinely missing card AND a card the caller\'s tenant does not own collapse to the same shape on purpose, so a foreign card id cannot be probed for existence', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  },
  {
    id: 'cards.get_plan_pin', method: 'GET', path: '/api/cards/:cardId/plan-pin', handler: 'handleGetCardPlanPin', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    source: { module: 'src/routes/cards/plan-pin.ts', load: () => import('../../routes/cards/plan-pin') },
    frozen: {
      summary: 'The plan pinned on a card at mint (U11)',
      description:
        'Reads `card_plan_pins` (migration 148) for the card UNDER THE ACTIVE TENANT. The query is ' +
        'tenant-predicated, so a card pinned under another tenant is a 404 exactly like an unpinned card ' +
        '(never a 403). `pointer` is the `Metadata.plan_pin` value the row backs.',
      tags: ['Cards'],
      operationId: 'getCardPlanPin',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'cardId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': {
          description: 'The pin',
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['data'],
            properties: { data: {
              type: 'object',
              required: ['card_id', 'plan_sha256', 'plan', 'created_at', 'pointer'],
              properties: {
                card_id: { type: 'string' },
                plan_sha256: { type: 'string' },
                plan: { type: 'object', additionalProperties: true },
                created_at: { type: 'string', format: 'date-time' },
                pointer: { type: 'object', properties: { store: { type: 'string', enum: ['fr'] }, sha256: { type: 'string' } } },
              },
            } },
          } } },
        },
        '401': { description: 'Unauthenticated' },
        '404': { description: 'No pin for this card under the active tenant (absent or foreign)' },
      },
    },
  },
  {
    id: 'cards.get_plan_conformance', method: 'GET', path: '/api/cards/:cardId/plan-conformance', handler: 'handleGetCardPlanConformance', effect: 'read',
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
    source: { module: 'src/routes/cards/plan-pin.ts', load: () => import('../../routes/cards/plan-pin') },
    frozen: {
      summary: 'Does what ran on this card conform to the plan pinned at mint? (U11 / D2)',
      description:
        'A pure computation over `card_plan_pins`, `card_plan_events` and `card_executed_activities`, all ' +
        'read under the active tenant. No pin ⇒ `unproven` (never a pass). An executed activity whose name is ' +
        'not in the effective plan\'s `plan[list].activity_sequence` is a deviation (membership, not order). The ' +
        'effective plan is the pin until a plan event EXCUSING_PLAN_EVENTS admits — `rule` split at ' +
        'ready/qa/blocked or `rule` reclassify at qa/blocked — replaces it with its sha-verified `detail.new_plan` ' +
        'for activities recorded strictly after it. All ordering uses the server-stamped `recorded_at` (then ' +
        'numeric id), never the caller\'s `at`. An admitted event re-plans nothing and is itself a deviation ' +
        'when its plan is unverifiable (`excuse_without_verifiable_plan`), its `prev_plan_sha` is not the plan ' +
        'in force (`excuse_prev_plan_mismatch`), or its list contradicts the recorded activity log — a `ready` ' +
        'event after doing/qa/done activity, a `qa`/`blocked` event with no prior doing activity ' +
        '(`excuse_list_inconsistent`); any event recorded before the pin is `event_before_pin`. Every other event (llm, a split from doing, …) is listed ' +
        'with `excuses: false`. Any deviation ⇒ `deviates`; a pin with zero executed activities ⇒ `unproven` ' +
        '(`unproven_reason: no_executed_activities`); otherwise `conforms`.',
      tags: ['Cards'],
      operationId: 'getCardPlanConformance',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'cardId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': {
          description: 'The conformance verdict and the rows it was computed from',
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['data'],
            properties: { data: {
              type: 'object',
              required: ['card_id', 'status', 'unproven_reason', 'pinned', 'executed', 'deviations', 'excused_by_events'],
              properties: {
                card_id: { type: 'string' },
                status: { type: 'string', enum: ['conforms', 'deviates', 'unproven'] },
                unproven_reason: { type: 'string', nullable: true, enum: ['no_pin', 'no_executed_activities', null] },
                pinned: { type: 'object', nullable: true, additionalProperties: true },
                executed: { type: 'array', items: { type: 'object', additionalProperties: true } },
                deviations: { type: 'array', items: { type: 'object', additionalProperties: true } },
                excused_by_events: { type: 'array', items: { type: 'object', additionalProperties: true } },
              },
            } },
          } } },
        },
        '401': { description: 'Unauthenticated' },
      },
    },
  },
];

export const CARD_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = frozenRouteCapabilities({ area: 'cards', tenancy: 'tenant', module: 'src/routes/cards/project.ts', load: () => import('../../routes/cards/project') }, CARD_ROUTES);
