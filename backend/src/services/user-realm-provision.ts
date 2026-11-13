// src/services/user-realm-provision.ts
//
// The super-admin console's onboarding of a NEW person (provision-user and its additional seats),
// with the identity in fr's OWN realm.
//
// ⭐ WHY THIS EXISTS (realm per app, 2026-10-23). fr's users live in `config.keycloak.userRealm`
// (prod: realm `fr`). The provisioning engine only administers ITS realm (`KEYCLOAK_REALM`,
// portal), so letting it create the user — as this console did until the cutover — gave the
// person a PORTAL account that fr's JWTs never present: fr then granted roles to a `sub` nobody
// signs in as, and the engine mailed a generic welcome to it. So, as CommonPractice / agent /
// w2v do: fr mints (or 409-resolves) the identity in its own realm, hands the engine that id as
// a caller-owned identity (`keycloak_user_id`: no Keycloak step, no email on the engine side),
// and only AFTER the engine has landed the tenant and licences does fr issue the password and
// send the one set-password email, in its realm. A failed run sends no email.
//
// ⛔ ORDER (George 2026-10-23, fail closed; audit of fr#1634): the account is minted DISABLED, gets
// its temporary password and realm role, then the engine runs, then the CALLER runs every one of
// its own steps (workspace, role grant, budget, seats, …) — and only then `activate()` enables the
// account and sends the ONE set-password email, as the very last action. Any failure before that
// leaves a disabled account and zero emails. `activate()` never sends a second email: what this
// console minted and mailed is recorded in an `IdentityLedger` (the provisioning_audit rows), so a
// retry after a failure sends exactly one and a retry after success sends none.

import { randomBytes } from 'node:crypto';

import {
  createUser,
  enableUser,
  getUserState,
  hasPasswordCredential,
  mergeUserAttributes,
  sendUpdatePasswordEmail,
  setPassword,
} from './keycloak-admin';
import { keycloak } from './keycloak';
import { provisionUser, type ProvProvisionResult } from './provisioning';
import { isIntegrationError } from '../integrations/_lib/errors';

/**
 * A DEFINITE Keycloak refusal of a send (a 4xx): the email certainly did not go out, so its
 * at-most-once record may be withdrawn. A timeout, network error or 5xx is NOT definite — the
 * mail may have left — so the record stays and a retry never sends a second one (recovery is the
 * explicit super_admin "resend set-password email" action).
 */
export function isDefiniteSendRefusal(err: unknown): boolean {
  return isIntegrationError(err) && typeof err.upstreamStatus === 'number' && err.upstreamStatus >= 400 && err.upstreamStatus < 500;
}

/** The realm role every provisioned person holds (what the engine used to map in portal). */
export const USER_REALM_MEMBER_ROLE = 'member';

export type UserRealmProvisionInput = Parameters<typeof provisionUser>[0];

/**
 * Durable record of what THIS console did to an fr-realm account (super-admin.ts keeps it in
 * `provisioning_audit.result.identities[<user id>]`). `minted`: the account was created by this
 * console (so a later run may activate it while it is still disabled). `emailSent`: the one
 * set-password email already went out for this scope (tenant slug / tenant id).
 */
export interface IdentityLedger {
  /** `scope`: the tenant slug (new tenant) or tenant id (existing-tenant member add). */
  prior(userId: string, scope: string): Promise<{ minted: boolean; activated: boolean; emailSent: boolean }>;
  record(userId: string, patch: { minted?: true; activated?: true; email_sent?: boolean }): Promise<void>;
}

export interface PreparedIdentity {
  /** The engine's result; `temporary_password` / `already_existed` describe what fr did. */
  prov: ProvProvisionResult;
  /**
   * Enable the account (if this console minted it) and send the one set-password email (if asked
   * for and not already sent). The CALLER's last action. A failed email is a warning, not a throw.
   */
  activate(): Promise<{ magicLinkSent: boolean; warnings: string[] }>;
}

