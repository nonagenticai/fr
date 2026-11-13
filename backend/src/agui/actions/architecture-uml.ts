/**
 * The project agent's UML (profile uml-2.5.1-p1) and TRACE LINK actions — every
 * capability of the UML model pages and the trace-link panels
 * (routes/assets/architecture-uml.ts) as an agent tool.
 *
 * Same contract as agui/actions/architecture-modeling.ts, whose helpers this
 * module reuses:
 *   - reads call requirements_management directly; lists are bound to the
 *     conversation's project (PROJECT_BINDING), rows addressed by id are checked
 *     against it by agent/project-asset-guard.ts;
 *   - writes are PROPOSED as confirm cards and run on the human's Confirm through
 *     the pages' own routes as the human, BOUND to this project: a create joins
 *     this project, and a write on an existing row is refused unless the row is
 *     this project's (`model_not_in_project`);
 *   - an update READS the row and changes only the fields the agent named (RM's
 *     PUT replaces the whole row; a field the agent did not mention is kept);
 *   - deleting an element, relationship, interaction or diagram is DESTRUCTIVE
 *     (RM cascades): a typed card where the human types the item's name
 *     (`confirm_name`, re-checked here). Removing one shape or line from a
 *     diagram, or one trace link, is a plain confirm card.
 */
import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { AppError } from '../../utils/errors';
import { callRouteAsHuman, lazyRoute } from './project-core';
import {
  MODEL_NOT_IN_PROJECT,
  TYPED_CONFIRMATION_MISMATCH,
  dataOf,
  idempotencyKey,
  invokeCard,
  keyOf,
  modelInProject,
  projectId,
  read,
  write,
} from './architecture-modeling';
import { rmCall, seg, umlDiagramRenderUrl } from '../../integrations/architecture';
import {
  getGetTraceLinkUrl,
  getGetUmlDiagramUrl,
  getGetUmlElementUrl,
  getGetUmlInteractionUrl,
  getGetUmlProfileUrl,
  getGetUmlRelationshipUrl,
  getListTraceLinksUrl,
  getListUmlDiagramConnectionsUrl,
  getListUmlDiagramObjectsUrl,
  getListUmlDiagramsUrl,
  getListUmlElementsUrl,
  getListUmlInteractionsUrl,
  getListUmlRelationshipsUrl,
  TraceLinkInLinkType,
  TraceRefKind,
  type ListTraceLinksParams,
  type RenderReport,
  type SchemasUmlApiUmlDiagramConnectionIn,
  type SchemasUmlApiUmlDiagramObjectIn,
  type TraceLinkOut,
  type UmlDiagramUpdate,
  type UmlElementUpdate,
  type UmlInteractionUpdate,
  type UmlProfileOut,
  type UmlRelationshipUpdate,
} from '@fr/service-client-requirements';

type UmlResource = 'elements' | 'relationships' | 'interactions' | 'diagrams';

/** The generated list / get URL builders per UML resource. */
const UML_URL: Record<UmlResource, { list: (p?: Record<string, unknown>) => string; get: (id: string) => string }> = {
  elements: { list: getListUmlElementsUrl, get: getGetUmlElementUrl },
  relationships: { list: getListUmlRelationshipsUrl, get: getGetUmlRelationshipUrl },
  interactions: { list: getListUmlInteractionsUrl, get: getGetUmlInteractionUrl },
  diagrams: { list: getListUmlDiagramsUrl, get: getGetUmlDiagramUrl },
};

/**
 * Every key of a generated body type, as a runtime list. The object literal must
 * name EVERY key of `T` and nothing else, so a field RM adds or drops fails the
 * typecheck here instead of being silently lost from a PUT.
 */
const keysOf =
  <T>() =>
  <K extends Record<keyof Required<T>, true>>(o: K & Record<Exclude<keyof K, keyof T>, never>): ReadonlyArray<keyof T & string> =>
    Object.keys(o) as Array<keyof T & string>;

const routes = () => import('../../routes/assets/architecture-uml');
const UML = '/api/assets/architecture/modeling/uml';

