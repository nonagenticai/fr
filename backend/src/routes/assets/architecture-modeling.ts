// Architecture MODELING routes — requirements_management's ArchiMate modeling
// lifecycle (RM target spec §7 models / draft head / revisions / validation /
// review + publication, §8.1 rendering + exchange, §9.5 change sets) under
// `/api/assets/architecture/*`.
//
// Same conventions as routes/assets/architecture.ts: `validateAuth` first, the
// tenant comes from the request frame (the integration refuses to send without
// one), `{ data }` envelopes, 201 on a create, an empty 204 on a delete.
//
// What is new here:
//   * CONCURRENCY. A model has a draft `head`. fr forwards the caller's
//     `If-Match` (or a body `expected_head`, the agent's form) and relays RM's
//     `ETag` (the new head) on every response that carries one.
//   * REFUSALS IN PLAIN WORDS (`_lib/modeling-http.ts`, shared with the UML,
//     view-contents and ArchiMate routes). RM refuses with stable codes (`stale_head`,
//     `revision_not_validated`, `revision_not_approved`, …). `modelingRefusal`
//     relays the code and the status unchanged and replaces RM's developer
//     sentence with one a user can act on, plus the structured facts the UI
//     needs to offer the way out (`head` for a reload, `findings` for an
//     integrity refusal). Unknown codes fall through to the generic converter.
//   * fr IS A FACILITATOR. Nothing here computes a verdict: validation results,
//     review decisions and change-set status are RM's, shown as stored.
//
// The pure relays (lists, gets, publish, apply, exports, the SVG diagrams) are
// rows of the RM pass-through table (`_lib/rm-passthrough.ts`); the handlers
// below validate input first or carry fr behaviour of their own.

import { validateAuth } from '../../middleware/auth';
import {
  createModelingModel,
  deleteModelingModel,
  getModelingRuleset,
  importModelingExchange,
  patchModelingModel,
  rejectModelingChangeSet,
  reviewModelingRevision,
  runModelingValidation,
  sealModelingRevision,
} from '../../integrations/architecture';
import type {
  DeleteModelParams,
  ModelIn,
  ModelPatch,
  ReviewIn,
} from '@fr/service-client-requirements';
import { jsonResponse, noContentResponse } from '../../utils/response';
import { rmDownload, rmPassthrough } from './_lib/rm-passthrough';
import {
  badRequest,
  bodyObject,
  etagHeaders,
  expectedHeadOf,
  idempotencyKeyOf,
  modelingHandle,
  withoutExpectedHead,
} from './_lib/modeling-http';

/** Optional text from a body; anything but a string is a 400. RM checks the length and answers in words. */
function optionalString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw badRequest(`${field} must be text.`);
  return v;
}

function exchangeBody(body: Record<string, unknown>): { xml: string; filename?: string } {
  const xml = body.xml;
  if (typeof xml !== 'string' || xml.trim() === '') throw badRequest('Choose an ArchiMate exchange file (.xml) to import.');
  const filename = optionalString(body.filename, 'The file name');
  return { xml, ...(filename ? { filename } : {}) };
}

/** The language version a NEW model is created in, when the caller names none (fr's product default). */
const DEFAULT_LANGUAGE_VERSION: Record<ModelIn['language'], string> = { archimate: '3.2', uml: '2.5.1-p1' };

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export async function handleCreateArchitectureModel(req: Request): Promise<Response> {
  await validateAuth(req);
  const body = await bodyObject(req);
  const title = optionalString(body.title, 'The title')?.trim();
  if (!title) throw badRequest('Give the model a title.');
  const language = (body.language ?? 'archimate') as ModelIn['language'];
  if (!Object.hasOwn(DEFAULT_LANGUAGE_VERSION, String(language))) throw badRequest("The modeling language must be 'archimate' or 'uml'.");
  const input: ModelIn = {
    ...(withoutExpectedHead(body) as Partial<ModelIn>),
    language,
    language_version: optionalString(body.language_version, 'The language version')?.trim() || DEFAULT_LANGUAGE_VERSION[language],
    title,
  };
  return modelingHandle(
    () => createModelingModel(input, { 'Idempotency-Key': idempotencyKeyOf(req) }),
    (r) => jsonResponse({ data: r.data }, 201, etagHeaders(r.etag)),
  );
}

