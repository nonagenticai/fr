import { jsonResponse } from '../../utils/response';
import { getCorrelationId, tryGetRequestContext } from './context';

export type IntegrationErrorCode =
  // Upstream HTTP failure modes (existing)
  | 'UPSTREAM_UNREACHABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_BAD_STATUS'
  | 'UPSTREAM_BAD_BODY'
  | 'UPSTREAM_UNAUTHORIZED'
  | 'UPSTREAM_FORBIDDEN'
  | 'UPSTREAM_NOT_FOUND'
  | 'UPSTREAM_CONFLICT'
  // The upstream is BUSY and said when to come back: a 503 or 429, relayed
  // with its status, its `Retry-After` and the body's `error` / `retry_after`.
  // Opt-in per client (`HttpClientOptions.passThroughBusy`) — today only the
  // Scientific Processor's GPU admission control (`503 {"error":"gpu_busy",
  // "lane","retry_after"}` + `Retry-After`, scientific-processor #71). Every
  // other client keeps the old mapping (503 → 502, 429 → 429 without the
  // header), so this changes nothing for them. A 502 told the caller "broken"
  // when the truth was "busy, retry in N s", and dropping `Retry-After` left
  // the caller no way to retry correctly.
  | 'UPSTREAM_BUSY'
  // fr could not mint ITS OWN service credential — the client_credentials
  // grant to Keycloak was refused or answered with nonsense. The caller did not
  // supply that credential and cannot do anything about it, so this is NEVER a
  // 4xx to them, whatever status the token endpoint chose.
  //
  // This exists because the status was previously used to classify the fault.
  // `httpStatusFor` passes upstream 4xx through (correctly — a kanban 422 on a
  // malformed card IS the caller's fault) and special-cased only 401. Keycloak
  // answers **400 `invalid_client`** for a wrong client secret, so a broken
  // fr-side credential surfaced to the user as "your request was bad". Widening
  // the 401 special case would have been the same defect one status later: 403
  // for a disabled client, 404 for a wrong realm URL.
  //
  // Kept DISTINCT from `UPSTREAM_UNAUTHORIZED` (an upstream API rejected a token
  // we did mint) and from `UPSTREAM_UNREACHABLE` (the token endpoint never
  // answered). All three are 502; conflating them would blur exactly the
  // distinction the telemetry is ranked by.
  | 'SERVICE_AUTH_FAILED'
  // Caller-side refusal: a tenant-scoped upstream call was attempted without a
  // known tenant. Never sent — raised BEFORE the request, because the ambient
  // request-context fallback would silently address the wrong tenant (see
  // kag.ts deleteDocument: a wrong-tenant purge is a 200-with-zeros no-op).
  | 'MISSING_TENANT'
  // Caller-side refusal: the INBOUND request is malformed — bad JSON, a failed
  // zod parse of the caller's body/query, a missing or non-UUID path/query
  // param, an absent multipart field, an over-cap upload. fr had not called any
  // upstream when this was raised, so nothing about it is "upstream".
  //
  // These exist because there was previously NO caller-side member here and
  // `UPSTREAM_BAD_BODY` was the nearest-sounding one, which maps to 502. That
  // cost three things: Cloudflare replaces origin 5xx bodies with its own HTML
  // so the caller never saw fr's envelope; `routes/agui.ts` classifies anything
  // without an `upstreamStatus` as `retriable: true`, so agents retried input
  // that can never succeed; and the 20 n8n node modules whose
  // `LicenseAuthenticator` retries on `statusCode >= 500` did the same, 3x.
  //
  // The names are not new — fr already emits both on the wire via plain
  // `jsonResponse` envelopes (`routes/assets/artifacts.ts:175`,
  // `routes/assets/bindings.ts:252`, `routes/tools/kag.ts:97`). Adding them here
  // puts both idioms on ONE vocabulary rather than inventing a third.
  | 'BAD_REQUEST'
  | 'PAYLOAD_TOO_LARGE'
  // Caller-side refusal (D4): the upstream PATH fr was about to request carries
  // a `.`/`..` segment (raw or %2e-encoded) or a `#`. Generated clients
  // interpolate path params raw, so an id like `x/../../workers/x` would walk
  // the upstream's routing tree. Raised in http-client BEFORE any fetch or
  // credential mint; 400, never retried.
  | 'BAD_PATH'
  // Caller-side in placement only: NOBODY's input was wrong. fr refused because
  // one of ITS OWN invariants does not hold -- a precondition a route was
  // supposed to have validated, or a server-side knob nobody configured. Both
  // are fr's fault and both are 500.
  //
  // Before this existed, 11 such sites reached for `UPSTREAM_BAD_BODY` (502),
  // which blames an upstream that was never contacted, and the caller-side
  // codes above would have been just as false -- they blame the caller. e.g.
  // `integrations/n8n.ts` "workflow id is required" is reached from
  // `GET /api/workflows/:id`, where a `:id` path segment CANNOT match empty,
  // so a violated guard there is a bug in fr, not a bad request -- one no
  // caller can fix and no retry can change.
  //
  // ONE member, not two. A separate SERVER_MISCONFIGURED would be a fourth
  // near-synonym in a union whose whole defect was that near-synonyms invite
  // mis-selection. The message carries the distinction; the status does not
  // differ.
  | 'INTERNAL_PRECONDITION'
  // Never sent upstream: the OPTIONAL upstream this client addresses has no
  // base URL on this deployment, so the feature is disabled (raised by
  // http-client `assertConfigured`). Distinct from INTERNAL_PRECONDITION
  // because nothing is broken: the env var is deliberately unset — e.g.
  // KAG_API_URL and METERING_BASE_URL after the KAG family and
  // improvement-loop-service were removed (gitops #4968). 503, and its message
  // is fr-authored ("not available on this deployment"), never upstream text.
  | 'SERVICE_NOT_CONFIGURED'
  // BYO LLM hard-fail: a byo_required tenant has no provider configured.
  // worker_management (and the worker-based services) return HTTP 402 with
  // body { code: 'byo_llm_not_configured', message }.
  | 'UPSTREAM_BYO_NOT_CONFIGURED'
  // Budget top-up payment seam (services/billing/topup.ts).
  // PAYMENT_REQUIRED: settlement did not report paid, so no tokens were
  // allocated. NOT_IMPLEMENTED: a payment provider (Stripe) is referenced but
  // not wired — a deliberate guard so real money never flows through a stub.
  | 'PAYMENT_REQUIRED'
  | 'NOT_IMPLEMENTED'
  // Bridge slice (analysis-to-kanban) domain errors
  | 'draft_not_found'
  | 'draft_not_editable'
  | 'draft_not_rejectable'
  | 'draft_not_submittable'
  | 'draft_not_committable'
  | 'draft_missing_target_list'
  | 'target_list_not_found'
  | 'draft_insert_failed'
  | 'draft_update_failed'
  | 'approval_insert_failed'
  | 'kanban_unexpected_response'
  | 'output_not_found'
  | 'coding_output_not_cached'
  | 'coding_output_unresolvable'
  | 'coding_stable_id_unrecoverable'
  | 'coding_slice_not_landed'
  | 'unknown_producer';

