/**
 * Coding analysis routes — narrow FR-shaped surface over coding-gateway.
 *
 * Spec: docs/superpowers/specs/completed/2026-04-24-coding-analysis-ui.md
 *   §"Architecture"           — repo selection + type picker + job list
 *   §"Agent-callable actions" — five actions registered via E-2 registry
 *   §"Telemetry emitted"      — emitSpan with the `coding.*` attribute set
 *
 * Five routes mirror the action catalog 1:1 so the AG-UI runtime can dispatch
 * the same actions a human user fires from `/tools/coding`. The write action
 * (`coding.trigger_analysis`) flows through E-5 single-approver(initiator)
 * policy via `invokeAction`; reads run direct.
 *
 * BY DESIGN: `coding.cancel_job` is NOT registered as an AG-UI action
 * because the coding analysis pipeline runs inline per request — there
 * is no long-lived job queue with a cancel handle to signal. Registering
 * cancel as a write-action would create permanently unresolvable
 * approval rows before the handler returned NOT_SUPPORTED. The HTTP
 * route `POST /api/tools/coding/jobs/:id/cancel` is preserved and
 * returns a deterministic 501 NOT_SUPPORTED envelope so any client that
 * tries cancellation gets a clean signal. Re-evaluate if and when
 * coding-* services grow first-class long-running job execution with
 * cancellation hooks.
 */

import { z } from 'zod';

import { validateAuth } from '../../middleware/auth';
import { jsonResponse } from '../../utils/response';
import { handle } from '../assets/_lib/handler';
import { emitSpan } from '../../telemetry/spans';
import { registerAction } from '../../agui/registry';
import { withInvokeCard } from '../../agui/capability-invoke-card';
import {
  IntegrationError,
} from '../../integrations/_lib/errors';
import type { AgentCallableAction, ActionContext } from '../../agui/types';
import {
  ANALYSIS_TYPES,
  JOB_STATUSES,
  SEVERITIES,
  getFindings,
  getJob,
  listAnalysisTypes,
  listJobs,
  resolveHeadShaForRepoId,
  triggerAnalysis,
  type AnalysisType,
  type JobStatus,
  type Severity,
} from '../../integrations/coding';
import { withIntegrationCatch } from '../_lib';

// ---------------------------------------------------------------------------
// Input schemas — shared between HTTP routes and AG-UI actions
// ---------------------------------------------------------------------------

const triggerInputSchema = z.object({
  /**
   * fr-agui P2: the project this write targets — the PROJECT PARAMETER
   * (agui/agent-surface.ts PROJECT_BINDING): removed from the model's schema
   * and set from the thread in a bound context, required by the confirm card's
   * route (POST /api/capabilities/:id/invoke). Unused outside a project.
   */
  project_id: z.string().uuid().optional(),
  repo_id: z.string().min(1),
  type: z.enum(ANALYSIS_TYPES),
  options: z
    .object({
      ref: z.string().optional(),
      paths: z.array(z.string()).optional(),
      severity_floor: z.enum(SEVERITIES).optional(),
      test_selector: z.string().optional(),
    })
    .partial()
    .strip()
    .optional(),
  client_idempotency_key: z.string().min(1),
});

const listJobsInputSchema = z.object({
  repo_id: z.string().optional(),
  type: z.enum(ANALYSIS_TYPES).optional(),
  status: z.enum(JOB_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(250).optional(),
  cursor: z.string().optional(),
});

const getJobInputSchema = z.object({ job_id: z.string().min(1) });

const getFindingsInputSchema = z.object({
  job_id: z.string().min(1),
  severity_floor: z.enum(SEVERITIES).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function parseJsonBody(req: Request): Promise<unknown> {
  return req.text().then((t) => (t.length === 0 ? {} : JSON.parse(t)));
}

function parseQuery<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const url = new URL(req.url);
  const raw: Record<string, string> = {};
  for (const k of url.searchParams.keys()) {
    const v = url.searchParams.get(k);
    if (v !== null) raw[k] = v;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: `Invalid query: ${JSON.stringify(parsed.error.issues)}`,
    });
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// HTTP route handlers
// ---------------------------------------------------------------------------

export async function handleListAnalysisTypes(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    await validateAuth(req);
    return await emitSpan(
      'fr.tool.coding.list_types',
      { outcome: 'ok' },
      async () => jsonResponse({ data: listAnalysisTypes() }),
    );
  });
}

