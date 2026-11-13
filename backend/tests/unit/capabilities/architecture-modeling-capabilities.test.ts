// The 40 ArchiMate MODELING capabilities (capabilities/library/architecture-modeling.ts),
// pinned exactly: id → METHOD path → handler export, effect, success status, the
// non-JSON downloads, and that every handler named exists in the route module.
// (library-capabilities.test.ts pins the P4a3 set and leaves this file to this suite.)

import { describe, expect, test } from 'bun:test';

import { ARCHITECTURE_MODELING_CAPABILITIES, ARCHITECTURE_OCCURRENCE_CAPABILITIES, ARCHITECTURE_UML_CAPABILITIES } from '../../../src/capabilities/library/architecture-modeling';
import * as occurrenceRoutes from '../../../src/routes/assets/architecture-occurrences';
import * as umlRoutes from '../../../src/routes/assets/architecture-uml';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import * as routes from '../../../src/routes/assets/architecture-modeling';
import { handlerRefOf } from '../../helpers/capabilities';

const M = '/api/assets/architecture/modeling';
const PINNED: Record<string, string> = {
  'architecture.list_models': `GET ${M}/models -> handleListArchitectureModels`,
  'architecture.create_model': `POST ${M}/models -> handleCreateArchitectureModel`,
  'architecture.get_model': `GET ${M}/models/:mid -> handleGetArchitectureModel`,
  'architecture.update_model': `PATCH ${M}/models/:mid -> handleUpdateArchitectureModel`,
  'architecture.delete_model': `DELETE ${M}/models/:mid -> handleDeleteArchitectureModel`,
  'architecture.list_model_revisions': `GET ${M}/models/:mid/revisions -> handleListArchitectureModelRevisions`,
  'architecture.seal_model_revision': `POST ${M}/models/:mid/revisions -> handleSealArchitectureModelRevision`,
  'architecture.get_model_revision': `GET ${M}/models/:mid/revisions/:rid -> handleGetArchitectureModelRevision`,
  'architecture.list_revision_reviews': `GET ${M}/models/:mid/revisions/:rid/reviews -> handleListArchitectureRevisionReviews`,
  'architecture.review_model_revision': `POST ${M}/models/:mid/revisions/:rid/reviews -> handleReviewArchitectureModelRevision`,
  'architecture.publish_model_revision': `POST ${M}/models/:mid/revisions/:rid/publish -> handlePublishArchitectureModelRevision`,
  'architecture.export_model_revision': `GET ${M}/models/:mid/revisions/:rid/exchange -> handleExportArchitectureModelRevision`,
  'architecture.get_revision_view_diagram': `GET ${M}/models/:mid/revisions/:rid/views/:vid/diagram -> handleGetArchitectureRevisionViewDiagram`,
  'architecture.download_revision_view_png': `GET ${M}/models/:mid/revisions/:rid/views/:vid/diagram/png -> handleDownloadArchitectureRevisionViewPng`,
  'architecture.download_revision_view_svg': `GET ${M}/models/:mid/revisions/:rid/views/:vid/diagram/svg -> handleDownloadArchitectureRevisionViewSvg`,
  'architecture.download_revision_view_pdf': `GET ${M}/models/:mid/revisions/:rid/views/:vid/diagram/pdf -> handleDownloadArchitectureRevisionViewPdf`,
  'architecture.download_revision_pdf': `GET ${M}/models/:mid/revisions/:rid/export/pdf -> handleDownloadArchitectureRevisionPdf`,
  'architecture.download_revision_svg_zip': `GET ${M}/models/:mid/revisions/:rid/export/svg -> handleDownloadArchitectureRevisionSvgZip`,
  'architecture.download_revision_xmi': `GET ${M}/models/:mid/revisions/:rid/xmi -> handleDownloadArchitectureRevisionXmi`,
  'architecture.list_model_publications': `GET ${M}/models/:mid/publications -> handleListArchitectureModelPublications`,
  'architecture.list_validation_runs': `GET ${M}/models/:mid/validation-runs -> handleListArchitectureValidationRuns`,
  'architecture.run_model_validation': `POST ${M}/models/:mid/validation-runs -> handleRunArchitectureModelValidation`,
  'architecture.list_change_sets': `GET ${M}/models/:mid/change-sets -> handleListArchitectureChangeSets`,
  'architecture.export_model': `GET ${M}/models/:mid/exchange -> handleExportArchitectureModel`,
  'architecture.download_model_pdf': `GET ${M}/models/:mid/export/pdf -> handleDownloadArchitectureModelPdf`,
  'architecture.download_model_svg_zip': `GET ${M}/models/:mid/export/svg -> handleDownloadArchitectureModelSvgZip`,
  'architecture.download_model_xmi': `GET ${M}/models/:mid/xmi -> handleDownloadArchitectureModelXmi`,
  'architecture.import_into_model': `POST ${M}/models/:mid/exchange-imports -> handleImportIntoArchitectureModel`,
  'architecture.import_model': `POST ${M}/imports -> handleImportArchitectureModel`,
  'architecture.get_validation_run': `GET ${M}/validation-runs/:runId -> handleGetArchitectureValidationRun`,
  'architecture.list_validation_findings': `GET ${M}/validation-runs/:runId/findings -> handleListArchitectureValidationFindings`,
  'architecture.get_change_set': `GET ${M}/change-sets/:csid -> handleGetArchitectureChangeSet`,
  'architecture.apply_change_set': `POST ${M}/change-sets/:csid/apply -> handleApplyArchitectureChangeSet`,
  'architecture.reject_change_set': `POST ${M}/change-sets/:csid/reject -> handleRejectArchitectureChangeSet`,
  'architecture.list_rulesets': `GET ${M}/rulesets -> handleListArchitectureRulesets`,
  'architecture.get_ruleset': `GET ${M}/rulesets/:ref -> handleGetArchitectureRuleset`,
  'architecture.get_view_diagram': 'GET /api/assets/architecture/views/:vid/diagram -> handleGetArchitectureViewDiagram',
  'architecture.download_view_png': 'GET /api/assets/architecture/views/:vid/diagram/png -> handleDownloadArchitectureViewPng',
  'architecture.download_view_svg': 'GET /api/assets/architecture/views/:vid/diagram/svg -> handleDownloadArchitectureViewSvg',
  'architecture.download_view_pdf': 'GET /api/assets/architecture/views/:vid/diagram/pdf -> handleDownloadArchitectureViewPdf',
};