export interface IntegrationErrorInit {
  code: IntegrationErrorCode;
  message: string;
  /**
   * The upstream this error is ABOUT. Optional because a caller-side refusal
   * (`BAD_REQUEST`, `PAYLOAD_TOO_LARGE`, `MISSING_TENANT`) happens before any
   * upstream call, and naming one there attributes the failure to a service
   * that was never contacted. `integrationErrorResponse` and
   * `routes/agui.ts` both drop the key when it is undefined.
   */
  service?: string;
  path?: string;
  method?: string;
  upstreamStatus?: number;
  upstreamBody?: unknown;
  /**
   * This failure has ALREADY been recorded by a more specific telemetry stream,
   * so the converter must not emit a second `integration_error` line for it.
   *
   * Set it only where a dedicated line already carries strictly more detail.
   * The motivating caller is `middleware/internal-tenant-only.ts refuseTenant`,
   * which emits `internal_tenant_refused` (gate, tenant_id, admitted set) and
   * then throws this to produce the 404. Measured on prod 2026-09-04: those
   * refusals were 13 of the 38 `integration_error` rows on the current binary —
   * 34% of the whole production defect ranking — reported as an upstream named
   * `fr-streams` returning NOT_FOUND, with `path` and `upstream_status` null
   * because NO upstream was ever contacted. An access-control gate working
   * correctly, dressed as an integration failure.
   *
   * ⚠️ It suppresses only the LOG LINE. Status mapping, the response body and
   * every caller's control flow are untouched — this must never become a way to
   * silence a failure, only a way to stop counting one failure twice. The same
   * concern `statusForIntegrationError` exists for, one field over.
   */
  alreadyReported?: boolean;
  /**
   * Parameter names a CALLER-SIDE refusal requires, for a caller that can act
   * on them.
   *
   * Safe to disclose, and that is the whole point of it being a separate field
   * from `message`: a caller-side refusal contacted NO upstream, so these names
   * are fr's OWN contract, not an echo of anything a third party said. The
   * non-disclosure rule in `routes/agui.ts` exists to stop upstream messages and
   * bodies leaking to an agent; it was never meant to stop fr telling a caller
   * which of ITS parameters are missing.
   *
   * MEASURED 2026-09-01: `bridge.list_outputs` declares
   * `filters: z.record(z.string()).optional()` with the prose hint "filter shape
   * varies per producer", while each producer requires a different set —
   * artifacts `project_id`, coding `job_id`+`user_id`, kag `session_id`. An
   * agent read "optional", called without them, and was told only "the action
   * input was rejected as invalid; correct the input" — with no way to discover
   * WHAT to correct. Six identical calls in 0.8s.
   */
  requiredParams?: string[];
  /**
   * The upstream's raw `Retry-After` header. Set only for `UPSTREAM_BUSY`. It
   * is NEVER echoed verbatim: `busyRetrySeconds` validates it (integer seconds,
   * clamped 1–120; an HTTP-date or garbage is dropped and the body's
   * `retry_after` is used instead), and that ONE value is what
   * `integrationErrorResponse` emits as both the `Retry-After` header and the
   * envelope's `retry_after`.
   */
  retryAfter?: string;
  cause?: unknown;
}

export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;
  readonly service?: string;
  readonly path?: string;
  readonly method?: string;
  readonly upstreamStatus?: number;
  readonly upstreamBody?: unknown;
  readonly requiredParams?: string[];
  /** See {@link IntegrationErrorInit.retryAfter}. */
  readonly retryAfter?: string;
  /** See {@link IntegrationErrorInit.alreadyReported}. Suppresses the LOG only. */
  readonly alreadyReported?: boolean;

  constructor(init: IntegrationErrorInit) {
    super(init.message);
    this.name = 'IntegrationError';
    this.code = init.code;
    this.service = init.service;
    this.path = init.path;
    this.method = init.method;
    this.upstreamStatus = init.upstreamStatus;
    this.upstreamBody = init.upstreamBody;
    this.requiredParams = init.requiredParams;
    this.retryAfter = init.retryAfter;
    this.alreadyReported = init.alreadyReported;
    if (init.cause !== undefined) {
      (this as { cause?: unknown }).cause = init.cause;
    }
  }
}

export function isIntegrationError(err: unknown): err is IntegrationError {
  return err instanceof IntegrationError;
}

/**
 * The HTTP status this IntegrationError becomes — WITHOUT converting or logging.
 *
 * Exported because two places need the same answer and only one of them may
 * produce a response. `integrationErrorResponse` both maps AND emits telemetry,
 * so a caller that only wants the number (the usage-span middleware, which
 * meters an error the boundary is separately converting) cannot call it: doing
 * so would double-log every failure it measured.
 *
 * ONE definition, because the alternative is a second copy of the mapping that
 * drifts — which is exactly the defect this export was added to fix. The span
 * middleware had duck-typed `err.status`, a property NO error class in this repo
 * carries, so every thrown error was metered as its 500 default.
 */
