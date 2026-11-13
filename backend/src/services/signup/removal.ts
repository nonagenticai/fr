// src/services/signup/removal.ts — REMOVE an approved early-access workspace end to end.
//
// Why it exists: on 2026-10-25 the test tenants were removed by hand. The super_admin
// deprovision-user removed the person's own licences and login, but the conveyor bundle licences
// (12, tenant-level), the licences tenant, the fr workspace and the workspace-admin grant all stayed
// live, and the signup row stayed `approved` (its slug reserved). This is the one action that undoes
// an approve — modelled on Studio's (w2v_orchestrator services/signup/removal.py) and CommonPractice's
// reject cleanup (#476/#477), on fr's own building blocks (the reject cleanup in core.ts).
//
// THE ACTION (`startRemoval`, POST /api/signup-approvals/:id/remove, super_admin): only an
// `approved` row, with its workspace slug typed back as `confirm`, whose steps lease is free and
// which has no blocker. ONE guarded UPDATE moves it to `status='removed'` with
// `removal = {state: 'pending', …}` (no tick re-runs a removed row's provisioning steps from then
// on), then the steps run in the request. Retry (`retryRemoval`) re-runs a pending / failed /
// blocked removal; Resolve (`resolveRemoval`) closes a failed / blocked one by hand.
//
// THE STEPS, in order, each recorded in `removal.steps` and audited as one `provisioning_audit` row
// (`remove_signup_step`); an `ok` / `skipped` step is never re-run:
//
//   (blockers)       re-checked at the start of EVERY run, nothing is touched while any holds:
//                    the row's tenant must be the one THIS signup founded (provision record +
//                    `tenant_attempts`), and nobody but the requester may hold a role in it.
//   provisioning     reverse the engine's provisioning run for (email, slug): its licences + their
//                    billing quota (`no_run` = nothing to reverse).
//   licences         list EVERY licence of the tenant (the person's AND the `conveyor` bundle's
//                    tenant-level ones), revoke each live one through provisioning (billing quota
//                    deregistered, deterministic key so a retry resumes), re-list and CONFIRM none is
//                    live. A listing that names another tenant's licence blocks with zero writes.
//   licences_tenant  archive the licences tenant.
//   workspace        archive the fr workspace (`workspaces.archived_at`).
//   grants           delete the requester's fr role grants in the tenant (workspace-admin et al).
//   identity         delete the realm-fr login this signup minted (fr's deprovision policy deletes,
//                    never disables) — only one stamped `fr_signup_id = <row id>`; any other login
//                    blocks (`identity_not_owned`), it is never touched.
//   finalize         release the reserved slug (`tenant_slug = NULL`) and mark the removal `done`.
//
// A failed step stops the run: `removal.state = 'failed'` (or `blocked`), `lastError`, and the
// screen's Retry. Never half-silent: the HTTP answer is 409 / 502 naming the step, the row shows it
// under "Needs attention", and every attempt is in provisioning_audit.
//
// ⚠️ What this does NOT release: licences keeps tenant names unique per owner INCLUDING archived
// tenants, so the archived licences tenant still holds its name; a new signup's slug reservation
// (which reads archived names too) skips it and picks `<slug>-2`. That is licences' rule, not fr's.
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { db, provisioningAudit, signupApprovals } from '../../db/client';
import { identityBelongsTo, SIGNUP_ID_ATTRIBUTE } from './identity';
import {
  actorAudit,
  errCode,
  errText,
  mustLoad,
  signupDeps,
  SignupError,
  stepsOf,
  type SignupActor,
  type SignupRow,
} from './core';

export const REMOVAL_STEPS = ['provisioning', 'licences', 'licences_tenant', 'workspace', 'grants', 'identity', 'finalize'] as const;
export type RemovalStepName = (typeof REMOVAL_STEPS)[number];

export interface RemovalStepRecord {
  status: 'ok' | 'skipped' | 'failed' | 'blocked';
  at: string;
  code?: string | null;
  error?: string | null;
  detail?: Record<string, unknown>;
}

