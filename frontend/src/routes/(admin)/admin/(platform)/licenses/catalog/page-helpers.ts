// src/routes/(admin)/admin/(platform)/licenses/catalog/page-helpers.ts
//
// Pure logic for the catalog page's Regions list. Extracted so vitest can
// verify it under `environment: 'node'` without rendering the component.
//
// ── Why this exists ────────────────────────────────────────────────────────
// Measured on the live catalog (2026-09-10), the regions list contains rows
// whose `code` is an UN-INTERPOLATED PYTHON f-STRING FRAGMENT:
//
//     test-{uuid}
//     test-ebd49b24.hex[:8]}
//     test-f26f2a12.hex[:8]}
//
// This is a **DATA** defect, not a rendering one. Three independent pieces of
// evidence:
//
//  1. `RegionRecord.code` / `.name` are plain `string` fields and the component
//     interpolates them directly (`{r.code}` / `{r.name}`). There is no
//     template engine on the client that could have failed to substitute.
//  2. A backend test fixture already annotated the sibling case on the APPS table:
//     `'inttest-{uuid}', // literal unformatted f-string, really in the prod DB`.
//  3. The malformed rows carry a code and a name with DIFFERENT uuids
//     (`test-ebd49b24.hex[:8]}` beside `Test Region test-1c869499`), so the two
//     fields were produced by two separate calls in a seeding script — nothing
//     in a single render step could do that.
//
// ⛔ Therefore this module does NOT filter these rows out of the Regions LIST.
// Hiding them there would destroy the only visible evidence that the licensing
// DB holds junk region codes, and a region code is load-bearing (a plan
// references it). The list only lets the UI SAY the value is malformed instead
// of presenting it as an ordinary region name. The real fix belongs upstream:
// purge the rows and fix the seeder, the same way `scripts/purge_test_apps.py`
// handles the apps table.
//
// ⚠️ AMENDED (fr#1240) — THIS RULE IS SCOPED TO THE LIST, AND THIS FILE NOW ALSO
// EXPORTS THREE FILTERS. An earlier revision of this paragraph said flatly that
// "this module deliberately does NOT filter these rows out", 70 lines above the
// block that introduces `isResidueRegion`, `offerableRegions` and
// `regionPickerState` — so a reader who stopped at the first confident sentence
// would conclude those exports contradict the module's own rule and delete them.
// They do not. The distinction is RECORD vs OFFER: the Regions LIST is a record
// and stays unfiltered; the create-plan form's region `<Select>` is an OFFER of
// values an operator may write into a NEW plan, and offering junk there is not
// evidence-preservation. The full argument is at "THE PLAN FORM'S REGION
// DROPDOWN IS AN OFFER, NOT A RECORD" below — read it before changing either.

import { directoryReadState, type DirectoryReadState } from '$lib/asset-workspace/scopeRefs';
import { isTestApp } from '../page-helpers';

/**
 * An un-interpolated template fragment left in a stored value.
 *
 * Matches either a stray brace (`{` or `}` — a `{uuid}` placeholder or the
 * dangling close brace of one that was half-substituted) or a Python attribute
 * /slice expression that leaked into the data (`.hex[:8]`).
 *
 * Deliberately narrow: it must NOT match a legitimate code such as `eu`,
 * `us-east-1`, or the merely test-shaped-but-well-formed `test-1c869499`.
 * Flagging a healthy row as malformed is as much a lie as hiding a broken one.
 */
export const UNINTERPOLATED_TEMPLATE_RE = /[{}]|\.[A-Za-z_]\w*\[[^\]]*\]/;

/** True when a stored value still contains an un-interpolated template fragment. */
export function isMalformedValue(value: string | null | undefined): boolean {
  if (!value) return false;
  return UNINTERPOLATED_TEMPLATE_RE.test(value);
}

/**
 * True when a region row carries junk in either load-bearing text field.
 * The row is still rendered — this only drives the "malformed" marker.
 */
export function isMalformedRegion(
  region: { code: string; name: string },
): boolean {
  return isMalformedValue(region.code) || isMalformedValue(region.name);
}

// ── THE PLAN FORM'S REGION DROPDOWN IS AN OFFER, NOT A RECORD (fr#1240) ───────────
//
// ⛔ THE DISTINCTION THIS WHOLE BLOCK TURNS ON, AND WHY IT DOES NOT CONTRADICT THE ⛔
// AT THE TOP OF THIS FILE. That rule governs the Regions LIST, which is a RECORD: it
// must keep rendering every stored row, marked, because hiding junk would destroy the
// only visible evidence the licensing DB holds it. The plan form's `<Select>` is a
// different thing — an OFFER of values an operator may write into a NEW plan. Handing
// somebody `test-ebd49b24.hex[:8]}` as a choice is not evidence-preservation, it is
// inviting them to create a real plan pointing at junk. So: the list still shows
// everything, the dropdown offers only what is fit to pick, and `Show test/demo
// residue` — the toggle that already governs the Apps table — governs both.
//
// ⚠️ MEASURED ON THE PRODUCTION `licenses.region` TABLE 2026-09-26/27: 97 rows, **97
// test/demo-shaped, 0 genuine**, 90 active, and **0 licenses + 0 plans reference any
// region at all** (the `license.region_id` / `plan.region_id` FKs exist and nothing uses
// them). That is the defect this filter was written for: every stored row was junk, and
// the dropdown was offering all of it.
//
// ⛔ CORRECTED 2026-09-27 — `all-residue-hidden` HAS ZERO PRODUCTION SUBJECTS TODAY, AND
// AN EARLIER REVISION OF THIS PARAGRAPH CLAIMED THE OPPOSITE. It said 94 rows survived
// and so "once this filter is on, it hides EVERY row" was "the DEFAULT state of this page
// against real data". The operator then purged the catalog outright (`DELETE 94`).
// RE-MEASURED live on `licenses`: `region` = **0 rows** (non-zero control on the same
// connection: `app` = 52, `plan` = 89, so the count discriminates). ⇒ The live page now
// renders `empty` — "No regions configured" — which is the TRUE statement for an empty
// table. `all-residue-hidden` is currently **unreachable against production data**.
//
// ⭐ IT STAYS ANYWAY, AND NOT AS DEAD WEIGHT: the seeder that produced those 97 rows has
// not been fixed, so residue can return, and the moment it does this state is the only
// thing standing between an operator and "no regions configured" printed over a table
// that has 90 of them. Keep it ARMED; do not read it as live. Keyed on the OFFERED count
// alone, "N rows exist and your own filter is hiding all of them" is arithmetically
// identical to "this deployment has no regions", which is why `total` and `offered` are
// separate parameters below — a single count cannot tell those apart.

