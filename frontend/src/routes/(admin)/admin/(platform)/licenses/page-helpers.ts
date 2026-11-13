// src/routes/(admin)/admin/(platform)/licenses/page-helpers.ts
//
// Pure logic backing the licensing console pages. Extracted so vitest can
// verify it under `environment: 'node'` without rendering the components.

import type {
  AppRecord,
  LicenseRecord,
  PersonRecord,
  PlanRecord,
  TenantRecord,
  TenantSeatCount,
  TenantOfferingRecord,
} from '$lib/api/licenses-admin';
import type { ComboOption } from '$lib/components/ui';
import {
  RATE_LIMIT_ENFORCED,
  RATE_LIMIT_NOT_ENFORCED_SUFFIX,
} from '$lib/admin/rate-limit-enforcement';

/** Format an ISO timestamp as a locale date; em-dash for null. */
export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

/** Human label for an app: name, disambiguated by the key the edge enforces. */
export function appLabel(app: Pick<AppRecord, 'key' | 'name'>): string {
  return app.name && app.name !== app.key ? `${app.name} (${app.key})` : app.key;
}

/**
 * Human label for a plan, surfacing the limits that actually differ between
 * plans. `null` means unlimited/perpetual upstream, which is NOT the same as
 * zero and must never render as "0".
 *
 * ⛔ 2026-09-26 (fr#1046): the rpm bit carries `(not enforced)`. Measured by
 * whole-tree grep with a positive control — `rate_limit_rpm` is written by the
 * admin API and typed through the proxy, and is compared by NOTHING. This is
 * the ONLY site that renders the value, so it is the only site where a bare
 * number could be mistaken for a live limit. Full evidence and the reason it
 * is labelled rather than enforced: $lib/admin/rate-limit-enforcement.
 */
export function planLabel(plan: PlanRecord): string {
  const bits: string[] = [];
  if (plan.rate_limit_rpm != null) {
    bits.push(
      RATE_LIMIT_ENFORCED
        ? `${plan.rate_limit_rpm} rpm`
        : `${plan.rate_limit_rpm} rpm${RATE_LIMIT_NOT_ENFORCED_SUFFIX}`,
    );
  }
  if (plan.quota_monthly != null) bits.push(`${plan.quota_monthly}/mo`);
  bits.push(plan.duration_days != null ? `${plan.duration_days}d` : 'perpetual');
  return `${plan.code} — ${bits.join(', ')}`;
}

/**
 * Test/demo residue left in the licenses catalog by integration tests writing
 * to the prod DB (`inttest-*`, `demo-app-*`, …).
 *
 * The backend already filters these; this mirror is defence-in-depth so a
 * picker degrades gracefully if the residue returns before the root cause (a
 * test config pointed at prod) is fixed. Keep in sync with
 * `TEST_APP_KEY_RE` in backend/src/routes/admin/licenses-admin.ts and
 * `JUNK_RE` in the licenses repo's scripts/purge_test_apps.py.
 */
export const TEST_APP_KEY_RE =
  /^(?:inttest-|demo-app(?:-|$)|test-|dbg\d*-|debug-|probe-|app-)/;

export function isTestApp(key: string): boolean {
  return TEST_APP_KEY_RE.test(key);
}