/** RM types a trace link's ends and link types as enums: the agent's choices are those, from the generated client. */
const TRACE_KINDS = z.nativeEnum(TraceRefKind);
const TRACE_LINK_TYPES = z.nativeEnum(TraceLinkInLinkType);

const id = (what: string) => z.string().min(1).max(100).describe(what);
const modelIdReq = z.string().min(1).max(100).describe("The UML model of THIS project to add to (from architecture.list_models, language 'uml').");

// Profile shapes (RM UmlElementAttributes, UmlAssociationEnd, the interaction document).
const property = z.object({
  id: z.string().min(1).describe('A short id unique in the model, e.g. "p-amount".'),
  name: z.string().optional(),
  type_ref: z.string().nullable().optional().describe('Element id of the type.'),
  multiplicity: z.string().nullable().optional().describe('e.g. "1", "0..1", "*", "1..*".'),
  visibility: z.enum(['public', 'private', 'protected', 'package']).nullable().optional(),
  is_static: z.boolean().optional(),
  default: z.string().nullable().optional(),
});
const parameter = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  type_ref: z.string().nullable().optional(),
  direction: z.enum(['in', 'out', 'inout', 'return']).nullable().optional(),
  multiplicity: z.string().nullable().optional(),
});
const operation = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  visibility: z.enum(['public', 'private', 'protected', 'package']).nullable().optional(),
  is_abstract: z.boolean().optional(),
  is_static: z.boolean().optional(),
  parameters: z.array(parameter).optional(),
  return_type_ref: z.string().nullable().optional(),
});
const attributes = z
  .object({
    properties: z.array(property).optional(),
    operations: z.array(operation).optional(),
    literals: z.array(z.string()).optional().describe('Enumeration literals (enumeration only).'),
    is_abstract: z.boolean().optional(),
    provided: z.array(z.string()).optional().describe('Interface ids a component or port provides.'),
    required: z.array(z.string()).optional().describe('Interface ids a component or port requires.'),
  })
  .describe("The element's features.");
const end = z.object({
  element_ref: z.string().min(1),
  role: z.string().nullable().optional(),
  multiplicity: z.string().nullable().optional(),
  aggregation: z.enum(['none', 'shared', 'composite']).optional(),
  navigable: z.boolean().optional(),
});
const lifeline = z.object({ id: z.string().min(1), name: z.string().optional(), represents_ref: z.string().nullable().optional() });
const occurrence = z.object({ id: z.string().min(1), lifeline: z.string().min(1) });
const message = z.object({
  id: z.string().min(1),
  kind: z.enum(['synch_call', 'asynch_call', 'asynch_signal', 'reply', 'create', 'delete']),
  name: z.string().optional(),
  send_occurrence: z.string().min(1),
  receive_occurrence: z.string().min(1),
  operation_ref: z.string().nullable().optional(),
  arguments: z.array(z.string()).optional(),
});
const execution = z.object({ id: z.string().min(1), lifeline: z.string().min(1), start: z.string().min(1), finish: z.string().min(1) });
const fragment = z.object({
  id: z.string().min(1),
  operator: z.enum(['alt', 'opt', 'loop', 'par', 'break']),
  covered: z.array(z.string()).optional(),
  operands: z.array(z.object({ guard: z.string().nullable().optional(), occurrences: z.array(z.string()).optional() })).optional(),
});
const bounds = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().optional(), h: z.number().int().optional() });

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const RES_FIELD: Record<UmlResource, string> = {
  elements: 'element_id',
  relationships: 'relationship_id',
  interactions: 'interaction_id',
  diagrams: 'diagram_id',
};
const RES_ONE: Record<UmlResource, string> = { elements: 'element', relationships: 'relationship', interactions: 'interaction', diagrams: 'diagram' };

const listInput = (withKind: boolean, withOwner: boolean) =>
  z.object({
    project_id: z.string().optional(),
    model_id: z.string().optional(),
    ...(withKind ? { kind: z.string().optional() } : {}),
    ...(withOwner ? { owner_id: z.string().optional() } : {}),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
  });