describe('the modeling capabilities', () => {
  test('exactly the pinned set, each on its route and handler', () => {
    const got = Object.fromEntries(
      ARCHITECTURE_MODELING_CAPABILITIES.map((c) => [c.id, `${c.http.method} ${c.http.path} -> ${handlerRefOf(c.legacyHandler)?.exportName}`]),
    );
    expect(got).toEqual(PINNED);
  });

  test('every handler named is exported by the route module', () => {
    const exported = routes as unknown as Record<string, unknown>;
    for (const c of ARCHITECTURE_MODELING_CAPABILITIES) {
      const name = handlerRefOf(c.legacyHandler)!.exportName;
      expect(`${name} ${typeof exported[name]}`).toBe(`${name} function`);
    }
  });

  test('effects, success statuses, tenancy, agent exposure and the downloads', () => {
    const status: Record<string, number> = {};
    for (const c of ARCHITECTURE_MODELING_CAPABILITIES) {
      if (c.http.method === 'GET') expect(`${c.id} ${c.effect}`).toBe(`${c.id} read`);
      else if (c.http.method === 'DELETE') expect(`${c.id} ${c.effect} ${c.confirm}`).toBe(`${c.id} destructive card-typed`);
      else expect(`${c.id} ${c.effect}`).toBe(`${c.id} write`);
      expect(c.tenancy).toBe('tenant');
      expect(c.agent).toEqual({ expose: false, reason: 'out-of-agent-scope' });
      if (c.http.successStatus !== undefined) status[c.id] = c.http.successStatus;
    }
    expect(status).toEqual({
      'architecture.create_model': 201,
      'architecture.delete_model': 204,
      'architecture.seal_model_revision': 201,
      'architecture.review_model_revision': 201,
      'architecture.publish_model_revision': 201,
      'architecture.run_model_validation': 201,
      'architecture.import_into_model': 201,
      'architecture.import_model': 201,
    });
    const downloads = ARCHITECTURE_MODELING_CAPABILITIES.filter((c) => c.http.responseContentType !== undefined).map((c) => `${c.id} ${c.http.responseContentType}`);
    expect(downloads.sort()).toEqual([
      'architecture.download_model_pdf application/pdf',
      'architecture.download_model_svg_zip application/zip',
      'architecture.download_model_xmi application/xml',
      'architecture.download_revision_pdf application/pdf',
      'architecture.download_revision_svg_zip application/zip',
      'architecture.download_revision_view_pdf application/pdf',
      'architecture.download_revision_view_png image/png',
      'architecture.download_revision_view_svg image/svg+xml',
      'architecture.download_revision_xmi application/xml',
      'architecture.download_view_pdf application/pdf',
      'architecture.download_view_png image/png',
      'architecture.download_view_svg image/svg+xml',
    ]);
  });

  test('registered once, from their own file', () => {
    const rows = CAPABILITIES.filter((e) => e.file === 'src/capabilities/library/architecture-modeling.ts');
    expect(rows.map((e) => e.cap.id as string).sort()).toEqual(
      [...Object.keys(PINNED), ...ARCHITECTURE_UML_CAPABILITIES.map((c) => c.id as string), ...ARCHITECTURE_OCCURRENCE_CAPABILITIES.map((c) => c.id as string)].sort(),
    );
  });
});

