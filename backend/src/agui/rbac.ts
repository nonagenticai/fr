/**
 * E-12: Per-action RBAC.
 *
 * One narrowly-scoped authorization seam at the action boundary. Runs *after*
 * Keycloak/license/tenant/project resolution (which produced `ActionContext`)
 * and *before* the idempotency cache (so denials never poison the cache and
 * never create approval rows).
 *
 * See `docs/superpowers/specs/completed/2026-04-25-e12-per-action-rbac.md` for the full
 * design rationale.
 *
 * Module-global plug-in points:
 *   - `setProjectMembershipProvider(p)` — supplies
 *     `(projectId, userId, tenantId) -> role | null`. Production registers
 *     `agui/tenant-member-provider.ts` at boot (server.ts; fr-agui P1-TEAM-a,
 *     George 2026-10-15: every member of a tenant is a member of every project
 *     of that tenant). `tenantId` is the caller's RESOLVED tenant
 *     (`resolvedRbacTenant`). Without a registration the module-level deny-all
 *     stays in force (`rbac_provider_not_registered`).
 *
 * Production wires the DB-backed provider at boot.
 */

import type { DeptRole } from '../db/schema';
import { principalDoorAdmits, type CapabilityRoute } from '../capabilities/rbac-rules';
import { tryGetRequestContext } from '../integrations/_lib/context';
import { isSuperAdmin } from '../lib/super-admin-gate';
import { and, eq } from 'drizzle-orm';

import { db, departments } from '../db/client';
import { INTERNAL_SYSTEM_TENANT_ID } from '../middleware/internal-tenant-only';
import { getMemberRole } from '../services/department-members';
import { hasRole as defaultHasRole, isWorkspaceAdminVia } from '../services/user-roles';
import { AppError } from '../utils/errors';
import type { ActionContext, AgentCallableAction } from './types';
import { agentSurfaceRefusal, projectAgentMembershipApplies } from './agent-surface';

// ---------- Rule shape ----------

export type ProjectRole = 'owner' | 'editor' | 'viewer';

/**
 * Foundation Plan 2 §Task 9 — department-role rule. Delegates to
 * `getMemberRole` (services/department-members) and ranks the role against
 * `min` using `DEPT_ROLE_ORDER` below. The discriminator stays `type` to
 * match every other variant in this union (the plan spec drafted it as
 * `kind`, but `RbacRuleLike` in `agui/types.ts` and every existing rule
 * here use `type`; aligning avoids a parallel discriminator just for one
 * variant).
 */
export type DeptRoleRule = { type: 'dept-role'; deptId: string; min: DeptRole };