/**
 * Is this region row test/demo residue?
 *
 * ⛔ NO SECOND PREDICATE, AND NO SECOND REGEX. It is the union of the two that already
 * exist, which is also what makes it consistent with the rest of the console:
 *   - `isTestApp` (`../page-helpers.ts:72`, `TEST_APP_KEY_RE` at :71) — the vocabulary
 *     the `Show test/demo residue` toggle ALREADY means for the Apps table, kept in
 *     sync with `TEST_APP_KEY_RE` in the backend and `JUNK_RE` in the licences repo's
 *     `purge_test_apps.py`. Applied to `code` because a region's code is its key: it
 *     is the field a plan's `region_id` resolves to and the field the seeder wrote.
 *   - `isMalformedRegion` (this file, :58) — the un-interpolated-template rows.
 *
 * ⚠️ The union is not redundant even though every measured malformed row ALSO starts
 * `test-`. A row whose code is clean and whose NAME carries `{uuid}` is malformed and
 * not test-prefixed, and it must not be offered either.
 */
export function isResidueRegion(region: { code: string; name: string }): boolean {
  return isTestApp(region.code) || isMalformedRegion(region);
}

/** The rows fit to OFFER. `includeResidue` is the `Show test/demo residue` toggle. */
export function offerableRegions<T extends { code: string; name: string }>(
  regions: readonly T[],
  includeResidue: boolean,
): T[] {
  return includeResidue ? [...regions] : regions.filter((r) => !isResidueRegion(r));
}

/**
 * What the region dropdown may CLAIM — four states from the house helper, plus a fifth
 * this surface genuinely has and that helper cannot express.
 *
 * ⭐ `directoryReadState` (`$lib/asset-workspace/scopeRefs.ts:88`) is reused rather
 * than re-derived: it already draws the loading / unreadable / empty / ready
 * distinctions and its docblock argues each one, including why `unreadable` outranks a
 * non-zero count and why in-flight is not "empty". Three approver dialogs key their
 * directory copy on it.
 *
 * ⛔ THE FIFTH STATE EXISTS BECAUSE THE FOURTH WOULD LIE. Keyed on the OFFERED count
 * alone, "N rows exist and your own filter is hiding all of them" is arithmetically
 * identical to "this deployment has no regions". Telling an operator "no regions
 * configured" while N sit one checkbox away is the absence-rendered-as-a-result defect:
 * they conclude the system is broken when it is obeying them. So `total` and `offered`
 * are SEPARATE parameters; a single count cannot answer this.
 *
 * ⚠️ ARMED, NOT LIVE — see the ⛔ CORRECTED note above. `licenses.region` is 0 rows as of
 * 2026-09-27, so production takes the `empty` arm, which is honest for an empty table.
 * `all-residue-hidden` has zero production subjects until the unfixed seeder reseeds.
 *
 * ⚠️ `total` is what the read returned, `offered` what survived the filter. Passing
 * the same number for both makes the fifth state unreachable.
 *
 * ⚠️ `unreadable` IS PASSED THROUGH BUT HAS NO CALLER THAT CAN PRODUCE IT TODAY. The one
 * caller, `+page.svelte`, shares a single `loadError` between the apps read and the
 * regions read, and a non-null `loadError` replaces the WHOLE card with `<ErrorState>`
 * before the plan form exists — so no plan-form copy can paint in that state (fr#1240
 * audit F3; the dead branch was removed). This function keeps the arm because it
 * is generic: a caller that reads regions on its own error channel gets the right answer.
 */
export type RegionPickerState = DirectoryReadState | 'all-residue-hidden';

export function regionPickerState(
  loaded: boolean,
  total: number,
  offered: number,
  unreadable: string | null | undefined,
): RegionPickerState {
  // Loading / unreadable / genuinely-empty are the shared helper's business, and it
  // must see the TOTAL: whether the read landed and whether it returned rows are
  // facts about the read, not about this surface's filter.
  const base = directoryReadState(loaded, total, unreadable);
  if (base !== 'ready') return base;
  return offered === 0 ? 'all-residue-hidden' : 'ready';
}
