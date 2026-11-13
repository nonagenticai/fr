// fr-agui SPEC §13 P4d-2c — spec drain: the asset-authoring publish dispatcher
// (routes/asset-authoring/publish.ts), re-expressed with NO behaviour change (`legacyHandler`).
// The operation the openapi.ts literal served is FROZEN (capabilities/frozen-routes.ts).
// (Moved out of capabilities/library/streams.ts when the v3 improvement-stream registry was
// deleted, 2026-11-03.)
//
// Gate: validateAuth, then a workspace-admin of the active tenant (403
// 'workspace-admin role required'), then the card-owner check — the literal's description says
// so; its responses declare no 403 (a frozen gap, P4-carry "From P4d-2c").
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import type { Capability } from '../define';
import { frozenRouteCapabilities, type FrozenRoute } from '../frozen-routes';
import { isAuthenticatedUser } from '../rbac-rules';
import { routeRule } from '../account/_shared';

const authenticated = routeRule(isAuthenticatedUser);

const ASSET_AUTHORING_ROUTES: FrozenRoute[] = [
  {
    area: 'asset_authoring', id: 'asset_authoring.publish', method: 'POST', path: '/api/asset-authoring/publish', handler: 'handlePublishAsset', effect: 'write',
    rule: authenticated,
    licenceOps: ['assetAuthoring.publish'],
    source: { module: 'src/routes/asset-authoring/publish.ts', load: () => import('../../routes/asset-authoring/publish') },
    frozen: {
      summary: 'Publish an authored principle, requirement or decision',
      description:
        'Takes the `card_type`-tagged envelope emitted by the asset-authoring LLM workers, ' +
        'validates `payload` against the matching patch schema, and dispatches to the upstream ' +
        'asset service. The three plain `*_development` types CREATE a new asset and answer 201; ' +
        'the three `change_*_development` types UPDATE the asset named by `asset_id` and answer ' +
        '200 with `updated: true`. ⚠️ `asset_id` is REQUIRED for the three `change_*` types and ' +
        'ignored for the other three — OpenAPI 3.0 cannot express that conditional, so it is ' +
        'stated here: a `change_*` request without `asset_id` returns 400 `asset_id_required`. ' +
        'Envelope-level parse failure (unknown `card_type`, missing `payload`) returns 400 ' +
        '`unknown_asset_card_type`; a payload that fails its patch schema returns 400 ' +
        '`validation_failed` with the zod `issues`. `card_id` is passed through to the response ' +
        'unchanged and echoes back as null when omitted. Every `card_type` requires the caller ' +
        'to be a workspace admin of the active tenant (403 `workspace-admin role required`), and ' +
        'a `card_id` whose board is owned by a customer tenant or cannot be resolved is refused ' +
        '403 `asset_authoring_customer_card_refused` / `asset_authoring_card_unresolved`, both ' +
        'before any upstream call.',
      tags: ['Streams'],
      operationId: 'publishAuthoredAsset',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['card_type', 'payload'],
              properties: {
                card_type: {
                  type: 'string',
                  enum: [
                    'principle_development',
                    'requirement_development',
                    'decision_development',
                    'change_principle_development',
                    'change_requirement_development',
                    'change_decision_development',
                  ],
                },
                payload: {
                  type: 'object',
                  additionalProperties: true,
                  description:
                    'The authored asset body. Its shape is decided by `card_type` and validated ' +
                    'against PrinciplePatch / RequirementPatch / DecisionPatch in ' +
                    'backend/src/services/asset-authoring/output-schemas.ts — the change_* types ' +
                    'use the same three schemas as their create counterparts.',
                },
                card_id: {
                  type: 'string',
                  description:
                    'Originating card id. Not validated or resolved; echoed back on the response.',
                },
                asset_id: {
                  type: 'string',
                  description:
                    'Target asset to revise. REQUIRED for the three change_*_development types; ' +
                    'unused by the create types.',
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description:
            'Existing asset updated — the `change_*_development` path only.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  asset_kind: {
                    type: 'string',
                    enum: ['principle', 'requirement', 'decision'],
                  },
                  id: { type: 'string' },
                  card_id: { type: 'string', nullable: true },
                  updated: { type: 'boolean', enum: [true] },
                },
              },
            },
          },
        },
        '201': {
          description:
            'New asset created — the plain `*_development` path only. No `updated` field.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  asset_kind: {
                    type: 'string',
                    enum: ['principle', 'requirement', 'decision'],
                  },
                  id: { type: 'string' },
                  card_id: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        '400': {
          description:
            'Envelope rejected (`unknown_asset_card_type`), a `change_*` request without an ' +
            '`asset_id` (`asset_id_required`), or a payload that failed its patch schema ' +
            '(`validation_failed`, with `issues`).',
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
        // P4d-2e (P4d-2c carry): the two 403s the description above names, declared.
        '403': {
          description:
            "`error` 'workspace-admin role required' (every card_type: the caller is not a workspace admin of the active " +
            "tenant), or `code` 'asset_authoring_customer_card_refused' / 'asset_authoring_card_unresolved' (a `card_id` " +
            'whose board a customer tenant owns, or that cannot be resolved). Both before any upstream call.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '500': {
          description: 'Upstream asset-service create/update failed',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
      },
    },
  },
];

export const ASSET_AUTHORING_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = frozenRouteCapabilities(
  {
    area: 'asset_authoring', tenancy: 'tenant',
    module: 'src/routes/asset-authoring/publish.ts', load: () => import('../../routes/asset-authoring/publish'),
  },
  ASSET_AUTHORING_ROUTES,
);
