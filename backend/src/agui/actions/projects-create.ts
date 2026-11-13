/**
 * fr-agui SPEC §6 (P0a) — `projects.create`, the doorway into a project, plus the
 * two catalogue reads the doorway agent needs to fill it.
 *
 * ⛔ ONE DOOR. This action has NO insert of its own. #1552 retired the old
 * `agent.create_project` because it was a second door (a Planka board + its own
 * row insert, no type, no RM POST, auto-approved). Its replacement
 * reaches the SAME engine `POST /api/projects` uses:
 *
 *   WEB  (W)  the agent loop never invokes this action: `confirm` makes it return
 *             a proposal, and the human's ProjectCreateCard click calls
 *             `POST /api/projects` under the human's own session.
 *   CHANNEL   `start <type> <title>` parks (single-approver: the sender), the reply
 *             names the approval id, and `approve <id>` (by the sender or, since
 *             P1-TEAM-c, ANY member of the tenant) resolves the park, which runs
 *             `handler` below AS THE APPROVER → `createProjectCore` →
 *             `createSingleProject`.
 *
 * `tests/unit/routes/project-insert-single-door.test.ts` stays unchanged and
 * green: no insert site is added here.
 *
 * Deliberately NOT `autoApproveForInitiator`: a chat `start` must park and be
 * confirmed by an explicit `approve <id>` (George OQ-7). A bare yes/no never
 * confirms it: the shared reply flow (channel-reply.ts) binds an untagged reply
 * only to an approval NOTIFICATION delivered to the sender, never to a parked write.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { createProjectCore } from '../../routes/projects';
import {
  approverActionPrincipal,
  assertChannelTenantResolved,
  channelAuthUser,
  isAuthenticatedTenantUser,
} from '../../capabilities/principal';
import { deriveAgentAction } from '../../capabilities/derive-agent';
import {
  projectsCreateCapability,
  type ProjectsCreateInput,
  type ProjectsCreateOutput,
} from '../../capabilities/projects/create';
import {
  conveyorListProjectTypesCapability,
  listProjectTypesOutput,
} from '../../capabilities/conveyor/list-project-types';
import {
  isStartableProjectType,
  priorities as cataloguePriorities,
  projectTypes as catalogueProjectTypes,
} from '../../services/catalogue/tenant-catalogue';
import { projectTypeCreatableOn } from '../../lib/project-type-tenant';
import { AppError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// Idempotency (SPEC §6.3)
// ---------------------------------------------------------------------------

/** Fixed namespace for the channel create key (any constant UUID; never change it). */
const CHANNEL_CREATE_NAMESPACE = 'b3f1c1de-5a0e-4c39-9d0e-6f5b7a3c2e10';

/** RFC 4122 UUIDv5 (SHA-1, name-based). */
export function uuidV5(name: string, namespace: string = CHANNEL_CREATE_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The project id / `Idempotency-Key` of a channel create: a UUIDv5 of
 * (channel, sender, inbound message id), so a re-delivered message replays the
 * same project instead of making a second one.
 */
export function channelCreateKey(ctx: Pick<ActionContext, 'channel' | 'userId' | 'correlationId'>): string {
  return uuidV5(`${ctx.channel}\u0000${ctx.userId}\u0000${ctx.correlationId}`);
}

// ---------------------------------------------------------------------------
// projects.create
// ---------------------------------------------------------------------------

type CreateInput = ProjectsCreateInput;
type CreateOutput = ProjectsCreateOutput;

/** The `POST /api/projects` body a create input maps to (the field is `name`, not `title`). */
export function createBodyFor(input: CreateInput): Record<string, unknown> {
  return {
    name: input.title,
    project_type: input.project_type,
    ...(input.description ? { description: input.description } : {}),
    ...(input.problem_statement ? { problem_statement: input.problem_statement } : {}),
    ...(input.desired_outcome ? { desired_outcome: input.desired_outcome } : {}),
    ...(input.repository_url ? { repository_url: input.repository_url } : {}),
    // Absent ⇒ the create engine stores 'brief_and_closure' (project-intake.ts rmItInputsOf).
    ...(input.approval_mode ? { approval_mode: input.approval_mode } : {}),
  };
}

/** A refusal from the create door, surfaced VERBATIM (status + code + message). */
export class ProjectCreateRefusedError extends AppError {
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    const code = typeof body.error === 'string' ? body.error : `http_${status}`;
    const message = typeof body.message === 'string' ? `: ${body.message}` : '';
    const allowed = Array.isArray(body.allowed) ? ` (allowed: ${body.allowed.join(', ')})` : '';
    super(status, `${code}${message}${allowed}`);
    this.name = 'ProjectCreateRefusedError';
    this.code = code;
    this.body = body;
  }
}

/**
 * The channel handler of `projects.create` (capabilities/projects/create.ts).
 * Runs ONLY when a parked channel invocation is approved (resolvePendingAction,
 * which re-enters a request frame naming the APPROVAL's tenant and the APPROVER
 * as the acting user — P1-TEAM-c). The web never reaches it.
 */
