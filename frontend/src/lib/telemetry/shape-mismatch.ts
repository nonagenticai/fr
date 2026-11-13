// src/lib/telemetry/shape-mismatch.ts
//
// The sink for "the server sent a 200 whose BODY this caller cannot read".
//
// Why this is its own signal and not just another error: a shape mismatch is a
// SUCCESSFUL request. Status is 200, `response.ok` is true, no exception is
// thrown by fetch, and every existing error path in the app stays quiet. The
// only observable consequence today is that `res.items ?? []` evaluates to `[]`
// and the page draws its empty state. The user sees "no rows" and reports
// "everything is broken"; the operator sees a green dashboard. Nothing in the
// system disagrees with anything else, which is exactly why the defect class
// survives review.
//
// So the mismatch has to be MANUFACTURED into a signal. `$lib/api/response-shape`
// raises it; this module carries it off the page.
//
// PII: the report carries the SHAPE only — a path, the expected grammar, and a
// description of what arrived that names keys and types but never values
// (`object{data, meta}`, `array(3)`, `string`). No row content, no ids, no
// tokens can reach the sink through this payload by construction, so there is
// nothing here for a redaction pass to miss.

/** Everything we know about one unreadable-but-successful response. */
export interface ShapeMismatchReport {
  /** Request path, query stripped by the caller. */
  endpoint: string;
  method: string;
  /** HTTP status the mismatch arrived on — 200 in every interesting case. */
  status: number;
  /** Where in the body it went wrong: `<root>`, `items[3].id`, `data.total`. */
  path: string;
  /** The grammar the call site DECLARED it wanted. */
  expected: string;
  /** What arrived there — keys and types only, never values. */
  received: string;
}

export type ShapeMismatchSink = (report: ShapeMismatchReport) => void;

/**
 * The tag every emitted line starts with. A log search for this string finds
 * every shape mismatch in the estate and nothing else.
 */
export const SHAPE_MISMATCH_EVENT = 'fr.client.response_shape_mismatch';

/**
 * Default sink: one structured line on the console.
 *
 * This is deliberately the weakest useful sink, and it is weak on purpose
 * rather than by oversight. There is no client-error transport on `main` — no
 * Sentry, no beacon, no `POST /api/client-errors` (the route does not exist on
 * the backend either). A branch adding one is in flight; when it lands, the
 * integration is to call its reporter from `emitShapeMismatch` below.
 * Until then a console line is strictly more than the nothing we emit today,
 * and it keeps this module free of a dependency that would not compile.
 *
 * The payload is keyed to match that transport's `ClientErrorEvent` field names
 * (`kind`/`message`/`route`/`status`) so the adapter is a rename of nothing.
 */
export function consoleShapeMismatchSink(report: ShapeMismatchReport): void {
  // eslint-disable-next-line no-console -- this IS the transport
  console.error(SHAPE_MISMATCH_EVENT, {
    kind: 'api',
    message: shapeMismatchMessage(report),
    route: report.endpoint,
    status: report.status,
    method: report.method,
    path: report.path,
    expected: report.expected,
    received: report.received,
  });
}

/**
 * The one sentence that goes in a log line and in the on-screen error. It names
 * the endpoint, the declared grammar and what actually arrived, and it says
 * outright that this is not an empty result — because "no rows" is the wrong
 * conclusion a reader would otherwise reach.
 */
export function shapeMismatchMessage(report: ShapeMismatchReport): string {
  return (
    `${report.method} ${report.endpoint} returned a response this page cannot read: ` +
    `expected ${report.expected} at ${report.path}, received ${report.received}. ` +
    `This is a bug, not an empty result.`
  );
}

/**
 * Hand a report to the console sink.
 *
 * Swallows anything the sink throws: telemetry that can break the page it
 * observes is worse than no telemetry. The mismatch itself still surfaces to
 * the user — that path is the thrown `ResponseShapeError`, not this call.
 */
export function emitShapeMismatch(report: ShapeMismatchReport): void {
  try {
    consoleShapeMismatchSink(report);
  } catch {
    // A failing sink must not take the render with it.
  }
}