function umlReads(resource: UmlResource, withKind: boolean, withOwner: boolean, describe: string): AgentCallableAction<any, unknown>[] {
  const field = RES_FIELD[resource];
  return [
    read(`architecture.list_uml_${resource}`, `List this project's UML ${describe}. Optional filters: model_id${withKind ? ', kind' : ''}${withOwner ? ', owner_id' : ''}, limit, offset.`, listInput(withKind, withOwner), async (i) => ({
      items: (await rmCall<unknown[]>(UML_URL[resource].list(i as Record<string, unknown>))).data,
    })),
    read(`architecture.get_uml_${RES_ONE[resource]}`, `One UML ${RES_ONE[resource]} with everything stored on it.`, z.object({ [field]: id(`The ${RES_ONE[resource]} id`) }), async (i) => ({
      item: (await rmCall<unknown>(UML_URL[resource].get(seg(String(i[field]))))).data,
    })),
  ];
}

export const UML_READ_ACTIONS: ReadonlyArray<AgentCallableAction<any, unknown>> = [
  ...umlReads('elements', true, true, 'elements (packages, classes, interfaces, data types, enumerations, primitive types, components, ports, actors)'),
  ...umlReads('relationships', true, false, 'relationships (associations, generalizations, realizations, dependencies, usages, connectors)'),
  ...umlReads('interactions', false, true, 'interactions (sequences of messages between lifelines)'),
  ...umlReads('diagrams', true, false, 'diagrams (class, component and sequence diagrams)'),
  read(
    'architecture.list_uml_diagram_objects',
    'The shapes on a UML diagram (each shows an element, or a lifeline on a sequence diagram), in drawing order.',
    z.object({ diagram_id: id('The diagram id') }),
    async (i) => ({ items: (await rmCall<unknown[]>(getListUmlDiagramObjectsUrl(seg(i.diagram_id)))).data }),
  ),
  read(
    'architecture.list_uml_diagram_connections',
    'The lines on a UML diagram (each shows a relationship, or a message on a sequence diagram).',
    z.object({ diagram_id: id('The diagram id') }),
    async (i) => ({ items: (await rmCall<unknown[]>(getListUmlDiagramConnectionsUrl(seg(i.diagram_id)))).data }),
  ),
  read(
    'architecture.get_uml_diagram_picture',
    "The drawing notes for a UML diagram (anything that could not be drawn as stored), now or as it was in a saved version. The picture itself is on the diagram's page.",
    z.object({ diagram_id: id('The diagram id'), model_id: z.string().optional(), revision_id: z.string().optional() }),
    async (i) => {
      const r = (
        await rmCall<RenderReport>(
          umlDiagramRenderUrl(i.diagram_id, { format: 'svg', report: true }, i.model_id && i.revision_id ? { modelId: i.model_id, revisionId: i.revision_id } : undefined),
          { slow: true },
        )
      ).data;
      return { diagnostics: r.diagnostics, renderer_version: r.renderer_version, svg_bytes: r.svg.length };
    },
  ),
  read(
    'architecture.download_diagram_png',
    "Give the person a download card for a diagram's picture as a PNG file: an ArchiMate view (kind 'view') or a UML diagram (kind 'uml_diagram'), now or as it was in a saved version (model_id + revision_id). The person downloads it from the card; you never receive the file.",
    z.object({
      kind: z.enum(['view', 'uml_diagram']),
      id: id('The view or UML diagram id'),
      model_id: z.string().min(1).max(100).optional(),
      revision_id: z.string().min(1).max(100).optional(),
    }),
    async (i) => {
      const saved = i.model_id && i.revision_id ? { model_id: i.model_id, revision_id: i.revision_id } : {};
      // Only the title is read, to name the file on the card; the picture itself goes from fr to the browser.
      const row =
        i.kind === 'view'
          ? ((await (await import('../../integrations/architecture')).getArchitectureView(i.id)) as unknown as { title?: unknown })
          : (await rmCall<{ name?: unknown }>(getGetUmlDiagramUrl(seg(i.id)))).data;
      const title = String((row as { title?: unknown; name?: unknown }).title ?? (row as { name?: unknown }).name ?? 'diagram');
      return { downloadable: true, diagram: { kind: i.kind, id: i.id, title, ...saved } };
    },
  ),
  read('architecture.get_uml_profile', 'The UML profile: which element and relationship kinds exist, and what each may hold.', z.object({}), async () => ({
    item: (await rmCall<UmlProfileOut>(getGetUmlProfileUrl())).data,
  })),
  read(
    'architecture.list_trace_links',
    "The trace links of one item of this project, both ways (what it realizes, refines, traces to, satisfies, implements or depends on, and what does so to it). Optional link_type.",
    z.object({ item_kind: TRACE_KINDS, item_id: id('The item id'), link_type: TRACE_LINK_TYPES.optional() }),
    async (i) => {
      const q = (k: 'source_id' | 'target_id'): ListTraceLinksParams => ({ [k]: i.item_id, ...(i.link_type ? { link_type: i.link_type } : {}), limit: 1000 });
      const [from, to] = await Promise.all([
        rmCall<TraceLinkOut[]>(getListTraceLinksUrl(q('source_id'))),
        rmCall<TraceLinkOut[]>(getListTraceLinksUrl(q('target_id'))),
      ]);
      const seen = new Set<string>();
      return { items: [...from.data, ...to.data].filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true))) };
    },
  ),
  read('architecture.get_trace_link', 'One trace link.', z.object({ link_id: id('The trace link id') }), async (i) => ({
    item: (await rmCall<unknown>(getGetTraceLinkUrl(seg(i.link_id)))).data,
  })),
];

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** A UML row, read as the human through its page route; refused unless it is this project's. */
export async function umlRowInProject(action: string, resource: UmlResource, rowId: string, pid: string, ctx: ActionContext): Promise<Record<string, unknown>> {
  const handler = { elements: 'handleGetUmlElement', relationships: 'handleGetUmlRelationship', interactions: 'handleGetUmlInteraction', diagrams: 'handleGetUmlDiagram' }[resource];
  const row = dataOf(
    await callRouteAsHuman(action, { method: 'GET', template: `${UML}/${resource}/:id`, handler: lazyRoute(routes, handler), params: { id: rowId } }, ctx),
  );
  if (row.project_id !== pid) {
    throw new AppError(403, 'This item does not belong to this project. Open it from the architecture library to change it.').withCode(MODEL_NOT_IN_PROJECT);
  }
  return row;
}

