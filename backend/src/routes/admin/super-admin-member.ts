// src/routes/admin/super-admin-member.ts
//
// POST /api/admin/super-admin/provision-user in EXISTING-TENANT mode (`tenant_id`).
//
// A super_admin adds a human MEMBER to a tenant that already exists — including a
// tenant fr does not own but can resolve by id (e.g. the platform-owned conveyor
// service tenant, reachable through fr's active `tenant_app_grant`). The slug mode
// cannot do this: the provisioning engine resolves or mints fr-owned tenants BY
// SLUG, so any slug lands in (or creates) an fr tenant.
//
// George's rulings this path encodes:
//   * 10-10 — the TENANT holds the licence. Adding a member mints NO licence, NO
//     budget and NO seat: `provisionUserUpstream`, `createBudget` and every licence
//     mint are never reached from here (the body schema refuses the fields that
//     would feed them).
//   * 10-15 — every member is notified: the tenant's user-list cache is dropped so
//     notification fan-out sees the new member at once, not after its 60s TTL.
//   * Strict tenant separation; NEVER re-tenant a user. An existing account whose
//     Keycloak `tenant_id` is anything other than this tenant is REFUSED (409
//     `tenant_divergence`) before any role, workspace or grant is written. fr never
//     writes `tenant_id` on an existing account.
//
// The audit row reuses action `provision_user` (a DB CHECK restricts the action
// vocabulary — db/schema.ts `provisioning_audit_action_check`) with
// `payload.mode = 'existing_tenant'`.

import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { db, provisioningAudit } from '../../db/client';
import { isIntegrationError, integrationErrorResponse } from '../../integrations/_lib/errors';
import { adminGetTenant, type TenantRecord } from '../../services/licenses';
import { invalidateTenantUserCache, keycloak } from '../../services/keycloak';
import {
  createUser,
  enableUser,
  getUserState,
  hasPasswordCredential,
  sendUpdatePasswordEmail,
  setPassword,
} from '../../services/keycloak-admin';
import { syncTenantAdminGrant, type GrantSync } from '../../services/tenant-admin-sync';
import { userRolesService } from '../../services/user-roles';
import { auditIdentityLedger } from '../../services/provisioning-identity-ledger';
import { isDefiniteSendRefusal } from '../../services/user-realm-provision';
import { ensureWorkspace } from '../../services/workspaces';
import { AppError } from '../../utils/errors';
import { isValidUuid } from '../../utils/tenant';
import { jsonResponse } from '../../utils/response';
import type { User } from '../../types/api';
import type { ExistingTenantProvisionInput } from './super-admin-schemas';

/** The portal-realm role of a plain tenant user (George 2026-09-30: super_admin > tenant_admin > member). */
export const REALM_MEMBER_ROLE = 'member';

export interface ProvisionMemberResult {
  mode: 'existing_tenant';
  user_id: string;
  tenant_id: string;
  tenant_name: string;
  already_existed: boolean;
  /** 🔐 Shown ONCE; null for an existing account that already had a password (never rotated). */
  temporary_password: string | null;
  magic_link_sent: boolean;
  /** Always false: this mode has no engine run to replay. Present so the shared credential copy reads it. */
  replayed: false;
  workspace_role: 'admin' | 'member';
  realm_role: 'added' | 'already';
  keycloak_sync?: GrantSync;
  warnings: string[];
}

type Resolved = { ok: true; tenant: TenantRecord } | { ok: false; response: Response };

/**
 * Resolve the target tenant by id. A licences 404 is an ANSWER — no such tenant,
 * or one fr may not see (another owner's tenant without a grant reads the same,
 * deliberately) — and is refused before anything is attempted. Any other failure
 * is not an answer and is relayed as the upstream error.
 */
async function resolveTenant(tenantId: string): Promise<Resolved> {
  try {
    const tenant = await adminGetTenant(tenantId);
    if (tenant.archived_at) {
      return {
        ok: false,
        response: jsonResponse(
          {
            error: 'tenant_archived',
            detail: `tenant ${tenantId} ('${tenant.name}') is archived; nobody is added to an archived tenant. Nothing was attempted.`,
          },
          409,
        ),
      };
    }
    return { ok: true, tenant };
  } catch (e) {
    if (isIntegrationError(e) && e.code === 'UPSTREAM_NOT_FOUND') {
      return {
        ok: false,
        response: jsonResponse(
          {
            error: 'tenant_not_found',
            detail:
              `licences does not resolve tenant ${tenantId} for fr: it does not exist, or fr neither ` +
              'owns it nor holds an active grant on it. Nothing was attempted.',
          },
          404,
        ),
      };
    }
    if (isIntegrationError(e)) return { ok: false, response: integrationErrorResponse(e) };
    throw e;
  }
}

