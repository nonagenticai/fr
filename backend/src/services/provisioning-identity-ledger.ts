// src/services/provisioning-identity-ledger.ts
//
// The super-admin console's identity ledger (services/user-realm-provision.ts `IdentityLedger`),
// shared by provision-user (new tenant + seats, routes/admin/super-admin.ts) and the existing-tenant
// member add (routes/admin/super-admin-member.ts). Kept in the provisioning_audit rows, so it needs
// no table of its own.

import { and, eq, sql } from 'drizzle-orm';

import { db, provisioningAudit } from '../db/client';
import type { IdentityLedger } from './user-realm-provision';

/**
 * The identity ledger of this console (user-realm-provision.ts `IdentityLedger`), kept in
 * `provisioning_audit.result.identities[<fr user id>]` of the provision_user rows: which fr-realm
 * accounts THIS console minted (so a retry may activate one an earlier attempt left disabled)
 * and whether the one set-password email already went out for a scope — the tenant slug, or the
 * tenant id of an existing-tenant member add (never twice).
 */
export function auditIdentityLedger(auditId: string): IdentityLedger {
  return {
    async prior(userId, scope) {
      const rows = await db
        .select({
          rec: sql<Record<string, unknown> | null>`${provisioningAudit.result} -> 'identities' -> ${userId}::text`,
          // The run's scope: the slug (new tenant) or the tenant id (existing-tenant member add).
          slug: sql<string | null>`coalesce(${provisioningAudit.payload} ->> 'tenant_slug', ${provisioningAudit.payload} ->> 'tenant_id')`,
        })
        .from(provisioningAudit)
        .where(
          and(
            eq(provisioningAudit.action, 'provision_user'),
            sql`jsonb_exists(coalesce(${provisioningAudit.result} -> 'identities', '{}'::jsonb), ${userId}::text)`,
          ),
        );
      const recs = (Array.isArray(rows) ? rows : []).filter(
        (r): r is { rec: Record<string, unknown>; slug: string | null } =>
          !!r && typeof r === 'object' && !!(r as { rec?: unknown }).rec && typeof (r as { rec?: unknown }).rec === 'object',
      );
      return {
        minted: recs.some((r) => r.rec.minted === true),
        activated: recs.some((r) => r.rec.activated === true),
        emailSent: recs.some((r) => r.slug === scope && r.rec.email_sent === true),
      };
    },
    async record(userId, patch) {
      const identities = sql`coalesce(${provisioningAudit.result} -> 'identities', '{}'::jsonb)`;
      await db
        .update(provisioningAudit)
        .set({
          result: sql`coalesce(${provisioningAudit.result}, '{}'::jsonb) || jsonb_build_object('identities', ${identities} || jsonb_build_object(${userId}::text, coalesce(${identities} -> ${userId}::text, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb))`,
          updated_at: new Date(),
        })
        .where(eq(provisioningAudit.id, auditId));
    },
  };
}
