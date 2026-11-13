// src/lib/api/response-shape.ts
//
// Declared response shapes, so a wrong envelope is LOUD instead of empty.
//
// ── The defect this exists to kill ───────────────────────────────────────────
//
// fr-backend has no response envelope. Measured across the 60 GET routes that
// return 200: 13 return `{data: …}`, 8 return `{items, total}`, 2 return
// `{items}`, one returns a bare array, and ~21 return a one-off object of their
// own. Two SIBLING routes of the same resource disagree:
//
//     GET /api/reports                  -> {"items": [], "total": 0}
//     GET /api/reports/approval-backlog -> {"data": {...}}
//
// `backend/src/utils/response.ts` `jsonResponse` adds no wrapper, so the shape
// is whatever the handler happened to pass. That is not fixable from here — 60
// routes have consumers, and re-enveloping them is a breaking change. What IS
// fixable is the frontend's reaction to guessing wrong.
//
// Today the reaction is silence. A call site written against one shape reads
// the other and gets `undefined`:
//
//     const rows = res.items ?? [];      // res is {data: […]} -> []
//
// `?? []` is doing something much worse than defaulting. It is ANSWERING a
// question it cannot answer. "The server has no rows for you" and "I could not
// find the rows in this response" are different facts about the world, and this
// line renders them as the same pixels — the empty state, with no error, no log
// and no failing test. `apiClient.get<T>()` ends in `return data as T`, so
// TypeScript actively certifies the lie: the type says `{items: Row[]}` and the
// value is `{data: Row[]}`, and nothing anywhere checks. Users report
// "everything is broken"; every dashboard is green.
//
// ── The mechanism ────────────────────────────────────────────────────────────
//
// A call site DECLARES the grammar it can read. The declaration is checked
// against the actual body at runtime, and the two outcomes are made structurally
// impossible to confuse:
//
//   legitimately empty -> resolves to {items: [], total: 0}  -> empty state
//   unreadable shape   -> THROWS ResponseShapeError          -> error state
//
// Throwing is the integration. Every list page in this app already runs its
// fetch inside `try { … } catch (e) { error = e }` feeding `<ErrorState>`, so a
// mismatch lands in an error surface the UI already knows how to draw, with no
// new component and no change to the page's control flow.
//
// ── Why strict, and where it deliberately is not ─────────────────────────────
//
// Strict on structure: if you declare `itemsEnvelope`, a `{data: …}` body is a
// mismatch. A permissive reader that sniffed all four envelopes would never
// mismatch, and would therefore never tell you the backend had changed under
// you — it would just quietly succeed until the day it quietly returned nothing.
// The declaration is the whole value.
//
// Lenient in exactly two places, both load-bearing:
//   * UNKNOWN KEYS ARE FINE. A handler that adds a field must not red-light a
//     page that does not read it, or this becomes a deployment coupling and
//     gets ripped out within the month.
//   * `total` may be absent — `{items}` and `{items, total}` are the same
//     envelope with the same load-bearing key, and 10 routes split across them.
//     Present-but-not-a-number is still a mismatch.
//
// ── Diagnostics carry no values ──────────────────────────────────────────────
//
// `describeValue` reports keys and types and never contents. A report reads
// `object{data, meta}` or `array(3)`, never a row. Nothing in a mismatch report
// can leak a token or a customer field, so the sink needs no redaction pass.

import {
  emitShapeMismatch,
  shapeMismatchMessage,
  type ShapeMismatchReport,
} from '$lib/telemetry/shape-mismatch';

// -----------------------------------------------------------------------------
// The error
// -----------------------------------------------------------------------------

/**
 * Thrown when a 200 response does not match the shape the call site declared.
 *
 * Distinct class, not a generic `Error`, so a page can tell "the server is
 * broken" (`ApiError`, has a status) from "the server and I disagree about what
 * this endpoint returns" (this) and word them differently.
 */
export class ResponseShapeError extends Error {
  readonly report: ShapeMismatchReport;

  constructor(report: ShapeMismatchReport) {
    super(shapeMismatchMessage(report));
    this.name = 'ResponseShapeError';
    this.report = report;
    // Native subclassing under the ES5 downlevel target loses the prototype.
    Object.setPrototypeOf(this, ResponseShapeError.prototype);
  }
}

/**
 * Raised by decoders while walking the body; converted to a `ResponseShapeError`
 * at the boundary once endpoint context is known. Internal — a decoder has no
 * idea which request it is reading.
 */
class Mismatch extends Error {
  constructor(
    readonly path: string,
    readonly expected: string,
    readonly received: string,
  ) {
    super(`expected ${expected} at ${path}, received ${received}`);
    this.name = 'Mismatch';
    Object.setPrototypeOf(this, Mismatch.prototype);
  }
}

// -----------------------------------------------------------------------------
// Describing what arrived — SHAPE ONLY
// -----------------------------------------------------------------------------

/** How many object keys to name before summarising the rest. */
export const MAX_DESCRIBED_KEYS = 8;

