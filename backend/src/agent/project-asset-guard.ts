/**
 * fr-agui SPEC §13 P2 (carried from P1c-a decision 7) — ASSET-BY-ID reads and
 * writes are checked against the BOUND project.
 *
 * `bindProjectInput` (agent/project-binding.ts) proves every PROJECT id the
 * model names is the bound one. It cannot prove that an ASSET id belongs to the
 * project: `requirements.get {rid}`, `toc.get_graph {tree_id}`,
 * `architecture.get_element {eid}` name no project at all. Inside a bound thread
 * this module answers that question for every project-agent action that
 * addresses an asset by id, and refuses 403 `project_mismatch` when the asset is
 * not the bound project's — before a proposal is shaped or a handler runs.
 *
 * What "the project's asset" means, per asset family (the SAME view the
 * project's list action gives the project agent, so a get can never show what
 * the list would not):
 *   governed assets   VISIBLE IN the project: bound to it, or bound to no
 *     (requirement,   project at all (fr asset bindings, `visible_in` —
 *      principle,     routes/assets/_lib/binding-filter.ts).
 *      decision)
 *   TOC trees /       the row's own `project_id` equals the bound project (the
 *   architecture      lists filter upstream on `project_id`; a tree or element
 *   rows              with no project, or another one, is refused).
 *   entity graph      an `architecture_elements` entity by its project; a
 *                     requirement / principle / decision by its visibility; any
 *                     other entity type cannot be attributed and is refused.
 *
 * NOT here, because the action proves it itself (listed in
 * `ASSET_BY_ID_HANDLER_SCOPED`, pinned by the guard test): `cards.get`,
 * `approvals.get(_document)` (project-core.ts), the `artifacts.*` reads (fetched
 * BY `(project_id, artifact_id)` upstream), `coding.get_job_status` /
 * `coding.get_findings` (the job is read by `(job_id, project_id)`),
 * `repositories.get` / `documents.get_status` (project-assets.ts).
 *
 * WHO: the project agent's own contexts only — the AG-UI rail (marked
 * server-side, `markAgentTokenContext`) and the human's confirm of one of its
 * proposals (`markConfirmedCard`, routes/capability-invoke.ts). Outside a bound
 * project (`ctx.projectId` null) and on every other caller (REST tools routes,
 * the channel grammar, a deferred approval) this is a no-op: those do not run
 * "inside a project conversation", and their own routes keep their own gates.
 */
import { isAgentTokenContext, isConfirmedCard } from '../agui/context-provenance';
import {
  getGetTraceLinkUrl,
  getGetUmlDiagramUrl,
  getGetUmlElementUrl,
  getGetUmlInteractionUrl,
  getGetUmlRelationshipUrl,
} from '@fr/service-client-requirements';
import { isProjectOwnedAsset } from '../routes/assets/_lib/governed-asset-write-gate';
import type { ActionContext } from '../agui/types';
import { AppError } from '../utils/errors';
import { ProjectMismatchError } from './project-binding';

type Visible = (input: Record<string, unknown>, projectId: string) => Promise<boolean>;

type GovernedKind = 'requirement' | 'principle' | 'decision';

/**
 * Read the asset upstream in the REQUEST tenant (the integrations send the frame
 * tenant; another tenant's id is the upstream's 404, which propagates). fr's
 * bind route does not tenant-verify the upstream kinds (routes/assets/bindings.ts
 * findForeignAssets), so a binding alone never proves the asset is the tenant's.
 */
async function readInTenant(kind: 'requirement' | 'principle' | 'decision', id: string): Promise<{ origin_kind?: unknown; origin_project_id?: unknown } | undefined> {
  const row =
    kind === 'requirement'
      ? await (await import('../integrations/requirements')).getRequirement(id)
      : kind === 'principle'
        ? await (await import('../integrations/principles')).getPrinciple(id)
        : await (await import('../integrations/decisions')).getDecision(id);
  return row as { origin_kind?: unknown; origin_project_id?: unknown } | undefined;
}

async function visibleInProject(kind: GovernedKind, id: string | number, projectId: string): Promise<boolean> {
  const { applyBindingFilter } = await import('../routes/assets/_lib/binding-filter');
  return (await applyBindingFilter(kind, [{ id }], { visible_in: projectId })).length > 0;
}

