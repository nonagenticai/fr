/**
 * `shortId` — the one way to abbreviate an entity id for display.
 *
 * THE DEFECT CLASS this exists to close: 25 sites across 19 files hand-roll
 * `id.slice(0, 8)` (fr#1205). That algorithm is not merely duplicated, it is
 * WRONG, and it was already adjudicated wrong once — this function is the
 * extraction of the derivation `EntityRef.svelte` arrived at under fr#1203.
 *
 * ⛔ DO NOT "consolidate" this onto a LEADING slice. Our ids are time-ordered
 * (UUIDv7-shaped: a monotonic timestamp prefix, then random bytes), so rows
 * created in one provisioning batch NECESSARILY share leading characters.
 * Measured live in `licenses`: 52 apps → 27 distinct leading-8 (13 apps all
 * rendered `06954722…`, another 12 all rendered `019f6fcd…`) versus 52
 * distinct trailing-8. Widening the leading slice does not fix it either: the
 * width needed to discriminate is a function of the id scheme AND the batch
 * size, not a constant anyone can pick correctly once. The tail carries the
 * random bytes; take the tail.
 *
 * The ellipsis LEADS because the stub is taken from the tail, and it is
 * mandatory: without it a truncated id is indistinguishable from a complete
 * short code.
 *
 * ⚠️ Byte-identical to what `EntityRef.svelte` derived before it imported this
 * (that component is the reason the threshold is `> SHORT_LEN` and not
 * `>= SHORT_LEN` or `> 9`): changing any boundary here changes rendered output
 * at every call site at once.
 *
 * Edge behaviour, chosen deliberately:
 *   - `null` / `undefined` → `''`. There is nothing to abbreviate, and a
 *     placeholder like `…` or `unknown` would be a value the caller cannot
 *     distinguish from a real stub. Callers that need copy for "no id" own that
 *     copy themselves (`EntityRef` hides the slot entirely when this is empty).
 *   - `''` → `''`. Same reason; also what `EntityRef` already rendered.
 *   - length ≤ SHORT_LEN (8) → returned UNCHANGED, with no ellipsis: the whole
 *     value is already on screen, so marking it truncated would be a lie.
 *     ⚠️ A 9-character id IS truncated (`…` + its last 8), because that is what
 *     `EntityRef` has always done and this function may not change its output.
 *   - no trimming, no case folding: an id is an exact lookup key, and an
 *     operator eyeballing this against a log line needs the literal bytes.
 *
 * `displayName()` is an ORTHOGONAL concern (which text identifies a row) and
 * must not be folded in here (how an id is abbreviated once chosen).
 */

/** Characters of the id kept in the stub. Taken from the TAIL — see above. */
export const SHORT_LEN = 8;

export function shortId(id: string | null | undefined): string {
  const fullId = id ?? '';
  return fullId.length > SHORT_LEN ? `…${fullId.slice(-SHORT_LEN)}` : fullId;
}