/**
 * A value's shape as a short string, naming keys and types but NEVER contents.
 * This is what makes a mismatch report safe to log unredacted.
 */
export function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `array(${v.length})`;
  switch (typeof v) {
    case 'string':
      return 'string';
    case 'number':
      return Number.isFinite(v) ? 'number' : 'number(non-finite)';
    case 'boolean':
      return 'boolean';
    case 'object': {
      const keys = Object.keys(v as object).sort();
      if (keys.length === 0) return 'object{}';
      const shown = keys.slice(0, MAX_DESCRIBED_KEYS);
      const rest = keys.length - shown.length;
      return `object{${shown.join(', ')}${rest > 0 ? `, +${rest} more` : ''}}`;
    }
    default:
      return typeof v;
  }
}

// -----------------------------------------------------------------------------
// Decoders
// -----------------------------------------------------------------------------

export interface Decoder<T> {
  /** Human-readable grammar, used in the error and the telemetry report. */
  readonly expected: string;
  /** Returns the typed value, or throws `Mismatch`. */
  read(input: unknown, path: string): T;
}

function decoder<T>(expected: string, read: (input: unknown, path: string) => T): Decoder<T> {
  return { expected, read };
}

function fail(path: string, expected: string, got: unknown): never {
  throw new Mismatch(path, expected, describeValue(got));
}

export const str: Decoder<string> = decoder('string', (v, p) =>
  typeof v === 'string' ? v : fail(p, 'string', v),
);

export const num: Decoder<number> = decoder('number', (v, p) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fail(p, 'number', v),
);

export const bool: Decoder<boolean> = decoder('boolean', (v, p) =>
  typeof v === 'boolean' ? v : fail(p, 'boolean', v),
);

/** Accepts anything, including `undefined`. For fields the page passes through. */
export const anything: Decoder<unknown> = decoder('anything', (v) => v);

/** `T | null`. A JSON `null` is a real value here; a missing key is not. */
export function nullable<T>(inner: Decoder<T>): Decoder<T | null> {
  return decoder(`${inner.expected} | null`, (v, p) => (v === null ? null : inner.read(v, p)));
}

/** `T | undefined`. Absent and `null` both read as `undefined`. */
export function optional<T>(inner: Decoder<T>): Decoder<T | undefined> {
  return decoder(`${inner.expected}?`, (v, p) =>
    v === undefined || v === null ? undefined : inner.read(v, p),
  );
}

/** One of a fixed set of strings. */
export function oneOf<const T extends readonly string[]>(values: T): Decoder<T[number]> {
  const expected = values.map((v) => `'${v}'`).join(' | ');
  return decoder(expected, (v, p) =>
    typeof v === 'string' && (values as readonly string[]).includes(v)
      ? (v as T[number])
      : fail(p, expected, v),
  );
}

/**
 * A homogeneous array. Rejects non-arrays — which is the check that catches a
 * `{items: {…}}` where the page indexes `items[0]` and gets `undefined`.
 */
export function arrayOf<T>(inner: Decoder<T>): Decoder<T[]> {
  return decoder(`array of ${inner.expected}`, (v, p) => {
    if (!Array.isArray(v)) return fail(p, `array of ${inner.expected}`, v);
    return v.map((el, i) => inner.read(el, `${p}[${i}]`));
  });
}

type FieldsOf<F> = { [K in keyof F]: F[K] extends Decoder<infer T> ? T : never };

function readFields(
  fields: Record<string, Decoder<unknown>>,
  src: Record<string, unknown>,
  p: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    out[key] = fields[key].read(src[key], p === ROOT ? key : `${p}.${key}`);
  }
  return out;
}

/**
 * An object with declared fields, whose type is INFERRED from the decoders.
 *
 * Undeclared keys are not validated and are carried through to the result
 * untouched. Both halves are deliberate: validating them would make a backend
 * adding a field a page outage, and dropping them would silently blank any
 * field the decoder's author forgot — trading a loud defect for a quiet one,
 * which is the exact move this module exists to reverse.
 */
export function object<F extends Record<string, Decoder<unknown>>>(fields: F): Decoder<FieldsOf<F>> {
  const expected = `object{${Object.keys(fields).sort().join(', ')}}`;
  return decoder(expected, (v, p) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail(p, expected, v);
    const src = v as Record<string, unknown>;
    return { ...src, ...readFields(fields, src, p) } as FieldsOf<F>;
  });
}

/**
 * An object GUARDED on a few load-bearing fields and typed as `T`, returned by
 * reference with every field intact.
 *
 * This is the right combinator for a DOMAIN ROW. An `Approval` has ~20 fields;
 * re-declaring all of them here would fork the type and turn every additive
 * backend change into a red page. What actually needs checking is the handful
 * that prove this is the row you think it is — `id` being a string is enough to
 * separate an approval from whatever else a wrong envelope handed you.
 *
 * The `T` is an assertion about the unchecked remainder, exactly like the
 * `as T` it replaces. The difference is that the ENVELOPE and the guard fields
 * are now facts rather than hopes, which is where the silent-empty defect lives.
 */
