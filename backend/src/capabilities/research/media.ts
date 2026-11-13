// fr-agui SPEC §13 P4a2 — spec drain, research: the 10 `/api/research/media/*`
// routes (routes/research/media.ts, the Media Discovery proxy: customer-safe
// reads + compute only, no media writes) re-expressed as capabilities with NO
// behaviour change (`legacyHandler`). Ids equal the `media.*` AG-UI action
// names (agui/actions/media.ts) where one exists; no action is derived.
// Shared responses / rule: ./_shared.ts.
import { z } from 'zod';

import type { Capability } from '../define';
import { pathId, researchCapabilities, upstreamBody, type ResearchRoute } from './_shared';

const item = z.object({ itemId: pathId('Media item id') });

const ROUTES: ResearchRoute[] = [
  {
    id: 'media.search', method: 'POST', path: '/api/research/media/search', handler: 'handleMediaSearch',
    summary: 'Federated media search', effect: 'read', input: upstreamBody('Media Discovery service', 'SearchRequest'),
  },
  {
    id: 'media.list_sources', method: 'GET', path: '/api/research/media/sources', handler: 'handleMediaSources',
    summary: 'List the live media search sources', effect: 'read', input: z.object({}),
  },
  {
    id: 'media.score_batch', method: 'POST', path: '/api/research/media/score/batch', handler: 'handleMediaScoreBatch',
    summary: 'Score a batch of media items', effect: 'read',
    input: upstreamBody('Media Discovery service', 'ScoreBatchRequest'),
  },
  {
    id: 'media.get_score_report', method: 'GET', path: '/api/research/media/score/report/:sessionId',
    handler: 'handleMediaScoreReport', summary: "A prior scoring run's report", effect: 'read',
    input: z.object({ sessionId: pathId('Scoring session id') }),
  },
  {
    id: 'media.list_related', method: 'GET', path: '/api/research/media/items/:itemId/related',
    handler: 'handleMediaItemRelated', summary: 'Media items related to an item', effect: 'read', input: item,
  },
  {
    id: 'media.get_transcript', method: 'GET', path: '/api/research/media/items/:itemId/transcript',
    handler: 'handleMediaItemTranscript', summary: "A media item's transcript", effect: 'read', input: item,
  },
  {
    id: 'media.score_item', method: 'GET', path: '/api/research/media/items/:itemId/score',
    handler: 'handleMediaItemScore', summary: "A media item's relevance score", effect: 'read', input: item,
  },
  {
    id: 'media.get_item', method: 'GET', path: '/api/research/media/items/:itemId', handler: 'handleMediaItem',
    summary: 'A media item', effect: 'read', input: item,
  },
  {
    id: 'media.list_collections', method: 'GET', path: '/api/research/media/collections',
    handler: 'handleMediaCollections', summary: "Browse the tenant's media collections", effect: 'read', input: z.object({}),
  },
  {
    id: 'media.get_collection', method: 'GET', path: '/api/research/media/collections/:collectionId',
    handler: 'handleMediaCollection', summary: 'A media collection', effect: 'read',
    input: z.object({ collectionId: pathId('Collection id') }),
  },
];

export const RESEARCH_MEDIA_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = researchCapabilities(
  'media',
  'Media',
  'src/routes/research/media.ts',
  () => import('../../routes/research/media'),
  ROUTES,
);