const HANDLER_NAME: Record<UmlResource, string> = { elements: 'Element', relationships: 'Relationship', interactions: 'Interaction', diagrams: 'Diagram' };

/** The fields an update may name, per resource: exactly the generated `…Update` body's keys. */
const UPDATABLE: Record<UmlResource, readonly string[]> = {
  elements: keysOf<UmlElementUpdate>()({ kind: true, name: true, owner_id: true, attributes: true }),
  relationships: keysOf<UmlRelationshipUpdate>()({ kind: true, name: true, source: true, target: true, ends: true, connector_kind: true }),
  interactions: keysOf<UmlInteractionUpdate>()({ name: true, owner_id: true, lifelines: true, occurrences: true, messages: true, executions: true, fragments: true }),
  diagrams: keysOf<UmlDiagramUpdate>()({ kind: true, name: true, documentation: true }),
};

function umlWrites(resource: UmlResource, create: z.ZodRawShape, describe: string): AgentCallableAction<any, unknown>[] {
  const one = RES_ONE[resource];
  const field = RES_FIELD[resource];
  const Name = HANDLER_NAME[resource];
  const createInput = z.object({ project_id: projectId, model_id: modelIdReq, ...create, idempotency_key: idempotencyKey }).strict();
  const updShape: z.ZodRawShape = {};
  for (const [k, v] of Object.entries(create)) updShape[k] = (v as z.ZodTypeAny).optional();
  const updateInput = z
    .object({
      project_id: projectId,
      [field]: id(`The ${one} to change`),
      ...updShape,
      expected_head: z.number().int().min(0).optional().describe("The model's head; the change is refused if someone changed the model since."),
      idempotency_key: idempotencyKey,
    })
    .strict();
  const deleteInput = z
    .object({
      project_id: projectId,
      [field]: id(`The ${one} to delete`),
      confirm_name: z.string().max(500).optional().describe(`Typed by the human on the card: the ${one}'s name — never by the agent.`),
      idempotency_key: idempotencyKey,
    })
    .strict();
  type C = z.infer<typeof createInput>;
  type U = Record<string, unknown> & { project_id: string; idempotency_key?: string };
  return [
    write<C>(
      `architecture.create_uml_${one}`,
      `Create a UML ${describe} in a UML model of THIS project (model_id). The user confirms on a card.`,
      createInput,
      invokeCard(`architecture.create_uml_${one}`),
      (i) => keyOf(`architecture.create_uml_${one}`, i, JSON.stringify(i)),
      async (i, ctx, pid) => {
        const m = await modelInProject(`architecture.create_uml_${one}`, String(i.model_id), pid, ctx);
        if (m.language !== 'uml') {
          throw new AppError(422, 'That model is not a UML model. Choose a UML model of this project.').withCode('model_language_mismatch');
        }
        // Exactly RM's create fields (extra="forbid"): the model names the project.
        const { project_id: _p, idempotency_key: _k, ...rest } = i as Record<string, unknown>;
        return callRouteAsHuman(
          `architecture.create_uml_${one}`,
          { method: 'POST', template: `${UML}/${resource}`, handler: lazyRoute(routes, `handleCreateUml${Name}`), params: {}, body: rest },
          ctx,
        );
      },
    ),
    write<U>(
      `architecture.update_uml_${one}`,
      `Change a UML ${one} of this project. Only the fields you name change; everything else is kept.`,
      updateInput as unknown as z.ZodType<U>,
      invokeCard(`architecture.update_uml_${one}`),
      (i) => keyOf(`architecture.update_uml_${one}`, i, JSON.stringify(i)),
      async (i, ctx, pid) => {
        const rowId = String(i[field]);
        const row = await umlRowInProject(`architecture.update_uml_${one}`, resource, rowId, pid, ctx);
        const body: Record<string, unknown> = {};
        for (const k of UPDATABLE[resource]) if (k in row) body[k] = row[k];
        for (const k of UPDATABLE[resource]) if (i[k] !== undefined) body[k] = i[k];
        if (i.expected_head !== undefined) body.expected_head = i.expected_head;
        return callRouteAsHuman(
          `architecture.update_uml_${one}`,
          { method: 'PUT', template: `${UML}/${resource}/:id`, handler: lazyRoute(routes, `handleUpdateUml${Name}`), params: { id: rowId }, body },
          ctx,
        );
      },
    ),
    write<U>(
      `architecture.delete_uml_${one}`,
      `Delete a UML ${one} of this project — DESTRUCTIVE: what it owns and the diagram shapes showing it go with it. The user confirms by TYPING its name on the card; you never fill it in.`,
      deleteInput as unknown as z.ZodType<U>,
      invokeCard(`architecture.delete_uml_${one}`, 'typed-confirm', ['confirm_name']),
      (i) => keyOf(`architecture.delete_uml_${one}`, i, String(i[field])),
      async (i, ctx, pid) => {
        const rowId = String(i[field]);
        const row = await umlRowInProject(`architecture.delete_uml_${one}`, resource, rowId, pid, ctx);
        // An unnamed row (an anonymous relationship) is confirmed by typing its kind, as the card shows it.
        const name = (typeof row.name === 'string' ? row.name.trim() : '') || String(row.kind ?? '').trim();
        if (name === '' || String(i.confirm_name ?? '').trim() !== name) {
          throw new AppError(422, `Type the ${one}'s exact name on the card to confirm the deletion.`).withCode(TYPED_CONFIRMATION_MISMATCH);
        }
        return callRouteAsHuman(
          `architecture.delete_uml_${one}`,
          { method: 'DELETE', template: `${UML}/${resource}/:id`, handler: lazyRoute(routes, `handleDeleteUml${Name}`), params: { id: rowId } },
          ctx,
        );
      },
    ),
  ];
}