async function tocTreeProject(treeId: string): Promise<unknown> {
  const { getTocTree } = await import('../integrations/toc');
  return ((await getTocTree(treeId)) as { project_id?: unknown }).project_id;
}

async function architectureProject(kind: 'element' | 'relationship' | 'view' | 'standard', id: string): Promise<unknown> {
  const a = await import('../integrations/architecture');
  const row =
    kind === 'element'
      ? await a.getArchitectureElement(id)
      : kind === 'relationship'
        ? await a.getArchitectureRelationship(id)
        : kind === 'view'
          ? await a.getArchitectureView(id)
          : await a.getArchitectureStandard(id);
  return (row as { project_id?: unknown }).project_id;
}

/** The modeling model an ArchiMate element / relationship / view belongs to (its `model_id`), when it has one. */
async function architectureModelOf(kind: 'element' | 'relationship' | 'view', id: string): Promise<unknown> {
  const a = await import('../integrations/architecture');
  const row = kind === 'element' ? await a.getArchitectureElement(id) : kind === 'relationship' ? await a.getArchitectureRelationship(id) : await a.getArchitectureView(id);
  return (row as { model_id?: unknown }).model_id;
}

/** An ArchiMate model's project (the modeling lifecycle). */
async function modelingModelProject(modelId: string): Promise<unknown> {
  const a = await import('../integrations/architecture');
  return (await a.getModelingModel(modelId)).data.project_id;
}

/** A UML row's project (elements, relationships, interactions, diagrams carry their model's). */
async function umlProject(resource: 'elements' | 'relationships' | 'interactions' | 'diagrams', id: string): Promise<unknown> {
  const a = await import('../integrations/architecture');
  const url = {
    elements: getGetUmlElementUrl,
    relationships: getGetUmlRelationshipUrl,
    interactions: getGetUmlInteractionUrl,
    diagrams: getGetUmlDiagramUrl,
  }[resource](a.seg(id));
  return ((await a.rmCall<{ project_id?: unknown }>(url)).data ?? {}).project_id;
}

/** A trace link's starting item. */
async function traceLinkSource(id: string): Promise<{ kind: string; id: string } | null> {
  const a = await import('../integrations/architecture');
  const link = (await a.rmCall<{ source?: { kind?: unknown; id?: unknown } }>(getGetTraceLinkUrl(a.seg(id)))).data;
  const src = link?.source;
  return src && typeof src.kind === 'string' && typeof src.id === 'string' ? { kind: src.kind, id: src.id } : null;
}

/** The model a validation run or a change set belongs to. */
async function modelingParentModel(kind: 'run' | 'change_set', id: string): Promise<string> {
  const a = await import('../integrations/architecture');
  const row = kind === 'run' ? await a.getModelingValidationRun(id) : await a.getModelingChangeSet(id);
  return String((row as { model_id?: unknown }).model_id ?? '');
}

const sameProject = (v: unknown, projectId: string) => typeof v === 'string' && v.toLowerCase() === projectId.toLowerCase();
const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

const governed =
  (kind: GovernedKind, field: string): Visible =>
  async (input, projectId) => {
    const id = str(input[field]);
    return id !== '' && visibleInProject(kind, id, projectId);
  };

const tocTree: Visible = async (input, projectId) => {
  const id = str(input.tree_id);
  return id !== '' && sameProject(await tocTreeProject(id), projectId);
};

const arch =
  (kind: 'element' | 'relationship' | 'view' | 'standard', field: string): Visible =>
  async (input, projectId) => {
    const id = str(input[field]);
    return id !== '' && sameProject(await architectureProject(kind, id), projectId);
  };

/** An ArchiMate model (by `field`), or the model a run / change set belongs to: its `project_id` is the bound project. */
const modelingModel =
  (field: string): Visible =>
  async (input, projectId) => {
    const id = str(input[field]);
    return id !== '' && sameProject(await modelingModelProject(id), projectId);
  };
const modelingChild =
  (kind: 'run' | 'change_set', field: string): Visible =>
  async (input, projectId) => {
    const id = str(input[field]);
    if (id === '') return false;
    const modelId = await modelingParentModel(kind, id);
    return modelId !== '' && sameProject(await modelingModelProject(modelId), projectId);
  };
