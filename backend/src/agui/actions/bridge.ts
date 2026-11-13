// fr/backend/src/agui/actions/bridge.ts
//
// AG-UI agent-callable actions for the analysis-to-kanban bridge. See spec
// `docs/superpowers/specs/completed/2026-04-24-analysis-to-kanban-bridge.md`
// §"Agent-callable actions". Every action delegates to the same domain
// service the HTTP route layer calls, so behavior stays identical regardless
// of entry point.
//
// Registration is gated by `FR_FEATURE_BRIDGE` at server boot; see
// `server.ts`.

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { db as defaultDb } from '../../db/client';
import { cardDrafts } from '../../db/schema';
import {
  IntegrationError,
} from '../../integrations/_lib/errors';

import { assertProjectInCallerTenant, scopedFilters } from '../../domain/bridge/caller-scope';
import { bridgeRegistry } from '../../domain/bridge/registry';
import { commitService } from '../../domain/bridge/commit';
import { outputIdsKey } from '../../domain/bridge/dedup';
import { draftService } from '../../domain/bridge/drafts';
import { submitService } from '../../domain/bridge/submit';
import type {
  BridgeCtx,
  Initiator,
  ProducerId,
} from '../../domain/bridge/types';
import type { RequestContext } from '../../integrations/_lib/context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRODUCERS = ['coding', 'kag', 'artifacts'] as const;

function sha256Hex(s: string): string {
  return new Bun.CryptoHasher('sha256').update(s).digest('hex');
}

/**
 * Build a BridgeCtx from an ActionContext. The agent core supplies
 * (userId, projectId, correlationId, initiator, channel); we synthesize a
 * RequestContext shape compatible with `integrations/_lib/context.ts`.
 */
async function ctxToBridge(ctx: ActionContext): Promise<BridgeCtx> {
  if (!ctx.projectId) {
    throw new IntegrationError({
      // Caller-side: the invoking agent session did not bind a project, and
      // binding one is something the caller can actually do. Distinct from the
      // tenantId guard below, which is a tenancy question, not an input one.
      code: 'BAD_REQUEST',
      message: 'bridge.* actions require ctx.projectId',
    });
  }
  if (!ctx.tenantId) {
    // Migration 042 — bridge SubmitService writes approvals + required_approvers
    // rows that need a tenant_id. The AG-UI invoke layer (routes/agui.ts)
    // resolves ctx.tenantId from the agent session; an unaffiliated caller
    // cannot create a bridge approval.
    throw new IntegrationError({
      code: 'MISSING_TENANT',
      message: 'bridge.* actions require ctx.tenantId (caller has no resolvable tenant)',
    });
  }
  // H5: same tenant-scoped project check as the REST buildBridgeCtx.
  await assertProjectInCallerTenant(defaultDb, ctx.projectId, ctx.tenantId);
  const request: RequestContext = {
    correlationId: ctx.correlationId,
    initiator: ctx.initiator,
    channel: ctx.channel,
    bearerToken: undefined,
    // The bridge sources' output caches are keyed by tenantId|userId and
    // refuse to cache an unscoped context, so the caller's scope MUST ride
    // on the request ctx (it was previously dropped here).
    tenantId: ctx.tenantId,
    userId: ctx.userId,
  };
  return {
    request,
    user_id: ctx.userId,
    project_id: ctx.projectId,
    tenant_id: ctx.tenantId,
  };
}

function draftInitiator(reqInitiator: ActionContext['initiator']): Initiator {
  return reqInitiator === 'human' ? 'user' : reqInitiator;
}

// ---------------------------------------------------------------------------
// Schemas (zod) — kept loose where the underlying domain types are loose so
// authors can extend without churn here.
// ---------------------------------------------------------------------------

const overridesSchema = z
  .object({
    title: z.string().optional(),
    body_md: z.string().optional(),
    project_id: z.string().optional(),
    board_id: z.string().optional(),
    list_id: z.string().optional(),
    assignee_user_id: z.string().optional(),
    labels: z.array(z.string()).optional(),
  })
  .partial()
  .optional();

