// src/services/signup/core.ts — approve, reject, the provisioning steps and the retry tick.
//
// Port of the commonpractice early-access v2 approve/reject core (routes/onboarding.ts
// approveApprovalRow / rejectApprovalRow, services/tenant-provisioning.ts, services/signup-reject-repair.ts)
// onto fr's own provisioning path: the SAME building blocks POST /api/admin/super-admin/provision-user
// uses (the provisioning engine, ensureWorkspace + the workspace-admin grant, the manual token budget,
// the PM catalogue import), plus the `conveyor` bundle (licenses migration 059) and the one email.
// Defaults only: a new tenant with the suggested name; no plan choice.
//
// THE STEPS, in order. Every outcome is recorded on the row (`steps`), never inferred:
//
//   identity        fr mints the requester's realm identity (no credential; stamped
//                   `fr_signup_id = [row id]`; see identity.ts). An address whose realm identity
//                   does not carry THIS row's id is REFUSED (`identity_exists`), never adopted.
//                   Re-read after create/adopt: a realm that dropped the attribute (undeclared in
//                   its user profile) fails here (`identity_attr_dropped`), before any tenant.
//   provision       fr FOUNDS the licences tenant itself first (POST /tenants, name = external_ref =
//                   the reserved slug, owner fr): 201 = founded by this signup → `tenant_id` recorded
//                   on the row; 200 = a tenant fr already keyed on that slug — accepted only when it
//                   is the one recorded here, otherwise it is someone else's and the slug is dropped.
//                   Then the provisioning engine (which keys its tenant on the same (owner fr,
//                   external_ref = slug), so it lands in the tenant fr founded) mints a licence per
//                   FR_SIGNUP_APPS. The step is ok ONLY when the engine answered the recorded tenant,
//                   every FR_SIGNUP_APPS key is licensed and `partial_failures` is empty; then fr
//                   stamps `tenant_id` / `tenant_slug` on the identity (the engine only stamps users
//                   it creates itself).
//   workspace       fr's workspace row + the requester's `workspace-admin` grant (+ realm write-through).
//   budget          the manual monthly token budget, idempotent (provision-user's rule).
//   catalogue       the tenant's PM catalogue (requirements_management import-defaults).
//   bundle          `conveyor` ensured on the tenant (licences owner-scoped ensure, fr = ensurer).
//   invite_email    the ONE email: `locale` + `signup_app=fr` on the identity, then Keycloak
//                   execute-actions-email (UPDATE_PASSWORD, VERIFY_EMAIL; client fr-frontend;
//                   redirect = FR_PUBLIC_URL/). It runs ONLY once every other step is ok/skipped:
//                   the person must land in a ready, licensed workspace.
//
// identity + provision run under the APPROVE CLAIM and fail the approve (the row stays pending and
// the next approve resumes into the same identity / slug / tenant). The later steps are recorded
// and retried: approve, the 5-minute tick and the super_admin Retry all take the row's STEPS LEASE
// before running any of them, so the email can never be sent twice in parallel.
//
// The nine CommonPractice lessons, and where each lives here:
//   1. RLS read in tenant context — n/a: fr has no row-level-security tables.
//   2. per-claim token from the claim's RETURNING row, heartbeat, token-scoped release/final write
//      — `claimApproval` / `HeldApprovalClaim` / `decide`.
//   3. "founded by approval X" written with the tenant — the slug is RESERVED on this row, fr founds
//      the tenant itself and records its id only on a 201, and every later step (and reject) works
//      from that recorded id: a resume that finds the slug's tenant founded by anybody else stops.
//   4. licence + email under the same lease as the tick — `runTenantSteps` (steps lease).
//   5. never rotate the link on resend; land at the app root — one email, redirect FR_PUBLIC_URL/,
//      never re-sent once `ok`.
//   6-9 (Keycloak SPI, chat-bridge secret, `exp`, intake `locale`) — keycloak / chat-bridge / here:
//      service-token.ts requires `exp`; the intake accepts `locale`.
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';

import { db, signupApprovals } from '../../db/client';
import { AppError } from '../../utils/errors';
import { isIntegrationError } from '../../integrations/_lib/errors';
import { importPmCatalogueDefaults } from '../../integrations/pm-catalogue';
import { invalidateTenantCatalogue } from '../catalogue/tenant-catalogue';
import { adminListTenants, licencesRefusalCode, licensesClient, LicensesUpstreamError } from '../licenses';
import { createBudget, getBudgetStatus } from '../metering-admin';
import {
  deprovisionUser as deprovisionUserUpstream,
  grantLicense as grantLicenseUpstream,
  licenseRevokeIdempotencyKey,
  provisionUser as provisionUserUpstream,
  revokeLicenseById as revokeLicenseByIdUpstream,
  type ProvDeprovisionResult,
  type ProvGrantResult,
  type ProvProvisionResult,
} from '../provisioning';
import { isFrPersonApp } from '../../lib/fr-issuable-apps';
import { FR_APP_KEY } from '../../lib/fr-app-key';
import { invalidateFrLicenseCache } from '../../lib/require-fr-license';
import { syncTenantAdminGrant } from '../tenant-admin-sync';
import { userRolesService } from '../user-roles';
import { ensureWorkspace } from '../workspaces';
import {
  DEFAULT_SIGNUP_LOCALE,
  normaliseSignupLocale,
  SIGNUP_APP_KEY,
  signupProvisioningConfig,
  signupPublicUrl,
} from './config';
import { identityBelongsTo, KeycloakSignupError, keycloakIdentityOps, SIGNUP_ID_ATTRIBUTE, type IdentityOps } from './identity';
import { defaultTenantName, slugCandidates, slugify } from './naming';
import { notifySignupDecision } from './telegram';

export type SignupRow = typeof signupApprovals.$inferSelect;

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/** A refusal of the signup core: HTTP status + a stable code (`code`) + extra body fields (`details`). */
export class SignupError extends AppError {
  declare code: string;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(status, message, extra);
    this.name = 'SignupError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

const PRE_TENANT_STEPS = ['identity', 'provision'] as const;
const TENANT_STEPS = ['workspace', 'budget', 'catalogue', 'bundle', 'invite_email'] as const;
const ALL_STEPS = [...PRE_TENANT_STEPS, ...TENANT_STEPS] as const;
type StepName = (typeof ALL_STEPS)[number];

interface StepRecord {
  /** `unknown`: the effect may or may not have happened (the email send timed out) — operator Retry only. */
  status: 'ok' | 'skipped' | 'failed' | 'waiting' | 'unknown';
  at: string;
  code?: string | null;
  error?: string | null;
  detail?: Record<string, unknown>;
}

export function stepsOf(row: Pick<SignupRow, 'steps'>): Partial<Record<StepName, StepRecord>> {
  return (row.steps ?? {}) as Partial<Record<StepName, StepRecord>>;
}

const done = (r: StepRecord | undefined) => r?.status === 'ok' || r?.status === 'skipped';

/** Every step ok/skipped (the email included). */
function stepsComplete(row: Pick<SignupRow, 'steps'>): boolean {
  const s = stepsOf(row);
  return ALL_STEPS.every((k) => done(s[k]));
}

/** Steps that did not finish ok/skipped (for the Telegram follow-up and the screen). */
export function stepsNotOk(row: Pick<SignupRow, 'steps'>): Array<{ step: string; status: string; code: string | null }> {
  const s = stepsOf(row);
  return ALL_STEPS.filter((k) => !done(s[k])).map((k) => ({ step: k, status: s[k]?.status ?? 'pending', code: s[k]?.code ?? null }));
}

/**
 * The email's send is UNCERTAIN (it timed out, Keycloak may have sent it): only the super_admin
 * Retry re-sends it, so the tick stops scheduling the row.
 */
function awaitingOperator(row: Pick<SignupRow, 'steps'>): boolean {
  return stepsOf(row).invite_email?.status === 'unknown';
}

export function emailState(row: Pick<SignupRow, 'steps'>): 'sent' | 'waiting' {
  return stepsOf(row).invite_email?.status === 'ok' ? 'sent' : 'waiting';
}

export function errText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 500 ? `${m.slice(0, 499)}…` : m;
}

export function errCode(err: unknown, fallback: string): string {
  if (err instanceof SignupError) return err.code;
  if (isIntegrationError(err)) {
    const refusal = licencesRefusalCode(err.upstreamBody);
    return refusal ?? `${fallback}_${err.upstreamStatus ?? 'unreachable'}`;
  }
  if (err instanceof LicensesUpstreamError) return licencesRefusalCode(err.upstreamBody) ?? `${fallback}_${err.upstreamStatus}`;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? `${fallback}_${status}` : fallback;
}

// ---------------------------------------------------------------------------
// deps
// ---------------------------------------------------------------------------

