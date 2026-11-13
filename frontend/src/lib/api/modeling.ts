// Client for the ArchiMate MODELING routes (backend routes/assets/architecture-modeling.ts),
// which proxy requirements_management's modeling lifecycle: models, saved
// versions, validation runs + findings, reviews + publication, change sets,
// exchange import/export and diagram rendering.
//
// fr is a FACILITATOR: every verdict this module returns (a run's `clean`,
// `status`, `counts`; a change set's `status` and findings; a review decision)
// is the one requirements_management stored. Nothing here computes one.
//
// Refusals arrive as `ModelingError`: the backend keeps RM's status and code
// (`stale_head`, `revision_not_validated`, …) and supplies a plain-language
// message, plus `head` (the current draft head, for a reload) and `findings`
// (for an integrity refusal).

import { authFetch } from './auth-fetch';

// ⭐ Every RM shape below is the GENERATED one (`@fr/service-client-requirements`,
// from requirements_management's live openapi.json), imported as types only.
// fr's routes relay RM's rows inside fr's `{ data }` envelope, unchanged. Where
// RM declares a nested object as untyped (`additionalProperties: true`), fr
// narrows it to the fields it reads, named `…View`; those are listed for the RM
// follow-up that types them, after which the narrowing goes.
import type {
  ArchimateConceptOut,
  ArchimateConceptsOut,
  ArchitectureElementOut,
  ArchitectureRelationshipOut,
  ArchitectureViewOut,
  Bounds,
  ChangeSetOut,
  ChangeSetOutStatus,
  CodeRef,
  ExchangeExportReport,
  ExchangeImportOut,
  ExchangeLossOut,
  ModelDetail,
  ModelInLanguage,
  ModelInVisibility,
  ModelPatch,
  PublicationOut,
  RenderReport,
  ReviewOut,
  RevisionOut,
  RuleInfo as RmRuleInfo,
  RulesetInfo,
  TraceLinkInLinkType,
  TraceLinkOut,
  TraceRef,
  TraceRefKind,
  UmlAssociationEnd,
  UmlDiagramConnectionOut,
  UmlDiagramObjectOut,
  UmlDiagramOut,
  UmlElementAttributes,
  UmlElementOut,
  UmlInteractionOut,
  UmlLifeline as RmUmlLifeline,
  UmlMessage as RmUmlMessage,
  UmlOperation as RmUmlOperation,
  UmlParameter as RmUmlParameter,
  UmlProperty as RmUmlProperty,
  UmlRelationshipOut,
  ValidationFindingOut,
  ValidationFindingOutSeverity,
  ValidationRunOut,
  ViewConnectionOut,
  ViewObjectOut,
} from '@fr/service-client-requirements';

export type ModelVisibility = ModelInVisibility;
/** A model edit: RM's GENERATED `ModelPatch` (PATCH /modeling/models/{id}). */
export type { ModelPatch };
export type ModelLanguage = ModelInLanguage;
export type Severity = ValidationFindingOutSeverity;

/** A finding's target: RM types `targets` items as untyped objects; fr reads kind + id. */
export interface FindingTargetView {
  kind: string;
  id: string;
}
export type ValidationFinding = Omit<ValidationFindingOut, 'targets'> & { targets: FindingTargetView[] };
export type ValidationRun = ValidationRunOut;
/** `latest_validation_run` is an untyped object in RM: fr reads the run's own fields from it. */
export type ArchitectureModel = Omit<ModelDetail, 'latest_validation_run'> & { latest_validation_run?: Partial<ValidationRun> | null };
/** A version's manifest is untyped in RM; fr reads the concept / relationship / view lists. */
export interface RevisionManifestView {
  model?: { language?: string; [key: string]: unknown };
  concepts?: Array<{ id: string; type?: string; name?: string }>;
  relationships?: Array<{ id: string; type?: string }>;
  views?: Array<{ id: string; name?: string; viewpoint?: string }>;
  [key: string]: unknown;
}
/** A list answers `RevisionOut`; one version (`RevisionDetail`) adds its manifest. */
export type ModelRevision = RevisionOut & { manifest?: RevisionManifestView };
export type RuleInfo = RmRuleInfo;
export type Ruleset = RulesetInfo;
export type ModelReview = ReviewOut;
export type ModelPublication = PublicationOut;
export type ChangeSetStatus = ChangeSetOutStatus;
/** A change-set op is untyped in RM; fr reads these fields. */
export interface ChangeOpView {
  op: string;
  kind: string;
  id?: string | null;
  attributes?: Record<string, unknown> | null;
}
export type ChangeSet = Omit<ChangeSetOut, 'ops' | 'findings' | 'blocking_findings'> & {
  ops: ChangeOpView[];
  findings: ValidationFinding[];
  blocking_findings: ValidationFinding[];
};
export type ExchangeLoss = ExchangeLossOut;
export type ExchangeImport = Omit<ExchangeImportOut, 'change_set'> & { change_set: ChangeSet };
export type ExchangeExport = ExchangeExportReport;
export type DiagramReport = RenderReport;

