/**
 * The project agent's ArchiMate MODEL CONTENTS actions — what the model page's
 * contents panel (ArchimateModelContents) does, as agent tools: add an element,
 * a relationship or a view to an ArchiMate model of this project, place an
 * element on a view as a shape, draw a relationship on it as a line, and delete
 * each of these. Plus the metamodel reads the panel's pickers are fed from.
 *
 * Same contract as agui/actions/architecture-modeling.ts and architecture-uml.ts,
 * whose helpers this module reuses:
 *   - reads call requirements_management directly (the metamodel is reference
 *     data; a view's shapes and lines are checked against the bound project by
 *     agent/project-asset-guard.ts);
 *   - writes are PROPOSED as confirm cards and run on the human's Confirm through
 *     the pages' own routes as the human (`callRouteAsHuman`), BOUND to this
 *     project: a create names a model of THIS project, and a write on an existing
 *     row is refused unless its model is this project's (`model_not_in_project`);
 *   - the element's LAYER follows from its type in RM's metamodel (never chosen);
 *     a relationship the metamodel does not allow is RM's 422 `model_integrity`,
 *     relayed with its findings;
 *   - deleting an element, a relationship or a view is DESTRUCTIVE (an element
 *     takes its relationships and shapes with it): a typed card where the human
 *     types its name (`confirm_name`; a relationship: its type), re-checked here.
 *     Removing one shape or line from a view is a plain confirm card.
 *   - RM takes NO Idempotency-Key on a view's shapes and lines, so none is sent:
 *     each add re-reads the view and refuses an element / relationship already
 *     on it (`already_on_view`), which makes a retry after an unknown outcome safe.
 */
import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { AppError } from '../../utils/errors';
import { callRouteAsHuman, lazyRoute } from './project-core';
import { MODEL_NOT_IN_PROJECT, TYPED_CONFIRMATION_MISMATCH, dataOf, idempotencyKey, invokeCard, keyOf, modelInProject, projectId, read, write } from './architecture-modeling';
import { rmCall, seg } from '../../integrations/architecture';
import {
  getListArchimateConceptsUrl,
  getListArchitectureViewConnectionsUrl,
  getListArchitectureViewObjectsUrl,
  getQueryArchimateRelationshipMatrixUrl,
  type ArchimateConceptsOut,
  type RelationshipMatrixCell,
  type ViewConnectionOut,
  type ViewObjectOut,
} from '@fr/service-client-requirements';

const crud = () => import('../../routes/assets/architecture');
const occ = () => import('../../routes/assets/architecture-occurrences');
const ARCH = '/api/assets/architecture';

const id = (what: string) => z.string().min(1).max(100).describe(what);
const modelIdReq = z.string().min(1).max(100).describe("The ArchiMate model of THIS project to add to (from architecture.list_models, language 'archimate').");

