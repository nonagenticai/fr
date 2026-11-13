// src/lib/licence-door.ts
//
// The LICENCE door on the n8n system routes (George 2026-10-10): a customer's /
// local n8n reaches fr ONLY with its n8n-nodes-fr credential's licence token, so
// it must never hold fr's shared `N8N_WEBHOOK_SECRET` or an `X-Internal-Token`.
// Every resource such a route reads or writes is bound to the licence's tenant,
// which is PINNED by `lib/licence-introspect.ts` (no header can move it, no
// realm role is ever derived from it).
//
// ⛔ G4 (George 2026-10-10): the SHARED-SECRET door is GONE on every route the
// n8n node calls: report, plan-ledger, bug-fix-for-card, write-set and (G5)
// card-approval accept ONLY a licence (`licenceOnly` below); card-phase-lease
// and (G5) execution-approvals accept a licence or a Keycloak JWT
// through `validateAuth`. An `X-Webhook-Secret` header there is ignored: a
// secret-only request is 401.
//
// ⭐ G5 (George 2026-10-10): a licence caller is the tenant's CONVEYOR SEAT and
// may MINT every gate kind the secret door minted — qa.coverage_signoff
// (COVERAGE), MERGE / SPLIT / DROP deblocks, phase-advance, canary, the bug-fix
// authorization marker — TENANT-BOUND: the project / card / board / lists (and,
// for a MERGE, the PR's repository — `assertLicencePrOnProjectRepo`) must belong
// to the licence's tenant, with the same validation the secret door ran.
// Minting is not deciding: every decide path and self-approval guard is
// untouched, and a Keycloak JWT still cannot mint the system kinds.
// The secret itself is NOT retired: fr still SENDS it outbound to n8n, and the
// other inbound n8n routes (approval-request, execution-event, router-dedupe, …)
// still verify it.
//
// ⛔ WHAT A LICENCE CALLER STILL NEVER GETS. The old secret door was the SYSTEM:
// it could name any tenant (including a platform tenant with no reference),
// choose an n8n callback path, page an arbitrary phone number, address an
// approval to any user, link an arbitrary learning card. A licence caller gets
// none of those — each route documents what it refuses — and every refusal
// happens BEFORE any write.

import { validateAuth } from '../middleware/auth';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { keycloak } from '../services/keycloak';
import { isLicenceBearer } from './licence-introspect';
import { defaultParentBoardResolver } from './planka-parent-board';
import type { User } from '../types/api';
import { parseGithubRepo } from '../services/repo-access';

/** The one refusal code for "this resource is not in the licence's tenant". */
export const LICENCE_TENANT_MISMATCH_CODE = 'licence_tenant_mismatch' as const;
/** A body field that selects a SYSTEM power the licence door does not grant. */
export const LICENCE_FIELD_FORBIDDEN_CODE = 'licence_field_forbidden' as const;

/** The licence door (licence-only routes): a tenant-pinned licence caller. */
export type LicenceDoor = { kind: 'licence'; user: User; tenantId: string };

/**
 * True when the request carries a licence-shaped bearer and no shared secret.
 * Used by `routes/internal-computed-checks.ts` to pick the licence door over the
 * `X-Internal-Token` door its non-n8n kinds keep.
 */
export function isLicenceDoorRequest(req: Request): boolean {
  if (req.headers.get('X-Webhook-Secret') !== null) return false;
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return false;
  let token: string;
  try {
    token = keycloak.extractToken(authHeader);
  } catch {
    return false;
  }
  return isLicenceBearer(token);
}

/**
 * Authenticate a licence caller through `validateAuth` (the one entry point).
 * Throws 401 unless the answer is a licence identity with a tenant.
 */
export async function requireLicenceCaller(req: Request): Promise<{ user: User; tenantId: string }> {
  const user = await validateAuth(req);
  if (user.authKind !== 'licence' || !user.tenantId) {
    throw new UnauthorizedError('This route accepts an fr licence token only (X-Webhook-Secret is not accepted)');
  }
  return { user, tenantId: user.tenantId.toLowerCase() };
}

/**
 * G4: the licence door ALONE. No `X-Webhook-Secret` fallback — a secret-only
 * request (no bearer), a Keycloak JWT, or a licence the licences service refuses
 * is 401 (502/504 on a licences outage, from `validateAuth`).
 */