export class ModelingError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** The model's current draft head, on a `stale_head` refusal. */
  readonly head: number | undefined;
  /** Integrity problems RM reported with a `model_integrity` refusal. */
  readonly findings: ValidationFinding[] | undefined;
  constructor(message: string, status: number, code?: string, head?: number, findings?: ValidationFinding[]) {
    super(message);
    this.name = 'ModelingError';
    this.status = status;
    this.code = code;
    this.head = head;
    this.findings = findings;
  }
}

/** The fallback sentence when a refusal carries no message of its own. */
function fallbackMessage(status: number): string {
  if (status === 404) return 'This item no longer exists. It may have been deleted.';
  if (status === 403) return 'You do not have access to this.';
  if (status === 401) return 'Your session has ended. Sign in again.';
  if (status >= 500) return 'The modeling service is not answering right now. Try again in a moment.';
  return 'The request could not be completed. Try again.';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<{ data: T; res: Response }> {
  const res = await authFetch(path, init);
  if (res.status === 204) return { data: undefined as T, res };
  const text = await res.text();
  let body: { data?: T; error?: unknown } | null = null;
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text) as { data?: T; error?: unknown };
    } catch (err) {
      // A success we cannot read is a failure, never an empty result.
      if (res.ok) throw new ModelingError('The modeling service sent an answer that could not be read. Try again.', 502, 'unreadable_answer');
      // A refusal without a JSON body still has its status: the fallback sentence below says it.
      console.warn('[modeling] a refusal without a readable body', res.status, err);
    }
  }
  if (!res.ok) {
    const raw = body?.error;
    const e = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const code = typeof raw === 'string' ? raw : typeof e.code === 'string' ? e.code : undefined;
    const message = typeof e.message === 'string' && e.message ? e.message : fallbackMessage(res.status);
    throw new ModelingError(
      message,
      res.status,
      code,
      typeof e.head === 'number' ? e.head : undefined,
      Array.isArray(e.findings) ? (e.findings as ValidationFinding[]) : undefined,
    );
  }
  return { data: (body && 'data' in body ? body.data : body) as T, res };
}

const enc = encodeURIComponent;
const json = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const qs = (params: Record<string, string | undefined>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : '';
};

// Models ---------------------------------------------------------------------

export async function listModels(filters: { project_id?: string; language?: string; q?: string } = {}): Promise<{
  items: ArchitectureModel[];
  truncated: boolean;
}> {
  const { data, res } = await request<ArchitectureModel[]>(`/api/assets/architecture/modeling/models${qs(filters)}`);
  return { items: data ?? [], truncated: res.headers.get('X-Truncated') === 'true' };
}

export async function getModel(id: string): Promise<ArchitectureModel> {
  return (await request<ArchitectureModel>(`/api/assets/architecture/modeling/models/${enc(id)}`)).data;
}

export async function createModel(input: {
  title: string;
  description?: string;
  project_id?: string;
  visibility?: ModelVisibility;
  language?: 'archimate' | 'uml';
}, idempotencyKey: string): Promise<ArchitectureModel> {
  return (
    await request<ArchitectureModel>(
      '/api/assets/architecture/modeling/models',
      json('POST', { ...input, language: input.language ?? 'archimate' }, { 'Idempotency-Key': idempotencyKey }),
    )
  ).data;
}

/** `expectedHead`: the head the user last saw; a concurrent change is refused (412) instead of overwritten. */
export async function updateModel(
  id: string,
  patch: ModelPatch,
  expectedHead?: number,
): Promise<ArchitectureModel> {
  const headers: Record<string, string> = expectedHead !== undefined ? { 'If-Match': `"${expectedHead}"` } : {};
  return (await request<ArchitectureModel>(`/api/assets/architecture/modeling/models/${enc(id)}`, json('PATCH', patch, headers))).data;
}