/** RM's figure size and the grid a new shape is placed on (same as the page: first free cell, 4 columns). */
const SHAPE = { w: 120, h: 55, gapX: 60, gapY: 45, origin: 24, columns: 4 } as const;
type Bounds = { x: number; y: number; w: number; h: number };
export function nextShapeBounds(existing: ReadonlyArray<Bounds | null | undefined>): Bounds {
  const taken = existing.filter((b): b is Bounds => !!b);
  const hit = (a: Bounds, b: Bounds) => {
    const bw = b.w > 0 ? b.w : SHAPE.w;
    const bh = b.h > 0 ? b.h : SHAPE.h;
    return a.x < b.x + bw && b.x < a.x + a.w && a.y < b.y + bh && b.y < a.y + a.h;
  };
  for (let i = 0; ; i++) {
    const cell = {
      x: SHAPE.origin + (i % SHAPE.columns) * (SHAPE.w + SHAPE.gapX),
      y: SHAPE.origin + Math.floor(i / SHAPE.columns) * (SHAPE.h + SHAPE.gapY),
      w: SHAPE.w,
      h: SHAPE.h,
    };
    if (!taken.some((b) => hit(cell, b))) return cell;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const ARCHIMATE_READ_ACTIONS: ReadonlyArray<AgentCallableAction<any, unknown>> = [
  read(
    'architecture.get_metamodel_concepts',
    'Every ArchiMate element type the modeling service accepts, with its layer (strategy, business, application, technology, …), and the relationship types. Use it to pick an element_type; the layer follows from the type.',
    z.object({}),
    async () => ({ item: (await rmCall<ArchimateConceptsOut>(getListArchimateConceptsUrl())).data }),
  ),
  read(
    'architecture.query_metamodel_relationships',
    'The relationship types ArchiMate allows from a source element type to a target element type (e.g. application_component → application_service: realization). Ask before proposing a relationship.',
    z.object({ source_type: z.string().min(1).max(50), target_type: z.string().min(1).max(50) }),
    async (i) => ({ items: (await rmCall<RelationshipMatrixCell[]>(getQueryArchimateRelationshipMatrixUrl({ source_type: i.source_type, target_type: i.target_type }))).data }),
  ),
  read(
    'architecture.list_view_objects',
    "The shapes on an ArchiMate view (each shows an element of the view's model, a note or a group), in drawing order.",
    z.object({ view_id: id('The view id') }),
    async (i) => ({ items: (await rmCall<ViewObjectOut[]>(getListArchitectureViewObjectsUrl(seg(i.view_id)))).data }),
  ),
  read(
    'architecture.list_view_connections',
    'The lines on an ArchiMate view (each shows a relationship between two of its shapes).',
    z.object({ view_id: id('The view id') }),
    async (i) => ({ items: (await rmCall<ViewConnectionOut[]>(getListArchitectureViewConnectionsUrl(seg(i.view_id)))).data }),
  ),
];

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

type Res = 'elements' | 'relationships' | 'views';
const GET_HANDLER: Record<Res, string> = { elements: 'handleGetArchitectureElement', relationships: 'handleGetArchitectureRelationship', views: 'handleGetArchitectureView' };
const DELETE_HANDLER: Record<Res, string> = { elements: 'handleDeleteArchitectureElement', relationships: 'handleDeleteArchitectureRelationship', views: 'handleDeleteArchitectureView' };
const PARAM: Record<Res, string> = { elements: 'eid', relationships: 'rid', views: 'vid' };

/** An ArchiMate model of this project (read as the human), refused unless it is ArchiMate. */
async function archimateModelInProject(action: string, modelId: string, pid: string, ctx: ActionContext): Promise<Record<string, unknown>> {
  const m = await modelInProject(action, modelId, pid, ctx);
  if (m.language !== 'archimate') {
    throw new AppError(422, 'That model is not an ArchiMate model. Choose an ArchiMate model of this project.').withCode('model_language_mismatch');
  }
  return m;
}

/** An element / relationship / view, read as the human through its page route; refused unless its model is this project's. */
export async function archimateRowInProject(action: string, resource: Res, rowId: string, pid: string, ctx: ActionContext): Promise<{ row: Record<string, unknown>; model: Record<string, unknown> }> {
  const row = dataOf(
    await callRouteAsHuman(action, { method: 'GET', template: `${ARCH}/${resource}/:${PARAM[resource]}`, handler: lazyRoute(crud, GET_HANDLER[resource]), params: { [PARAM[resource]]: rowId } }, ctx),
  );
  const modelId = typeof row.model_id === 'string' ? row.model_id : '';
  if (modelId === '') {
    throw new AppError(403, 'This item does not belong to a model of this project. Open it from the architecture library to change it.').withCode(MODEL_NOT_IN_PROJECT);
  }
  const model = await archimateModelInProject(action, modelId, pid, ctx);
  return { row, model };
}

/** The layer of `type` in RM's metamodel (the agent never chooses one); an unknown type is refused in words. */
async function layerOf(action: string, type: string, ctx: ActionContext): Promise<string> {
  const meta = dataOf(await callRouteAsHuman(action, { method: 'GET', template: `${ARCH}/metamodel/concepts`, handler: lazyRoute(occ, 'handleGetArchimateConcepts'), params: {} }, ctx)) as {
    concepts?: Array<{ type?: unknown; layer?: unknown }>;
  };
  const hit = (meta.concepts ?? []).find((c) => c.type === type);
  if (!hit || typeof hit.layer !== 'string') {
    throw new AppError(422, `"${type}" is not an ArchiMate element type. Read architecture.get_metamodel_concepts for the types.`).withCode('unknown_element_type');
  }
  return hit.layer;
}

const createHeaders = (i: { idempotency_key?: string }, model: Record<string, unknown>): Record<string, string> => ({
  ...(i.idempotency_key ? { 'Idempotency-Key': i.idempotency_key } : {}),
  ...(model.visibility === 'user' || model.visibility === 'tenant' ? { 'X-Visibility': String(model.visibility) } : {}),
});

const createElementInput = z
  .object({
    project_id: projectId,
    model_id: modelIdReq,
    title: z.string().min(1).max(300).describe('The element name.'),
    element_type: z.string().min(1).max(50).describe('An ArchiMate element type from architecture.get_metamodel_concepts, e.g. application_component.'),
    idempotency_key: idempotencyKey,
  })
  .strict();
const createRelationshipInput = z
  .object({
    project_id: projectId,
    source_id: id('The element the relationship starts from (an element of an ArchiMate model of this project).'),
    target_id: id('The element it goes to (in the same model).'),
    relationship_type: z.string().min(1).max(50).describe('One the metamodel allows for the two types (architecture.query_metamodel_relationships), e.g. realization.'),
    idempotency_key: idempotencyKey,
  })
  .strict();
const createViewInput = z
  .object({
    project_id: projectId,
    model_id: modelIdReq,
    title: z.string().min(1).max(300).describe('The view name.'),
    viewpoint: z.string().min(1).max(50).optional().describe('An ArchiMate viewpoint, e.g. application_cooperation; omit for none.'),
    idempotency_key: idempotencyKey,
  })
  .strict();
const deleteInput = (field: string, what: string) =>
  z
    .object({
      project_id: projectId,
      [field]: id(`The ${what} to delete`),
      confirm_name: z.string().max(500).optional().describe(`Typed by the human on the card: the ${what}'s name — never by the agent.`),
      idempotency_key: idempotencyKey,
    })
    .strict();
const addObjectInput = z
  .object({
    project_id: projectId,
    view_id: id('The view'),
    element_id: id("The element to show (an element of the view's model)."),
    bounds: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() }).optional().describe('Where to draw it; omitted: the first free place on the view.'),
    idempotency_key: idempotencyKey,
  })
  .strict();