/** Real apps only, sorted by the key the edge enforces. */
export function usableApps(apps: AppRecord[]): AppRecord[] {
  return apps
    .filter((a) => !a.revoked && !isTestApp(a.key))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The apps a HUMAN can be provisioned onto.
 *
 * The licence registry holds 47 apps; only these 7 are end-user products. The
 * rest are internal platform modules whose licences are held by SERVICES, or
 * n8n custom-node action packages held by automation. `seed_apps.py` states
 * the rule outright — fr drives kanban/n8n/kag/requirements on the user's
 * behalf and "those need no per-user license".
 *
 * Why this is a hardcoded list and not a query: the `app` row carries no
 * `audience`/`surface` column, and neither available proxy is safe.
 * `token_type='internal'` misclassifies the 13 `*_Module` rows that were
 * minted as ordinary `api` tokens for n8n credentials. Adding
 * `app.audience IN ('human','platform','automation')` to the licences schema
 * is the real fix; until then an explicit list is the only correct option, and
 * an explicit list beats a silent wrong one.
 *
 * What the uncurated picker actually cost (measured 2026-08-26): an operator
 * ticked `coding`, `n8n` and `observability` for one person because the form
 * offered them, then the run aborted 10.8s in on `meta_prompt_core_actions` —
 * an n8n action package with no active plan — leaving five orphaned licences
 * behind. Every human-held "platform" licence in production traces back to
 * either this picker or two bootstrap identities.
 *
 * The classification now lives in the licences service as `app.audience`
 * (migration 022), so there is no list here to keep in sync with anything. Two
 * hardcoded copies used to sit in this file and in
 * `backend/src/routes/admin/super-admin.ts`, pinned together by a drift test —
 * safe, but a judgement about ANOTHER service's data, held in this repo. The
 * data answers it now.
 */

/**
 * The result of narrowing the catalogue to apps a person may hold.
 *
 * Deliberately NOT a bare `AppRecord[]`. A licences deployment older than
 * migration 022 omits `audience` from every row, and `filter(a => a.audience
 * === 'human')` over such a catalogue returns `[]` — rendering an empty picker
 * that looks exactly like a correctly-empty one. "47 rows, none carry the
 * field" is a version mismatch and must be reported as one; "47 rows, none are
 * human" is a real answer. The caller cannot tell them apart from an array.
 */
export type ProvisionableApps =
  | { status: 'ok'; apps: AppRecord[] }
  | { status: 'catalogue_missing_audience'; total: number };

/**
 * Apps offerable when provisioning a person. Narrower than `usableApps`, which
 * still backs the grants console, the offerings editor and per-(tenant,app)
 * BYO mode — all three legitimately operate on platform apps.
 *
 * What the uncurated picker cost (measured 2026-08-26): an operator ticked
 * `coding`, `n8n` and `observability` for one person because the form offered
 * them, then the run aborted 10.8s in on `meta_prompt_core_actions` — an n8n
 * action package with no active plan — leaving five orphaned licences behind.
 */
export function provisionableApps(apps: AppRecord[]): ProvisionableApps {
  const usable = usableApps(apps);
  if (usable.length > 0 && usable.every((a) => a.audience === undefined)) {
    return { status: 'catalogue_missing_audience', total: usable.length };
  }
  return { status: 'ok', apps: usable.filter((a) => a.audience === 'human') };
}

/** Plans a license can actually be granted on. */
export function selectablePlans(plans: PlanRecord[]): PlanRecord[] {
  return plans.filter((p) => !p.revoked);
}

export type LicenseState = 'active' | 'expired' | 'revoked' | 'pending' | 'unknown';

/**
 * Resolve what a license IS right now, rather than trusting `status` alone.
 *
 * `status` is a stored column: a license that has sailed past `expires_at`
 * still reads `active` until something updates it. Showing that verbatim would
 * tell an operator a dead license is live — so expiry is checked against the
 * clock and wins.
 */
export function licenseState(
  lic: Pick<LicenseRecord, 'status' | 'expires_at'>,
): LicenseState {
  if (lic.status === 'revoked') return 'revoked';
  if (lic.expires_at) {
    const exp = new Date(lic.expires_at);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() <= Date.now()) return 'expired';
  }
  if (lic.status === 'active') return 'active';
  if (lic.status === 'pending') return 'pending';
  if (lic.status === 'expired') return 'expired';
  return 'unknown';
}

/** Pill tone per state — `revoked`/`expired` must not read as healthy. */
export function stateTone(state: LicenseState): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (state) {
    case 'active':
      return 'success';
    case 'pending':
      return 'warning';
    case 'expired':
    case 'revoked':
      return 'danger';
    default:
      return 'neutral';
  }
}

// --- dropdown option builders (every super-admin field is a picker) --------

/** A person as a picker option: name up top, email/username underneath — never the sub. */
export function personOption(p: PersonRecord): ComboOption {
  const sub = [p.email, p.username].filter((x) => x && x !== p.name).join(' · ');
  return { value: p.id, label: p.name, sublabel: sub || undefined };
}

