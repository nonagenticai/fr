// src/utils/errors.ts
import { z } from 'zod';

import {
  integrationErrorResponse,
  isIntegrationError,
  serviceAuthIntegrationError,
  statusForIntegrationError,
} from '../integrations/_lib/errors';
import { AuthenticationError } from '../lib/service-auth';
import {
  PlankaAuthError,
  PlankaError,
  PlankaForbiddenError,
  PlankaNotFoundError,
  PlankaRateLimitError,
  PlankaValidationError,
} from '../services/planka/errors';

export class AppError extends Error {
  /**
   * Optional stable, machine-readable cause. When set it is emitted as a
   * top-level `code` on the JSON error body so a caller can branch on the
   * cause instead of pattern-matching an English `error` string (which is
   * free to change). Purely ADDITIVE — every existing consumer reads
   * `error`/`details` and is unaffected by a body that also carries `code`.
   *
   * Set it via `withCode()` at the throw site; leaving it undefined keeps the
   * pre-existing body shape byte-for-byte.
   */
  public code?: string;

  constructor(
    public statusCode: number,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = 'AppError';
  }

  /** Attach a machine-readable cause and return `this`, so a throw site can
   *  stay a single expression: `throw new NotFoundError(msg).withCode(c)`. */
  withCode(code: string): this {
    this.code = code;
    return this;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, message);
    this.name = 'ForbiddenError';
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: any) {
    super(400, message, details);
    this.name = 'BadRequestError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: any) {
    super(422, message, details);
    this.name = 'ValidationError';
  }
}

/** A Postgres SQLSTATE is exactly five chars, digits and uppercase letters. */
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

/**
 * How far to follow `.cause`. Measured against drizzle-orm 0.45.2: every throw
 * site in `pg-core/session.js` (:41, :48, :59, :66, :81, :98) constructs
 * `DrizzleQueryError(queryString, params, e)` inside `PgPreparedQuery.
 * queryWithCache`, i.e. exactly ONE wrap per statement, and the transaction
 * path reuses that same prepared-query path rather than adding a second catch.
 * So the driver error sits at depth 1 today and 3 is slack, not a guess.
 */
const PG_ERROR_CODE_MAX_DEPTH = 3;

/**
 * The Postgres SQLSTATE behind `error`, looking through wrapper errors.
 *
 * ⚠️ MEASURED IN PRODUCTION 2026-09-04, and this is why it exists. drizzle
 * wraps every driver error:
 *
 *     class DrizzleQueryError extends Error {
 *       constructor(query, params, cause) { …; this.cause = cause; }
 *     }
 *
 * It sets `.query`, `.params` and `.cause` — and NO `.code`. Both mappings in
 * this file read the SQLSTATE off the TOP-LEVEL error, so the `22P02` branch
 * below could never fire, and a malformed `:id` cast to a `uuid` column became
 * a bare 500. On the deployed pod (`fr-79866f74b6-4sg9d`, revision a4600cd9) a
 * 37-minute window held 13 HTTP 500s and ALL 13 were this:
 *
 *     [http] GET /api/projects/stream:9b9fc446-…-68908427ea32 500 25.3ms
 *     PostgresError: invalid input syntax for type uuid: "stream:…"
 *       routine: "string_to_uuid", code: "22P02"
 *
 * That is not cosmetic. A malformed id can NEVER succeed, and three layers key
 * on the 5xx class: Cloudflare replaces a 5xx body with its own HTML page,
 * `routes/agui.ts` `classifyError` advertises `retriable: true`, and 20 n8n
 * node modules retry on `statusCode >= 500`. `SsrfBlockedError` had the
 * identical failure — "a blocked SSRF
 * attempt was retried forever". Same defect class, third occurrence.
 *
 * ⚠️ THE KNOWLEDGE WAS ALREADY IN THIS REPO, TWICE, AND NEVER SHARED.
 * `routes/tools/bridge.ts` and `routes/assets/internal-create.ts` each wrote a
 * private cause-walker, each with a comment naming `DrizzleQueryError`. Neither
 * was exported, so the ONE shared mapping every route falls through to did not
 * get the fix. That is verbatim the lesson `lib/uuid-shape.ts` already records
 * about its own subject — "the guard existed, it just was not shared" — one
 * layer down, in the error path instead of the input path. Both of those copies
 * now call this function; there is one implementation, not three.
 *
 * ⚠️ WHY THE EVIDENCE REQUIREMENT TIGHTENS WITH DEPTH. At depth 0 a
 * SQLSTATE-shaped `.code` is accepted on its own, which is strictly NARROWER
 * than the bare `code === '22P02'` this replaced, so no existing behaviour
 * moves. Below that — reached only through `.cause`, which is new — the bearing
 * object must ALSO look like a pg driver error (postgres.js sets `severity` and
 * `routine`). Without that, any unrelated inner error with a five-uppercase
 * `code` (`EPIPE` is one) could be read as a SQLSTATE. Walking is the new
 * capability, so the extra proof is asked of what walking newly admits.
 *
 * Cycle-guarded because `cause` is caller-assignable and `err.cause = err` is
 * legal.
 */
