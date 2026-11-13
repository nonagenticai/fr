/**
 * Plan 3 — agent.search_library AG-UI action.
 *
 * Fans out a free-text search across the 5D memory:
 *   - requirements_management (requirements)
 *   - principles
 *   - decisions
 *   - kag (KAG documents)
 *
 * Returns a ranked union with source labels so the agent can decide what
 * to surface.
 *
 * The fanout is parallel (Promise.all). If one upstream is unreachable we
 * still return results from the others — partial >> empty.
 *
 * Foundation Plan 2 effective-set scoping is applied per-source via
 * `applyEffectiveFilter(workspaceId, assetType, upstream, projectId, workspaceName)`
 * when the request carries both a tenantId (resolved at the AG-UI invoke
 * layer via `getUserTenant`) and a projectId. `tenantName` is passed
 * through so the lazy `ensureWorkspace` insert seeds a legible name
 * (mirrors PR #239 on the Keycloak-User path). When tenantId / projectId
 * is missing the upstream array passes through unscoped — but a non-platform
 * (or unresolved) tenant still never receives a system-owned row
 * (`dropSystemRowsForCustomer`).
 */

import { z } from 'zod';
import { clientSafeUpstreamText } from '../../integrations/_lib/errors';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { rmJson } from '../../integrations/architecture';
import {
  getSearchDecisionsUrl,
  getSearchPrinciplesUrl,
  getSearchRequirementsUrl,
  type DecisionOut,
  type PrincipleOut,
  type RequirementOut,
} from '@fr/service-client-requirements';
import * as effectiveQuery from '../../routes/assets/_lib/effective-query';
import type { AssetType } from '../../services/asset-assignments';

const inputSchema = z.object({
  query: z.string().min(1),
  /** Per-source result cap; total is up to 3 * limit. */
  limit: z.number().int().min(1).max(20).default(5),
});

const resultItemSchema = z.object({
  source: z.enum(['requirement', 'principle', 'decision', 'kag']),
  id: z.string(),
  title: z.string(),
  snippet: z.string().optional(),
});

/**
 * Whether the `projectId` this action scoped by names a real project.
 *
 * ⛔ THIS IS THE NON-HTTP ANALOGUE OF `X-Project-Resolved`, and it exists because
 * the header cannot reach here. `routes/assets/_lib/effective-query.ts` returns
 * `[]` for a well-formed-but-unknown project id, and justifies that `[]` ONLY on
 * the grounds that the caller learns the cause out of band — "an empty set
 * WITHOUT that header would be the defect that comment warns about". All ten
 * route callers now emit `projectScopeHeaders(...)`. This action is the
 * ELEVENTH caller and emits no headers at all: it answers AG-UI events, not a
 * `{data}` envelope, so the same obligation has to be discharged IN THE BODY.
 * Before this field, an unresolvable projectId produced a confident, silent
 * `results: []` across four sources.
 *
 *   `resolved`   — the project exists; an empty result set means no matches.
 *   `unknown`    — the id is well-formed and resolves to NO project. The empty
 *                  set is an artefact of the scope, not a statement about the
 *                  library. Not an error: answering 404 here would make this an
 *                  existence oracle for other tenants' projects, which is the
 *                  reasoning `effective-set.ts` already gives for preferring 400
 *                  over 404 on a malformed id.
 *   `unverified` — resolution could not be established (a malformed id, or the
 *                  resolver itself failed). The scope was still applied
 *                  fail-CLOSED per source; `errors` names the cause.
 */
const projectScopeSchema = z.object({
  project_id: z.string(),
  resolution: z.enum(['resolved', 'unknown', 'unverified']),
});

const outputSchema = z.object({
  results: z.array(resultItemSchema),
  per_source: z.record(z.number()),
  errors: z.record(z.string()).optional(),
  /**
   * Present only when a project filter was actually applied. Absent means this
   * call asserted nothing about a project scope — the same contract the routes
   * keep by omitting the header when `?project_id=` was absent.
   */
  project_scope: projectScopeSchema.optional(),
});

type Input = z.infer<typeof inputSchema>;
type ResultItem = z.infer<typeof resultItemSchema>;
type Output = z.infer<typeof outputSchema>;