/**
 * A diagram: of a saved version (`model_id` AND `revision_id`, exactly when the
 * handler reads the version) by its model; otherwise the draft view, by the
 * view's own project. A `model_id` alone does not choose what is read, so it
 * never decides what is admitted.
 */
const modelingDiagram: Visible = async (input, projectId) =>
  str(input.model_id) !== '' && str(input.revision_id) !== ''
    ? modelingModel('model_id')(input, projectId)
    : arch('view', 'view_id')(input, projectId);

/**
 * An ArchiMate element / relationship / view (by `field`) of a model of the bound
 * project: the row's MODEL decides (its `project_id`), as for every other modeling
 * write. A row in no model is not this project's (fails closed).
 */
const archimateRow =
  (kind: 'element' | 'relationship' | 'view', field: string): Visible =>
  async (input, projectId) => {
    const id = str(input[field]);
    if (id === '') return false;
    const modelId = str(await architectureModelOf(kind, id));
    return modelId !== '' && sameProject(await modelingModelProject(modelId), projectId);
  };

type UmlRes = 'elements' | 'relationships' | 'interactions' | 'diagrams';
/** A UML row (by `field`) is the project's when its `project_id` is the bound project. */
const umlRow =
  (resource: UmlRes, field: string): Visible =>
  async (input, projectId) => {
    const id = str(input[field]);
    return id !== '' && sameProject(await umlProject(resource, id), projectId);
  };

/** One end of a trace link, by kind: a modeling row by its project, a governed asset by its visibility in the project. */
async function traceEndInProject(kind: string, id: string, projectId: string): Promise<boolean> {
  if (id === '') return false;
  switch (kind) {
    case 'element':
    case 'relationship':
    case 'view':
      return sameProject(await architectureProject(kind, id), projectId);
    case 'uml_element':
      return sameProject(await umlProject('elements', id), projectId);
    case 'uml_relationship':
      return sameProject(await umlProject('relationships', id), projectId);
    case 'interaction':
      return sameProject(await umlProject('interactions', id), projectId);
    case 'diagram':
      return sameProject(await umlProject('diagrams', id), projectId);
    case 'requirement':
    case 'principle':
    case 'decision':
      return visibleInProject(kind, id, projectId);
    default:
      return false;
  }
}
/**
 * `architecture.create_trace_link` (the AGENT): BOTH ends are items of this
 * project — the project agent never links into another project. (A person on
 * the item pages may still link across projects of the tenant.) A link to code
 * has no second item.
 */
const traceSource: Visible = async (input, projectId) => {
  if (!(await traceEndInProject(str(input.source_kind), str(input.source_id), projectId))) return false;
  const targetId = str(input.target_id);
  return targetId === '' || traceEndInProject(str(input.target_kind), targetId, projectId);
};
/** `architecture.delete_trace_link`: the link's starting item is this project's. */
const traceLink: Visible = async (input, projectId) => {
  const src = await traceLinkSource(str(input.link_id));
  return src !== null && traceEndInProject(src.kind, src.id, projectId);
};

const ENTITY_KIND: Readonly<Record<string, GovernedKind>> = {
  requirements: 'requirement',
  principles: 'principle',
  decisions: 'decision',
};

const entityGraph: Visible = async (input, projectId) => {
  const type = str(input.entity_type);
  const id = str(input.entity_id);
  if (id === '') return false;
  if (type === 'architecture_elements') return sameProject(await architectureProject('element', id), projectId);
  const kind = ENTITY_KIND[type];
  return kind !== undefined && visibleInProject(kind, id, projectId);
};

/** `agent.update_asset {asset_type, asset_id}`: the revised asset must be visible in the project. */
const updateAsset: Visible = async (input, projectId) => {
  const kind = str(input.asset_type);
  const id = str(input.asset_id);
  if (id === '' || !['requirement', 'principle', 'decision'].includes(kind)) return false;
  return visibleInProject(kind as GovernedKind, id, projectId);
};

/** `project_assets.edit {kind, asset_id}`: governed kinds. */
const projectAssetEdit: Visible = async (input, projectId) => {
  const kind = str(input.kind) as GovernedKind;
  if (!['requirement', 'principle', 'decision'].includes(kind)) return false;
  return governed(kind, 'asset_id')(input, projectId);
};