export async function handleUpdateArchitectureModel(req: Request, mid: string): Promise<Response> {
  await validateAuth(req);
  const body = await bodyObject(req);
  const ifMatch = expectedHeadOf(req, body);
  const patch = withoutExpectedHead(body) as ModelPatch;
  if ('title' in patch && !optionalString(patch.title, 'The title')?.trim()) throw badRequest('A model needs a title.');
  if (Object.keys(patch).length === 0) throw badRequest('Nothing to change: send a new title, description or visibility.');
  return modelingHandle(
    () => patchModelingModel(mid, patch, { 'If-Match': ifMatch }),
    (r) => jsonResponse({ data: r.data }, 200, etagHeaders(r.etag)),
  );
}

export async function handleDeleteArchitectureModel(req: Request, mid: string): Promise<Response> {
  await validateAuth(req);
  const params: DeleteModelParams = new URL(req.url).searchParams.get('force') === 'true' ? { force: true } : {};
  return modelingHandle(
    () => deleteModelingModel(mid, params),
    () => noContentResponse(),
  );
}

// ---------------------------------------------------------------------------
// Revisions, review, publication
// ---------------------------------------------------------------------------

export async function handleSealArchitectureModelRevision(req: Request, mid: string): Promise<Response> {
  await validateAuth(req);
  const body = await bodyObject(req);
  const ifMatch = expectedHeadOf(req, body);
  const label = optionalString(body.label, 'The label')?.trim();
  return modelingHandle(
    () => sealModelingRevision(mid, label ? { label } : {}, { 'If-Match': ifMatch }),
    (r) => jsonResponse({ data: r.data }, 201, etagHeaders(r.etag)),
  );
}

