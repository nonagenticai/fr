/**
 * AG-UI agent-callable read actions for the `requirements_management` upstream.
 *
 * Closes the read-side coverage gap left by the internal-create matrix
 * (PRs #293–#299, which wired the *write* surface). Every handler delegates
 * to the existing integration adapter in `src/integrations/requirements.ts`
 * — no HTTP plumbing is duplicated here.
 *
 * Pattern mirrors `actions/n8n.ts`. All four actions are `kind:'read'`,
 * `approval:{type:'auto'}`, `cronSafe:true`, `rbac:{type:'public'}`.
 */

import { z } from 'zod';

import { registerAction } from '../registry';
import type { AgentCallableAction } from '../types';
import {
  listRequirements,
  getRequirement,
  listRequirementVersions,
} from '../../integrations/requirements';
import { rmCall } from '../../integrations/architecture';
import { getSearchRequirementsUrl, type RequirementOut } from '@fr/service-client-requirements';
import * as bindingFilter from '../../routes/assets/_lib/binding-filter';
import {
  fieldEquals,
  rejectOffsetInBoundMode,
} from '../../routes/assets/_lib/bound-by-id';
import { ASSET_LIST_DEFAULT_LIMIT } from '../../routes/assets/_lib/page-cap';

// ---------------------------------------------------------------------------
// Schemas — output shapes are kept loose (`z.array(z.unknown())` / `z.unknown()`)
// to avoid double-validating generated upstream types. Integration-fn return
// types are the source of truth.
// ---------------------------------------------------------------------------

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

const getInputSchema = z.object({ rid: z.string().min(1) });
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

const listVersionsInputSchema = z.object({ rid: z.string().min(1) });
type ListVersionsInput = z.infer<typeof listVersionsInputSchema>;

const listVersionsOutputSchema = z.object({ versions: z.array(z.unknown()) });

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const listAction: AgentCallableAction<ListInput, z.infer<typeof listOutputSchema>> = {
  name: 'requirements.list',
  kind: 'read',
  description:
    'List requirements visible to the caller. Upstream filters: project_id, origin, limit, offset. fr-local project-scope filters, applied against fr asset bindings after the upstream call: bound_to (strictly bound to that project), visible_in (bound to that project, plus assets bound to no project at all).',
  input: listInputSchema,
  output: listOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) =>
    `requirements.list:${i.project_id ?? ''}:${i.origin ?? ''}:${i.bound_to ?? ''}:${i.visible_in ?? ''}:${i.limit ?? ''}:${i.offset ?? ''}`,
  handler: async (input) => {
    // ⚠️ SPLIT the input at this boundary; do NOT hand it to the integration
    // whole. `listRequirements` reaches the generated URL builder
    // (`getListRequirementsUrl`), which appends EVERY defined key via
    // URLSearchParams. FastAPI drops a query param the route does not
    // declare unconditionally and silently — a 200 carrying the full
    // tenant-wide list. So `bound_to`/`visible_in` never narrowed anything:
    // an agent that asked for one project's requirements was handed every
    // project's. The failure is SCOPING, not paging, and the response shape
    // was normal throughout, which is why it survived unnoticed.
    //
    // `bound_to`/`visible_in` are fr-LOCAL BY DESIGN — they filter against
    // fr's own `asset_bindings` table (migration 067), which upstream knows
    // nothing about. The REST route has always applied them after the
    // upstream call (`routes/assets/requirements.ts:28-41`); this mirrors it.
    //
    // `origin` goes on the wire as `origin_kind`: that is the name of the
    // column on the model (`RequirementOut.origin_kind`, "Provenance: tenant
    // | project | workflow"). The action's INPUT name stays `origin` — it is
    // the published AG-UI contract and feeds `idempotencyKey` above.
    //
    // `project_id` IS a real `RequirementOut` column, so it stays forwarded.
    //
    // BOUND MODE (`bound_to` without `visible_in`): ids from asset_bindings,
    // each read with getRequirement (the `requirements.get` read), so a bound
    // requirement beyond the first upstream page is not lost. Only
    // `origin_kind` is re-applied locally: `routes/assets/requirements.ts`
    // measured that the generated list params declare no `project_id`, so the
    // upstream list never narrowed on it either — applying it here would be a
    // NEW filter, not a preserved one.
    if (input.bound_to && !input.visible_in) {
      rejectOffsetInBoundMode(input.offset);
      const bound = await bindingFilter.listBoundById(
        'requirement',
        input.bound_to,
        input.limit ?? ASSET_LIST_DEFAULT_LIMIT,
        (rid) => getRequirement(rid),
        fieldEquals({ origin_kind: input.origin }),
      );
      return { items: bound.items };
    }
    const upstream = await listRequirements({
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      ...(input.origin !== undefined ? { origin_kind: input.origin } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
    });
    const items = await bindingFilter.applyBindingFilter('requirement', upstream, {
      bound_to: input.bound_to,
      visible_in: input.visible_in,
    });
    return { items };
  },
};

const getAction: AgentCallableAction<GetInput, z.infer<typeof getOutputSchema>> = {
  name: 'requirements.get',
  kind: 'read',
  description: 'Fetch a single requirement by id.',
  input: getInputSchema,
  output: getOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `requirements.get:${i.rid}`,
  handler: async (input) => {
    const item = await getRequirement(input.rid);
    return { item };
  },
};

const searchAction: AgentCallableAction<SearchInput, z.infer<typeof searchOutputSchema>> = {
  name: 'requirements.search',
  kind: 'read',
  description: 'Text search across requirements. `q` is the query, `k` caps the result count.',
  input: searchInputSchema,
  output: searchOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `requirements.search:${i.q ?? ''}:${i.k ?? ''}:${i.visible_in ?? ''}`,
  handler: async (input) => {
    // SPLIT at this boundary (see `requirements.list`): only `q`/`k` go upstream.
    const upstream = (
      await rmCall<RequirementOut[]>(
        getSearchRequirementsUrl({
          ...(input.q !== undefined ? { q: input.q } : {}),
          ...(input.k !== undefined ? { k: input.k } : {}),
        }),
      )
    ).data;
    const items = await bindingFilter.applyBindingFilter('requirement', upstream, {
      visible_in: input.visible_in,
    });
    return { items };
  },
};

const listVersionsAction: AgentCallableAction<
  ListVersionsInput,
  z.infer<typeof listVersionsOutputSchema>
> = {
  name: 'requirements.list_versions',
  kind: 'read',
  description: 'Immutable version history for a requirement.',
  input: listVersionsInputSchema,
  output: listVersionsOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `requirements.list_versions:${i.rid}`,
  handler: async (input) => {
    const versions = await listRequirementVersions(input.rid);
    return { versions };
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

export function registerRequirementsActions(): void {
  safeRegister(listAction);
  safeRegister(getAction);
  safeRegister(searchAction);
  safeRegister(listVersionsAction);
}
