/**
 * AG-UI agent-callable read actions for the `media` (Media Discovery) upstream.
 *
 * Mirrors `actions/principles.ts` in shape and tenant threading — see that
 * file for design notes.
 *
 * Scope: ONLY the customer-safe READ + COMPUTE surface already exposed by
 * `integrations/media.ts` (search, item detail/related/transcript/score,
 * collection browse, score report). Media WRITES (collection create/delete/
 * add/remove/import, download create, ingest push) are deliberately NOT
 * wrapped — they have no BFF route either and stay in the n8n node / admin
 * tooling. `mediaScoreBatch` is a POST compute over a caller-supplied batch;
 * it is intentionally left out of this catalog too (see the note below).
 *
 * Every upstream call is tenant-isolated via an explicit `X-Tenant-Id`, so
 * every action here requires `ctx.tenantId`. There is NO unscoped fallback:
 * a caller without a resolved tenant gets an error rather than a widened
 * (cross-tenant / DEFAULT_TENANT) read.
 */

import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { RbacDeniedError } from '../rbac';
import {
  mediaSearch,
  mediaSources,
  mediaItem,
  mediaItemRelated,
  mediaItemTranscript,
  mediaItemScore,
  mediaCollections,
  mediaCollection,
  mediaScoreReport,
} from '../../integrations/media';

function requireTenantId(ctx: ActionContext): string {
  if (!ctx.tenantId) {
    // Non-retriable BY DESIGN. A raw Error here mapped to
    // `internal_error, retriable:true`, so an agent would retry a call that
    // can never succeed, and the operator saw a stack trace instead of a
    // cause. A caller with no resolved tenant cannot be scoped to tenant data,
    // so this is an authorization outcome, not a fault.
    //
    // Deliberately NOT "return unfiltered" (the `ActionContext.tenantId`
    // docstring's advice): that guidance is for post-hoc result filtering via
    // applyEffectiveFilter. Here tenantId is a REQUIRED upstream scope
    // parameter — dropping it would widen a tenant-scoped read, which is
    // strictly worse than failing.
    throw new RbacDeniedError(
      'tenant_unresolved',
      'media.*',
      'caller is not in a resolved tenant context (no tenant on the agent token and no user_roles row)',
    );
  }
  return ctx.tenantId;
}

// ---------- schemas ----------

const searchInputSchema = z.object({
  query: z.string().min(1),
  sources: z.array(z.string().min(1)).optional(),
  max_results_per_source: z.number().int().min(1).max(100).optional(),
  media_type: z.string().min(1).optional(),
});
type SearchInput = z.infer<typeof searchInputSchema>;
const searchOutputSchema = z.object({ results: z.unknown() });

const sourcesInputSchema = z.object({}).strict();
type SourcesInput = z.infer<typeof sourcesInputSchema>;
const sourcesOutputSchema = z.object({ sources: z.unknown() });

const itemInputSchema = z.object({ item_id: z.string().min(1) });
type ItemInput = z.infer<typeof itemInputSchema>;
const itemOutputSchema = z.object({ item: z.unknown() });

const relatedInputSchema = z.object({ item_id: z.string().min(1) });
type RelatedInput = z.infer<typeof relatedInputSchema>;
const relatedOutputSchema = z.object({ related: z.unknown() });

const transcriptInputSchema = z.object({ item_id: z.string().min(1) });
type TranscriptInput = z.infer<typeof transcriptInputSchema>;
const transcriptOutputSchema = z.object({ transcript: z.unknown() });

const itemScoreInputSchema = z.object({ item_id: z.string().min(1) });
type ItemScoreInput = z.infer<typeof itemScoreInputSchema>;
const itemScoreOutputSchema = z.object({ score: z.unknown() });

const collectionsInputSchema = z.object({}).strict();
type CollectionsInput = z.infer<typeof collectionsInputSchema>;
const collectionsOutputSchema = z.object({ collections: z.unknown() });

const collectionInputSchema = z.object({ collection_id: z.string().min(1) });
type CollectionInput = z.infer<typeof collectionInputSchema>;
const collectionOutputSchema = z.object({ collection: z.unknown() });

const scoreReportInputSchema = z.object({ session_id: z.string().min(1) });
type ScoreReportInput = z.infer<typeof scoreReportInputSchema>;
const scoreReportOutputSchema = z.object({ report: z.unknown() });

// ---------- actions ----------