export function pgErrorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth <= PG_ERROR_CODE_MAX_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    if (seen.has(current)) return undefined;
    seen.add(current);

    const candidate = current as {
      code?: unknown;
      severity?: unknown;
      routine?: unknown;
      cause?: unknown;
    };

    if (typeof candidate.code === 'string' && SQLSTATE_RE.test(candidate.code)) {
      const looksLikeDriverError =
        typeof candidate.severity === 'string' || typeof candidate.routine === 'string';
      if (depth === 0 || looksLikeDriverError) return candidate.code;
    }

    current = candidate.cause;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Inbound JSON body parse failures — a CALLER fault (400), never a 500.
//
// ~150 handlers call `await req.json()` bare. On a non-JSON body Bun 1.3 throws
// a plain `SyntaxError` (MEASURED, `bun -e`):
//     new Request(u, {method:'POST', body:'{bad'}).json()
//       -> SyntaxError, message "Failed to parse JSON"
//     new Request(u, {method:'POST', body:''}).json()     (or no body)
//       -> SyntaxError, message "Unexpected end of JSON input"
// with no `code` and nothing else to branch on, so it fell through to the
// generic 500 below.
//
// ⛔ WHY NOT MATCH ON `instanceof SyntaxError` + MESSAGE. An UPSTREAM
// `Response.json()` throws the BYTE-IDENTICAL error (same class, same
// "Failed to parse JSON", same stack shape), and ~45 service/route sites parse
// an upstream body bare (services/keycloak.ts, licenses.ts, n8n.ts,
// planka/auth.ts, ...). A message match would answer "your request was bad"
// (400) for an upstream that returned HTML — laundering an UPSTREAM fault into
// a CLIENT fault, the exact inversion scripts/check-client-input-not-upstream.ts
// polices. The two cannot be told apart from the error object alone.
//
// So provenance is recorded at the SOURCE instead: `server.ts` calls
// `tagInboundJsonParseErrors(req)` on the inbound Request before dispatch,
// which wraps THAT instance's `.json()` so a parse failure is marked with a
// symbol. Only a marked SyntaxError maps to 400. Everything else — an upstream
// body, a `JSON.parse` in our own code, a genuine code SyntaxError — keeps its
// existing status. The original error object is rethrown (only tagged), so a
// handler that already does `catch (e) { if (e instanceof SyntaxError) … }`
// behaves exactly as before.
// ---------------------------------------------------------------------------
const INBOUND_JSON_PARSE = Symbol.for('fr.inboundJsonBodyParseError');

/**
 * Wrap this inbound Request's `.json()` so a body-parse failure is marked as
 * the caller's. Idempotent; a no-op if the instance cannot be patched.
 */
export function tagInboundJsonParseErrors(req: Request): void {
  const r = req as Request & { [INBOUND_JSON_PARSE]?: true };
  if (r[INBOUND_JSON_PARSE]) return;
  const original = req.json.bind(req);
  try {
    Object.defineProperty(req, 'json', {
      configurable: true,
      writable: true,
      value: () =>
        original().catch((err: unknown) => {
          if (err instanceof SyntaxError) {
            (err as SyntaxError & { [INBOUND_JSON_PARSE]?: true })[INBOUND_JSON_PARSE] = true;
          }
          throw err;
        }),
    });
    r[INBOUND_JSON_PARSE] = true;
  } catch {
    // Non-extensible instance: keep the pre-existing behaviour (generic 500).
  }
}