export interface RemovalState {
  state: 'pending' | 'blocked' | 'failed' | 'done' | 'resolved_manually';
  tenantId: string;
  tenantSlug: string;
  requestedBy: string;
  requestedAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  blockers: string[];
  steps: Partial<Record<RemovalStepName, RemovalStepRecord>>;
  leaseToken?: string | null;
  leaseUntil?: string | null;
  note?: string;
  resolvedBy?: string;
}

const LEASE_MS = 5 * 60_000;
const RETRYABLE = ['pending', 'failed', 'blocked'] as const;

export function removalOf(row: Pick<SignupRow, 'removal'>): RemovalState | null {
  return (row.removal as unknown as RemovalState | null) ?? null;
}

const stepDone = (r: RemovalStepRecord | undefined) => r?.status === 'ok' || r?.status === 'skipped';

// ---------------------------------------------------------------------------
// audit (one provisioning_audit row per start / retry / resolve and per step attempt)
// ---------------------------------------------------------------------------

async function audit(
  action: 'remove_signup' | 'remove_signup_step',
  row: SignupRow,
  actor: string,
  payload: Record<string, unknown>,
  outcome: { status: 'success' | 'error'; result?: Record<string, unknown>; error?: string | null },
): Promise<void> {
  try {
    await db.insert(provisioningAudit).values({
      actor_user_id: actor,
      action,
      target_email: row.email,
      target_user_id: row.kc_user_id,
      tenant_id: row.tenant_id,
      payload: { signup_id: row.id, ...payload },
      result: outcome.result ?? {},
      status: outcome.status,
      error: outcome.error ?? null,
    });
  } catch (err) {
    // The step's outcome is already on the row (removal.steps); a lost audit row is logged loudly.
    console.error(`[signup-removal] provisioning_audit write failed id=${row.id} action=${action}: ${errText(err)}`);
  }
}

// ---------------------------------------------------------------------------
// blockers
// ---------------------------------------------------------------------------

/** Why removing this row's workspace now would be wrong or unsafe ([] = go). */
export async function removalBlockers(row: SignupRow, tenantSlug: string): Promise<string[]> {
  const blockers: string[] = [];
  const tenantId = row.tenant_id;
  const provTenant = (stepsOf(row).provision?.detail as { tenantId?: unknown } | undefined)?.tenantId;
  const attempt = ((row.tenant_attempts ?? {}) as Record<string, { state?: string; tenantId?: string }>)[tenantSlug];
  if (!tenantId || provTenant !== tenantId || attempt?.state !== 'founded' || attempt.tenantId !== tenantId) {
    blockers.push(
      `tenant_mismatch: the row records tenant ${tenantId ?? '-'}, its provision step ${String(provTenant ?? '-')} and ` +
        `tenant_attempts[${tenantSlug}] ${attempt?.state ?? '-'}/${attempt?.tenantId ?? '-'}; only a tenant this signup founded is removed`,
    );
    return blockers;
  }
  const others = await signupDeps().otherMemberGrants(tenantId, row.kc_user_id);
  if (others > 0) {
    blockers.push(
      `other_members: ${others} role grant(s) in this workspace belong to someone other than the requester; ` +
        'offboard those members first (Admin → Users → deprovision), then retry',
    );
  }
  return blockers;
}

// ---------------------------------------------------------------------------
// the steps
// ---------------------------------------------------------------------------

type StepOutcome = Omit<RemovalStepRecord, 'at'>;

interface StepContext {
  /** Renew the run's lease (false: lost — the step must stop writing). */
  renewLease(): Promise<boolean>;
}

