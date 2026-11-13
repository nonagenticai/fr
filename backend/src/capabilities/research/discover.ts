// fr-agui SPEC §13 P4a2 — spec drain, research: the 24 `/api/research/discover/*`
// routes (routes/research/discover.ts, the Discovery Engine proxy) re-expressed
// as capabilities with NO behaviour change: every route keeps its handler
// (`legacyHandler`); the declaration is the route CONTRACT for the derived spec.
//
// Tenant-scoped, `out-of-agent-scope` (SPEC §13 P1c retires the `research.*`
// agent actions; none is derived here). Where an AG-UI action of the same name
// exists (agui/actions/research.ts) the id equals it, but the action's schema is
// NOT reused: the actions are deliberately stricter (`.strict()`, no
// `session_id` on search) than the routes, which forward the body verbatim.
// Shared responses / rule: ./_shared.ts.
import { z } from 'zod';

import type { Capability } from '../define';
import { pathId, requiredString, researchCapabilities, upstreamBody, type ResearchRoute } from './_shared';

const body = (type: string) => upstreamBody('Discovery Engine', type);
const session = z.object({ sessionId: pathId('Discovery session id') });

const ROUTES: ResearchRoute[] = [
  {
    id: 'research.search', method: 'POST', path: '/api/research/discover/search', handler: 'handleResearchSearch',
    summary: 'Federated academic search', effect: 'write', input: body('SearchRequest'),
    description:
      'Body `{ query, session_id?, sources?, max_results_per_source?, open_access_only?, sort_by? }`. With a ' +
      '`session_id` every result is PERSISTED into that discovery session; without one the search is ephemeral.',
  },
  {
    id: 'research.list_sources', method: 'GET', path: '/api/research/discover/sources', handler: 'handleResearchSources',
    summary: 'List the live Discovery Engine search sources', effect: 'read', input: z.object({}),
  },
  {
    id: 'research.score_batch', method: 'POST', path: '/api/research/discover/score/batch',
    handler: 'handleResearchScoreBatch', summary: 'Trust-score a batch of discovered papers', effect: 'read',
    input: body('ScoreBatchRequest'),
    description: 'Body `{ paper_ids[], session_id? }`; the papers must already be persisted by a prior search.',
  },
  {
    id: 'research.score_paper', method: 'POST', path: '/api/research/discover/score', handler: 'handleResearchScorePaper',
    summary: 'Trust-score one discovered paper', effect: 'read', input: body('ScoreRequest'),
  },
  {
    id: 'research.get_paper_related', method: 'GET', path: '/api/research/discover/papers/:paperId/:kind',
    handler: 'handleResearchPaperRelated', summary: "A paper's citation-graph neighbours", effect: 'read',
    input: z.object({
      paperId: pathId('Paper id'),
      kind: z
        .enum(['similar', 'citations', 'references'])
        .describe('similar = semantic neighbours, citations = papers citing it, references = papers it cites; anything else is a 400'),
    }),
  },
  {
    id: 'research.get_paper', method: 'GET', path: '/api/research/discover/papers/:paperId',
    handler: 'handleResearchGetPaper', summary: "A discovered paper's full metadata", effect: 'read',
    input: z.object({ paperId: pathId('Paper id') }),
  },
  {
    id: 'research.create_session', method: 'POST', path: '/api/research/discover/sessions',
    handler: 'handleResearchCreateSession', summary: 'Create a discovery session', effect: 'write',
    input: body('SessionCreate'), description: 'Body `{ name, description?, mode?, config? }`.',
  },
  {
    id: 'research.get_session', method: 'GET', path: '/api/research/discover/sessions/:sessionId',
    handler: 'handleResearchGetSession', summary: 'A discovery session', effect: 'read', input: session,
  },
  {
    id: 'research.update_session', method: 'PATCH', path: '/api/research/discover/sessions/:sessionId',
    handler: 'handleResearchUpdateSession', summary: "Edit a discovery session's name, description, status or config",
    effect: 'write', input: body('SessionUpdate').extend(session.shape),
  },
  {
    id: 'research.delete_session', method: 'DELETE', path: '/api/research/discover/sessions/:sessionId',
    handler: 'handleResearchDeleteSession', summary: 'Delete a discovery session', effect: 'destructive', input: session,
    description: 'An upstream 204 answers `{}` (no `data`).',
  },
  {
    id: 'research.export_session', method: 'GET', path: '/api/research/discover/sessions/:sessionId/export',
    handler: 'handleResearchExportSession', summary: "Export a session's papers as it is now", effect: 'read',
    input: session.extend({
      format: z.enum(['json', 'bibtex', 'ris']).optional().describe("Default 'json'; any other value is a 400"),
    }),
  },
  {
    id: 'research.get_review_export', method: 'GET',
    path: '/api/research/discover/sessions/:sessionId/review-export/:batchId', handler: 'handleResearchGetReviewExport',
    summary: 'A frozen review-export document', effect: 'read',
    input: session.extend({ batchId: pathId('Review-export batch id') }),
    description:
      'The bytes were sealed upstream (RFC 8785) but cross two JSON hops: re-canonicalise before checking the digest.',
  },
  {
    id: 'research.create_review_export', method: 'POST', path: '/api/research/discover/sessions/:sessionId/review-export',
    handler: 'handleResearchCreateReviewExport', summary: 'Freeze and digest a session for evidence review',
    effect: 'write', input: session, successStatus: 201,
    description: 'Answers 201 with the receipt `{ batch_id, session_id, digest, record_count, created_at }`. No body is read.',
  },
  {
    id: 'research.list_review_exports', method: 'GET', path: '/api/research/discover/sessions/:sessionId/review-export',
    handler: 'handleResearchListReviewExports', summary: "A session's review-export receipts", effect: 'read', input: session,
  },
  {
    id: 'research.ingest_push', method: 'POST', path: '/api/research/discover/ingest/push',
    handler: 'handleResearchIngestPush', summary: 'Push selected papers into the tenant KAG graph', effect: 'write',
    input: body('IngestPushRequest'),
    description: 'Body `{ session_id, paper_ids[], mode? }`. Asynchronous: poll GET /api/research/discover/ingest/push/{pushId}.',
  },
  {
    id: 'research.get_ingest_push', method: 'GET', path: '/api/research/discover/ingest/push/:pushId',
    handler: 'handleResearchIngestPushStatus', summary: 'An ingest push status', effect: 'read',
    input: z.object({ pushId: pathId('Ingest push id') }),
  },
  {
    id: 'research.start_snowball', method: 'POST', path: '/api/research/discover/snowball',
    handler: 'handleResearchSnowballStart', summary: 'Start a citation-graph snowball walk', effect: 'write',
    input: body('SnowballRequest'),
    description:
      'Body `{ seed_paper_ids[], session_id, direction?, max_depth?, max_papers? }`; discovered papers are persisted ' +
      'into the session. Poll GET /api/research/discover/snowball/{jobId}.',
  },
  {
    id: 'research.snowball_status', method: 'GET', path: '/api/research/discover/snowball/:jobId',
    handler: 'handleResearchSnowballStatus', summary: 'A snowball job status', effect: 'read',
    input: z.object({ jobId: pathId('Snowball job id') }),
  },
  {
    id: 'research.cancel_snowball', method: 'POST', path: '/api/research/discover/snowball/:jobId/cancel',
    handler: 'handleResearchSnowballCancel', summary: 'Cancel a snowball job', effect: 'write',
    input: z.object({ jobId: pathId('Snowball job id') }),
  },
  {
    id: 'research.pause_session', method: 'POST', path: '/api/research/discover/sessions/:sessionId/pause',
    handler: 'handleResearchPauseSession', summary: 'Pause a discovery session', effect: 'write', input: session,
  },
  {
    id: 'research.resume_session', method: 'POST', path: '/api/research/discover/sessions/:sessionId/resume',
    handler: 'handleResearchResumeSession', summary: 'Resume a paused discovery session', effect: 'write', input: session,
  },
  {
    id: 'research.session_insights', method: 'GET', path: '/api/research/discover/sessions/:sessionId/insights',
    handler: 'handleResearchSessionInsights', summary: "A session's ingest-event health", effect: 'read', input: session,
  },
  {
    id: 'research.score_report', method: 'GET', path: '/api/research/discover/score/report/:sessionId',
    handler: 'handleResearchScoreReport', summary: "A session's trust-score distribution", effect: 'read', input: session,
  },
  {
    id: 'research.semantic_search', method: 'POST', path: '/api/research/discover/search/semantic',
    handler: 'handleResearchSemanticSearch', summary: "Semantic search over a session's papers", effect: 'read',
    input: body('SemanticSearchRequest').extend({ query: requiredString('Search text') }),
    description: 'Body `{ query, session_id?, limit? }`.',
  },
];

export const RESEARCH_DISCOVER_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = researchCapabilities(
  'research',
  'Research',
  'src/routes/research/discover.ts',
  () => import('../../routes/research/discover'),
  ROUTES,
);
