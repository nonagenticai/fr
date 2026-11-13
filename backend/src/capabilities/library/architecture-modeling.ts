// The ArchiMate MODELING lifecycle (RM target spec §7, §8.1, §9.5) — the 40 routes
// behind the Models pages (routes/assets/architecture-modeling.ts), declared as
// capabilities. Kept apart from library/architecture.ts (the P4a3 spec drain of the
// pre-existing 19 CRUD routes, whose tests pin that set exactly).
//
// Same tenant rule and response family as the architecture CRUD routes. Their
// agent actions are hand-written in agui/actions/architecture-modeling.ts
// (project-bound writes confirmed on a card, reads in the project agent); the
// capabilities themselves derive no action, like every other library row.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';
import {
  ListChangeSetsStatus,
  ListModelValidationRunsTarget,
  ListValidationFindingsSeverity,
  ModelInLanguage, ModelInVisibility, ModelPatchVisibility, ReviewInDecision, TraceLinkInLinkType, TraceRefKind, type OperationName } from '@fr/service-client-requirements';

import type { Capability } from '../define';
import { isAuthenticatedUserInFrameTenant } from '../rbac-rules';
import { dataEnvelope, libraryCapabilities, pathId, proxyResponses, rmRequestModel, routeRule, type LibraryRoute } from './_shared';

const listOutput = z.object({ data: z.array(z.unknown()) });
const view = z.object({ vid: pathId('Architecture view id') });

const MODELS = '/api/assets/architecture/modeling/models';
const model = z.object({ mid: pathId('Model id') });
const revision = model.extend({ rid: pathId('Model version (revision) id') });
const revisionView = revision.extend({ vid: pathId('View id inside that version') });
const run = z.object({ runId: pathId('Validation run id') });
const changeSet = z.object({ csid: pathId('Change set id') });
const ruleset = z.object({ ref: pathId('Rule set id or reference') });
const expectedHead = z
  .union([z.number().int().min(0), z.string()])
  .optional()
  .describe("The model head the caller last read (same as an `If-Match` header). A mismatch is 412 `stale_head` with the current `head`.");
const page = {
  limit: z.string().optional().describe('Rows per page: default 200, max 1000 (`X-Applied-Limit` / `X-Truncated` report the cap).'),
  offset: z.string().optional().describe('Rows to skip.'),
};
const exchangeIn = {
  xml: z.string().min(1).describe('The Open Group ArchiMate exchange document (XML text, at most 25 MB; larger is 413).'),
  filename: z.string().optional().describe('The original file name, recorded with the import.'),
};
const MODELING_REFUSALS =
  " Modeling refusals keep RM's status and code with a plain-language `message`: 412 `stale_head` (+ `head`), 409 " +
  "`model_has_revisions`, `revision_not_approved`, `revision_not_validated`, " +
  "`revision_already_published`, `change_set_not_proposed`; 422 `model_integrity` (+ `findings`), `review_reason_required`, `exchange_invalid`, " +
  '`input_too_large`; 413 `exchange_too_large`.';