export function statusForIntegrationError(err: IntegrationError): number {
  return httpStatusFor(err);
}

function httpStatusFor(err: IntegrationError): number {
  switch (err.code) {
    case 'SERVICE_AUTH_FAILED':
      // fr's own credential mint failed. Always a gateway fault — see the union
      // member for why this is a category and not a status.
      return 502;
    case 'UPSTREAM_UNAUTHORIZED':
      // fr's credential to upstream is rejected (key rotated/revoked).
      // The end-user is not the cause — surface as gateway error so user
      // sessions don't look broken on the client side. (403 stays passthrough:
      // upstream may legitimately deny based on tenant/scope claims forwarded
      // from the user; collapsing it would hide real permission errors.)
      return 502;
    case 'UPSTREAM_BYO_NOT_CONFIGURED':
      // Pass the BYO hard-fail through unchanged so the UI can prompt the user
      // to configure their LLM provider.
      return 402;
    case 'UPSTREAM_FORBIDDEN':
      return 403;
    case 'UPSTREAM_NOT_FOUND':
      return 404;
    case 'UPSTREAM_CONFLICT':
      return 409;
    case 'UPSTREAM_TIMEOUT':
      return 504;
    case 'UPSTREAM_BUSY':
      // Only ever built from a 503 or 429 (http-client `passThroughBusy`);
      // anything else is a construction bug, and 503 is the honest default.
      return err.upstreamStatus === 429 ? 429 : 503;
    case 'UPSTREAM_UNREACHABLE':
      return 502;
    case 'UPSTREAM_BAD_STATUS':
      // NOTE: the provider-not-configured case never reaches here —
      // integrationErrorResponse() intercepts it earlier so it can set the body
      // as well as the status. A duplicate mapping here was unreachable (this
      // function is module-private and has exactly one caller), and a mutation
      // test proved it: removing it changed nothing. Deleted rather than left
      // as decorative dead code.
      // Preserve 4xx caused by request shape (400, 404, 409, 422, 403);
      // collapse 401 (fr-cred problem, not user's) and 5xx into 502.
      if (err.upstreamStatus && err.upstreamStatus >= 400 && err.upstreamStatus < 500) {
        if (err.upstreamStatus === 401) return 502;
        return err.upstreamStatus;
      }
      return 502;
    case 'UPSTREAM_BAD_BODY':
      return 502;
    // Bridge codes
    case 'draft_not_found':
    case 'output_not_found':
    case 'coding_output_not_cached':
    case 'coding_output_unresolvable':
    case 'unknown_producer':
      return 404;
    case 'draft_not_editable':
    case 'draft_not_rejectable':
    case 'draft_not_submittable':
    case 'draft_not_committable':
      return 409;
    case 'draft_missing_target_list':
    case 'coding_stable_id_unrecoverable':
      return 422;
    case 'target_list_not_found':
      return 404;
    case 'draft_insert_failed':
    case 'draft_update_failed':
    case 'approval_insert_failed':
    case 'kanban_unexpected_response':
      return 502;
    case 'coding_slice_not_landed':
      return 503;
    // Never sent upstream: fr could not name the tenant the resource was written
    // under, so the call was refused. The state is unresolvable by retrying the
    // same request (an operator must supply the tenant) — 409, mirroring the
    // documents-delete route's own refusal.
    case 'MISSING_TENANT':
      return 409;
    // Never sent upstream: the CALLER's request was refused. 4xx is not
    // cosmetic here — it is the signal every retry layer keys on. See the union
    // comment above for what a 502 cost.
    case 'BAD_REQUEST':
    case 'BAD_PATH':
      return 400;
    case 'PAYLOAD_TOO_LARGE':
      return 413;
    // Never sent upstream, and not the caller's fault either: an fr invariant
    // does not hold. 500 is the only honest answer -- a 4xx would tell the
    // caller to fix input that is already correct, and a 502 would blame an
    // upstream that was never contacted.
    case 'INTERNAL_PRECONDITION':
      return 500;
    // Never sent upstream: an optional upstream is not configured on this
    // deployment, so the feature is disabled. 503 — unavailable here.
    case 'SERVICE_NOT_CONFIGURED':
      return 503;
    // Budget top-up seam.
    case 'PAYMENT_REQUIRED':
      // Settlement didn't report paid; nothing was allocated. 402 so the UI can
      // surface "payment needed" once a provider exists (today it only fires on
      // a priced package with no processor — a misconfiguration).
      return 402;
    case 'NOT_IMPLEMENTED':
      // A payment provider is referenced but not wired. 501 — server-side gap,
      // not the caller's fault.
      return 501;
    default: {
      const _exhaustive: never = err.code;
      void _exhaustive;
      return 500;
    }
  }
}

/** Pull a human message + machine code out of an upstream BYO 402 body. */
/**
 * An upstream 502 whose body says a provider is simply NOT CONFIGURED.
 *
 * worker_management answers `/providers/:p/models` for an unconfigured provider
 * with a fast, perfectly clear JSON 502:
 *
 *   {"error":{"code":"BAD_GATEWAY",
 *     "message":"Upstream unreachable for provider 'anthropic': ANTHROPIC_API_KEY is not configured"}}
 *
 * fr used to pass that straight through as a 502 — and because it is a 5xx,
 * Cloudflare REPLACES the body with its own HTML error page. The one piece of
 * information that would have explained everything ("ANTHROPIC_API_KEY is not
 * configured") was destroyed in transit, so /chat showed an empty model
 * dropdown and no reason. Measured live 2026-08-07: 7 of 11 providers
 * (anthropic, openai, groq, google, deepseek, cohere, vlm_local) behaved this
 * way, which is what "fr chat is broken" actually was.
 *
 * This is a CONFIGURATION state, not a gateway failure, so it must not be a
 * 5xx. Same reasoning as UPSTREAM_BYO_NOT_CONFIGURED above, which is already
 * mapped off 5xx for exactly this reason.
 */