export async function prepareInUserRealm(
  input: UserRealmProvisionInput,
  ledger: IdentityLedger,
): Promise<PreparedIdentity> {
  // 1. The identity, in fr's realm, DISABLED. 409 → the existing account (never re-tenanted).
  const [firstName, ...rest] = input.name.trim().split(/\s+/);
  const created = await createUser({
    email: input.email,
    firstName: firstName || input.email,
    lastName: rest.join(' '),
    enabled: false,
  });
  const userId = created.id;
  // Recorded BEFORE anything else: a later run must be able to tell "the account an earlier
  // attempt of this console minted and never activated" from "an account someone disabled".
  if (!created.alreadyExisted) await ledger.record(userId, { minted: true });

  // 2. Which account is this?
  //    fresh            — minted now, or minted by an earlier attempt of this console and still
  //                       disabled: password, tenant stamp, enable + email at activation.
  //    operatorDisabled — disabled, and NOT minted by this console: someone disabled it on
  //                       purpose. Licensed (the engine still runs) but never enabled, given a
  //                       password or mailed.
  //    active           — an existing enabled account: password only if it has none.
  const prior = await ledger.prior(userId, input.tenantSlug);
  let fresh = !created.alreadyExisted;
  let operatorDisabled = false;
  let hasPassword = false;
  if (created.alreadyExisted) {
    const state = await getUserState(userId);
    if (!state.enabled) {
      // Resumable ONLY while it was never activated: an account this console minted, activated
      // and someone later DISABLED is an operator decision, exactly like any other disabled one.
      if (prior.minted && !prior.activated) fresh = true;
      else operatorDisabled = true;
    } else {
      hasPassword = await hasPasswordCredential(userId);
    }
  }
  const warnings: string[] = [];
  if (operatorDisabled) {
    warnings.push(
      `account_disabled: ${input.email} exists in fr's realm and is DISABLED; it was licensed but not ` +
        'enabled, given a password or emailed. Enable it in Keycloak if that is intended.',
    );
  }

  // 3. Password + realm role — on the still-DISABLED account, before the engine. If either fails
  //    the account stays disabled and nothing was mailed.
  let temporaryPassword: string | null = null;
  if (fresh || (!operatorDisabled && !hasPassword)) {
    temporaryPassword = randomBytes(18).toString('base64url');
    await setPassword(userId, temporaryPassword, true);
  }
  await keycloak.assignRealmRole(userId, USER_REALM_MEMBER_ROLE);

  // 4. The engine: tenant + licences + quota for THIS identity (no Keycloak step, no email there).
  const prov = await provisionUser({ ...input, sendPasswordResetEmail: false, keycloakUserId: userId });
  if (prov.keycloak_user_id !== userId) {
    // Fail closed: an engine that predates caller-owned identities would have minted its own.
    throw new Error(
      `provisioning resolved user ${prov.keycloak_user_id}, not the fr-realm identity ${userId}; ` +
        'deploy provisioning with keycloak_user_id support',
    );
  }

  // 5. Tenant attributes on a fresh account (the JWT tenant). An existing account is never
  //    re-tenanted: the route's convergence check reports it instead.
  if (fresh) {
    await mergeUserAttributes(userId, { tenant_id: prov.tenant_id, tenant_slug: input.tenantSlug });
  }

  let activated = false;
  return {
    prov: {
      ...prov,
      keycloak_user_id: userId,
      already_existed: !fresh,
      temporary_password: temporaryPassword,
      magic_link_sent: false,
      warnings: [...prov.warnings, ...warnings],
    },
    async activate() {
      if (activated) throw new Error('activate() called twice');
      activated = true;
      if (operatorDisabled) return { magicLinkSent: false, warnings: [] };
      if (fresh) {
        await enableUser(userId);
        await ledger.record(userId, { activated: true });
      }
      if (!input.sendPasswordResetEmail || prior.emailSent) return { magicLinkSent: false, warnings: [] };
      // AT MOST ONCE: recorded before the send, so a crash after Keycloak accepted it can never
      // lead a retry to mail the person a second time. A definite refusal un-records it.
      await ledger.record(userId, { email_sent: true });
      try {
        await sendUpdatePasswordEmail(userId);
      } catch (mailErr) {
        const detail = mailErr instanceof Error ? mailErr.message : String(mailErr);
        if (isDefiniteSendRefusal(mailErr)) {
          await ledger.record(userId, { email_sent: false });
          return { magicLinkSent: false, warnings: [`magic_link_email_failed: ${detail}`] };
        }
        // Uncertain (timeout / 5xx): it may have been delivered — stays recorded, never re-sent
        // automatically. Recovery: the super_admin "resend set-password email" action.
        return { magicLinkSent: false, warnings: [`magic_link_email_uncertain: ${detail}`] };
      }
      return { magicLinkSent: true, warnings: [] };
    },
  };
}
