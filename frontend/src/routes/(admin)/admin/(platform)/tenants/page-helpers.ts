// src/routes/(admin)/admin/(platform)/tenants/page-helpers.ts
//
// Pure logic backing /admin/tenants. Extracted so vitest can verify it under
// `environment: 'node'` without rendering the component — the confirm copy in
// particular is the only thing standing between an operator and a
// misunderstanding about what archiving does, so it is unit-tested text rather
// than a string typed inline at the call site.

import { LicensesAdminCallError, type TenantRecord } from '$lib/api/licenses-admin';

/**
 * The tenant name shape, mirroring `TenantName` in
 * `backend/src/routes/admin/licenses-admin.ts`.
 *
 * Client-side so a bad name is a message under the field rather than a 422
 * banner. The server copy is the enforcement — this one only saves a round
 * trip; keep the two in sync.
 */
export const TENANT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Why `name` is not an acceptable tenant name, or null when it is.
 *
 * Returns the REASON, not a boolean: "invalid" alone leaves an operator
 * guessing which of length / case / leading-hyphen they tripped, and the three
 * have different fixes.
 */
export function tenantNameError(name: string): string | null {
  const n = name.trim();
  if (n.length === 0) return 'A name is required.';
  if (n.length > 255) return 'Name must be 255 characters or fewer.';
  if (n !== name) return 'Name must not have leading or trailing spaces.';
  if (!TENANT_NAME_RE.test(n)) {
    return 'Lowercase letters, digits and hyphens only, starting with a letter or digit.';
  }
  return null;
}

/** Whether a tenant is archived. `undefined` (older licences build) is live. */
export function isArchived(t: Pick<TenantRecord, 'archived_at'>): boolean {
  return Boolean(t.archived_at);
}

/**
 * The tenants to show.
 *
 * Archived tenants are withheld unless `showArchived`, because that is the
 * point of the flag. The free-text filter matches name, id and realm so the
 * one box serves every column the table renders.
 */
export function visibleTenants(
  tenants: TenantRecord[],
  opts: { showArchived: boolean; query?: string },
): TenantRecord[] {
  const needle = (opts.query ?? '').trim().toLowerCase();
  return tenants.filter((t) => {
    if (!opts.showArchived && isArchived(t)) return false;
    if (!needle) return true;
    return [t.name, t.id, t.keycloak_realm]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(needle));
  });
}

/**
 * Live tenants first, each block alphabetical.
 *
 * Interleaving them by name alone would scatter the archived rows through the
 * table, so an operator scanning for a real tenant reads greyed-out ones the
 * whole way down. Order is stable for equal keys via `localeCompare` on a
 * unique-by-construction name.
 */
export function sortTenants(tenants: TenantRecord[]): TenantRecord[] {
  return [...tenants].sort((a, b) => {
    const aArch = isArchived(a) ? 1 : 0;
    const bArch = isArchived(b) ? 1 : 0;
    if (aArch !== bArch) return aArch - bArch;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Href for one tenant's detail page.
 *
 * Addressed by `id`, never by `name`. The licences endpoint behind the detail
 * page resolves either — but the name is mutable from this very table, one
 * button away, and a name-built link 404s the moment it is renamed (and a
 * bookmarked one 404s forever). Lives here rather than in the detail route's
 * own helpers so the list page can link without importing across a `[param]`
 * directory.
 */
export function tenantDetailHref(tenant: Pick<TenantRecord, 'id'>): string {
  return `/admin/tenants/${encodeURIComponent(tenant.id)}`;
}

/** How many of these are archived — for the "show archived" toggle's label. */
export function archivedCount(tenants: TenantRecord[]): number {
  return tenants.filter(isArchived).length;
}

/**
 * Confirm copy for archiving or restoring a tenant.
 *
 * The copy states outright that NOTHING is revoked. Both misreadings are
 * expensive and opposite: an operator who thinks archive means delete will
 * never use it and the pick-lists stay full of dead tenants; one who thinks it
 * revokes will archive a live customer expecting their tokens to stop, and
 * they will not. Neither is recoverable from a generic "Are you sure?".
 */
export function describeTenantArchive(
  tenant: Pick<TenantRecord, 'name' | 'archived_at'>,
): string {
  if (isArchived(tenant)) {
    return (
      `Restore “${tenant.name}”?\n\n` +
      'It reappears in tenant pick-lists and can be provisioned into again. ' +
      'Nothing else changes — its licences, tokens and budget were never touched.'
    );
  }
  return (
    `Archive “${tenant.name}”?\n\n` +
    'This REVOKES NOTHING. Its licences, tokens and budget all survive, and ' +
    'every existing token keeps working exactly as it does now.\n\n' +
    'What changes: the tenant disappears from tenant pick-lists and is marked ' +
    '“do not provision into this”. You can restore it at any time.'
  );
}

/**
 * Confirm copy for a rename.
 *
 * A tenant name is an IDENTIFIER, not a label: the licences service resolves
 * `/tenants/{name_or_id}` by name and the edge compares tenant names
 * literally, so anything scripted or bookmarked against the old name breaks
 * the instant this succeeds. The confirm has to say so, and has to show both
 * names — an operator re-reading their own typo is the cheapest check there is.
 */
export function describeTenantRename(
  tenant: Pick<TenantRecord, 'name'>,
  newName: string,
): string {
  return (
    `Rename “${tenant.name}” to “${newName.trim()}”?\n\n` +
    'The name is an identifier, not just a label — anything that addresses this ' +
    'tenant by name (scripts, bookmarks, saved API calls) will stop resolving. ' +
    'Licences and tokens are unaffected.'
  );
}

/**
 * The server's sentence when a create was refused because fr already holds a
 * licences tenant with that name (409 `tenant_name_taken`; names are unique
 * per owning app since licences migration 050), or null for any other failure.
 * Shown under the create form, where the operator can pick another name.
 */
export function tenantNameTakenMessage(err: unknown): string | null {
  if (!(err instanceof LicensesAdminCallError)) return null;
  if (err.status !== 409 || err.code !== 'tenant_name_taken') return null;
  return err.detail || 'fr already has a licences tenant with this name. Choose another name.';
}