/** True only for a SyntaxError raised by a TAGGED inbound `req.json()`. */
export function isInboundJsonBodyParseError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    (error as SyntaxError & { [INBOUND_JSON_PARSE]?: true })[INBOUND_JSON_PARSE] === true
  );
}

/**
 * What HTTP status does this error become? One definition, no response, no log.
 *
 * ⚠️ MEASURED 2026-09-03, and this is why it exists. `middleware/usage-spans.ts`
 * decided the metered status by duck-typing `err.status`:
 *
 *     if ('status' in err && typeof err.status === 'number') statusCode = err.status;
 *
 * NO error class in this repo carries `.status`. `AppError` carries
 * `statusCode`; `IntegrationError` carries neither. So the probe never matched
 * and every THROWN error fell through to that function's `statusCode = 500`
 * default — while errors RETURNED as a Response were recorded correctly.
 *
 * Measured consequence in `billing_metering_events` over 9 days:
 * `/api/webhooks/n8n/execution-event` shows 424 events, ALL status 500 — and
 * fr's own access log for that route over 24h shows 65x404, 120x422 and ZERO
 * 500s, with the 65 matching exactly. 1,666 rows estate-wide are recorded 500,
 * an unknown share of which are 4xx. Any 5xx alert or SLO built on that column
 * has been measuring fiction.
 *
 * Duck-typing one property name is what made that possible, so the fix is a
 * SHARED mapping rather than a second, better guess: `handleError` (which
 * produces the response the caller sees) and the span middleware (which records
 * what happened) now answer from the same function and cannot drift.
 */
/**
 * What HTTP status does an escaped `PlankaError` become? ONE mapping, shared
 * by `statusForError` and `handleError`, and deliberately the SAME mapping
 * `routes/kanban/_errors.ts toHttpError()` already encodes for its callers —
 * this is that mapping lifted to the boundary, not a second guess at it.
 *
 * ⚠️ WHY THIS EXISTS. `PlankaError` (`services/planka/errors.ts`) carries
 * `status: number` but no `data` field, so server.ts's typed-error probe
 * (`'status' in error && 'data' in error`) never matches it, and neither
 * `statusForError` nor `handleError` had a branch for it before this — so
 * every Planka failure that escaped a route without going through the local
 * `toHttpError()` shim (every route OUTSIDE `routes/kanban/*.ts`) fell to the
 * generic 500. A Planka 403 (lost board access) or 429 (rate-limited) then
 * read as "fr crashed" instead of a permission or backoff signal.
 *
 * DIVERGES FROM `toHttpError()` in exactly one place: `PlankaRateLimitError`.
 * `toHttpError()` lumps it into the generic "network, server, rate-limit,
 * conflict → 502" bucket because that shim was written before rate limits
 * were split out as their own concern. At the CENTRAL boundary, a 429 is
 * worth preserving as 429 — it is the one Planka status whose entire meaning
 * is "back off and retry later", and collapsing it into 502 makes a
 * rate-limit retry immediately instead of backing off (fr's own upstream
 * HTTP client — see `integrations/_lib/http-client.ts` — treats 5xx as
 * retriable-now and 429 as retriable-with-backoff). `toHttpError()` itself is
 * UNCHANGED — its callers in `routes/kanban/*.ts` keep getting 502 for a rate
 * limit exactly as before; only errors that escape straight to THIS boundary
 * get the corrected status.
 *
 * Every other subclass (`PlankaConflictError`, `PlankaServerError`,
 * `PlankaNetworkError`) stays in the generic 502 bucket, matching
 * `toHttpError()` exactly.
 */
/**
 * Client-facing text per mapped status. Deliberately says nothing about the
 * upstream, its path, or its body — see the note in `handleError`.
 */
const CLIENT_SAFE_PLANKA_MESSAGE: Record<number, string> = {
  400: 'Validation error',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  429: 'Rate limited',
  502: 'Upstream error',
};