const addConnectionInput = z
  .object({
    project_id: projectId,
    view_id: id('The view'),
    relationship_id: id('The relationship to draw; both of its elements must already be shapes on the view.'),
    idempotency_key: idempotencyKey,
  })
  .strict();
const removeInput = (field: string, what: string) => z.object({ project_id: projectId, view_id: id('The view'), [field]: id(`The ${what}`), idempotency_key: idempotencyKey }).strict();

type Del = Record<string, unknown> & { project_id: string; confirm_name?: string; idempotency_key?: string };
type Occ = Record<string, unknown> & { project_id: string; view_id: string; idempotency_key?: string };

function deleteAction(resource: Res, field: string, what: string, effect: string): AgentCallableAction<any, unknown> {
  const name = `architecture.delete_${what}`;
  return write<Del>(
    name,
    `Delete an ArchiMate ${what} of this project — DESTRUCTIVE: ${effect} The user confirms by TYPING its name on the card${resource === 'relationships' ? ' (a relationship: its type, e.g. realization)' : ''}; you never fill it in.`,
    deleteInput(field, what) as unknown as z.ZodType<Del>,
    invokeCard(name, 'typed-confirm', ['confirm_name']),
    (i) => keyOf(name, i, String(i[field])),
    async (i, ctx, pid) => {
      const rowId = String(i[field]);
      const { row } = await archimateRowInProject(name, resource, rowId, pid, ctx);
      const expected = String((resource === 'relationships' ? row.relationship_type : row.title) ?? '').trim();
      if (expected === '' || String(i.confirm_name ?? '').trim() !== expected) {
        throw new AppError(422, `Type the ${what}'s exact ${resource === 'relationships' ? 'type' : 'name'} on the card to confirm the deletion.`).withCode(TYPED_CONFIRMATION_MISMATCH);
      }
      await callRouteAsHuman(name, { method: 'DELETE', template: `${ARCH}/${resource}/:${PARAM[resource]}`, handler: lazyRoute(crud, DELETE_HANDLER[resource]), params: { [PARAM[resource]]: rowId } }, ctx);
      return { deleted: rowId, name: expected };
    },
  );
}

/** The view, checked against the project; its current shapes. */
async function viewAndShapes(action: string, viewId: string, pid: string, ctx: ActionContext): Promise<{ view: Record<string, unknown>; objects: Array<Record<string, unknown>> }> {
  const { row } = await archimateRowInProject(action, 'views', viewId, pid, ctx);
  const listed = await callRouteAsHuman(action, { method: 'GET', template: `${ARCH}/views/:vid/objects`, handler: lazyRoute(occ, 'handleListArchitectureViewObjects'), params: { vid: viewId } }, ctx);
  const objects = ((listed as { data?: unknown } | null)?.data ?? []) as Array<Record<string, unknown>>;
  return { view: row, objects };
}

