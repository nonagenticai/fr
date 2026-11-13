/**
 * AG-UI agent-callable read actions for the `decisions` upstream. Same
 * shape as `actions/requirements.ts` — see that file for design notes.
 */

import { z } from 'zod';

import { registerAction } from '../registry';
import type { AgentCallableAction } from '../types';
import {
  listDecisions,
  getDecision,
  listDecisionVersions,
} from '../../integrations/decisions';
import { rmCall } from '../../integrations/architecture';
import { getSearchDecisionsUrl, type DecisionOut } from '@fr/service-client-requirements';
import * as bindingFilter from '../../routes/assets/_lib/binding-filter';
import {
  fieldEquals,
  rejectOffsetInBoundMode,
} from '../../routes/assets/_lib/bound-by-id';
import { ASSET_LIST_DEFAULT_LIMIT } from '../../routes/assets/_lib/page-cap';

// ⚠️ CONTRACT CHANGE: `card_id` was REMOVED from this schema. MEASURED: it
// exists on no model anywhere — not on `DecisionOut`, and not as a column of
// `asset_bindings` (migration 067 has asset_kind/asset_id/project_id only) —
// so it could never have filtered anything, upstream or locally. It was
// advertised, accepted, appended to the query string, and dropped.
const listInputSchema = z.object({
  project_id: z.string().optional(),
  origin: z.enum(['tenant', 'project', 'workflow']).optional(),
  bound_to: z.string().uuid().optional(),
  visible_in: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});
type ListInput = z.infer<typeof listInputSchema>;
const listOutputSchema = z.object({ items: z.array(z.unknown()) });

// D4 — requirements_management types `did` as a UUID (routers/decisions.py
// `did: UUID = Path(...)`). Constraining it here keeps a raw-interpolated
// path param (`/decisions/${did}`) from carrying `/`, `..`, `?` or `#`.
const getInputSchema = z.object({ did: z.string().uuid() });
type GetInput = z.infer<typeof getInputSchema>;
const getOutputSchema = z.object({ item: z.unknown() });

const searchInputSchema = z.object({
  q: z.string().optional(),
  k: z.number().int().min(1).max(1000).optional(),
  // fr-local project scope (fr asset bindings), applied AFTER the upstream
  // search exactly as `*.list` applies it: bound to that project, plus assets
  // bound to no project. In a project-bound agent thread it is injected from
  // the bound project (agui/agent-surface.ts PROJECT_BINDING), so a search can
  // never answer with another project's assets. Never forwarded upstream.
  visible_in: z.string().uuid().optional(),
});
type SearchInput = z.infer<typeof searchInputSchema>;
const searchOutputSchema = z.object({ items: z.array(z.unknown()) });

const listVersionsInputSchema = z.object({ did: z.string().uuid() });
type ListVersionsInput = z.infer<typeof listVersionsInputSchema>;
const listVersionsOutputSchema = z.object({ versions: z.array(z.unknown()) });

const listAction: AgentCallableAction<ListInput, z.infer<typeof listOutputSchema>> = {
  name: 'decisions.list',
  kind: 'read',
  description:
    'List decisions visible to the caller. Upstream filters: project_id, origin, limit, offset. fr-local project-scope filters, applied against fr asset bindings after the upstream call: bound_to (strictly bound to that project), visible_in (bound to that project, plus assets bound to no project at all).',
  input: listInputSchema,
  output: listOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) =>
    `decisions.list:${i.project_id ?? ''}:${i.origin ?? ''}:${i.bound_to ?? ''}:${i.visible_in ?? ''}:${i.limit ?? ''}:${i.offset ?? ''}`,
  handler: async (input) => {
    // ⚠️ SPLIT the input at this boundary. See `actions/requirements.ts` for
    // the full measurement; the short version: the whole input used to go to
    // `listDecisions`, whose generated URL builder appends every defined key,
    // and FastAPI drops an undeclared query param unconditionally and
    // silently — 200, full tenant-wide list. `bound_to`/`visible_in` are
    // fr-LOCAL filters against `asset_bindings` (migration 067) and must be
    // applied here, exactly as `routes/assets/decisions.ts` already does.
    //
    // `origin` goes on the wire as `origin_kind` (`DecisionOut.origin_kind`);
    // the INPUT name stays `origin` because it is the published contract.
    // `project_id` IS a real `DecisionOut` column, so it stays forwarded.
    //
    // BOUND MODE (`bound_to` without `visible_in`): the bound ids come from
    // asset_bindings and each is read with getDecision — the same read as
    // `decisions.get` — so a bound decision beyond the first upstream page is
    // not lost. The upstream equality filters are re-applied to the rows.
    if (input.bound_to && !input.visible_in) {
      rejectOffsetInBoundMode(input.offset);
      const bound = await bindingFilter.listBoundById(
        'decision',
        input.bound_to,
        input.limit ?? ASSET_LIST_DEFAULT_LIMIT,
        (did) => getDecision(did),
        fieldEquals({ origin_kind: input.origin, project_id: input.project_id }),
      );
      return { items: bound.items };
    }
    const upstream = await listDecisions({
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      ...(input.origin !== undefined ? { origin_kind: input.origin } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
    });
    const items = await bindingFilter.applyBindingFilter('decision', upstream, {
      bound_to: input.bound_to,
      visible_in: input.visible_in,
    });
    return { items };
  },
};

const getAction: AgentCallableAction<GetInput, z.infer<typeof getOutputSchema>> = {
  name: 'decisions.get',
  kind: 'read',
  description: 'Fetch a single decision by id.',
  input: getInputSchema,
  output: getOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `decisions.get:${i.did}`,
  handler: async (input) => {
    const item = await getDecision(input.did);
    return { item };
  },
};

const searchAction: AgentCallableAction<SearchInput, z.infer<typeof searchOutputSchema>> = {
  name: 'decisions.search',
  kind: 'read',
  description: 'Text search across decisions. `q` is the query, `k` caps the result count.',
  input: searchInputSchema,
  output: searchOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `decisions.search:${i.q ?? ''}:${i.k ?? ''}:${i.visible_in ?? ''}`,
  handler: async (input) => {
    // SPLIT at this boundary (see `decisions.list`): only `q`/`k` go upstream.
    const upstream = (
      await rmCall<DecisionOut[]>(
        getSearchDecisionsUrl({
          ...(input.q !== undefined ? { q: input.q } : {}),
          ...(input.k !== undefined ? { k: input.k } : {}),
        }),
      )
    ).data;
    const items = await bindingFilter.applyBindingFilter('decision', upstream, {
      visible_in: input.visible_in,
    });
    return { items };
  },
};

const listVersionsAction: AgentCallableAction<
  ListVersionsInput,
  z.infer<typeof listVersionsOutputSchema>
> = {
  name: 'decisions.list_versions',
  kind: 'read',
  description: 'Immutable version history for a decision.',
  input: listVersionsInputSchema,
  output: listVersionsOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `decisions.list_versions:${i.did}`,
  handler: async (input) => {
    const versions = await listDecisionVersions(input.did);
    return { versions };
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

export function registerDecisionsActions(): void {
  safeRegister(listAction);
  safeRegister(getAction);
  safeRegister(searchAction);
  safeRegister(listVersionsAction);
}
