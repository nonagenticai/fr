// src/lib/super-admin-switch.ts
//
// ⭐ George 2026-10-27: "fr-test is just the test login i use for all my apps and
// i just need to be able to work as a tenant-admin in every tenant i open."
//
// A super-admin whose request carries an ACCEPTED workspace switch
// (`X-Active-Tenant`, middleware/request-context.ts) acts as a TENANT-ADMIN of
// the active workspace — on every path, not only the read lanes. This module
// answers the one question every gate asks: "is THIS request a super-admin
// switched into `tenantId`?" — from the request frame only.
//
// Why the frame and nothing else: `buildRequestContext` is the single place the
// switch is decided, from the SIGNED `super_admin` realm role and the switch
// decision (`decideActiveTenantSwitch` → lib/super-admin-switch-target.ts: a
// platform tenant, the caller's own, or any existing non-archived workspace for a
// human). It has already refused a non-permitted target (403
// `active_tenant_not_permitted` + reason) before any handler runs, and it never
// honours the header for a non-super-admin, an fr-agent token or a licence
// token (no signed claims). So nothing a client sends can make this true by
// itself. Every such request is audited (lib/super-admin-tenant-audit.ts).
//
// ⛔ NOT a general super-admin widening. Un-switched (home view) a super-admin
// is admin of their OWN claimed tenant only, via the realm composite
// (`isRealmTenantAdminOf`).

import { tryGetRequestContext } from '../integrations/_lib/context';
import { isSuperAdmin } from './super-admin-gate';

/**
 * The tenant a super-admin has SWITCHED this request into, or `undefined` when
 * the request is not such a switch (no frame, JWT tenant, an
 * unsigned/agent/licence caller, a super_admin that is not on an fr super-admin
 * session, or the "switch" names the caller's own home).
 */
export function superAdminSwitchedTenant(): string | undefined {
  const ctx = tryGetRequestContext();
  if (!ctx) return undefined;
  if (ctx.activeTenantVia !== 'active-tenant-header') return undefined;
  if (ctx.callerIsSuperAdmin !== true) return undefined;
  // George 2026-10-27 decision: the tenant-admin arm is honoured ONLY for an fr
  // super-admin session (fr realm issuer + fr's browser client, a human). A
  // portal-issued super_admin (e.g. a bot via portal-bff) gets none of it.
  if (ctx.callerIsFrSuperAdminSession !== true) return undefined;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || tenantId.length === 0) return undefined;
  if (tenantId === ctx.jwtTenantId) return undefined;
  return tenantId;
}

/**
 * True iff this request is a super-admin switched into `tenantId` and the
 * frame's (signed) user is `userId`. For callers that hold only an id — e.g.
 * the agent project-membership provider — the frame's `callerIsSuperAdmin` is
 * the signed proof.
 */
export function frameIsSuperAdminSwitchedInto(
  userId: string | null | undefined,
  tenantId: string | null | undefined,
): boolean {
  if (typeof userId !== 'string' || userId.length === 0) return false;
  if (typeof tenantId !== 'string' || tenantId.length === 0) return false;
  return superAdminSwitchedTenant() === tenantId && tryGetRequestContext()?.userId === userId;
}

/**
 * True iff this request is a super-admin switched into `tenantId` AND the
 * subject the gate is deciding for is that same signed super-admin (their
 * roles carry `super_admin`; when an id is given it must be the frame's user).
 */
export function isSuperAdminSwitchedInto(
  subject: { id?: string; roles?: readonly string[] },
  tenantId: string | null | undefined,
): boolean {
  if (typeof tenantId !== 'string' || tenantId.length === 0) return false;
  if (!isSuperAdmin(subject)) return false;
  if (superAdminSwitchedTenant() !== tenantId) return false;
  if (subject.id !== undefined && tryGetRequestContext()?.userId !== subject.id) return false;
  return true;
}
