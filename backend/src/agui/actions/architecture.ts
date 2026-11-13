/**
 * AG-UI agent-callable read actions for the `architecture` (ArchiMate) upstream.
 * Same shape as `actions/principles.ts` — see that file for design notes.
 *
 * Only the READ surface of `integrations/architecture.ts` is wrapped here; the
 * create / update / delete verbs in that module are deliberately NOT registered
 * (this catalog is `kind: 'read'` only).
 *
 * Tenant scope: identical to principles — `integrations/architecture.ts` goes
 * through the shared `createHttpClient` factory, which injects `X-Tenant-Id` /
 * `X-User-Id` from the request context, and the upstream scopes by `tenant_id`.
 * No handler here widens that scope or forwards a caller-supplied tenant.
 */

import { z } from 'zod';

import { registerAction } from '../registry';
import type { AgentCallableAction } from '../types';
import {
  getArchitectureElement,
  listArchitectureRelationships,
  getArchitectureRelationship,
  getArchitectureEntityGraph,
  getArchitectureView,
  getArchitectureStandard,
  rmCall,
} from '../../integrations/architecture';
import {
  getListArchitectureElementsUrl,
  getListArchitectureStandardsUrl,
  getListArchitectureViewsUrl,
  type ArchitectureElementOut,
  type ArchitectureViewOut,
  type StandardOut,
} from '@fr/service-client-requirements';

/**
 * The generated list URL builders forward a plain `Record<string, string>`
 * verbatim through `URLSearchParams`, so numeric / boolean
 * filters are stringified here and the upstream validates them. Undefined
 * keys are dropped so an all-empty input yields the bare path.
 */
function toParams(
  input: Record<string, string | number | boolean | undefined>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) out[k] = String(v);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

// --- Elements -------------------------------------------------------------

const listElementsInputSchema = z.object({
  layer: z.string().optional(),
  element_type: z.string().optional(),
  status: z.string().optional(),
  architecture_state: z.string().optional(),
  project_id: z.string().optional(),
  synthetic: z.boolean().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});
type ListElementsInput = z.infer<typeof listElementsInputSchema>;
const listElementsOutputSchema = z.object({ items: z.array(z.unknown()) });

const listElementsAction: AgentCallableAction<
  ListElementsInput,
  z.infer<typeof listElementsOutputSchema>
> = {
  name: 'architecture.list_elements',
  kind: 'read',
  description:
    'List ArchiMate architecture elements visible to the caller. Optional filters: layer, element_type, status, architecture_state, project_id, synthetic, limit, offset.',
  input: listElementsInputSchema,
  output: listElementsOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) =>
    `architecture.list_elements:${i.layer ?? ''}:${i.element_type ?? ''}:${i.status ?? ''}:${i.architecture_state ?? ''}:${i.project_id ?? ''}:${i.synthetic ?? ''}:${i.limit ?? ''}:${i.offset ?? ''}`,
  handler: async (input) => {
    const items = (await rmCall<ArchitectureElementOut[]>(getListArchitectureElementsUrl(toParams(input)))).data;
    return { items };
  },
};

const getElementInputSchema = z.object({ eid: z.string().min(1) });
type GetElementInput = z.infer<typeof getElementInputSchema>;
const getElementOutputSchema = z.object({ item: z.unknown() });

const getElementAction: AgentCallableAction<
  GetElementInput,
  z.infer<typeof getElementOutputSchema>
> = {
  name: 'architecture.get_element',
  kind: 'read',
  description: 'Fetch a single ArchiMate architecture element by id.',
  input: getElementInputSchema,
  output: getElementOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `architecture.get_element:${i.eid}`,
  handler: async (input) => {
    const item = await getArchitectureElement(input.eid);
    return { item };
  },
};

// --- Relationships --------------------------------------------------------

const listRelationshipsInputSchema = z.object({
  source_entity_type: z.string().optional(),
  source_id: z.string().optional(),
  target_entity_type: z.string().optional(),
  target_id: z.string().optional(),
  relationship_type: z.string().optional(),
  project_id: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});