const OCC: Record<'objects' | 'connections', { one: string; Name: string; ref: string; shape: z.ZodRawShape; describe: string }> = {
  objects: {
    one: 'object',
    Name: 'DiagramObject',
    ref: 'object_id',
    describe: 'a shape (an element, or a lifeline on a sequence diagram)',
    shape: {
      element_ref: z.string().nullable().optional().describe('The element shown (class / component diagrams).'),
      lifeline_id: z.string().nullable().optional().describe('The lifeline shown (sequence diagrams).'),
      bounds: bounds.nullable().optional(),
      position: z.number().int().min(0).nullable().optional().describe('Drawing order (0 = bottom).'),
      style: z.record(z.unknown()).nullable().optional().describe('Fill / line / font settings, as stored.'),
    },
  },
  connections: {
    one: 'connection',
    Name: 'DiagramConnection',
    ref: 'connection_id',
    describe: 'a line (a relationship, or a message on a sequence diagram)',
    shape: {
      relationship_ref: z.string().nullable().optional(),
      message_id: z.string().nullable().optional(),
      source_object_id: z.string().optional(),
      target_object_id: z.string().optional(),
      bendpoints: z.array(z.object({ x: z.number().int(), y: z.number().int() })).nullable().optional(),
      style: z.record(z.unknown()).nullable().optional(),
    },
  },
};