export async function deleteModel(id: string, force = false): Promise<void> {
  await request<void>(`/api/assets/architecture/modeling/models/${enc(id)}${force ? '?force=true' : ''}`, { method: 'DELETE' });
}

// Versions, reviews, publication -------------------------------------------------

export async function listRevisions(modelId: string): Promise<ModelRevision[]> {
  return (await request<ModelRevision[]>(`/api/assets/architecture/modeling/models/${enc(modelId)}/revisions`)).data ?? [];
}

export async function sealRevision(modelId: string, label: string | undefined, expectedHead?: number): Promise<ModelRevision> {
  const headers: Record<string, string> = expectedHead !== undefined ? { 'If-Match': `"${expectedHead}"` } : {};
  return (await request<ModelRevision>(`/api/assets/architecture/modeling/models/${enc(modelId)}/revisions`, json('POST', label ? { label } : {}, headers))).data;
}

export async function getRevision(modelId: string, revisionId: string): Promise<ModelRevision> {
  return (await request<ModelRevision>(`/api/assets/architecture/modeling/models/${enc(modelId)}/revisions/${enc(revisionId)}`)).data;
}

export async function listReviews(modelId: string, revisionId: string): Promise<ModelReview[]> {
  return (await request<ModelReview[]>(`/api/assets/architecture/modeling/models/${enc(modelId)}/revisions/${enc(revisionId)}/reviews`)).data ?? [];
}

export async function reviewRevision(
  modelId: string,
  revisionId: string,
  decision: 'approve' | 'reject',
  reason?: string,
): Promise<ModelReview> {
  return (
    await request<ModelReview>(
      `/api/assets/architecture/modeling/models/${enc(modelId)}/revisions/${enc(revisionId)}/reviews`,
      json('POST', { decision, ...(reason ? { reason } : {}) }),
    )
  ).data;
}

export async function publishRevision(modelId: string, revisionId: string): Promise<ModelPublication> {
  return (await request<ModelPublication>(`/api/assets/architecture/modeling/models/${enc(modelId)}/revisions/${enc(revisionId)}/publish`, { method: 'POST' })).data;
}

export async function listPublications(modelId: string): Promise<ModelPublication[]> {
  return (await request<ModelPublication[]>(`/api/assets/architecture/modeling/models/${enc(modelId)}/publications`)).data ?? [];
}

// Validation -----------------------------------------------------------------

export async function listValidationRuns(modelId: string): Promise<ValidationRun[]> {
  return (await request<ValidationRun[]>(`/api/assets/architecture/modeling/models/${enc(modelId)}/validation-runs`)).data ?? [];
}

export async function runValidation(modelId: string, revisionId?: string): Promise<ValidationRun> {
  return (
    await request<ValidationRun>(`/api/assets/architecture/modeling/models/${enc(modelId)}/validation-runs`, json('POST', revisionId ? { revision_id: revisionId } : {}))
  ).data;
}

export async function getValidationRun(runId: string): Promise<ValidationRun> {
  return (await request<ValidationRun>(`/api/assets/architecture/modeling/validation-runs/${enc(runId)}`)).data;
}

export async function listFindings(
  runId: string,
  filters: { severity?: Severity; rule_id?: string } = {},
): Promise<{ items: ValidationFinding[]; truncated: boolean }> {
  const { data, res } = await request<ValidationFinding[]>(
    `/api/assets/architecture/modeling/validation-runs/${enc(runId)}/findings${qs({ ...filters, limit: '1000' })}`,
  );
  return { items: data ?? [], truncated: res.headers.get('X-Truncated') === 'true' };
}

export async function getRuleset(ref: string): Promise<Ruleset> {
  return (await request<Ruleset>(`/api/assets/architecture/modeling/rulesets/${enc(ref)}`)).data;
}

// Change sets ----------------------------------------------------------------

export async function listChangeSets(modelId: string): Promise<ChangeSet[]> {
  return (await request<ChangeSet[]>(`/api/assets/architecture/modeling/models/${enc(modelId)}/change-sets`)).data ?? [];
}

export async function getChangeSet(id: string): Promise<ChangeSet> {
  return (await request<ChangeSet>(`/api/assets/architecture/modeling/change-sets/${enc(id)}`)).data;
}

export async function applyChangeSet(id: string): Promise<ChangeSet> {
  return (await request<ChangeSet>(`/api/assets/architecture/modeling/change-sets/${enc(id)}/apply`, { method: 'POST' })).data;
}