type ListRelationshipsInput = z.infer<typeof listRelationshipsInputSchema>;
const listRelationshipsOutputSchema = z.object({ items: z.array(z.unknown()) });

const listRelationshipsAction: AgentCallableAction<
  ListRelationshipsInput,
  z.infer<typeof listRelationshipsOutputSchema>
> = {
  name: 'architecture.list_relationships',
  kind: 'read',
  description:
    'List architecture relationships. Optional filters: source_entity_type, source_id, target_entity_type, target_id, relationship_type, project_id, limit, offset.',
  input: listRelationshipsInputSchema,
  output: listRelationshipsOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) =>
    `architecture.list_relationships:${i.source_entity_type ?? ''}:${i.source_id ?? ''}:${i.target_entity_type ?? ''}:${i.target_id ?? ''}:${i.relationship_type ?? ''}:${i.project_id ?? ''}:${i.limit ?? ''}:${i.offset ?? ''}`,
  handler: async (input) => {
    const items = await listArchitectureRelationships(toParams(input));
    return { items };
  },
};

const getRelationshipInputSchema = z.object({ rid: z.string().min(1) });
type GetRelationshipInput = z.infer<typeof getRelationshipInputSchema>;
const getRelationshipOutputSchema = z.object({ item: z.unknown() });

const getRelationshipAction: AgentCallableAction<
  GetRelationshipInput,
  z.infer<typeof getRelationshipOutputSchema>
> = {
  name: 'architecture.get_relationship',
  kind: 'read',
  description: 'Fetch a single architecture relationship by id.',
  input: getRelationshipInputSchema,
  output: getRelationshipOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `architecture.get_relationship:${i.rid}`,
  handler: async (input) => {
    const item = await getArchitectureRelationship(input.rid);
    return { item };
  },
};

// --- Entity graph (traceability) ------------------------------------------

// ⛔ fr#1383. `entity_id` was `z.string().min(1)`, but the upstream route
// (requirements_management `GET /architecture/relationships/graph/{entity_type}/{entity_id}`)
// declares `entity_id: UUID`. The agent passed the element's SLUG
// (`data-validation-service`), the upstream answered 422, and the agent saw
// only the client-safe "The request was rejected" — no hint of what to change,
// so it retried the identical call. Validating the UUID HERE turns that into
// an fr-authored validation error that names the field and the fix. This does
// not widen access: the upstream still scopes by the caller's tenant.
const entityGraphInputSchema = z.object({
  entity_type: z
    .string()
    .min(1)
    .describe(
      "Upstream table name of the entity, e.g. 'architecture_elements', 'requirements', 'decisions', 'principles'.",
    ),
  entity_id: z
    .string()
    .uuid({
      message:
        'entity_id must be the entity UUID (its `id`), not a slug or a name — look the entity up first to get its id',
    })
    .describe('UUID of the entity (its `id`). A slug or name is rejected.'),
});
type EntityGraphInput = z.infer<typeof entityGraphInputSchema>;
const entityGraphOutputSchema = z.object({ relationships: z.array(z.unknown()) });

const getEntityGraphAction: AgentCallableAction<
  EntityGraphInput,
  z.infer<typeof entityGraphOutputSchema>
> = {
  name: 'architecture.get_entity_graph',
  kind: 'read',
  description:
    "One-hop neighbourhood for any 5D entity: every relationship where the (entity_type, entity_id) pair appears as source OR target. `entity_type` is the upstream table name ('architecture_elements', 'requirements', 'decisions', 'principles', 'pm_*').",
  input: entityGraphInputSchema,
  output: entityGraphOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `architecture.get_entity_graph:${i.entity_type}:${i.entity_id}`,
  handler: async (input) => {
    const relationships = await getArchitectureEntityGraph(
      input.entity_type,
      input.entity_id,
    );
    return { relationships };
  },
};

// --- Views ----------------------------------------------------------------

