/**
 * The project agent's ArchiMate MODELING actions — every capability of the
 * Models pages (routes/assets/architecture-modeling.ts) as an agent tool
 * (George 2026-10-14: fr fully operable through the AG-UI agent).
 *
 * READS call requirements_management through integrations/architecture.ts,
 * like the sibling `architecture.*` reads (actions/architecture.ts). A model
 * is addressed by id; `architecture.list_models` is bound to the conversation's
 * project (agui/agent-surface.ts PROJECT_BINDING).
 *
 * WRITES are PROPOSED, never run by the agent: each is a confirm card, and on
 * the human's Confirm it runs the Models page's OWN route as the human
 * (`callRouteAsHuman`) — same identity, same refusals in the same words, so the
 * agent can never do more than the buttons. Every write is BOUND to the
 * conversation's project: `project_id` is injected, and a write on an existing
 * model (or change set) is refused unless that model belongs to this project
 * (`model_not_in_project`) — the agent never reaches another project's model.
 *
 * fr IS A FACILITATOR, NEVER A JUDGE (George 2026-10-12):
 *   - validation verdicts are RM's: `run_model_validation` asks RM to run the
 *     rules and returns what RM stored;
 *   - a review DECISION is the human's: `decision` and `reason` are
 *     `humanFields` on the `model-review` card, stripped from any proposal, so
 *     the agent can put a version in front of a reviewer but never decide;
 *   - deleting a model is DESTRUCTIVE: a `typed-confirm` card where the human
 *     types the model's title (`confirm_title`, re-checked here before anything
 *     is deleted);
 *   - an import is a FILE the human picks on the `model-import` card; the bytes
 *     go from the browser to the import route and never through the agent.
 */
import { z } from 'zod';
import {
  ListChangeSetsStatus,
  ListModelValidationRunsTarget,
  ListValidationFindingsSeverity,
  ModelInLanguage,
  ModelInVisibility,
  ReviewInDecision,
  getExportModelExchangeUrl,
  getExportModelRevisionExchangeUrl,
  getListChangeSetsUrl,
  getListModelPublicationsUrl,
  getListModelRevisionReviewsUrl,
  getListModelRevisionsUrl,
  getListModelValidationRunsUrl,
  getListModelsUrl,
  getListRulesetsUrl,
  getListValidationFindingsUrl,
  getGetModelRevisionUrl,
  getRenderArchitectureViewUrl,
  getRenderModelRevisionViewUrl,
  type ChangeSetOut,
  type ExchangeExportReport,
  type ListChangeSetsParams,
  type ListModelRevisionsParams,
  type ListModelValidationRunsParams,
  type ListModelsParams,
  type ListValidationFindingsParams,
  type ModelOut,
  type PublicationOut,
  type RenderReport,
  type ReviewOut,
  type RevisionDetail,
  type RevisionOut,
  type RulesetInfo,
  type ValidationFindingOut,
  type ValidationRunOut,
} from '@fr/service-client-requirements';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction, ProposalSpec } from '../types';
import { AppError } from '../../utils/errors';
import { bound, callRouteAsHuman, lazyRoute } from './project-core';
import { getModelingChangeSet, getModelingModel, getModelingRuleset, getModelingValidationRun, rmCall, seg } from '../../integrations/architecture';

const anyOut = z.unknown();
const routes = () => import('../../routes/assets/architecture-modeling');

/** `project_id`: the binding (hidden from the model; injected; required by the invoke route). */
export const projectId = z.string().uuid().describe('The project (set from this conversation; never chosen by the model).');
/** The card's own idempotency key (stable per proposal); never the model's. */
export const idempotencyKey = z.string().min(1).max(200).optional().describe('Set by the confirm card.');
const modelId = z.string().min(1).max(100).describe('The model id (from architecture.list_models).');
const revisionId = z.string().min(1).max(100).describe('The saved version (revision) id (from architecture.list_model_revisions).');

/** Strip undefined values; stringify the rest (query parameters). */
export function params(input: Record<string, string | number | boolean | undefined>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== '') out[k] = String(v);
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** One requirements_management read by its GENERATED url: the answer's body. */
async function rmData<T>(url: string, slow = false): Promise<T> {
  return (await rmCall<T>(url, slow ? { slow: true } : {})).data;
}