const MODELING_ROUTES: LibraryRoute[] = [
  { id: 'architecture.list_models', method: 'GET', path: MODELS, handler: 'handleListArchitectureModels', summary: 'List architecture models', effect: 'read', input: z.object({ ...page, language: z.nativeEnum(ModelInLanguage).optional(), project_id: z.string().optional().describe('Only the models of this project.'), q: z.string().optional().describe('Title contains.') }), output: listOutput },
  { id: 'architecture.create_model', method: 'POST', path: MODELS, handler: 'handleCreateArchitectureModel', summary: 'Create an architecture model', effect: 'write', successStatus: 201, input: z.object({ title: z.string().min(1), description: z.string().optional(), language: z.nativeEnum(ModelInLanguage).optional().describe("Default 'archimate'."), language_version: z.string().optional().describe("Default '3.2' for ArchiMate, '2.5.1-p1' for UML."), project_id: z.string().optional(), visibility: z.nativeEnum(ModelInVisibility).optional().describe("'tenant': everyone in the workspace; 'user': only the creator.") }) },
  { id: 'architecture.get_model', method: 'GET', path: `${MODELS}/:mid`, handler: 'handleGetArchitectureModel', summary: "An architecture model, its draft head (also the `ETag`), latest version and latest validation", effect: 'read', input: model },
  { id: 'architecture.update_model', method: 'PATCH', path: `${MODELS}/:mid`, handler: 'handleUpdateArchitectureModel', summary: "Change a model's title, description or visibility (honours `If-Match`)", effect: 'write', input: model.extend({ title: z.string().min(1).optional(), description: z.string().nullable().optional(), visibility: z.nativeEnum(ModelPatchVisibility).optional(), expected_head: expectedHead }) },
  { id: 'architecture.delete_model', method: 'DELETE', path: `${MODELS}/:mid`, handler: 'handleDeleteArchitectureModel', summary: 'Delete a model (409 `model_has_revisions` unless `force=true`, which deletes every version, run and change set too)', effect: 'destructive', successStatus: 204, input: model.extend({ force: z.enum(['true', 'false']).optional() }) },
  { id: 'architecture.list_model_revisions', method: 'GET', path: `${MODELS}/:mid/revisions`, handler: 'handleListArchitectureModelRevisions', summary: "A model's saved versions, newest first", effect: 'read', input: model.extend(page), output: listOutput },
  { id: 'architecture.seal_model_revision', method: 'POST', path: `${MODELS}/:mid/revisions`, handler: 'handleSealArchitectureModelRevision', summary: 'Save the current draft as an immutable version (honours `If-Match`)', effect: 'write', successStatus: 201, input: model.extend({ label: z.string().optional(), expected_head: expectedHead }) },
  { id: 'architecture.get_model_revision', method: 'GET', path: `${MODELS}/:mid/revisions/:rid`, handler: 'handleGetArchitectureModelRevision', summary: 'A saved version with its full content', effect: 'read', input: revision },
  { id: 'architecture.list_revision_reviews', method: 'GET', path: `${MODELS}/:mid/revisions/:rid/reviews`, handler: 'handleListArchitectureRevisionReviews', summary: "A version's reviews, newest first (the newest is its decision)", effect: 'read', input: revision, output: listOutput },
  { id: 'architecture.review_model_revision', method: 'POST', path: `${MODELS}/:mid/revisions/:rid/reviews`, handler: 'handleReviewArchitectureModelRevision', summary: "Record an approval or rejection of a version (a rejection needs a reason)", effect: 'write', successStatus: 201, input: revision.extend({ decision: z.nativeEnum(ReviewInDecision), reason: z.string().optional() }) },
  { id: 'architecture.publish_model_revision', method: 'POST', path: `${MODELS}/:mid/revisions/:rid/publish`, handler: 'handlePublishArchitectureModelRevision', summary: 'Publish an approved, cleanly validated version', effect: 'write', successStatus: 201, input: revision },
  { id: 'architecture.export_model_revision', method: 'GET', path: `${MODELS}/:mid/revisions/:rid/exchange`, handler: 'handleExportArchitectureModelRevision', summary: 'A saved version as an ArchiMate exchange file: `{xml, losses}`', effect: 'read', input: revision },
  { id: 'architecture.get_revision_view_diagram', method: 'GET', path: `${MODELS}/:mid/revisions/:rid/views/:vid/diagram`, handler: 'handleGetArchitectureRevisionViewDiagram', summary: "A view's diagram as it was in a saved version: `{svg, diagnostics, renderer_version}`", effect: 'read', input: revisionView },
  { id: 'architecture.download_revision_view_png', method: 'GET', path: `${MODELS}/:mid/revisions/:rid/views/:vid/diagram/png`, handler: 'handleDownloadArchitectureRevisionViewPng', summary: "A view's diagram in a saved version, as a PNG download", effect: 'read', input: revisionView, output: z.unknown(), responseContentType: 'image/png' },
  { id: 'architecture.download_revision_view_svg', method: 'GET', path: `${MODELS}/:mid/revisions/:rid/views/:vid/diagram/svg`, handler: 'handleDownloadArchitectureRevisionViewSvg', summary: "A view's diagram in a saved version, as an SVG download", effect: 'read', input: revisionView, output: z.unknown(), responseContentType: 'image/svg+xml' },
  { id: 'architecture.download_revision_view_pdf', method: 'GET', path: `${MODELS}/:mid/revisions/:rid/views/:vid/diagram/pdf`, handler: 'handleDownloadArchitectureRevisionViewPdf', summary: "A view's diagram in a saved version, as a (vector) PDF download", effect: 'read', input: revisionView, output: z.unknown(), responseContentType: 'application/pdf' },
  { id: 'architecture.download_revision_pdf', method: 'GET', path: `${MODELS}/:mid/revisions/:rid/export/pdf`, handler: 'handleDownloadArchitectureRevisionPdf', summary: 'Every view or diagram of a saved version as one PDF, a titled page each (404 `no_diagrams` when it has none)', effect: 'read', input: revision, output: z.unknown(), responseContentType: 'application/pdf' },
  { id: 'architecture.download_revision_svg_zip', method: 'GET', path: `${MODELS}/:mid/revisions/:rid/export/svg`, handler: 'handleDownloadArchitectureRevisionSvgZip', summary: 'Every view or diagram of a saved version as SVG files in one zip (404 `no_diagrams` when it has none)', effect: 'read', input: revision, output: z.unknown(), responseContentType: 'application/zip' },
  { id: 'architecture.download_revision_xmi', method: 'GET', path: `${MODELS}/:mid/revisions/:rid/xmi`, handler: 'handleDownloadArchitectureRevisionXmi', summary: 'A saved version of a UML model as an OMG XMI 2.5.1 file (409 `xmi_unsupported_language` for ArchiMate: use the exchange file)', effect: 'read', input: revision, output: z.unknown(), responseContentType: 'application/xml' },
  { id: 'architecture.list_model_publications', method: 'GET', path: `${MODELS}/:mid/publications`, handler: 'handleListArchitectureModelPublications', summary: "A model's publication history, newest first", effect: 'read', input: model, output: listOutput },
  { id: 'architecture.list_validation_runs', method: 'GET', path: `${MODELS}/:mid/validation-runs`, handler: 'handleListArchitectureValidationRuns', summary: "A model's validation runs, newest first", effect: 'read', input: model.extend({ ...page, target: z.nativeEnum(ListModelValidationRunsTarget).optional(), clean: z.enum(['true', 'false']).optional() }), output: listOutput },
  { id: 'architecture.run_model_validation', method: 'POST', path: `${MODELS}/:mid/validation-runs`, handler: 'handleRunArchitectureModelValidation', summary: 'Run the modeling rules on the draft (default) or a saved version; RM stores the result', effect: 'write', successStatus: 201, input: model.extend({ revision_id: z.string().optional(), ruleset_id: z.string().optional() }) },
  { id: 'architecture.list_change_sets', method: 'GET', path: `${MODELS}/:mid/change-sets`, handler: 'handleListArchitectureChangeSets', summary: "A model's proposed, applied and rejected change sets", effect: 'read', input: model.extend({ ...page, status: z.nativeEnum(ListChangeSetsStatus).optional() }), output: listOutput },
  { id: 'architecture.export_model', method: 'GET', path: `${MODELS}/:mid/exchange`, handler: 'handleExportArchitectureModel', summary: 'The draft as an ArchiMate exchange file: `{xml, losses}` (`ETag` = the head exported)', effect: 'read', input: model },
  { id: 'architecture.download_model_pdf', method: 'GET', path: `${MODELS}/:mid/export/pdf`, handler: 'handleDownloadArchitectureModelPdf', summary: 'Every view or diagram of the draft as one PDF, a titled page each (404 `no_diagrams` when it has none)', effect: 'read', input: model, output: z.unknown(), responseContentType: 'application/pdf' },
  { id: 'architecture.download_model_svg_zip', method: 'GET', path: `${MODELS}/:mid/export/svg`, handler: 'handleDownloadArchitectureModelSvgZip', summary: 'Every view or diagram of the draft as SVG files in one zip (404 `no_diagrams` when it has none)', effect: 'read', input: model, output: z.unknown(), responseContentType: 'application/zip' },
  { id: 'architecture.download_model_xmi', method: 'GET', path: `${MODELS}/:mid/xmi`, handler: 'handleDownloadArchitectureModelXmi', summary: 'The draft of a UML model as an OMG XMI 2.5.1 file (409 `xmi_unsupported_language` for ArchiMate: use the exchange file)', effect: 'read', input: model, output: z.unknown(), responseContentType: 'application/xml' },
  { id: 'architecture.import_into_model', method: 'POST', path: `${MODELS}/:mid/exchange-imports`, handler: 'handleImportIntoArchitectureModel', summary: 'Stage an ArchiMate exchange file as a change set on this model (nothing changes until it is applied)', effect: 'write', successStatus: 201, input: model.extend(exchangeIn) },
  { id: 'architecture.import_model', method: 'POST', path: '/api/assets/architecture/modeling/imports', handler: 'handleImportArchitectureModel', summary: 'Create a model from an ArchiMate exchange file, staged as a change set to apply', effect: 'write', successStatus: 201, input: z.object({ ...exchangeIn, project_id: z.string().optional() }) },
  { id: 'architecture.get_validation_run', method: 'GET', path: '/api/assets/architecture/modeling/validation-runs/:runId', handler: 'handleGetArchitectureValidationRun', summary: 'A validation run as RM stored it (status, counts, clean)', effect: 'read', input: run },
  { id: 'architecture.list_validation_findings', method: 'GET', path: '/api/assets/architecture/modeling/validation-runs/:runId/findings', handler: 'handleListArchitectureValidationFindings', summary: "A validation run's findings (filters severity, rule_id, target_id)", effect: 'read', input: run.extend({ ...page, severity: z.nativeEnum(ListValidationFindingsSeverity).optional(), rule_id: z.string().optional(), target_id: z.string().optional() }), output: listOutput },
  { id: 'architecture.get_change_set', method: 'GET', path: '/api/assets/architecture/modeling/change-sets/:csid', handler: 'handleGetArchitectureChangeSet', summary: 'A change set with its operations and findings', effect: 'read', input: changeSet },
  { id: 'architecture.apply_change_set', method: 'POST', path: '/api/assets/architecture/modeling/change-sets/:csid/apply', handler: 'handleApplyArchitectureChangeSet', summary: 'Apply a proposed change set to its model (412 `stale_head` if the model changed since it was staged)', effect: 'write', input: changeSet },
  { id: 'architecture.reject_change_set', method: 'POST', path: '/api/assets/architecture/modeling/change-sets/:csid/reject', handler: 'handleRejectArchitectureChangeSet', summary: 'Reject a proposed change set (a reason is required)', effect: 'write', input: changeSet.extend({ reason: z.string().min(1) }) },
  { id: 'architecture.list_rulesets', method: 'GET', path: '/api/assets/architecture/modeling/rulesets', handler: 'handleListArchitectureRulesets', summary: 'The modeling rule sets RM can validate with', effect: 'read', input: z.object({}), output: listOutput },
  { id: 'architecture.get_ruleset', method: 'GET', path: '/api/assets/architecture/modeling/rulesets/:ref', handler: 'handleGetArchitectureRuleset', summary: 'A rule set with the title and description of every rule', effect: 'read', input: ruleset },
  { id: 'architecture.get_view_diagram', method: 'GET', path: '/api/assets/architecture/views/:vid/diagram', handler: 'handleGetArchitectureViewDiagram', summary: "A view's current diagram: `{svg, diagnostics, renderer_version}`", effect: 'read', input: view },
  { id: 'architecture.download_view_png', method: 'GET', path: '/api/assets/architecture/views/:vid/diagram/png', handler: 'handleDownloadArchitectureViewPng', summary: "A view's current diagram as a PNG download", effect: 'read', input: view, output: z.unknown(), responseContentType: 'image/png' },
  { id: 'architecture.download_view_svg', method: 'GET', path: '/api/assets/architecture/views/:vid/diagram/svg', handler: 'handleDownloadArchitectureViewSvg', summary: "A view's current diagram as an SVG download", effect: 'read', input: view, output: z.unknown(), responseContentType: 'image/svg+xml' },
  { id: 'architecture.download_view_pdf', method: 'GET', path: '/api/assets/architecture/views/:vid/diagram/pdf', handler: 'handleDownloadArchitectureViewPdf', summary: "A view's current diagram as a (vector) PDF download", effect: 'read', input: view, output: z.unknown(), responseContentType: 'application/pdf' },
];

