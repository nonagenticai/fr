/**
 * `/api/assets/kag/reviews/*` — Evidence Review 8810.
 *
 * Two upstream forms, chosen by `EVIDENCE_REVIEW_URL` (see `resolveReviewsTarget`):
 * through the kag gateway when it is unset (the production shape), or straight
 * at Evidence Review when it is set. What the gateway hop costs when skipped is
 * spelled out on `resolveReviewsTarget` — it is not free, and the tests that
 * cover the difference are named there.
 *
 * A byte-level passthrough rather than a typed handler per operation, for the
 * same reason `kag/src/routers/reviews.py` is a byte-level forwarder: Evidence
 * Review's contract depends on things a re-serializing proxy destroys.
 *
 * `handle()` + `jsonResponse()` — the pattern every other handler in
 * `routes/assets/kag.ts` uses — would break four of them:
 *
 *  - `201`/`202` become `200`, so the studio cannot tell "created" from
 *    "accepted";
 *  - `ETag` is dropped, and without it the studio cannot send
 *    `expected_revision`, which silently turns optimistic concurrency into
 *    last-write-wins;
 *  - an `application/problem+json` body is re-wrapped, so `code` —
 *    `forbidden_discriminator`, `precondition_failed` — is lost and the UI can
 *    only show a generic failure;
 *  - a 4xx is converted into an `IntegrationError`, which makes the deliberate
 *    `404` that reviewer blinding depends on (`01-…:728`) indistinguishable
 *    from an upstream outage.
 *
 * So this forwards status, an allowlist of headers, and the raw body.
 *
 * Auth is NOT bypassed: `validateAuth` runs first and the caller's bearer token
 * is forwarded, because Evidence Review derives the acting human subject from
 * it and refuses to record a decision without one. A stripped `Authorization`
 * would not merely lose attribution — every screening decision would be
 * rejected as a service principal.
 *
 * Which identity Evidence Review actually reads depends on how IT is running,
 * and that distinction is worth stating because it is not visible from here:
 *
 * * with its `ENABLE_AUTH` on — the deployed pod — it reads the VERIFIED token
 *   and ignores `X-Tenant-Id` / `X-Subject-Id` entirely. The headers below are
 *   then inert, and a caller with no verifiable token gets `401`, never
 *   `403 human_principal_required`. A non-JWT placeholder is not a weaker
 *   credential, it is an unverifiable one.
 * * with `ENABLE_AUTH=false` and a non-production `ENVIRONMENT` — a local
 *   stack — it reads those two headers instead, which is what makes the
 *   Screening write path drivable in a browser without a Keycloak reviewer.
 */

import { config } from '../../config';
import { validateAuth } from '../../middleware/auth';
import { tryCtxTenantId, tryGetRequestContext } from '../../middleware/request-context';

/**
 * Response headers forwarded verbatim.
 *
 * Kept in step with the kag gateway's own allowlist
 * (`kag/src/routers/reviews.py:50-62`) — this used to be a strict subset of it,
 * which meant fr silently narrowed what the gateway had deliberately let
 * through:
 *
 *  - `x-request-id` is the correlation handle. When a browser drive of the
 *    Screening stage goes red, this is the id that ties the failed request to
 *    the Evidence Review log line; dropping it meant the one artefact worth
 *    having never reached the browser.
 *  - `cache-control` is the upstream's own statement about the freshness of a
 *    read. Dropping it does not make a response uncacheable, it makes it
 *    UNLABELLED — the intermediary's default applies instead of the answer the
 *    service gave.
 *
 * `content-length` / `transfer-encoding` stay OUT, for the reason the gateway
 * states: they describe the hop, not the payload.
 */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'etag',
  'location',
  'retry-after',
  'idempotency-key',
  'x-request-id',
  'cache-control',
] as const;

/**
 * Request headers forwarded upstream.
 *
 * `x-research-context` is the signed research-context JWS. The kag gateway
 * forwards it (`reviews.py:69`) and the deployed Evidence Review accepts it as
 * an alternative to a verified bearer token, so omitting it here made one of the
 * two credentials the service accepts unreachable through fr — a caller holding
 * only a research context could not be authenticated at all.
 */
const FORWARDED_REQUEST_HEADERS = [
  'authorization',
  'x-research-context',
  'content-type',
  'idempotency-key',
  'if-match',
  'accept',
] as const;

/**
 * How long the upstream has to produce response HEADERS.
 *
 * A *header* budget, not a request budget — see `fetchWithHeaderBudget` for why
 * the distinction is load-bearing and what it deliberately stops bounding.
 */
const HEADER_BUDGET_MS = 30_000;