const READ = {
  kind: 'read' as const,
  approval: { type: 'auto' as const },
  cronSafe: true,
  rbac: { type: 'public' as const },
  output: anyOut,
};

export function read<I extends Record<string, unknown>>(
  name: string,
  description: string,
  input: z.ZodType<I>,
  handler: (i: I) => Promise<unknown>,
): AgentCallableAction<I, unknown> {
  return { ...READ, name, description, input, idempotencyKey: (i) => `${name}:${JSON.stringify(i)}`, handler: (i) => handler(i) };
}

/** A version's content as the agent needs it: counts and the views it can draw, not the whole manifest. */
export function revisionSummary(rev: Record<string, unknown>): Record<string, unknown> {
  const manifest = (rev.manifest ?? {}) as Record<string, unknown>;
  const arr = (k: string) => (Array.isArray(manifest[k]) ? (manifest[k] as Record<string, unknown>[]) : []);
  const { manifest: _omit, ...meta } = rev;
  const language = ((manifest.model ?? {}) as { language?: unknown }).language;
  if (language === 'uml') {
    // A UML version holds elements, relationships, interactions and diagrams (RM uml_manifest).
    return {
      ...meta,
      content: {
        elements: arr('elements').length,
        relationships: arr('relationships').length,
        interactions: arr('interactions').map((i) => ({ id: i.id, name: i.name })),
        diagrams: arr('diagrams').map((d) => ({ id: d.id, name: d.name, kind: d.kind })),
      },
    };
  }
  return {
    ...meta,
    content: {
      elements: arr('concepts').length,
      relationships: arr('relationships').length,
      views: arr('views').map((v) => ({ id: v.id, name: v.name, viewpoint: v.viewpoint })),
    },
  };
}

/** XML up to this size is returned inline to the agent; larger exports are downloaded from the model page. */
export const AGENT_EXPORT_INLINE_MAX = 64 * 1024;