export const ARCHITECTURE_MODELING_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = libraryCapabilities(
  {
    area: 'architecture',
    tag: 'Architecture',
    tenancy: 'tenant',
    rule: routeRule(isAuthenticatedUserInFrameTenant),
    responses: proxyResponses('requirements_management', MODELING_REFUSALS),
    output: dataEnvelope,
    module: 'src/routes/assets/architecture-modeling.ts',
    load: () => import('../../routes/assets/architecture-modeling'),
  },
  MODELING_ROUTES,
);

// ---------------------------------------------------------------------------
// UML (profile uml-2.5.1-p1, spec §8.2) and trace links (§7.4) —
// routes/assets/architecture-uml.ts.
// ---------------------------------------------------------------------------

const MODELING = '/api/assets/architecture/modeling';
const UML = '/api/assets/architecture/modeling/uml';
const umlBody = z
  .object({ expected_head: expectedHead })
  .passthrough()
  .describe("The profile's own shape (requirements_management UmlElementCreate / …Update, the interaction document, a diagram occurrence), validated by RM against its schema (422 VALIDATION_ERROR + details) and the whole model.");
const traceRef = z.object({ kind: z.nativeEnum(TraceRefKind), id: z.string().uuid() });
const traceLinkIn = z.object({
  source: traceRef,
  target: traceRef.optional(),
  target_code: z.object({ repo: z.string().min(1), commit: z.string().min(1), symbol: z.string().min(1) }).optional(),
  link_type: z.nativeEnum(TraceLinkInLinkType),
  note: z.string().optional(),
});