export const ARCHIMATE_WRITE_ACTIONS: ReadonlyArray<AgentCallableAction<any, unknown>> = [
  write<z.infer<typeof createElementInput>>(
    'architecture.create_element',
    'Add an element to an ArchiMate model of THIS project (model_id): a name and an element type from architecture.get_metamodel_concepts; its layer follows from the type. The user confirms on a card.',
    createElementInput,
    invokeCard('architecture.create_element'),
    (i) => keyOf('architecture.create_element', i, i.model_id, i.element_type, i.title),
    async (i, ctx, pid) => {
      const m = await archimateModelInProject('architecture.create_element', i.model_id, pid, ctx);
      const layer = await layerOf('architecture.create_element', i.element_type, ctx);
      return callRouteAsHuman(
        'architecture.create_element',
        {
          method: 'POST',
          template: `${ARCH}/elements`,
          handler: lazyRoute(crud, 'handleCreateArchitectureElement'),
          params: {},
          headers: createHeaders(i, m),
          body: { model_id: i.model_id, title: i.title, element_type: i.element_type, layer, project_id: pid },
        },
        ctx,
      );
    },
  ),
  write<z.infer<typeof createRelationshipInput>>(
    'architecture.create_relationship',
    'Add a relationship between two elements of the same ArchiMate model of THIS project (it joins their model). Ask architecture.query_metamodel_relationships first: a type the metamodel does not allow is refused with the reason.',
    createRelationshipInput,
    invokeCard('architecture.create_relationship'),
    (i) => keyOf('architecture.create_relationship', i, i.source_id, i.relationship_type, i.target_id),
    async (i, ctx, pid) => {
      const src = await archimateRowInProject('architecture.create_relationship', 'elements', i.source_id, pid, ctx);
      const tgt = await archimateRowInProject('architecture.create_relationship', 'elements', i.target_id, pid, ctx);
      if (src.row.model_id !== tgt.row.model_id) {
        throw new AppError(422, 'Both elements must be in the same model.').withCode('model_integrity');
      }
      return callRouteAsHuman(
        'architecture.create_relationship',
        {
          method: 'POST',
          template: `${ARCH}/relationships`,
          handler: lazyRoute(crud, 'handleCreateArchitectureRelationship'),
          params: {},
          headers: createHeaders(i, src.model),
          body: { source_entity_type: 'architecture_elements', source_id: i.source_id, target_entity_type: 'architecture_elements', target_id: i.target_id, relationship_type: i.relationship_type, project_id: pid },
        },
        ctx,
      );
    },
  ),
  write<z.infer<typeof createViewInput>>(
    'architecture.create_view',
    'Add a view (a diagram) to an ArchiMate model of THIS project. Then place elements on it (architecture.add_view_object) and draw relationships (architecture.add_view_connection).',
    createViewInput,
    invokeCard('architecture.create_view'),
    (i) => keyOf('architecture.create_view', i, i.model_id, i.title, i.viewpoint),
    async (i, ctx, pid) => {
      const m = await archimateModelInProject('architecture.create_view', i.model_id, pid, ctx);
      return callRouteAsHuman(
        'architecture.create_view',
        {
          method: 'POST',
          template: `${ARCH}/views`,
          handler: lazyRoute(crud, 'handleCreateArchitectureView'),
          params: {},
          headers: createHeaders(i, m),
          body: { model_id: i.model_id, title: i.title, project_id: pid, ...(i.viewpoint ? { viewpoint: i.viewpoint } : {}) },
        },
        ctx,
      );
    },
  ),
  deleteAction('elements', 'element_id', 'element', 'its relationships and the shapes showing it on every view go with it.'),
  deleteAction('relationships', 'relationship_id', 'relationship', 'the lines showing it on every view go with it.'),
  deleteAction('views', 'view_id', 'view', 'only the diagram goes; its elements and relationships stay in the model.'),
  write<Occ>(
    'architecture.add_view_object',
    "Place an element of the view's model on an ArchiMate view of this project as a shape (at the first free place unless bounds are given).",
    addObjectInput as unknown as z.ZodType<Occ>,
    invokeCard('architecture.add_view_object'),
    (i) => keyOf('architecture.add_view_object', i, i.view_id, i.element_id),
    async (i, ctx, pid) => {
      // RM takes no Idempotency-Key here: the view is RE-READ before every add, so a retry after
      // an unknown outcome finds the shape that landed instead of drawing a second one.
      const { objects } = await viewAndShapes('architecture.add_view_object', i.view_id, pid, ctx);
      if (objects.some((o) => o.kind === 'element' && o.concept_ref === i.element_id)) {
        throw new AppError(409, 'This element is already on the view.').withCode('already_on_view');
      }
      const bounds = (i.bounds as Bounds | undefined) ?? nextShapeBounds(objects.map((o) => o.bounds as Bounds | null));
      return callRouteAsHuman(
        'architecture.add_view_object',
        {
          method: 'POST',
          template: `${ARCH}/views/:vid/objects`,
          handler: lazyRoute(occ, 'handleCreateArchitectureViewObject'),
          params: { vid: i.view_id },
          body: { kind: 'element', concept_ref: i.element_id, bounds },
        },
        ctx,
      );
    },
  ),
  write<Occ>(
    'architecture.add_view_connection',
    'Draw a relationship on an ArchiMate view of this project as a line between the shapes of its two elements (place both elements first).',
    addConnectionInput as unknown as z.ZodType<Occ>,
    invokeCard('architecture.add_view_connection'),
    (i) => keyOf('architecture.add_view_connection', i, i.view_id, i.relationship_id),
    async (i, ctx, pid) => {
      // No Idempotency-Key on RM's side: re-read the view's lines first so a retry never draws a second one.
      const { objects } = await viewAndShapes('architecture.add_view_connection', i.view_id, pid, ctx);
      const lines = await callRouteAsHuman(
        'architecture.add_view_connection',
        { method: 'GET', template: `${ARCH}/views/:vid/connections`, handler: lazyRoute(occ, 'handleListArchitectureViewConnections'), params: { vid: i.view_id } },
        ctx,
      );
      if ((((lines as { data?: unknown } | null)?.data ?? []) as Array<Record<string, unknown>>).some((c) => c.relationship_ref === i.relationship_id)) {
        throw new AppError(409, 'This relationship is already drawn on the view.').withCode('already_on_view');
      }
      const { row: rel } = await archimateRowInProject('architecture.add_view_connection', 'relationships', String(i.relationship_id), pid, ctx);
      const shapeOf = (ref: unknown) => objects.find((o) => o.kind === 'element' && o.concept_ref === ref);
      const a = shapeOf(rel.source_id);
      const b = shapeOf(rel.target_id);
      if (!a || !b) {
        throw new AppError(422, 'Place both of its elements on the view first (architecture.add_view_object).').withCode('view_ends_missing');
      }
      return callRouteAsHuman(
        'architecture.add_view_connection',
        {
          method: 'POST',
          template: `${ARCH}/views/:vid/connections`,
          handler: lazyRoute(occ, 'handleCreateArchitectureViewConnection'),
          params: { vid: i.view_id },
          body: { kind: 'relationship', relationship_ref: i.relationship_id, source_object_id: a.id, target_object_id: b.id },
        },
        ctx,
      );
    },
  ),
  write<Occ>(
    'architecture.remove_view_object',
    'Remove a shape from an ArchiMate view of this project, with the lines attached to it (the element itself stays in the model).',
    removeInput('object_id', 'shape') as unknown as z.ZodType<Occ>,
    invokeCard('architecture.remove_view_object'),
    (i) => keyOf('architecture.remove_view_object', i, i.view_id, i.object_id),
    async (i, ctx, pid) => {
      await archimateRowInProject('architecture.remove_view_object', 'views', i.view_id, pid, ctx);
      return callRouteAsHuman(
        'architecture.remove_view_object',
        { method: 'DELETE', template: `${ARCH}/views/:vid/objects/:oid`, handler: lazyRoute(occ, 'handleDeleteArchitectureViewObject'), params: { vid: i.view_id, oid: String(i.object_id) } },
        ctx,
      );
    },
  ),
  write<Occ>(
    'architecture.remove_view_connection',
    'Remove a line from an ArchiMate view of this project (the relationship itself stays in the model).',
    removeInput('connection_id', 'line') as unknown as z.ZodType<Occ>,
    invokeCard('architecture.remove_view_connection'),
    (i) => keyOf('architecture.remove_view_connection', i, i.view_id, i.connection_id),
    async (i, ctx, pid) => {
      await archimateRowInProject('architecture.remove_view_connection', 'views', i.view_id, pid, ctx);
      return callRouteAsHuman(
        'architecture.remove_view_connection',
        { method: 'DELETE', template: `${ARCH}/views/:vid/connections/:cid`, handler: lazyRoute(occ, 'handleDeleteArchitectureViewConnection'), params: { vid: i.view_id, cid: String(i.connection_id) } },
        ctx,
      );
    },
  ),
];

export const ARCHITECTURE_ARCHIMATE_ACTIONS: ReadonlyArray<AgentCallableAction<any, unknown>> = [...ARCHIMATE_READ_ACTIONS, ...ARCHIMATE_WRITE_ACTIONS];

function safeRegister<I, O>(a: AgentCallableAction<I, O>): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

/** Production registrar (called by `registerAllActions`). */
export function registerArchitectureArchimateActions(): void {
  for (const a of ARCHITECTURE_ARCHIMATE_ACTIONS) safeRegister(a);
}