const toolOutputSchema = z.object({
  producer: z.enum(PRODUCERS),
  run_id: z.string(),
  output_id: z.string(),
  stable_id: z.string(),
  title: z.string(),
  body_md: z.string(),
  severity: z.enum(['low', 'moderate', 'high', 'critical']).optional(),
  source_ref: z
    .object({
      file_path: z.string().optional(),
      line_number: z.number().optional(),
      url: z.string().optional(),
      artifact_id: z.string().optional(),
    })
    .optional(),
  suggested_labels: z.array(z.string()).optional(),
  suggested_project_id: z.string().optional(),
});

const draftRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  drafter_id: z.string(),
  initiator: z.string(),
  producer: z.string(),
  run_id: z.string(),
  output_id: z.string(),
  stable_id: z.string(),
  content_digest: z.string(),
  title: z.string(),
  body_md: z.string(),
  target_project_id: z.string().nullable(),
  target_board_id: z.string().nullable(),
  target_list_id: z.string().nullable(),
  assignee_user_id: z.string().nullable(),
  labels: z.array(z.string()),
  status: z.string(),
  approval_id: z.string().nullable(),
  committed_card_id: z.string().nullable(),
  dedup_of_card_id: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable().optional(),
  created_at: z.date(),
  updated_at: z.date(),
});

// ---------------------------------------------------------------------------
// Idempotency replay (mirrors routes/tools/bridge.ts)
// ---------------------------------------------------------------------------

async function findDraftsByIdempotency(
  projectId: string,
  producer: ProducerId,
  outputIds: string[],
  idempotencyKey: string,
): Promise<typeof cardDrafts.$inferSelect[] | null> {
  // Use the shared canonical encoder so a route-stamped key matches an
  // action-stamped key on replay. (Previously this used .join(',') which
  // disagreed with the routes layer's JSON.stringify-of-sorted-array form.)
  const sortedKey = outputIdsKey(outputIds);
  const rows = await defaultDb
    .select()
    .from(cardDrafts)
    .where(
      and(
        eq(cardDrafts.project_id, projectId),
        eq(cardDrafts.producer, producer),
        sql`${cardDrafts.metadata} ->> 'idempotency_key' = ${idempotencyKey}`,
        sql`${cardDrafts.metadata} ->> 'output_ids_key' = ${sortedKey}`,
      ),
    );
  return rows.length > 0 ? rows : null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const listSourcesAction: AgentCallableAction<
  Record<string, never>,
  { sources: { id: string; label: string; filters_schema?: unknown }[] }
> = {
  name: 'bridge.list_sources',
  kind: 'read',
  description:
    'List producers (coding, kag, artifacts) that can promote outputs to kanban card drafts.',
  input: z.object({}).strict(),
  output: z.object({
    sources: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        filters_schema: z.unknown().optional(),
      }),
    ),
  }),
  approval: { type: 'auto' },
  cronSafe: true,
  // Declares `public` rather than falling through to `defaultRule()`, whose
  // project-less default is `{type:'tenant-role', role:'user'}` — a role the
  // portal realm does not currently issue (see
  // tests/unit/agui/tenant-role-names.test.ts; the fix for that is in Keycloak,
  // not here).
  //
  // Independently of that gap, this is the right rule: the handler reads
  // `bridgeRegistry.list()`, a process-global registry of producer names with
  // no tenant data. A static catalog should say `public` explicitly rather than
  // inherit a tenant rule it does not need.
  //
  // Deliberately NOT applied to the other bridge actions: they read and write
  // tenant-scoped card_drafts, so deny-by-default is the right posture for them
  // until a tenant-member rule exists.
  rbac: { type: 'public' },
  // Namespace on bridgeRegistry.generation so partial-boot caching of an
  // empty sources[] doesn't persist for 24h once registration completes.
  idempotencyKey: () => `bridge.list_sources:v1:gen=${bridgeRegistry.generation}`,
  handler: async () => ({
    sources: bridgeRegistry.list().map((s) => ({ id: s.id, label: s.id })),
  }),
};