export async function rejectChangeSet(id: string, reason: string): Promise<ChangeSet> {
  return (await request<ChangeSet>(`/api/assets/architecture/modeling/change-sets/${enc(id)}/reject`, json('POST', { reason }))).data;
}

// Exchange -------------------------------------------------------------------

export async function exportModel(modelId: string, revisionId?: string): Promise<ExchangeExport> {
  const path = revisionId
    ? `/api/assets/architecture/modeling/models/${enc(modelId)}/revisions/${enc(revisionId)}/exchange`
    : `/api/assets/architecture/modeling/models/${enc(modelId)}/exchange`;
  return (await request<ExchangeExport>(path)).data;
}

/** Import into `modelId`, or (none) as a new model in `projectId`'s scope. Staged as a change set. */
export async function importExchange(opts: {
  modelId?: string;
  xml: string;
  filename?: string;
  projectId?: string;
  /** One per import the user asked for: a retry of the same request reuses it. */
  idempotencyKey: string;
}): Promise<ExchangeImport> {
  const path = opts.modelId ? `/api/assets/architecture/modeling/models/${enc(opts.modelId)}/exchange-imports` : `/api/assets/architecture/modeling/imports`;
  const body: Record<string, unknown> = { xml: opts.xml };
  if (opts.filename) body.filename = opts.filename;
  if (!opts.modelId && opts.projectId) body.project_id = opts.projectId;
  return (await request<ExchangeImport>(path, json('POST', body, { 'Idempotency-Key': opts.idempotencyKey }))).data;
}

// Diagrams -------------------------------------------------------------------

/** An ArchiMate view (`viewId`) or a UML diagram (`umlDiagramId`); with `modelId` + `revisionId`, as that saved version holds it. */
export interface DiagramRef {
  viewId?: string;
  umlDiagramId?: string;
  modelId?: string;
  revisionId?: string;
}

function diagramPath(ref: DiagramRef): string {
  const saved = ref.modelId && ref.revisionId;
  if (ref.umlDiagramId) {
    return saved
      ? `/api/assets/architecture/modeling/models/${enc(ref.modelId!)}/revisions/${enc(ref.revisionId!)}/uml-diagrams/${enc(ref.umlDiagramId)}/picture`
      : `/api/assets/architecture/modeling/uml/diagrams/${enc(ref.umlDiagramId)}/picture`;
  }
  const view = ref.viewId ?? '';
  return saved
    ? `/api/assets/architecture/modeling/models/${enc(ref.modelId!)}/revisions/${enc(ref.revisionId!)}/views/${enc(view)}/diagram`
    : `/api/assets/architecture/views/${enc(view)}/diagram`;
}

export async function getDiagram(ref: DiagramRef): Promise<DiagramReport> {
  return (await request<DiagramReport>(diagramPath(ref))).data;
}

/** A diagram's download formats, as fr's download routes name them (`…/png`, `…/svg`, `…/pdf`). */
export type DiagramFormat = 'png' | 'svg' | 'pdf';

/** A diagram as a file: requirements_management's bytes, relayed unchanged by fr. */
export async function downloadDiagram(ref: DiagramRef, format: DiagramFormat): Promise<Blob> {
  return await downloadFile(`${diagramPath(ref)}/${format}`);
}

/**
 * A model's downloads: every view (ArchiMate) or diagram (UML) in one PDF or in
 * one zip of SVGs, and a UML model's XMI file. With `revisionId`, the saved
 * version; otherwise the current draft.
 */
export type ModelDownload = 'pdf' | 'svg' | 'xmi';

export async function downloadModel(modelId: string, download: ModelDownload, revisionId?: string): Promise<Blob> {
  const model = `/api/assets/architecture/modeling/models/${enc(modelId)}${revisionId ? `/revisions/${enc(revisionId)}` : ''}`;
  return await downloadFile(download === 'xmi' ? `${model}/xmi` : `${model}/export/${download}`);
}

/** The file-name ending of each model download (the SVG export is a zip). */
export const MODEL_DOWNLOAD_SUFFIX: Record<ModelDownload, string> = { pdf: '.pdf', svg: '.zip', xmi: '.xmi' };

/**
 * The standard exchange format of a model's language: XMI for UML, the Open
 * Group exchange file (.xml) for ArchiMate — the language a model has when none
 * is stated (fr's create default).
 */
export function exchangeFormatOf(language: string | null | undefined): 'xmi' | 'archimate-exchange' {
  return language === 'uml' ? 'xmi' : 'archimate-exchange';
}