export type RbacRule =
  | { type: 'public' }
  | { type: 'project-member' }
  | { type: 'project-role'; role: ProjectRole }
  | { type: 'tenant-role'; role: string }
  /**
   * fr-agui P4a1 — workspace-admin of `ctx.tenantId`, decided by the ONE
   * canonical predicate `isWorkspaceAdminVia` (services/user-roles.ts): a
   * `user_roles` 'workspace-admin' row, OR a realm `tenant_admin` / legacy
   * `admin` PINNED to the raw `tenant_id` claim (`ctx.tenantClaim`). This is the
   * rule `requireWorkspaceAdmin` gates on in the routes; `tenant-role
   * 'workspace-admin'` is NOT it (an unpinned realm-string match that misses
   * every DB grant and every realm tenant_admin). No `ctx.tenantClaim` ⇒ the
   * realm arm fails closed; no `ctx.tenantId` / `ctx.userId` ⇒ deny.
   *
   * fr-agui P4a3: with `route` (the capability's own `router.add` pattern), the
   * rule ALSO applies the licence / conveyor route doors `validateAuth` applies
   * before any handler logic (`principalDoorAdmits`, capabilities/rbac-rules.ts),
   * so a licence caller whose user holds a workspace-admin grant is refused
   * exactly where the route refuses it (403 licence_route_not_allowed). Without
   * `route` the rule is unchanged (P4-carry: the KAG admin verbs).
   *
   * fr-agui P4b — two options, each mirroring a route gate EXACTLY:
   *   * `superAdmin: true` — a platform super_admin (`isSuperAdmin`, the realm
   *     role on the verified token) passes too, once the door and the tenant
   *     resolution have passed: `routes/settings/llm-provider.ts` isTenantAdmin
   *     and `routes/tenant/billing.ts` (workspace-admin | super-admin).
   *   * `frameTenant: true` — the tenant is the REQUEST-CONTEXT tenant only,
   *     refused when absent or blank after trim (no JWT fallback): the route's
   *     upstream client is `requireTenant` (worker_management, which refuses
   *     MISSING_TENANT before sending), so a caller with no frame tenant is never
   *     served even when the admin check itself would pass on the JWT tenant.
   *   * `frameTenant: 'untrimmed'` (P4b part 3) — the REQUEST-CONTEXT tenant only,
   *     refused when absent or EMPTY, NOT trimmed: `routes/me/budget-topup.ts`
   *     (`getRequestContext().tenantId`, then `if (!tenantId)` → 400) admits a
   *     whitespace frame tenant to its admin check, where only the super_admin
   *     arm can pass it (a blank id is neither a pinned claim nor a uuid).
   *
   * fr-agui P4c part 1 — `deptAdminOf: '<input key>'`: a `dept-admin` of the
   * department the INPUT names under that key (`getMemberRole`, the predicate
   * the route calls) passes too, once the door and the tenant resolution have
   * passed: routes/admin/department-members.ts (workspace-admin OR dept-admin of
   * `:id`). Whether that department belongs to the request tenant is the
   * route's RESOURCE check (an opaque 404 first), not part of the principal rule.
   *
   * fr-agui P4c part 2 — two more, each the route's own check:
   *   * `systemTenantSuperOnly: true` — when the resolved tenant is the SYSTEM
   *     tenant, ONLY the super_admin arm counts (routes/admin/assets/_lib/gate.ts
   *     `gateWriteAsset`: system asset writes are super-admin only, so a
   *     workspace-admin grant / realm tenant_admin of the system tenant is
   *     refused there). Every other tenant is unchanged.
   *   * `deptManagerOfPromoteTarget: true` — routes/asset-scope/promote.ts: when
   *     the input's `to` is `{ dept_id }` (a promotion to a DEPARTMENT), a
   *     `dept-admin` or `dept-manager` of that department passes too, provided
   *     the department belongs to the resolved tenant (the route reads
   *     `departments` by id AND workspace_id before the role). A promotion to
   *     the workspace (`to: 'workspace'`) stays workspace-admin only.
   */
  | {
      type: 'workspace-admin';
      route?: CapabilityRoute;
      superAdmin?: true;
      frameTenant?: true | 'untrimmed';
      deptAdminOf?: string;
      systemTenantSuperOnly?: true;
      deptManagerOfPromoteTarget?: true;
    }
  | DeptRoleRule
  | {
      type: 'custom';
      check: (ctx: ActionContext, input: unknown) => Promise<boolean>;
    };

// dept-admin >= dept-manager >= dept-member >= dept-viewer
const DEPT_ROLE_ORDER: Record<DeptRole, number> = {
  'dept-viewer': 0,
  'dept-member': 1,
  'dept-manager': 2,
  'dept-admin': 3,
};

/** P4c part 1 `deptAdminOf`: the caller is `dept-admin` of the department `input[key]` names. */
async function deptAdminOfInput(key: string, userId: string, input: unknown): Promise<boolean> {
  const deptId = (input as Record<string, unknown> | null | undefined)?.[key];
  if (typeof deptId !== 'string' || deptId === '') return false;
  return (await getMemberRole(deptId, userId)) === 'dept-admin';
}

