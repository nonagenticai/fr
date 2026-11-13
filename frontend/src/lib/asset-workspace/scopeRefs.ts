// scopeRefs.ts
// ============
// The SCOPE-REFERENCE reads — the project list and the department list — and
// what a surface is allowed to claim when one of them fails.
//
// ## Why this module exists
//
// Three surfaces read these two lists purely as ENRICHMENT for a list that
// renders regardless: `AssetList` (bulk assign / bulk promote), `library/[type]`
// (promotion targets) and `AssetCreateScopePicker` (the project radio). All
// three degraded a failed read to `[]`, and `[]` is also how "this tenant has
// no projects" and "this workspace has no departments" arrive. The controls
// gate on `length > 0`, so a dead upstream DELETED the control and the surface
// presented itself as complete — the worst direction, because the copy beside
// it then instructs the user (`"No projects available — switch to tenant-wide."`).
//
// A previous pass added the per-input flags (`projectsUnreadable`,
// `departmentsUnreadable`) — the house idiom, `kaizen_available` /
// `identity_available` — and the markup that renders them. What it did NOT do
// is keep the REASON: the flags were booleans, so the catch threw away the one
// fact that tells a user whether retrying can possibly help. "Retry." after a
// 403 is advice that cannot work, and after a 502 is advice that will.
//
// So the flags carry `string | null` — the reason, or null for a read that
// succeeded — and these two helpers are the shared, testable core.

/**
 * The reason a read failed, as a short string safe to render.
 *
 * `fallback` names the READ, not the error: a thrown non-Error (or an Error
 * with an empty message) must still produce something a user can act on, and
 * an empty string is indistinguishable from success at every call site because
 * every one of them treats null/'' as "it worked".
 */
export function readFailureReason(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * What a scope-reference control may claim. Three states, not two.
 *
 * - `unreadable` — the read failed. The set of targets is UNKNOWN. Never render
 *   the empty-state copy here: on this surface that copy is an instruction.
 * - `empty` — the read succeeded and the tenant genuinely has none.
 * - `ready`  — there are targets to pick from.
 *
 * ⚠️ `unreadable` outranks a non-zero count deliberately. A refresh that fails
 * beside rows left over from an earlier tick is showing a stale set as if it
 * were current; saying so is cheaper than a silently wrong assignment target.
 */
export type ScopeRefState = 'unreadable' | 'empty' | 'ready';

export function scopeRefState(
  count: number,
  unreadable: string | null | undefined,
): ScopeRefState {
  if (unreadable != null && unreadable !== '') return 'unreadable';
  return count > 0 ? 'ready' : 'empty';
}

/**
 * What a directory read may claim while it is STILL IN FLIGHT — the fourth
 * state, and the one `scopeRefState` cannot express.
 *
 * `scopeRefState` is keyed on (count, reason) alone, which is right for a list
 * that arrives with its page. It is WRONG for a list fetched after mount: with
 * no roster and no recorded failure, the in-flight window is arithmetically
 * indistinguishable from a successful read of an empty tenant, so a surface
 * built on it renders the EMPTY-state copy while the request is still open.
 *
 * ⛔ That is not a cosmetic slip. On the approver pickers the empty-state copy
 * ASSERTS the read completed ("The directory WAS read") and INSTRUCTS the user
 * to paste a raw user id instead. Handing someone that instruction on the
 * strength of a read that never completed is the defect — a 40-member tenant
 * resolving through Keycloak in chunks can hold that window open for seconds,
 * and the id they paste in it is pasted into a gate nobody may be able to
 * discharge.
 *
 * `loaded` is the ONLY fact that separates the two, so it is a parameter and
 * not an inference. Ordering is deliberate: a recorded failure outranks
 * everything (the read is over and it failed), then not-yet-loaded, then the
 * ordinary count-based verdict.
 */
export type DirectoryReadState = 'loading' | ScopeRefState;

export function directoryReadState(
  loaded: boolean,
  count: number,
  unreadable: string | null | undefined,
): DirectoryReadState {
  if (unreadable != null && unreadable !== '') return 'unreadable';
  if (!loaded) return 'loading';
  return scopeRefState(count, unreadable);
}