const listOutputsInput = z.object({
  producer: z.enum(PRODUCERS),
  filters: z.record(z.string()).optional(),
});
type ListOutputsInput = z.infer<typeof listOutputsInput>;

const listOutputsAction: AgentCallableAction<
  ListOutputsInput,
  { outputs: z.infer<typeof toolOutputSchema>[] }
> = {
  name: 'bridge.list_outputs',
  kind: 'read',
  description:
    'List promotable outputs from a producer (filter shape varies per producer).',
  input: listOutputsInput,
  output: z.object({ outputs: z.array(toolOutputSchema) }),
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `bridge.list_outputs:${input.producer}:${JSON.stringify(input.filters ?? {})}`,
  handler: async (input, ctx) => {
    const bridgeCtx = await ctxToBridge(ctx);
    const source = bridgeRegistry.get(input.producer);
    // Identity comes from the authenticated context, never from the caller's
    // filter bag — see domain/bridge/caller-scope.ts. Every sibling action here
    // already reads bridgeCtx (project_id at :284/:334, user_id at :477); this
    // one passed `filters` straight through, which is how a caller could list
    // another user's coding findings.
    const outputs = await source.listOutputs(
      bridgeCtx.request,
      scopedFilters(input.filters, bridgeCtx),
    );
    return { outputs };
  },
};

const draftFromOutputInput = z.object({
  producer: z.enum(PRODUCERS),
  output_id: z.string().min(1),
  overrides: overridesSchema,
  idempotency_key: z.string().min(1),
});
type DraftFromOutputInput = z.infer<typeof draftFromOutputInput>;

const draftFromOutputAction: AgentCallableAction<
  DraftFromOutputInput,
  { draft: z.infer<typeof draftRowSchema> }
> = {
  name: 'bridge.draft_card_from_output',
  kind: 'write',
  description:
    'Create a single editable card_drafts row from one tool output. Requires drafter approval.',
  input: draftFromOutputInput,
  output: z.object({ draft: draftRowSchema }),
  approval: { type: 'single-approver', approver: 'initiator' },
  cronSafe: false,
  idempotencyKey: (input) =>
    `bridge.draft_card_from_output:${input.idempotency_key}:${input.producer}:${input.output_id}`,
  handler: async (input, ctx) => {
    const bridgeCtx = await ctxToBridge(ctx);
    const initiator = draftInitiator(ctx.initiator);
    const prior = await findDraftsByIdempotency(
      bridgeCtx.project_id,
      input.producer,
      [input.output_id],
      input.idempotency_key,
    );
    if (prior && prior[0]) return { draft: prior[0] };

    const result = await draftService.create(defaultDb, bridgeCtx, {
      producer: input.producer,
      output_ids: [input.output_id],
      overrides: input.overrides as Parameters<typeof draftService.create>[2]['overrides'],
      initiator,
      idempotency_key: input.idempotency_key,
      output_ids_key: outputIdsKey([input.output_id]),
    });
    if (!result[0]) {
      throw new Error('draftService.create returned no rows');
    }
    return { draft: result[0] };
  },
};

const draftCardsFromOutputsInput = z.object({
  producer: z.enum(PRODUCERS),
  output_ids: z.array(z.string().min(1)).min(1),
  overrides: overridesSchema,
  idempotency_key: z.string().min(1),
});
type DraftCardsFromOutputsInput = z.infer<typeof draftCardsFromOutputsInput>;

const draftCardsFromOutputsAction: AgentCallableAction<
  DraftCardsFromOutputsInput,
  { drafts: z.infer<typeof draftRowSchema>[] }