/**
 * P4c part 2 `deptManagerOfPromoteTarget`: the route's department arm (routes/asset-scope/promote.ts
 * `canPromoteToDept`): `to` is `{ dept_id }`, that department belongs to `workspaceId` (the route's
 * `departments` read by id AND workspace_id), and the caller is its `dept-admin` or `dept-manager`.
 */
async function deptManagerOfPromoteTarget(userId: string, workspaceId: string, input: unknown): Promise<boolean> {
  const to = (input as Record<string, unknown> | null | undefined)?.to;
  if (to === null || typeof to !== 'object') return false;
  const deptId = (to as Record<string, unknown>).dept_id;
  if (typeof deptId !== 'string' || deptId === '') return false;
  if (!(await departmentInWorkspace(deptId, workspaceId))) return false;
  const role = await getMemberRole(deptId, userId);
  return role === 'dept-admin' || role === 'dept-manager';
}

async function departmentInWorkspace(deptId: string, workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.id, deptId), eq(departments.workspace_id, workspaceId)))
    .limit(1);
  return row !== undefined;
}

// ---------- Error type ----------

/**
 * A permission denial.
 *
 * ⚠️ Extends `AppError` with status 403 so `handleError` renders it as a
 * denial. It used to extend bare `Error`, which meant `handleError` matched
 * nothing and fell through to `500 {"error":"Internal server error"}` on every
 * REST tool route (/api/tools/{analytics,kag,coding}/*, assets/artifacts) --
 * `withIntegrationCatch` rethrows non-IntegrationErrors by design, so nothing
 * in between reclassified it.
 *
 * That was not cosmetic. The caller could not tell "you may not do this" from
 * "fr is broken", and 20 n8n node modules retry on `statusCode >= 500`, so a
 * denial that can never succeed was retried indefinitely.
 *
 * `routes/agui.ts` catches this class explicitly and answers 200 NDJSON; that
 * path is unaffected -- subclassing does not break `instanceof`.
 *
 * The existing machine-readable `code` is promoted onto `AppError.code`, which
 * `handleError` emits as a top-level `code` on the body.
 *
 * ⛔ `this.name` is re-set AFTER super() on purpose: AppError's constructor
 * sets `this.name = 'AppError'`, and callers match this class by name.
 */
export class RbacDeniedError extends AppError {
  constructor(
    code: string,
    public readonly actionName: string,
    public readonly reason: string,
  ) {
    super(403, `RBAC denied for action ${actionName}: ${reason} (code=${code})`);
    this.name = 'RbacDeniedError';
    // Not a parameter property: `AppError` already declares `code`, and
    // re-declaring it here as `readonly` conflicts with the mutable base field.
    // Assigning keeps `err.code` byte-identical for every existing reader.
    this.code = code;
  }
}

// ---------- Project-membership provider plug-in ----------

/**
 * Resolves the project role for a given (projectId, userId) pair, or `null`
 * if the user is not a member of the project.
 *
 * Implementations MUST be safe to call concurrently and SHOULD be cheap
 * (request-scoped memoization is the caller's responsibility, not the
 * provider's, per the open question in the spec).
 */
export interface ProjectMembershipProvider {
  /**
   * `tenantId` — the caller's RESOLVED tenant (P1-TEAM-a): the request-context
   * frame's tenant, else `ActionContext.tenantId` (`resolvedRbacTenant`).
   * `undefined` when neither carries one; a provider MUST then answer `null`.
   *
   * `homeTenantId` — the caller's OWN (JWT / agent-token) tenant. When it
   * differs from `tenantId` the caller acts OUTSIDE its own tenant (a
   * super-admin switched view): it is not a member there, and the production
   * provider answers at most a read-only `viewer`, `editor` only on a project
   * the caller owns (the pre-P1-TEAM owner pin on writes).
   */
  getRole(
    projectId: string,
    userId: string,
    tenantId?: string,
    homeTenantId?: string,
  ): Promise<ProjectRole | null>;
}