describe('the UML and trace-link capabilities', () => {
  test('every handler exported by the UML route module, effects by method', () => {
    const exported = umlRoutes as unknown as Record<string, unknown>;
    const status: Record<string, number> = {};
    for (const c of ARCHITECTURE_UML_CAPABILITIES) {
      const name = handlerRefOf(c.legacyHandler)!.exportName;
      expect(`${name} ${typeof exported[name]}`).toBe(`${name} function`);
      expect(c.http.path!.startsWith('/api/assets/architecture/modeling/')).toBe(true);
      if (c.http.method === 'GET') expect(`${c.id} ${c.effect}`).toBe(`${c.id} read`);
      else if (c.http.method === 'DELETE') expect(`${c.id} ${c.effect}`).toBe(`${c.id} destructive`);
      else expect(`${c.id} ${c.effect}`).toBe(`${c.id} write`);
      if (c.http.successStatus !== undefined) status[c.id] = c.http.successStatus;
    }
    // Creates are 201; a UML delete answers 200 with what RM removed alongside (`cascaded`).
    expect(Object.values(status).every((s) => s === 201)).toBe(true);
    expect(Object.keys(status).sort()).toEqual([
      'architecture.create_trace_link',
      'architecture.create_uml_diagram',
      'architecture.create_uml_diagram_connection',
      'architecture.create_uml_diagram_object',
      'architecture.create_uml_element',
      'architecture.create_uml_interaction',
      'architecture.create_uml_relationship',
    ]);
  });
});

describe('the ArchiMate view-contents and metamodel capabilities', () => {
  const A = '/api/assets/architecture';
  test('pinned exactly: id, METHOD path, handler, effect, success status', () => {
    const exported = occurrenceRoutes as unknown as Record<string, unknown>;
    const rows = ARCHITECTURE_OCCURRENCE_CAPABILITIES.map((c) => {
      const name = handlerRefOf(c.legacyHandler)!.exportName;
      expect(`${name} ${typeof exported[name]}`).toBe(`${name} function`);
      return `${c.id} ${c.http.method} ${c.http.path} -> ${name} ${c.effect}${c.http.successStatus ? ` ${c.http.successStatus}` : ''}`;
    });
    expect(rows).toEqual([
      `architecture.list_view_objects GET ${A}/views/:vid/objects -> handleListArchitectureViewObjects read`,
      `architecture.create_view_object POST ${A}/views/:vid/objects -> handleCreateArchitectureViewObject write 201`,
      `architecture.update_view_object PUT ${A}/views/:vid/objects/:oid -> handleUpdateArchitectureViewObject write`,
      `architecture.delete_view_object DELETE ${A}/views/:vid/objects/:oid -> handleDeleteArchitectureViewObject destructive`,
      `architecture.list_view_connections GET ${A}/views/:vid/connections -> handleListArchitectureViewConnections read`,
      `architecture.create_view_connection POST ${A}/views/:vid/connections -> handleCreateArchitectureViewConnection write 201`,
      `architecture.update_view_connection PUT ${A}/views/:vid/connections/:cid -> handleUpdateArchitectureViewConnection write`,
      `architecture.delete_view_connection DELETE ${A}/views/:vid/connections/:cid -> handleDeleteArchitectureViewConnection destructive`,
      `architecture.get_metamodel_concepts GET ${A}/metamodel/concepts -> handleGetArchimateConcepts read`,
      `architecture.query_metamodel_relationships GET ${A}/metamodel/relationships -> handleQueryArchimateRelationshipMatrix read`,
    ]);
  });
});