> = {
  name: 'bridge.draft_cards_from_outputs',
  kind: 'write',
  description:
    'Bulk-create editable card_drafts rows from multiple outputs of one producer.',
  input: draftCardsFromOutputsInput,
  output: z.object({ drafts: z.array(draftRowSchema) }),
  approval: { type: 'single-approver', approver: 'initiator' },
  cronSafe: false,
  idempotencyKey: (input) => {
    const sorted = [...input.output_ids].sort().join(',');
    return `bridge.draft_cards_from_outputs:${input.idempotency_key}:${input.producer}:${sha256Hex(sorted)}`;
  },
  handler: async (input, ctx) => {
    const bridgeCtx = await ctxToBridge(ctx);
    const initiator = draftInitiator(ctx.initiator);
    const prior = await findDraftsByIdempotency(
      bridgeCtx.project_id,
      input.producer,
      input.output_ids,
      input.idempotency_key,
    );
    if (prior) return { drafts: prior };

    const result = await draftService.create(defaultDb, bridgeCtx, {
      producer: input.producer,
      output_ids: input.output_ids,
      overrides: input.overrides as Parameters<typeof draftService.create>[2]['overrides'],
      initiator,
      idempotency_key: input.idempotency_key,
      output_ids_key: outputIdsKey(input.output_ids),
    });
    return { drafts: result };
  },
};

const editDraftInput = z.object({
  draft_id: z.string().uuid(),
  patch: z
    .object({
      title: z.string().optional(),
      body_md: z.string().optional(),
      target_project_id: z.string().optional(),
      target_board_id: z.string().optional(),
      target_list_id: z.string().optional(),
      assignee_user_id: z.string().uuid().optional(),
      labels: z.array(z.string()).optional(),
    })
    .strict(),
  idempotency_key: z.string().min(1),
});
type EditDraftInput = z.infer<typeof editDraftInput>;

const editDraftAction: AgentCallableAction<
  EditDraftInput,
  { draft: z.infer<typeof draftRowSchema> }
> = {
  name: 'bridge.edit_draft',
  kind: 'write',
  description: 'Patch an editable card draft (title/body/target/assignee/labels).',
  input: editDraftInput,
  output: z.object({ draft: draftRowSchema }),
  approval: { type: 'single-approver', approver: 'initiator' },
  cronSafe: false,
  idempotencyKey: (input) =>
    `bridge.edit_draft:${input.idempotency_key}:${input.draft_id}:${sha256Hex(JSON.stringify(input.patch))}`,
  handler: async (input, ctx) => {
    const bridgeCtx = await ctxToBridge(ctx);
    const row = await draftService.patch(
      defaultDb,
      bridgeCtx,
      input.draft_id,
      input.patch,
    );
    const patchHash = sha256Hex(JSON.stringify(input.patch));
    const merged = {
      ...(row.metadata ?? {}),
      idempotency_key: input.idempotency_key,
      patch_hash: patchHash,
    };
    await defaultDb
      .update(cardDrafts)
      .set({ metadata: merged })
      .where(eq(cardDrafts.id, row.id));
    row.metadata = merged;
    return { draft: row };
  },
};

const submitDraftInput = z.object({
  draft_id: z.string().uuid(),
  idempotency_key: z.string().min(1),
});
type SubmitDraftInput = z.infer<typeof submitDraftInput>;

const submitDraftAction: AgentCallableAction<
  SubmitDraftInput,
  { approval_id: string; broadcasted_to: number }