export function record<T>(guards: Record<string, Decoder<unknown>>): Decoder<T> {
  const expected = `object{${Object.keys(guards).sort().join(', ')}}`;
  return decoder(expected, (v, p) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail(p, expected, v);
    const src = v as Record<string, unknown>;
    readFields(guards, src, p);
    return v as T;
  });
}

// -----------------------------------------------------------------------------
// Envelopes
// -----------------------------------------------------------------------------

/** Path label for the top of a response body. */
export const ROOT = '<response root>';

/**
 * What every list call site gets back, whatever envelope it declared. The
 * normalisation is the ergonomic half; the declaration above is the safety half.
 */
export interface Paged<T> {
  items: T[];
  total: number;
}

/**
 * `{items: T[], total?: number}` — 10 of the measured routes.
 *
 * `total` absent derives from `items.length`; `total` present but not a number
 * is a mismatch, because that means the envelope is not the one you declared.
 */
export function itemsEnvelope<T>(item: Decoder<T>): Decoder<Paged<T>> {
  const expected = `object{items: array of ${item.expected}, total?: number}`;
  return decoder(expected, (v, p) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail(p, expected, v);
    const src = v as Record<string, unknown>;
    if (!('items' in src)) return fail(p, expected, v);
    const items = arrayOf(item).read(src.items, p === ROOT ? 'items' : `${p}.items`);
    const total = optional(num).read(src.total, p === ROOT ? 'total' : `${p}.total`);
    return { items, total: total ?? items.length };
  });
}

/** `{data: T[]}` — the list flavour of the 13 `{data: …}` routes. */
export function dataListEnvelope<T>(item: Decoder<T>): Decoder<Paged<T>> {
  const expected = `object{data: array of ${item.expected}}`;
  return decoder(expected, (v, p) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail(p, expected, v);
    const src = v as Record<string, unknown>;
    if (!('data' in src)) return fail(p, expected, v);
    const items = arrayOf(item).read(src.data, p === ROOT ? 'data' : `${p}.data`);
    const total = optional(num).read(src.total, p === ROOT ? 'total' : `${p}.total`);
    return { items, total: total ?? items.length };
  });
}

/** `{data: X}` for a non-list payload. */
export function dataEnvelope<T>(inner: Decoder<T>): Decoder<T> {
  const expected = `object{data: ${inner.expected}}`;
  return decoder(expected, (v, p) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail(p, expected, v);
    const src = v as Record<string, unknown>;
    if (!('data' in src)) return fail(p, expected, v);
    return inner.read(src.data, p === ROOT ? 'data' : `${p}.data`);
  });
}

// -----------------------------------------------------------------------------
// The boundary
// -----------------------------------------------------------------------------

export interface ShapeContext {
  endpoint: string;
  method?: string;
  status?: number;
}

/** Strip query and fragment: a report must not carry an OAuth code or a filter. */
export function sanitizeEndpoint(raw: string): string {
  return raw.split('#')[0].split('?')[0];
}

/**
 * Read an already-parsed body against a declared shape.
 *
 * On mismatch: emits telemetry EXACTLY once, then throws. There is no third
 * outcome and deliberately no `fallback` parameter — an escape hatch here would
 * reintroduce the `?? []` that this module exists to delete.
 */
export function decodeBody<T>(body: unknown, shape: Decoder<T>, ctx: ShapeContext): T {
  try {
    return shape.read(body, ROOT);
  } catch (e) {
    if (!(e instanceof Mismatch)) throw e;
    const report: ShapeMismatchReport = {
      endpoint: sanitizeEndpoint(ctx.endpoint),
      method: (ctx.method ?? 'GET').toUpperCase(),
      status: ctx.status ?? 200,
      path: e.path,
      expected: e.expected,
      received: e.received,
    };
    emitShapeMismatch(report);
    throw new ResponseShapeError(report);
  }
}

/**
 * Read a `Response` from `authFetch` against a declared shape.
 *
 * A non-OK response is left to the caller's existing error handling — this
 * module's job starts at "the request succeeded and the body is wrong". A body
 * that is not JSON at all IS this module's job: 15 of the 60 measured routes
 * return non-JSON, so an HTML error page arriving where a list was expected is
 * a live possibility and reads as a mismatch rather than a parse crash.
 */
export async function decodeResponse<T>(
  response: Response,
  shape: Decoder<T>,
  ctx?: Partial<ShapeContext>,
): Promise<T> {
  const endpoint = ctx?.endpoint ?? response.url ?? '<unknown>';
  const method = ctx?.method ?? 'GET';
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    const report: ShapeMismatchReport = {
      endpoint: sanitizeEndpoint(endpoint),
      method: method.toUpperCase(),
      status: response.status,
      path: ROOT,
      expected: shape.expected,
      received: 'a body that is not JSON',
    };
    emitShapeMismatch(report);
    throw new ResponseShapeError(report);
  }
  return decodeBody(body, shape, { endpoint, method, status: response.status });
}