/**
 * The client-safe text and status for a PlankaError — the SINGLE source of
 * truth, shared with `routes/kanban/_errors.ts`.
 *
 * ⛔ Exported deliberately rather than copied. Two independent tables of the
 * same mapping cannot disagree loudly: each stays internally consistent while
 * describing different policy, so a status added here and missed there is
 * silent. That is exactly how `toHttpError` came to echo the raw upstream
 * string this boundary refuses.
 */
export function clientSafePlankaMessage(status: number): string {
  return CLIENT_SAFE_PLANKA_MESSAGE[status] ?? 'Upstream error';
}

/**
 * The client-safe sentence for a PlankaError that a route renders ITSELF (in
 * its own envelope, e.g. `{error:'planka_card_create_failed', message}`)
 * instead of letting it escape to `handleError`. Same rule as `handleError`'s
 * PlankaError branch: never `error.message`, which `mapPlankaError` builds as
 * `Planka <status> on <internal path>` + up to 200 chars of the raw upstream
 * body. The full message is logged here, under `tag`, for the operator.
 */
export function clientSafePlankaErrorMessage(error: PlankaError, tag: string): string {
  console.error(`[${tag}] Planka failure:`, error.message);
  return clientSafePlankaMessage(statusForPlankaError(error));
}

export function statusForPlankaError(error: PlankaError): number {
  if (error instanceof PlankaNotFoundError) return 404;
  if (error instanceof PlankaValidationError) return 400;
  if (error instanceof PlankaForbiddenError) return 403;
  if (error instanceof PlankaAuthError) {
    // Planka rejected fr's OWN service account (`PlankaAuth.agentToken()` —
    // wrong, expired or locked PLANKA_AGENT_* credential). The end user is not
    // the cause, so surface as a gateway error and name Planka: a 401 here
    // makes user sessions look broken on the client side, and any client-side
    // "401 ⇒ force re-login" flow logs perfectly-authenticated users out for an
    // ops-side credential fault. 7 `plankaAsAgent()` call sites reach this.
    //
    // Identical reasoning to `integrations/_lib/errors.ts`'s
    // UPSTREAM_UNAUTHORIZED → 502, which fixed this same class on the
    // integration boundary and was never propagated to the Planka boundary.
    //
    // ⛔ NOT every Planka 401. A rejected USER credential stays 401 — there the
    // caller genuinely is unauthenticated and the client SHOULD re-auth.
    // Collapsing both would be as wrong as the bug, in the other direction.
    if (error.credentialSource === 'agent') return 502;
    return 401;
  }
  if (error instanceof PlankaRateLimitError) return 429;
  // Generic PlankaError (network, server, rate-limit-shaped-but-unclassed,
  // conflict, etc.) → 502 upstream, same as toHttpError()'s fallthrough.
  return 502;
}

export function statusForError(error: unknown): number {
  if (error instanceof AppError) return error.statusCode;
  if (error instanceof z.ZodError) return 422;

  // jose's `ERR_JWT_*` / `ERR_JWS_*` is read TOP-LEVEL and deliberately does
  // NOT use `pgErrorCode`. This used to share one `const code` with the
  // SQLSTATE branch below, and pointing that shared read at the cause-walker
  // would have silently widened the AUTH mapping over every wrapped error too —
  // 31 sites in this repo construct errors with `cause: err` (see
  // `integrations/_lib/http-client.ts`), so a jose failure buried in any of
  // them would start answering 401. Two questions, two reads.
  const joseCode = (error as { code?: unknown } | null)?.code;
  if (
    typeof joseCode === 'string' &&
    (joseCode.startsWith('ERR_JWT_') || joseCode.startsWith('ERR_JWS_'))
  ) {
    return 401;
  }

  // Both of these reach the caller through the integration converter, so the
  // status must come from ITS mapping, not a second copy of it.
  if (error instanceof AuthenticationError) {
    return statusForIntegrationError(
      serviceAuthIntegrationError({
        message: error.message,
        service: 'keycloak-token',
        statusCode: error.statusCode,
      }),
    );
  }
  if (isIntegrationError(error)) return statusForIntegrationError(error);

  // A PlankaError that escaped a route without going through the local
  // `routes/kanban/_errors.ts toHttpError()` shim. See `statusForPlankaError`
  // for the mapping and why it exists.
  if (error instanceof PlankaError) return statusForPlankaError(error);

  // Postgres invalid_text_representation — a malformed uuid/int from the caller.
  //
  // ⚠️ ORDER IS LOAD-BEARING: this MUST stay below the two branches above. It
  // used to run first, which was safe only while it read a top-level `.code`.
  // Now that it walks `.cause`, an `IntegrationError` deliberately constructed
  // with `cause: <drizzle error>` (`routes/tools/kag.ts`,
  // `routes/projects.ts`) would be answered 400 here and never reach its own
  // upstream mapping — laundering an UPSTREAM fault into a CLIENT fault, which
  // is the exact inversion `scripts/check-client-input-not-upstream.ts` exists
  // to police.
  if (pgErrorCode(error) === '22P02') return 400;

  // A malformed inbound request body — see `tagInboundJsonParseErrors`.
  if (isInboundJsonBodyParseError(error)) return 400;

  return 500;
}