const searchAction: AgentCallableAction<SearchInput, z.infer<typeof searchOutputSchema>> = {
  name: 'media.search',
  kind: 'read',
  description:
    'Federated media search across the registered Media Discovery sources. `query` is required; optional `sources`, `max_results_per_source`, `media_type` narrow the fan-out. Scoped to the calling tenant.',
  input: searchInputSchema,
  output: searchOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) =>
    `media.search:${i.query}:${(i.sources ?? []).join(',')}:${i.max_results_per_source ?? ''}:${i.media_type ?? ''}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    // ⚠️ TRANSLATE at this boundary. media-discovery's `SearchRequest`
    // (`src/schemas.py`) names these `limit` and `media_types`, and the model
    // carries pydantic's default `extra="ignore"` — so `max_results_per_source`
    // and `media_type` were accepted with a 200 and SILENTLY DISCARDED. Neither
    // the paging nor the type filter has ever taken effect, and nothing said so:
    // the response was a normal, plausible full-width result set.
    //
    // The action's INPUT names are deliberately left alone — they are the
    // published AG-UI contract, they feed `idempotencyKey` above, and
    // `research.ts` uses `max_results_per_source` against a different
    // downstream. Renaming the input would break callers to fix a wire bug.
    //
    // `limit` is bounded `ge=1, le=100` server-side and this schema already caps
    // at 100, so the two agree. `media_types` is a LIST there and a single
    // string here; one value is wrapped rather than the field being widened,
    // because widening the input is a contract change and this is a bug fix.
    const body: Record<string, unknown> = { query: input.query };
    if (input.sources !== undefined) body.sources = input.sources;
    if (input.max_results_per_source !== undefined) {
      body.limit = input.max_results_per_source;
    }
    if (input.media_type !== undefined) body.media_types = [input.media_type];
    const results = await mediaSearch(body, tenantId);
    return { results };
  },
};

const sourcesAction: AgentCallableAction<SourcesInput, z.infer<typeof sourcesOutputSchema>> = {
  name: 'media.list_sources',
  kind: 'read',
  description:
    'List the live registered media search sources and their enabled state, for the calling tenant.',
  input: sourcesInputSchema,
  output: sourcesOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: () => 'media.list_sources',
  handler: async (_input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const sources = await mediaSources(tenantId);
    return { sources };
  },
};

const itemAction: AgentCallableAction<ItemInput, z.infer<typeof itemOutputSchema>> = {
  name: 'media.get_item',
  kind: 'read',
  description: "Fetch a single media item's full detail by id, scoped to the calling tenant.",
  input: itemInputSchema,
  output: itemOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `media.get_item:${i.item_id}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const item = await mediaItem(input.item_id, tenantId);
    return { item };
  },
};

const relatedAction: AgentCallableAction<RelatedInput, z.infer<typeof relatedOutputSchema>> = {
  name: 'media.list_related',
  kind: 'read',
  description:
    'Media items related to a given item (semantic / same-collection neighbours), scoped to the calling tenant.',
  input: relatedInputSchema,
  output: relatedOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `media.list_related:${i.item_id}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const related = await mediaItemRelated(input.item_id, tenantId);
    return { related };
  },
};

const transcriptAction: AgentCallableAction<
  TranscriptInput,
  z.infer<typeof transcriptOutputSchema>
> = {
  name: 'media.get_transcript',
  kind: 'read',
  description:
    "A media item's transcript — the trust surface recording what was actually said. Scoped to the calling tenant.",
  input: transcriptInputSchema,
  output: transcriptOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `media.get_transcript:${i.item_id}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const transcript = await mediaItemTranscript(input.item_id, tenantId);
    return { transcript };
  },
};

const itemScoreAction: AgentCallableAction<
  ItemScoreInput,
  z.infer<typeof itemScoreOutputSchema>
> = {
  name: 'media.score_item',
  kind: 'read',
  description:
    "A media item's relevance/quality score. Pure compute upstream — no mutation. Scoped to the calling tenant.",
  input: itemScoreInputSchema,
  output: itemScoreOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `media.score_item:${i.item_id}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const score = await mediaItemScore(input.item_id, tenantId);
    return { score };
  },
};

const collectionsAction: AgentCallableAction<
  CollectionsInput,
  z.infer<typeof collectionsOutputSchema>
> = {
  name: 'media.list_collections',
  kind: 'read',
  description: "Browse the calling tenant's media collections.",
  input: collectionsInputSchema,
  output: collectionsOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: () => 'media.list_collections',
  handler: async (_input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const collections = await mediaCollections(tenantId);
    return { collections };
  },
};

const collectionAction: AgentCallableAction<
  CollectionInput,
  z.infer<typeof collectionOutputSchema>
> = {
  name: 'media.get_collection',
  kind: 'read',
  description: "A single media collection's detail and its items, scoped to the calling tenant.",
  input: collectionInputSchema,
  output: collectionOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `media.get_collection:${i.collection_id}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const collection = await mediaCollection(input.collection_id, tenantId);
    return { collection };
  },
};

const scoreReportAction: AgentCallableAction<
  ScoreReportInput,
  z.infer<typeof scoreReportOutputSchema>
> = {
  name: 'media.get_score_report',
  kind: 'read',
  description:
    "Fetch a prior media scoring run's report by session id, scoped to the calling tenant.",
  input: scoreReportInputSchema,
  output: scoreReportOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `media.get_score_report:${i.session_id}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    const report = await mediaScoreReport(input.session_id, tenantId);
    return { report };
  },
};

function safeRegister<I, O>(action: AgentCallableAction<I, O>): void {
  try {
    registerAction(action);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') {
      return;
    }
    throw err;
  }
}

export function registerMediaActions(): void {
  safeRegister(searchAction);
  safeRegister(sourcesAction);
  safeRegister(itemAction);
  safeRegister(relatedAction);
  safeRegister(transcriptAction);
  safeRegister(itemScoreAction);
  safeRegister(collectionsAction);
  safeRegister(collectionAction);
  safeRegister(scoreReportAction);
}