interface SignupDeps {
  identity: IdentityOps;
  /**
   * licences `POST /tenants {name, external_ref}` under fr's owner (the same owner the engine's
   * provisioning-backend client maps to). `created` = 201 (founded now) vs 200 (fr already keyed a
   * live tenant on that external_ref). A live fr tenant of that NAME with another external_ref = 409.
   */
  ensureTenant(input: { name: string; externalRef: string }): Promise<{ created: boolean; tenantId: string }>;
  /**
   * provisioning `POST /api/provision` with the identity THIS approval minted in fr's realm
   * (`keycloakUserId`, caller-owned): the engine creates no user and sends no email.
   */
  provision(input: { email: string; name: string; tenantSlug: string; appKeys: string[]; keycloakUserId: string }): Promise<ProvProvisionResult>;
  deprovision(input: { email: string; tenantSlug: string; reason: string }): Promise<ProvDeprovisionResult | 'no_run'>;
  /** Every licences tenant name (archived and service actors included) — the slug collision check. */
  licencesTenantNames(): Promise<string[]>;
  ensureBundle(tenantId: string, bundle: string, plans: string[]): Promise<Record<string, unknown>>;
  /** Archive the licences tenant (refuses every licence at introspect). */
  archiveTenant(tenantId: string): Promise<'archived' | 'not_found'>;
  ensureWorkspace(tenantId: string, name: string): Promise<void>;
  grantWorkspaceAdmin(userId: string, tenantId: string, actorId: string): Promise<string>;
  revokeWorkspaceAdmin(userId: string, tenantId: string): Promise<void>;
  /** The manual monthly token budget's id (an existing manual one is reused). */
  ensureBudget(tenantId: string, tokens: number): Promise<string | null>;
  importCatalogue(tenantId: string): Promise<void>;
  /** What would make offboarding the founded tenant destructive: other members, projects. */
  workspaceBlockers(tenantId: string, requesterSub: string | null): Promise<string[]>;
  /** licences `GET /licenses/active?tenant_id=&app_key=` (the fr gate's own check, uncached). */
  hasActiveLicense(tenantId: string, appKey: string): Promise<boolean>;
  /**
   * provisioning `POST /api/licenses/grant` — the engine's add-a-licence op: the SAME
   * mint-or-reuse + quota primitive (`ensure_license_with_quota`) a provision runs per app key.
   */
  grantLicence(input: { tenantId: string; subjectId: string; appKey: string }): Promise<ProvGrantResult>;
  /** Drop fr's cached gate answer for the tenant (require-fr-license.ts). */
  invalidateFrLicence(tenantId: string): Promise<void>;
  // ---- the early-access removal (removal.ts) ----
  /** licences `GET /licenses` scoped to the tenant (X-Tenant-Id): every licence, any subject / app. */
  listTenantLicences(tenantId: string): Promise<TenantLicence[]>;
  /** provisioning `POST /api/licenses/revoke` by licence id (+ its billing quota), deterministic key. */
  revokeLicence(tenantId: string, licenseId: string, reason: string): Promise<void>;
  /** Stamp the fr workspace row archived. */
  archiveWorkspace(tenantId: string): Promise<'archived' | 'already_archived' | 'absent'>;
  /** Every fr role grant (`user_roles`) the user holds in the tenant; returns how many were removed. */
  removeTenantGrants(userId: string, tenantId: string): Promise<number>;
  /** How many fr role grants in the tenant belong to someone OTHER than `userId`. */
  otherMemberGrants(tenantId: string, userId: string | null): Promise<number>;
}

/** One licence as `GET /licenses` lists it (the fields the removal reads). */
interface TenantLicence {
  id: string;
  tenant_id: string;
  subject_id: string;
  status: string;
  revoked_at: string | null;
  /** The app key when the listing carries it, else the app id (a label only). */
  app_key: string | null;
  /** A shared DEPENDENCY licence (licences migration 059): released with the last licence needing it. */
  is_dependency: boolean;
}