async function runStep(step: RemovalStepName, row: SignupRow, r: RemovalState, ctx: StepContext): Promise<StepOutcome> {
  const d = signupDeps();
  const tenantId = r.tenantId;
  const reason = `fr early-access signup ${row.id} removed`;
  switch (step) {
    case 'provisioning': {
      const dep = await d.deprovision({ email: row.email, tenantSlug: r.tenantSlug, reason });
      if (dep === 'no_run') return { status: 'ok', code: 'no_run', detail: { run: 'none' } };
      return {
        status: 'ok',
        detail: {
          licencesDeleted: dep.licenses_deleted,
          alreadyDeprovisioned: dep.already_deprovisioned,
          keycloakUserDeleted: dep.keycloak_user_deleted,
          billingQuotaRetained: dep.billing_quota_retained,
        },
      };
    }
    case 'licences': {
      const isLive = (l: { status: string; revoked_at: string | null }) =>
        !l.revoked_at && l.status !== 'revoked' && l.status !== 'expired';
      const listed = await d.listTenantLicences(tenantId);
      const foreign = listed.filter((l) => l.tenant_id !== tenantId).map((l) => l.id);
      if (foreign.length > 0) {
        return {
          status: 'blocked',
          code: 'licence_tenant_mismatch',
          error: `licences listed ${foreign.length} licence(s) of another tenant for ${tenantId}; nothing was revoked`,
          detail: { foreign },
        };
      }
      // DEPENDENCY licences last: licences refuses one while a live licence on the tenant still
      // requires it (409 dependency_still_required — which provisioning's revoke relays as a bare
      // 500 "license revoke failed") and RELEASES it with the last licence needing it. So the
      // ordinary licences go first, each dependency is re-checked against a fresh listing right
      // before its own revoke, and ANY revoke failure is only recorded: the re-list after the loop
      // decides. (Provisioning also answers 200 for a revoke licences silently refused — another
      // reason the re-list, not the revoke answers, is the judge.)
      const live = listed.filter(isLive);
      const ordered = [...live.filter((l) => !l.is_dependency), ...live.filter((l) => l.is_dependency)];
      const revoked: string[] = [];
      const releasedBefore: string[] = [];
      const failures: Array<{ licenseId: string; appKey: string | null; dependency: boolean; error: string }> = [];
      for (const lic of ordered) {
        if (!(await ctx.renewLease())) throw new Error('the removal lease was lost mid-step; nothing further was revoked');
        if (lic.is_dependency) {
          const now = (await d.listTenantLicences(tenantId)).find((l) => l.id === lic.id);
          if (!now || !isLive(now)) {
            releasedBefore.push(lic.id);
            continue;
          }
        }
        try {
          await d.revokeLicence(tenantId, lic.id, reason);
          revoked.push(lic.id);
        } catch (err) {
          failures.push({ licenseId: lic.id, appKey: lic.app_key, dependency: lic.is_dependency, error: errText(err) });
        }
      }
      const after = await d.listTenantLicences(tenantId);
      const stillLive = after.filter(isLive).map((l) => ({ licenseId: l.id, appKey: l.app_key, dependency: l.is_dependency }));
      const detail: Record<string, unknown> = {
        listed: listed.length,
        alreadyDead: listed.length - live.length,
        revoked,
        releasedWithTheirDependants: releasedBefore,
        apps: [...new Set(live.map((l) => l.app_key ?? '?'))].sort(),
        ...(failures.length > 0 ? { revokeFailures: failures } : {}),
      };
      if (stillLive.length > 0) {
        return {
          status: 'failed',
          code: failures.length > 0 ? 'licence_revoke_failed' : 'licences_still_live',
          error:
            `${stillLive.length} licence(s) still live after the revoke (${stillLive.map((x) => x.appKey ?? x.licenseId).join(', ')})` +
            (failures.length > 0 ? `; revoke failures: ${failures.map((x) => `${x.appKey ?? x.licenseId}: ${x.error}`).join('; ')}` : ''),
          detail: { ...detail, stillLive },
        };
      }
      try {
        await d.invalidateFrLicence(tenantId);
      } catch (err) {
        // The licences ARE revoked; only fr's cached gate answer may lag until its TTL.
        detail.gateCacheInvalidation = `failed: ${errText(err)}`;
      }
      return { status: 'ok', detail };
    }
    case 'licences_tenant':
      return { status: 'ok', detail: { result: await d.archiveTenant(tenantId) } };
    case 'workspace':
      return { status: 'ok', detail: { result: await d.archiveWorkspace(tenantId) } };
    case 'grants': {
      if (!row.kc_user_id) return { status: 'skipped', code: 'no_identity' };
      return { status: 'ok', detail: { removed: await d.removeTenantGrants(row.kc_user_id, tenantId) } };
    }
    case 'identity': {
      if (!row.kc_user_id || !row.identity_minted) return { status: 'skipped', code: 'no_minted_identity' };
      const user = await d.identity.getUser(row.kc_user_id);
      if (!user) return { status: 'ok', detail: { result: 'already_gone', userId: row.kc_user_id } };
      if (!identityBelongsTo(user, row.id)) {
        return {
          status: 'blocked',
          code: 'identity_not_owned',
          error: `login ${row.kc_user_id} does not carry ${SIGNUP_ID_ATTRIBUTE}=${row.id}; it is not this signup's to delete`,
        };
      }
      const deleted = await d.identity.deleteUser(row.kc_user_id);
      return { status: 'ok', detail: { result: deleted ? 'deleted' : 'already_gone', userId: row.kc_user_id } };
    }
    case 'finalize':
      return { status: 'ok' };
  }
}