function providerNotConfigured(err: IntegrationError): string | null {
  if (err.upstreamStatus !== 502) return null;
  const body = err.upstreamBody;
  if (!body || typeof body !== 'object') return null;
  const flat = body as { message?: unknown };
  const nested = (body as { error?: { message?: unknown } }).error;
  const message =
    (typeof flat.message === 'string' && flat.message) ||
    (nested && typeof nested.message === 'string' && nested.message) ||
    '';
  return /is not configured/i.test(message) ? message : null;
}

// ---- Busy retry hint (UPSTREAM_BUSY) ----
//
// Same semantics as kag-frontend `routes/research/scientific.ts`
// (parseRetryAfterHeader / parseRetryAfterBody / upstreamBusyResponse):
//   * the hint is whole seconds clamped to [1, 120];
//   * the `Retry-After` header wins when it is an integer (`^-?\d{1,9}$`) —
//     an HTTP-date or garbage is dropped, NOT relayed;
//   * else the body's numeric `retry_after` (finite → ceil);
//   * a 503 with NO valid hint is not "busy" — it is kag's own connection
//     failure or a mesh "no healthy upstream", and stays a 502 (http-client);
//   * 429 is busy by definition; its hint is optional.
// ONE value is emitted as both header and body, so they can never disagree.

const SAFE_BUSY_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
const RETRY_AFTER_MIN_S = 1;
const RETRY_AFTER_MAX_S = 120;

function clampRetrySeconds(n: number): number {
  return Math.min(RETRY_AFTER_MAX_S, Math.max(RETRY_AFTER_MIN_S, n));
}

/** `Retry-After` header → whole seconds in [1, 120], or undefined if not an integer. */
export function parseRetryAfterHeader(raw: string | null | undefined): number | undefined {
  const v = raw?.trim();
  if (v === undefined || !/^-?\d{1,9}$/.test(v)) return undefined;
  return clampRetrySeconds(Number(v));
}

/** Body `retry_after` → whole seconds in [1, 120], or undefined if not a finite number. */
export function parseRetryAfterBody(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return clampRetrySeconds(Math.ceil(raw));
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/**
 * The validated retry hint of a busy answer: header first, else body
 * `retry_after`; undefined when neither is valid. http-client uses it to decide
 * whether a 503 is busy at all; the response uses it for header AND body.
 */
export function busyRetrySeconds(
  retryAfterHeader: string | null | undefined,
  body: unknown,
): number | undefined {
  return parseRetryAfterHeader(retryAfterHeader) ?? parseRetryAfterBody(bodyRecord(body).retry_after);
}

/**
 * The retry contract of a BUSY upstream, as fr-built top-level fields of the
 * error envelope — NOT the raw body, so they survive caller redaction
 * (`redactForCaller` drops only `service` and `upstream`). Each is validated:
 *   * `upstream_error` — the body's `error` token (`gpu_busy`), only if it is a
 *                        plain identifier (`^[a-z][a-z0-9_]{0,63}$`);
 *   * `lane`           — which admission lane was full, same rule;
 *   * `retry_after`    — `busyRetrySeconds`; absent when there is no valid
 *                        hint — fr never invents a back-off.
 */
function busyDetail(err: IntegrationError): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const b = bodyRecord(err.upstreamBody);
  if (typeof b.error === 'string' && SAFE_BUSY_TOKEN.test(b.error)) out.upstream_error = b.error;
  if (typeof b.lane === 'string' && SAFE_BUSY_TOKEN.test(b.lane)) out.lane = b.lane;
  const seconds = busyRetrySeconds(err.retryAfter, err.upstreamBody);
  if (seconds !== undefined) out.retry_after = seconds;
  return out;
}

function byoErrorDetail(err: IntegrationError): { code: string; message: string } {
  const fallback = 'Configure your LLM provider in Settings before running agents.';
  const body = err.upstreamBody;
  if (body && typeof body === 'object') {
    // worker_management returns { code, message }; some services wrap it as
    // { error: { code, message } }. Accept both.
    const flat = body as { code?: unknown; message?: unknown };
    const nested = (body as { error?: { code?: unknown; message?: unknown } }).error;
    const message =
      (typeof flat.message === 'string' && flat.message) ||
      (nested && typeof nested.message === 'string' && nested.message) ||
      fallback;
    return { code: 'byo_llm_not_configured', message };
  }
  return { code: 'byo_llm_not_configured', message: fallback };
}

/**
 * Structured telemetry for an upstream failure.
 *
 * THIS LIVES HERE, not in a route wrapper, because this file is the single
 * funnel every failing integration passes through. It used to live in
 * `routes/assets/_lib/handler.ts`, which reaches 41 call sites — leaving the
 * other 32 modules that call `integrationErrorResponse` DIRECTLY with no
 * telemetry at all.
 *
 * MEASURED 2026-08-30: `GET /api/admin/licenses/budget/:tenantId` returned 502
 * twenty-one times in one burst and left exactly one line per failure —
 * `[http] … 502 18ms` — with no code, no service, no cause. Its handler goes
 * through `gated()` in `routes/admin/licenses-admin.ts`, a second copy of the
 * convert-and-return pattern that never called the logger. The upstream signal
 * from that burst is now unrecoverable. Same-shaped proof from the other side:
 * the telemetry line fires for `pricing-admin` (which uses the wrapper) and
 * ZERO times for `metering-admin` (which does not).
 *
 * Putting it in the converter means every present and future caller is covered
 * by construction, including ones that never heard of the wrapper.
 *
 * `http_status` is what WE returned; `upstream_status` is what the upstream
 * said. They differ on purpose — `httpStatusFor` collapses upstream 401 and 5xx
 * into 502 — and without both, a 502 in the access log cannot be traced back to
 * the credential failure that caused it.
 *
 * The upstream BODY is deliberately never logged: it can carry tokens and PII.
 */