/** Grantable apps → searchable options (real apps only, sorted). */
export function appOptions(apps: AppRecord[]): ComboOption[] {
  return usableApps(apps).map((a) => ({ value: a.id, label: appLabel(a), sublabel: a.key }));
}

/** Live plans for an app → options; revoked plans are not selectable. */
export function planOptions(plans: PlanRecord[]): ComboOption[] {
  return selectablePlans(plans).map((p) => ({ value: p.id, label: planLabel(p) }));
}

/** Tenants → options; label is the friendly name, sublabel the id for disambiguation. */
export function tenantOptions(tenants: TenantRecord[]): ComboOption[] {
  return [...tenants]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ value: t.id, label: t.name, sublabel: t.byo_mode }));
}

/**
 * Free-text filter over a license list. Matches app key/name, plan code,
 * tenant id and status — the columns shown — and ALSO the raw `subject_id`,
 * which is deliberately NOT a column: it stays searchable so an operator holding
 * a subject id from billing or a support ticket can still find the row, without
 * the page displaying person identity as a property of a licence.
 */
export function filterLicenses(
  licenses: LicenseRecord[],
  q: string,
): LicenseRecord[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return licenses;
  return licenses.filter((l) =>
    [
      l.app?.key,
      l.app?.name,
      l.plan?.code,
      l.subject_id,
      l.tenant_id,
      l.status,
    ]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(needle)),
  );
}

/**
 * Summarise what deleting an app would destroy.
 *
 * `DELETE /apps/{id}` is a hard cascade — plans, licenses AND tokens — with no
 * "still referenced" guard upstream (unlike DELETE /plans, which 409s). The
 * count of LIVE licenses is the only warning an operator gets, so the confirm
 * copy is built from real data, never a generic "are you sure?".
 */
export function describeAppDeletion(app: AppRecord, licenses: LicenseRecord[]): string {
  const live = licenses.filter((l) => licenseState(l) === 'active').length;
  const total = licenses.length;
  if (total === 0) {
    return `Delete “${appLabel(app)}”? It has no licenses. This cannot be undone.`;
  }
  const livePart =
    live > 0
      ? `${live} of them ${live === 1 ? 'is' : 'are'} ACTIVE and will stop working immediately`
      : 'none of them are active';
  return (
    `Delete “${appLabel(app)}”? This also deletes ${total} license${total === 1 ? '' : 's'} ` +
    `and every token issued against ${total === 1 ? 'it' : 'them'} — ${livePart}. This cannot be undone.`
  );
}

/**
 * What the tenant-offerings read-back on /admin/licenses/offerings should show.
 *
 * This is a function rather than a chain of template `{#if}`s because it encodes
 * one claim that is easy to get wrong and invisible in review: **a failed read
 * is not an empty list.** `[]` is a legitimate, meaningful state — a tenant with
 * no per-product overrides, inheriting its tenant-wide posture — so rendering it
 * when the read FAILED asserts "nothing is provisioned" on no evidence, about a
 * tenant that may well have plenty.
 *
 * The ordering matters and is the whole point: error is checked before empty,
 * and `null` (never loaded / failed) is distinguished from `[]` (loaded, empty).
 */
export type OfferingsReadback =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'rows' };

export function offeringsReadback(state: {
  tenantId: string | null;
  busy: boolean;
  error: string | null;
  offerings: readonly unknown[] | null;
}): OfferingsReadback {
  if (!state.tenantId) return { kind: 'idle' };
  if (state.busy) return { kind: 'loading' };
  if (state.error !== null) return { kind: 'error', message: state.error };
  if (state.offerings === null) return { kind: 'idle' };
  if (state.offerings.length === 0) return { kind: 'empty' };
  return { kind: 'rows' };
}