// ---------------------------------------------------------------------------
// lease + writes (every write after the claim is guarded by the lease token)
// ---------------------------------------------------------------------------

async function claim(id: string): Promise<{ row: SignupRow; lease: string } | null> {
  const lease = randomUUID();
  const [row] = await db
    .update(signupApprovals)
    .set({
      removal: sql`${signupApprovals.removal} || jsonb_build_object(
        'state', 'pending',
        'leaseToken', ${lease}::text,
        'leaseUntil', to_jsonb(now() + make_interval(secs => ${LEASE_MS / 1000})),
        'lastAttemptAt', to_jsonb(now()),
        'attempts', coalesce((${signupApprovals.removal}->>'attempts')::int, 0) + 1)`,
    })
    .where(
      and(
        eq(signupApprovals.id, id),
        eq(signupApprovals.status, 'removed'),
        sql`${signupApprovals.removal}->>'state' IN ('pending','failed','blocked')`,
        sql`(${signupApprovals.removal}->>'leaseUntil' IS NULL OR (${signupApprovals.removal}->>'leaseUntil')::timestamptz <= now())`,
      ),
    )
    .returning();
  return row ? { row, lease } : null;
}

const leaseHeld = (lease: string) => sql`${signupApprovals.removal}->>'leaseToken' = ${lease}`;

async function renew(id: string, lease: string): Promise<boolean> {
  const rows = await db
    .update(signupApprovals)
    .set({
      removal: sql`${signupApprovals.removal} || jsonb_build_object('leaseUntil', to_jsonb(now() + make_interval(secs => ${LEASE_MS / 1000})))`,
    })
    .where(and(eq(signupApprovals.id, id), leaseHeld(lease)))
    .returning({ id: signupApprovals.id });
  return rows.length > 0;
}

async function recordStep(id: string, lease: string, step: RemovalStepName, rec: StepOutcome): Promise<void> {
  const full = JSON.stringify({ ...rec, at: new Date().toISOString() });
  await db
    .update(signupApprovals)
    .set({
      removal: sql`jsonb_set(${signupApprovals.removal}, '{steps}',
        coalesce(${signupApprovals.removal}->'steps', '{}'::jsonb) || jsonb_build_object(${step}::text, ${full}::jsonb))`,
    })
    .where(and(eq(signupApprovals.id, id), leaseHeld(lease)));
}