export function logIntegrationFailure(err: IntegrationError, httpStatus: number): void {
  // A more specific stream already recorded this one. Emitting here too would
  // double-count it AND rank it as an upstream failure it is not.
  if (err.alreadyReported) return;
  try {
    console.error(
      JSON.stringify({
        telemetry: 'integration_error',
        code: err.code,
        // `?? null`, not a bare read: `service` became OPTIONAL on main — a
        // CALLER-side refusal (BAD_REQUEST / PAYLOAD_TOO_LARGE / MISSING_TENANT)
        // names no upstream because none was contacted. Without the coalesce
        // JSON.stringify DROPS the key, so those lines would carry a different
        // SHAPE from every other telemetry line and a parser keyed on `service`
        // would skip them silently — the same defect class this telemetry exists
        // to end. Preserved from main's version of the logger, which lived in
        // routes/assets/_lib/handler.ts before this moved to the converter.
        service: err.service ?? null,
        method: err.method ?? null,
        path: err.path ?? null,
        upstream_status: err.upstreamStatus ?? null,
        http_status: httpStatus,
        message: err.message,
        correlation_id: getCorrelationId() ?? null,
      }),
    );
  } catch {
    // Logging must never turn an upstream refusal into a 500.
  }
}

/**
 * Classify a failed service-credential mint.
 *
 * This lived inline in server.ts's error boundary, where nothing could test it
 * — every test that "covered" it constructed the IntegrationError by hand and
 * so asserted its own input. That is how the defect below survived review.
 *
 * The rule is about WHO is at fault, not which status the token endpoint chose:
 *
 *   * no status  -> UPSTREAM_UNREACHABLE. `fetch` itself failed; the endpoint
 *                   never answered. An operator's problem is networking.
 *   * any status -> SERVICE_AUTH_FAILED. Keycloak answered and refused. An
 *                   operator's problem is the client secret / realm / client id.
 *
 * Both are 502. Neither is ever the caller's fault: they did not supply fr's
 * service credential and can do nothing about it. `UPSTREAM_BAD_STATUS` — the
 * code this used to pick when a status was present — deliberately passes 4xx
 * THROUGH, which is right for a caller-driven upstream call (a kanban 422 on a
 * malformed card) and wrong here. Keycloak answers 400 `invalid_client` for a
 * wrong secret, so a broken fr-side credential reached the user as HTTP 400.
 */
export function serviceAuthIntegrationError(init: {
  message: string;
  service: string;
  statusCode?: number;
}): IntegrationError {
  return new IntegrationError({
    code: init.statusCode === undefined ? 'UPSTREAM_UNREACHABLE' : 'SERVICE_AUTH_FAILED',
    message: init.message,
    service: init.service,
    upstreamStatus: init.statusCode,
  });
}

/**
 * Record a failure that is being SWALLOWED on purpose, without converting it
 * into a response.
 *
 * There is a whole family of `catch { rows = []; }` in fr: a list falls back to
 * empty, a rollup to zero, a sparkline to a flat line. Most are deliberate — an
 * inherited-asset lookup that has not been provisioned yet SHOULD degrade rather
 * than 500 the page. The defect is not the fallback, it is that the fallback is
 * INVISIBLE: an upstream outage and a genuinely empty result produce byte-
 * identical output and byte-identical logs, so "no data" and "we could not read
 * the data" cannot be told apart afterwards.
 *
 * This emits the same `integration_error` line the converter emits, so a
 * swallowed failure still appears in the ranking, while leaving the caller's
 * behaviour exactly as it was. `http_status` is null precisely because no
 * response was produced — that is what distinguishes a swallowed failure from a
 * served one when reading the telemetry.
 *
 * Use it at the catch site you are keeping. It is not a substitute for throwing
 * where throwing is right.
 */
export function reportSwallowedFailure(err: unknown, context: {
  service: string;
  method?: string;
  path?: string;
  /** What the caller gets instead, e.g. 'empty list'. Recorded, not inferred. */
  degradedTo: string;
}): void {
  try {
    const integ = isIntegrationError(err) ? err : undefined;
    console.error(
      JSON.stringify({
        telemetry: 'integration_error',
        code: integ?.code ?? 'SWALLOWED_NON_INTEGRATION_ERROR',
        service: integ?.service ?? context.service,
        method: integ?.method ?? context.method ?? null,
        path: integ?.path ?? context.path ?? null,
        upstream_status: integ?.upstreamStatus ?? null,
        // null, not a number: nothing was served from this failure.
        http_status: null,
        swallowed: true,
        degraded_to: context.degradedTo,
        message: err instanceof Error ? err.message : String(err),
        correlation_id: getCorrelationId() ?? null,
      }),
    );
  } catch {
    // Reporting a swallowed failure must never itself become one.
  }
}

/**
 * Converts and LOGS. See `logIntegrationFailure` for why the logging is here.
 */
export function integrationErrorResponse(err: IntegrationError): Response {
  const { body, status } = buildIntegrationErrorBody(err);
  logIntegrationFailure(err, status);
  // The SAME validated value as the envelope's `retry_after` (busyDetail).
  const retrySeconds =
    err.code === 'UPSTREAM_BUSY' ? busyRetrySeconds(err.retryAfter, err.upstreamBody) : undefined;
  return jsonResponse(
    body,
    status,
    retrySeconds !== undefined ? { 'Retry-After': String(retrySeconds) } : undefined,
  );
}

/**
 * Client-safe text per status for an UPSTREAM-describing failure. A browser
 * must not learn fr's internal topology from an error: the raw message is
 * `"<service> <METHOD> <internal path> returned <status>"` (measured:
 * `worker_management GET /providers/xai/models returned 403` shown to a
 * customer), `service` names an internal service, and `upstream.body` can carry
 * anything the upstream chose to say. All of it stays on the log line
 * (`logIntegrationFailure`), which is where an operator reads it.
 */
const CLIENT_SAFE_INTEGRATION_MESSAGE: Readonly<Record<number, string>> = {
  400: 'The request was rejected',
  401: 'Not authorized',
  402: 'Payment required',
  403: 'You do not have access to this',
  404: 'Not found',
  409: 'Conflict with the current state — reload and try again',
  413: 'Request too large',
  422: 'The request was rejected',
  424: 'A required provider is not configured',
  429: 'Too many requests — try again shortly',
  502: 'A backing service failed — try again',
  503: 'A backing service is unavailable — try again',
  504: 'A backing service timed out — try again',
};

