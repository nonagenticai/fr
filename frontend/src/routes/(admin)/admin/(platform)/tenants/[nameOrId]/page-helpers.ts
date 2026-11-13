// src/routes/(admin)/admin/(platform)/tenants/[nameOrId]/page-helpers.ts
//
// Pure logic backing /admin/tenants/[nameOrId]. Extracted so vitest can verify
// it under `environment: 'node'` without rendering the component, following the
// same split as the list page next door.
//
// Almost everything here exists to defend ONE semantic: on a provisioning row,
// `offering_code: null` means the provenance is UNKNOWN, not that nothing was
// provisioned. That distinction is a string in a cell — exactly the kind of
// thing a later reader "tidies up" into `?? '—'` — so it is a named, tested
// function rather than an inline fallback at the call site.

import type { TenantOfferingRecord, TenantRecord } from '$lib/api/licenses-admin';

/**
 * What a row with no recorded offering code renders as.
 *
 * ⛔ Do NOT replace this with an em-dash, an empty string, or "none". A blank
 * cell reads as "nothing was provisioned for this product", and these rows may
 * well have been: the posture was either set directly (no offering involved) or
 * it predates licences migration 025, which added the column and could not
 * backfill it because the code had never been recorded anywhere. Saying
 * "nothing" about a row we simply cannot account for is the failure this page
 * was built to prevent.
 */
export const OFFERING_UNKNOWN_LABEL = 'provenance unknown';

/** The note that has to sit next to the table whenever an unknown row is shown. */
export const OFFERING_UNKNOWN_NOTE =
  '“Provenance unknown” does not mean nothing was provisioned. It means we ' +
  'cannot say which offering produced this posture — either it was set ' +
  'directly rather than by provisioning an offering, or it predates the ' +
  'migration that started recording the offering code and could not be ' +
  'backfilled.';

/**
 * licences owns only HALF of what provisioning writes. The other half — the
 * markup rule and the access charge — lives in billing_service and is not
 * fetched, rendered or implied anywhere on this page. The caption states that
 * outright so nobody reads this table as the tenant's commercial picture.
 */
export const OFFERINGS_SCOPE_NOTE =
  'Licensing posture only. Provisioning also writes a markup rule and an ' +
  'access charge to the billing service; neither is shown here.';

/** Human label for the product a posture row is about. */
export function productLabel(
  row: Pick<TenantOfferingRecord, 'app_key' | 'app_name'>,
): string {
  const name = (row.app_name ?? '').trim();
  return name.length > 0 ? name : row.app_key;
}

/**
 * How a row's offering should be rendered, as data rather than as markup.
 *
 * `known: false` is a first-class state with its own copy — never an absence to
 * be papered over by a `??` at the template. A blank or whitespace-only code is
 * folded into the same state: it is no more an offering code than `null` is,
 * and letting it through would print the empty cell this whole helper exists to
 * stop.
 */
export function offeringProvenance(
  row: Pick<TenantOfferingRecord, 'offering_code'>,
): { known: boolean; label: string } {
  const code = (row.offering_code ?? '').trim();
  if (code.length === 0) return { known: false, label: OFFERING_UNKNOWN_LABEL };
  return { known: true, label: code };
}

/** How many rows we cannot account for — drives whether the note is shown. */
export function unknownProvenanceCount(rows: TenantOfferingRecord[]): number {
  return rows.filter((r) => !offeringProvenance(r).known).length;
}

/**
 * Products alphabetically by their visible label, ties broken on the key.
 *
 * Sorting on the LABEL rather than the key matches what the operator is
 * reading; the key tiebreak keeps the order stable for two products sharing a
 * display name.
 */
export function sortOfferings(rows: TenantOfferingRecord[]): TenantOfferingRecord[] {
  return [...rows].sort((a, b) => {
    const byLabel = productLabel(a).localeCompare(productLabel(b));
    return byLabel !== 0 ? byLabel : a.app_key.localeCompare(b.app_key);
  });
}

/**
 * The copy shown when the tenant has NO per-product rows.
 *
 * "No offerings" would read as "this tenant has nothing", which is wrong and
 * alarming: an empty list means there are no per-product OVERRIDES, so every
 * product resolves to the tenant-wide posture — which is a perfectly normal,
 * fully-working configuration. The tenant-wide mode is named in the sentence so
 * the operator can see what everything actually falls back to.
 */
export function describeNoOfferings(tenantByoMode: string): string {
  return (
    'No per-product overrides. Every product falls back to this tenant’s ' +
    `tenant-wide BYO posture (“${tenantByoMode}”). That is a normal ` +
    'configuration, not a missing one.'
  );
}

/**
 * One-line summary above the table.
 *
 * The unknown count is surfaced here rather than left to be discovered cell by
 * cell — an operator auditing provisioning needs to know up front how much of
 * the table cannot be accounted for.
 */
export function describeOfferings(rows: TenantOfferingRecord[]): string {
  const n = rows.length;
  const unknown = unknownProvenanceCount(rows);
  const head = `${n} per-product posture ${n === 1 ? 'row' : 'rows'}.`;
  if (unknown === 0) return head;
  return (
    `${head} ${unknown} of ${n} ${unknown === 1 ? 'has' : 'have'} no recorded ` +
    'offering — their provenance is unknown, not absent.'
  );
}

/**
 * Pill tone for a BYO posture.
 *
 * `byo_required` is `warning`, never `danger`: it is a deliberate, valid
 * posture, not a fault. It is singled out at all because it is the one mode
 * that hard-fails a tenant's runs when they have no key configured, so it is
 * worth an operator's eye — but a red pill would say something is broken.
 */
export function byoTone(mode: string): 'neutral' | 'accent' | 'warning' {
  if (mode === 'byo_required') return 'warning';
  if (mode === 'local_allowed') return 'accent';
  return 'neutral';
}

/**
 * Whether a row's posture differs from the tenant-wide one.
 *
 * Every row in this table is an override, but only some of them actually CHANGE
 * anything; flagging the ones that diverge is what makes the table scannable.
 */
export function overridesTenantDefault(
  row: Pick<TenantOfferingRecord, 'byo_mode'>,
  tenantByoMode: string,
): boolean {
  return row.byo_mode !== tenantByoMode;
}

/** The heading for the detail page: the name, with the realm when there is one. */
export function tenantHeading(
  tenant: Pick<TenantRecord, 'name' | 'keycloak_realm'>,
): string {
  const realm = (tenant.keycloak_realm ?? '').trim();
  return realm.length > 0 ? `${tenant.name} · ${realm}` : tenant.name;
}