/** Close the run: merge `patch`, drop the lease. `releaseSlug` frees the reserved name (done only). */
async function finish(id: string, lease: string, patch: Partial<RemovalState>, releaseSlug = false): Promise<SignupRow | null> {
  const [row] = await db
    .update(signupApprovals)
    .set({
      removal: sql`${signupApprovals.removal} || ${JSON.stringify({ ...patch, leaseToken: null, leaseUntil: null })}::jsonb`,
      ...(releaseSlug ? { tenant_slug: null } : {}),
    })
    .where(and(eq(signupApprovals.id, id), leaseHeld(lease)))
    .returning();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

export interface RemovalRun {
  /** False: another run holds the lease, or the removal is not in a runnable state. */
  ran: boolean;
  row: SignupRow;
  removal: RemovalState | null;
}

/** Run every removal step that has not landed, in order; stop at the first that fails / blocks. */
export async function runRemoval(id: string, actor: string): Promise<RemovalRun> {
  const claimed = await claim(id);
  if (!claimed) {
    const row = await mustLoad(id);
    return { ran: false, row, removal: removalOf(row) };
  }
  const { lease } = claimed;
  const done = async (patch: Partial<RemovalState>, releaseSlug = false): Promise<RemovalRun> => {
    const row = (await finish(id, lease, patch, releaseSlug)) ?? (await mustLoad(id));
    return { ran: true, row, removal: removalOf(row) };
  };
  try {
    const first = claimed.row;
    const r0 = removalOf(first)!;
    const blockers = await removalBlockers(first, r0.tenantSlug);
    if (blockers.length > 0) {
      await audit('remove_signup_step', first, actor, { step: 'blockers' }, { status: 'error', error: blockers.join('; ') });
      console.warn(`[signup-removal] blocked id=${id}: ${blockers.join('; ')}`);
      return await done({ state: 'blocked', blockers, lastError: null });
    }
    for (const step of REMOVAL_STEPS) {
      const row = await mustLoad(id);
      const r = removalOf(row)!;
      if (stepDone(r.steps?.[step])) continue;
      if (!(await renew(id, lease))) {
        // The lease was lost (it expired under a stalled run and another run took it): stop here.
        const now = await mustLoad(id);
        return { ran: true, row: now, removal: removalOf(now) };
      }
      let rec: StepOutcome;
      try {
        rec = await runStep(step, row, r, { renewLease: () => renew(id, lease) });
      } catch (err) {
        rec = { status: 'failed', code: errCode(err, `${step}_failed`), error: errText(err) };
      }
      await recordStep(id, lease, step, rec);
      await audit(
        'remove_signup_step',
        row,
        actor,
        { step, attempt: r.attempts },
        {
          status: rec.status === 'ok' || rec.status === 'skipped' ? 'success' : 'error',
          result: { status: rec.status, code: rec.code ?? null, detail: rec.detail ?? {} },
          error: rec.error ?? null,
        },
      );
      if (rec.status === 'failed') {
        console.warn(`[signup-removal] step failed id=${id} step=${step}: ${rec.error ?? rec.code}`);
        return await done({ state: 'failed', lastError: `${step}: ${rec.error ?? rec.code ?? 'failed'}`, blockers: [] });
      }
      if (rec.status === 'blocked') {
        console.warn(`[signup-removal] step blocked id=${id} step=${step}: ${rec.error ?? rec.code}`);
        return await done({ state: 'blocked', lastError: null, blockers: [`${rec.code ?? step}: ${rec.error ?? ''}`.trim()] });
      }
    }
    console.log(`[signup-removal] done id=${id} tenant=${r0.tenantId} slug=${r0.tenantSlug}`);
    return await done({ state: 'done', lastError: null, blockers: [] }, true);
  } catch (err) {
    // A fault outside a step (a DB read): recorded, never left `pending` under a dead lease.
    console.warn(`[signup-removal] run failed id=${id}: ${errText(err)}`);
    return await done({ state: 'failed', lastError: errText(err) });
  }
}

// ---------------------------------------------------------------------------
// the actions
// ---------------------------------------------------------------------------

/**
 * Remove an APPROVED signup's workspace. `confirm` must be the workspace slug. Refused with no
 * change while a blocker holds (409 `signup_removal_blocked`) or the steps lease is held (409
 * `steps_in_progress`).
 */
export async function startRemoval(id: string, confirm: string, actor: SignupActor): Promise<RemovalRun> {
  const row = await mustLoad(id);
  if (row.status === 'removed') {
    const st = removalOf(row)?.state ?? 'unknown';
    throw new SignupError(
      409,
      'signup_already_removed',
      `This signup is already removed (removal ${st}).` + (RETRYABLE.includes(st as never) ? ' Use Retry removal.' : ''),
      { state: st },
    );
  }
  if (row.status !== 'approved') {
    throw new SignupError(400, 'approval_not_approved', `Only an approved signup can be removed (it is ${row.status}).`);
  }
  if (!row.tenant_slug || !row.tenant_id) {
    throw new SignupError(409, 'signup_no_workspace', 'This approved signup records no workspace to remove.');
  }
  if (confirm.trim() !== row.tenant_slug) {
    throw new SignupError(422, 'removal_confirm_mismatch', `Type the workspace slug '${row.tenant_slug}' as confirm to remove it.`);
  }
  const blockers = await removalBlockers(row, row.tenant_slug);
  if (blockers.length > 0) {
    await audit('remove_signup', row, actorAudit(actor), { operation: 'start' }, { status: 'error', error: blockers.join('; ') });
    throw new SignupError(409, 'signup_removal_blocked', `Not removed — ${blockers.join('; ')}`, { blockers });
  }
  const initial: RemovalState = {
    state: 'pending',
    tenantId: row.tenant_id,
    tenantSlug: row.tenant_slug,
    requestedBy: actorAudit(actor),
    requestedAt: new Date().toISOString(),
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    blockers: [],
    steps: {},
  };
  const [moved] = await db
    .update(signupApprovals)
    .set({ status: 'removed', steps_next_attempt_at: null, removal: sql`${JSON.stringify(initial)}::jsonb` })
    .where(
      and(
        eq(signupApprovals.id, id),
        eq(signupApprovals.status, 'approved'),
        eq(signupApprovals.tenant_slug, row.tenant_slug),
        sql`(${signupApprovals.steps_lease_until} IS NULL OR ${signupApprovals.steps_lease_until} <= now())`,
      ),
    )
    .returning();
  if (!moved) {
    const now = await mustLoad(id);
    if (now.status !== 'approved') throw new SignupError(409, 'approval_not_approved', `The signup is ${now.status} now; reload.`);
    throw new SignupError(409, 'steps_in_progress', 'Its provisioning steps are running right now; retry the removal in a moment.');
  }
  await audit('remove_signup', moved, actorAudit(actor), { operation: 'start', tenant_slug: row.tenant_slug }, { status: 'success' });
  console.log(`[signup-removal] started id=${id} tenant=${row.tenant_id} slug=${row.tenant_slug} by=${actorAudit(actor)}`);
  return runRemoval(id, actorAudit(actor));
}

/** super_admin Retry of a pending / failed / blocked removal. */
export async function retryRemoval(id: string, actor: SignupActor): Promise<RemovalRun> {
  const row = await mustLoad(id);
  const st = removalOf(row)?.state ?? null;
  if (row.status !== 'removed' || !st || !RETRYABLE.includes(st as never)) {
    throw new SignupError(409, 'removal_not_retryable', `Only a pending / failed / blocked removal can be retried (it is ${st ?? row.status}).`, { state: st });
  }
  await audit('remove_signup', row, actorAudit(actor), { operation: 'retry', previous_state: st }, { status: 'success' });
  const run = await runRemoval(id, actorAudit(actor));
  if (!run.ran) throw new SignupError(409, 'removal_in_progress', 'This removal is running right now; reload in a moment.');
  return run;
}

/**
 * Close a failed / blocked removal by hand, with a note. It may leave the requester's login, a
 * licence or the workspace live, so the caller must acknowledge that. Releases the reserved slug.
 */
export async function resolveRemoval(id: string, actor: SignupActor, note: string, acknowledgeLiveAccess: boolean): Promise<SignupRow> {
  if (!acknowledgeLiveAccess) {
    throw new SignupError(
      422,
      'removal_live_access_unacknowledged',
      'Closing this removal by hand may leave the login, a licence or the workspace live; confirm that explicitly (acknowledgeLiveAccess: true).',
    );
  }
  const patch = { state: 'resolved_manually', note, resolvedBy: actorAudit(actor) };
  const [row] = await db
    .update(signupApprovals)
    .set({ removal: sql`${signupApprovals.removal} || ${JSON.stringify(patch)}::jsonb`, tenant_slug: null })
    .where(
      and(
        eq(signupApprovals.id, id),
        eq(signupApprovals.status, 'removed'),
        sql`${signupApprovals.removal}->>'state' IN ('failed','blocked')`,
        sql`(${signupApprovals.removal}->>'leaseUntil' IS NULL OR (${signupApprovals.removal}->>'leaseUntil')::timestamptz <= now())`,
      ),
    )
    .returning();
  if (!row) {
    const now = await mustLoad(id);
    const st = removalOf(now)?.state ?? null;
    throw new SignupError(409, 'removal_not_resolvable', `Only a failed or blocked removal can be closed by hand (it is ${st ?? now.status}).`, { state: st });
  }
  await audit('remove_signup', row, actorAudit(actor), { operation: 'resolve', note }, { status: 'success' });
  return row;
}