/**
 * Default provider that denies every membership lookup. Installed at module
 * load so an action requiring project membership cannot accidentally pass
 * when boot wiring forgot to register a real provider. Denials produced
 * while this provider is active are flagged as
 * `code='rbac_provider_not_registered'` (vs. `rbac_not_project_member` for a
 * real provider that legitimately reports no membership).
 */
const denyAllProvider: ProjectMembershipProvider = {
  async getRole(_projectId, _userId) {
    return null;
  },
};

let membershipProvider: ProjectMembershipProvider = denyAllProvider;
let isDefaultProvider = true;

export function setProjectMembershipProvider(p: ProjectMembershipProvider): void {
  membershipProvider = p;
  isDefaultProvider = false;
}

export function getProjectMembershipProvider(): ProjectMembershipProvider {
  return membershipProvider;
}

// owner >= editor >= viewer
const ROLE_ORDER: Record<ProjectRole, number> = {
  owner: 3,
  editor: 2,
  viewer: 1,
};

// ---------- Workspace-admin role lookup plug-in ----------

type HasRoleFn = (userId: string, tenantId: string, role: string) => Promise<boolean>;
const workspaceAdminHasRole: HasRoleFn = (u, t, r) => defaultHasRole(u, t, r);

function roleSatisfies(actual: ProjectRole, required: ProjectRole): boolean {
  return ROLE_ORDER[actual] >= ROLE_ORDER[required];
}

// ---------- Default rule ----------

/**
 * Synthesize the default rule when `action.rbac` is absent.
 *
 * - projectId !== null  -> require project membership
 * - projectId === null  -> require baseline tenant role 'user'
 *
 * This is intentionally conservative: actions safe for any authenticated
 * caller MUST opt in via `rbac: { type: 'public' }`.
 */
function defaultRule(ctx: ActionContext): RbacRule {
  if (ctx.projectId !== null && ctx.projectId !== undefined) {
    return { type: 'project-member' };
  }
  return { type: 'tenant-role', role: 'user' };
}

// ---------- Per-rule resolution ----------

/**
 * The caller's RESOLVED tenant, EXACTLY as the routes resolve it
 * (`ctxTenantId(user.tenantId)`, middleware/request-context.ts): the
 * request-context frame's tenant — the accepted `X-Active-Tenant` of a switched
 * super-admin, a licence's pinned tenant — else the JWT tenant on
 * `ctx.tenantId`. Spelled over the env-free frame accessor
 * (integrations/_lib/context) because importing request-context loads Keycloak
 * config, and the env-free guards import this module. Shared by the
 * `workspace-admin` rule and the project-membership lookup so the two can never
 * resolve different tenants for one call.
 */
export function resolvedRbacTenant(ctx: Pick<ActionContext, 'tenantId'>): string | undefined {
  return tryGetRequestContext()?.tenantId || ctx.tenantId || undefined;
}

async function checkProjectMember(
  actionName: string,
  ctx: ActionContext,
): Promise<ProjectRole> {
  if (ctx.projectId === null || ctx.projectId === undefined) {
    throw new RbacDeniedError(
      'rbac_project_required',
      actionName,
      'this action requires a project-scoped context but ctx.projectId is null',
    );
  }
  const role = await membershipProvider.getRole(
    ctx.projectId,
    ctx.userId,
    resolvedRbacTenant(ctx),
    ctx.tenantId || undefined,
  );
  if (role === null) {
    if (isDefaultProvider) {
      // Deployment misconfiguration: no real provider was wired at boot, so
      // the module-level denyAllProvider is denying everything. Surface as
      // an authz event with a distinct code so operators see it on the RBAC
      // dashboard rather than as legitimate per-user denials.
      throw new RbacDeniedError(
        'rbac_provider_not_registered',
        actionName,
        "No project-membership provider registered. Wire setProjectMembershipProvider at boot or set rbac:{type:'public'} on the action.",
      );
    }
    throw new RbacDeniedError(
      'rbac_not_project_member',
      actionName,
      `user ${ctx.userId} is not a member of project ${ctx.projectId}`,
    );
  }
  return role;
}