export function clientSafeIntegrationMessage(status: number): string {
  return CLIENT_SAFE_INTEGRATION_MESSAGE[status] ?? 'Something went wrong — try again';
}

/**
 * Upstream statuses whose BODY describes the CALLER's own input (a validation
 * list, a conflict on the caller's write). Same principle `utils/errors.ts`
 * applies to a Planka validation error's `fields`: the caller is entitled to
 * see why THEIR input was refused. Every other upstream body is withheld.
 */
const CALLER_INPUT_STATUSES: ReadonlySet<number> = new Set([400, 409, 422]);

/**
 * Codes whose message/body describe an UPSTREAM (or fr's own credential mint).
 * Everything else is an fr-local code (`BAD_REQUEST`, `MISSING_TENANT`, the
 * bridge codes, ...) whose message fr authored about the caller's request.
 */
function describesUpstream(code: string): boolean {
  return code.startsWith('UPSTREAM_') || code === 'SERVICE_AUTH_FAILED';
}

/**
 * Raw upstream detail is for super-admins only. Redacted whenever a request
 * frame exists and its VERIFIED caller is not a super-admin — including frames
 * that never set the flag (fail closed). With no request frame at all (cron,
 * startup, unit tests calling the converter directly) nothing reaches a browser
 * and the full body is kept.
 */
function shouldRedactForCaller(): boolean {
  const ctx = tryGetRequestContext();
  if (!ctx) return false;
  return ctx.callerIsSuperAdmin !== true;
}

/**
 * The client-safe `message` for an IntegrationError that a route renders
 * ITSELF instead of going through `integrationErrorResponse` (provision,
 * artifact download, ...). Same rule as the converter: the raw upstream
 * sentence for a super-admin (or with no request frame at all), the generic
 * per-status text for everyone else. fr-local codes keep fr's own message.
 */
export function clientSafeIntegrationErrorMessage(err: IntegrationError, status: number): string {
  if (!shouldRedactForCaller()) return err.message;
  return redactedIntegrationText(err, status);
}

/** The redacted text, independent of who is calling. */
function redactedIntegrationText(err: IntegrationError, status: number): string {
  return describesUpstream(err.code) ? clientSafeIntegrationMessage(status) : err.message;
}

/**
 * Client-safe text for an ARBITRARY caught error a route puts into a response
 * body (a warning field, a `failed[].error`, an NDJSON error event, ...).
 * Super-admin / no frame: the raw message. Otherwise an IntegrationError gets
 * the per-status generic text, and any other error gets `fallback` — fr cannot
 * tell whether a plain Error's text was copied from an upstream (secrets-service
 * embeds its raw response body), so it fails closed. Routes that know an error
 * is fr-authored (AppError, a validation error) should render it directly.
 */
export function clientSafeCaughtErrorText(
  err: unknown,
  fallback: string,
  opts: {
    /**
     * Redact regardless of the CURRENT caller. Use when the text is STORED in a
     * column a customer reads back later: the writer may be a super-admin, the
     * reader is not. The raw text belongs on the log line.
     */
    forStorage?: boolean;
  } = {},
): string {
  if (!opts.forStorage && !shouldRedactForCaller()) {
    return err instanceof Error ? err.message : String(err);
  }
  if (isIntegrationError(err)) return redactedIntegrationText(err, httpStatusFor(err));
  return fallback;
}

/**
 * Like `clientSafeCaughtErrorText`, but only an IntegrationError is redacted;
 * any other error keeps its message. For surfaces whose non-upstream errors are
 * fr-authored and actionable (AG-UI action validation, RBAC, scope errors).
 */
export function clientSafeUpstreamText(err: unknown): string {
  if (isIntegrationError(err)) return clientSafeIntegrationErrorMessage(err, httpStatusFor(err));
  return err instanceof Error ? err.message : String(err);
}

/** Exported so a self-rendering route can drop its OTHER upstream-derived fields. */
export function shouldRedactUpstreamDetailForCaller(): boolean {
  return shouldRedactForCaller();
}

/**
 * READ-path redaction for raw failure text fr STORED in a column (an n8n
 * callback problem on `approvals.error_message`, an adapter error on
 * `engagement_deliveries.error`, ...). The column keeps the raw value because
 * operators triage from it; only the response a non-super-admin receives is
 * rewritten. `null` stays `null` so "no error" is still distinguishable from
 * "an error we will not show you".
 */
export function clientSafeStoredErrorText(
  raw: string | null | undefined,
  generic: string,
): string | null {
  if (raw === null || raw === undefined) return raw ?? null;
  return shouldRedactForCaller() ? generic : raw;
}

/**
 * Keys under which a STORED JSON document (an approved action's output on
 * `engagement_deliveries.metadata_json`, ...) carries failure text. The action
 * registry is open — any handler's return value lands there — so the match is
 * on the key's NAME, not on a per-action schema: `error`, `errors`,
 * `kanban_error`, `errorMessage`, `error_text`, `message`, `detail`, `stack`,
 * `stderr`, `traceback`, `reason`, `failure_reason`, `skipReason`, ...
 */
const STORED_ERROR_KEY =
  /^(err|errors?|error_?message|errorMessage|error_?text|errorText|messages?|msg|exception|stack(_?trace)?|stackTrace|traceback|stderr|details?|reason|why|failures?|upstream_?body|upstreamBody|upstream_?response|upstreamResponse|upstream_?text|upstreamText|response_?text|responseText|problems?|hints?|causes?|warnings?|logs?|stdout|output_?text)$|[_-](error|errors|detail|details|exception|reason|failure)$|[a-z](Error|Errors|Detail|Details|Exception|Reason|Failure)$/i;