async function downloadFile(path: string): Promise<Blob> {
  const res = await authFetch(path);
  if (!res.ok) {
    let message = fallbackMessage(res.status);
    let code: string | undefined;
    try {
      const b = (await res.json()) as { error?: { message?: string; code?: string } };
      if (b.error?.message) message = b.error.message;
      code = b.error?.code;
    } catch {
      /* the body is not JSON: keep the fallback sentence */
    }
    throw new ModelingError(message, res.status, code);
  }
  return await res.blob();
}

// Helpers shared by the pages -------------------------------------------------

/**
 * One Idempotency-Key per thing the user asked for. Take a key when the form
 * opens (or the action starts) and reuse it for every retry of that same
 * request, so a retried create is answered with the first one's result instead
 * of creating twice; take a new key only for a new intent.
 */
export function newIntentKey(): string {
  return crypto.randomUUID();
}

/** Save `content` as a file in the browser. */
export function saveFile(content: Blob | string, filename: string, type = 'application/xml'): void {
  const blob = typeof content === 'string' ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A file-system-safe file name from a title. */
export function fileNameOf(title: string, suffix: string): string {
  const base = title.trim().replace(/[^A-Za-z0-9._ -]+/g, '').replace(/\s+/g, '-').slice(0, 80) || 'model';
  return `${base}${suffix}`;
}

// UML (profile uml-2.5.1-p1) ------------------------------------------------------

export const UML_ELEMENT_KINDS = ['package', 'class', 'interface', 'data_type', 'enumeration', 'primitive_type', 'component', 'port', 'actor'] as const;
export const UML_RELATIONSHIP_KINDS = ['association', 'generalization', 'interface_realization', 'realization', 'dependency', 'usage', 'connector'] as const;
export const UML_DIAGRAM_KINDS = ['class', 'component', 'sequence'] as const;
export const UML_MESSAGE_KINDS = ['synch_call', 'asynch_call', 'asynch_signal', 'reply', 'create', 'delete'] as const;
export type UmlResource = 'elements' | 'relationships' | 'interactions' | 'diagrams';

export type UmlProperty = RmUmlProperty;
export type UmlParameter = RmUmlParameter;
export type UmlOperation = RmUmlOperation;
export type UmlAttributes = UmlElementAttributes;
export type UmlElement = Omit<UmlElementOut, 'attributes'> & { attributes: UmlAttributes };
export type UmlEnd = UmlAssociationEnd;
export type UmlRelationship = Omit<UmlRelationshipOut, 'ends'> & { ends: UmlEnd[] | null };
export type UmlLifeline = RmUmlLifeline;
export type UmlMessage = RmUmlMessage;
/** RM types an interaction's lists as untyped objects; fr reads the profile's own item shapes. */
export type UmlInteraction = Omit<UmlInteractionOut, 'lifelines' | 'occurrences' | 'messages' | 'executions' | 'fragments'> & {
  lifelines: UmlLifeline[];
  occurrences: Array<{ id: string; lifeline: string }>;
  messages: UmlMessage[];
  executions: Array<{ id: string; lifeline: string; start: string; finish: string }>;
  fragments: Array<Record<string, unknown>>;
};
export type UmlDiagram = UmlDiagramOut;
export type UmlDiagramObject = Omit<UmlDiagramObjectOut, 'bounds'> & { bounds: Bounds | null };
export type UmlDiagramConnection = UmlDiagramConnectionOut;
/** RM answers a UML delete with an untyped object; fr reads what cascaded. */
export interface UmlDeleted {
  cascaded?: Record<string, string[]>;
}

/** Each UML collection's route, spelled out (the API census reads these literals). */
const UML_PATHS: Record<UmlResource, string> = {
  elements: '/api/assets/architecture/modeling/uml/elements',
  relationships: '/api/assets/architecture/modeling/uml/relationships',
  interactions: '/api/assets/architecture/modeling/uml/interactions',
  diagrams: '/api/assets/architecture/modeling/uml/diagrams',
};
const ifMatch = (head?: number): Record<string, string> => (head !== undefined ? { 'If-Match': `"${head}"` } : {});

export async function listUml<T>(resource: UmlResource, filters: Record<string, string | undefined> = {}): Promise<T[]> {
  return (await request<T[]>(`${UML_PATHS[resource]}${qs({ ...filters, limit: '1000' })}`)).data ?? [];
}
export async function getUml<T>(resource: UmlResource, id: string): Promise<T> {
  return (await request<T>(`${UML_PATHS[resource]}/${enc(id)}`)).data;
}
export async function createUml<T>(resource: UmlResource, body: Record<string, unknown>, idempotencyKey: string, head?: number): Promise<T> {
  return (await request<T>(UML_PATHS[resource], json('POST', body, { 'Idempotency-Key': idempotencyKey, ...ifMatch(head) }))).data;
}
/** PUT replaces the row: send the whole row's editable fields. */
export async function updateUml<T>(resource: UmlResource, id: string, body: Record<string, unknown>, head?: number): Promise<T> {
  return (await request<T>(`${UML_PATHS[resource]}/${enc(id)}`, json('PUT', body, ifMatch(head)))).data;
}
export async function deleteUml(resource: UmlResource, id: string, head?: number): Promise<UmlDeleted> {
  return (await request<UmlDeleted>(`${UML_PATHS[resource]}/${enc(id)}`, { method: 'DELETE', headers: ifMatch(head) })).data ?? {};
}
export async function listDiagramObjects(diagramId: string): Promise<UmlDiagramObject[]> {
  return (await request<UmlDiagramObject[]>(`/api/assets/architecture/modeling/uml/diagrams/${enc(diagramId)}/objects`)).data ?? [];
}
export async function listDiagramConnections(diagramId: string): Promise<UmlDiagramConnection[]> {
  return (await request<UmlDiagramConnection[]>(`/api/assets/architecture/modeling/uml/diagrams/${enc(diagramId)}/connections`)).data ?? [];
}
export async function addDiagramObject(diagramId: string, body: Record<string, unknown>, idempotencyKey: string): Promise<UmlDiagramObject> {
  return (await request<UmlDiagramObject>(`/api/assets/architecture/modeling/uml/diagrams/${enc(diagramId)}/objects`, json('POST', body, { 'Idempotency-Key': idempotencyKey }))).data;
}
export async function removeDiagramObject(diagramId: string, objectId: string): Promise<UmlDeleted> {
  return (await request<UmlDeleted>(`/api/assets/architecture/modeling/uml/diagrams/${enc(diagramId)}/objects/${enc(objectId)}`, { method: 'DELETE' })).data ?? {};
}
export async function addDiagramConnection(diagramId: string, body: Record<string, unknown>, idempotencyKey: string): Promise<UmlDiagramConnection> {
  return (await request<UmlDiagramConnection>(`/api/assets/architecture/modeling/uml/diagrams/${enc(diagramId)}/connections`, json('POST', body, { 'Idempotency-Key': idempotencyKey }))).data;
}
export async function removeDiagramConnection(diagramId: string, connectionId: string): Promise<UmlDeleted> {
  return (await request<UmlDeleted>(`/api/assets/architecture/modeling/uml/diagrams/${enc(diagramId)}/connections/${enc(connectionId)}`, { method: 'DELETE' })).data ?? {};
}

// ArchiMate model contents (elements, relationships, views + their shapes and lines) -----
//
// Rows of an ArchiMate model live in requirements_management's `/architecture/*`
// tables, each carrying its `model_id`; fr proxies them under
// `/api/assets/architecture/*`. A create names the model (`model_id`; a
// relationship joins its source element's model), sends the head the user saw
// (`If-Match`), one Idempotency-Key per user intent, and the model's visibility
// (`X-Visibility`: a row joins only a model of its own visibility). A view's
// shapes and lines take If-Match only: RM declares no Idempotency-Key on them.

export type ArchimateElement = ArchitectureElementOut;
export type ArchimateRelationship = ArchitectureRelationshipOut;
export type ArchimateView = ArchitectureViewOut;
export type ViewBounds = Required<Bounds>;
export type ArchimateViewObject = ViewObjectOut;
export type ArchimateViewConnection = ViewConnectionOut;
export type MetamodelConcept = ArchimateConceptOut;
export type MetamodelConcepts = ArchimateConceptsOut;
export type ArchimateResource = 'elements' | 'relationships' | 'views';

/** Each ArchiMate collection's route, spelled out (the API census reads these literals). */
const ARCHIMATE_PATHS: Record<ArchimateResource, string> = {
  elements: '/api/assets/architecture/elements',
  relationships: '/api/assets/architecture/relationships',
  views: '/api/assets/architecture/views',
};

/**
 * The rows of one ArchiMate model, plus whether the upstream page was CAPPED.
 *
 * `model_id` is sent as the list filter (for relationships: whose source
 * element is in the model), but the rows are also matched on their own
 * `model_id`: requirements_management's list routes do not all apply the filter
 * yet, so one page can carry other models' rows.
 *
 * ⚠️ That local filter is NOT a completeness claim. The upstream serves at most
 * one page (fr asks for 1,000 rows and the upstream clamps there), so a model
 * larger than one page comes back partial — and until 2026-10-29 this function
 * threw the `X-Truncated` header away, so the panel rendered the first page as
 * the whole model and elements beyond it were invisible to the pickers. Callers
 * MUST render `truncated`; it is the upstream's own answer to "is there more".
 */
export async function listArchimate<T extends { model_id?: string | null }>(
  resource: ArchimateResource,
  modelId: string,
): Promise<{ items: T[]; truncated: boolean }> {
  const { data, res } = await request<T[]>(`${ARCHIMATE_PATHS[resource]}${qs({ model_id: modelId, limit: '1000' })}`);
  return {
    items: (data ?? []).filter((r) => r.model_id === modelId),
    truncated: res.headers.get('X-Truncated') === 'true',
  };
}

interface CreateOpts {
  idempotencyKey: string;
  head?: number;
  visibility?: string;
}
const createHeaders = (o: CreateOpts): Record<string, string> => ({
  'Idempotency-Key': o.idempotencyKey,
  ...ifMatch(o.head),
  ...(o.visibility === 'user' || o.visibility === 'tenant' ? { 'X-Visibility': o.visibility } : {}),
});

export async function createArchimateElement(
  input: { model_id: string; title: string; element_type: string; layer: string; project_id?: string | null },
  opts: CreateOpts,
): Promise<ArchimateElement> {
  const { project_id, ...rest } = input;
  const body = { ...rest, ...(project_id ? { project_id } : {}) };
  return (await request<ArchimateElement>(ARCHIMATE_PATHS.elements, json('POST', body, createHeaders(opts)))).data;
}

/** A relationship between two elements of the model; it joins its source's model. A metamodel violation is 422 `model_integrity` + findings. */
export async function createArchimateRelationship(
  input: { source_id: string; target_id: string; relationship_type: string; project_id?: string | null },
  opts: CreateOpts,
): Promise<ArchimateRelationship> {
  const body = {
    source_entity_type: 'architecture_elements',
    source_id: input.source_id,
    target_entity_type: 'architecture_elements',
    target_id: input.target_id,
    relationship_type: input.relationship_type,
    ...(input.project_id ? { project_id: input.project_id } : {}),
  };
  return (await request<ArchimateRelationship>(ARCHIMATE_PATHS.relationships, json('POST', body, createHeaders(opts)))).data;
}

export async function createArchimateView(
  input: { model_id: string; title: string; viewpoint?: string | null; project_id?: string | null },
  opts: CreateOpts,
): Promise<ArchimateView> {
  const body: Record<string, unknown> = { model_id: input.model_id, title: input.title };
  if (input.viewpoint) body.viewpoint = input.viewpoint;
  if (input.project_id) body.project_id = input.project_id;
  return (await request<ArchimateView>(ARCHIMATE_PATHS.views, json('POST', body, createHeaders(opts)))).data;
}

export async function getArchimate<T>(resource: ArchimateResource, id: string): Promise<T> {
  return (await request<T>(`${ARCHIMATE_PATHS[resource]}/${enc(id)}`)).data;
}

/**
 * Delete an element (its relationships and the shapes showing it go with it), a relationship or a view.
 *
 * ⚠️ NO precondition is sent: RM's delete route reads no `If-Match` (and fr's
 * proxy passes none), so these deletes are LAST-WRITE-WINS. If someone else
 * renamed or otherwise edited the row between this page's read and the delete,
 * their edit is discarded — no 412, no Reload prompt. The shape/line routes
 * (add/remove object/connection) DO carry the head; the create routes do too.
 */
export async function deleteArchimate(resource: ArchimateResource, id: string): Promise<void> {
  await request<void>(`${ARCHIMATE_PATHS[resource]}/${enc(id)}`, { method: 'DELETE' });
}

export async function listViewObjects(viewId: string): Promise<ArchimateViewObject[]> {
  return (await request<ArchimateViewObject[]>(`/api/assets/architecture/views/${enc(viewId)}/objects`)).data ?? [];
}
export async function listViewConnections(viewId: string): Promise<ArchimateViewConnection[]> {
  return (await request<ArchimateViewConnection[]>(`/api/assets/architecture/views/${enc(viewId)}/connections`)).data ?? [];
}
/**
 * Show an element of the view's model on the view.
 *
 * ⚠️ RM takes NO Idempotency-Key here (nor for a line), so none is sent: a
 * create whose outcome is unknown (no answer, a 5xx) may have landed, and the
 * caller must re-read the view before offering the same add again.
 */
export async function addViewObject(viewId: string, body: { concept_ref: string; bounds: ViewBounds }, opts: { head?: number } = {}): Promise<ArchimateViewObject> {
  return (await request<ArchimateViewObject>(`/api/assets/architecture/views/${enc(viewId)}/objects`, json('POST', { kind: 'element', ...body }, ifMatch(opts.head)))).data;
}
/** Remove a shape (and the lines attached to it); the element stays in the model. */
export async function removeViewObject(viewId: string, objectId: string, head?: number): Promise<void> {
  await request<unknown>(`/api/assets/architecture/views/${enc(viewId)}/objects/${enc(objectId)}`, { method: 'DELETE', headers: ifMatch(head) });
}
/** Draw a relationship between the two shapes showing its ends (no Idempotency-Key: see addViewObject). */
export async function addViewConnection(
  viewId: string,
  body: { relationship_ref: string; source_object_id: string; target_object_id: string },
  opts: { head?: number } = {},
): Promise<ArchimateViewConnection> {
  return (await request<ArchimateViewConnection>(`/api/assets/architecture/views/${enc(viewId)}/connections`, json('POST', { kind: 'relationship', ...body }, ifMatch(opts.head)))).data;
}
export async function removeViewConnection(viewId: string, connectionId: string, head?: number): Promise<void> {
  await request<unknown>(`/api/assets/architecture/views/${enc(viewId)}/connections/${enc(connectionId)}`, { method: 'DELETE', headers: ifMatch(head) });
}

export async function getMetamodelConcepts(): Promise<MetamodelConcepts> {
  return (await request<MetamodelConcepts>('/api/assets/architecture/metamodel/concepts')).data;
}
/** The relationship types ArchiMate allows from `sourceType` to `targetType`. */
export async function allowedRelationshipTypes(sourceType: string, targetType: string): Promise<string[]> {
  const cells = (await request<Array<{ source_type: string; target_type: string; allowed: string[] }>>(`/api/assets/architecture/metamodel/relationships${qs({ source_type: sourceType, target_type: targetType })}`)).data ?? [];
  return cells.find((c) => c.source_type === sourceType && c.target_type === targetType)?.allowed ?? [];
}

// Trace links (§7.4) ---------------------------------------------------------------

export type TraceKind = TraceRefKind;
export type TraceLinkType = TraceLinkInLinkType;
/** RM types a link's ends as untyped objects; they are the same `TraceRef` / `CodeRef` it accepts. */
export type TraceLink = Omit<TraceLinkOut, 'source' | 'target' | 'target_code'> & {
  source: TraceRef;
  target: TraceRef | null;
  target_code: CodeRef | null;
};

export async function listTraceLinks(filters: { source_id?: string; target_id?: string; link_type?: string } = {}): Promise<{ items: TraceLink[]; truncated: boolean }> {
  const { data, res } = await request<TraceLink[]>(`/api/assets/architecture/modeling/trace-links${qs({ ...filters, limit: '1000' })}`);
  return { items: data ?? [], truncated: res.headers.get('X-Truncated') === 'true' };
}

/** Every link that starts or ends at `id` (two reads, merged, each link once). */
export async function traceLinksOf(id: string): Promise<{ items: TraceLink[]; truncated: boolean }> {
  const [from, to] = await Promise.all([listTraceLinks({ source_id: id }), listTraceLinks({ target_id: id })]);
  const seen = new Set<string>();
  const items = [...from.items, ...to.items].filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
  return { items, truncated: from.truncated || to.truncated };
}

export async function createTraceLink(input: {
  source: { kind: TraceKind; id: string };
  link_type: TraceLinkType;
  target?: { kind: TraceKind; id: string };
  target_code?: { repo: string; commit: string; symbol: string };
  note?: string;
}): Promise<TraceLink> {
  return (await request<TraceLink>('/api/assets/architecture/modeling/trace-links', json('POST', input))).data;
}

export async function deleteTraceLink(id: string): Promise<void> {
  await request<unknown>(`/api/assets/architecture/modeling/trace-links/${enc(id)}`, { method: 'DELETE' });
}