export async function handleReviewArchitectureModelRevision(req: Request, mid: string, rid: string): Promise<Response> {
  await validateAuth(req);
  const body = await bodyObject(req);
  const decision = body.decision;
  if (decision !== 'approve' && decision !== 'reject') throw badRequest("Choose 'approve' or 'reject'.");
  const reason = optionalString(body.reason, 'The reason')?.trim();
  if (decision === 'reject' && !reason) throw badRequest('Please say why you are rejecting this version.');
  const review: ReviewIn = { decision, ...(reason ? { reason } : {}) };
  return modelingHandle(
    () => reviewModelingRevision(mid, rid, review),
    (data) => jsonResponse({ data }, 201),
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export async function handleRunArchitectureModelValidation(req: Request, mid: string): Promise<Response> {
  await validateAuth(req);
  const body = await bodyObject(req);
  const revisionId = optionalString(body.revision_id, 'The version')?.trim();
  const rulesetId = optionalString(body.ruleset_id, 'The rule set')?.trim();
  return modelingHandle(
    () => runModelingValidation(mid, { ...(revisionId ? { revision_id: revisionId } : {}), ...(rulesetId ? { ruleset_id: rulesetId } : {}) }),
    (data) => jsonResponse({ data }, 201),
  );
}

export async function handleGetArchitectureRuleset(req: Request, ref: string): Promise<Response> {
  await validateAuth(req);
  return modelingHandle(
    () => getModelingRuleset(ref),
    (data) => jsonResponse({ data }),
  );
}

// ---------------------------------------------------------------------------
// Change sets
// ---------------------------------------------------------------------------

export async function handleRejectArchitectureChangeSet(req: Request, csid: string): Promise<Response> {
  await validateAuth(req);
  const body = await bodyObject(req);
  const reason = optionalString(body.reason, 'The reason')?.trim();
  if (!reason) throw badRequest('Please say why you are rejecting these changes.');
  return modelingHandle(
    () => rejectModelingChangeSet(csid, { reason }),
    (data) => jsonResponse({ data }),
  );
}

// ---------------------------------------------------------------------------
// Exchange
// ---------------------------------------------------------------------------

export async function handleImportIntoArchitectureModel(req: Request, mid: string): Promise<Response> {
  await validateAuth(req);
  const { xml, filename } = exchangeBody(await bodyObject(req));
  return modelingHandle(
    () => importModelingExchange({ modelId: mid, xml, ...(filename ? { filename } : {}), headers: { 'Idempotency-Key': idempotencyKeyOf(req) } }),
    (data) => jsonResponse({ data }, 201),
  );
}

export async function handleImportArchitectureModel(req: Request): Promise<Response> {
  await validateAuth(req);
  const body = await bodyObject(req);
  const { xml, filename } = exchangeBody(body);
  const projectId = optionalString(body.project_id, 'The project')?.trim();
  return modelingHandle(
    () =>
      importModelingExchange({
        xml,
        ...(filename ? { filename } : {}),
        ...(projectId ? { projectId } : {}),
        headers: { 'Idempotency-Key': idempotencyKeyOf(req) },
      }),
    (data) => jsonResponse({ data }, 201),
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Downloads (rm-passthrough.ts `rmDownload`): RM's bytes, type and file name.
export const handleDownloadArchitectureViewPng = rmDownload('renderArchitectureView', { format: 'png' });
export const handleDownloadArchitectureViewSvg = rmDownload('renderArchitectureView', { format: 'svg' });
export const handleDownloadArchitectureViewPdf = rmDownload('renderArchitectureView', { format: 'pdf' });
export const handleDownloadArchitectureRevisionViewPng = rmDownload('renderModelRevisionView', { format: 'png' });
export const handleDownloadArchitectureRevisionViewSvg = rmDownload('renderModelRevisionView', { format: 'svg' });
export const handleDownloadArchitectureRevisionViewPdf = rmDownload('renderModelRevisionView', { format: 'pdf' });
export const handleDownloadArchitectureModelPdf = rmDownload('exportModelDiagrams', { format: 'pdf' });
export const handleDownloadArchitectureModelSvgZip = rmDownload('exportModelDiagrams', { format: 'svg' });
export const handleDownloadArchitectureRevisionPdf = rmDownload('exportModelRevisionDiagrams', { format: 'pdf' });
export const handleDownloadArchitectureRevisionSvgZip = rmDownload('exportModelRevisionDiagrams', { format: 'svg' });
export const handleDownloadArchitectureModelXmi = rmDownload('exportModelXmi');
export const handleDownloadArchitectureRevisionXmi = rmDownload('exportModelRevisionXmi');

// ---------------------------------------------------------------------------
// Pure relays (routes/assets/_lib/rm-passthrough.ts)
// ---------------------------------------------------------------------------

export const handleListArchitectureModels = rmPassthrough('listModels');
export const handleGetArchitectureModel = rmPassthrough('getModel');
export const handleListArchitectureModelRevisions = rmPassthrough('listModelRevisions');
export const handleGetArchitectureModelRevision = rmPassthrough('getModelRevision');
export const handleListArchitectureRevisionReviews = rmPassthrough('listModelRevisionReviews');
export const handlePublishArchitectureModelRevision = rmPassthrough('publishModelRevision');
export const handleListArchitectureModelPublications = rmPassthrough('listModelPublications');
export const handleListArchitectureValidationRuns = rmPassthrough('listModelValidationRuns');
export const handleGetArchitectureValidationRun = rmPassthrough('getValidationRun');
export const handleListArchitectureValidationFindings = rmPassthrough('listValidationFindings');
export const handleListArchitectureRulesets = rmPassthrough('listRulesets');
export const handleListArchitectureChangeSets = rmPassthrough('listChangeSets');
export const handleGetArchitectureChangeSet = rmPassthrough('getChangeSet');
export const handleApplyArchitectureChangeSet = rmPassthrough('applyChangeSet');
export const handleExportArchitectureModel = rmPassthrough('exportModelExchange');
export const handleExportArchitectureModelRevision = rmPassthrough('exportModelRevisionExchange');
export const handleGetArchitectureViewDiagram = rmPassthrough('renderArchitectureView');
export const handleGetArchitectureRevisionViewDiagram = rmPassthrough('renderModelRevisionView');