/** Every project-agent action that addresses an asset by id, and the field it names it by. */
export const ASSET_BY_ID: ReadonlyMap<string, { field: string; visible: Visible }> = new Map([
  ['requirements.get', { field: 'rid', visible: governed('requirement', 'rid') }],
  ['requirements.list_versions', { field: 'rid', visible: governed('requirement', 'rid') }],
  ['principles.get', { field: 'pid', visible: governed('principle', 'pid') }],
  ['principles.list_versions', { field: 'pid', visible: governed('principle', 'pid') }],
  ['decisions.get', { field: 'did', visible: governed('decision', 'did') }],
  ['decisions.list_versions', { field: 'did', visible: governed('decision', 'did') }],
  ['toc.get_tree', { field: 'tree_id', visible: tocTree }],
  ['toc.get_graph', { field: 'tree_id', visible: tocTree }],
  ['toc.get_quality', { field: 'tree_id', visible: tocTree }],
  ['architecture.get_element', { field: 'eid', visible: arch('element', 'eid') }],
  ['architecture.get_relationship', { field: 'rid', visible: arch('relationship', 'rid') }],
  ['architecture.get_view', { field: 'vid', visible: arch('view', 'vid') }],
  ['architecture.get_standard', { field: 'sid', visible: arch('standard', 'sid') }],
  ['architecture.get_entity_graph', { field: 'entity_id', visible: entityGraph }],
  ['agent.update_asset', { field: 'asset_id', visible: updateAsset }],
  ['project_assets.edit', { field: 'asset_id', visible: projectAssetEdit }],
  // G8 / R313: the copy must be visible in this project (governed kinds only).
  ['project_assets.request_promotion', { field: 'asset_id', visible: projectAssetEdit }],
  // The ArchiMate modeling lifecycle (agui/actions/architecture-modeling.ts): a model is the
  // project's when its `project_id` is the bound project; a run / change set by its model.
  // The writes also re-check in their handlers (`modelInProject`), after the human's Confirm.
  ...[
    'architecture.get_model',
    'architecture.list_model_revisions',
    'architecture.get_model_revision',
    'architecture.list_validation_runs',
    'architecture.list_revision_reviews',
    'architecture.list_model_publications',
    'architecture.list_change_sets',
    'architecture.export_model',
    'architecture.update_model',
    'architecture.delete_model',
    'architecture.seal_model_revision',
    'architecture.run_model_validation',
    'architecture.review_model_revision',
    'architecture.publish_model_revision',
    'architecture.import_model_exchange',
  ].map((n) => [n, { field: 'model_id', visible: modelingModel('model_id') }] as const),
  ['architecture.get_validation_run', { field: 'run_id', visible: modelingChild('run', 'run_id') }],
  ['architecture.list_validation_findings', { field: 'run_id', visible: modelingChild('run', 'run_id') }],
  ['architecture.get_change_set', { field: 'change_set_id', visible: modelingChild('change_set', 'change_set_id') }],
  ['architecture.apply_change_set', { field: 'change_set_id', visible: modelingChild('change_set', 'change_set_id') }],
  ['architecture.reject_change_set', { field: 'change_set_id', visible: modelingChild('change_set', 'change_set_id') }],
  // UML rows: by their own `project_id`; a diagram's shapes and lines by the diagram.
  ...(['element', 'relationship', 'interaction', 'diagram'] as const).flatMap((one) => {
    const res = `${one}s` as UmlRes;
    return [`architecture.get_uml_${one}`, `architecture.update_uml_${one}`, `architecture.delete_uml_${one}`].map(
      (n) => [n, { field: `${one}_id`, visible: umlRow(res, `${one}_id`) }] as const,
    );
  }),
  ...[
    'architecture.list_uml_diagram_objects',
    'architecture.list_uml_diagram_connections',
    'architecture.add_uml_diagram_object',
    'architecture.update_uml_diagram_object',
    'architecture.remove_uml_diagram_object',
    'architecture.add_uml_diagram_connection',
    'architecture.update_uml_diagram_connection',
    'architecture.remove_uml_diagram_connection',
  ].map((n) => [n, { field: 'diagram_id', visible: umlRow('diagrams', 'diagram_id') }] as const),
  ...['architecture.create_uml_element', 'architecture.create_uml_relationship', 'architecture.create_uml_interaction', 'architecture.create_uml_diagram'].map(
    (n) => [n, { field: 'model_id', visible: modelingModel('model_id') }] as const,
  ),
  // A saved version's picture (model_id + revision_id) by that model; the draft picture by the diagram.
  [
    'architecture.get_uml_diagram_picture',
    {
      field: 'diagram_id',
      visible: async (input, projectId) =>
        str(input.model_id) !== '' && str(input.revision_id) !== ''
          ? modelingModel('model_id')(input, projectId)
          : umlRow('diagrams', 'diagram_id')(input, projectId),
    },
  ],
  // The PNG download card: a saved version's picture by its model, else the view / UML diagram itself.
  [
    'architecture.download_diagram_png',
    {
      field: 'id',
      visible: async (input, projectId) =>
        str(input.model_id) !== '' && str(input.revision_id) !== ''
          ? modelingModel('model_id')(input, projectId)
          : str(input.kind) === 'uml_diagram'
            ? umlRow('diagrams', 'id')(input, projectId)
            : arch('view', 'id')(input, projectId),
    },
  ],
  ['architecture.create_trace_link', { field: 'source_id', visible: traceSource }],
  ['architecture.get_trace_link', { field: 'link_id', visible: traceLink }],
  ['architecture.list_trace_links', { field: 'item_id', visible: async (input, projectId) => traceEndInProject(str(input.item_kind), str(input.item_id), projectId) }],
  ['architecture.delete_trace_link', { field: 'link_id', visible: traceLink }],
  ['architecture.get_view_diagram', { field: 'view_id', visible: modelingDiagram }],
  // ArchiMate model contents (agui/actions/architecture-archimate.ts): a create names a model of
  // this project; a row (and a view's shapes / lines) by its model. The handlers re-check after Confirm.
  ...['architecture.create_element', 'architecture.create_view'].map((n) => [n, { field: 'model_id', visible: modelingModel('model_id') }] as const),
  ['architecture.create_relationship', { field: 'source_id', visible: archimateRow('element', 'source_id') }],
  ['architecture.delete_element', { field: 'element_id', visible: archimateRow('element', 'element_id') }],
  ['architecture.delete_relationship', { field: 'relationship_id', visible: archimateRow('relationship', 'relationship_id') }],
  ['architecture.delete_view', { field: 'view_id', visible: archimateRow('view', 'view_id') }],
  ...[
    'architecture.list_view_objects',
    'architecture.list_view_connections',
    'architecture.add_view_object',
    'architecture.add_view_connection',
    'architecture.remove_view_object',
    'architecture.remove_view_connection',
  ].map((n) => [n, { field: 'view_id', visible: archimateRow('view', 'view_id') }] as const),
]);

