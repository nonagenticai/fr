// src/lib/admin/rate-limit-enforcement.ts
//
// The single place that states what fr's plan rate-limit fields actually do.
//
// ⛔ MEASURED 2026-09-26 (fr#1046) — `rate_limit_rpm` and `rate_limit_burst`
// are STORED AND ADMIN-EDITABLE AND READ BY NO ENFORCING PATH. An operator can
// set a per-minute limit, see it persisted and see it rendered back, and have
// it enforced nowhere. That is worse than not having the field: it manufactures
// a belief that a limit is in force.
//
// THE EVIDENCE (whole-tree grep of `origin/main` @ 34acdf7f, node_modules and
// the vendored OpenAPI specs excluded). Every single occurrence of
// `rate_limit_rpm` / `rate_limit_burst` outside tests is one of three kinds,
// and NOT ONE is a comparison:
//
//   1. Admin WRITE schema (accepts the value, forwards it) — cited by SYMBOL
//      because the numbers move, and one of them already did:
//        backend/src/routes/admin/licenses-admin.ts  `CreatePlanBody`
//        backend/src/routes/admin/licenses-admin.ts  `UpdatePlanBody`
//      ⚠️ The first draft of this file cited them as :210,211 / :222,223.
//      Those are `origin/main` @ 34acdf7f numbers; the comment block THIS
//      change adds above `CreatePlanBody` pushed them down (264,265 / 276,277
//      as of this commit). Grep the symbol, not the line.
//   2. Pass-through TYPES (carried, never compared):
//        backend/src/services/licenses.ts:156-157, 730-731, 876-877, 889-890
//        frontend/src/lib/api/licenses-admin.ts:91-92, 188-189, 415-416, 428-429
//        frontend/src/lib/api/me-licenses.ts:25-26
//   3. Frontend DISPLAY / EDIT — the three surfaces this module now labels:
//        licenses/page-helpers.ts `planLabel`   (the only render site)
//        licenses/catalog/+page.svelte          (create-plan form)
//        users/+page.svelte                     (custom-plan form)
//
// POSITIVE CONTROL for that zero. The identical grep shape over the same trees
// finds a real enforcing read for another field, so "no comparison found" is a
// measurement and not a broken pattern:
//     backend/src/routes/client-errors.ts:237      `if (bucket.count >= RATE_LIMIT_MAX)`
//
// ⭐ AND THE SHARPEST CONTROL, in the same handler that accepts the write.
// `backend/src/routes/admin/licenses-admin.ts` `handleUpdatePlan` detects a
// change to the SIBLING field `quota_monthly` and re-applies it to every live
// license through provisioning, because billing snapshots the plan value at
// grant time and would otherwise "carry the OLD value" (the handler's own
// words). A plan field an enforcer consumes needs exactly that propagation.
// There is no equivalent block for `rate_limit_rpm` — and nothing to propagate
// it to. Same PATCH, two fields: one reaches an enforcer, the other nobody.
//
// WHY THIS IS LABELLED RATHER THAN ENFORCED (fr#1046 option B, not A).
//
// ⚠️ CORRECTED 2026-09-26, IN THE FIRST DRAFT OF THIS VERY FILE. It claimed
// "fr has no rate-limiting mechanism to reuse", and concluded that enforcing
// "would mean inventing a cross-replica counter: a new subsystem, not a
// reuse". THAT IS FALSE. There is a fourth limiter, and it is exactly that
// pattern: `backend/src/lib/decision-rate-limit.ts`. It is enforced against
// `approval_decisions.decided_at` for the SAME `approver_id` — in its own
// words, "keyed on the DECIDER's identity, not on the request path" and
// "enforced against the DB rather than in memory so it holds across pods,
// restarts and channels alike", because "an in-process limiter would reset
// exactly when a crash loop (or a channel switch) made bursts most likely".
// One shared `MIN_DECISION_INTERVAL_MS`, imported by `routes/approvals.ts` and
// by the telegram / teams webhooks, so the HTTP seat and the two
// chat seats cannot be played off against each other. It is the direct remedy
// for fr#901. So the cross-pod, cross-seat counter ALREADY SHIPS in this repo,
// and a future enforcer here would reuse that shape rather than invent it.
//
// What remains true of the other three is narrower than what was written:
// `routes/client-errors.ts` (fixed window), `routes/me/licenses.ts`
// (`REGEN_BUCKETS`, token regeneration) and `routes/tools/kag.ts`
// (`RATE_LIMIT_MAX_CONCURRENT`, concurrent ingest) are per-route, in-process,
// and read a module constant rather than any per-tenant value, so under fr's
// multiple replicas they already permit N× their nominal rate. That is a fact
// about those three routes — never evidence about fr's capability.
//
// ⭐ THE REASON THAT ACTUALLY HOLDS, AND IT DOES NOT DEPEND ON THE COUNTER.
// There is nothing here to enforce AGAINST. fr does not own this value: it is
// a PLAN attribute of the upstream licences service, which fr only proxies
// (`services/licenses.ts` `adminCreatePlan` / `adminUpdatePlan` → POST/PATCH
// `/plans`), and `licenses-admin.ts` states in its header that it is "a THIN
// PROXY on purpose … duplicating any of [the model or invariants] here would
// create a second source of truth that drifts". The two request-path guards,
// `lib/require-fr-license.ts` and `lib/require-kag-license.ts`, call
// `GET /licenses/active` and read active/inactive only — THE PLAN OBJECT
// CARRYING `rate_limit_rpm` IS NEVER FETCHED ON A REQUEST PATH AT ALL. Hand
// fr the best counter in the building and there is still no rpm value in hand
// at the moment a request is served. That is why the field is labelled, and it
// is a different claim from "fr could not count".
//
// ⛔ Do not read the correction as "so build one now". fr#1046 lists five
// questions — scope, null semantics, subject, bulk-caller behaviour, counter
// location — that are business decisions, not code ones, and all five are
// still open. This module makes the field honest; it does not schedule its
// enforcement or pre-answer any of the five.
//
// ⭐ The column and the admin control are DELIBERATELY KEPT. A value a human
// has already set is data, and a future enforcer will want it. What changes is
// only that no screen may imply protection that does not exist.
//
// WHEN ENFORCEMENT LANDS: flip `RATE_LIMIT_ENFORCED` to true and delete the
// suffix/note from the three surfaces.
//
// Context: fr#1046 is filed as the mechanism behind fr#901 — 175 approvals
// batch-approved in 1.14 s (~153/second) by one shared super-admin identity,
// with a separate session measuring 727 approvals in 6.6 s against the
// deciding PUT. Nothing rate-limited any of it, and this field is why an
// operator could have believed something would.