/**
 * The subset of error keys whose PRESENCE marks the enclosing object as a
 * failure record. `message` / `detail` / `reason` are redacted wherever they
 * appear but do not, alone, mark a success payload (`{sent: 3, message: "ok"}`)
 * as a failure.
 */
const FAILURE_MARKER_KEY =
  /^(err|errors?|error_?message|errorMessage|error_?text|errorText|exception|stack(_?trace)?|stackTrace|traceback|stderr|failures?|failure_reason|problems?|causes?)$|[_-](error|errors|exception|failure)$|[a-z](Error|Errors|Exception|Failure)$/i;
const STORED_JSON_MAX_DEPTH = 20;
/** Keys that hold an upstream's raw reply; denied whole inside any error-like object. */
const STORED_RAW_REPLY_KEY = /^(body|raw|raw_?body|response|response_?body|responseBody|upstream|output|stdout)$/i;
/**
 * A list of the things that FAILED (`{failed: [{target, why}]}`): every element
 * is a failure record, so the list is an error subtree (deny-by-default) even
 * though its elements carry no failure-marker key of their own.
 */
const STORED_FAILED_LIST_KEY = /^(failed|failed_?(items|targets|records|deliveries|recipients))$/i;
/**
 * At an ERROR-LIKE ROOT, the only direct STRING members that pass are
 * identifiers and kinds (`id`, `*_id`, `kind`, `type`, `channel`, `action`).
 * FR-7: the root used to deny only the raw-reply keys, so `{ok:false, text}`,
 * `{ok:false, problem}` or any other UNLISTED key carried raw failure text
 * straight through. Deny-by-default: an error-like root's own prose is failure
 * text whatever its key. Strings inside arrays/objects under the root (the
 * customer's own `delivered_to` list) keep the per-key rules.
 */
const STORED_ROOT_SAFE_STRING_KEY =
  /^(id|[a-z0-9]+_id|[a-z0-9]+Id|kind|type|channel|channel_?kind|action|action_?type|correlation_?id)$/i;
/** HTTP-status keys. A STRING value under an error-like parent is upstream text ("503 from …"). */
const STATUS_KEYS = ['status', 'statusCode', 'status_code', 'http_status', 'statusText', 'status_text'] as const;
const STORED_STATUS_KEY = /^(status|status_?code|statusCode|http_?status|status_?text|statusText)$/i;

/** An HTTP failure status, numeric (503) or as a string that starts with one ("503", "503 Service Unavailable"). */
function isFailureStatus(v: unknown): boolean {
  if (typeof v === 'number') return v >= 400;
  if (typeof v === 'string') {
    const m = /^\s*(\d{3})\b/.exec(v);
    return m !== null && Number(m[1]) >= 400;
  }
  return false;
}

/**
 * An object is ERROR-LIKE when it says it failed: it carries a non-null
 * failure-marker member (`FAILURE_MARKER_KEY`), `ok:false` / `success:false`, or an HTTP status >= 400.
 * Inside one, every string is failure text by default (deny-by-default): a
 * `response.body` or `body` there is an upstream's raw reply whatever its key.
 */
function isErrorLikeObject(obj: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined && v !== false && FAILURE_MARKER_KEY.test(k)) return true;
  }
  if (obj.ok === false || obj.success === false) return true;
  for (const k of STATUS_KEYS) {
    if (isFailureStatus(obj[k])) return true;
  }
  return false;
}

/**
 * READ-path redaction of failure text inside a STORED JSON document, for the
 * same reason as `clientSafeStoredErrorText`: the column keeps the raw value
 * (operators triage from it, and rows written before the write-path fixes are
 * already there); a non-super-admin reader gets every error-keyed STRING
 * replaced by `generic` (array elements one by one, so the count survives; a
 * nested object under an error key collapses to `generic`), and EVERY string
 * inside a NESTED error-like object (see `isErrorLikeObject`) replaced as well
 * — deny-by-default, so a `response.body` there cannot pass on an unlisted key.
 * At the root an error-like document has its raw-reply keys
 * (`STORED_RAW_REPLY_KEY`), a STRING status and EVERY direct string member that
 * is not an identifier/kind (`STORED_ROOT_SAFE_STRING_KEY`) denied — so
 * `{ok:false, text}` cannot pass on an unlisted key (FR-7). A `failed` list
 * (`STORED_FAILED_LIST_KEY`) is an error subtree wherever it appears (a STRING
 * `failed` is failure text), and
 * `why` / `upstream_body` / `response_text` are error keys everywhere.
 * Non-error keys outside an error-like object, numbers, booleans and nulls are
 * untouched. Super-admin / no frame: as stored.
 */
export function clientSafeStoredJson<T>(value: T, generic: string): T {
  if (!shouldRedactForCaller()) return value;
  return scrubStoredJson(value, generic, false, false, 0) as T;
}