/** Every field RM's diagram object / connection body accepts: exactly the generated body's keys. */
export const OCC_FIELDS: Record<'objects' | 'connections', readonly string[]> = {
  objects: keysOf<SchemasUmlApiUmlDiagramObjectIn>()({ element_ref: true, lifeline_id: true, bounds: true, style: true, position: true }),
  connections: keysOf<SchemasUmlApiUmlDiagramConnectionIn>()({
    relationship_ref: true,
    message_id: true,
    source_object_id: true,
    target_object_id: true,
    bendpoints: true,
    style: true,
  }),
};

function occurrenceWrites(part: 'objects' | 'connections'): AgentCallableAction<any, unknown>[] {
  const o = OCC[part];
  const addInput = z.object({ project_id: projectId, diagram_id: id('The diagram'), ...o.shape, idempotency_key: idempotencyKey }).strict();
  const changeInput = z.object({ project_id: projectId, diagram_id: id('The diagram'), [o.ref]: id(`The ${o.one}`), ...o.shape, idempotency_key: idempotencyKey }).strict();
  const removeInput = z.object({ project_id: projectId, diagram_id: id('The diagram'), [o.ref]: id(`The ${o.one}`), idempotency_key: idempotencyKey }).strict();
  type I = Record<string, unknown> & { project_id: string; idempotency_key?: string; diagram_id: string };
  const fields = Object.keys(o.shape);
  const pick = (i: I) => Object.fromEntries(fields.filter((k) => i[k] !== undefined).map((k) => [k, i[k]]));
  return [
    write<I>(
      `architecture.add_uml_diagram_${o.one}`,
      `Add ${o.describe} to a UML diagram of this project.`,
      addInput as unknown as z.ZodType<I>,
      invokeCard(`architecture.add_uml_diagram_${o.one}`),
      (i) => keyOf(`architecture.add_uml_diagram_${o.one}`, i, JSON.stringify(i)),
      async (i, ctx, pid) => {
        await umlRowInProject(`architecture.add_uml_diagram_${o.one}`, 'diagrams', i.diagram_id, pid, ctx);
        return callRouteAsHuman(
          `architecture.add_uml_diagram_${o.one}`,
          { method: 'POST', template: `${UML}/diagrams/:did/${part}`, handler: lazyRoute(routes, `handleCreateUml${o.Name}`), params: { did: i.diagram_id }, body: pick(i) },
          ctx,
        );
      },
    ),
    write<I>(
      `architecture.update_uml_diagram_${o.one}`,
      `Change ${o.describe} on a UML diagram of this project (only the fields you name).`,
      changeInput as unknown as z.ZodType<I>,
      invokeCard(`architecture.update_uml_diagram_${o.one}`),
      (i) => keyOf(`architecture.update_uml_diagram_${o.one}`, i, JSON.stringify(i)),
      async (i, ctx, pid) => {
        await umlRowInProject(`architecture.update_uml_diagram_${o.one}`, 'diagrams', i.diagram_id, pid, ctx);
        const current = ((
          await rmCall<Record<string, unknown>[]>(
            part === 'objects' ? getListUmlDiagramObjectsUrl(seg(i.diagram_id)) : getListUmlDiagramConnectionsUrl(seg(i.diagram_id)),
          )
        ).data ?? []).find((x) => x.id === i[o.ref]);
        if (!current) throw new AppError(404, `This ${o.one} is not on the diagram any more.`).withCode('not_found');
        // RM's PUT replaces the whole occurrence: start from EVERY field it accepts, as stored.
        const accepted = OCC_FIELDS[part];
        const body = { ...Object.fromEntries(accepted.filter((k) => k in current).map((k) => [k, current[k]])), ...pick(i) };
        return callRouteAsHuman(
          `architecture.update_uml_diagram_${o.one}`,
          {
            method: 'PUT',
            template: `${UML}/diagrams/:did/${part}/:${part === 'objects' ? 'oid' : 'cid'}`,
            handler: lazyRoute(routes, `handleUpdateUml${o.Name}`),
            params: { did: i.diagram_id, [part === 'objects' ? 'oid' : 'cid']: String(i[o.ref]) },
            body,
          },
          ctx,
        );
      },
    ),
    write<I>(
      `architecture.remove_uml_diagram_${o.one}`,
      `Remove ${o.describe} from a UML diagram of this project (the element or relationship itself stays).`,
      removeInput as unknown as z.ZodType<I>,
      invokeCard(`architecture.remove_uml_diagram_${o.one}`),
      (i) => keyOf(`architecture.remove_uml_diagram_${o.one}`, i, String(i[o.ref])),
      async (i, ctx, pid) => {
        await umlRowInProject(`architecture.remove_uml_diagram_${o.one}`, 'diagrams', i.diagram_id, pid, ctx);
        return callRouteAsHuman(
          `architecture.remove_uml_diagram_${o.one}`,
          {
            method: 'DELETE',
            template: `${UML}/diagrams/:did/${part}/:${part === 'objects' ? 'oid' : 'cid'}`,
            handler: lazyRoute(routes, `handleDeleteUml${o.Name}`),
            params: { did: i.diagram_id, [part === 'objects' ? 'oid' : 'cid']: String(i[o.ref]) },
          },
          ctx,
        );
      },
    ),
  ];
}