async function closeAudit(
  auditId: string,
  values: Partial<typeof provisioningAudit.$inferInsert>,
): Promise<void> {
  try {
    // `result` is MERGED, never replaced: `result.identities` is the identity ledger.
    const { result, ...rest } = values;
    await db
      .update(provisioningAudit)
      .set({
        ...rest,
        ...(result !== undefined
          ? { result: sql`coalesce(${provisioningAudit.result}, '{}'::jsonb) || ${JSON.stringify(result)}::jsonb` }
          : {}),
        updated_at: new Date(),
      })
      .where(eq(provisioningAudit.id, auditId));
  } catch (logErr) {
    console.error('[super-admin] failed to update provisioning_audit row', auditId, logErr);
  }
}

export async function provisionMemberIntoTenant(
  actor: User,
  body: ExistingTenantProvisionInput,
): Promise<Response> {
  // Already lower-cased by ProvisionUserBody; re-applied so this function never
  // depends on its caller for the one key every write below uses.
  const tenantId = body.tenant_id.toLowerCase();
  const resolved = await resolveTenant(tenantId);
  if (!resolved.ok) return resolved.response;
  const tenant = resolved.tenant;

  const [auditRow] = await db
    .insert(provisioningAudit)
    .values({
      actor_user_id: actor.id,
      action: 'provision_user',
      target_email: body.email,
      tenant_id: tenantId,
      payload: {
        mode: 'existing_tenant',
        email: body.email,
        name: body.name,
        tenant_id: tenantId,
        tenant_name: tenant.name,
        workspace_role: body.workspace_role,
        send_password_reset_email: body.send_password_reset_email,
      },
      result: {},
      status: 'pending',
    })
    .returning({ id: provisioningAudit.id });
  if (!auditRow) throw new AppError(500, 'failed to open provisioning_audit row');
  const auditId = auditRow.id;

  try {
    // 1. Keycloak account, stamped with THIS tenant. On a 409 Keycloak keeps the
    //    existing account's attributes untouched — which is exactly what makes the
    //    divergence check below necessary.
    const [firstName, ...rest] = body.name.trim().split(/\s+/);
    //    ⛔ Created DISABLED (George 2026-10-23, fail closed): it is enabled and mailed only as
    //    the LAST action below, after every step that can throw.
    const ledger = auditIdentityLedger(auditId);
    const created = await createUser({
      email: body.email,
      firstName: firstName || body.email,
      lastName: rest.join(' '),
      attributes: { tenant_id: tenantId, tenant_slug: tenant.name },
      enabled: false,
    });
    const userId = created.id;
    if (!created.alreadyExisted) await ledger.record(userId, { minted: true });
    const prior = await ledger.prior(userId, tenantId);

    // 2. An existing account must ALREADY belong to this tenant. Its JWT tenant is
    //    the `tenant_id` attribute, else its `sub` (mirrors `deriveTenantId`). A
    //    failed read THROWS (getUserTenantId) and lands in the catch below: an
    //    unread attribute is never treated as convergence.
    if (created.alreadyExisted) {
      const attr = await keycloak.getUserTenantId(userId);
      const effective = (attr && isValidUuid(attr) ? attr : userId).toLowerCase();
      if (effective !== tenantId) {
        await closeAudit(auditId, {
          target_user_id: userId,
          status: 'error',
          error: `tenant_divergence: account resolves to tenant ${effective}, not ${tenantId}`,
          result: { user_id: userId, already_existed: true, effective_tenant_id: effective },
        });
        return jsonResponse(
          {
            error: 'tenant_divergence',
            detail:
              `${body.email} already has an account in tenant ${effective}. fr never re-tenants a ` +
              `user, so it was not added to ${tenantId}. Nothing was changed.`,
            user_id: userId,
            existing_tenant_id: effective,
          },
          409,
        );
      }
    }

    // 3. Which account is this? `fresh`: minted now, or minted by an earlier attempt of this console
    //    and still DISABLED (the ledger says so). A disabled account this console did NOT mint was
    //    disabled on purpose: it is added to the tenant but never enabled, given a password or
    //    mailed. An active existing account keeps its password.
    const warnings: string[] = [];
    let fresh = !created.alreadyExisted;
    let operatorDisabled = false;
    if (created.alreadyExisted && !(await getUserState(userId)).enabled) {
      // Resumable ONLY while never activated (a minted-then-activated account someone disabled
      // later is an operator decision).
      if (prior.minted && !prior.activated) fresh = true;
      else operatorDisabled = true;
    }
    if (operatorDisabled) {
      warnings.push(
        `account_disabled: ${body.email} exists in fr's realm and is DISABLED; it was added to the ` +
          'tenant but not enabled, given a password or emailed. Enable it in Keycloak if intended.',
      );
    }

    // 4. A one-time temporary password (temporary=true puts UPDATE_PASSWORD on it) for a fresh
    //    account — and for an existing active account that holds NO password credential (without
    //    one nobody could ever log in). An account that already HAS a password is never rotated.
    //    Set on the still-DISABLED account; the email comes only at the very end.
    let temporaryPassword: string | null = null;
    let magicLinkSent = false;
    const issuePassword = fresh || (!operatorDisabled && !(await hasPasswordCredential(userId)));
    if (issuePassword) {
      temporaryPassword = randomBytes(18).toString('base64url');
      await setPassword(userId, temporaryPassword, true);
    }

    // 5. Realm role `member` (direct mapping, idempotent).
    const realmRole = await keycloak.assignRealmRole(userId, REALM_MEMBER_ROLE);

    // 6. fr-local workspace row + role grant. For admin, also the existing realm
    //    `tenant_admin` write-through (never throws; outcome rides the response).
    await ensureWorkspace(tenantId, tenant.name);
    const role = body.workspace_role === 'admin' ? 'workspace-admin' : 'workspace-member';
    await userRolesService.grantRole(userId, tenantId, role, actor.id);
    const keycloakSync: GrantSync | undefined =
      role === 'workspace-admin' ? await syncTenantAdminGrant(userId, tenantId, actor.id) : undefined;

    // 7. Notifications reach every member (George 10-15): drop the cached member
    //    list so the next fan-out includes this person immediately.
    invalidateTenantUserCache(tenantId);

    // 8. ⛔ ACTIVATION — the LAST action (fail closed): enable the account this console minted,
    //    then the ONE set-password email, at most once (recorded before the send).
    if (fresh) {
      await enableUser(userId);
      await ledger.record(userId, { activated: true });
    }
    if (issuePassword && body.send_password_reset_email && !prior.emailSent) {
      await ledger.record(userId, { email_sent: true });
      try {
        await sendUpdatePasswordEmail(userId);
        magicLinkSent = true;
      } catch (mailErr) {
        const detail = mailErr instanceof Error ? mailErr.message : String(mailErr);
        if (isDefiniteSendRefusal(mailErr)) {
          await ledger.record(userId, { email_sent: false });
          warnings.push(`magic_link_email_failed: ${detail}`);
        } else {
          // Uncertain (timeout / 5xx): stays recorded; recovery is the explicit resend action.
          warnings.push(`magic_link_email_uncertain: ${detail}`);
        }
      }
    }

    const result: ProvisionMemberResult = {
      mode: 'existing_tenant',
      user_id: userId,
      tenant_id: tenantId,
      tenant_name: tenant.name,
      already_existed: !fresh,
      temporary_password: temporaryPassword,
      magic_link_sent: magicLinkSent,
      replayed: false,
      workspace_role: body.workspace_role,
      realm_role: realmRole,
      ...(keycloakSync !== undefined ? { keycloak_sync: keycloakSync } : {}),
      warnings,
    };
    await closeAudit(auditId, {
      target_user_id: userId,
      status: 'success',
      // Ids and verdicts only — never the temporary password.
      result: {
        mode: 'existing_tenant',
        user_id: userId,
        tenant_id: tenantId,
        already_existed: !fresh,
        magic_link_sent: magicLinkSent,
        workspace_role: role,
        realm_role: realmRole,
        keycloak_sync: keycloakSync ?? null,
        warnings,
      },
    });
    return jsonResponse(result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await closeAudit(auditId, { status: 'partial', error: message });
    if (isIntegrationError(err)) return integrationErrorResponse(err);
    if (err instanceof AppError) {
      return jsonResponse({ error: err.message, details: err.details }, err.statusCode);
    }
    console.error('[super-admin] existing-tenant provisioning failed:', err);
    return jsonResponse({ error: 'provisioning failed', detail: message }, 500);
  }
}