const listViewsInputSchema = z.object({
  viewpoint: z.string().optional(),
  project_id: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});
type ListViewsInput = z.infer<typeof listViewsInputSchema>;
const listViewsOutputSchema = z.object({ items: z.array(z.unknown()) });

const listViewsAction: AgentCallableAction<
  ListViewsInput,
  z.infer<typeof listViewsOutputSchema>
> = {
  name: 'architecture.list_views',
  kind: 'read',
  description:
    'List architecture views. Optional filters: viewpoint, project_id, limit, offset.',
  input: listViewsInputSchema,
  output: listViewsOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) =>
    `architecture.list_views:${i.viewpoint ?? ''}:${i.project_id ?? ''}:${i.limit ?? ''}:${i.offset ?? ''}`,
  handler: async (input) => {
    const items = (await rmCall<ArchitectureViewOut[]>(getListArchitectureViewsUrl(toParams(input)))).data;
    return { items };
  },
};

const getViewInputSchema = z.object({ vid: z.string().min(1) });
type GetViewInput = z.infer<typeof getViewInputSchema>;
const getViewOutputSchema = z.object({ item: z.unknown() });

const getViewAction: AgentCallableAction<
  GetViewInput,
  z.infer<typeof getViewOutputSchema>
> = {
  name: 'architecture.get_view',
  kind: 'read',
  description: 'Fetch a single architecture view by id.',
  input: getViewInputSchema,
  output: getViewOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `architecture.get_view:${i.vid}`,
  handler: async (input) => {
    const item = await getArchitectureView(input.vid);
    return { item };
  },
};

// --- Standards ------------------------------------------------------------

const listStandardsInputSchema = z.object({
  standard_type: z.string().optional(),
  status: z.string().optional(),
  compliance_level: z.string().optional(),
  project_id: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});
type ListStandardsInput = z.infer<typeof listStandardsInputSchema>;
const listStandardsOutputSchema = z.object({ items: z.array(z.unknown()) });

const listStandardsAction: AgentCallableAction<
  ListStandardsInput,
  z.infer<typeof listStandardsOutputSchema>
> = {
  name: 'architecture.list_standards',
  kind: 'read',
  description:
    'List architecture standards. Optional filters: standard_type, status, compliance_level, project_id, limit, offset.',
  input: listStandardsInputSchema,
  output: listStandardsOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) =>
    `architecture.list_standards:${i.standard_type ?? ''}:${i.status ?? ''}:${i.compliance_level ?? ''}:${i.project_id ?? ''}:${i.limit ?? ''}:${i.offset ?? ''}`,
  handler: async (input) => {
    const items = (await rmCall<StandardOut[]>(getListArchitectureStandardsUrl(toParams(input)))).data;
    return { items };
  },
};

const getStandardInputSchema = z.object({ sid: z.string().min(1) });
type GetStandardInput = z.infer<typeof getStandardInputSchema>;
const getStandardOutputSchema = z.object({ item: z.unknown() });

const getStandardAction: AgentCallableAction<
  GetStandardInput,
  z.infer<typeof getStandardOutputSchema>
> = {
  name: 'architecture.get_standard',
  kind: 'read',
  description: 'Fetch a single architecture standard by id.',
  input: getStandardInputSchema,
  output: getStandardOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `architecture.get_standard:${i.sid}`,
  handler: async (input) => {
    const item = await getArchitectureStandard(input.sid);
    return { item };
  },
};

function safeRegister<I, O>(action: AgentCallableAction<I, O>): void {
  try {
    registerAction(action);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') {
      return;
    }
    throw err;
  }
}

export function registerArchitectureActions(): void {
  safeRegister(listElementsAction);
  safeRegister(getElementAction);
  safeRegister(listRelationshipsAction);
  safeRegister(getRelationshipAction);
  safeRegister(getEntityGraphAction);
  safeRegister(listViewsAction);
  safeRegister(getViewAction);
  safeRegister(listStandardsAction);
  safeRegister(getStandardAction);
}