async function evaluateRule(
  rule: RbacRule,
  action: AgentCallableAction,
  ctx: ActionContext,
  input: unknown,
): Promise<void> {
  switch (rule.type) {
    case 'public':
      return;

    case 'project-member': {
      const role = await checkProjectMember(action.name, ctx);
      // P1-TEAM-a: a `viewer` is READ-ONLY. The production provider answers
      // `viewer` for a caller acting outside its own tenant (a super-admin
      // switched view) on a project it does not own; such a caller keeps the
      // pre-P1-TEAM owner pin on every AGENT project-member write, so a WRITE
      // needs `editor`. (REST writes vary: see `projectWritableByCaller`.)
      if (action.kind === 'write' && !roleSatisfies(role, 'editor')) {
        throw new RbacDeniedError(
          'rbac_insufficient_project_role',
          action.name,
          `a write requires project role 'editor' but user has '${role}'`,
        );
      }
      return;
    }

    case 'project-role': {
      const actual = await checkProjectMember(action.name, ctx);
      if (!roleSatisfies(actual, rule.role)) {
        throw new RbacDeniedError(
          'rbac_insufficient_project_role',
          action.name,
          `requires project role '${rule.role}' but user has '${actual}'`,
        );
      }
      return;
    }

    case 'tenant-role': {
      const roles = ctx.tenantRoles ?? [];
      if (!roles.includes(rule.role)) {
        throw new RbacDeniedError(
          'rbac_missing_tenant_role',
          action.name,
          `requires tenant role '${rule.role}'`,
        );
      }
      return;
    }

    case 'workspace-admin': {
      // The tenant is resolved EXACTLY as the route gate does
      // (routes/assets/kag.ts requireWorkspaceAdmin: `ctxTenantId(user.tenantId)`):
      // the REQUEST-CONTEXT tenant, which is the X-Active-Tenant once a
      // super_admin's switch is accepted (middleware/request-context.ts), and
      // the JWT tenant (`ctx.tenantId`) only when no frame carries one.
      // `ctx.tenantId` itself is NOT re-pointed for the other rules.
      // `resolvedRbacTenant` — the same resolution the membership lookup uses:
      // `ctxTenantId(ctx.tenantId)` (middleware/request-context.ts), spelled
      // out over the frame accessor because importing that module loads
      // Keycloak config, and the env-free guards import this one.
      // P4b `frameTenant`: the REQUEST-CONTEXT tenant only, non-blank after
      // trim, no JWT fallback (the route's upstream client is requireTenant).
      // P4b part 3 `frameTenant: 'untrimmed'`: present and non-empty, no trim.
      const frameTenantId = tryGetRequestContext()?.tenantId;
      const tenantId =
        rule.frameTenant === 'untrimmed'
          ? frameTenantId || undefined
          : rule.frameTenant
            ? frameTenantId?.trim()
              ? frameTenantId
              : undefined
            : resolvedRbacTenant(ctx);
      if (rule.route !== undefined && !principalDoorAdmits(rule.route)) {
        throw new RbacDeniedError(
          'rbac_route_door',
          action.name,
          `the caller's route door refuses ${rule.route.method} ${rule.route.path} (licence allowlist / conveyor write routes)`,
        );
      }
      const superArm = rule.superAdmin === true && isSuperAdmin({ roles: [...(ctx.tenantRoles ?? [])] });
      // P4c part 2 `systemTenantSuperOnly`: in the SYSTEM tenant the super_admin arm is the only one.
      const systemOnlySuper = rule.systemTenantSuperOnly === true && tenantId === INTERNAL_SYSTEM_TENANT_ID;
      const ok =
        Boolean(ctx.userId) &&
        tenantId !== undefined &&
        (superArm ||
          (!systemOnlySuper &&
          ((await isWorkspaceAdminVia(
            {
              id: ctx.userId,
              roles: [...(ctx.tenantRoles ?? [])],
              ...(ctx.tenantClaim !== undefined ? { tenantClaim: ctx.tenantClaim } : {}),
            },
            tenantId,
            workspaceAdminHasRole,
          )) ||
          (rule.deptAdminOf !== undefined && (await deptAdminOfInput(rule.deptAdminOf, ctx.userId, input))) ||
          (rule.deptManagerOfPromoteTarget === true && (await deptManagerOfPromoteTarget(ctx.userId, tenantId, input))))));
      if (!ok) {
        throw new RbacDeniedError(
          'rbac_not_workspace_admin',
          action.name,
          `requires workspace-admin of tenant ${tenantId ?? '(none)'}`,
        );
      }
      return;
    }

    case 'dept-role': {
      const have = await getMemberRole(rule.deptId, ctx.userId);
      if (have === null) {
        throw new RbacDeniedError(
          'rbac_not_dept_member',
          action.name,
          `user ${ctx.userId} is not a member of department ${rule.deptId}`,
        );
      }
      if (DEPT_ROLE_ORDER[have] < DEPT_ROLE_ORDER[rule.min]) {
        throw new RbacDeniedError(
          'rbac_insufficient_dept_role',
          action.name,
          `requires dept role '${rule.min}' but user has '${have}'`,
        );
      }
      return;
    }

    case 'custom': {
      // A thrown exception inside `check` is intentionally NOT caught — see
      // spec §"Per-rule resolution" → custom: genuine bugs surface as 500s
      // rather than silent denials.
      const ok = await rule.check(ctx, input);
      if (!ok) {
        throw new RbacDeniedError(
          'rbac_custom_denied',
          action.name,
          'custom predicate returned false',
        );
      }
      return;
    }

    default: {
      // Exhaustiveness — if a future rule type is added without a handler,
      // fail closed.
      const _exhaustive: never = rule;
      throw new Error(`Unhandled RBAC rule type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ---------- Public entry point ----------

/**
 * Throws `RbacDeniedError` when the caller is not authorized to invoke the
 * given action under the given context. Resolves with no value otherwise.
 *
 * Called by `invokeAction` between input validation and the idempotency
 * lookup. See spec §"Enforcement order".
 */
export async function assertRbac(
  action: AgentCallableAction<any, any>,
  ctx: ActionContext,
  input: unknown,
): Promise<void> {
  // fr-agui SPEC §13 P1c (OQ-17 = c): the AGENT's surface, before the action's
  // own rule — the rail may use only the project agent's set (bound thread) or
  // the doorway set (unbound); a retired action (`catalog:'none'`) is refused to
  // every agent. Every persona, super_admin included. Human callers (the channel
  // grammar, REST routes) are untouched (agui/agent-surface.ts).
  const refusal = agentSurfaceRefusal(action, ctx);
  if (refusal) throw new RbacDeniedError(refusal.code, action.name, refusal.reason);
  const rule = action.rbac ?? defaultRule(ctx);
  // SPEC §4.1: the PROJECT agent's tools are project-member / project-role tools.
  // A re-homed action whose own rule is weaker (`public`, `tenant-role`, a channel
  // `custom`) gets the bound project's membership rule FIRST in a bound rail
  // context — a WRITE then needs `editor` — so the agent's answer equals the
  // project route's (the tenant-member provider mirrors those gates, P1-TEAM-a;
  // tests/unit/capabilities/rbac-parity.test.ts). Channel / REST callers keep the
  // action's own rule unchanged.
  if (projectAgentMembershipApplies(action, ctx) && rule.type !== 'project-member' && rule.type !== 'project-role') {
    await evaluateRule({ type: 'project-member' }, action as AgentCallableAction, ctx, input);
  }
  await evaluateRule(rule, action as AgentCallableAction, ctx, input);
}