const UML_ROUTES: LibraryRoute[] = [
  { id: 'architecture.list_uml_elements', method: 'GET', path: `${UML}/elements`, handler: 'handleListUmlElements', summary: 'List UML elements (package, class, interface, data type, enumeration, primitive type, component, port, actor)', effect: 'read', input: z.object({ ...page, model_id: z.string().optional(), kind: z.string().optional(), project_id: z.string().optional(), owner_id: z.string().optional() }), output: listOutput },
  { id: 'architecture.create_uml_element', method: 'POST', path: `${UML}/elements`, handler: 'handleCreateUmlElement', summary: 'Create a UML element (package, class, interface, data type, enumeration, primitive type, component, port, actor)', effect: 'write', input: umlBody, successStatus: 201 },
  { id: 'architecture.get_uml_element', method: 'GET', path: `${UML}/elements/:id`, handler: 'handleGetUmlElement', summary: 'A UML element (package, class, interface, data type, enumeration, primitive type, component, port, actor)', effect: 'read', input: z.object({ id: pathId('UML element id') }) },
  { id: 'architecture.update_uml_element', method: 'PUT', path: `${UML}/elements/:id`, handler: 'handleUpdateUmlElement', summary: 'Update a UML element (package, class, interface, data type, enumeration, primitive type, component, port, actor): only the fields sent change (honours If-Match; 412 `stale_head` when its model changed meanwhile)', effect: 'write', input: umlBody.extend(z.object({ id: pathId('UML element id') }).shape) },
  { id: 'architecture.delete_uml_element', method: 'DELETE', path: `${UML}/elements/:id`, handler: 'handleDeleteUmlElement', summary: 'Delete a UML element (package, class, interface, data type, enumeration, primitive type, component, port, actor); the answer lists what was removed with it', effect: 'destructive', input: z.object({ id: pathId('UML element id') }) },
  { id: 'architecture.list_uml_relationships', method: 'GET', path: `${UML}/relationships`, handler: 'handleListUmlRelationships', summary: 'List UML relationships (association, generalization, interface realization, realization, dependency, usage, connector)', effect: 'read', input: z.object({ ...page, model_id: z.string().optional(), kind: z.string().optional(), project_id: z.string().optional() }), output: listOutput },
  { id: 'architecture.create_uml_relationship', method: 'POST', path: `${UML}/relationships`, handler: 'handleCreateUmlRelationship', summary: 'Create a UML relationship (association, generalization, interface realization, realization, dependency, usage, connector)', effect: 'write', input: umlBody, successStatus: 201 },
  { id: 'architecture.get_uml_relationship', method: 'GET', path: `${UML}/relationships/:id`, handler: 'handleGetUmlRelationship', summary: 'A UML relationship (association, generalization, interface realization, realization, dependency, usage, connector)', effect: 'read', input: z.object({ id: pathId('UML relationship id') }) },
  { id: 'architecture.update_uml_relationship', method: 'PUT', path: `${UML}/relationships/:id`, handler: 'handleUpdateUmlRelationship', summary: 'Update a UML relationship (association, generalization, interface realization, realization, dependency, usage, connector): only the fields sent change (honours If-Match; 412 `stale_head` when its model changed meanwhile)', effect: 'write', input: umlBody.extend(z.object({ id: pathId('UML relationship id') }).shape) },
  { id: 'architecture.delete_uml_relationship', method: 'DELETE', path: `${UML}/relationships/:id`, handler: 'handleDeleteUmlRelationship', summary: 'Delete a UML relationship (association, generalization, interface realization, realization, dependency, usage, connector); the answer lists what was removed with it', effect: 'destructive', input: z.object({ id: pathId('UML relationship id') }) },
  { id: 'architecture.list_uml_interactions', method: 'GET', path: `${UML}/interactions`, handler: 'handleListUmlInteractions', summary: 'List UML interactions (a sequence: lifelines, ordered occurrences, messages, executions, fragments)', effect: 'read', input: z.object({ ...page, model_id: z.string().optional(), project_id: z.string().optional(), owner_id: z.string().optional() }), output: listOutput },
  { id: 'architecture.create_uml_interaction', method: 'POST', path: `${UML}/interactions`, handler: 'handleCreateUmlInteraction', summary: 'Create a UML interaction (a sequence: lifelines, ordered occurrences, messages, executions, fragments)', effect: 'write', input: umlBody, successStatus: 201 },
  { id: 'architecture.get_uml_interaction', method: 'GET', path: `${UML}/interactions/:id`, handler: 'handleGetUmlInteraction', summary: 'A UML interaction (a sequence: lifelines, ordered occurrences, messages, executions, fragments)', effect: 'read', input: z.object({ id: pathId('UML interaction id') }) },
  { id: 'architecture.update_uml_interaction', method: 'PUT', path: `${UML}/interactions/:id`, handler: 'handleUpdateUmlInteraction', summary: 'Update a UML interaction (a sequence: lifelines, ordered occurrences, messages, executions, fragments): only the fields sent change (honours If-Match; 412 `stale_head` when its model changed meanwhile)', effect: 'write', input: umlBody.extend(z.object({ id: pathId('UML interaction id') }).shape) },
  { id: 'architecture.delete_uml_interaction', method: 'DELETE', path: `${UML}/interactions/:id`, handler: 'handleDeleteUmlInteraction', summary: 'Delete a UML interaction (a sequence: lifelines, ordered occurrences, messages, executions, fragments); the answer lists what was removed with it', effect: 'destructive', input: z.object({ id: pathId('UML interaction id') }) },
  { id: 'architecture.list_uml_diagrams', method: 'GET', path: `${UML}/diagrams`, handler: 'handleListUmlDiagrams', summary: 'List UML diagrams (class, component or sequence)', effect: 'read', input: z.object({ ...page, model_id: z.string().optional(), kind: z.string().optional(), project_id: z.string().optional() }), output: listOutput },
  { id: 'architecture.create_uml_diagram', method: 'POST', path: `${UML}/diagrams`, handler: 'handleCreateUmlDiagram', summary: 'Create a UML diagram (class, component or sequence)', effect: 'write', input: umlBody, successStatus: 201 },
  { id: 'architecture.get_uml_diagram', method: 'GET', path: `${UML}/diagrams/:id`, handler: 'handleGetUmlDiagram', summary: 'A UML diagram (class, component or sequence)', effect: 'read', input: z.object({ id: pathId('UML diagram id') }) },
  { id: 'architecture.update_uml_diagram', method: 'PUT', path: `${UML}/diagrams/:id`, handler: 'handleUpdateUmlDiagram', summary: 'Update a UML diagram (class, component or sequence): only the fields sent change (honours If-Match; 412 `stale_head` when its model changed meanwhile)', effect: 'write', input: umlBody.extend(z.object({ id: pathId('UML diagram id') }).shape) },
  { id: 'architecture.delete_uml_diagram', method: 'DELETE', path: `${UML}/diagrams/:id`, handler: 'handleDeleteUmlDiagram', summary: 'Delete a UML diagram (class, component or sequence); the answer lists what was removed with it', effect: 'destructive', input: z.object({ id: pathId('UML diagram id') }) },
  { id: 'architecture.list_uml_diagram_objects', method: 'GET', path: `${UML}/diagrams/:did/objects`, handler: 'handleListUmlDiagramObjects', summary: 'The shapes on a UML diagram', effect: 'read', input: z.object({ did: pathId('UML diagram id') }), output: listOutput },
  { id: 'architecture.create_uml_diagram_object', method: 'POST', path: `${UML}/diagrams/:did/objects`, handler: 'handleCreateUmlDiagramObject', summary: 'Add a shape on a UML diagram', effect: 'write', input: umlBody.extend(z.object({ did: pathId('UML diagram id') }).shape), successStatus: 201 },
  { id: 'architecture.update_uml_diagram_object', method: 'PUT', path: `${UML}/diagrams/:did/objects/:oid`, handler: 'handleUpdateUmlDiagramObject', summary: 'Change a shape on a UML diagram: only the fields sent change (honours If-Match)', effect: 'write', input: umlBody.extend(z.object({ did: pathId('UML diagram id'), oid: pathId('Diagram object id') }).shape) },
  { id: 'architecture.delete_uml_diagram_object', method: 'DELETE', path: `${UML}/diagrams/:did/objects/:oid`, handler: 'handleDeleteUmlDiagramObject', summary: 'Remove a shape on a UML diagram', effect: 'destructive', input: z.object({ did: pathId('UML diagram id'), oid: pathId('Diagram object id') }) },
  { id: 'architecture.list_uml_diagram_connections', method: 'GET', path: `${UML}/diagrams/:did/connections`, handler: 'handleListUmlDiagramConnections', summary: 'The lines on a UML diagram', effect: 'read', input: z.object({ did: pathId('UML diagram id') }), output: listOutput },
  { id: 'architecture.create_uml_diagram_connection', method: 'POST', path: `${UML}/diagrams/:did/connections`, handler: 'handleCreateUmlDiagramConnection', summary: 'Add a line on a UML diagram', effect: 'write', input: umlBody.extend(z.object({ did: pathId('UML diagram id') }).shape), successStatus: 201 },
  { id: 'architecture.update_uml_diagram_connection', method: 'PUT', path: `${UML}/diagrams/:did/connections/:cid`, handler: 'handleUpdateUmlDiagramConnection', summary: 'Change a line on a UML diagram: only the fields sent change (honours If-Match)', effect: 'write', input: umlBody.extend(z.object({ did: pathId('UML diagram id'), cid: pathId('Diagram connection id') }).shape) },
  { id: 'architecture.delete_uml_diagram_connection', method: 'DELETE', path: `${UML}/diagrams/:did/connections/:cid`, handler: 'handleDeleteUmlDiagramConnection', summary: 'Remove a line on a UML diagram', effect: 'destructive', input: z.object({ did: pathId('UML diagram id'), cid: pathId('Diagram connection id') }) },
  { id: 'architecture.get_uml_diagram_picture', method: 'GET', path: `${UML}/diagrams/:did/picture`, handler: 'handleGetUmlDiagramPicture', summary: "A UML diagram's current picture: `{svg, diagnostics, renderer_version}`", effect: 'read', input: z.object({ did: pathId('UML diagram id') }) },
  { id: 'architecture.download_uml_diagram_png', method: 'GET', path: `${UML}/diagrams/:did/picture/png`, handler: 'handleDownloadUmlDiagramPng', summary: "A UML diagram's current picture as a PNG download", effect: 'read', input: z.object({ did: pathId('UML diagram id') }), output: z.unknown(), responseContentType: 'image/png' },
  { id: 'architecture.download_uml_diagram_svg', method: 'GET', path: `${UML}/diagrams/:did/picture/svg`, handler: 'handleDownloadUmlDiagramSvg', summary: "A UML diagram's current picture as an SVG download", effect: 'read', input: z.object({ did: pathId('UML diagram id') }), output: z.unknown(), responseContentType: 'image/svg+xml' },
  { id: 'architecture.download_uml_diagram_pdf', method: 'GET', path: `${UML}/diagrams/:did/picture/pdf`, handler: 'handleDownloadUmlDiagramPdf', summary: "A UML diagram's current picture as a (vector) PDF download", effect: 'read', input: z.object({ did: pathId('UML diagram id') }), output: z.unknown(), responseContentType: 'application/pdf' },
  { id: 'architecture.get_revision_uml_diagram_picture', method: 'GET', path: `${MODELS}/:mid/revisions/:rid/uml-diagrams/:did/picture`, handler: 'handleGetRevisionUmlDiagramPicture', summary: 'A UML diagram as a saved version holds it: `{svg, diagnostics, renderer_version}`', effect: 'read', input: revision.extend({ did: pathId('UML diagram id inside that version') }) },
  { id: 'architecture.download_revision_uml_diagram_png', method: 'GET', path: `${MODELS}/:mid/revisions/:rid/uml-diagrams/:did/picture/png`, handler: 'handleDownloadRevisionUmlDiagramPng', summary: 'A UML diagram in a saved version, as a PNG download', effect: 'read', input: revision.extend({ did: pathId('UML diagram id inside that version') }), output: z.unknown(), responseContentType: 'image/png' },
  { id: 'architecture.download_revision_uml_diagram_svg', method: 'GET', path: `${MODELS}/:mid/revisions/:rid/uml-diagrams/:did/picture/svg`, handler: 'handleDownloadRevisionUmlDiagramSvg', summary: 'A UML diagram in a saved version, as an SVG download', effect: 'read', input: revision.extend({ did: pathId('UML diagram id inside that version') }), output: z.unknown(), responseContentType: 'image/svg+xml' },
  { id: 'architecture.download_revision_uml_diagram_pdf', method: 'GET', path: `${MODELS}/:mid/revisions/:rid/uml-diagrams/:did/picture/pdf`, handler: 'handleDownloadRevisionUmlDiagramPdf', summary: 'A UML diagram in a saved version, as a (vector) PDF download', effect: 'read', input: revision.extend({ did: pathId('UML diagram id inside that version') }), output: z.unknown(), responseContentType: 'application/pdf' },
  { id: 'architecture.get_uml_profile', method: 'GET', path: `${UML}/profile`, handler: 'handleGetUmlProfile', summary: 'The UML profile: the element and relationship kinds, with the schema of each', effect: 'read', input: z.object({}) },
  { id: 'architecture.list_trace_links', method: 'GET', path: `${MODELING}/trace-links`, handler: 'handleListTraceLinks', summary: 'Trace links (filters source_id, target_id, link_type)', effect: 'read', input: z.object({ ...page, source_id: z.string().optional(), target_id: z.string().optional(), link_type: z.nativeEnum(TraceLinkInLinkType).optional() }), output: listOutput },
  { id: 'architecture.create_trace_link', method: 'POST', path: `${MODELING}/trace-links`, handler: 'handleCreateTraceLink', summary: 'Link two items (or an item and a place in the code)', effect: 'write', input: traceLinkIn, successStatus: 201 },
  { id: 'architecture.get_trace_link', method: 'GET', path: `${MODELING}/trace-links/:lid`, handler: 'handleGetTraceLink', summary: 'A trace link', effect: 'read', input: z.object({ lid: pathId('Trace link id') }) },
  { id: 'architecture.delete_trace_link', method: 'DELETE', path: `${MODELING}/trace-links/:lid`, handler: 'handleDeleteTraceLink', summary: 'Delete a trace link', effect: 'destructive', input: z.object({ lid: pathId('Trace link id') }) },
];

