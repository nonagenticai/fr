/**
 * AG-UI agent-callable read actions for the `pm` (project-management) upstream.
 * Same shape as `actions/principles.ts` — see that file for design notes.
 *
 * Scope: READ-ONLY. Only the list/get verbs from `integrations/pm.ts` are
 * registered here; the create/update/delete verbs in that module are
 * deliberately left unwrapped (they belong to a write catalog with a real
 * approval policy, not to this `approval: {type:'auto'}` read surface).
 *
 * Tenant scoping: `integrations/pm.ts` talks to the shared
 * `requirements_management` client built by `createHttpClient`, which injects
 * X-Tenant-Id / X-User-Id itself. There is therefore no tenantId argument to
 * thread through — exactly as in `principles.ts`. These handlers pass only the
 * caller's own filters and never widen scope.
 *
 * The pm integration list functions take `Record<string, string>` (they are
 * fed straight into URLSearchParams by the generated URL builders), so the
 * typed zod input is serialized via `toParams()` below rather than being
 * handed over as-is.
 */

import { z } from 'zod';

import { registerAction } from '../registry';
import type { AgentCallableAction } from '../types';
import {
  listProgrammes,
  getProgramme,
  listProjects,
  getProject,
  listRisks,
  getRisk,
} from '../../integrations/pm';

/**
 * Serialize a validated filter object into the `Record<string, string>` shape
 * the pm integration expects. Undefined keys are dropped; an empty result
 * becomes `undefined` so the URL builder emits the bare path.
 */
function toParams(input: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

const paginationShape = {
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
};

const getInputSchema = z.object({ eid: z.string().min(1) });
type GetInput = z.infer<typeof getInputSchema>;
const getOutputSchema = z.object({ item: z.unknown() });

// --- Programmes -----------------------------------------------------------

const listProgrammesInputSchema = z.object({
  status: z.string().optional(),
  ...paginationShape,
});
type ListProgrammesInput = z.infer<typeof listProgrammesInputSchema>;
const listProgrammesOutputSchema = z.object({ items: z.array(z.unknown()) });

const listProgrammesAction: AgentCallableAction<
  ListProgrammesInput,
  z.infer<typeof listProgrammesOutputSchema>
> = {
  name: 'pm.list_programmes',
  kind: 'read',
  description:
    'List programmes visible to the caller. Optional filters: status, limit, offset.',
  input: listProgrammesInputSchema,
  output: listProgrammesOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) =>
    `pm.list_programmes:${i.status ?? ''}:${i.limit ?? ''}:${i.offset ?? ''}`,
  handler: async (input) => {
    const items = await listProgrammes(toParams(input));
    return { items };
  },
};

const getProgrammeAction: AgentCallableAction<GetInput, z.infer<typeof getOutputSchema>> =
  {
    name: 'pm.get_programme',
    kind: 'read',
    description: 'Fetch a single programme by id.',
    input: getInputSchema,
    output: getOutputSchema,
    approval: { type: 'auto' },
    cronSafe: true,
    rbac: { type: 'public' },
    idempotencyKey: (i) => `pm.get_programme:${i.eid}`,
    handler: async (input) => {
      const item = await getProgramme(input.eid);
      return { item };
    },
  };

// --- Projects -------------------------------------------------------------

const listProjectsInputSchema = z.object({
  status: z.string().optional(),
  programme_id: z.string().optional(),
  ...paginationShape,
});
type ListProjectsInput = z.infer<typeof listProjectsInputSchema>;
const listProjectsOutputSchema = z.object({ items: z.array(z.unknown()) });

const listProjectsAction: AgentCallableAction<
  ListProjectsInput,
  z.infer<typeof listProjectsOutputSchema>
> = {
  name: 'pm.list_projects',
  kind: 'read',
  description:
    'List projects visible to the caller. Optional filters: status, programme_id, limit, offset.',
  input: listProjectsInputSchema,
  output: listProjectsOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) =>
    `pm.list_projects:${i.status ?? ''}:${i.programme_id ?? ''}:${i.limit ?? ''}:${i.offset ?? ''}`,
  handler: async (input) => {
    const items = await listProjects(toParams(input));
    return { items };
  },
};

const getProjectAction: AgentCallableAction<GetInput, z.infer<typeof getOutputSchema>> = {
  name: 'pm.get_project',
  kind: 'read',
  description: 'Fetch a single project by id.',
  input: getInputSchema,
  output: getOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `pm.get_project:${i.eid}`,
  handler: async (input) => {
    const item = await getProject(input.eid);
    return { item };
  },
};

// --- Risks ----------------------------------------------------------------

const listRisksInputSchema = z.object({
  status: z.string().optional(),
  category: z.string().optional(),
  project_id: z.string().optional(),
  ...paginationShape,
});
type ListRisksInput = z.infer<typeof listRisksInputSchema>;
const listRisksOutputSchema = z.object({ items: z.array(z.unknown()) });

const listRisksAction: AgentCallableAction<
  ListRisksInput,
  z.infer<typeof listRisksOutputSchema>
> = {
  name: 'pm.list_risks',
  kind: 'read',
  description:
    'List risks visible to the caller. Optional filters: status, category, project_id, limit, offset.',
  input: listRisksInputSchema,
  output: listRisksOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) =>
    `pm.list_risks:${i.status ?? ''}:${i.category ?? ''}:${i.project_id ?? ''}:${i.limit ?? ''}:${i.offset ?? ''}`,
  handler: async (input) => {
    const items = await listRisks(toParams(input));
    return { items };
  },
};

const getRiskAction: AgentCallableAction<GetInput, z.infer<typeof getOutputSchema>> = {
  name: 'pm.get_risk',
  kind: 'read',
  description: 'Fetch a single risk by id.',
  input: getInputSchema,
  output: getOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `pm.get_risk:${i.eid}`,
  handler: async (input) => {
    const item = await getRisk(input.eid);
    return { item };
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

export function registerPmActions(): void {
  safeRegister(listProgrammesAction);
  safeRegister(getProgrammeAction);
  safeRegister(listProjectsAction);
  safeRegister(getProjectAction);
  safeRegister(listRisksAction);
  safeRegister(getRiskAction);
}