export async function projectsCreateChannelHandler(input: CreateInput, ctx: ActionContext): Promise<CreateOutput> {
    if (ctx.channel === 'web') {
      throw new AppError(
        400,
        'projects.create runs on the web only through the create card (POST /api/projects)',
      ).withCode('use_the_create_card');
    }
    // P1-TEAM-c (George 2026-10-15): `ctx.userId` is the APPROVER — the parked
    // create runs as whoever approved it (`resolvePendingAction`), so the project
    // is theirs (owner_id = approver). When the approver is NOT the requester,
    // the requester's channel-derived tenant (rule 2) says nothing about them: the
    // tenant is the APPROVAL's, and the approver must be a current member of it
    // and homed in it, checked fresh here (`approverActionPrincipal`). No
    // fallback to the requester on a refusal.
    const approverIsNotRequester =
      typeof ctx.requesterId === 'string' && ctx.requesterId !== ctx.userId;
    let user;
    if (approverIsNotRequester) {
      user = await approverActionPrincipal(ctx.userId, ctx.tenantId ?? '');
    } else {
      // §6.5 rule 5: re-derive the AuthUser from the approval's user + tenant and
      // refuse a user who is no longer a member of that tenant. Runs FIRST so a
      // removed member is refused by THIS check (its own code), not by the next.
      user = await channelAuthUser(ctx.userId, ctx.tenantId ?? '');
      // §6.5 rule 2, layer 2: the tenant must still be the sender's ONLY
      // membership. Catches a path that reached this handler without the
      // dispatcher's `resolveChannelTenant` (a multi-workspace sender would
      // otherwise create in whichever tenant that path picked).
      await assertChannelTenantResolved(ctx);
    }
    const out = await createProjectCore({
      body: createBodyFor(input),
      user,
      idempotencyKey: channelCreateKey(ctx),
    });
    if (out.status !== 200 && out.status !== 201) {
      throw new ProjectCreateRefusedError(out.status, out.body);
    }
    const id = String(out.body.id);
    return {
      project_id: id,
      name: String(out.body.name ?? input.title),
      project_type: typeof out.body.project_type === 'string' ? out.body.project_type : input.project_type,
      replayed: out.status === 200,
      url: `/projects/${id}`,
    };
}

/** fr-agui SPEC §3.4 (c): DERIVED from the declaration — no hand-written action object. */
export const projectsCreateAction: AgentCallableAction<CreateInput, CreateOutput> =
  deriveAgentAction(projectsCreateCapability);

// ---------------------------------------------------------------------------
// conveyor.list_project_types / conveyor.list_priority_levels (doorway reads)
// ---------------------------------------------------------------------------

function requireTenant(ctx: ActionContext): string {
  if (!ctx.tenantId) {
    throw new AppError(409, 'no workspace is resolved for this session').withCode('tenant_required');
  }
  return ctx.tenantId;
}

/** The agent read behind `conveyor.list_project_types` (capabilities/conveyor/list-project-types.ts). */
export async function listProjectTypesHandler(
  _input: Record<string, never>,
  ctx: ActionContext,
): Promise<z.infer<typeof listProjectTypesOutput>> {
  const tenantId = requireTenant(ctx);
  const types = await catalogueProjectTypes(tenantId);
  return {
    types: types.map((t) => ({
      name: t.name,
      title: t.title ?? null,
      description: t.description ?? null,
      // Same rule as the picker and the create door: a type pinned to another tenant is
      // not startable here, so the agent never proposes one that would 400.
      startable: isStartableProjectType(t) && projectTypeCreatableOn(t.name, tenantId),
    })),
  };
}

/** fr-agui SPEC §3.4 (c): DERIVED from the declaration. */
export const listProjectTypesAction: AgentCallableAction<
  Record<string, never>,
  z.infer<typeof listProjectTypesOutput>
> = deriveAgentAction(conveyorListProjectTypesCapability);

const listPrioritiesOutput = z.object({
  levels: z.array(
    z.object({ name: z.string(), title: z.string().nullable(), rank: z.number(), is_default: z.boolean() }),
  ),
});

export const listPriorityLevelsAction: AgentCallableAction<
  Record<string, never>,
  z.infer<typeof listPrioritiesOutput>
> = {
  name: 'conveyor.list_priority_levels',
  kind: 'read',
  description: "List this workspace's priority levels, highest first.",
  input: z.object({}).strict(),
  output: listPrioritiesOutput,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: () => 'conveyor.list_priority_levels',
  rbac: { type: 'custom', check: (ctx) => isAuthenticatedTenantUser(ctx) },
  handler: async (_input, ctx) => {
    const levels = await cataloguePriorities(requireTenant(ctx));
    return {
      levels: levels.map((l) => ({
        name: l.name,
        title: l.title ?? null,
        rank: l.rank,
        is_default: Boolean(l.is_default),
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function safeRegister<I, O>(a: AgentCallableAction<I, O>): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

/** Registers this module's actions (idempotent); `registerAllActions` calls it at boot. */
export function registerProjectsCreateActions(): void {
  safeRegister(projectsCreateAction);
  safeRegister(listProjectTypesAction);
  safeRegister(listPriorityLevelsAction);
}

registerProjectsCreateActions();
