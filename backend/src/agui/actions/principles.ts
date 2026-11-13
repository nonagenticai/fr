/**
 * AG-UI agent-callable read actions for the `principles` upstream. Same
 * shape as `actions/requirements.ts` — see that file for design notes.
 */

import { z } from 'zod';

import { registerAction } from '../registry';
import type { AgentCallableAction } from '../types';
import {
  listPrinciples,
  getPrinciple,
  listPrincipleVersions,
} from '../../integrations/principles';
import { rmCall } from '../../integrations/architecture';
import { getSearchPrinciplesUrl, type PrincipleOut } from '@fr/service-client-requirements';
import * as bindingFilter from '../../routes/assets/_lib/binding-filter';
import {
  fieldEquals,
  rejectOffsetInBoundMode,
} from '../../routes/assets/_lib/bound-by-id';
import { ASSET_LIST_DEFAULT_LIMIT } from '../../routes/assets/_lib/page-cap';

// ⚠️ CONTRACT CHANGE: `project_id` was REMOVED from this schema. MEASURED:
// `PrincipleOut` has NO `project_id` column — only `origin_project_id`, which
// records WHERE A PRINCIPLE CAME FROM, not what it is scoped to. Forwarding
// `project_id` therefore filtered nothing (FastAPI drops an undeclared query
// param unconditionally and silently), and repurposing `origin_project_id`
// would answer a scoping question with a provenance column.
//
// It is REMOVED rather than filtered locally on purpose: the only thing fr can
// express locally is a row in `asset_bindings` (asset_kind, asset_id,
// project_id), and "assets bound to project P" is precisely what `bound_to`
// already advertises. Mapping `project_id` onto the same query would give one
// action two inputs with one meaning, and would silently redefine a published
// field rather than retire it. Callers that want project scope use `bound_to`
// or `visible_in`.
const listInputSchema = z.object({
  origin: z.enum(['tenant', 'project', 'workflow']).optional(),
  bound_to: z.string().uuid().optional(),
  visible_in: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});
type ListInput = z.infer<typeof listInputSchema>;
const listOutputSchema = z.object({ items: z.array(z.unknown()) });

const getInputSchema = z.object({ pid: z.string().min(1) });
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

const listVersionsInputSchema = z.object({ pid: z.string().min(1) });
type ListVersionsInput = z.infer<typeof listVersionsInputSchema>;
const listVersionsOutputSchema = z.object({ versions: z.array(z.unknown()) });

const listAction: AgentCallableAction<ListInput, z.infer<typeof listOutputSchema>> = {
  name: 'principles.list',
  kind: 'read',
  description:
    'List principles visible to the caller. Upstream filters: origin, limit, offset. fr-local project-scope filters, applied against fr asset bindings after the upstream call: bound_to (strictly bound to that project), visible_in (bound to that project, plus assets bound to no project at all). Principles carry no project_id column upstream — use bound_to/visible_in for project scope.',
  input: listInputSchema,
  output: listOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) =>
    `principles.list:${i.origin ?? ''}:${i.bound_to ?? ''}:${i.visible_in ?? ''}:${i.limit ?? ''}:${i.offset ?? ''}`,
  handler: async (input) => {
    // ⚠️ SPLIT the input at this boundary. See `actions/requirements.ts` for
    // the full measurement; the short version: the whole input used to go to
    // `listPrinciples`, whose generated URL builder appends every defined key,
    // and FastAPI drops an undeclared query param unconditionally and
    // silently — 200, full tenant-wide list. `bound_to`/`visible_in` are
    // fr-LOCAL filters against `asset_bindings` (migration 067) and must be
    // applied here, exactly as `routes/assets/principles.ts` already does.
    //
    // `origin` goes on the wire as `origin_kind` (`PrincipleOut.origin_kind`);
    // the INPUT name stays `origin` because it is the published contract.
    //
    // BOUND MODE (`bound_to` without `visible_in`): ids from asset_bindings,
    // each read with getPrinciple (the `principles.get` read). See
    // routes/assets/_lib/bound-by-id.ts.
    if (input.bound_to && !input.visible_in) {
      rejectOffsetInBoundMode(input.offset);
      const bound = await bindingFilter.listBoundById(
        'principle',
        input.bound_to,
        input.limit ?? ASSET_LIST_DEFAULT_LIMIT,
        (pid) => getPrinciple(pid),
        fieldEquals({ origin_kind: input.origin }),
      );
      return { items: bound.items };
    }
    const upstream = await listPrinciples({
      ...(input.origin !== undefined ? { origin_kind: input.origin } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
    });
    const items = await bindingFilter.applyBindingFilter('principle', upstream, {
      bound_to: input.bound_to,
      visible_in: input.visible_in,
    });
    return { items };
  },
};

const getAction: AgentCallableAction<GetInput, z.infer<typeof getOutputSchema>> = {
  name: 'principles.get',
  kind: 'read',
  description: 'Fetch a single principle by id.',
  input: getInputSchema,
  output: getOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `principles.get:${i.pid}`,
  handler: async (input) => {
    const item = await getPrinciple(input.pid);
    return { item };
  },
};

const searchAction: AgentCallableAction<SearchInput, z.infer<typeof searchOutputSchema>> = {
  name: 'principles.search',
  kind: 'read',
  description: 'Text search across principles. `q` is the query, `k` caps the result count.',
  input: searchInputSchema,
  output: searchOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `principles.search:${i.q ?? ''}:${i.k ?? ''}:${i.visible_in ?? ''}`,
  handler: async (input) => {
    // SPLIT at this boundary (see `principles.list`): only `q`/`k` go upstream.
    const upstream = (
      await rmCall<PrincipleOut[]>(
        getSearchPrinciplesUrl({
          ...(input.q !== undefined ? { q: input.q } : {}),
          ...(input.k !== undefined ? { k: input.k } : {}),
        }),
      )
    ).data;
    const items = await bindingFilter.applyBindingFilter('principle', upstream, {
      visible_in: input.visible_in,
    });
    return { items };
  },
};

const listVersionsAction: AgentCallableAction<
  ListVersionsInput,
  z.infer<typeof listVersionsOutputSchema>
> = {
  name: 'principles.list_versions',
  kind: 'read',
  description: 'Immutable version history for a principle.',
  input: listVersionsInputSchema,
  output: listVersionsOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `principles.list_versions:${i.pid}`,
  handler: async (input) => {
    const versions = await listPrincipleVersions(input.pid);
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

export function registerPrinciplesActions(): void {
  safeRegister(listAction);
  safeRegister(getAction);
  safeRegister(searchAction);
  safeRegister(listVersionsAction);
}