// ===========================================================================
// TENANT-FIRST grants console.
//
// The model this encodes, taken from the licensing service's own source
// (`licenses/main.py:2080` — ">1 is NORMAL: seats are minted per subject, apps
// are sold per tenant"): there are THREE layers, not one.
//
//   1. a tenant buys a BUNDLE            (unbuilt upstream — not shown here)
//   2. a tenant has an OFFERING provisioned  (per product, per tenant)
//   3. a SEAT is minted per PERSON       (a licence row, `subject_id NOT NULL`)
//
// The console used to implement (3) alone and present it as the whole model: it
// asked for a PERSON, then offered EVERY tenant unfiltered, and never showed
// whether the tenant was entitled or how many seats it already held. Since
// `GET /internal/tenants/{id}/seat-count` is billing's per-seat denominator, a
// mis-targeted seat charges the wrong tenant, silently.
//
// So the tenant is the subject of the operation, and the person field stays —
// a seat IS a person. The helpers below exist to keep three honesty rules out
// of template `{#if}` chains, where they are invisible in review.
// ===========================================================================

/**
 * What the seat-count panel should show.
 *
 * ⛔ THE DEFECT THIS DELETES: `catch { count = 0 }`. An unreadable denominator
 * rendered as `0` asserts "this tenant has no seats" — a claim about BILLING —
 * on the evidence of a failed HTTP call. `unknown` is a distinct kind precisely
 * so no branch can reach a number without a payload.
 *
 * `idle` (no tenant chosen) and `unknown` (chosen, read failed) are also kept
 * apart: only one of them is an incident.
 */
export type SeatCountReadback =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'unknown'; message: string }
  | { kind: 'ok'; count: TenantSeatCount };

export function seatCountReadback(state: {
  tenantId: string | null;
  busy: boolean;
  error: string | null;
  count: TenantSeatCount | null;
}): SeatCountReadback {
  if (!state.tenantId) return { kind: 'idle' };
  if (state.busy) return { kind: 'loading' };
  if (state.error !== null) return { kind: 'unknown', message: state.error };
  // No payload and no error is still not zero — the read simply has not landed.
  if (state.count === null) return { kind: 'unknown', message: 'seat count not read' };
  return { kind: 'ok', count: state.count };
}

/**
 * The seat-count disclosure, as labelled lines.
 *
 * ⛔ `unresolved_subjects` is ALWAYS emitted, including when it is zero. It is
 * not an error channel — it is the third cell of a partition, and hiding it
 * when empty trains the reader to assume the other two add up. The point of
 * showing it is that `human_subjects` can be read as a billable number only if
 * the reader can see what was excluded from it.
 */
/**
 * WHICH APPS a seat count covers.
 *
 * ⛔ THE LYING SURFACE THIS EXISTS TO CLOSE. `GET …/seat-count` without `?app=`
 * aggregates EVERY app the tenant holds. Rendered next to a list of product
 * names — which is exactly what this page's two-column layout does — an
 * unlabelled aggregate reads as a per-product seat count and is not one.
 * Upstream says so outright (`main.py:7982-7990`): "Without it a tenant's
 * licences for every other app inflate a per-product seat count."
 *
 * The response echoes `app_key` so the renderer never has to REMEMBER what it
 * asked. `null` or absent ⇒ every app. Deriving the label from the payload
 * rather than from the call site is the whole point: a future caller that adds
 * `?app=` gets a correct label for free, and one that removes it cannot
 * silently keep a per-product label.
 */
export type SeatScope =
  | { kind: 'all_apps'; label: string }
  | { kind: 'one_app'; appKey: string; label: string };

export function seatCountScope(
  count: Pick<TenantSeatCount, 'app_key'>,
): SeatScope {
  // Absent, null and '' all mean "not scoped". Only a real key narrows it.
  return count.app_key
    ? { kind: 'one_app', appKey: count.app_key, label: `scoped to ${count.app_key}` }
    : { kind: 'all_apps', label: 'all apps this tenant holds' };
}

/**
 * Is this count a zero-for-a-reason?
 *
 * TWO independent signals say a tenant is archived: the `tenant_archived` flag
 * and `basis === 'tenant_archived'`. Either one is believed, because a count
 * that is zero BECAUSE the tenant is archived and a live tenant with no seats
 * are different facts with different remedies, and the expensive direction of
 * error is missing the caveat — not showing it twice.
 */
export function seatCountArchived(
  count: Pick<TenantSeatCount, 'tenant_archived' | 'basis'>,
): boolean {
  return count.tenant_archived === true || count.basis === 'tenant_archived';
}

