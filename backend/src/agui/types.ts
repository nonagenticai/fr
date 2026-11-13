/**
 * E-2: AG-UI action registry — frozen type contracts.
 *
 * These types are shared between the registry, route handlers that wrap an
 * action invocation in an HTTP response, and (eventually) the agent core that
 * will call invokeAction directly. Do not widen the shape of ActionContext or
 * AgentCallableAction without coordinating with every action author.
 */

import type { DecisionVia } from '../db/schema';

export type ActionKind = 'read' | 'write';

export type ApprovalPolicy =
  | { type: 'auto' }
  | { type: 'single-approver'; approver: 'initiator' | 'project-owner' | string }
  | { type: 'consensus'; approvers: string[]; min: number }
  | { type: 'n-of-m'; approvers: string[]; n: number };

export interface ActionContext {
  userId: string;
  projectId: string | null;
  correlationId: string;
  initiator: 'human' | 'agent' | 'cron';
  /** 'web' | 'telegram' | 'teams' | 'cron' | future channel. */
  channel: string;
  /**
   * E-12 — Tenant roles attached to the request by Keycloak claim extraction
   * (or by the agent-token verifier). Optional and additive: existing call
   * sites that do not populate it will see `undefined`, which is treated as
   * an empty role set by RBAC. Source of truth (realm vs client roles) is
   * spec §"Open questions" #3 — left to the populator.
   */
  tenantRoles?: string[];
  /**
   * Plan 3 follow-up — the user's tenant/workspace UUID, resolved at the
   * AG-UI invoke layer via `services/user-tenant.getUserTenant`. Required
   * by `applyEffectiveFilter` (foundation Plan 2) so per-action handlers
   * can scope upstream search/list results to the user's effective set.
   * `undefined` when the user has no `user_roles` row (anonymous / not yet
   * seeded); handlers must treat that as "no scoping possible — return
   * unfiltered" rather than throwing.
   */
  tenantId?: string;
  /**
   * Human-readable workspace name for the resolved tenant (mirrors
   * `User.tenantName` on the Keycloak path; sourced from `workspaces.name`
   * on the agent path). Passed to `applyEffectiveFilter` so the lazy
   * `ensureWorkspace` insert receives a legible name on first sight.
   * `undefined` / empty falls back to id-as-name (PR #239 behaviour).
   */
  tenantName?: string;
  /**
   * fr-agui P4a1 — the caller's RAW Keycloak `tenant_id` claim (`User.tenantClaim`),
   * read only by the `workspace-admin` RBAC rule: it is what the realm
   * `tenant_admin` arm of `isWorkspaceAdminVia` pins to. Populate it ONLY from a
   * verified Keycloak token, never from `tenantId` (which `deriveTenantId` may
   * have defaulted to `sub`). Absent ⇒ that arm fails closed and only the
   * `user_roles` arm can admit.
   */
  tenantClaim?: string;
  /**
   * fr-agui SPEC §5.7 / P1b — Keycloak REALM roles, set ONLY from a VERIFIED
   * Keycloak token (the agent chat's forwarded `X-End-User-Token`,
   * middleware/request-context.ts `verifiedEndUserRealmRoles`). Never from the
   * fr-minted agent token. Read by the project READ gate only
   * (`loadProjectForRead` / `projectReadableAsGetProjectFilter`), so an agent
   * read answers exactly what `GET /api/projects/:id` answers for the same
   * person. Absent ⇒ no realm roles (the strict, fail-closed answer).
   */
  realmRoles?: readonly string[];
  /**
   * fr-agui P1-TEAM-c (George 2026-10-15) — set ONLY by `resolvePendingAction` on a
   * DEFERRED execution: the user whose agent REQUESTED the parked action. On that
   * path `userId` is the APPROVER the action runs as ("the action then runs under the
   * APPROVER's identity, not the requester's"). Absent everywhere else, where
   * `userId` is simply the caller. Handlers never act as this id; it is for
   * attribution and for telling "approved by someone else" from a self-approval.
   */
  requesterId?: string;
  /**
   * fr-agui P1-TEAM-c — set ONLY by the channel dispatcher, from the identity resolver,
   * when the sender's address is linked to MORE THAN ONE fr account (`userId` is one
   * of them). `approvals.decide` refuses such a sender (except the requester deciding
   * their own row): the decision, and the action it runs as its approver, must never
   * be attributed to one of several accounts.
   */
  channelLinkedAccountIds?: readonly string[];
  /**
   * fr-agui P1-TEAM-c audit 2 — set ONLY by the channel dispatcher, `true` when this dispatch
   * is a web SESSION (`inapp` / `web` with a server-set session tenant: `validateAuth` ran on
   * the request and the body's user is the token's). The ONE piece of evidence that lets a
   * `web`/`inapp` chat decide an ACTION approval (lib/action-decision-identity.ts); the
   * `web` N8N_WEBHOOK_SECRET injection, whose user is a body field, never carries it.
   */
  channelWebSession?: boolean;
  /**
   * Set ONLY by the channel dispatcher: the workspace the sender's link is pinned to
   * (`user_channel_prefs.tenant_id`, migration 216). The write-site re-check
   * (`assertChannelTenantResolved`) resolves the tenant with it, exactly as the
   * dispatcher did, so a pinned multi-workspace sender is not refused there. A
   * parked action stores it in the approval's server-written metadata and
   * `resolvePendingAction` restores it when the action runs.
   */
  channelLinkedTenantId?: string;
  /**
   * fr #1683 — set ONLY by the channel dispatcher for an agent member's mcp message: how
   * it arrived (channel, agent member, product, job), recorded on a decision
   * (`approval_decisions.via`) and on a parked approval's metadata. `userId` is the agent
   * member itself, or — option A, a resolvable `on_behalf_of` — that staff member.
   */
  decisionVia?: DecisionVia;
}