/** Project-agent actions that address something by id and prove its project in their own handler (see header). */
export const ASSET_BY_ID_HANDLER_SCOPED: ReadonlySet<string> = new Set([
  'cards.get',
  'approvals.get',
  'approvals.get_document',
  'approvals.decide',
  'kanban.add_comment',
  'artifacts.get',
  'artifacts.preview',
  'artifacts.manifest',
  'artifacts.download',
  'artifacts.review',
  'coding.get_job_status',
  'coding.get_findings',
  'coding.trigger_analysis',
  'repositories.get',
  'projects.detach_repository',
  'projects.set_primary_repository',
  'projects.attach_repository',
  'documents.get_status',
  // P2-c1: the asset-scope writes act AT THE BOUND PROJECT only (the handler sends
  // `[bound]` / the bound project; no input names a project) — the asset side is
  // the bind / override / block route's own (fr-local kinds tenant-verified,
  // upstream kinds read-path-gated; the override route refuses laundering).
  'project_assets.bind',
  'project_assets.unbind',
  'project_assets.override',
  'project_assets.block',
  // P2-c1: `repo_id` is resolved by the route under the bound project (a repo not
  // attached to it is the route's 404); `user_id` is a PERSON the route requires
  // to be a member of the project's tenant (else 404) — not an asset.
  'projects.get_quality_history',
  'projects.set_knowledge_allocation',
  // The card is looked up ON THE BOUND PROJECT'S BOARD (agui/actions/kanban-card.ts
  // `projectBoard`, tenant-member scoped); a card not on it is 404 `card_not_on_project_board`.
  'kanban.request_move',
]);

