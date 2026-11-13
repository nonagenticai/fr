// src/routes/project-outputs.ts
//
// R3 + DOC-3 (FR-PROJECT-HOME-REDESIGN-2026-10-26 §3, §7.1, §7.2, §8) — the project's Outputs:
//
//   GET /api/projects/:id/outputs
//     200 {data: {available: true, project_id, state, finished, current_phase, final_report,
//                 phases[], unassigned{documents, pull_requests}, partial[]}}
//     200 {data: {available: false, project_id, reason: 'no_rm_project'}}   not run by the conveyor
//   GET /api/projects/:id/documents/:artifactId/render?format=html|pdf
//     200 the rendered document, artifact_service's bytes + content type, relayed unchanged
//         (`X-Render-Cache` and `Content-Disposition` passed through)
//     422 invalid_format
//
// AUTH / TENANCY — identical to GET /api/projects/:id/cockpit: validateAuth + loadProjectForRead
// (tenant-scoped; another tenant's project — or a malformed id — is the same 404 as an absent one,
// and artifact_service is NEVER asked). Every artifact_service call is project-scoped to the fr
// project's own id, in the request's active tenant; a render of an artifact that is not this
// project's is artifact_service's 404, relayed.
//
// The rendered HTML is sanitised by artifact_service (allowlist; http/https/mailto only) and AGAIN
// in the browser (DOMPurify) — fr never trusts it blindly; this route does not alter it.
import { db } from '../db/client';
import { loadProjectForRead } from '../lib/project-access';
import { ctxTenantId } from '../middleware/request-context';
import { listArtifacts, renderArtifact, type RenderFormat } from '../integrations/artifacts';
import { buildProjectCockpit } from '../services/cockpit/project-cockpit';
import { composeDocumentTrail, type TrailArtifact } from '../services/cockpit/document-trail';
import { isFinishedState } from '../services/cockpit/cockpit-status';
import { rmPmProjectIdOf } from '../services/catalogue/project-state';
import { runReadModel } from '../services/read-models/_lib';
import { NotFoundError, ValidationError } from '../utils/errors';
import { jsonResponse } from '../utils/response';

/** How many of the project's artifacts the trail reads (a run produces tens). */
const OUTPUTS_ARTIFACT_LIMIT = 500;

const RENDER_FORMATS: readonly RenderFormat[] = ['html', 'pdf'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleGetProjectOutputs(req: Request, projectId: string): Promise<Response> {
  return runReadModel(req, async (user) => {
    // 404-for-everything tenant gate — never leaks which project ids exist across tenants/owners.
    const project = await loadProjectForRead(db, user, projectId);
    if (!(await rmPmProjectIdOf(project))) {
      return jsonResponse({ data: { available: false, project_id: project.id, reason: 'no_rm_project' } });
    }
    const tenantId = ctxTenantId(user.tenantId);
    // The artifact read failing is the page's failure (a relayed upstream error), never an empty trail.
    const [cockpit, artifacts] = await Promise.all([
      buildProjectCockpit(project, tenantId),
      listArtifacts(project.id, { limit: OUTPUTS_ARTIFACT_LIMIT } as never) as Promise<TrailArtifact[]>,
    ]);

    const spine = cockpit.spine.data;
    const overview = cockpit.overview.data;
    const state = cockpit.status.data?.state ?? null;
    const finished = state !== null && isFinishedState(state);
    const cardPhase = new Map<string, string>();
    const cardNames = new Map<string, string>();
    for (const c of spine?.cards ?? []) {
      if (c.phase) cardPhase.set(c.id, c.phase);
      if (c.name) cardNames.set(c.id, c.name);
    }
    const history = cockpit.conveyor_history?.data ?? null;
    const prs = history?.delivered.data?.pull_requests ?? null;

    const trail = composeDocumentTrail({
      artifacts: Array.isArray(artifacts) ? artifacts : [],
      phases: (spine?.phases ?? []).map((p) => ({ name: p.name, label: p.label, state: p.state })),
      currentPhase: overview?.current_phase ?? null,
      cardPhase,
      cardNames,
      pullRequests: prs,
      finished,
    });

    // What could not be read, so the page can say "part of this is missing" instead of silently less.
    const partial: string[] = [];
    if (cockpit.spine.health !== 'ok') partial.push('phases');
    if (cockpit.status.health !== 'ok') partial.push('state');
    if (prs === null) partial.push('pull_requests');

    return jsonResponse({
      data: { available: true, project_id: project.id, state, ...trail, partial },
    });
  });
}

export async function handleRenderProjectDocument(req: Request, projectId: string, artifactId: string): Promise<Response> {
  return runReadModel(req, async (user) => {
    const raw = new URL(req.url).searchParams.get('format');
    const format = (raw === null || raw === '' ? 'html' : raw) as RenderFormat;
    if (!RENDER_FORMATS.includes(format)) {
      throw new ValidationError('format must be html or pdf', { code: 'invalid_format' }).withCode('invalid_format');
    }
    // Tenant gate FIRST: another tenant's project is a 404 and artifact_service is never asked.
    const project = await loadProjectForRead(db, user, projectId);
    if (!UUID_RE.test(artifactId)) throw new NotFoundError('Document not found');
    const doc = await renderArtifact(project.id, artifactId, format);
    const headers = new Headers({
      'content-type': doc.contentType,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    if (doc.renderCache) headers.set('x-render-cache', doc.renderCache);
    if (doc.disposition) headers.set('content-disposition', doc.disposition);
    // The HTML is a document to sanitise and insert, never a page to run: forbid everything if a
    // browser ever navigates to it directly.
    if (format === 'html') headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    return new Response(doc.body, { status: 200, headers });
  });
}