export async function handleTriggerAnalysis(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    let body: unknown;
    try {
      body = await parseJsonBody(req);
    } catch (err) {
      throw new IntegrationError({
        code: 'BAD_REQUEST',
        message: `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const parsed = triggerInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new IntegrationError({
        code: 'BAD_REQUEST',
        message: `Invalid body: ${JSON.stringify(parsed.error.issues)}`,
      });
    }
    return await emitSpan(
      'fr.tool.coding.trigger',
      {
        'user.id': user.id,
        'coding.repo_id': parsed.data.repo_id,
        'coding.type': parsed.data.type,
        'coding.idempotency_key': parsed.data.client_idempotency_key,
        outcome: 'accepted',
      },
      () =>
        handle(
          () =>
            triggerAnalysis({
              repoId: parsed.data.repo_id,
              type: parsed.data.type,
              options: parsed.data.options ?? {},
              clientIdempotencyKey: parsed.data.client_idempotency_key,
              userId: user.id,
              projectId: null,
            }),
          (out) => jsonResponse({ data: out, meta: { deduped: out.deduped } }),
        ),
    );
  });
}

export async function handleListJobs(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const q = parseQuery(req, listJobsInputSchema);
    return await emitSpan(
      'fr.tool.coding.list',
      {
        'user.id': user.id,
        'coding.repo_id': q.repo_id ?? null,
        'coding.type': q.type ?? null,
        outcome: 'ok',
      },
      () =>
        handle(
          () =>
            listJobs({
              userId: user.id,
              repoId: q.repo_id,
              type: q.type,
              status: q.status,
              limit: q.limit,
              cursor: q.cursor,
            }),
          (out) =>
            jsonResponse({
              data: out.jobs,
              meta: { next_cursor: out.next_cursor },
            }),
        ),
    );
  });
}

export async function handleGetJob(
  req: Request,
  jobId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    return await emitSpan(
      'fr.tool.coding.get',
      { 'user.id': user.id, 'coding.job_id': jobId, outcome: 'ok' },
      () =>
        handle(
          () => getJob(jobId, user.id),
          (job) => {
            if (!job) {
              return jsonResponse(
                {
                  error: {
                    code: 'UPSTREAM_NOT_FOUND',
                    message: `Job ${jobId} not found`,
                  },
                },
                404,
              );
            }
            return jsonResponse({ data: job });
          },
        ),
    );
  });
}

export async function handleGetFindings(
  req: Request,
  jobId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const url = new URL(req.url);
    const raw: Record<string, string> = { job_id: jobId };
    for (const k of url.searchParams.keys()) {
      const v = url.searchParams.get(k);
      if (v !== null) raw[k] = v;
    }
    const parsed = getFindingsInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new IntegrationError({
        code: 'BAD_REQUEST',
        message: `Invalid query: ${JSON.stringify(parsed.error.issues)}`,
      });
    }
    return await emitSpan(
      'fr.tool.coding.findings',
      { 'user.id': user.id, 'coding.job_id': jobId, outcome: 'ok' },
      () =>
        handle(
          () =>
            getFindings({
              userId: user.id,
              jobId: parsed.data.job_id,
              severityFloor: parsed.data.severity_floor,
              cursor: parsed.data.cursor,
              limit: parsed.data.limit,
            }),
          (out) =>
            jsonResponse({
              data: out.findings,
              meta: { next_cursor: out.next_cursor },
            }),
        ),
    );
  });
}

export async function handleCancelJob(
  req: Request,
  _jobId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    await validateAuth(req);
    // BY DESIGN: action not registered (see file header). Return a
    // direct 501 so the client gets a deterministic NOT_SUPPORTED
    // envelope without booking an approval row.
    return await emitSpan(
      'fr.tool.coding.cancel',
      { 'coding.job_id': _jobId, outcome: 'not_supported' },
      async () =>
        jsonResponse(
          {
            error: {
              code: 'NOT_SUPPORTED',
              message: 'cancel_job is not exposed at this revision',
            },
          },
          501,
        ),
    );
  });
}

// ---------------------------------------------------------------------------
// AG-UI action registration
// ---------------------------------------------------------------------------

const triggerOutSchema = z.object({
  job: z.unknown(),
  deduped: z.boolean(),
});
const listJobsOutSchema = z.object({
  jobs: z.array(z.unknown()),
  next_cursor: z.string().nullable(),
});
const getJobOutSchema = z.object({ job: z.unknown() });
const getFindingsOutSchema = z.object({
  findings: z.array(z.unknown()),
  next_cursor: z.string().nullable(),
});
const listTypesOutSchema = z.object({
  types: z.array(z.enum(ANALYSIS_TYPES)),
});

type TriggerInput = z.infer<typeof triggerInputSchema>;
type ListJobsInput = z.infer<typeof listJobsInputSchema>;
type GetJobInput = z.infer<typeof getJobInputSchema>;
type GetFindingsInput = z.infer<typeof getFindingsInputSchema>;

const codingListTypesAction: AgentCallableAction<
  Record<string, never>,
  z.infer<typeof listTypesOutSchema>
> = {
  name: 'coding.list_analysis_types',
  kind: 'read',
  description:
    'List the fixed set of analysis types FR exposes over coding-gateway: security, bug_hunt, quality, dependencies, tests.',
  input: z.object({}).strip(),
  output: listTypesOutSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: () => 'coding.list_analysis_types:v1',
  // Static enum: long TTL is fine.
  idempotencyTtlSeconds: 60 * 60,
  handler: async () => listAnalysisTypes() as { types: AnalysisType[] },
  // Was `{type:'tenant-role', role:'user'}`, which nobody can satisfy: the
  // portal realm issues no literal `user` role (measured 2026-08-27 — a
  // verified super-admin holds 15 realm roles, none of them `user`). That is a
  // realm configuration gap, tracked in
  // tests/unit/agui/tenant-role-names.test.ts, and closing it belongs in
  // Keycloak.
  //
  // This action does not need to wait for that. It returns a fixed enum
  // (security, bug_hunt, quality, dependencies, tests) with no tenant data and
  // no per-caller variation, so `public` is what it always should have
  // declared — not a workaround for the gap.
  rbac: { type: 'public' },
};

const codingTriggerAction: AgentCallableAction<TriggerInput, z.infer<typeof triggerOutSchema>> = {
  name: 'coding.trigger_analysis',
  kind: 'write',
  description:
    'Trigger one of the five fixed coding-gateway analyses (security | bug_hunt | quality | dependencies | tests) against a registered FR repository.',
  input: triggerInputSchema,
  output: triggerOutSchema,
  approval: { type: 'single-approver', approver: 'initiator' },
  cronSafe: true,
  // T7a — fold the repo HEAD sha into the action-level dedup key. Two
  // analyze calls with the same `(repo_id, head_sha)` and the same
  // client_idempotency_key now resolve to the same write-path cache entry,
  // so the second call returns the prior PendingAction without queueing a
  // duplicate approval row. When the resolver returns null (gateway
  // unreachable + git ls-remote unavailable / repo not found), we fall back
  // to the bare client key — never WORSE than the pre-T7a behavior.
  idempotencyKey: async (input) => {
    const headSha = await resolveHeadShaForRepoId(input.repo_id);
    const shaSuffix = headSha ? `:${headSha}` : '';
    return `coding.trigger_analysis:${input.repo_id}:${input.type}:${input.client_idempotency_key}${shaSuffix}`;
  },
  handler: async (input, ctx: ActionContext) => {
    const out = await triggerAnalysis({
      repoId: input.repo_id,
      type: input.type,
      options: input.options ?? {},
      clientIdempotencyKey: input.client_idempotency_key,
      userId: ctx.userId,
      projectId: ctx.projectId,
    });
    return { job: out.job, deduped: out.deduped };
  },
  rbac: { type: 'project-member' },
};

const codingListJobsAction: AgentCallableAction<ListJobsInput, z.infer<typeof listJobsOutSchema>> = {
  name: 'coding.list_jobs',
  kind: 'read',
  description: 'List recent + in-flight coding analysis jobs for the calling user, optionally filtered by repo, type, or status. In a project thread: that project\'s jobs only.',
  input: listJobsInputSchema,
  output: listJobsOutSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `coding.list_jobs:${input.repo_id ?? ''}:${input.type ?? ''}:${input.status ?? ''}:${input.limit ?? ''}:${input.cursor ?? ''}:${Math.floor(Date.now() / 30_000)}`,
  handler: async (input, ctx: ActionContext) => {
    const out = await listJobs({
      userId: ctx.userId,
      // fr-agui SPEC §13 P1c "bound project only": in a project context (the
      // project agent) only that project's jobs, never the user's other projects'.
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
      repoId: input.repo_id,
      type: input.type as AnalysisType | undefined,
      status: input.status as JobStatus | undefined,
      limit: input.limit,
      cursor: input.cursor,
    });
    return { jobs: out.jobs, next_cursor: out.next_cursor };
  },
  rbac: { type: 'project-member' },
};

const codingGetJobAction: AgentCallableAction<GetJobInput, z.infer<typeof getJobOutSchema>> = {
  name: 'coding.get_job_status',
  kind: 'read',
  description: 'Fetch the current status of one coding analysis job, refreshing async upstream state when applicable.',
  input: getJobInputSchema,
  output: getJobOutSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `coding.get_job_status:${input.job_id}:${Math.floor(Date.now() / 5_000)}`,
  handler: async (input, ctx: ActionContext) => {
    // fr-agui P2: in a project thread, the project's job (any member), never another project's.
    const job = await getJob(input.job_id, ctx.userId, undefined, ctx.projectId ?? null);
    if (!job) {
      throw new IntegrationError({
        code: 'UPSTREAM_NOT_FOUND',
        message: `Job ${input.job_id} not found`,
        service: 'coding-gateway',
      });
    }
    return { job };
  },
  rbac: { type: 'project-member' },
};

const codingGetFindingsAction: AgentCallableAction<
  GetFindingsInput,
  z.infer<typeof getFindingsOutSchema>
> = {
  name: 'coding.get_findings',
  kind: 'read',
  description: 'Fetch normalized findings for one coding analysis job, optionally filtered by severity floor.',
  input: getFindingsInputSchema,
  output: getFindingsOutSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `coding.get_findings:${input.job_id}:${input.severity_floor ?? ''}:${input.cursor ?? ''}:${input.limit ?? ''}`,
  handler: async (input, ctx: ActionContext) => {
    const out = await getFindings({
      userId: ctx.userId,
      // fr-agui P2: in a project thread, the project's job (any member), never another project's.
      projectId: ctx.projectId ?? null,
      jobId: input.job_id,
      severityFloor: input.severity_floor as Severity | undefined,
      cursor: input.cursor,
      limit: input.limit,
    });
    return { findings: out.findings, next_cursor: out.next_cursor };
  },
  rbac: { type: 'project-member' },
};

// NOTE: `coding.cancel_job` is intentionally NOT registered. See file
// header for the BY DESIGN rationale (analyses run inline per request).

function safeRegister<I, O>(action: AgentCallableAction<I, O>): void {
  try {
    registerAction(action);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

safeRegister(codingListTypesAction);
safeRegister(withInvokeCard(codingTriggerAction));
safeRegister(codingListJobsAction);
safeRegister(codingGetJobAction);
safeRegister(codingGetFindingsAction);