/**
 * Whether ANY fr path consults the plan's `rate_limit_rpm` /
 * `rate_limit_burst` when deciding to serve a request.
 *
 * `false` as of 2026-09-26 — see the file header for the grep and its positive
 * control. Flip this when a real enforcer reads the value, and not before.
 */
export const RATE_LIMIT_ENFORCED = false;

/**
 * Appended to any rendered rate-limit value so the number never stands alone
 * and never reads as a live control.
 */
export const RATE_LIMIT_NOT_ENFORCED_SUFFIX = ' (not enforced)';

/**
 * Shown beside every rate-limit INPUT. Says what the field does — records a
 * value — and, explicitly, what it does not do.
 */
export const RATE_LIMIT_NOT_ENFORCED_NOTE =
  'Rate limit and burst are recorded on the plan but not enforced: no fr request path reads them, so setting a value here does not throttle anything (fr#1046).';

/**
 * Placeholder for a rate-limit input. Replaces the previous
 * "blank = unlimited" / "blank = default", both of which asserted enforcement
 * semantics for a field nothing enforces.
 */
export const RATE_LIMIT_INPUT_PLACEHOLDER = 'recorded, not enforced';

/** Test id for the notice, so a mounted-DOM assertion can require it. */
export const RATE_LIMIT_NOTICE_TESTID = 'rate-limit-not-enforced-note';