export async function licenceOnly(req: Request): Promise<LicenceDoor> {
  return { kind: 'licence', ...(await requireLicenceCaller(req)) };
}

export function sameTenant(a: string | null | undefined, b: string): boolean {
  return typeof a === 'string' && a.length > 0 && a.toLowerCase() === b.toLowerCase();
}

/** 403 `licence_tenant_mismatch` — the write-route refusal (card-phase-lease shape). */
export function licenceTenantMismatch(what: string): ForbiddenError {
  return new ForbiddenError(
    `${what} is not in the licence's tenant; a licence caller may act only on its own tenant's resources. Nothing was written`,
  ).withCode(LICENCE_TENANT_MISMATCH_CODE);
}

export const LICENCE_CANNOT_DECIDE_CODE = 'licence_cannot_decide' as const;

/**
 * ⛔ MINTING ≠ DECIDING (George 2026-10-10). A licence caller is the tenant's conveyor seat: it
 * may RAISE every gate kind, but deciding (approve / reject / void) stays human. A licence's id
 * is a licences Subject.id, not a person, and its minted rows carry no `requested_by_user_id`,
 * so nothing downstream could tell a licence deciding its own gate from a human. Refused at the
 * door of every decide route — before any read, whatever the roster says — 403
 * `licence_cannot_decide`, nothing written.
 */
export function assertNotLicenceDecider(user: Pick<User, 'authKind'>): void {
  if (user.authKind === 'licence') {
    throw new ForbiddenError(
      'A licence token may raise approvals but never decide them (approve, reject or void); a human must decide. Nothing was written',
    ).withCode(LICENCE_CANNOT_DECIDE_CODE);
  }
}

/** 403 `licence_field_forbidden` — a system-only body field on the licence door. */
export function licenceFieldForbidden(field: string, why: string): ForbiddenError {
  return new ForbiddenError(
    `${field} cannot be set by a licence caller: ${why}. Nothing was written`,
  ).withCode(LICENCE_FIELD_FORBIDDEN_CODE);
}

// --- Planka parent-board lookup (licence door's card/list → board binding) ----
// Default: lib/planka-parent-board.ts (null on 404 / any error ⇒ "not yours").
export function licenceParentBoard(kind: 'card' | 'list', id: string): Promise<string | null> {
  return defaultParentBoardResolver(kind, id);
}

// --- MERGE: the PR must be in the project's repository (G5) ------------------
/** The fields that name the pull request a MERGE deblock merges. */
export const PR_FIELDS = ['pr_url', 'pr_repo_owner', 'pr_repo_name', 'pr_number'] as const;

/**
 * G5: a licence caller may mint a MERGE, but only of a PR in the repository of a
 * project in its own tenant. A MERGE's PR fields name a repo + PR that fr's
 * platform credential merges, so an unbound repo would let a tenant merge any
 * repo the platform can write. No-op when no PR field is set. Otherwise the
 * project's `repository_url` must parse as a GitHub repo, `pr_repo_owner` /
 * `pr_repo_name` (when sent) must name it, and `pr_url` (when sent) must point
 * into it — case-insensitively. No project (a stream board) ⇒ refused.
 * Refusal: 403 licence_tenant_mismatch.
 */
export function assertLicencePrOnProjectRepo(
  fields: Record<string, unknown>,
  repositoryUrl: string | null | undefined,
): void {
  const present = PR_FIELDS.filter((k) => fields[k] !== undefined && fields[k] !== null);
  if (present.length === 0) return;
  const repo = typeof repositoryUrl === 'string' ? parseGithubRepo(repositoryUrl) : null;
  if (!repo) throw licenceTenantMismatch('a pull request on a target with no GitHub repository');
  const eqi = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  const what = (v: unknown) => `pull request repository ${String(v)}`;
  if (fields.pr_repo_owner != null && !eqi(fields.pr_repo_owner, repo.owner)) throw licenceTenantMismatch(what(fields.pr_repo_owner));
  if (fields.pr_repo_name != null && !eqi(fields.pr_repo_name, repo.repo)) throw licenceTenantMismatch(what(fields.pr_repo_name));
  if (fields.pr_url != null) {
    const prRepo = typeof fields.pr_url === 'string' ? parseGithubRepo(fields.pr_url) : null;
    if (!prRepo || !eqi(prRepo.owner, repo.owner) || !eqi(prRepo.repo, repo.repo)) throw licenceTenantMismatch(what(fields.pr_url));
  }
}