const defaultDeps = (): SignupDeps => ({
  identity: keycloakIdentityOps,
  ensureTenant: async ({ name, externalRef }) => {
    const { status, body } = await licensesClient._adminRequestWithStatus<{ id?: unknown }>('/tenants', {
      method: 'POST',
      body: JSON.stringify({ name, external_ref: externalRef }),
    });
    if (typeof body.id !== 'string' || !body.id) throw new Error(`licences POST /tenants ${status} without a tenant id`);
    return { created: status === 201, tenantId: body.id };
  },
  // ⭐ keycloakUserId: realm per app (2026-10-23). Without it the engine created the address in
  // ITS realm (portal) — a second user, mailed a generic welcome — and the approve failed
  // `identity_mismatch`. With it the engine touches no Keycloak user and sends nothing.
  provision: ({ email, name, tenantSlug, appKeys, keycloakUserId }) =>
    provisionUserUpstream({ email, name, tenantSlug, appKeys, sendPasswordResetEmail: false, keycloakUserId }),
  deprovision: async ({ email, tenantSlug, reason }) => {
    try {
      return await deprovisionUserUpstream({ email, tenantSlug, reason });
    } catch (err) {
      if (isIntegrationError(err) && err.code === 'UPSTREAM_NOT_FOUND') return 'no_run';
      throw err;
    }
  },
  licencesTenantNames: async () => (await adminListTenants(true, true)).map((t) => t.name),
  ensureBundle: async (tenantId, bundle, plans) => {
    const path = `/internal/tenants/${encodeURIComponent(tenantId)}/bundles/${encodeURIComponent(bundle)}/ensure`;
    const body = JSON.stringify({ plans, dry_run: false });
    try {
      return await licensesClient._adminRequest<Record<string, unknown>>(path, { method: 'POST', body });
    } catch (err) {
      // A concurrent adopt won the compare-and-set and wrote nothing for that app: one retry sees
      // the winner as `exists` (provisioning tenant_inference.py, same rule).
      const refused = err instanceof LicensesUpstreamError ? (err.upstreamBody as { refused?: Array<{ reason?: string }> })?.refused : undefined;
      if (Array.isArray(refused) && refused.length > 0 && refused.every((r) => r?.reason === 'lost_race')) {
        return await licensesClient._adminRequest<Record<string, unknown>>(path, { method: 'POST', body });
      }
      throw err;
    }
  },
  archiveTenant: async (tenantId) => {
    try {
      await licensesClient._adminRequest(`/tenants/${encodeURIComponent(tenantId)}/archive`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: true }),
      });
      return 'archived';
    } catch (err) {
      if (err instanceof LicensesUpstreamError && err.upstreamStatus === 404) return 'not_found';
      throw err;
    }
  },
  ensureWorkspace: async (tenantId, name) => {
    await ensureWorkspace(tenantId, name);
  },
  grantWorkspaceAdmin: async (userId, tenantId, actorId) => {
    await userRolesService.grantRole(userId, tenantId, 'workspace-admin', actorId);
    return await syncTenantAdminGrant(userId, tenantId, actorId);
  },
  revokeWorkspaceAdmin: (userId, tenantId) => userRolesService.revokeRole(userId, tenantId, 'workspace-admin'),
  ensureBudget: async (tenantId, tokens) => {
    const status = await getBudgetStatus(tenantId);
    const prior = status.budgets.find((b) => b.source === 'manual' && (b.period ?? 'monthly') === 'monthly');
    if (prior?.budget_id != null) return String(prior.budget_id);
    const created = await createBudget({ tenantId, budgetTokens: tokens, period: 'monthly', source: 'manual', priority: 50 });
    return created.id ?? null;
  },
  importCatalogue: async (tenantId) => {
    try {
      await importPmCatalogueDefaults(tenantId, undefined);
    } finally {
      invalidateTenantCatalogue(tenantId);
    }
  },
  workspaceBlockers: async (tenantId, requesterSub) => {
    const blockers: string[] = [];
    const members = (await db.execute(
      sql`SELECT count(*)::int AS n FROM user_roles
           WHERE tenant_id = ${tenantId}::uuid AND (${requesterSub}::text IS NULL OR user_id <> ${requesterSub}::text)`,
    )) as unknown as Array<{ n: number }>;
    if ((members[0]?.n ?? 0) > 0) blockers.push(`${members[0]!.n} other member role(s)`);
    const projects = (await db.execute(
      sql`SELECT count(*)::int AS n FROM projects WHERE project_data->>'keycloak_tenant_id' = ${tenantId}::text`,
    )) as unknown as Array<{ n: number }>;
    if ((projects[0]?.n ?? 0) > 0) blockers.push(`${projects[0]!.n} project(s)`);
    return blockers;
  },
  hasActiveLicense: (tenantId, appKey) => licensesClient.hasActiveLicense(tenantId, appKey),
  grantLicence: ({ tenantId, subjectId, appKey }) => grantLicenseUpstream({ tenantId, subjectId, appKey }),
  invalidateFrLicence: (tenantId) => invalidateFrLicenseCache(tenantId),
  listTenantLicences: async (tenantId) => {
    const rows = await licensesClient._adminRequest<Array<Record<string, unknown>>>('/licenses', {
      method: 'GET',
      headers: { 'X-Tenant-Id': tenantId },
    });
    if (!Array.isArray(rows)) throw new Error('licences GET /licenses did not answer a list');
    return rows.map((r) => ({
      id: String(r.id ?? ''),
      tenant_id: String(r.tenant_id ?? ''),
      subject_id: String(r.subject_id ?? ''),
      status: String(r.status ?? ''),
      revoked_at: typeof r.revoked_at === 'string' ? r.revoked_at : null,
      // `GET /licenses` (LicenseResponse) carries `app_id`, not the app object: the label falls back to it.
      app_key:
        typeof (r.app as { key?: unknown } | null)?.key === 'string'
          ? (r.app as { key: string }).key
          : typeof r.app_id === 'string'
            ? r.app_id
            : null,
      is_dependency: r.is_dependency === true,
    }));
  },
  revokeLicence: async (tenantId, licenseId, reason) => {
    // The deterministic key: a retried removal resumes a partially-failed revoke run.
    const res = await revokeLicenseByIdUpstream({ tenantId, licenseId, reason, idempotencyKey: licenseRevokeIdempotencyKey(licenseId) });
    if (res.tenant_id && res.tenant_id !== tenantId) {
      throw new Error(`provisioning revoked licence ${licenseId} in tenant ${res.tenant_id}, not ${tenantId}`);
    }
  },
  archiveWorkspace: async (tenantId) => {
    const updated = (await db.execute(
      sql`UPDATE workspaces SET archived_at = now() WHERE id = ${tenantId}::uuid AND archived_at IS NULL RETURNING id`,
    )) as unknown as Array<{ id: string }>;
    if (updated.length > 0) return 'archived';
    const existing = (await db.execute(sql`SELECT 1 AS one FROM workspaces WHERE id = ${tenantId}::uuid`)) as unknown as unknown[];
    return existing.length > 0 ? 'already_archived' : 'absent';
  },
  removeTenantGrants: async (userId, tenantId) => {
    const removed = (await db.execute(
      sql`DELETE FROM user_roles WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::text RETURNING id`,
    )) as unknown as unknown[];
    return removed.length;
  },
  otherMemberGrants: async (tenantId, userId) => {
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM user_roles
           WHERE tenant_id = ${tenantId}::uuid AND (${userId}::text IS NULL OR user_id <> ${userId}::text)`,
    )) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  },
});

const deps: SignupDeps = defaultDeps();
/** The live deps (shared with removal.ts). */
export function signupDeps(): SignupDeps {
  return deps;
}

// ---------------------------------------------------------------------------
// row helpers
// ---------------------------------------------------------------------------

export async function loadSignup(id: string): Promise<SignupRow | null> {
  const [row] = await db.select().from(signupApprovals).where(eq(signupApprovals.id, id)).limit(1);
  return row ?? null;
}

export async function mustLoad(id: string): Promise<SignupRow> {
  const row = await loadSignup(id);
  if (!row) throw new SignupError(404, 'approval_not_found', `No signup approval '${id}'`);
  return row;
}

const stepJson = (step: StepName, rec: StepRecord) =>
  sql`${signupApprovals.steps} || jsonb_build_object(${step}::text, ${JSON.stringify(rec)}::jsonb)`;

/** Record a step outcome. Unconditional on purpose: the effect exists whatever claim/lease state. */
async function recordStep(id: string, step: StepName, rec: Omit<StepRecord, 'at'>): Promise<void> {
  await db
    .update(signupApprovals)
    .set({ steps: stepJson(step, { ...rec, at: new Date().toISOString() }) })
    .where(eq(signupApprovals.id, id));
}

export async function pendingSignupCount(): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM signup_approvals WHERE status = 'pending'`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

export async function listSignups(filter: string | null): Promise<SignupRow[]> {
  const where =
    filter === 'needs_attention'
      ? sql`(${signupApprovals.status} = 'approved' AND NOT (${signupApprovals.steps} @> '{"invite_email":{"status":"ok"}}'::jsonb))
             OR (${signupApprovals.status} = 'rejected' AND ${signupApprovals.reject_repair}->>'state' IN ('pending','failed','blocked'))
             OR (${signupApprovals.status} = 'removed' AND ${signupApprovals.removal}->>'state' IN ('pending','failed','blocked'))`
      : filter
        ? eq(signupApprovals.status, filter as SignupRow['status'])
        : sql`true`;
  return db.select().from(signupApprovals).where(where).orderBy(desc(signupApprovals.created_at)).limit(500);
}

// ---------------------------------------------------------------------------
// actors
// ---------------------------------------------------------------------------

export type SignupActor =
  | { kind: 'super_admin'; userId: string }
  | { kind: 'telegram'; telegramUserId: number; azp: string; subject: string };

const actorId = (a: SignupActor) => (a.kind === 'super_admin' ? a.userId : a.subject);
const actorLabel = (a: SignupActor) => (a.kind === 'super_admin' ? 'fr onboarding screen' : `Telegram (user ${a.telegramUserId})`);
export const actorAudit = (a: SignupActor) => (a.kind === 'super_admin' ? a.userId : `telegram:${a.telegramUserId}`);

// ---------------------------------------------------------------------------
// the approve claim (one approver at a time, across replicas)
// ---------------------------------------------------------------------------

interface ClaimTiming {
  claimMs: number;
  heartbeatMs: number;
  ceilingMs: number;
}
const claimTiming: ClaimTiming = { claimMs: 5 * 60_000, heartbeatMs: 60_000, ceilingMs: 30 * 60_000 };

/**
 * Take the claim on a PENDING row in one conditional UPDATE with a fresh token; the RETURNING row
 * is what the approve works from. 409 `approval_in_progress` while another live claim holds it,
 * 400 `approval_not_pending` once decided, 404 when unknown.
 */
async function claimApproval(id: string): Promise<{ row: SignupRow; token: string }> {
  const token = randomUUID();
  const [row] = await db
    .update(signupApprovals)
    .set({
      approving_until: sql`now() + make_interval(secs => ${claimTiming.claimMs / 1000})`,
      approving_claim: token,
    })
    .where(
      and(
        eq(signupApprovals.id, id),
        eq(signupApprovals.status, 'pending'),
        sql`(${signupApprovals.approving_until} IS NULL OR ${signupApprovals.approving_until} <= now())`,
      ),
    )
    .returning();
  if (row) return { row, token };
  const now = await mustLoad(id);
  if (now.status !== 'pending') throw new SignupError(400, 'approval_not_pending', `Approval is already ${now.status}`);
  throw new SignupError(409, 'approval_in_progress', 'This signup is being approved right now; reload in a moment.');
}

/**
 * The approve run's claim, kept alive by a heartbeat and RE-CONFIRMED before every irreversible
 * step (`assertHeld` extends it in one token-scoped conditional UPDATE that also requires
 * `pending` and `approving_until > now()`). Reject refuses while `approving_until` is in the
 * future, so no reject can land between the check and the step it guards. Lost claim / ceiling /
 * unconfirmed heartbeat ⇒ the run aborts with 409 `approval_claim_lost` before its next step.
 */
class HeldApprovalClaim {
  private abortReason: 'claim_lost' | 'ceiling_reached' | 'claim_unconfirmed' | null = null;
  private readonly startedAt = Date.now();
  private lastConfirmedAt = Date.now();
  private readonly beat: ReturnType<typeof setInterval>;

  constructor(
    readonly id: string,
    readonly token: string,
    private readonly timing: ClaimTiming,
  ) {
    this.beat = setInterval(() => void this.heartbeat(), timing.heartbeatMs);
  }

  stop(): void {
    clearInterval(this.beat);
  }

  private abort(reason: NonNullable<HeldApprovalClaim['abortReason']>): void {
    if (this.abortReason) return;
    this.abortReason = reason;
    this.stop();
    console.warn(`[signup] approve claim aborted id=${this.id} reason=${reason}`);
  }

  private pastCeiling(): boolean {
    return Date.now() - this.startedAt >= this.timing.ceilingMs;
  }

  private async renew(): Promise<boolean> {
    const rows = await db
      .update(signupApprovals)
      .set({ approving_until: sql`now() + make_interval(secs => ${this.timing.claimMs / 1000})` })
      .where(
        and(
          eq(signupApprovals.id, this.id),
          eq(signupApprovals.approving_claim, this.token),
          eq(signupApprovals.status, 'pending'),
          sql`${signupApprovals.approving_until} > now()`,
        ),
      )
      .returning({ id: signupApprovals.id });
    if (rows.length > 0) this.lastConfirmedAt = Date.now();
    return rows.length > 0;
  }

  private async heartbeat(): Promise<void> {
    if (this.abortReason) return;
    if (this.pastCeiling()) return this.abort('ceiling_reached');
    try {
      if (!(await this.renew())) this.abort('claim_lost');
    } catch (err) {
      console.warn(`[signup] approve claim heartbeat failed id=${this.id}: ${errText(err)}`);
      if (Date.now() - this.lastConfirmedAt >= this.timing.claimMs - this.timing.heartbeatMs) this.abort('claim_unconfirmed');
    }
  }

  async assertHeld(step: string): Promise<void> {
    if (!this.abortReason) {
      if (this.pastCeiling()) this.abort('ceiling_reached');
      else if (!(await this.renew())) this.abort('claim_lost');
    }
    if (this.abortReason) {
      throw new SignupError(
        409,
        'approval_claim_lost',
        `Approve stopped before '${step}' (${this.abortReason}): this run no longer holds the approval. Nothing further was done; approve again to resume.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// the steps lease (approve, tick and Retry share it)
// ---------------------------------------------------------------------------

const STEPS_LEASE_MS = 5 * 60_000;

async function takeStepsLease(id: string): Promise<string | null> {
  const token = randomUUID();
  const rows = await db
    .update(signupApprovals)
    .set({
      steps_lease_token: token,
      steps_lease_until: sql`now() + make_interval(secs => ${STEPS_LEASE_MS / 1000})`,
    })
    .where(
      and(
        eq(signupApprovals.id, id),
        sql`(${signupApprovals.steps_lease_until} IS NULL OR ${signupApprovals.steps_lease_until} <= now())`,
      ),
    )
    .returning({ id: signupApprovals.id });
  return rows.length > 0 ? token : null;
}

async function renewStepsLease(id: string, token: string): Promise<boolean> {
  const rows = await db
    .update(signupApprovals)
    .set({ steps_lease_until: sql`now() + make_interval(secs => ${STEPS_LEASE_MS / 1000})` })
    .where(and(eq(signupApprovals.id, id), eq(signupApprovals.steps_lease_token, token)))
    .returning({ id: signupApprovals.id });
  return rows.length > 0;
}

async function releaseStepsLease(id: string, token: string): Promise<void> {
  await db
    .update(signupApprovals)
    .set({ steps_lease_token: null, steps_lease_until: null })
    .where(and(eq(signupApprovals.id, id), eq(signupApprovals.steps_lease_token, token)))
    .catch((err) => console.warn(`[signup] steps lease release failed id=${id}: ${errText(err)}`));
}

/** A Postgres unique violation, through drizzle's DrizzleQueryError wrapper (`cause`). */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// slug reservation
// ---------------------------------------------------------------------------

/**
 * Reserve the tenant slug on the row BEFORE anything is created. A candidate is taken only when no
 * licences tenant (any owner, archived and service actors included) carries that name AND no other
 * signup row reserved it (partial UNIQUE index). Fails CLOSED: an unreadable licences registry
 * reserves nothing (the engine would otherwise provision INTO an existing tenant of that slug).
 */
async function reserveSlug(row: SignupRow, token: string, tenantName: string | undefined, exclude: string[] = []): Promise<SignupRow> {
  const name = (tenantName ?? row.tenant_name ?? defaultTenantName(row)).trim();
  let taken: Set<string>;
  try {
    taken = new Set((await deps.licencesTenantNames()).map((n) => n.toLowerCase()));
  } catch (err) {
    throw new SignupError(502, 'licences_unreadable', `The licences registry could not be read, so the workspace name could not be checked: ${errText(err)}`);
  }
  for (const slug of slugCandidates(slugify(name))) {
    if (taken.has(slug) || exclude.includes(slug)) continue;
    try {
      const [updated] = await db
        .update(signupApprovals)
        .set({ tenant_slug: slug, tenant_name: name })
        .where(and(eq(signupApprovals.id, row.id), eq(signupApprovals.approving_claim, token)))
        .returning();
      if (!updated) throw new SignupError(409, 'approval_claim_lost', 'The approve claim was lost before the workspace name was reserved.');
      return updated;
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
  throw new SignupError(409, 'tenant_name_unavailable', `No free workspace name for '${name}' (tried ${slugify(name)} … -10). Approve on the onboarding screen with another name.`);
}

// ---------------------------------------------------------------------------
// pre-tenant steps (under the approve claim; a failure fails the approve)
// ---------------------------------------------------------------------------

/** The identity CP-style: mint, or recognise the one an earlier attempt of THIS approval minted. */
async function runIdentityStep(row: SignupRow): Promise<SignupRow> {
  const ops = deps.identity;
  if (row.kc_user_id) {
    const existing = await ops.getUser(row.kc_user_id);
    if (existing) {
      if (!identityBelongsTo(existing, row.id)) {
        const msg = `the recorded login ${row.kc_user_id} does not carry ${SIGNUP_ID_ATTRIBUTE}=${row.id}; it is not this signup's to use`;
        await recordStep(row.id, 'identity', { status: 'failed', code: 'identity_not_owned', error: msg });
        throw new SignupError(409, 'identity_not_owned', msg);
      }
      await recordStep(row.id, 'identity', { status: 'ok', detail: { userId: row.kc_user_id, minted: row.identity_minted } });
      return mustLoad(row.id);
    }
    // Deleted out of band: forget it and mint again.
    await db.update(signupApprovals).set({ kc_user_id: null, identity_minted: false }).where(eq(signupApprovals.id, row.id));
  }
  const locale = normaliseSignupLocale(row.locale) ?? DEFAULT_SIGNUP_LOCALE;
  let userId: string;
  try {
    const created = await ops.createUser({ email: row.email, name: row.name, locale, signupId: row.id });
    if (created.created) {
      userId = created.id;
    } else {
      const found = await ops.findUserByEmail(row.email);
      if (!found) throw new SignupError(502, 'identity_lookup_failed', 'Keycloak reported the address taken but no user carries it.');
      // Adopted ONLY when an earlier attempt of THIS row minted it (a crash between create and
      // record): it carries this row's id, and still no credential / IdP link / federation.
      // Freshness alone proves nothing — the portal realm is shared with other apps' signups.
      const ours =
        identityBelongsTo(found, row.id) &&
        !found.federationLink &&
        found.emailVerified !== true &&
        (await ops.countCredentials(found.id)) === 0 &&
        (await ops.countIdentityLinks(found.id)) === 0;
      if (!ours) {
        throw new SignupError(
          409,
          'identity_exists',
          `${row.email} already has a Non-Agentic AI login, which the one-tap approval never adopts. Provision this person from Admin → Users instead, then reject this signup.`,
        );
      }
      userId = found.id;
    }
    // RE-READ before anything irreversible: a realm whose user profile does not declare
    // `fr_signup_id` drops it SILENTLY on create, and every later ownership check would then fail —
    // after the tenant was founded and licences minted. Refuse here instead.
    const stored = await ops.getUser(userId);
    if (!identityBelongsTo(stored, row.id)) {
      // A login this attempt just minted (201, no credential yet) is removed so the address is free
      // again; an adopted one is never deleted here.
      let deleted = false;
      if (created.created) {
        try {
          deleted = await ops.deleteUser(userId);
        } catch (delErr) {
          console.warn(`[signup] could not delete unowned minted login ${userId} id=${row.id}: ${errText(delErr)}`);
        }
      }
      throw new SignupError(
        502,
        'identity_attr_dropped',
        `Keycloak did not keep ${SIGNUP_ID_ATTRIBUTE}=${row.id} on login ${userId}: declare fr_signup_id in the portal user profile (admin view/edit). ` +
          `Nothing was provisioned; ${deleted ? 'the login was deleted' : `login ${userId} was NOT deleted (remove it in Keycloak)`}, then approve again.`,
        { userId, deleted },
      );
    }
  } catch (err) {
    await recordStep(row.id, 'identity', { status: 'failed', code: errCode(err, 'identity_failed'), error: errText(err) });
    throw err instanceof SignupError ? err : new SignupError(502, 'identity_failed', `Creating the login failed: ${errText(err)}`);
  }
  // Recorded UNCONDITIONALLY (the identity exists whatever happened to the claim); a reject that
  // somehow landed meanwhile gets its cleanup armed in the same statement.
  await db
    .update(signupApprovals)
    .set({
      kc_user_id: userId,
      identity_minted: true,
      reject_repair: armRepairIfRejected(),
    })
    .where(eq(signupApprovals.id, row.id));
  await recordStep(row.id, 'identity', { status: 'ok', detail: { userId, minted: true } });
  return mustLoad(row.id);
}

/** In-SQL: arm the reject cleanup when a reject landed meanwhile (and none is outstanding). */
const armRepairIfRejected = () => sql`CASE WHEN ${signupApprovals.status} = 'rejected'
                               AND (${signupApprovals.reject_repair} IS NULL OR ${signupApprovals.reject_repair}->>'state' IN ('done','resolved_manually'))
                          THEN ${JSON.stringify(initialRejectRepair())}::jsonb ELSE ${signupApprovals.reject_repair} END`;

const tenantAttemptJson = (slug: string, rec: { state: string; tenantId?: string }) =>
  sql`${signupApprovals.tenant_attempts} || jsonb_build_object(${slug}::text, ${JSON.stringify({ ...rec, at: new Date().toISOString() })}::jsonb)`;

/**
 * Record what this row did with a slug at licences. Not claim-conditioned (the effect exists whatever
 * the claim), but it NEVER DOWNGRADES: a stale approver whose claim lapsed while a newer one founded
 * the tenant must not overwrite that slug's `founded` entry with `attempted`/`suspected_orphan`, nor
 * record the row's own live tenant as an orphan/foreign one. Both read the LIVE row, in the WHERE.
 */
async function recordTenantAttempt(id: string, slug: string, rec: { state: string; tenantId?: string }): Promise<void> {
  await db
    .update(signupApprovals)
    .set({ tenant_attempts: tenantAttemptJson(slug, rec) })
    .where(
      and(
        eq(signupApprovals.id, id),
        sql`(${signupApprovals.tenant_attempts} -> ${slug}::text ->> 'state') IS DISTINCT FROM 'founded'`,
        rec.tenantId ? sql`${signupApprovals.tenant_id}::text IS DISTINCT FROM ${rec.tenantId}::text` : undefined,
      ),
    );
}

/** A provision-step refusal: recorded on the row, then thrown (the approve fails, the row stays pending). */
async function failProvision(id: string, status: number, code: string, message: string, detail?: Record<string, unknown>): Promise<never> {
  await recordStep(id, 'provision', { status: 'failed', code, error: message, ...(detail ? { detail } : {}) });
  throw new SignupError(status, code, message, detail ?? {});
}

/**
 * Found the licences tenant HERE, before the engine runs, so "founded by this signup" is a recorded
 * fact rather than an inference. licences keys a tenant on (owner, external_ref) and fr-backend and
 * the engine's provisioning-backend client share owner `fr`, so with external_ref = the slug the
 * engine's own `create_tenant(name=slug, external_ref=slug)` answers 200 with THIS tenant.
 *
 *   201 → founded now: `tenant_id` recorded on the row (the founded-by record reject relies on).
 *   200 → fr already keyed a live tenant on this slug: ours only when it is the recorded one;
 *         anybody else's → `tenant_slug_foreign` (the approve drops the slug, reserves the next).
 *   409 `tenant_name_taken` → a live fr tenant holds the NAME under another external_ref.
 *
 * A crash (or a lost answer) between the 201 and the UPDATE below leaves an empty fr tenant the next
 * attempt reads as foreign (it moves to the next slug): fail-closed, never a join. So that it is not
 * merely logged, every call is preceded by a `tenant_attempts[slug] = attempted` record on the row;
 * a later attempt that finds a tenant on a slug THIS row attempted and never recorded marks it
 * `suspected_orphan` with its id — for an operator, never for an automatic join.
 */
async function ensureOwnTenant(row: SignupRow): Promise<SignupRow> {
  const slug = row.tenant_slug!;
  const prior = ((row.tenant_attempts ?? {}) as Record<string, { state?: string }>)[slug]?.state;
  if (!row.tenant_id) await recordTenantAttempt(row.id, slug, { state: 'attempted' });
  let res: { created: boolean; tenantId: string };
  try {
    res = await deps.ensureTenant({ name: slug, externalRef: slug });
  } catch (err) {
    const code = errCode(err, 'tenant_create_failed');
    return failProvision(row.id, code === 'tenant_name_taken' ? 409 : 502, code, `Founding the workspace tenant '${slug}' failed: ${errText(err)}`);
  }
  if (row.tenant_id && res.tenantId !== row.tenant_id) {
    if (res.created) {
      console.warn(`[signup] tenant ${res.tenantId} founded for slug=${slug} id=${row.id} but the row records ${row.tenant_id}: orphan, not used`);
      await recordTenantAttempt(row.id, slug, { state: 'orphan', tenantId: res.tenantId });
    }
    return failProvision(row.id, 502, 'tenant_mismatch', `licences answered tenant ${res.tenantId} for '${slug}', not the tenant this signup founded (${row.tenant_id}); nothing further was done.`);
  }
  if (row.tenant_id) return row; // resume: the tenant this signup founded
  if (!res.created) {
    const suspected = prior === 'attempted' || prior === 'suspected_orphan';
    console.warn(
      `[signup] slug=${slug} id=${row.id}: licences already holds tenant ${res.tenantId} for it, not recorded as founded by this signup — not joining` +
        (suspected ? ' (an earlier attempt of THIS signup may have founded it: recorded as suspected_orphan)' : ''),
    );
    await recordTenantAttempt(row.id, slug, { state: suspected ? 'suspected_orphan' : 'foreign', tenantId: res.tenantId });
    return failProvision(row.id, 409, 'tenant_slug_foreign', `The workspace name '${slug}' already belongs to another tenant; this signup never joins it.`, {
      tenantId: res.tenantId,
      suspectedOrphan: suspected,
    });
  }
  await db
    .update(signupApprovals)
    .set({
      tenant_id: res.tenantId,
      tenant_attempts: tenantAttemptJson(slug, { state: 'founded', tenantId: res.tenantId }),
      reject_repair: armRepairIfRejected(),
    })
    .where(and(eq(signupApprovals.id, row.id), sql`${signupApprovals.tenant_id} IS NULL`));
  const updated = await mustLoad(row.id);
  if (updated.tenant_id !== res.tenantId) {
    return failProvision(row.id, 502, 'tenant_mismatch', `the row records tenant ${updated.tenant_id}, not ${res.tenantId}`);
  }
  return updated;
}

async function runProvisionStep(row: SignupRow): Promise<SignupRow> {
  const cfg = signupProvisioningConfig();
  if (!row.tenant_slug || !row.kc_user_id) throw new SignupError(500, 'internal', 'provision before slug/identity');
  row = await ensureOwnTenant(row);
  const tenantId = row.tenant_id!;
  const kcUserId = row.kc_user_id!;
  let prov: ProvProvisionResult;
  try {
    prov = await deps.provision({ email: row.email, name: row.name, tenantSlug: row.tenant_slug!, appKeys: cfg.apps, keycloakUserId: kcUserId });
  } catch (err) {
    return failProvision(row.id, 502, errCode(err, 'provision_failed'), `Provisioning failed: ${errText(err)}`);
  }
  if (prov.tenant_id !== tenantId) {
    return failProvision(
      row.id,
      502,
      'tenant_mismatch',
      `provisioning resolved tenant ${prov.tenant_id}, not the tenant this signup founded (${tenantId}); nothing further was done`,
    );
  }
  if (prov.keycloak_user_id !== kcUserId) {
    return failProvision(row.id, 502, 'identity_mismatch', `provisioning resolved user ${prov.keycloak_user_id}, not the identity this approval minted (${kcUserId})`);
  }
  const licenseIds: Record<string, string> = {};
  for (const g of prov.licenses ?? []) if (g?.license_id) licenseIds[g.app_key] = g.license_id;
  const missingLicences = cfg.apps.filter((k) => !licenseIds[k]);
  const partialFailures = prov.partial_failures ?? [];
  const detail = {
    tenantId: prov.tenant_id,
    licenseIds,
    provisioningStatus: prov.status,
    replayed: prov.replayed,
    partialFailures,
    missingLicences,
    warnings: prov.warnings,
  };
  if (missingLicences.length > 0 || partialFailures.length > 0) {
    return failProvision(
      row.id,
      502,
      'provision_incomplete',
      `Provisioning did not finish: ${[
        missingLicences.length ? `no licence for ${missingLicences.join(', ')}` : '',
        partialFailures.length ? `partial failures ${partialFailures.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; ')}`,
      detail,
    );
  }
  // The engine stamps tenant_id / tenant_slug only on a user IT creates; this identity was minted by
  // fr, so stamp them here — without them the person's JWT derives the tenant from `sub`. Only on the
  // identity this signup minted (re-read: never overwrite another app's user).
  try {
    await assertOwnIdentity(row);
    await deps.identity.updateAttributes(kcUserId, { tenant_id: tenantId, tenant_slug: row.tenant_slug });
  } catch (err) {
    const code = err instanceof SignupError ? err.code : 'tenant_attribute_failed';
    return failProvision(row.id, err instanceof SignupError ? err.statusCode : 502, code, `Stamping the tenant on the login failed: ${errText(err)}`);
  }
  await recordStep(row.id, 'provision', { status: 'ok', detail });
  return mustLoad(row.id);
}

/** Re-read the recorded identity and refuse unless it carries this row's `fr_signup_id`. */
async function assertOwnIdentity(row: SignupRow): Promise<void> {
  const user = row.kc_user_id ? await deps.identity.getUser(row.kc_user_id) : null;
  if (!identityBelongsTo(user, row.id)) {
    throw new SignupError(409, 'identity_not_owned', `login ${row.kc_user_id ?? '-'} is missing or does not carry ${SIGNUP_ID_ATTRIBUTE}=${row.id}`);
  }
}

// ---------------------------------------------------------------------------
// tenant steps (under the steps lease; recorded, retried by the tick)
// ---------------------------------------------------------------------------

async function runOneTenantStep(step: (typeof TENANT_STEPS)[number], row: SignupRow, actor: string): Promise<Omit<StepRecord, 'at'>> {
  const cfg = signupProvisioningConfig();
  const tenantId = row.tenant_id!;
  const userId = row.kc_user_id!;
  switch (step) {
    case 'workspace': {
      await deps.ensureWorkspace(tenantId, row.tenant_slug ?? row.tenant_name ?? tenantId);
      const sync = await deps.grantWorkspaceAdmin(userId, tenantId, actor);
      return { status: 'ok', detail: { keycloakSync: sync } };
    }
    case 'budget': {
      const budgetId = await deps.ensureBudget(tenantId, cfg.monthlyBudgetTokens);
      return { status: 'ok', detail: { budgetId, tokens: cfg.monthlyBudgetTokens } };
    }
    case 'catalogue':
      await deps.importCatalogue(tenantId);
      return { status: 'ok' };
    case 'bundle': {
      if (!cfg.bundle) return { status: 'skipped', code: 'no_bundle_configured' };
      const res = await deps.ensureBundle(tenantId, cfg.bundle, cfg.bundlePlans);
      const apps = (res.apps ?? {}) as Record<string, { decision?: string; license_id?: string }>;
      return {
        status: 'ok',
        detail: {
          bundle: cfg.bundle,
          apps: Object.fromEntries(Object.entries(apps).map(([k, v]) => [k, { decision: v?.decision, licenseId: v?.license_id }])),
        },
      };
    }
    case 'invite_email': {
      const publicUrl = signupPublicUrl();
      if (!publicUrl) throw new SignupError(503, 'public_url_unset', 'FR_PUBLIC_URL is not set: the email would have nowhere to land.');
      const locale = normaliseSignupLocale(row.locale) ?? DEFAULT_SIGNUP_LOCALE;
      // Never write to, or mail, a login this signup did not mint.
      await assertOwnIdentity(row);
      let attributes = true;
      try {
        await deps.identity.updateAttributes(userId, { locale, signup_app: SIGNUP_APP_KEY });
      } catch (err) {
        // Not fatal: Keycloak then sends its generic set-password email in the realm language.
        attributes = false;
        console.warn(`[signup] email attributes failed id=${row.id}: ${errText(err)}`);
      }
      // The identity was minted DISABLED (no sign-in, no mail on a failed approve); everything
      // before this step landed, so enable it now — Keycloak refuses execute-actions-email to a
      // disabled user. A failed enable fails the step: no email.
      await deps.identity.enableUser(userId);
      // ⛔ THE APP ROOT: the person is seated and licensed already, nothing is left to accept, and a
      // link carrying no per-send token is never invalidated by anything fr does later.
      try {
        await deps.identity.executeActionsEmail(userId, ['UPDATE_PASSWORD', 'VERIFY_EMAIL'], {
          clientId: cfg.frontendClientId,
          redirectUri: `${publicUrl}/`,
          lifespanSeconds: cfg.emailLifespanSeconds,
        });
      } catch (err) {
        // A send that TIMED OUT (or a gateway timeout) may well have gone out: recorded `unknown`,
        // which the tick never re-sends — the super_admin Retry decides. A definite refusal stays
        // `failed` and is retried as usual.
        if (err instanceof KeycloakSignupError && (err.timedOut || err.status === 504)) {
          return { status: 'unknown', code: 'sent_uncertain', error: errText(err), detail: { locale, attributes, clientId: cfg.frontendClientId } };
        }
        throw err;
      }
      return { status: 'ok', detail: { locale, attributes, clientId: cfg.frontendClientId } };
    }
  }
}

interface TenantStepsResult {
  ran: boolean;
  reason?: 'lease_busy' | 'no_tenant' | 'tenant_unverified';
  row: SignupRow;
}

/**
 * Run every tenant step that has not landed, under the steps lease, in order. A step failure is
 * recorded and the run moves on (the email then waits); `beforeStep` (approve: the claim check) may
 * throw to abort. The email runs only when every other step is ok/skipped and never once it is ok.
 */
async function runTenantSteps(
  id: string,
  opts: { actorId: string; beforeStep?: (step: string) => Promise<void>; manual?: boolean },
): Promise<TenantStepsResult> {
  const first = await mustLoad(id);
  if (!first.tenant_id || !first.kc_user_id) return { ran: false, reason: 'no_tenant', row: first };
  // ⛔ Only past a provision that answered the tenant THIS signup founded: the workspace-admin grant,
  // the budget, the catalogue, the bundle and the email all key on `tenant_id`.
  const prov = stepsOf(first).provision;
  if (prov?.status !== 'ok' || prov.detail?.tenantId !== first.tenant_id) {
    console.warn(`[signup] tenant steps refused id=${id}: provision ${prov?.status ?? 'absent'} for ${String(prov?.detail?.tenantId ?? '-')}, row tenant ${first.tenant_id}`);
    return { ran: false, reason: 'tenant_unverified', row: first };
  }
  const lease = await takeStepsLease(id);
  if (!lease) return { ran: false, reason: 'lease_busy', row: first };
  try {
    for (const step of TENANT_STEPS) {
      const row = await mustLoad(id);
      // The decision gate: nothing more for a rejected signup, nor for one a super_admin removed.
      if (row.status === 'rejected' || row.status === 'removed') break;
      const s = stepsOf(row);
      if (done(s[step])) continue;
      // An uncertain send is never repeated automatically (it may have arrived): Retry only.
      if (step === 'invite_email' && s.invite_email?.status === 'unknown' && !opts.manual) continue;
      if (step === 'invite_email') {
        const blocking = ALL_STEPS.filter((k) => k !== 'invite_email' && !done(s[k]));
        if (blocking.length > 0) {
          await recordStep(id, 'invite_email', { status: 'waiting', code: 'waiting_for_steps', detail: { blocking } });
          continue;
        }
      }
      if (opts.beforeStep) await opts.beforeStep(step);
      if (!(await renewStepsLease(id, lease))) break;
      try {
        await recordStep(id, step, await runOneTenantStep(step, row, opts.actorId));
      } catch (err) {
        console.warn(`[signup] step failed id=${id} step=${step}: ${errText(err)}`);
        await recordStep(id, step, { status: 'failed', code: errCode(err, `${step}_failed`), error: errText(err) });
      }
    }
  } finally {
    await releaseStepsLease(id, lease);
  }
  return { ran: true, row: await mustLoad(id) };
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

export interface ApproveResult {
  row: SignupRow;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  emailState: 'sent' | 'waiting';
  notOk: Array<{ step: string; status: string; code: string | null }>;
}

const TICK_FIRST_RETRY_SECS = 60;

/**
 * The approve path, shared by the super_admin screen, the super_admin invite and the Telegram
 * decision. Defaults: a new tenant named after the company / email organisation / name.
 */
export async function approveSignup(id: string, opts: { tenantName?: string }, actor: SignupActor): Promise<ApproveResult> {
  const { row: claimed, token } = await claimApproval(id);
  const claim = new HeldApprovalClaim(id, token, claimTiming);
  try {
    let row = claimed;
    if (!row.tenant_slug) {
      row = await reserveSlug(row, token, opts.tenantName);
    } else if (opts.tenantName !== undefined && opts.tenantName.trim() !== (row.tenant_name ?? '')) {
      // The slug is reserved (an earlier attempt, maybe a founded tenant): a different name is a
      // different workspace, never silently ignored.
      throw new SignupError(
        409,
        'tenant_name_locked',
        `This signup already reserved the workspace '${row.tenant_name ?? row.tenant_slug}' (${row.tenant_slug}); approve without a name or with that one, or reject it.`,
        { tenantName: row.tenant_name, tenantSlug: row.tenant_slug },
      );
    }
    await claim.assertHeld('identity');
    row = await runIdentityStep(row);
    await claim.assertHeld('provision');
    try {
      row = await runProvisionStep(row);
    } catch (err) {
      // The slug was free when reserved but is taken now (a tenant created since, or one fr keyed on
      // it that this signup did not found): nothing was created or joined, so reserve the next
      // candidate once and retry.
      if (err instanceof SignupError && (err.code === 'tenant_name_taken' || err.code === 'tenant_slug_foreign') && !row.tenant_id) {
        const takenSlug = row.tenant_slug!;
        await db.update(signupApprovals).set({ tenant_slug: null }).where(and(eq(signupApprovals.id, id), eq(signupApprovals.approving_claim, token)));
        row = await reserveSlug({ ...row, tenant_slug: null }, token, opts.tenantName, [takenSlug]);
        await claim.assertHeld('provision');
        row = await runProvisionStep(row);
      } else {
        throw err;
      }
    }
    const steps = await runTenantSteps(id, { actorId: actorId(actor), beforeStep: (s) => claim.assertHeld(s) });
    if (!steps.ran && steps.reason === 'tenant_unverified') {
      throw new SignupError(502, 'tenant_unverified', 'The provisioning record does not match the tenant this signup founded; nothing further was done.');
    }
    if (!steps.ran) throw new SignupError(409, 'approval_in_progress', 'Its provisioning steps are running elsewhere right now; reload in a moment.');
    await claim.assertHeld('decide');
    const complete = stepsComplete(steps.row) || awaitingOperator(steps.row);
    const [updated] = await db
      .update(signupApprovals)
      .set({
        status: 'approved',
        decided_at: new Date(),
        decided_by: actor.kind === 'super_admin' ? actor.userId : null,
        decided_via: actor.kind === 'super_admin' ? 'onboarding' : 'telegram',
        decider_actor: actorAudit(actor),
        steps_next_attempt_at: complete ? null : sql`now() + make_interval(secs => ${TICK_FIRST_RETRY_SECS})`,
        steps_attempts: 0,
      })
      .where(and(eq(signupApprovals.id, id), eq(signupApprovals.status, 'pending'), eq(signupApprovals.approving_claim, token)))
      .returning();
    if (!updated) throw new SignupError(400, 'approval_not_pending', 'Approval was decided meanwhile');
    console.log(
      `[signup] approved id=${id} tenant=${updated.tenant_id} slug=${updated.tenant_slug} by=${actorAudit(actor)} ` +
        `email=${emailState(updated)} not_ok=${stepsNotOk(updated).map((s) => s.step).join(',') || '-'}`,
    );
    notifySignupDecision({
      id,
      outcome: 'approved',
      email: updated.email,
      name: updated.name,
      tenantId: updated.tenant_id,
      tenantName: updated.tenant_name,
      tenantSlug: updated.tenant_slug,
      decidedVia: actorLabel(actor),
      emailState: emailState(updated),
      notOk: stepsNotOk(updated),
    });
    return {
      row: updated,
      tenantId: updated.tenant_id!,
      tenantName: updated.tenant_name,
      tenantSlug: updated.tenant_slug,
      emailState: emailState(updated),
      notOk: stepsNotOk(updated),
    };
  } finally {
    claim.stop();
    await db
      .update(signupApprovals)
      .set({ approving_until: null, approving_claim: null })
      .where(and(eq(signupApprovals.id, id), eq(signupApprovals.approving_claim, token)))
      .catch(() => {});
  }
}

/** super_admin Retry of an approved signup's unfinished steps (resets the tick's backoff). */
export async function retrySignupSteps(id: string, actor: SignupActor): Promise<SignupRow> {
  const row = await mustLoad(id);
  if (row.status !== 'approved') throw new SignupError(400, 'approval_not_approved', `Only an approved signup's steps can be retried (it is ${row.status}).`);
  const res = await runTenantSteps(id, { actorId: actorId(actor), manual: true });
  if (!res.ran && res.reason === 'tenant_unverified') {
    throw new SignupError(409, 'tenant_unverified', 'The provisioning record does not match the tenant this signup founded; resolve it by hand.');
  }
  if (!res.ran) throw new SignupError(409, 'steps_in_progress', 'Its provisioning steps are running right now; reload in a moment.');
  return finishStepsRun(res.row, true);
}

const STEPS_MAX_ATTEMPTS = 10;
function stepsBackoffMs(attempts: number): number {
  return Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** Math.min(Math.max(attempts, 1) - 1, 10));
}

async function finishStepsRun(row: SignupRow, reset: boolean): Promise<SignupRow> {
  // An uncertain email parks the row for the operator: the tick has nothing it may do.
  const complete = stepsComplete(row) || awaitingOperator(row);
  const attempts = reset ? 0 : row.steps_attempts + 1;
  const [updated] = await db
    .update(signupApprovals)
    .set({
      steps_attempts: complete ? row.steps_attempts : attempts,
      steps_next_attempt_at: complete
        ? null
        : attempts >= STEPS_MAX_ATTEMPTS
          ? null
          : sql`now() + make_interval(secs => ${Math.floor(stepsBackoffMs(attempts + (reset ? 1 : 0)) / 1000)})`,
    })
    .where(eq(signupApprovals.id, row.id))
    .returning();
  return updated ?? row;
}

// ---------------------------------------------------------------------------
// reject + the cleanup of what an aborted approve left behind
// ---------------------------------------------------------------------------

export interface RejectRepairState {
  state: 'pending' | 'done' | 'failed' | 'blocked' | 'resolved_manually';
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  leaseUntil?: string | null;
  leaseToken?: string | null;
  blockers?: string[];
  undid?: string[];
  note?: string;
  resolvedBy?: string;
}

function initialRejectRepair(): RejectRepairState {
  return { state: 'pending', attempts: 0, nextAttemptAt: new Date().toISOString(), lastAttemptAt: null, lastError: null };
}

const REPAIR_LEASE_MS = 3 * 60_000;
const REJECT_REPAIR_MAX_ATTEMPTS = 10;

interface RejectOutcome {
  row: SignupRow;
  decidedHere: boolean;
  repair: RejectRepairState | null;
}

export async function rejectSignup(id: string, actor: SignupActor): Promise<RejectOutcome> {
  const row = await mustLoad(id);
  const rr = row.reject_repair as RejectRepairState | null;
  if (row.status === 'rejected' && rr && rr.state !== 'done' && rr.state !== 'resolved_manually') {
    // Retry (the screen's): finish the cleanup an earlier reject left pending / blocked / failed.
    const repair = await repairRejectedSignup(id, { manual: true });
    return { row: await mustLoad(id), decidedHere: false, repair };
  }
  if (row.status !== 'pending') throw new SignupError(400, 'approval_not_pending', `Approval is already ${row.status}`);
  if (row.approving_until && row.approving_until.getTime() > Date.now()) {
    throw new SignupError(409, 'approval_in_progress', 'This signup is being approved right now; reload in a moment.');
  }
  if (row.tenant_id) {
    const blockers = await deps.workspaceBlockers(row.tenant_id, row.kc_user_id);
    if (blockers.length > 0) {
      throw new SignupError(
        409,
        'signup_workspace_in_use',
        'An earlier approve of this signup founded a workspace that now has other members or data, so rejecting it would destroy them. Offboard it deliberately first.',
        { tenantId: row.tenant_id, blockers },
      );
    }
  }
  const [updated] = await db
    .update(signupApprovals)
    .set({
      status: 'rejected',
      decided_at: new Date(),
      decided_by: actor.kind === 'super_admin' ? actor.userId : null,
      decided_via: actor.kind === 'super_admin' ? 'onboarding' : 'telegram',
      decider_actor: actorAudit(actor),
      steps_next_attempt_at: null,
      // The cleanup is recorded WITH the decision, in SQL, so an effect an aborting approve recorded
      // a moment ago is never missed.
      reject_repair: sql`CASE WHEN ${signupApprovals.identity_minted} OR ${signupApprovals.tenant_id} IS NOT NULL
                               OR ${signupApprovals.steps} ? 'provision'
                          THEN ${JSON.stringify(initialRejectRepair())}::jsonb ELSE NULL END`,
      // Nothing to undo ⇒ the reserved name is released now (spam cannot burn names); otherwise the
      // cleanup needs it (deprovision addresses the run by (email, slug)) and releases it when done.
      tenant_slug: sql`CASE WHEN ${signupApprovals.identity_minted} OR ${signupApprovals.tenant_id} IS NOT NULL
                               OR ${signupApprovals.steps} ? 'provision'
                          THEN ${signupApprovals.tenant_slug} ELSE NULL END`,
    })
    .where(
      and(
        eq(signupApprovals.id, id),
        eq(signupApprovals.status, 'pending'),
        // ⛔ Never under a live approve claim, token or not.
        sql`(${signupApprovals.approving_until} IS NULL OR ${signupApprovals.approving_until} <= now())`,
      ),
    )
    .returning();
  if (!updated) {
    const now = await mustLoad(id);
    if (now.status === 'pending') throw new SignupError(409, 'approval_in_progress', 'This signup is being approved right now; reload in a moment.');
    throw new SignupError(400, 'approval_not_pending', 'Approval was decided meanwhile');
  }
  const repair = updated.reject_repair ? await repairRejectedSignup(id, { manual: false, ignoreBackoff: true }) : null;
  console.log(`[signup] rejected id=${id} by=${actorAudit(actor)} cleanup=${repair?.state ?? 'none'}`);
  notifySignupDecision({
    id,
    outcome: 'rejected',
    email: updated.email,
    name: updated.name,
    decidedVia: actorLabel(actor),
    cleanup: repair ? repair.state : null,
  });
  return { row: await mustLoad(id), decidedHere: true, repair };
}

function repairBackoffMs(attempts: number): number {
  return stepsBackoffMs(attempts);
}

/** Take the repair lease (one runner at a time). null = held by another runner or not due. */
async function claimRepair(id: string, o: { manual: boolean; ignoreBackoff?: boolean }): Promise<{ row: SignupRow; lease: string } | null> {
  const lease = randomUUID();
  const states = o.manual ? sql`('pending','failed','blocked')` : sql`('pending')`;
  const [row] = await db
    .update(signupApprovals)
    .set({
      reject_repair: sql`${signupApprovals.reject_repair} || jsonb_build_object(
        'leaseToken', ${lease}::text,
        'leaseUntil', to_jsonb(now() + make_interval(secs => ${REPAIR_LEASE_MS / 1000})),
        'lastAttemptAt', to_jsonb(now()),
        'attempts', CASE WHEN ${o.manual} THEN 1 ELSE coalesce((${signupApprovals.reject_repair}->>'attempts')::int, 0) + 1 END,
        'nextAttemptAt', to_jsonb(now() + make_interval(secs => ${REPAIR_LEASE_MS / 1000})))`,
    })
    .where(
      and(
        eq(signupApprovals.id, id),
        eq(signupApprovals.status, 'rejected'),
        sql`${signupApprovals.reject_repair}->>'state' IN ${states}`,
        sql`(${signupApprovals.reject_repair}->>'leaseUntil' IS NULL OR (${signupApprovals.reject_repair}->>'leaseUntil')::timestamptz <= now())`,
        o.manual || o.ignoreBackoff
          ? sql`true`
          : sql`coalesce((${signupApprovals.reject_repair}->>'nextAttemptAt')::timestamptz, now()) <= now()`,
      ),
    )
    .returning();
  return row ? { row, lease } : null;
}

async function writeRepair(id: string, lease: string, patch: Partial<RejectRepairState>): Promise<RejectRepairState | null> {
  const [row] = await db
    .update(signupApprovals)
    .set({
      reject_repair: sql`${signupApprovals.reject_repair} || ${JSON.stringify({ ...patch, leaseToken: null, leaseUntil: null })}::jsonb`,
    })
    .where(and(eq(signupApprovals.id, id), sql`${signupApprovals.reject_repair}->>'leaseToken' = ${lease}`))
    .returning();
  return (row?.reject_repair as RejectRepairState | null) ?? null;
}

/**
 * Undo what an aborted approve of a REJECTED signup left behind: reverse the provisioning run (the
 * identity and that run's licences), archive the licences tenant (every licence on it — the
 * `conveyor` bundle's included — stops authorising), drop the fr-local admin grant, and retire the
 * identity fr minted. NEVER past a blocker: another member or a project → `blocked`, nothing done.
 * `done` only when every part answered.
 */
async function repairRejectedSignup(
  id: string,
  o: { manual: boolean; ignoreBackoff?: boolean },
): Promise<RejectRepairState | null> {
  const claimed = await claimRepair(id, o);
  if (!claimed) {
    const row = await loadSignup(id);
    return (row?.reject_repair as RejectRepairState | null) ?? null;
  }
  const { row, lease } = claimed;
  const attempts = Number((row.reject_repair as unknown as RejectRepairState).attempts ?? 1);
  const undid: string[] = [];
  try {
    if (row.tenant_id) {
      const blockers = await deps.workspaceBlockers(row.tenant_id, row.kc_user_id);
      if (blockers.length > 0) {
        console.warn(`[signup] reject cleanup blocked id=${id} tenant=${row.tenant_id}: ${blockers.join(', ')}`);
        return await writeRepair(id, lease, { state: 'blocked', blockers, lastError: null, nextAttemptAt: null });
      }
    }
    const provisioned = row.tenant_id !== null || stepsOf(row).provision !== undefined;
    if (provisioned && row.tenant_slug) {
      // The run is addressed by (email, slug): only THIS person's run on this slug is reversed.
      const dep = await deps.deprovision({ email: row.email, tenantSlug: row.tenant_slug, reason: `fr early-access signup ${id} rejected` });
      undid.push(dep === 'no_run' ? 'provisioning:no_run' : `provisioning:deprovisioned(licences=${dep.licenses_deleted})`);
    }
    // ⛔ Only the tenant this signup FOUNDED (row.tenant_id is recorded only on licences' 201) — never
    // a tenant the engine or the deprovision answered.
    if (row.tenant_id) undid.push(`tenant:${await deps.archiveTenant(row.tenant_id)}`);
    if (row.tenant_id && row.kc_user_id) {
      await deps.revokeWorkspaceAdmin(row.kc_user_id, row.tenant_id);
      undid.push('workspace-admin:revoked');
    }
    if (row.kc_user_id && row.identity_minted) {
      // ⛔ Only a login stamped with THIS signup's id is deleted.
      const user = await deps.identity.getUser(row.kc_user_id);
      if (!user) undid.push('identity:already_gone');
      else if (!identityBelongsTo(user, row.id)) {
        console.warn(`[signup] reject cleanup id=${id}: login ${row.kc_user_id} lacks ${SIGNUP_ID_ATTRIBUTE}=${id}, NOT deleted`);
        undid.push('identity:not_owned');
      } else undid.push((await deps.identity.deleteUser(row.kc_user_id)) ? 'identity:deleted' : 'identity:already_gone');
    }
    // Everything is undone: release the reserved name.
    await db.update(signupApprovals).set({ tenant_slug: null }).where(and(eq(signupApprovals.id, id), eq(signupApprovals.status, 'rejected')));
    console.log(`[signup] reject cleanup done id=${id}: ${undid.join(', ') || 'nothing'}`);
    return await writeRepair(id, lease, { state: 'done', undid, lastError: null, nextAttemptAt: null, blockers: [] });
  } catch (err) {
    const gaveUp = attempts >= REJECT_REPAIR_MAX_ATTEMPTS;
    console.warn(`[signup] reject cleanup failed id=${id} attempt=${attempts}: ${errText(err)}`);
    return await writeRepair(id, lease, {
      state: gaveUp ? 'failed' : 'pending',
      undid,
      lastError: errText(err),
      nextAttemptAt: gaveUp ? null : new Date(Date.now() + repairBackoffMs(attempts)).toISOString(),
    });
  }
}

/**
 * Close a cleanup that cannot finish on its own (failed / blocked), with a note. It may leave the
 * rejected requester's login, licence or workspace live, so the caller must acknowledge that.
 */
export async function resolveRejectRepair(
  id: string,
  actor: SignupActor,
  note: string,
  acknowledgeLiveAccess: boolean,
): Promise<SignupRow> {
  if (!acknowledgeLiveAccess) {
    throw new SignupError(
      422,
      'reject_repair_live_access_unacknowledged',
      "Resolving this cleanup may leave the rejected requester's login, licence or workspace live; confirm that explicitly (acknowledgeLiveAccess: true).",
    );
  }
  const patch = { state: 'resolved_manually', note, resolvedBy: actorAudit(actor), nextAttemptAt: null };
  const [row] = await db
    .update(signupApprovals)
    .set({ reject_repair: sql`${signupApprovals.reject_repair} || ${JSON.stringify(patch)}::jsonb` })
    .where(
      and(
        eq(signupApprovals.id, id),
        eq(signupApprovals.status, 'rejected'),
        sql`${signupApprovals.reject_repair}->>'state' IN ('failed','blocked')`,
        sql`(${signupApprovals.reject_repair}->>'leaseUntil' IS NULL OR (${signupApprovals.reject_repair}->>'leaseUntil')::timestamptz <= now())`,
      ),
    )
    .returning();
  if (row) return row;
  const now = await mustLoad(id);
  const state = (now.reject_repair as RejectRepairState | null)?.state ?? null;
  throw new SignupError(409, 'reject_repair_not_resolvable', `Only a rejected signup whose cleanup is failed or blocked can be resolved (it is ${state ?? now.status}).`, { state });
}

// ---------------------------------------------------------------------------
// the tick
// ---------------------------------------------------------------------------

interface SignupTickResult {
  stepRuns: number;
  repairRuns: number;
}

/** One pass: due approved rows' unfinished steps, then due reject cleanups. Never throws per row. */
export async function runSignupTick(limit = 20): Promise<SignupTickResult> {
  let stepRuns = 0;
  let repairRuns = 0;
  const due = await db
    .select({ id: signupApprovals.id })
    .from(signupApprovals)
    .where(and(eq(signupApprovals.status, 'approved'), sql`${signupApprovals.steps_next_attempt_at} <= now()`))
    .orderBy(signupApprovals.steps_next_attempt_at)
    .limit(limit);
  for (const { id } of due) {
    try {
      const res = await runTenantSteps(id, { actorId: 'system:signup-tick' });
      if (!res.ran) continue;
      stepRuns++;
      await finishStepsRun(res.row, false);
    } catch (err) {
      console.warn(`[signup] tick steps failed id=${id}: ${errText(err)}`);
    }
  }
  const repairs = await db
    .select({ id: signupApprovals.id })
    .from(signupApprovals)
    .where(
      and(
        eq(signupApprovals.status, 'rejected'),
        sql`${signupApprovals.reject_repair}->>'state' = 'pending'`,
        sql`coalesce((${signupApprovals.reject_repair}->>'nextAttemptAt')::timestamptz, now()) <= now()`,
      ),
    )
    .limit(limit);
  for (const { id } of repairs) {
    try {
      if (await repairRejectedSignup(id, { manual: false })) repairRuns++;
    } catch (err) {
      console.warn(`[signup] tick repair failed id=${id}: ${errText(err)}`);
    }
  }
  return { stepRuns, repairRuns };
}

// ---------------------------------------------------------------------------
// licence repair (scripts/signup-ensure-licences.ts)
// ---------------------------------------------------------------------------

interface SignupLicenceRepairReport {
  signupId: string;
  tenantId: string;
  tenantSlug: string;
  /**
   * The keys this signup's approve requested (recorded on `steps.provision.detail`), or — only when
   * the row records none — today's `signupApps()`. Always includes the gate's `fr`.
   */
  apps: string[];
  /** Where `apps` came from: the approve-time record on the row, or the current FR_SIGNUP_APPS. */
  appsSource: 'approve_record' | 'env_fallback';
  /** Keys with NO active licence for the tenant before this run. */
  missing: string[];
  applied: boolean;
  /** app_key → licence id the engine granted (apply only). */
  granted: Record<string, string>;
  /** Keys still without an active licence after the grants (apply only; [] = repaired). */
  stillMissing: string[];
  partialFailures: string[];
  /** Set when grants landed but the licence-gate cache could not be dropped (stale until TTL). */
  cacheInvalidationError: string | null;
}

/**
 * Licence every signup app key (incl. the gate's `fr`) that the tenant THIS signup founded holds no
 * ACTIVE licence for. The repair for approves that ran before `fr` was in the signup app list
 * (2026-10-20: the workspace was founded, emailed, and refused by fr's own gate).
 *
 * The keys are the ones THIS signup's approve requested (`recordedSignupApps`), never today's
 * FR_SIGNUP_APPS unless the row records none. Before anything is read or granted, the row's tenant
 * must agree with the provision step's recorded tenant and the identity's `tenant_id` stamp
 * (`tenant_mismatch` otherwise: the row is skipped, nothing granted).
 *
 * Dry run (the default) reads and reports only. `apply` grants ONLY the missing keys, to the
 * recorded tenant, for the identity this signup minted, drops fr's cached gate answer as soon as any
 * grant landed (also when a later grant fails), and records `steps.licence_repair` on the row.
 *
 * ⚠️ Not `deps.provision` again: provisioning keys a provision on (email, tenant_slug), so a second
 * provision of the same person REPLAYS the first run and mints nothing (services/provisioning.ts,
 * IDEMPOTENCY). The engine's add-a-licence op (`POST /api/licenses/grant`) runs the same
 * mint-or-reuse + quota primitive per key, and is idempotent on an existing live licence.
 */
export async function ensureSignupLicences(
  id: string,
  opts: { apply: boolean; actor?: string },
): Promise<SignupLicenceRepairReport> {
  const row = await mustLoad(id);
  if (row.status !== 'approved') {
    throw new SignupError(409, 'approval_not_approved', `Only an approved signup can be repaired (it is ${row.status}).`);
  }
  const tenantId = row.tenant_id;
  const slug = row.tenant_slug;
  const attempt = slug ? ((row.tenant_attempts ?? {}) as Record<string, { state?: string; tenantId?: string }>)[slug] : undefined;
  if (!tenantId || !slug || attempt?.state !== 'founded' || attempt.tenantId !== tenantId) {
    throw new SignupError(
      409,
      'tenant_not_founded_by_signup',
      `Signup ${id} records tenant ${tenantId ?? '-'} but no 'founded' tenant_attempts entry for slug ${slug ?? '-'} with that id; refusing to license it.`,
    );
  }
  if (!row.kc_user_id) throw new SignupError(409, 'identity_missing', `Signup ${id} records no identity to license.`);
  const kcUserId = row.kc_user_id;
  const actor = opts.actor ?? 'script:signup-ensure-licences';

  // Tenant agreement BEFORE any grant: the tenant the provision step recorded and the tenant stamped
  // on the identity must both be the row's tenant. A mismatch skips the row — nothing is granted.
  const mismatch = await licenceRepairTenantMismatch(row, tenantId);
  if (mismatch) {
    if (opts.apply) {
      await recordLicenceRepair(id, { status: 'failed', code: 'tenant_mismatch', error: mismatch, detail: { tenantId, actor, phase: 'pre_grant' } });
    }
    throw new SignupError(409, 'tenant_mismatch', `${mismatch}; skipped, nothing was granted.`);
  }

  const { apps, source: appsSource } = recordedSignupApps(row);
  const missing: string[] = [];
  for (const key of apps) if (!(await deps.hasActiveLicense(tenantId, key))) missing.push(key);
  const report: SignupLicenceRepairReport = {
    signupId: id,
    tenantId,
    tenantSlug: slug,
    apps,
    appsSource,
    missing,
    applied: false,
    granted: {},
    stillMissing: missing,
    partialFailures: [],
    cacheInvalidationError: null,
  };
  if (!opts.apply) return report;

  report.applied = true;
  const fail = async (status: number, code: string, message: string): Promise<never> => {
    await recordLicenceRepair(id, { status: 'failed', code, error: message, detail: { ...repairDetail(report), actor } });
    throw new SignupError(status, code, message);
  };
  // fr's gate caches its answer per tenant: once ANY grant landed in this tenant the cache is dropped,
  // even when a later key fails or the run aborts — otherwise the person stays refused by a stale
  // "no licence" until the TTL.
  let grantedHere = false;
  let cacheError: string | null = null;
  try {
    for (const appKey of missing) {
      let g: ProvGrantResult;
      try {
        g = await deps.grantLicence({ tenantId, subjectId: kcUserId, appKey });
      } catch (err) {
        return await fail(502, errCode(err, 'grant_failed'), `Granting '${appKey}' failed: ${errText(err)}`);
      }
      if (g.tenant_id !== tenantId) {
        return await fail(
          502,
          'tenant_mismatch',
          `provisioning granted '${appKey}' in tenant ${g.tenant_id}, not the tenant this signup founded (${tenantId}); stopped.`,
        );
      }
      grantedHere = true;
      if (g.license?.license_id) report.granted[appKey] = g.license.license_id;
      report.partialFailures.push(...(g.partial_failures ?? []));
    }
    const stillMissing: string[] = [];
    for (const key of missing) if (!(await deps.hasActiveLicense(tenantId, key))) stillMissing.push(key);
    report.stillMissing = stillMissing;
  } finally {
    // A grant error already propagating wins; an invalidation failure on an
    // otherwise clean run fails the repair below (stale gate until TTL).
    if (grantedHere) {
      await deps.invalidateFrLicence(tenantId).catch((err) => {
        cacheError = errText(err);
        console.warn(`[signup] licence repair: gate cache invalidation failed tenant=${tenantId}: ${cacheError}`);
      });
    }
  }
  report.cacheInvalidationError = cacheError;
  const still = report.stillMissing;
  const clean = still.length === 0 && report.partialFailures.length === 0 && cacheError === null;
  await recordLicenceRepair(id, {
    status: clean ? 'ok' : 'failed',
    code:
      still.length > 0
        ? 'licence_still_missing'
        : report.partialFailures.length > 0
          ? 'grant_partial'
          : cacheError !== null
            ? 'gate_cache_invalidation_failed'
            : null,
    detail: { ...repairDetail(report), actor },
  });
  return report;
}

/**
 * The app keys THIS signup's approve requested, read from `steps.provision.detail` (`licenseIds`
 * keys + `missingLicences` = exactly the list the approve sent the engine). Falls back to today's
 * FR_SIGNUP_APPS only when the row records none. Always includes the gate's `fr` (approves before
 * 2026-10-20 never requested it — the very defect the repair exists for).
 */
function recordedSignupApps(row: Pick<SignupRow, 'steps'>): { apps: string[]; source: 'approve_record' | 'env_fallback' } {
  const detail = (stepsOf(row).provision?.detail ?? {}) as { licenseIds?: unknown; missingLicences?: unknown };
  const recorded: string[] = [];
  const add = (k: unknown): void => {
    if (typeof k === 'string' && k && !recorded.includes(k)) recorded.push(k);
  };
  if (detail.licenseIds && typeof detail.licenseIds === 'object' && !Array.isArray(detail.licenseIds)) {
    for (const k of Object.keys(detail.licenseIds)) add(k);
  }
  if (Array.isArray(detail.missingLicences)) for (const k of detail.missingLicences) add(k);
  const source = recorded.length > 0 ? 'approve_record' : 'env_fallback';
  // Only fr's per-person licences (fr + fr-frontend): a repair never mints another platform's
  // app, even one an older approve recorded.
  const apps = (recorded.length > 0 ? recorded : [...signupProvisioningConfig().apps]).filter(isFrPersonApp);
  if (!apps.includes(FR_APP_KEY)) apps.push(FR_APP_KEY);
  return { apps, source };
}

/** Why the row's tenant disagrees with the provision record or the identity's stamp (null = agrees). */
async function licenceRepairTenantMismatch(row: SignupRow, tenantId: string): Promise<string | null> {
  const provTenant = (stepsOf(row).provision?.detail as { tenantId?: unknown } | undefined)?.tenantId;
  if (typeof provTenant === 'string' && provTenant && provTenant !== tenantId) {
    return `Signup ${row.id} records tenant ${tenantId} but its provision step recorded tenant ${provTenant}`;
  }
  const user = await deps.identity.getUser(row.kc_user_id!);
  if (!identityBelongsTo(user, row.id)) {
    return `Signup ${row.id}: login ${row.kc_user_id ?? '-'} is missing or does not carry ${SIGNUP_ID_ATTRIBUTE}=${row.id}`;
  }
  const userTenant = user?.attributes?.tenant_id?.[0];
  if (userTenant && userTenant !== tenantId) {
    return `Signup ${row.id} records tenant ${tenantId} but its login ${row.kc_user_id ?? '-'} is stamped tenant_id=${userTenant}`;
  }
  return null;
}

function repairDetail(r: SignupLicenceRepairReport): Record<string, unknown> {
  return { tenantId: r.tenantId, apps: r.apps, appsSource: r.appsSource, missing: r.missing, granted: r.granted, stillMissing: r.stillMissing, partialFailures: r.partialFailures };
}

/** `steps.licence_repair` — an audit note beside the steps, never one of ALL_STEPS (no gating). */
async function recordLicenceRepair(id: string, rec: Omit<StepRecord, 'at'>): Promise<void> {
  await db
    .update(signupApprovals)
    .set({
      steps: sql`${signupApprovals.steps} || jsonb_build_object('licence_repair'::text, ${JSON.stringify({ ...rec, at: new Date().toISOString() })}::jsonb)`,
    })
    .where(eq(signupApprovals.id, id));
}
