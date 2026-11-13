// R3 + DOC-3 (FR-PROJECT-HOME-REDESIGN-2026-10-26 §3, §7.1, §7.2) — the project's Outputs page and
// its document reader:
//
//   projects.list_outputs      GET /api/projects/:id/outputs
//   projects.render_document   GET /api/projects/:id/documents/:artifactId/render?format=html|pdf
//
// Same doors as the cockpit read (capabilities/projects/project-routes.ts): validateAuth, then the
// project READ lane (`loadProjectForRead`) — cross-tenant is a 404 and artifact_service is never
// asked. Not on the licence route allowlist; out of agent scope (the agent has its own artifact
// actions).
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import type { Capability } from '../define';
import { isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { standardResponses } from '../account/_shared';
import { pathId, routeRule, settingsCapabilities } from '../settings/_shared';

const rule = routeRule(isAuthenticatedUserInResolvedTenant);
const PROJECT_404 = "404: `error` 'Project not found' (absent, malformed id, or not readable in the request tenant). ";
const ROUTES_MODULE = (m: string, load: () => Promise<Record<string, unknown>>) => ({ module: `src/routes/${m}.ts`, load });

const trailVersion = z.object({
  number: z.number().int(),
  artifact_id: z.string(),
  review_artifact_id: z.string(),
  status: z.enum(['published', 'in_review', 'draft']).nullable(),
  review_status: z.string().nullable(),
  at: z.string().nullable(),
  title: z.string(),
  summary: z.string().nullable(),
});

const trailDocument = z.object({
  key: z.string(),
  artifact_id: z.string(),
  review_artifact_id: z.string(),
  title: z.string().describe('A human title: DOC-1 `title`, else "<kind>: <card name>", else the kind — never a file name or id.'),
  type_label: z.string(),
  status: z.enum(['published', 'in_review', 'draft']).nullable(),
  review_status: z.string().nullable(),
  version: z.number().int(),
  version_count: z.number().int(),
  at: z.string().nullable(),
  summary: z.string().nullable(),
  phase: z.string().nullable(),
  card_id: z.string().nullable(),
  card_name: z.string().nullable(),
  is_final: z.boolean(),
  reviewable: z.boolean(),
  versions: z.array(trailVersion),
});

const trailPr = z.object({
  url: z.string(),
  title: z.string(),
  state: z.string().nullable(),
  at: z.string().nullable(),
  card_name: z.string().nullable(),
  phase: z.string().nullable(),
});

export const PROJECT_DOCUMENT_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  ...settingsCapabilities(
    { area: 'projects', tag: 'Projects', tenancy: 'project', rule, ...ROUTES_MODULE('project-outputs', () => import('../../routes/project-outputs')) },
    [
      {
        id: 'projects.list_outputs', method: 'GET', path: '/api/projects/:id/outputs', handler: 'handleGetProjectOutputs',
        summary: "A project's outputs: the final report, then the document trail and pull requests per phase", effect: 'read',
        description:
          "The documents the project produced (artifact_service, project-scoped), grouped per card and document kind; a " +
          '`.json` report and its `.md` companion uploaded together are ONE version (the `.md` is read). Placed by the card\'s ' +
          "exact phase, else the producer's DOC-1 `phase`, else unassigned. Drafts are left out once the project is finished. " +
          "Only what was produced: a phase with nothing is absent. A project with no RM link answers `{data: {available: false, reason: 'no_rm_project'}}`.",
        input: z.object({ id: pathId('Project id (a uuid; a malformed id is the same 404 as an absent project)') }),
        output: z.object({
          data: z
            .object({
              available: z.boolean(),
              project_id: z.string(),
              reason: z.string().optional(),
              state: z.string().nullable().optional(),
              finished: z.boolean().optional(),
              current_phase: z.string().nullable().optional(),
              final_report: trailDocument.nullable().optional(),
              phases: z
                .array(
                  z.object({
                    name: z.string(),
                    label: z.string(),
                    state: z.string(),
                    current: z.boolean(),
                    documents: z.array(trailDocument),
                    pull_requests: z.array(trailPr),
                  }),
                )
                .optional(),
              unassigned: z.object({ documents: z.array(trailDocument), pull_requests: z.array(trailPr) }).optional(),
              partial: z.array(z.string()).optional().describe("Sources that could not be read ('phases', 'state', 'pull_requests')."),
            })
            .passthrough(),
        }),
        responses: standardResponses(
          PROJECT_404 + "artifact_service unreachable or failing: its relayed status in the integration envelope (`error.code`). ",
        ),
      },
      {
        id: 'projects.render_document', method: 'GET', path: '/api/projects/:id/documents/:artifactId/render', handler: 'handleRenderProjectDocument',
        summary: "One of the project's documents, rendered by artifact_service as HTML (to read) or PDF (to download)", effect: 'read',
        description:
          "artifact_service DOC-1 `GET /projects/{id}/artifacts/{artifactId}/render?format=`, relayed unchanged (content type, " +
          '`X-Render-Cache`, `Content-Disposition`). The HTML is sanitised upstream and again in the browser. The project read lane runs ' +
          'first: another tenant\'s project is a 404 and artifact_service is never asked.',
        input: z.object({
          id: pathId('Project id (a uuid; a malformed id is the same 404 as an absent project)'),
          artifactId: pathId('The artifact id (one of this project\'s artifacts)'),
          format: z.enum(['html', 'pdf']).optional().describe("'html' (default) or 'pdf'; anything else is 422 invalid_format."),
        }),
        output: z.unknown().describe('The rendered document: text/html or application/pdf.'),
        responseContentType: 'text/html',
        responses: standardResponses(
          "422: `code` 'invalid_format'. " +
            PROJECT_404 +
            "404 also: `error` 'Document not found' (a malformed artifact id) or artifact_service's 404 (not this project's, or not " +
            'visible). 413 / 415 relayed (too large / not a renderable document). artifact_service failing: its relayed status. ',
        ),
      },
    ],
  ),
];