export function handleError(error: unknown): Response {
  console.error('Error:', error);

  if (error instanceof AppError) {
    return new Response(
      // `code` is omitted entirely (not emitted as null) when unset, so bodies
      // for every pre-existing throw site are unchanged.
      JSON.stringify({
        error: error.message,
        details: error.details,
        ...(error.code ? { code: error.code } : {}),
      }),
      {
        status: error.statusCode,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (error instanceof z.ZodError) {
    return new Response(
      JSON.stringify({
        error: 'Validation error',
        details: error.errors,
      }),
      {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Defense-in-depth: bare jose errors (ERR_JWT_*, ERR_JWS_*) reach here when a
  // route forgets the local authErrorToResponse wrap. Map to 401, never 500.
  //
  // Read TOP-LEVEL, and deliberately NOT through `pgErrorCode` — see the note on
  // the matching branch in `statusForError`. Pointing this read at the cause
  // walker would widen the auth mapping over every error constructed with
  // `cause: err`.
  const joseCode = (error as { code?: unknown }).code;
  if (
    typeof joseCode === 'string' &&
    (joseCode.startsWith('ERR_JWT_') || joseCode.startsWith('ERR_JWS_'))
  ) {
    return new Response(
      JSON.stringify({ error: 'unauthorized' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Defense-in-depth, and the same class as the two mappings above: an
  // `IntegrationError` is NOT an `AppError`, so before this branch every one
  // that escaped a route's own `handle(...)` / `withIntegrationCatch(...)`
  // wrapper landed on the 500 below -- including the caller-side codes whose
  // entire purpose is to be a 4xx.
  //
  // MEASURED on the deployed pod (fr-5599f785d-c9h2j, revision 7922df7e):
  //     GET /api/tools/bridge/sources/artifacts/outputs   (no project_id)
  //     -> 500 {"error":"Internal server error"}
  // `handleListOutputs` calls `requireProjectIdFromQuery(req)` on its FIRST
  // line -- before `buildBridgeCtx` and outside the wrapper -- so its
  // `BAD_REQUEST` never reached `httpStatusFor` and the caller was told fr had
  // broken, for a missing query parameter.
  //
  // Fixing it HERE rather than at the one route is deliberate: the defect is
  // "a throw that escapes its wrapper", and any route can grow one. This makes
  // the escape harmless instead of relying on every handler remembering to
  // wrap. `integrationErrorResponse` is the same converter the wrappers use,
  // so a wrapped and an escaped error now render identically.
  // A service-account TOKEN MINT failure (Keycloak unreachable, or refusing the
  // client_credentials grant). Same argument as the IntegrationError branch
  // directly below, and it belongs beside it rather than in a second place:
  // `AuthenticationError` is its own class, so it matched nothing here and was
  // demoted to a bare 500 — reporting a CREDENTIAL fault as an fr code bug,
  // which sends an operator to read fr's source when the fault is a secret or a
  // network path.
  //
  // Converted here rather than in lib/service-auth.ts so `getAuthHeader`
  // callers stay free to catch it for their own retry logic; only what ESCAPES
  // to the boundary is reclassified.
  if (error instanceof AuthenticationError) {
    // Classification lives in `serviceAuthIntegrationError`, not here. It used
    // to pick `UPSTREAM_BAD_STATUS` whenever a status was present — a code whose
    // 4xx `httpStatusFor` deliberately passes THROUGH, which is right for a
    // caller-driven upstream call and wrong for a credential mint. Keycloak
    // answers 400 `invalid_client` for a wrong client secret, so a fault the
    // caller never caused reached them as "your request was bad".
    return integrationErrorResponse(
      serviceAuthIntegrationError({
        message: error.message,
        service: 'keycloak-token',
        statusCode: error.statusCode,
      }),
    );
  }

  if (isIntegrationError(error)) {
    return integrationErrorResponse(error);
  }

  // Defense-in-depth: a `PlankaError` that escaped a route without going
  // through the local `routes/kanban/_errors.ts toHttpError()` shim — every
  // route OUTSIDE `routes/kanban/*.ts` that calls into `services/planka/*`.
  // `PlankaError` carries `status`, not `data`, so server.ts's typed-error
  // probe (`'status' in error && 'data' in error`) never matches it, and
  // without this branch it fell through to the generic 500 below. See
  // `statusForPlankaError` for the mapping (and the deliberate 429
  // divergence from `toHttpError()`) and `PlankaValidationError.fields` for
  // why validation errors carry `details`.
  if (error instanceof PlankaError) {
    const status = statusForPlankaError(error);
    const details = error instanceof PlankaValidationError ? error.fields : undefined;
    // ⚠️ A GENERIC message, never `error.message`. `mapPlankaError`
    // (services/planka/errors.ts:62-74) deliberately builds a rich operator
    // string — `Planka <status> on <internal path>` plus up to 200 chars of the
    // RAW upstream body, which for a mesh deny is text like "RBAC: access
    // denied" from ztunnel/nginx, not from Planka at all. That is exactly what
    // an operator needs and exactly what a client must not receive.
    //
    // Before this branch existed these errors fell through to the generic
    // `{"error":"Internal server error"}`, so echoing the message here would
    // BROADEN disclosure across every Planka-calling route as a side effect of
    // fixing the status code. Same principle the 22P02 branch below states for
    // the raw DB message. The full error is already on the log line at the top
    // of this function, which is where the detail belongs.
    //
    // `details` IS forwarded for a validation error: `fields` describes the
    // CALLER's own input, which they are entitled to see.
    return new Response(
      JSON.stringify({
        error: CLIENT_SAFE_PLANKA_MESSAGE[status] ?? 'Upstream error',
        ...(details !== undefined ? { details } : {}),
      }),
      {
        status,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Defense-in-depth: a malformed client value (a non-UUID :id path param, a bad
  // enum literal, a non-numeric int) reaches Postgres as SQLSTATE 22P02
  // (invalid_text_representation) when a handler forwards it into a typed column
  // without validating — e.g. GET /api/projects/:id with a non-UUID id cast to a
  // `uuid` column. Postgres is the authority on what its types accept; its
  // rejection of a syntactically invalid literal is a CLIENT error (400), never a
  // 500, and must never leak the raw DB message.
  //
  // ⚠️ THIS BRANCH COULD NOT FIRE UNTIL 2026-09-04. It named the failing route in
  // its own comment while reading `.code` off a `DrizzleQueryError`, which does
  // not carry one — so the case it was written for was the case it could not
  // catch. `pgErrorCode` looks through the wrapper; see its doc comment.
  //
  // ⚠️ ORDER IS LOAD-BEARING — it must stay below the AuthenticationError and
  // IntegrationError branches above, for the reason given in `statusForError`:
  // walking `.cause` would otherwise let an IntegrationError built with
  // `cause: <drizzle error>` be answered 400 here instead of by its own upstream
  // mapping.
  if (pgErrorCode(error) === '22P02') {
    return new Response(
      JSON.stringify({ error: 'invalid request parameter' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // A non-JSON INBOUND request body (`await req.json()` on `{bad` / empty).
  // Only a SyntaxError tagged by `tagInboundJsonParseErrors` matches — an
  // upstream `Response.json()` failure is byte-identical and must NOT become a
  // 400; see the block comment above `tagInboundJsonParseErrors`.
  if (isInboundJsonBodyParseError(error)) {
    return new Response(
      JSON.stringify({ error: 'invalid JSON body' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  return new Response(
    JSON.stringify({ error: 'Internal server error' }),
    {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