const traceCreateInput = z
  .object({
    project_id: projectId,
    source_kind: TRACE_KINDS.describe('What the link starts from.'),
    source_id: id('The id of the item the link starts from (it must belong to this project).'),
    link_type: TRACE_LINK_TYPES,
    target_kind: TRACE_KINDS.optional(),
    target_id: z.string().min(1).max(100).optional().describe('The id of the other item (it must belong to this project too).'),
    code_repo: z.string().max(300).optional().describe('Instead of a target item: the repository …'),
    code_commit: z.string().max(100).optional().describe('… the commit …'),
    code_symbol: z.string().max(1000).optional().describe('… and the symbol (function, class, file) the link points to.'),
    note: z.string().max(4000).optional(),
    idempotency_key: idempotencyKey,
  })
  .strict();
const traceDeleteInput = z.object({ project_id: projectId, link_id: id('The trace link'), idempotency_key: idempotencyKey }).strict();

export const UML_WRITE_ACTIONS: ReadonlyArray<AgentCallableAction<any, unknown>> = [
  ...umlWrites(
    'elements',
    { kind: z.string().min(1).describe('One of the profile\'s element kinds (architecture.get_uml_profile).'), name: z.string().min(1), owner_id: z.string().nullable().optional().describe('The owning package (or the class/component a port belongs to).'), attributes: attributes.optional() },
    'element (package, class, interface, data type, enumeration, primitive type, component, port or actor)',
  ),
  ...umlWrites(
    'relationships',
    {
      kind: z.string().min(1).describe('One of the profile\'s relationship kinds (architecture.get_uml_profile).'),
      name: z.string().optional(),
      source: z.string().nullable().optional().describe('Element id (for a generalization: the specific one).'),
      target: z.string().nullable().optional().describe('Element id (for a generalization: the general one).'),
      ends: z.array(end).length(2).nullable().optional().describe('Association only: exactly two ends.'),
      connector_kind: z.string().nullable().optional().describe('Connector only.'),
    },
    'relationship',
  ),
  ...umlWrites(
    'interactions',
    {
      name: z.string().min(1),
      owner_id: z.string().nullable().optional(),
      lifelines: z.array(lifeline).optional(),
      occurrences: z.array(occurrence).optional().describe('In time order.'),
      messages: z.array(message).optional(),
      executions: z.array(execution).optional(),
      fragments: z.array(fragment).optional(),
    },
    'interaction (a sequence)',
  ),
  ...umlWrites(
    'diagrams',
    { kind: z.string().min(1).describe('class, component or sequence.'), name: z.string().min(1), documentation: z.string().max(100_000).nullable().optional() },
    'diagram (class, component or sequence)',
  ),
  ...occurrenceWrites('objects'),
  ...occurrenceWrites('connections'),
  write<z.infer<typeof traceCreateInput>>(
    'architecture.create_trace_link',
    'Link an item of this project to another item of this project (or to a place in the code): realizes, refines, traces_to, satisfies, implements or depends_on. Give either target_kind + target_id or code_repo + code_commit + code_symbol.',
    traceCreateInput,
    invokeCard('architecture.create_trace_link'),
    (i) => keyOf('architecture.create_trace_link', i, i.source_kind, i.source_id, i.link_type, i.target_kind, i.target_id, i.code_symbol),
    (i, ctx) => {
      const body: Record<string, unknown> = { source: { kind: i.source_kind, id: i.source_id }, link_type: i.link_type };
      if (i.target_kind && i.target_id) body.target = { kind: i.target_kind, id: i.target_id };
      else body.target_code = { repo: i.code_repo, commit: i.code_commit, symbol: i.code_symbol };
      if (i.note) body.note = i.note;
      return callRouteAsHuman(
        'architecture.create_trace_link',
        { method: 'POST', template: '/api/assets/architecture/modeling/trace-links', handler: lazyRoute(routes, 'handleCreateTraceLink'), params: {}, body },
        ctx,
      );
    },
  ),
  write<z.infer<typeof traceDeleteInput>>(
    'architecture.delete_trace_link',
    'Delete a trace link whose starting item belongs to this project.',
    traceDeleteInput,
    invokeCard('architecture.delete_trace_link'),
    (i) => keyOf('architecture.delete_trace_link', i, i.link_id),
    (i, ctx) =>
      callRouteAsHuman(
        'architecture.delete_trace_link',
        { method: 'DELETE', template: '/api/assets/architecture/modeling/trace-links/:lid', handler: lazyRoute(routes, 'handleDeleteTraceLink'), params: { lid: i.link_id } },
        ctx,
      ),
  ),
];

export const ARCHITECTURE_UML_ACTIONS: ReadonlyArray<AgentCallableAction<any, unknown>> = [...UML_READ_ACTIONS, ...UML_WRITE_ACTIONS];

function safeRegister<I, O>(a: AgentCallableAction<I, O>): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

/** Production registrar (called by `registerAllActions`). */
export function registerArchitectureUmlActions(): void {
  for (const a of ARCHITECTURE_UML_ACTIONS) safeRegister(a);
}