export interface SeatBasisDisclosure {
  /** Which apps the figure covers — see `seatCountScope`. */
  scope: SeatScope;
  /** True when a `0` is attributable to archival rather than to "no seats". */
  archived: boolean;
  /** The billable basis — humans, and nothing else. */
  billable: number;
  /** Everything excluded from `billable`, always present, zero included. */
  excluded: { key: 'service' | 'unresolved'; label: string; value: number }[];
  /** `subjects` as reported upstream. */
  subjects: number;
  /** Licence rows. >= subjects, because one person may hold several. */
  seats: number;
  /**
   * Non-null when `human + service + unresolved !== subjects`. The three
   * partition `subjects` EXACTLY; if they do not, the upstream arithmetic is
   * wrong and silently reconciling it here would hide that.
   */
  partitionMismatch: string | null;
}

export function seatBasisDisclosure(count: TenantSeatCount): SeatBasisDisclosure {
  const parts =
    count.human_subjects + count.service_subjects + count.unresolved_subjects;
  return {
    scope: seatCountScope(count),
    archived: seatCountArchived(count),
    billable: count.human_subjects,
    excluded: [
      { key: 'service', label: 'service subjects', value: count.service_subjects },
      { key: 'unresolved', label: 'unresolved subjects', value: count.unresolved_subjects },
    ],
    subjects: count.subjects,
    seats: count.seats,
    partitionMismatch:
      parts === count.subjects
        ? null
        : `upstream reports ${count.subjects} subjects but the three classes sum to ${parts}`,
  };
}

/**
 * Provenance of one provisioned-offering row.
 *
 * ⛔ `offering_code: null` means "provenance UNKNOWN", NOT "no offering" — the
 * posture was set directly, or the row predates licences migration 025, which
 * added the column and could not backfill it. A blank cell reads as absence
 * about a row that IS provisioned. See `TenantOfferingRecord` in the client.
 */
export function offeringProvenance(
  row: Pick<TenantOfferingRecord, 'offering_code'>,
): { known: true; code: string } | { known: false } {
  return row.offering_code ? { known: true, code: row.offering_code } : { known: false };
}

/**
 * Does the person's own tenant attribute corroborate the tenant being targeted?
 *
 * ⛔ THIS IS NEVER A GATE. Most Keycloak users carry no `tenant_id` attribute at
 * all, so blocking on missing evidence would deny the majority of legitimate
 * grants. `unknown` and `mismatch` are DISCLOSURES the operator reads before
 * pressing the button — which is why `canAddSeat` below does not consult them.
 */
export type TenantEvidence =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'match'; tenantId: string }
  | { kind: 'mismatch'; personTenantId: string; targetTenantId: string };

export function tenantEvidence(
  person: Pick<PersonRecord, 'tenant_id'> | null,
  targetTenantId: string | null,
): TenantEvidence {
  if (!person || !targetTenantId) return { kind: 'none' };
  if (!person.tenant_id) return { kind: 'unknown' };
  return person.tenant_id === targetTenantId
    ? { kind: 'match', tenantId: targetTenantId }
    : { kind: 'mismatch', personTenantId: person.tenant_id, targetTenantId };
}

/**
 * Whether the seat form may be submitted.
 *
 * TENANT FIRST is enforced here and not only by rendering order: `tenantId` is
 * the first term, so restoring the person-first flow (person chosen, tenant
 * still null) cannot produce a submittable form.
 *
 * ⛔ Deliberately does NOT consult `tenantEvidence`, the seat count, or the
 * offerings readback. None of those are preconditions for minting a seat, and
 * gating on an unreadable one would turn a failed GET into a work stoppage.
 */
export function canAddSeat(state: {
  tenantId: string | null;
  subjectId: string | null;
  appId: string | null;
  planId: string | null;
  busy: boolean;
}): boolean {
  return Boolean(
    state.tenantId && state.subjectId && state.appId && state.planId && !state.busy,
  );
}

/** Seats already held in this tenant, for the "what it has" panel. */
export function licensesForTenant(
  licenses: LicenseRecord[],
  tenantId: string | null,
): LicenseRecord[] {
  if (!tenantId) return [];
  return licenses.filter((l) => l.tenant_id === tenantId);
}