/**
 * A write action that routes through the approval backend returns a pending
 * descriptor rather than the declared Output type. `invokeAction`'s return
 * type is therefore `Promise<O | PendingAction>`; callers must narrow.
 */
export interface PendingAction {
  status: 'pending';
  actionId: string;
  /**
   * The approvals row id (`approvals.id`) the park created. This is the id a
   * human names in `approve <id>` / `reject <id>` and the one
   * `PUT /api/approvals/:approvalId` takes (fr-agui SPEC §5.2 P). Optional so a
   * PendingAction cached by `runIdempotent` before P0a still parses.
   */
  approvalId?: string;
}

/**
 * fr-agui SPEC §5.2 (W): a write the web agent PROPOSES instead of executing.
 * The agent loop validates the input, dry-runs RBAC and returns
 * `status:'proposal'`; the browser renders a confirm card and, on the human's
 * click, calls `http` under the human's own Keycloak session. No approval row
 * is created and the handler is never run by the agent.
 */
export interface ProposalSpec {
  /** The UI route the confirm card calls. `:name` segments come from the input. */
  http: { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string };
  /** The frontend card that renders this proposal. */
  card: 'project-create' | 'approval-decide' | 'project-request' | 'capability-invoke' | 'file-upload' | 'artifact-review' | 'typed-confirm' | 'model-review' | 'model-import';
  /** Input keys that are secrets (§10.1 / R7): never echoed into the thread. */
  secretFields?: readonly string[];
  /**
   * fr-agui P2-c2 — input keys ONLY THE HUMAN sets, on the card (fr is a
   * facilitator, never a judge: an artifact review's decision, the typed name of
   * a destructive confirmation). They are removed from the LLM-facing schema and
   * from any input the agent sends, so a proposal can never carry them; the
   * card collects them itself and the handler requires them.
   */
  humanFields?: readonly string[];
  /** The browser mints an `Idempotency-Key` (UUID v4) once per proposal. */
  idempotent?: boolean;
}