> = {
  name: 'bridge.submit_draft',
  kind: 'write',
  description:
    'Submit a card draft for approval. Creates an approvals row and broadcasts to the drafter.',
  input: submitDraftInput,
  output: z.object({
    approval_id: z.string(),
    broadcasted_to: z.number(),
  }),
  // Project-default approver set; concrete resolution happens in the
  // approval backend (E-5). Encoded as `single-approver` here per spec
  // table — the backend interprets `'project-owner'` as the default set.
  approval: { type: 'single-approver', approver: 'project-owner' },
  cronSafe: false,
  idempotencyKey: (input) =>
    `bridge.submit_draft:${input.idempotency_key}:${input.draft_id}`,
  handler: async (input, ctx) => {
    const bridgeCtx = await ctxToBridge(ctx);
    const result = await submitService.submit(
      defaultDb,
      bridgeCtx,
      input.draft_id,
    );
    return {
      approval_id: result.approval_id,
      broadcasted_to: result.broadcasted_to,
    };
  },
};

const rejectDraftInput = z.object({
  draft_id: z.string().uuid(),
  reason: z.string().optional(),
  idempotency_key: z.string().min(1),
});
type RejectDraftInput = z.infer<typeof rejectDraftInput>;

type RejectDraftOutput = { ok: true; reason: string | null };

const rejectDraftAction: AgentCallableAction<
  RejectDraftInput,
  RejectDraftOutput
> = {
  name: 'bridge.reject_draft',
  kind: 'write',
  description: 'Reject (soft-delete) a card draft. Only the drafter may approve.',
  input: rejectDraftInput,
  output: z.object({
    ok: z.literal(true),
    reason: z.string().nullable(),
  }),
  approval: { type: 'single-approver', approver: 'initiator' },
  cronSafe: false,
  idempotencyKey: (input) =>
    `bridge.reject_draft:${input.idempotency_key}:${input.draft_id}`,
  handler: async (input, ctx) => {
    const bridgeCtx = await ctxToBridge(ctx);
    const row = await draftService.reject(
      defaultDb,
      bridgeCtx,
      input.draft_id,
      bridgeCtx.user_id,
      input.reason,
    );
    const persistedReason = (row.metadata as Record<string, unknown> | null)
      ?.rejection_reason;
    return {
      ok: true as const,
      reason:
        typeof persistedReason === 'string' ? persistedReason : null,
    };
  },
};

// `bridge.commit_draft` is the commit-callback target invoked after consensus
// on a `bridge.submit_draft` approval. It is not a first-class action in the
// spec's "Agent-callable actions" table, but it must exist as an AG-UI action
// so the approval-completion handler can dispatch to it via the same registry
// the other six actions use. Approval policy mirrors `submit_draft`
// ('project-owner') because the commit happens on behalf of the project after
// the human approval has already cleared.
const commitDraftInput = z.object({
  draft_id: z.string().uuid(),
  idempotency_key: z.string().min(1),
});
type CommitDraftInput = z.infer<typeof commitDraftInput>;

const commitDraftAction: AgentCallableAction<
  CommitDraftInput,
  { card_id: string; idempotent: boolean }
> = {
  name: 'bridge.commit_draft',
  kind: 'write',
  description:
    'Commit an approved card draft: write the Planka card and stamp card_bridge_links. Idempotent on retry.',
  input: commitDraftInput,
  output: z.object({
    card_id: z.string(),
    idempotent: z.boolean(),
  }),
  approval: { type: 'single-approver', approver: 'project-owner' },
  cronSafe: false,
  idempotencyKey: (input) =>
    `bridge.commit_draft:${input.idempotency_key}:${input.draft_id}`,
  handler: async (input, ctx) => {
    const bridgeCtx = await ctxToBridge(ctx);
    return await commitService.commit(defaultDb, bridgeCtx, input.draft_id);
  },
};

// ---------------------------------------------------------------------------
// Registration entry point
// ---------------------------------------------------------------------------

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

export function registerBridgeActions(): void {
  safeRegister(listSourcesAction);
  safeRegister(listOutputsAction);
  safeRegister(draftFromOutputAction);
  safeRegister(draftCardsFromOutputsAction);
  safeRegister(editDraftAction);
  safeRegister(submitDraftAction);
  safeRegister(rejectDraftAction);
  safeRegister(commitDraftAction);
}