/**
 * Resolve the upstream URL for a reviews request. Pure, and exported, because
 * the two forms below differ in their PREFIX and that is the single most
 * error-prone line in this file.
 *
 * ```
 *   fr           /api/assets/kag/reviews/{rest}
 *   kag gateway  {kag}/reviews/{rest}          -> rewrites to {ers}/api/reviews/{rest}
 *   Evidence Review                               mounts at /api/reviews
 * ```
 *
 * So the direct form is NOT a base swap. Handing `{ers}` to the gateway-shaped
 * code path yields `{ers}/reviews/...`, which Evidence Review answers with a
 * flat `404` — no error, no log line naming a misconfiguration, just a studio
 * where every read comes back empty. Both prefixes are therefore built HERE,
 * from the service root, rather than being something an operator has to encode
 * correctly in an env var.
 *
 * ## What the direct form costs, stated plainly
 *
 * With `EVIDENCE_REVIEW_URL` set, the fr -> kag hop is NOT EXERCISED AT ALL.
 * Skipped with it: kag's tenant resolution (`get_tenant_id`), its `X-Tenant-Id`
 * re-stamping, its retrying transport (which exists because Istio ambient's
 * ztunnel idle-reaps pooled sockets), and its response allowlist — a superset of
 * ours. So the direct form is a LOCAL DRIVING AID, not a second production path,
 * and a green run against it says nothing about the gateway.
 *
 * kag's half of that contract is pinned by its own
 * `tests/test_reviews_proxy_fidelity.py`.
 *
 * @returns the absolute upstream URL, or `null` when neither base is configured.
 */
export function resolveReviewsTarget(
  pathname: string,
  search: string,
  bases: { evidenceReview: string; kag: string },
): string | null {
  const ers = bases.evidenceReview.replace(/\/+$/, '');
  if (ers) {
    // Everything after `/api/assets/kag/reviews` — `''` for the bare collection,
    // `/{id}/screening/queue` for a nested resource.
    const rest = pathname.replace(/^\/api\/assets\/kag\/reviews/, '');
    return `${ers}/api/reviews${rest}${search}`;
  }

  const kag = bases.kag.replace(/\/+$/, '');
  if (kag) {
    // Byte-identical to what this route emitted before `EVIDENCE_REVIEW_URL`
    // existed: everything after `/api/assets/kag` is the kag path, `/reviews/…`.
    const suffix = pathname.replace(/^\/api\/assets\/kag/, '');
    return `${kag}${suffix}${search}`;
  }

  return null;
}

/**
 * `fetch`, with a budget on the response HEADERS rather than on the whole
 * exchange.
 *
 * This was `signal: AbortSignal.timeout(30_000)`, and that one signal covered
 * the body stream too. We return `upstream.body` unread, so the budget was still
 * live while the BROWSER consumed it: an inclusion export whose read ran past
 * the deadline had its stream torn down mid-flight and surfaced as a truncated
 * body — a corrupt JSON parse in the studio, with nothing anywhere naming a
 * timeout. A size-dependent failure that looks like a product defect.
 *
 * `fetch` resolves as soon as headers arrive, so clearing the timer in `finally`
 * is precisely "stop counting once the upstream has started answering".
 *
 * WHAT THIS DELIBERATELY STOPS BOUNDING: the body read. fr now puts no deadline
 * on it; it is bounded by the connection and by the gateway's own
 * `httpx.Timeout(30.0)` (`reviews.py:88`). Reinstating an fr-side body budget
 * needs the stream wrapped in a `TransformStream` that can fail it with a
 * NAMEABLE error instead of a silent truncation — deliberately out of scope
 * here, and called out rather than left implicit.
 *
 * The abort reason is a `TimeoutError`, which is what lets the caller answer
 * `504` instead of folding a slow upstream in with a refused connection.
 */