export const INHERITED_ASSET = 'inherited_asset_copy_on_write';

/**
 * OQ-16 (DECIDED a): inside a project, a REVISION may only target the
 * project's OWN asset — THE PUT/DELETE gate's definition (`isProjectOwnedAsset`,
 * routes/assets/_lib/governed-asset-write-gate.ts, George 2026-10-16): an asset
 * CREATED in the project (`origin_kind` 'project', `origin_project_id`).
 * ⛔ Neither a binding (the P2-b bind loophole) nor an override row (the
 * override-laundering blocker) is ownership — any member may write either. `agent.update_asset`
 * revises the asset it names upstream (its change card PUTs it at QA), so on an
 * inherited or shared asset it would change the workspace original — refused
 * 409 `inherited_asset_copy_on_write`, naming `project_assets.edit`, which makes
 * the project copy instead.
 */
export const OWNED_ONLY: ReadonlyMap<string, { kindField: string; idField: string }> = new Map([
  ['agent.update_asset', { kindField: 'asset_type', idField: 'asset_id' }],
]);

/**
 * Project-agent actions whose id-shaped input is a FILTER inside an answer that is
 * already the bound project's (the list is scoped by its injected project param),
 * or a navigation under the bound project's own path — nothing is read by that id
 * outside the project: `architecture.list_relationships` (source / target filters
 * on the project's relationships), `artifacts.list`, `coding.list_jobs` (repo
 * filter on the project's jobs), `n8n.list_executions` (workflow filter on the
 * caller's runs of this project), `ui.open_approval` (a URL under
 * /projects/<bound>/approve/…, whose page gates the approval itself).
 */
export const ID_FILTERS_WITHIN_PROJECT: ReadonlySet<string> = new Set([
  'architecture.list_relationships',
  'artifacts.list',
  'coding.list_jobs',
  'n8n.list_executions',
  'ui.open_approval',
  // The UML lists are bound to the project (`project_id`); `model_id` / `owner_id` filter inside that answer.
  'architecture.list_uml_elements',
  'architecture.list_uml_relationships',
  'architecture.list_uml_interactions',
  'architecture.list_uml_diagrams',
]);

/**
 * Refuse 403 `project_mismatch` unless the asset `action` addresses belongs to
 * the bound project. A no-op outside a bound context or for an action that
 * addresses no asset by id. An upstream error while resolving (the asset does
 * not exist, the upstream is down) propagates as itself — never an admit.
 */
export async function assertAssetInBoundProject(
  action: { name: string },
  input: unknown,
  ctx: ActionContext,
): Promise<void> {
  const projectId = ctx.projectId;
  if (!projectId) return;
  if (!isAgentTokenContext(ctx) && !isConfirmedCard(ctx)) return;
  const rule = ASSET_BY_ID.get(action.name);
  if (!rule) return;
  const base = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  // No asset named (the field is absent or blank): nothing to attribute — input
  // validation refuses a missing required id; this guard never admits one.
  if (str(base[rule.field]).trim() === '') return;
  if (!(await rule.visible(base, projectId))) throw new ProjectMismatchError(action.name, rule.field, projectId);
  const own = OWNED_ONLY.get(action.name);
  if (own) {
    const kind = str(base[own.kindField]) as GovernedKind;
    const assetId = str(base[own.idField]);
    // The P1-TEAM-a audit's open question ("is agent.update_asset's asset_id
    // validated against the caller's tenant downstream?"): it is, here — the
    // asset must READ in the request tenant before a change card is minted (a
    // failed read propagates as itself), and that read supplies its origin.
    const row = await readInTenant(kind as 'requirement' | 'principle' | 'decision', assetId);
    const owned = isProjectOwnedAsset({ originKind: row?.origin_kind, originProjectId: row?.origin_project_id, projectId });
    if (!owned) {
      throw new AppError(
        409,
        `${action.name}: this ${kind} is not the project's own copy (inherited, or only bound to the project), and revising it would change ` +
          'the workspace original (OQ-16). Use project_assets.edit, which edits a project copy instead.',
        { use: 'project_assets.edit' },
      ).withCode(INHERITED_ASSET);
    }
  }
}