function scrubStoredJson(
  value: unknown,
  generic: string,
  underErrorKey: boolean,
  inErrorSubtree: boolean,
  depth: number,
): unknown {
  if (value === null || value === undefined) return value;
  if (depth > STORED_JSON_MAX_DEPTH) return generic;
  if (typeof value === 'string') return underErrorKey || inErrorSubtree ? generic : value;
  if (Array.isArray(value)) {
    return value.map((v) => scrubStoredJson(v, generic, underErrorKey, inErrorSubtree, depth + 1));
  }
  if (typeof value === 'object') {
    if (underErrorKey) return generic;
    const obj = value as Record<string, unknown>;
    const errorLike = isErrorLikeObject(obj);
    // The ROOT is the action's whole output: a partial failure there must not
    // blank the customer's own `delivered_to` list, so at the root only the
    // raw-reply keys are denied. Any NESTED error-like object is denied whole.
    const subtree = inErrorSubtree || (depth > 0 && errorLike);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const child =
        subtree ||
        (errorLike && STORED_RAW_REPLY_KEY.test(k)) ||
        // A string status under an error-like parent is upstream text, not a code.
        (errorLike && STORED_STATUS_KEY.test(k) && typeof v === 'string') ||
        // `failed: [{target, why}]` — each element is a failure record; and a
        // STRING `failed` ("timeout talking to …") is failure text itself.
        (STORED_FAILED_LIST_KEY.test(k) && v !== null && (typeof v === 'object' || typeof v === 'string')) ||
        // Deny-by-default at an error-like ROOT for direct string members.
        (depth === 0 && errorLike && typeof v === 'string' && !STORED_ROOT_SAFE_STRING_KEY.test(k));
      out[k] = scrubStoredJson(v, generic, STORED_ERROR_KEY.test(k), child, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * kag's proxy (`knowledge/kag/src/services/proxy.py`, the HTTPStatusError
 * branch) re-raises a DOWNSTREAM 4xx as
 * `{"detail": "Backend service error (<status>): <500-char body preview>"}` —
 * the preview is another internal service's own body, so a 409/422 that fr
 * passes through as "the caller's own input" would hand a customer a slice of
 * an internal service's response. Matched on the wrapper, not on kag: any
 * service that adopts the same proxy helper gets the same treatment.
 */
const PROXY_WRAPPED_DETAIL = /Backend service error \(\d{3}\)/;
const CALLER_INPUT_MAX_DEPTH = 20;

/** True when ANY string anywhere in `value` carries the proxy wrapper. */
function containsProxyWrappedText(value: unknown, depth = 0): boolean {
  if (depth > CALLER_INPUT_MAX_DEPTH) return true; // fail closed on pathological nesting
  if (typeof value === 'string') return PROXY_WRAPPED_DETAIL.test(value);
  if (Array.isArray(value)) return value.some((v) => containsProxyWrappedText(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) =>
      containsProxyWrappedText(v, depth + 1),
    );
  }
  return false;
}

/** A FastAPI validation item → only `{loc, msg, type}` (drops the echoed `input`, `ctx`, `url`). */
function validationItem(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const { loc, msg, type } = item as { loc?: unknown; msg?: unknown; type?: unknown };
  return { loc, msg, type };
}

/**
 * The caller-input body (400/409/422) a non-super-admin may see.
 *  - a proxy-wrapped text ANYWHERE in the body (a string, `{detail}`,
 *    `{message}`, nested, or not at the start of the string) → dropped entirely;
 *  - a FastAPI validation list, top-level or under `detail` → only
 *    `{loc, msg, type}` per item (`input`, `ctx` and `url` echo values and doc
 *    links the caller does not need);
 *  - anything else → unchanged (a typed problem body the service wrote for
 *    its client, e.g. a requirements 422 naming the caller's bad field).
 */
export function clientSafeCallerInputBody(body: unknown): unknown {
  if (containsProxyWrappedText(body)) return undefined;
  if (Array.isArray(body)) return body.map(validationItem);
  if (!body || typeof body !== 'object') return body;
  const detail = (body as { detail?: unknown }).detail;
  if (Array.isArray(detail)) {
    return { ...(body as Record<string, unknown>), detail: detail.map(validationItem) };
  }
  return body;
}

function redactForCaller(
  err: IntegrationError,
  body: { error: Record<string, unknown> },
  status: number,
): { error: Record<string, unknown> } {
  const { service: _service, upstream: _upstream, ...rest } = body.error;
  const out: Record<string, unknown> = { ...rest };
  // Keyed on the BODY's code: the BYO (`byo_llm_not_configured`) and
  // `provider_not_configured` bodies carry an actionable sentence fr built for
  // exactly this user ("configure your provider key"), so they keep it.
  if (describesUpstream(String(rest.code ?? err.code))) {
    out.message = clientSafeIntegrationMessage(status);
  }
  if (err.upstreamStatus !== undefined) {
    const safeBody = CALLER_INPUT_STATUSES.has(status)
      ? clientSafeCallerInputBody(err.upstreamBody)
      : undefined;
    out.upstream =
      safeBody !== undefined
        ? { status: err.upstreamStatus, body: safeBody }
        : { status: err.upstreamStatus };
  }
  return { error: out };
}

function buildIntegrationErrorBody(err: IntegrationError): {
  body: unknown;
  status: number;
} {
  const full = buildFullIntegrationErrorBody(err);
  if (!shouldRedactForCaller()) return full;
  return {
    body: redactForCaller(err, full.body as { error: Record<string, unknown> }, full.status),
    status: full.status,
  };
}

function buildFullIntegrationErrorBody(err: IntegrationError): {
  body: unknown;
  status: number;
} {
  // For the BYO hard-fail, surface the actionable upstream message + the
  // machine-readable `byo_llm_not_configured` code at the top level so the UI
  // can prompt the user (and link to Settings → LLM Provider) instead of
  // showing a generic "upstream returned 402".
  if (err.code === 'UPSTREAM_BYO_NOT_CONFIGURED') {
    const detail = byoErrorDetail(err);
    return {
      body: {
        error: {
          code: detail.code,
          message: detail.message,
          service: err.service,
          upstream:
            err.upstreamStatus !== undefined
              ? { status: err.upstreamStatus, body: err.upstreamBody }
              : undefined,
        },
      },
      status: 402,
    };
  }
  // Same treatment as the BYO hard-fail: give the UI a machine-readable code and
  // the upstream's actionable sentence, so /chat can say WHICH key is missing
  // instead of rendering an empty model list with no explanation.
  const notConfigured = providerNotConfigured(err);
  if (notConfigured) {
    return {
      body: {
        error: {
          code: 'provider_not_configured',
          message: notConfigured,
          service: err.service,
          upstream:
            err.upstreamStatus !== undefined
              ? { status: err.upstreamStatus, body: err.upstreamBody }
              : undefined,
        },
      },
      status: 424,
    };
  }
  return {
    body: {
      error: {
        code: err.code,
        message: err.message,
        service: err.service,
        ...(err.code === 'UPSTREAM_BUSY' ? busyDetail(err) : {}),
        upstream:
          err.upstreamStatus !== undefined
            ? { status: err.upstreamStatus, body: err.upstreamBody }
            : undefined,
      },
    },
    status: httpStatusFor(err),
  };
}