export const ARCHITECTURE_UML_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = libraryCapabilities(
  {
    area: 'architecture',
    tag: 'Architecture',
    tenancy: 'tenant',
    rule: routeRule(isAuthenticatedUserInFrameTenant),
    responses: proxyResponses('requirements_management', MODELING_REFUSALS),
    output: dataEnvelope,
    module: 'src/routes/assets/architecture-uml.ts',
    load: () => import('../../routes/assets/architecture-uml'),
  },
  UML_ROUTES,
);

// ---------------------------------------------------------------------------
// ArchiMate view contents (spec §8.1: a view's objects and connections) and the
// ArchiMate metamodel reference data — routes/assets/architecture-occurrences.ts.
// ---------------------------------------------------------------------------

/** The body of RM operation `op` (its model name read from RM's spec), checked by RM. */
const occurrenceBody = (op: OperationName) =>
  z
    .object({ expected_head: expectedHead })
    .passthrough()
    .describe(`requirements_management's ${rmRequestModel(op)} body; RM checks it against its schema and the view's model (422 \`model_integrity\` + findings).`);
const viewObject = view.extend({ oid: pathId('View object id') });
const viewConnection = view.extend({ cid: pathId('View connection id') });

const OCCURRENCE_ROUTES: LibraryRoute[] = [
  { id: 'architecture.list_view_objects', method: 'GET', path: '/api/assets/architecture/views/:vid/objects', handler: 'handleListArchitectureViewObjects', summary: "The shapes on an ArchiMate view (element occurrences, notes, groups), in drawing order", effect: 'read', input: view, output: listOutput },
  { id: 'architecture.create_view_object', method: 'POST', path: '/api/assets/architecture/views/:vid/objects', handler: 'handleCreateArchitectureViewObject', summary: 'Place a shape on an ArchiMate view: an element of its model (`kind: "element"`, `concept_ref`, `bounds`), a note or a group (honours If-Match; RM takes no Idempotency-Key here, so re-read the view after an unknown outcome)', effect: 'write', input: occurrenceBody('createArchitectureViewObject').extend(view.shape), successStatus: 201 },
  { id: 'architecture.update_view_object', method: 'PUT', path: '/api/assets/architecture/views/:vid/objects/:oid', handler: 'handleUpdateArchitectureViewObject', summary: 'Change a shape on an ArchiMate view: only the fields sent change (honours If-Match)', effect: 'write', input: occurrenceBody('updateArchitectureViewObject').extend(viewObject.shape) },
  { id: 'architecture.delete_view_object', method: 'DELETE', path: '/api/assets/architecture/views/:vid/objects/:oid', handler: 'handleDeleteArchitectureViewObject', summary: 'Remove a shape from an ArchiMate view, with the lines attached to it (the element itself stays)', effect: 'destructive', input: viewObject },
  { id: 'architecture.list_view_connections', method: 'GET', path: '/api/assets/architecture/views/:vid/connections', handler: 'handleListArchitectureViewConnections', summary: 'The lines on an ArchiMate view (relationship occurrences)', effect: 'read', input: view, output: listOutput },
  { id: 'architecture.create_view_connection', method: 'POST', path: '/api/assets/architecture/views/:vid/connections', handler: 'handleCreateArchitectureViewConnection', summary: 'Draw a relationship on an ArchiMate view between two of its shapes (`kind: "relationship"`, `relationship_ref`, `source_object_id`, `target_object_id`; honours If-Match; RM takes no Idempotency-Key here, so re-read the view after an unknown outcome)', effect: 'write', input: occurrenceBody('createArchitectureViewConnection').extend(view.shape), successStatus: 201 },
  { id: 'architecture.update_view_connection', method: 'PUT', path: '/api/assets/architecture/views/:vid/connections/:cid', handler: 'handleUpdateArchitectureViewConnection', summary: 'Change a line on an ArchiMate view: only the fields sent change (honours If-Match)', effect: 'write', input: occurrenceBody('updateArchitectureViewConnection').extend(viewConnection.shape) },
  { id: 'architecture.delete_view_connection', method: 'DELETE', path: '/api/assets/architecture/views/:vid/connections/:cid', handler: 'handleDeleteArchitectureViewConnection', summary: 'Remove a line from an ArchiMate view (the relationship itself stays)', effect: 'destructive', input: viewConnection },
  { id: 'architecture.get_metamodel_concepts', method: 'GET', path: '/api/assets/architecture/metamodel/concepts', handler: 'handleGetArchimateConcepts', summary: 'Every ArchiMate concept (element type with its layer and aspect) and the relationship types', effect: 'read', input: z.object({}) },
  { id: 'architecture.query_metamodel_relationships', method: 'GET', path: '/api/assets/architecture/metamodel/relationships', handler: 'handleQueryArchimateRelationshipMatrix', summary: 'The relationship types ArchiMate allows between a source and a target concept type', effect: 'read', input: z.object({ source_type: z.string().optional().describe('Source concept type, e.g. application_component.'), target_type: z.string().optional().describe('Target concept type, e.g. application_service.') }), output: listOutput },
];

export const ARCHITECTURE_OCCURRENCE_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = libraryCapabilities(
  {
    area: 'architecture',
    tag: 'Architecture',
    tenancy: 'tenant',
    rule: routeRule(isAuthenticatedUserInFrameTenant),
    responses: proxyResponses('requirements_management', MODELING_REFUSALS),
    output: dataEnvelope,
    module: 'src/routes/assets/architecture-occurrences.ts',
    load: () => import('../../routes/assets/architecture-occurrences'),
  },
  OCCURRENCE_ROUTES,
);
