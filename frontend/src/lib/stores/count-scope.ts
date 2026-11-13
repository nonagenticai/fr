// count-scope.ts
// ==============
// THE SENTENCE A COUNT NEEDS WHEN THE NUMBER ALONE IS A CLAIM ABOUT SCOPE.
//
// ⛔ WHY THIS IS A MODULE AND NOT A `$derived` IN EACH CONSUMER. The wording was
// written for, and lived inside, `$lib/layout/SidebarBadge.svelte` (its `label`
// builder). It is now read by THREE surfaces off ONE store field
// (`navCounts.pendingApprovalsScopeKind`): the rail badge, the Home hero and
// `PendingApprovalsCard`. Two of those three had NO qualifier at all, which is the
// defect this module exists to close — and the obvious repair, pasting the sentence
// into each of them, is how the estate gets three copies of one claim that then
// drift. `SidebarBadge` now imports from here, so there is exactly one spelling.
//
// ⛔ THE UNDERLYING FACT, MEASURED AND RECORDED IN THE STORE ITSELF
// (`navCounts.svelte.ts:42-46`): `GET /api/approvals/all` applies NO ROSTER FILTER,
// and for a super-admin in their home view it drops `approvals.tenant_id` ENTIRELY.
// Measured on the prod primary 2026-09-26: fleet pending 5 (`system` 3,
// `nonagentic-exec` 2), `fr-test` 0. So the badge rendered `5` a few pixels from a
// workspace switcher reading `fr-test` — a workspace holding none of the five.
//
// ⚠️ THOSE ARE TWO INDEPENDENT DEFECTS AND THEY NEED TWO SEPARATE SENTENCES. The
// tenant half is about WHICH WORKSPACE and varies per response, so it is keyed on
// the scope the envelope stated. The roster half is about WHOSE QUEUE, is true of
// EVERY response the endpoint has ever returned, and is therefore a constant
// (`PENDING_APPROVALS_ROSTER_CAVEAT`) rather than a third value of the scope enum.
// Collapsing them would make "in this workspace" read as "and they are yours".

/**
 * What the count covers, exactly as the ENVELOPE stated it — never re-derived from
 * the active workspace, because the active workspace is precisely what the backend
 * may have ignored. `undefined` is a THIRD case: a pre-#855 backend stated no scope,
 * and the only honest rendering is the unqualified number.
 */
export type CountScope = 'fleet' | 'workspace' | undefined;

/**
 * The scope clause, or `''` when the envelope named no scope.
 *
 * ⚠️ `''` for `undefined` is load-bearing and must not become "in this workspace".
 * Printing a confinement there invents the very claim the fleet bug invented, just
 * more quietly; printing the fleet note would cry wolf on every count such a server
 * returns. Callers branch on the empty string to render nothing at all.
 */
export function scopeQualifier(scope: CountScope): string {
  if (scope === 'fleet') return 'across every workspace — not just the one selected';
  if (scope === 'workspace') return 'in this workspace';
  return '';
}

/**
 * The staleness clause. It NAMES THE FAILURE, NOT A TIME: we know the refresh did
 * not land, we do not know when the number was taken, and a fabricated "as of 12:04"
 * would be the more comfortable of the two lies.
 */
export const STALE_QUALIFIER = 'last known value, not confirmed by the latest refresh';

/**
 * `GET /api/approvals/all` APPLIES NO ROSTER FILTER, so this counter can never
 * support the words "awaiting your decision".
 *
 * ⛔ MEASURED: `PendingApprovalsCard` rendered exactly that sentence under the bare
 * number — a roster claim about a population the endpoint does not narrow to the
 * caller. Unlike the scope clause this is NOT conditional on anything: it holds for
 * every response, for every reader, on every backend version, which is why it is a
 * constant and not a branch.
 */
export const PENDING_APPROVALS_ROSTER_CAVEAT = 'not filtered to your roster';

/**
 * The whole claim in ONE sentence, for `title` / `aria-label` alike.
 *
 * ⭐ ONE STRING FOR BOTH. They used to be able to disagree in `SidebarBadge` (only
 * `aria-label` existed, and it was the one that was wrong), and a tooltip that says
 * something a screen reader does not is the same defect with a smaller audience.
 *
 * ⚠️ The staleness note goes LAST, after the scope clause. That order is what
 * `SidebarBadge` shipped and what its tests pin; do not reorder for tidiness.
 */
export function scopedCountLabel(counted: string, scope: CountScope, stale: boolean): string {
  const qualifier = scopeQualifier(scope);
  const scoped = qualifier === '' ? counted : `${counted} ${qualifier}`;
  return stale ? `${scoped} — ${STALE_QUALIFIER}` : scoped;
}