export const MODELING_READ_ACTIONS: ReadonlyArray<AgentCallableAction<any, unknown>> = [
  read(
    'architecture.list_models',
    "List this project's architecture models (title, language, visibility, draft head, published version). Optional filters: language, q (title contains), limit, offset.",
    z.object({
      project_id: z.string().optional(),
      language: z.nativeEnum(ModelInLanguage).optional(),
      q: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    async (i) => ({ items: await rmData<ModelOut[]>(getListModelsUrl(params(i) as ListModelsParams | undefined)) }),
  ),
  read(
    'architecture.get_model',
    "One architecture model: its draft head (the number to pass as expected_head), latest saved version and the summary of its latest validation run, as stored by the modeling service.",
    z.object({ model_id: modelId }),
    async (i) => ({ item: (await getModelingModel(i.model_id)).data }),
  ),
  read(
    'architecture.list_model_revisions',
    "A model's saved versions (revisions), newest first: id, number, label, who saved it and when.",
    z.object({ model_id: modelId, limit: z.number().int().min(1).max(1000).optional(), offset: z.number().int().min(0).optional() }),
    async (i) => ({ items: await rmData<RevisionOut[]>(getListModelRevisionsUrl(seg(i.model_id), params({ limit: i.limit, offset: i.offset }) as ListModelRevisionsParams | undefined)) }),
  ),
  read(
    'architecture.get_model_revision',
    'A saved version: its metadata, how many elements and relationships it holds, and the views it can draw.',
    z.object({ model_id: modelId, revision_id: revisionId }),
    async (i) => ({ item: revisionSummary((await rmData<RevisionDetail>(getGetModelRevisionUrl(seg(i.model_id), seg(i.revision_id)))) as unknown as Record<string, unknown>) }),
  ),
  read(
    'architecture.list_validation_runs',
    "A model's validation runs, newest first, each with the modeling service's own verdict (status, counts, clean). Optional filters: target ('draft_head' | 'revision'), clean.",
    z.object({ model_id: modelId, target: z.nativeEnum(ListModelValidationRunsTarget).optional(), clean: z.boolean().optional() }),
    async (i) => ({ items: await rmData<ValidationRunOut[]>(getListModelValidationRunsUrl(seg(i.model_id), params({ target: i.target, clean: i.clean }) as ListModelValidationRunsParams | undefined)) }),
  ),
  read(
    'architecture.get_validation_run',
    'One validation run as the modeling service stored it: status (complete / incomplete / failed), counts by severity and whether it is clean.',
    z.object({ run_id: z.string().min(1).max(100) }),
    async (i) => ({ item: await getModelingValidationRun(i.run_id) }),
  ),
  read(
    'architecture.list_validation_findings',
    "A validation run's findings (rule, severity, message, the elements concerned). Optional filters: severity, rule_id, target_id, limit, offset.",
    z.object({
      run_id: z.string().min(1).max(100),
      severity: z.nativeEnum(ListValidationFindingsSeverity).optional(),
      rule_id: z.string().max(100).optional(),
      target_id: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    async ({ run_id, ...rest }) => ({ items: await rmData<ValidationFindingOut[]>(getListValidationFindingsUrl(seg(run_id), params(rest) as ListValidationFindingsParams | undefined)) }),
  ),
  read(
    'architecture.list_rulesets',
    'The sets of modeling rules a validation can use.',
    z.object({}),
    async () => ({ items: await rmData<RulesetInfo[]>(getListRulesetsUrl()) }),
  ),
  read(
    'architecture.get_ruleset',
    'One rule set with the title and description of each rule (use it to explain a finding in plain words).',
    z.object({ ruleset: z.string().min(1).max(200) }),
    async (i) => ({ item: await getModelingRuleset(i.ruleset) }),
  ),
  read(
    'architecture.list_revision_reviews',
    "A saved version's reviews, newest first (the newest is the version's current decision).",
    z.object({ model_id: modelId, revision_id: revisionId }),
    async (i) => ({ items: await rmData<ReviewOut[]>(getListModelRevisionReviewsUrl(seg(i.model_id), seg(i.revision_id))) }),
  ),
  read(
    'architecture.list_model_publications',
    "A model's publication history, newest first.",
    z.object({ model_id: modelId }),
    async (i) => ({ items: await rmData<PublicationOut[]>(getListModelPublicationsUrl(seg(i.model_id))) }),
  ),
  read(
    'architecture.list_change_sets',
    "A model's change sets (imported or proposed changes) with their status: proposed, invalid, applied or rejected.",
    z.object({ model_id: modelId, status: z.nativeEnum(ListChangeSetsStatus).optional() }),
    async (i) => ({ items: await rmData<ChangeSetOut[]>(getListChangeSetsUrl(seg(i.model_id), params({ status: i.status }) as ListChangeSetsParams | undefined)) }),
  ),
  read(
    'architecture.get_change_set',
    'One change set: its operations, status and the problems the modeling service found in it.',
    z.object({ change_set_id: z.string().min(1).max(100) }),
    async (i) => ({ item: await getModelingChangeSet(i.change_set_id) }),
  ),
  read(
    'architecture.get_view_diagram',
    "The drawing notes for a view's diagram (anything that could not be drawn as stored), current draft by default or as it was in a saved version. The picture itself is on the view's page.",
    z.object({ view_id: z.string().min(1).max(100), model_id: z.string().min(1).max(100).optional(), revision_id: z.string().min(1).max(100).optional() }),
    async (i) => {
      const svgReport = { format: 'svg', report: true } as const;
      const r = await rmData<RenderReport>(
        i.model_id && i.revision_id
          ? getRenderModelRevisionViewUrl(seg(i.model_id), seg(i.revision_id), seg(i.view_id), svgReport)
          : getRenderArchitectureViewUrl(seg(i.view_id), svgReport),
        true,
      );
      return { diagnostics: r.diagnostics, renderer_version: r.renderer_version, svg_bytes: r.svg.length };
    },
  ),
  read(
    'architecture.export_model',
    `A model (current draft, or a saved version) as an ArchiMate exchange file, with what the format could not carry ("losses"). The XML is returned when it is at most ${AGENT_EXPORT_INLINE_MAX / 1024} KB; larger files are downloaded from the model's page.`,
    z.object({ model_id: modelId, revision_id: z.string().min(1).max(100).optional() }),
    async (i) => {
      const r = await rmData<ExchangeExportReport>(
        i.revision_id
          ? getExportModelRevisionExchangeUrl(seg(i.model_id), seg(i.revision_id), { report: true })
          : getExportModelExchangeUrl(seg(i.model_id), { report: true }),
        true,
      );
      const bytes = new TextEncoder().encode(r.xml).byteLength;
      return {
        losses: r.losses,
        xml_bytes: bytes,
        ...(bytes <= AGENT_EXPORT_INLINE_MAX ? { xml: r.xml } : { note: "The file is too large to show here; download it from the model's page." }),
      };
    },
  ),
];

// ---------------------------------------------------------------------------
// Writes — proposed, confirmed on a card, run as the human through the route
// ---------------------------------------------------------------------------

export function invokeCard(name: string, card: ProposalSpec['card'] = 'capability-invoke', humanFields?: readonly string[]): ProposalSpec {
  return { http: { method: 'POST', path: `/api/capabilities/${name}/invoke` }, card, ...(humanFields ? { humanFields } : {}) };
}

export function write<I extends { project_id: string }>(
  name: string,
  description: string,
  input: z.ZodType<I>,
  confirm: ProposalSpec,
  key: (i: I) => string,
  run: (i: I, ctx: ActionContext, projectId: string) => Promise<unknown>,
): AgentCallableAction<I, unknown> {
  return {
    name,
    kind: 'write',
    description,
    input,
    output: anyOut,
    // The human's Confirm IS the approval (sole approver = the initiator): the
    // confirmed run executes inline; a non-human initiator still parks.
    approval: { type: 'single-approver', approver: 'initiator' },
    autoApproveForInitiator: true,
    cronSafe: false,
    rbac: { type: 'project-member' },
    projectParam: 'project_id',
    webOnly: true,
    confirm,
    idempotencyKey: key,
    handler: async (i, ctx) => run(i, ctx, bound(ctx, name)),
  };
}

export const MODEL_NOT_IN_PROJECT = 'model_not_in_project';

export const dataOf = (body: unknown): Record<string, unknown> =>
  ((body as { data?: unknown } | null)?.data ?? {}) as Record<string, unknown>;

/** The model, read as the human through its page's route; refused unless it belongs to THIS project. */
export async function modelInProject(action: string, model_id: string, pid: string, ctx: ActionContext): Promise<Record<string, unknown>> {
  const m = dataOf(
    await callRouteAsHuman(
      action,
      { method: 'GET', template: '/api/assets/architecture/modeling/models/:mid', handler: lazyRoute(routes, 'handleGetArchitectureModel'), params: { mid: model_id } },
      ctx,
    ),
  );
  if (m.project_id !== pid) {
    throw new AppError(403, 'This model does not belong to this project. Open it from the architecture library to change it.').withCode(
      MODEL_NOT_IN_PROJECT,
    );
  }
  return m;
}

export const keyOf = (name: string, i: { project_id: string; idempotency_key?: string }, ...parts: unknown[]) =>
  `${name}:${i.project_id}:${parts.map((p) => (p === undefined ? '' : String(p))).join(':')}:${i.idempotency_key ?? ''}`;

const createInput = z
  .object({
    project_id: projectId,
    title: z.string().min(1).describe('The model title.'),
    language: z.nativeEnum(ModelInLanguage).optional().describe("'archimate' (default): enterprise architecture; 'uml': classes, components, sequences."),
    description: z.string().optional(),
    visibility: z.nativeEnum(ModelInVisibility).optional().describe("'tenant' (default): everyone in the workspace can see it; 'user': only the person who confirms."),
    idempotency_key: idempotencyKey,
  })
  .strict();
const updateInput = z
  .object({
    project_id: projectId,
    model_id: modelId,
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    visibility: z.nativeEnum(ModelInVisibility).optional(),
    expected_head: z.number().int().min(0).optional().describe("The model's head from architecture.get_model; the change is refused if someone changed the model since."),
    idempotency_key: idempotencyKey,
  })
  .strict();
const deleteInput = z
  .object({
    project_id: projectId,
    model_id: modelId,
    force: z.boolean().optional().describe('Also delete every saved version, validation run and change set (needed when the model has saved versions).'),
    confirm_title: z.string().max(500).optional().describe("Typed by the human on the card: the model's title — never by the agent."),
    idempotency_key: idempotencyKey,
  })
  .strict();
const sealInput = z
  .object({
    project_id: projectId,
    model_id: modelId,
    label: z.string().optional().describe('A short label for the version, e.g. "Release 1".'),
    expected_head: z.number().int().min(0).optional(),
    idempotency_key: idempotencyKey,
  })
  .strict();
const validateInput = z
  .object({
    project_id: projectId,
    model_id: modelId,
    revision_id: z.string().min(1).max(100).optional().describe('Validate this saved version instead of the current draft.'),
    ruleset_id: z.string().min(1).max(200).optional().describe('Default: the current rules for the model language.'),
    idempotency_key: idempotencyKey,
  })
  .strict();
const reviewInput = z
  .object({
    project_id: projectId,
    model_id: modelId,
    revision_id: revisionId,
    decision: z.nativeEnum(ReviewInDecision).optional().describe('Chosen by the human on the card — never by the agent.'),
    reason: z.string().optional().describe('Written by the human on the card.'),
    idempotency_key: idempotencyKey,
  })
  .strict();
const publishInput = z.object({ project_id: projectId, model_id: modelId, revision_id: revisionId, idempotency_key: idempotencyKey }).strict();
const importInput = z
  .object({
    project_id: projectId,
    model_id: z.string().min(1).max(100).optional().describe('Import into this model; omit to create a new model from the file.'),
    purpose: z.string().max(500).optional().describe('What the file is, shown on the card.'),
    idempotency_key: idempotencyKey,
  })
  .strict();
const changeSetInput = z.object({ project_id: projectId, change_set_id: z.string().min(1).max(100), idempotency_key: idempotencyKey }).strict();
const rejectChangeSetInput = changeSetInput.extend({ reason: z.string().min(1).describe('Why the changes are rejected (the human can edit it on the card).') }).strict();

export const TYPED_CONFIRMATION_MISMATCH = 'typed_confirmation_mismatch';

/** The change set's model, checked against the project. */
async function changeSetInProject(action: string, csid: string, pid: string, ctx: ActionContext): Promise<void> {
  const cs = dataOf(
    await callRouteAsHuman(
      action,
      { method: 'GET', template: '/api/assets/architecture/modeling/change-sets/:csid', handler: lazyRoute(routes, 'handleGetArchitectureChangeSet'), params: { csid } },
      ctx,
    ),
  );
  await modelInProject(action, String(cs.model_id ?? ''), pid, ctx);
}

export const MODEL_IMPORT_CONFIRM: ProposalSpec = { http: { method: 'POST', path: '/api/assets/architecture/modeling/imports' }, card: 'model-import' };

export const MODELING_WRITE_ACTIONS: ReadonlyArray<AgentCallableAction<any, unknown>> = [
  write<z.infer<typeof createInput>>(
    'architecture.create_model',
    'Create an ArchiMate or UML model in THIS project (the Models page\'s New model). The user confirms on a card.',
    createInput,
    invokeCard('architecture.create_model'),
    (i) => keyOf('architecture.create_model', i, i.title),
    (i, ctx, pid) =>
      callRouteAsHuman(
        'architecture.create_model',
        {
          method: 'POST',
          template: '/api/assets/architecture/modeling/models',
          handler: lazyRoute(routes, 'handleCreateArchitectureModel'),
          params: {},
          body: { title: i.title, language: i.language ?? 'archimate', project_id: pid, ...(i.description !== undefined ? { description: i.description } : {}), ...(i.visibility ? { visibility: i.visibility } : {}) },
        },
        ctx,
      ),
  ),
  write<z.infer<typeof updateInput>>(
    'architecture.update_model',
    "Change a model's title, description or who can see it. Pass expected_head from architecture.get_model so a concurrent change is refused instead of overwritten.",
    updateInput,
    invokeCard('architecture.update_model'),
    (i) => keyOf('architecture.update_model', i, i.model_id, i.title, i.description, i.visibility, i.expected_head),
    async (i, ctx, pid) => {
      await modelInProject('architecture.update_model', i.model_id, pid, ctx);
      const body: Record<string, unknown> = {};
      if (i.title !== undefined) body.title = i.title;
      if (i.description !== undefined) body.description = i.description;
      if (i.visibility !== undefined) body.visibility = i.visibility;
      if (i.expected_head !== undefined) body.expected_head = i.expected_head;
      return callRouteAsHuman(
        'architecture.update_model',
        { method: 'PATCH', template: '/api/assets/architecture/modeling/models/:mid', handler: lazyRoute(routes, 'handleUpdateArchitectureModel'), params: { mid: i.model_id }, body },
        ctx,
      );
    },
  ),
  write<z.infer<typeof deleteInput>>(
    'architecture.delete_model',
    "Delete a model of this project — DESTRUCTIVE. The user confirms by TYPING the model's title on the card; you never fill it in. A model with saved versions is only deleted with force (every version, validation run and change set goes with it).",
    deleteInput,
    invokeCard('architecture.delete_model', 'typed-confirm', ['confirm_title']),
    (i) => keyOf('architecture.delete_model', i, i.model_id, i.force),
    async (i, ctx, pid) => {
      const m = await modelInProject('architecture.delete_model', i.model_id, pid, ctx);
      const title = typeof m.title === 'string' ? m.title.trim() : '';
      if (title === '' || (i.confirm_title ?? '').trim() !== title) {
        throw new AppError(422, "Type the model's exact title on the card to confirm the deletion.").withCode(TYPED_CONFIRMATION_MISMATCH);
      }
      await callRouteAsHuman(
        'architecture.delete_model',
        {
          method: 'DELETE',
          template: '/api/assets/architecture/modeling/models/:mid',
          handler: lazyRoute(routes, 'handleDeleteArchitectureModel'),
          params: { mid: i.model_id },
          query: { force: i.force ? 'true' : undefined },
        },
        ctx,
      );
      return { deleted: i.model_id, title };
    },
  ),
  write<z.infer<typeof sealInput>>(
    'architecture.seal_model_revision',
    "Save the model's current draft as a version that can no longer change (needed before a review or publication).",
    sealInput,
    invokeCard('architecture.seal_model_revision'),
    (i) => keyOf('architecture.seal_model_revision', i, i.model_id, i.label, i.expected_head),
    async (i, ctx, pid) => {
      await modelInProject('architecture.seal_model_revision', i.model_id, pid, ctx);
      return callRouteAsHuman(
        'architecture.seal_model_revision',
        {
          method: 'POST',
          template: '/api/assets/architecture/modeling/models/:mid/revisions',
          handler: lazyRoute(routes, 'handleSealArchitectureModelRevision'),
          params: { mid: i.model_id },
          body: { ...(i.label ? { label: i.label } : {}), ...(i.expected_head !== undefined ? { expected_head: i.expected_head } : {}) },
        },
        ctx,
      );
    },
  ),
  write<z.infer<typeof validateInput>>(
    'architecture.run_model_validation',
    "Ask the modeling service to check a model (current draft, or a saved version) against the modeling rules. It stores the result; report its status, counts and clean flag as returned — never your own judgement.",
    validateInput,
    invokeCard('architecture.run_model_validation'),
    (i) => keyOf('architecture.run_model_validation', i, i.model_id, i.revision_id, i.ruleset_id),
    async (i, ctx, pid) => {
      await modelInProject('architecture.run_model_validation', i.model_id, pid, ctx);
      return callRouteAsHuman(
        'architecture.run_model_validation',
        {
          method: 'POST',
          template: '/api/assets/architecture/modeling/models/:mid/validation-runs',
          handler: lazyRoute(routes, 'handleRunArchitectureModelValidation'),
          params: { mid: i.model_id },
          body: { ...(i.revision_id ? { revision_id: i.revision_id } : {}), ...(i.ruleset_id ? { ruleset_id: i.ruleset_id } : {}) },
        },
        ctx,
      );
    },
  ),
  write<z.infer<typeof reviewInput>>(
    'architecture.review_model_revision',
    'Offer the user a card to review a saved version. The USER chooses approve or reject and writes the reason on the card; you never choose or pre-fill the decision.',
    reviewInput,
    invokeCard('architecture.review_model_revision', 'model-review', ['decision', 'reason']),
    (i) => keyOf('architecture.review_model_revision', i, i.model_id, i.revision_id),
    async (i, ctx, pid) => {
      if (i.decision !== 'approve' && i.decision !== 'reject') {
        throw new AppError(422, 'Choose approve or reject on the card.').withCode('review_decision_required');
      }
      await modelInProject('architecture.review_model_revision', i.model_id, pid, ctx);
      return callRouteAsHuman(
        'architecture.review_model_revision',
        {
          method: 'POST',
          template: '/api/assets/architecture/modeling/models/:mid/revisions/:rid/reviews',
          handler: lazyRoute(routes, 'handleReviewArchitectureModelRevision'),
          params: { mid: i.model_id, rid: i.revision_id },
          body: { decision: i.decision, ...(i.reason ? { reason: i.reason } : {}) },
        },
        ctx,
      );
    },
  ),
  write<z.infer<typeof publishInput>>(
    'architecture.publish_model_revision',
    'Publish a saved version that a reviewer approved and that passed a complete, error-free validation. If it is refused, tell the user the reason returned.',
    publishInput,
    invokeCard('architecture.publish_model_revision'),
    (i) => keyOf('architecture.publish_model_revision', i, i.model_id, i.revision_id),
    async (i, ctx, pid) => {
      await modelInProject('architecture.publish_model_revision', i.model_id, pid, ctx);
      return callRouteAsHuman(
        'architecture.publish_model_revision',
        {
          method: 'POST',
          template: '/api/assets/architecture/modeling/models/:mid/revisions/:rid/publish',
          handler: lazyRoute(routes, 'handlePublishArchitectureModelRevision'),
          params: { mid: i.model_id, rid: i.revision_id },
        },
        ctx,
      );
    },
  ),
  {
    name: 'architecture.import_model_exchange',
    kind: 'write',
    description:
      "Offer the user a card to import an ArchiMate exchange file (.xml) into a model of this project, or as a new model. The user picks the file on the card; you never see its contents. The import is staged as a change set: nothing changes until it is applied (architecture.apply_change_set).",
    input: importInput,
    output: anyOut,
    approval: { type: 'single-approver', approver: 'initiator' },
    autoApproveForInitiator: true,
    cronSafe: false,
    rbac: { type: 'project-member' },
    projectParam: 'project_id',
    webOnly: true,
    confirm: MODEL_IMPORT_CONFIRM,
    idempotencyKey: (i: z.infer<typeof importInput>) => keyOf('architecture.import_model_exchange', i, i.model_id, i.purpose),
    handler: async () => {
      throw new AppError(409, 'The file goes from the browser to the import route through its card; this action never runs itself.').withCode(
        'file_card_only',
      );
    },
  } satisfies AgentCallableAction<z.infer<typeof importInput>, unknown>,
  write<z.infer<typeof changeSetInput>>(
    'architecture.apply_change_set',
    'Apply a proposed change set (for example an import) to its model. Refused if the model changed since it was staged: then re-import.',
    changeSetInput,
    invokeCard('architecture.apply_change_set'),
    (i) => keyOf('architecture.apply_change_set', i, i.change_set_id),
    async (i, ctx, pid) => {
      await changeSetInProject('architecture.apply_change_set', i.change_set_id, pid, ctx);
      return callRouteAsHuman(
        'architecture.apply_change_set',
        { method: 'POST', template: '/api/assets/architecture/modeling/change-sets/:csid/apply', handler: lazyRoute(routes, 'handleApplyArchitectureChangeSet'), params: { csid: i.change_set_id } },
        ctx,
      );
    },
  ),
  write<z.infer<typeof rejectChangeSetInput>>(
    'architecture.reject_change_set',
    'Reject a proposed change set so it can no longer be applied. A reason is required.',
    rejectChangeSetInput,
    invokeCard('architecture.reject_change_set'),
    (i) => keyOf('architecture.reject_change_set', i, i.change_set_id),
    async (i, ctx, pid) => {
      await changeSetInProject('architecture.reject_change_set', i.change_set_id, pid, ctx);
      return callRouteAsHuman(
        'architecture.reject_change_set',
        {
          method: 'POST',
          template: '/api/assets/architecture/modeling/change-sets/:csid/reject',
          handler: lazyRoute(routes, 'handleRejectArchitectureChangeSet'),
          params: { csid: i.change_set_id },
          body: { reason: i.reason },
        },
        ctx,
      );
    },
  ),
];

/** Every action this module registers. */
export const ARCHITECTURE_MODELING_ACTIONS: ReadonlyArray<AgentCallableAction<any, unknown>> = [
  ...MODELING_READ_ACTIONS,
  ...MODELING_WRITE_ACTIONS,
];

function safeRegister<I, O>(a: AgentCallableAction<I, O>): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

/** Production registrar (called by `registerAllActions`). */
export function registerArchitectureModelingActions(): void {
  for (const a of ARCHITECTURE_MODELING_ACTIONS) safeRegister(a);
}