async function safeFan<T>(
  label: string,
  fn: () => Promise<T[]>,
  errors: Record<string, string>,
): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    errors[label] = clientSafeUpstreamText(err);
    return [];
  }
}

const action: AgentCallableAction<Input, Output> = {
  name: 'agent.search_library',
  kind: 'read',
  description:
    'Search the 5D library (requirements, principles, decisions, KAG documents) for entries matching a free-text query. Workspace-default scope.',
  input: inputSchema,
  output: outputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (i) => `agent.search_library:${i.query}:${i.limit}`,
  rbac: { type: 'public' },
  handler: async (input, ctx: ActionContext): Promise<Output> => {
    const errors: Record<string, string> = {};

    const [reqsRaw, prinsRaw, decsRaw] = await Promise.all([
      safeFan('requirement', () =>
        rmJson<RequirementOut[]>(getSearchRequirementsUrl({ q: input.query, k: input.limit }), 'GET'), errors),
      safeFan('principle', () =>
        rmJson<PrincipleOut[]>(getSearchPrinciplesUrl({ q: input.query, k: input.limit }), 'GET'), errors),
      safeFan('decision', () =>
        rmJson<DecisionOut[]>(getSearchDecisionsUrl({ q: input.query, k: input.limit }), 'GET'), errors),
    ]);

    // Foundation Plan 2 effective-set scoping. When the request lacks a
    // tenantId or projectId we short-circuit to unfiltered upstream output
    // — applyEffectiveFilter itself short-circuits on `!projectId`, but
    // the lazy-seed path requires a real workspaceId so we gate on both.
    const scoping = Boolean(ctx.tenantId && ctx.projectId);

    // ⛔ ASKED ONCE, BEFORE THE FAN-OUT, with the SAME predicate the filter uses
    // one layer down, so the reported resolution and the returned rows cannot
    // disagree. This mirrors what the ten route callers do at their own boundary
    // (`projectId === undefined ? undefined : await projectExists(projectId)`).
    // Without it, `applyEffectiveFilter`'s honest `[]` for a ghost project arrives
    // here indistinguishable from "the library holds no matches" — on four sources
    // at once.
    let resolution: 'resolved' | 'unknown' | 'unverified' | undefined;
    if (scoping) {
      try {
        resolution = (await effectiveQuery.projectExists(ctx.projectId!))
          ? 'resolved'
          : 'unknown';
      } catch (err) {
        // A malformed id (`projectExists` throws `BadRequestError` on a non-UUID)
        // or a resolver failure. NOT rethrown: the scope below still runs and
        // still fails closed, so the safe half of the contract holds. What must
        // not happen is claiming `resolved` for something never resolved.
        //
        // ⚠️ CORRECTED: this used to justify the branch with "fr mints
        // `stream:<uuid>` pseudo-project ids that are not UUIDs", present tense.
        // That mint was REMOVED on 2026-09-04 by an explicit operator decision —
        // `handleListProjects` emits the stream's own uuid and `kind:'continuous'`
        // carries the distinction. The tombstones are `routes/projects.ts:1417`
        // and `:1553` — ⚠️ and those hold `stream:${s.id}`, a DIFFERENT literal
        // from the `stream:<uuid>` this comment names. An earlier draft of this
        // retraction said "the only two occurrences of that literal" and pointed
        // at those two lines: the count (2) was right for BOTH strings, so a
        // coincidence did a measurement's work and the error survived checking.
        // Measured: `stream:<uuid>` occurs here and at `services/effective-set.ts`;
        // `stream:${s.id}` occurs only in those two `projects.ts` tombstones. The
        // branch is still correct; only its example was dead. `ctx.projectId` is
        // session-derived, so a non-UUID is not an expected input here — which is
        // why this reports `unverified` rather than pretending to a verdict.
        resolution = 'unverified';
        errors['project-scope-resolution'] =
          clientSafeUpstreamText(err);
      }
    }

    async function scope<T extends { id: string | number }>(
      assetType: AssetType,
      items: T[],
    ): Promise<T[]> {
      // ⛔ Unscoped is not unfiltered: a customer (or an unresolved tenant —
      // fail closed) never receives a system-owned row, the same rule
      // `applyEffectiveFilter` applies on both its branches.
      if (!ctx.tenantId || !ctx.projectId) {
        return effectiveQuery.dropSystemRowsForCustomer(ctx.tenantId, items);
      }
      try {
        return await effectiveQuery.applyEffectiveFilter(
          ctx.tenantId,
          assetType,
          items,
          ctx.projectId,
          ctx.tenantName,
        );
      } catch (err) {
        errors[`${assetType}-scope`] =
          clientSafeUpstreamText(err);
        // ⛔ EMPTY, NOT `items`. This `return items` used to hand back the
        // UNFILTERED upstream list whenever the project scope failed — a
        // fail-OPEN in the leaked-tenant direction, and the precise thing the
        // rest of this change condemns: `effective-query.ts` argues at length
        // that returning the whole workspace for a scope that could not be
        // applied is "the one answer that is certainly wrong, and it is wrong in
        // the direction that leaks the whole tenant". A scope failure means we do
        // not know what this project may see; the only honest answers are "refuse"
        // and "nothing, and here is why".
        //
        // ⭐ CHOSEN: nothing-with-a-reason, PER SOURCE — not a propagated throw.
        // The reason is this action's own documented contract (see the header:
        // "If one upstream is unreachable we still return results from the others
        // — partial >> empty"). It fans out across three libraries; a throw from
        // one scope call would discard four healthy sources, converting a
        // narrow scope fault into a total outage of the agent's search. The
        // failure is NOT silent either way: `errors['<type>-scope']` is part of
        // `outputSchema` and is returned to the caller, and `per_source` drops to
        // 0 for that source alone, so an agent can tell "this source failed" from
        // "this source had no matches". Propagating would also be a behaviour
        // change for every existing caller of a `kind: 'read'` action; returning
        // [] keeps the shape and removes the leak.
        //
        // ⚠️ SEVERITY, HONESTLY: `ctx.projectId` and `ctx.tenantId` are
        // session/auth-derived (see the header comment on this file), NOT
        // caller-supplied query params. So this is materially less reachable than
        // the route-param path the ten route callers guard — no external caller
        // can aim a chosen project id at it. What made it worth fixing now is that
        // this change ADDED a new way in: `projectExists` throws `BadRequestError`
        // on a present-but-empty project id, which is a NEW error path that lands
        // in exactly this catch.
        return [];
      }
    }

    const [reqs, prins, decs] = await Promise.all([
      scope('requirement', reqsRaw as Array<{ id: string | number }>),
      scope('principle', prinsRaw as Array<{ id: string | number }>),
      scope('decision', decsRaw as Array<{ id: string | number }>),
    ]);

    const results: ResultItem[] = [];
    for (const r of reqs) {
      results.push({
        source: 'requirement',
        id: String(getField(r, 'id') ?? ''),
        title: String(getField(r, 'title') ?? getField(r, 'name') ?? '(untitled)'),
        snippet: stringField(r, 'description', 'body', 'summary'),
      });
    }
    for (const p of prins) {
      results.push({
        source: 'principle',
        id: String(getField(p, 'id') ?? ''),
        title: String(getField(p, 'title') ?? getField(p, 'name') ?? '(untitled)'),
        snippet: stringField(p, 'description', 'rationale'),
      });
    }
    for (const d of decs) {
      results.push({
        source: 'decision',
        id: String(getField(d, 'id') ?? ''),
        title: String(getField(d, 'title') ?? '(untitled)'),
        snippet: stringField(d, 'rationale', 'description'),
      });
    }

    return {
      results,
      per_source: {
        requirement: reqs.length,
        principle: prins.length,
        decision: decs.length,
        kag: 0,
      },
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
      // Omitted when no project filter was applied: assert nothing about a scope
      // that was never used. Present on every scoped call, including the
      // `resolved` one — a field that appeared only on failure would be another
      // series you cannot distinguish from an unwired producer.
      ...(resolution !== undefined && ctx.projectId
        ? { project_scope: { project_id: ctx.projectId, resolution } }
        : {}),
    };
  },
};

function getField(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  return (obj as Record<string, unknown>)[key];
}

function stringField(obj: unknown, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = getField(obj, k);
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 200);
  }
  return undefined;
}

function safeRegister<I, O>(a: AgentCallableAction<I, O>): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

/** Registers this module's actions (idempotent); `registerAllActions` calls it at boot. */
export function registerAgentSearchActions(): void {
  safeRegister(action);
}

registerAgentSearchActions();
