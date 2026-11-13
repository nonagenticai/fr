/**
 * `displayName` — a row's human label, or its id when the row has no usable one.
 *
 * THE DEFECT CLASS this exists to close. Across the app, reference lists are
 * rendered as `<option value={x.id}>{x.name}</option>` — raw. A row whose
 * `name` is `null`, `''` or `'   '` therefore paints an option the user cannot
 * identify, while the `value` it is keyed by (the id) sits right there unused.
 * With two such rows the options are not merely blank, they are
 * INDISTINGUISHABLE FROM EACH OTHER. fr#1192 named six of these in the asset
 * workspace; a sweep of `src/` found the same shape in nine more places.
 *
 * ⛔ WHY NOT `value ?? id`. `??` falls through on `null`/`undefined` ONLY, so
 * `''` and `'   '` WIN the chain and the id is discarded — it repairs 1 of the
 * 4 cases and looks like it repaired all of them. `||` alone repairs 3 of 4
 * and still lets `'   '` through. Only a TRIM-then-test handles all four, and
 * that is the whole content of this function.
 *
 * ⚠️ THE TRIM RULE IS SHARED, NOT COPIED. `rowFieldText`
 * (`$lib/asset-workspace/manifest.ts`) is the asset-workspace's primitive for
 * the identical question, and `AssetList.svelte` / `AssetScopePanel.svelte`
 * use it. This module is deliberately NOT an import of that one: `utils/` must
 * not depend on a feature module, and the feature module predates this. The
 * two are pinned to agree, case for case, by `displayName.test.ts` — so if
 * either side's trim rule is ever changed alone, that test fails rather than
 * the app quietly acquiring two different notions of "blank".
 *
 * @param value    the row's candidate label — typically `row.name`.
 * @param fallback what to show instead when `value` is blank — typically the
 *                 id, i.e. something that still tells two rows apart.
 */
export function displayName(value: unknown, fallback: string): string {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text === '' ? fallback : text;
}
