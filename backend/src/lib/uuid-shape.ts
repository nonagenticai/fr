// src/lib/uuid-shape.ts
//
// One shared answer to "is this string shaped like a UUID".
//
// ⚠️ Scope, stated honestly: this does NOT consolidate the repo's existing UUID
// checks. There are several standalone ones already (`middleware/request-context.ts`,
// `middleware/bridge-auth.ts`, `domain/engagement/adapters/inapp.ts`,
// `routes/assets/artifacts.ts`, `routes/assets/streams.ts`) plus many
// `z.string().uuid()` field validators, and none is changed here — folding them
// in would alter error messages their own tests pin. What this fixes is the
// files that had NO check at all. An earlier version of this comment claimed
// "three file-local copies", which was simply wrong, and consolidating was
// never attempted.
//
// Measured in production 2026-09-01: fr's own `GET /api/projects` returns
// stream-backed pseudo-projects with ids like
// `stream:9b9fc446-3fff-4587-be44-68908427ea32`. Feeding one back into a route
// that puts it in a `uuid` column made Postgres raise 22P02
// `invalid input syntax for type uuid`, which escaped as a bare 500 on BOTH
//   GET /api/reports/project-status/:projectId
//   GET /api/tools/bridge/links
// `routes/assets/artifacts.ts` never had the bug — it happened to carry its own
// `z.string().uuid()` guard. That is the whole lesson: the guard existed, it
// just was not shared, so every route written without it inherited the defect.
//
// ⚠️ AND TWO SITES WERE MISSED on 2026-09-01, which is the same lesson landing
// twice. Measured live 2026-09-04: `GET /api/projects/stream:9b9fc446-…` still
// returned 500 in 25.3 ms with the same 22P02, and `/approvals` 500'd the same
// way — while the project cockpit page polls that route every ~11 s, so the URL
// was hard-broken and showed up in the frontend's own `client_error` telemetry.
// Fixed 2026-09-04 at:
//   routes/projects.ts        handleGetProject
//   lib/project-access.ts     findTenantScopedProject (hence loadTenantScopedProject,
//                             the seam every project SUB-RESOURCE handler funnels through)
// Both answer 404 rather than 400 — see the comment at each site; those routes'
// existing contract is a deliberate don't-leak-existence 404, and a 400 would
// make a malformed id distinguishable from a well-formed unreachable one.
//
// Deliberately NOT version-pinned. The job is to keep a non-UUID out of a
// `uuid` column, not to police which UUID version minted it — fr ids include
// both v4 and v7, and a version-pinned regex would reject live data.
const UUID_SHAPE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when `value` can be safely handed to a `uuid` column.
 *
 * Callers throw their OWN error type: this returns a boolean rather than
 * throwing, so a route can answer with the envelope its surface already uses
 * (`BadRequestError` in the report routes, `IntegrationError('BAD_REQUEST')`
 * in the bridge routes) instead of this module dictating one.
 */
export function isUuidShape(value: unknown): value is string {
  return typeof value === 'string' && UUID_SHAPE_RE.test(value);
}