export async function fetchWithHeaderBudget(
  target: string,
  init: RequestInit,
  budgetMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          'the reviews upstream did not send response headers in time',
          'TimeoutError',
        ),
      ),
    budgetMs,
  );
  try {
    return await fetch(target, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function problem(status: number, code: string, detail: string): Response {
  return new Response(
    JSON.stringify({ type: 'about:blank', title: code, status, detail, code }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

export async function handleKagReviewsProxy(req: Request): Promise<Response> {
  const user = await validateAuth(req);

  const url = new URL(req.url);
  const target = resolveReviewsTarget(url.pathname, url.search, {
    evidenceReview: config.services.evidenceReview.baseUrl,
    kag: config.services.kag.baseUrl,
  });
  if (!target) {
    return problem(
      503,
      'upstream_not_configured',
      'neither EVIDENCE_REVIEW_URL nor a kag base URL is configured',
    );
  }

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  // The tenant comes from the validated request context, never from the client
  // body or query. `tryCtxTenantId` rather than `ctxTenantId`: the hard variant
  // THROWS when there is no request frame, which would turn a missing frame
  // into an unhandled 500 on a route that can still be served — kag resolves
  // the tenant itself from the forwarded credential, and refuses the request
  // with a 401 when it cannot. Passing the header is an optimisation, not the
  // authorization decision.
  //
  // The `?? user.tenantId` fallback is load-bearing, and is the same one
  // `routes/documents.ts` already documents: `buildRequestContext` populates
  // `tenantId` ONLY from a cryptographically verified bearer JWT and knows
  // nothing about `AUTH_BYPASS`, so under bypass the frame carries no tenant
  // while `validateAuth` still returns a synthetic user that has one. Without
  // it this proxy forwarded NO identity at all under bypass — neither header —
  // and every call reached Evidence Review as an anonymous caller, which it
  // refuses. That is why the whole Screening stage was undrivable in any local
  // or demo stack, while looking like an Evidence Review auth problem.
  //
  // In production nothing changes: the frame is populated there and wins.
  const tenantId = tryCtxTenantId() ?? user.tenantId;

  // Refuse when fr and Evidence Review would be in different workspaces.
  //
  // fr lets a `super_admin` switch the active tenant with `X-Active-Tenant`;
  // when that is accepted the frame's tenant becomes the header's and
  // `activeTenantSource` flips to `'header'`. Evidence Review with
  // `ENABLE_AUTH` on — how the deployed pod runs — resolves the actor from the
  // VERIFIED token and never reads `X-Tenant-Id`: `get_actor`
  // (`src/api/dependencies.py`) consults that header only on the
  // `not settings.enable_auth` branch, which is itself refused in a production
  // environment. So the forwarded tenant is inert and the two systems land in
  // different places — the studio renders the switched workspace while every
  // read and write executes in the token's.
  //
  // Refusing rather than logging, because the writes behind this proxy are
  // decisions, corpus seals and sealed exports; `inclusion_exports` is
  // append-only by DB trigger, so a log read tomorrow is a record of the
  // mistake, not a way back from it. The cost of the refusal is one workspace
  // switch.
  //
  // Compared on VALUES, never on the flag alone: `X-Active-Tenant` equal to the
  // JWT's own claim is accepted and flagged `'header'` while being no
  // divergence at all, and the `aa-orchestrator` override sets the same flag.
  // And with no `jwtTenantId` there is nothing to disagree with — that is the
  // `AUTH_BYPASS` path, where refusing would make the whole Screening stage
  // undrivable locally, which is exactly what the `?? user.tenantId` fallback
  // above exists to prevent.
  const jwtTenantId = tryGetRequestContext()?.jwtTenantId;
  if (jwtTenantId && tenantId && tenantId !== jwtTenantId) {
    return problem(
      409,
      'tenant_context_conflict',
      `this request would act in tenant ${jwtTenantId} (from the verified token) while fr is ` +
        `showing tenant ${tenantId} (from X-Active-Tenant). Evidence Review derives the tenant ` +
        `from the token and ignores the forwarded header, so the decision would be recorded in a ` +
        `workspace you are not looking at. Switch back to ${jwtTenantId} and retry.`,
    );
  }

  if (tenantId) headers.set('X-Tenant-Id', tenantId);

  // The acting END USER, on fr's established `X-Subject-Id` forwarding
  // contract — the same one inference-router and per-user metering use.
  // `buildRequestContext` resolves it from the VERIFIED JWT `sub` and only
  // falls back to an inbound header when there is no verified claim, so this
  // cannot be used to impersonate.
  //
  // Evidence Review ignores this header entirely whenever `ENABLE_AUTH` is on:
  // there it derives the subject from the JWT it verifies itself. So this
  // changes nothing in production and is not an authorization input. What it
  // does is let a local AUTH_BYPASS stack — where there is no real token to
  // verify — carry an attributable subject, so the screening write path can be
  // driven end to end in a browser instead of stopping at
  // `human_principal_required`.
  const subjectId = tryGetRequestContext()?.subjectId ?? user.id;
  if (subjectId) headers.set('X-Subject-Id', subjectId);

  // No `HEAD` arm. It used to be branched on here and was unreachable from both
  // directions: `server.ts` registers this handler for GET/POST/PATCH/PUT/DELETE
  // only, and the kag gateway registers the same five
  // (`kag/src/routers/reviews.py:165`) — so a HEAD wired up on this side alone
  // would have bought a 405 from the next hop. Pinned by
  // `tests/unit/kag-reviews-methods.test.ts`, which fails if the two lists drift.
  const body = req.method === 'GET' ? undefined : await req.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetchWithHeaderBudget(
      target,
      {
        method: req.method,
        headers,
        body: body && body.byteLength > 0 ? body : undefined,
      },
      HEADER_BUDGET_MS,
    );
  } catch (e) {
    // A timeout is not unreachability, and reporting it as one cost real
    // debugging time: the full/dual browser drives count every >=400 on the
    // reviews surface, so a slow import read as a product defect rather than as
    // a budget. They are different facts with different fixes — an unreachable
    // upstream is down, a timed-out one is answering too slowly — so they get
    // different statuses and different codes.
    if (e instanceof Error && e.name === 'TimeoutError') {
      return problem(
        504,
        'upstream_timeout',
        `the reviews upstream did not send response headers within ${HEADER_BUDGET_MS}ms`,
      );
    }
    return problem(502, 'upstream_unreachable', 'the kag gateway did not respond');
  }

  // No status branching. A 4xx from Evidence Review is an answer, not a fault.
  const out = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
