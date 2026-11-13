import { AsyncLocalStorage } from 'node:async_hooks';

export type Initiator = 'human' | 'agent' | 'cron';

export interface RequestContext {
  bearerToken?: string;
  correlationId: string;
  initiator: Initiator;
  channel: string;
  /**
   * Tenant identifier extracted from the bearer token's `tenant_id` claim
   * (or `sub` fallback via `deriveTenantId`). Forwarded as the plain
   * `X-Tenant-Id` header on every upstream HTTP call so trusted-network
   * middleware on secrets / requirements_management /
   * worker_management / artifact_service / kag picks up the per-user tenant
   * instead of falling back to `DEFAULT_TENANT_ID="n8n-dev"`.
   *
   * Optional because not every code path has a request-scoped user
   * (cron, channel webhooks, startup) — when absent, no header is sent.
   */
  tenantId?: string;
  /**
   * Keycloak user UUID (the JWT `sub` claim) for the request's end user.
   * Forwarded as `X-User-Id` on upstream HTTP calls so services that
   * participate in the next-push tenant+user separation contract can
   * attribute work to the correct user inside a shared tenant.
   *
   * Optional like `tenantId` — cron / startup / unauthenticated paths
   * have no user, in which case no header is sent. Sending an extra
   * `X-User-Id` to services that don't yet read it is benign by design.
   */
  userId?: string;
  /**
   * Subject identifier (Keycloak `sub` claim) — the canonical end-user
   * identity for downstream metering. Populated from the inbound
   * `X-Subject-Id` header (injected by license-authz/istio for
   * browser-facing requests as of 2026-04-27) with a JWT-`sub` fallback.
   * Forwarded as `X-Subject-Id` on every upstream HTTP call so
   * inference-router and metering attribute LLM cost back to the
   * originating user (per-user metering Phase 5a).
   *
   * Distinct from `userId` (X-User-Id, internal tenant+user separation
   * contract) — both are present because the upstream services use
   * different header names. They typically share the same UUID value when
   * both are populated.
   */
  subjectId?: string;
  /**
   * Producer-specific request extensions. The bridge slice carries the
   * originating coding-gateway run id (FR-side `coding_analysis_runs.id`)
   * here when a request operates on a coding output, so the bridge source's
   * `getOutput` can resolve fresh data on a cache miss instead of throwing
   * `coding_output_not_cached`.
   *
   * Populated from the `X-Coding-Job-Id` request header, or — when the
   * request body explicitly carries `coding_job_id` (e.g. drafts create) —
   * forced into ALS by the route handler before invoking the source.
   *
   * Optional and additive: routes that don't touch coding leave this unset.
   */
  coding?: {
    jobId?: string;
  };
  /**
   * Origin of the request's effective tenantId: `'jwt'` when derived from
   * the bearer token's `tenant_id` claim (default), `'header'` when the
   * super-admin override `X-Active-Tenant` was accepted. Observability
   * field — log it on tenant-sensitive writes so misrouted requests are
   * visible. Optional/defaulted to `'jwt'` by callers that don't care.
   *
   * The override is accepted only when (a) the requester is in
   * `SUPER_ADMIN_USER_IDS` AND the target is one of the reserved internal
   * tenants (system + workflow-improvement + prompt-improvement) or
   * matches the JWT tenant claim, or (b) the requester has an explicit
   * `user_roles` row in the target tenant (multi-membership; not yet
   * wired — super-admin path is sufficient for v1). All other cases
   * silently fall back to the JWT-derived tenantId.
   */
  activeTenantSource?: 'jwt' | 'header';
  /**
   * WHICH header displaced the JWT tenant — `'active-tenant-header'` is the
   * super-admin `X-Active-Tenant` workspace switcher (MEMBERSHIP-BOUNDED: a
   * platform tenant or the requester's own JWT tenant, SIGNED `super_admin`
   * realm role required). The `aa-orchestrator` `X-Tenant-Id` override that was
   * the second, UNBOUNDED value was removed (fr#1437): `buildRequestContext`
   * now refuses a role holder naming a foreign tenant with 403
   * `orchestrator_tenant_override_removed`.
   *
   * ⚠️ OPTIONAL, and `undefined` means "no header path was ever evaluated" —
   * NOT "jwt". Synthetic frames (cron seeders, the AG-UI / channels action
   * frames, `attributeRequestTo` on the webhook path) construct a context from a
   * resolved tenant with no request headers in sight; stamping `'jwt'` there
   * would assert a verified bearer claim that does not exist.
   */
  activeTenantVia?: 'jwt' | 'active-tenant-header';
  /**
   * The tenant the VERIFIED bearer token itself claims, kept alongside the
   * effective `tenantId` rather than replaced by it.
   *
   * `activeTenantSource` records *that* a header won; this records *what it
   * displaced*, and only the pair makes a divergence detectable. Both header
   * paths (the super-admin `X-Active-Tenant` switch and the `aa-orchestrator`
   * `X-Tenant-Id` override) set the source flag, and one of them —
   * `X-Active-Tenant` equal to the JWT's own claim — is not a divergence at
   * all. Comparing the flag alone would refuse a caller that is in perfect
   * agreement with itself.
   *
   * This matters because not every upstream honours the forwarded tenant.
   * Evidence Review with `ENABLE_AUTH` on resolves the actor from the token and
   * ignores `X-Tenant-Id` entirely, so a header-switched request executes in
   * the JWT's tenant while fr renders the switched one. See
   * `routes/assets/kag-reviews.ts`, which refuses exactly that pair.
   *
   * Undefined on unauthenticated and `AUTH_BYPASS` paths, where there is no
   * verified claim to disagree with.
   */
  jwtTenantId?: string;
  /**
   * The VERIFIED bearer carries the `super_admin` realm role. Set only by
   * `buildRequestContext` (the one place that verifies the token). Read by the
   * integration error converter to decide whether a browser may see raw
   * upstream detail (service names, internal paths, upstream bodies).
   * ⚠️ Absent ≠ super-admin: any frame that does not set it (synthetic frames,
   * nested action frames) gets the REDACTED body — fail closed.
   */
  callerIsSuperAdmin?: boolean;
  /**
   * George 2026-10-27: TRUE iff `callerIsSuperAdmin` AND the token is an FR
   * super-admin session — a human, signed by the fr realm issuer
   * (FR_SUPER_ADMIN_SWITCH_ISSUER) for fr's browser client
   * (FR_SUPER_ADMIN_SWITCH_AZP); lib/super-admin-switch-target.ts. Only such a
   * caller may switch into a customer workspace and act as tenant-admin of the
   * switched tenant (lib/super-admin-switch.ts). A portal-issued super_admin
   * (e.g. a bot via portal-bff) gets neither. Absent ⇒ false.
   */
  callerIsFrSuperAdminSession?: boolean;
  /**
   * TRUE when the bearer is an fr-minted AGENT token carrying the
   * `super_admin_switch` claim (lib/agent-token.ts): a Copilot session issued
   * for an fr super-admin session that was switched into `tenantId`. Its
   * writes are audited like the super_admin's own (lib/super-admin-tenant-audit.ts).
   */
  agentSuperAdminSwitch?: boolean;
  /**
   * TRUE when the effective `tenantId` is a Keycloak SERVICE ACCOUNT's `sub`
   * (the `deriveTenantId` sub fallback fired for a client-credentials token
   * with no `tenant_id` claim, and no header override displaced it). Such an
   * id is a caller identity, never a tenant — writes that create tenant-owned
   * rows refuse it (see `utils/tenant.ts isServiceAccountSubjectTenant`).
   */
  tenantIsServiceAccountSubject?: boolean;
  /**
   * The fr project this request operates on, once resolved AND validated by
   * `lib/project-owner-guard.ts guardProjectId()` against
   * `project_data.keycloak_tenant_id`. Forwarded as `X-Project-Id` on
   * upstream HTTP calls (`http-client.ts buildHeaders`) and folded into the
   * per-request metering span (`services/metering-emit.ts`) so
   * billing/inference-router can attribute cost to a project instead of only
   * a tenant.
   *
   * Deliberately NOT settable from an inbound header or request body — see
   * `setProjectId()`. A caller-supplied project id must pass the guard
   * first; trusting one directly would reopen the "ownership could not be
   * validated" gap the guard exists to close.
   */
  projectId?: string;
  /**
   * The signed-in user's OWN portal-realm access token, forwarded to
   * worker_management as `X-End-User-Token: Bearer <token>` on DELEGATED calls
   * (worker_management#316). It is the proof WM needs before it will decrypt a
   * tenant's stored BYO key for `svc-fr-backend`: WM verifies the signature
   * against the portal JWKS and requires the token to prove
   * `X-Effective-Tenant-Id` (raw `tenant_id`, or a `member_tenant_ids` entry —
   * fr#1385, shared predicate `tokenProvesTenant`).
   *
   * Set ONLY when ALL hold (see `middleware/request-context.ts
   * endUserTokenFromClaims`): the bearer verified against fr's Keycloak issuer,
   * it is a HUMAN token (not a client-credentials service account), and it
   * proves the effective `tenantId` of this frame (`tokenProvesTenant`: raw
   * `tenant_id` or a signed `member_tenant_ids` entry, EXACT). So an agent
   * token (HS256, `aud=fr-agent`), the conveyor's service identity, a
   * super-admin switched view into a workspace the token does not list, and
   * every synthetic frame (cron, webhooks) carry
   * NOTHING, and WM simply leaves the tenant unproven.
   *
   * ⛔ A CREDENTIAL. Never log it, never persist it, never copy it into a
   * telemetry span. Only the worker_management client opts in to sending it
   * (`HttpClientOptions.forwardEndUserToken`); no other upstream sees it.
   */
  endUserToken?: string;
  /**
   * The SWITCHED super-admin's own portal token, for ONE consumer only: the
   * agent's run-the-UI-route-as-the-human lane (`agui/actions/project-core.ts
   * callRouteAsHuman`), which runs the route with this bearer AND
   * `X-Active-Tenant: <tenantId>` so it resolves the workspace the session is
   * bound to and re-applies the browser's own switch gate.
   *
   * ⛔ Deliberately NOT `endUserToken`. That field is forwarded to
   * worker_management, whose LICENCE branch REFUSES (403
   * `END_USER_TENANT_MISMATCH`) a token that does not prove the tenant — and a
   * switched super-admin's token names their HOME tenant. Putting it there
   * would break every switched Copilot turn's LLM call.
   *
   * Set ONLY by `buildRequestContext` (an ACCEPTED `X-Active-Tenant` switch, a
   * verified human token with the signed `super_admin` role, not the support
   * switch) and `routes/agent.ts` (`verifyForwardedSwitchEndUserToken`: same
   * user as the agent session, signed `super_admin`, a switch target, and
   * Keycloak's live `userMaySuperAdminSwitchInto`). Valid only while
   * `tenantId` equals the frame's tenant — a re-pinned frame must not use it.
   *
   * ⛔ A CREDENTIAL. Never log it, never persist it, never forward it upstream.
   */
  superAdminSwitchToken?: { token: string; tenantId: string };
  /**
   * `'licence'` when the bearer is a licence token verified by the licences
   * service (`lib/licence-introspect.ts`, `buildRequestContext`). For such a
   * frame `tenantId` is the introspected `tenant_id` and NO header
   * (`X-Tenant-Id`, `X-Active-Tenant`, `X-Subject-Id`) displaced it, and
   * `subjectId` is the licences `Subject.id` (fr#1052). Absent otherwise.
   */
  authKind?: 'licence';
  /**
   * TRUE when the VERIFIED Keycloak bearer is the dedicated conveyor priority
   * identity (`lib/conveyor-identity.ts isConveyorActor` over the signed `azp`,
   * `preferred_username` and realm roles), set only by `buildRequestContext`.
   * `validateAuth` holds that identity to `assertConveyorRouteAllowed`; the
   * capability rules read this to decide the same (capabilities/rbac-rules.ts
   * `principalDoorAdmits`). Absent otherwise.
   */
  conveyorActor?: true;
  /** Licence frames only: the licences `Subject.id` (introspected `subject_id`). */
  licenceSubjectId?: string;
  /** Licence frames only: the introspected `license_id`. */
  licenseId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Strict accessor matching spec §E-3 frozen signature.
 * Throws if called outside an active `withRequestContext` frame.
 *
 * Call sites that legitimately run both inside and outside a request frame
 * (e.g. telemetry emitted from startup / cron / background tasks) should
 * use `tryGetRequestContext()` instead.
 */
export function getRequestContext(): RequestContext {
  const ctx = requestContext.getStore();
  if (ctx === undefined) {
    throw new Error(
      'getRequestContext called outside of withRequestContext',
    );
  }
  return ctx;
}

/**
 * Soft accessor — returns undefined when no ALS frame is active.
 * Use this from code paths that must tolerate a missing request context
 * (startup, cron, background refresh, best-effort telemetry).
 */
export function tryGetRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

/**
 * Publish an identity resolved by the HANDLER onto the live request context,
 * for routes whose credential is NOT on `Authorization`.
 *
 * Caller: `/api/agui/session/refresh`. Its credential is `refreshToken` in the
 * request BODY, so `buildRequestContext` has no bearer token to verify — and it
 * runs before the body is read anyway (`req.json()` consumes the stream, so it
 * cannot peek). The identity only becomes known once `refreshAgentSession` has
 * matched the token hash against an `agent_sessions` row. `withUsageSpans` reads
 * `tryGetRequestContext()` AFTER the handler returns, so an identity published
 * late is still visible to the metering span.
 *
 * Measured on prod after PR #931 (live 2026-09-03T12:09:08Z), which fixed the
 * bearer-layer routes: `/api/agui/threads` 0 of 8 events nil-tenant, while
 * `/api/agui/session/refresh` stayed at 4 of 4 nil-tenant. Not a missed line —
 * a structurally different case.
 *
 * SECOND CALLER — the n8n webhook receivers (`routes/webhooks.ts`). Their
 * credential is the `X-Webhook-Secret` shared secret, so there is no bearer
 * token and `buildRequestContext` leaves `tenantId` undefined for the whole
 * request. Measured in `billing_metering_events` on worker4 over 3h on
 * 2026-09-04: 335 `POST /api/webhooks/n8n/router-dedupe`, 48 card-approval and
 * 1 execution-event rows, ALL `source_ip=fr-backend` with an EMPTY tenant —
 * ≈2,733/day landing on billing's nil tenant
 * (`00000000-0000-0000-0000-000000000000`) rather than being rejected. The
 * tenant is not unknowable there: two of those three handlers already resolve
 * and REQUIRE a real tenant to do their work, and the third can resolve one
 * from its Planka scope id. Publishing it here is what makes the resolved
 * value reach the span.
 *
 * `userId` is OPTIONAL for exactly that caller: a webhook has a tenant but no
 * end user. A tenant-only call publishes the tenant and leaves `userId`
 * untouched — it does not invent a user.
 *
 * FILL-IF-EMPTY ONLY. If `tenantId` / `userId` is already set it is left alone:
 * an identity derived from a verified bearer token must never be silently
 * replaced by one derived from a body credential.
 *
 * ⚠️ Deliberately does NOT set `jwtTenantId`, `activeTenantSource`,
 * `activeTenantVia` or `bearerToken`. There is no verified JWT here.
 * `jwtTenantId` is what a header override is compared AGAINST,
 * `activeTenantSource` records that an override won and `activeTenantVia`
 * records WHICH header won; writing any of them from a body credential would
 * corrupt the tenant-divergence detection `routes/assets/kag-reviews.ts` and
 * the orchestrator-decide refusal in `routes/approvals.ts` depend on.
 *
 * No-op when no ALS frame is active.
 */
export function attributeRequestTo(identity: {
  userId?: string;
  tenantId: string | null;
}): void {
  const ctx = requestContext.getStore();
  if (ctx === undefined) return;
  if (ctx.userId === undefined && identity.userId) {
    ctx.userId = identity.userId;
  }
  if (ctx.tenantId === undefined && identity.tenantId) {
    ctx.tenantId = identity.tenantId;
  }
}

export function getBearerToken(): string | undefined {
  return requestContext.getStore()?.bearerToken;
}

/** See `RequestContext.endUserToken`. A credential — never log the value. */
export function getEndUserToken(): string | undefined {
  return requestContext.getStore()?.endUserToken;
}

/**
 * See `RequestContext.superAdminSwitchToken`. Returned ONLY while its tenant is
 * still the frame's tenant (a re-pinned frame gets nothing). A credential —
 * never log the value.
 */
export function getSuperAdminSwitchToken(): { token: string; tenantId: string } | undefined {
  const ctx = requestContext.getStore();
  const s = ctx?.superAdminSwitchToken;
  if (!s || !s.token || !s.tenantId || s.tenantId !== ctx?.tenantId) return undefined;
  return s;
}

export function getTenantId(): string | undefined {
  return requestContext.getStore()?.tenantId;
}

export function getUserId(): string | undefined {
  return requestContext.getStore()?.userId;
}

/** See `RequestContext.tenantIsServiceAccountSubject`. */
export function getTenantIsServiceAccountSubject(): boolean {
  return requestContext.getStore()?.tenantIsServiceAccountSubject === true;
}

export function getSubjectId(): string | undefined {
  return requestContext.getStore()?.subjectId;
}

export function getProjectId(): string | undefined {
  return requestContext.getStore()?.projectId;
}

/**
 * Publish a GUARD-VALIDATED project id onto the live request context. Callers
 * must pass a value `lib/project-owner-guard.ts guardProjectId()` already
 * decided may ride the wire — this function performs no validation itself.
 *
 * FILL-IF-EMPTY, mirroring `attributeRequestTo`: the first resolver in a
 * request wins, so a later unrelated project lookup in the same handler
 * cannot silently retarget outbound billing attribution mid-request. No-op
 * when no ALS frame is active or `projectId` is falsy.
 */
export function setProjectId(projectId: string | undefined): void {
  const ctx = requestContext.getStore();
  if (ctx === undefined || !projectId) return;
  if (ctx.projectId === undefined) ctx.projectId = projectId;
}

export function getCorrelationId(): string | undefined {
  return requestContext.getStore()?.correlationId;
}

/**
 * FR coding-analysis-run id for the current request, if the route was
 * invoked with `X-Coding-Job-Id` (or a body field surfaced into ALS by the
 * handler). Mirrors `getTenantId` / `getCorrelationId` — returns undefined
 * when no ALS frame is active or no job id was supplied.
 */
export function getCodingJobId(): string | undefined {
  return requestContext.getStore()?.coding?.jobId;
}

export function getInitiator(): Initiator | undefined {
  return requestContext.getStore()?.initiator;
}

export function getChannel(): string | undefined {
  return requestContext.getStore()?.channel;
}

/**
 * Runs `fn` with `ctx` bound in AsyncLocalStorage. Spec §E-3 frozen signature.
 */
export function withRequestContext<T>(
  ctx: RequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return Promise.resolve(requestContext.run(ctx, fn));
}

export function extractBearerToken(req: Request): string | undefined {
  const h = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!h) return undefined;
  return h.startsWith('Bearer ') ? h.slice(7) : undefined;
}