export interface AgentCallableAction<Input = unknown, Output = unknown> {
  /** `<tool>.<verb_noun>`, exactly two lowercase segments. Enforced at register. */
  name: string;
  kind: ActionKind;
  /** Surfaced to the agent as the tool description. */
  description: string;
  /** zod schema for input (typed as `unknown` to avoid coupling to a specific zod version's generic). */
  input: unknown;
  /** zod schema for output. */
  output: unknown;
  approval: ApprovalPolicy;
  /**
   * Derived key from input — NOT a random UUID. Must resolve to a non-empty
   * string. May be sync or async; async is used by actions that fold runtime
   * state into the key (e.g. `coding.trigger_analysis` resolving the repo
   * HEAD sha so two analyze calls with the same `(repo_id, head_sha)` dedup
   * to the same approval row).
   */
  idempotencyKey: (input: Input) => string | Promise<string>;
  /**
   * Safe for non-interactive initiators. When false, invoking with
   * `ctx.initiator === 'cron'` throws NotCronSafeError.
   */
  cronSafe: boolean;
  handler: (input: Input, ctx: ActionContext) => Promise<Output>;
  /**
   * Idempotency TTL (seconds).
   *   - kind:'read': reads are NOT cached unless this is set; setting it opts
   *     the read into a cache of this length (D2).
   *   - kind:'write': dedupe window for the approval dispatch / self-approve
   *     run; defaults to 24h if unset.
   * Every cache key is scoped by user, tenant and project.
   */
  idempotencyTtlSeconds?: number;
  /** TTL for the approval row in seconds; default 24h if absent. */
  approvalTtlSeconds?: number;
  /**
   * Auto-approve this write when a HUMAN invokes it directly and is themselves
   * the sole required approver — i.e. execute inline instead of parking a
   * pending approval. A person performing their own self-service action (e.g.
   * uploading a document into KAG, kicking off a scrape) has no one else to
   * gate on, so the approval would only be them approving themselves.
   *
   * Strictly opt-in and initiator-gated: a NON-human initiator (agent / n8n /
   * cron) still parks for human review — that is where the approval carries
   * real governance value. Actions that omit this park exactly as before.
   */
  autoApproveForInitiator?: boolean;
  /**
   * E-12 — Optional fine-grained authorization rule evaluated by `assertRbac`
   * before idempotency lookup / approval dispatch. Typed loosely here as
   * `unknown` to avoid a circular import with `rbac.ts`; consumers in
   * `rbac.ts` narrow via `RbacRule`. Authors SHOULD import `RbacRule` from
   * `./rbac` and assign accordingly:
   *
   *   const myAction: AgentCallableAction<I, O> = {
   *     ...,
   *     rbac: { type: 'project-role', role: 'editor' } satisfies RbacRule,
   *   };
   *
   * When omitted, the default rule synthesizes `project-member` for
   * project-scoped contexts and `tenant-role: user` otherwise.
   */
  rbac?: RbacRuleLike;
  /**
   * fr-agui SPEC §5.2. Present ⇒ the web agent never invokes this action; it
   * returns a proposal for a confirm card (W). Channel invocations are unchanged.
   */
  confirm?: ProposalSpec;
  /**
   * `'never'` ⇒ this write is NEVER parked as an approval: it is itself the
   * human's governance act on an approval that already exists. Allowed for
   * exactly one action, `approvals.decide` (enforced at registration). The
   * registry runs it directly ONLY for a human channel initiator; every other
   * invocation (the agent token, the web) is refused.
   */
  parking?: 'never';
  /**
   * The channel reply for a parked invocation (Telegram/Teams). Absent ⇒ the
   * dispatcher's generic "awaiting approval" text.
   */
  channelPendingText?: (input: Input, ctx: ActionContext, approvalId: string) => string;
  /**
   * fr-agui SPEC §5.7 rule 3. The input key that names the project, for a
   * `tenancy:'project'` capability (derived from its `/api/projects/:<param>`
   * path, capabilities/derive-agent.ts). In a project-bound thread it is removed
   * from the LLM-facing schema and injected from `ctx.projectId`
   * (agent/project-binding.ts); a different id is refused `project_mismatch`.
   */
  projectParam?: string;
  /**
   * fr-agui SPEC §5.2 (W). A confirm-card write that exists ONLY on the web
   * (its capability declares no Telegram/Teams channel): a channel invocation is
   * refused before any approval row is parked, so `approve <id>` can never run
   * it. Its `handler` is never reached.
   */
  webOnly?: true;
  /**
   * fr-agui SPEC §13 P1c (OQ-17 = c, George 2026-10-14). `'none'` ⇒ RETIRED FROM
   * THE AGENT: the action is in NO agent catalog (the project agent, the doorway,
   * the channel agent) and an agent invocation of it is refused
   * `rbac_retired_from_agent`. The action stays registered because a REST route
   * (the tools routes) or the deterministic channel grammar (`status`, `help`, …)
   * still invokes it as a HUMAN — those callers are untouched. Stamped at
   * registration from the one list in `agui/agent-surface.ts`.
   */
  catalog?: 'none';
}

/**
 * Structural mirror of `rbac.ts`'s `RbacRule` discriminated union, declared
 * here purely so `AgentCallableAction.rbac` can be typed without forming a
 * circular import (`rbac.ts` imports `types.ts`). The canonical definition
 * — including the typed `custom.check` predicate — lives in `./rbac`. Any
 * change to the union there must mirror here.
 */
export type RbacRuleLike =
  | { type: 'public' }
  | { type: 'project-member' }
  | { type: 'project-role'; role: 'owner' | 'editor' | 'viewer' }
  | { type: 'tenant-role'; role: string }
  | {
      type: 'workspace-admin';
      route?: { readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; readonly path: string };
      /** fr-agui P4b: a platform super_admin also passes (the routes that admit one; see agui/rbac.ts). */
      superAdmin?: true;
      /**
       * fr-agui P4b: the tenant is the REQUEST-CONTEXT tenant only — `true`: non-blank after trim;
       * `'untrimmed'` (P4b part 3): present and non-empty, no trim (see agui/rbac.ts).
       */
      frameTenant?: true | 'untrimmed';
      /**
       * fr-agui P4c part 1: a dept-admin of the department named by this INPUT key also passes
       * (routes/admin/department-members.ts: workspace-admin OR dept-admin of `:id`; see agui/rbac.ts).
       */
      deptAdminOf?: string;
      /**
       * fr-agui P4c part 2: in the SYSTEM tenant only the super_admin arm passes (routes/admin/assets/_lib/gate.ts
       * gateWriteAsset: system writes are super-admin only; a workspace-admin of the system tenant is refused).
       */
      systemTenantSuperOnly?: true;
      /**
       * fr-agui P4c part 2: the asset-scope promote target (routes/asset-scope/promote.ts): when the INPUT's `to`
       * names a department (`{ dept_id }`), a dept-admin / dept-manager of that department, which must belong to
       * the resolved tenant, also passes (see agui/rbac.ts).
       */
      deptManagerOfPromoteTarget?: true;
    }
  | {
      type: 'dept-role';
      deptId: string;
      min: 'dept-admin' | 'dept-manager' | 'dept-member' | 'dept-viewer';
    }
  | {
      type: 'custom';
      check: (ctx: ActionContext, input: unknown) => Promise<boolean>;
    };
