// Shared helpers for /api/assets/* pages.
//
// The backend always returns `{ data: ... }` on success and
// `{ error: { code, message, upstream? } }` on failure. Pages call
// `assetFetch` which unwraps `data` on success and throws an `AssetError`
// with the upstream `message` on failure (so the page can display it
// verbatim without leaking raw JSON).

import { authFetch } from './auth-fetch';
import {
  KAG_LICENSE_REQUIRED_CODE,
  KAG_LICENSE_REQUIRED_MESSAGE,
} from './kag-license';

export class AssetError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /**
   * True for a 403 `kag_license_required` — the tenant lacks the KAG add-on.
   * KAG tabs already render `err.message` inline; this flag lets a tab render a
   * dedicated "needs a KAG license" affordance if it wants. It is deliberately
   * NOT wired to the global fr licenseGate. See $lib/api/kag-license.ts.
   */
  readonly kagLicenseRequired: boolean;
  /**
   * The upstream service's own error body, verbatim, when the backend forwarded
   * one — `undefined` otherwise.
   *
   * ## Why this exists
   *
   * A refusal is only actionable if every hop preserves what it says. Some
   * upstreams answer a refusal with facts a caller is meant to ACT on, not just
   * read. discovery-engine's session-create 409 is the case that forced this:
   * it refuses to discover into a session that already holds a corpus, tells
   * the caller "GET it if you meant to continue that corpus", and (since DE #66)
   * carries `session_id`, `paper_count` and `query_count` as
   * `error.context` for exactly that purpose.
   *
   * The backend already forwarded it — `integrationErrorResponse` emits
   * `error.upstream = { status, body }` — and `Envelope` below has DECLARED
   * `upstream?: unknown` since this file was written. This class was the hop
   * that dropped it: it read `rawErr.upstream` nowhere and constructed from
   * `(message, status, code)` alone. So no caller could act on ANY upstream's
   * structured refusal, and the instruction in the prose was unfollowable.
   *
   * Deliberately typed `unknown`: this is another service's body, not ours. A
   * caller that wants a field must narrow it and cope with its absence, which
   * is the honest contract for a value that crossed a service boundary.
   */
  readonly upstreamBody: unknown;
  /**
   * WHICH upstream service refused, verbatim from `error.service`.
   *
   * `integrationErrorResponse` (backend `integrations/_lib/errors.ts:222-278`)
   * has always emitted this on every failure envelope, including the two
   * special-cased ones — but neither `Envelope` nor this class read it, so a
   * caller could say a call failed and never say what failed. That matters most
   * for the slow LLM-backed routes, where "requirements_management timed out"
   * and "fr is broken" look identical to a user otherwise.
   *
   * `undefined` for the license gate's bare `{ error: '<code>' }` shape, which
   * genuinely carries no service.
   */
  readonly service: string | undefined;
  constructor(
    message: string,
    status: number,
    code?: string,
    upstreamBody?: unknown,
    service?: string,
  ) {
    super(message);
    this.name = 'AssetError';
    this.status = status;
    this.code = code;
    this.kagLicenseRequired = code === KAG_LICENSE_REQUIRED_CODE;
    this.upstreamBody = upstreamBody;
    this.service = service;
  }
}

interface Envelope<T> {
  // The asset routes wrap failures as `{ error: { code, message } }`. The
  // package-license gate (which runs BEFORE the route handler) instead emits a
  // bare `{ error: '<code>' }` string — both shapes are handled below.
  data?: T;
  error?:
    | string
    | {
        code?: string;
        message?: string;
        // The upstream service that refused — see `AssetError.service`.
        service?: string;
        // `{ status, body }`, where `body` is the upstream service's own error
        // body verbatim — see `AssetError.upstreamBody`.
        upstream?: { status?: number; body?: unknown };
      };
}

/** A list page plus the truth about whether it is the whole set. */
export interface AssetPage<T> {
  items: T;
  /** The route told us at least one upstream frame came back full. */
  truncated: boolean;
  /** Rows requested per upstream frame, or null on a route that does not say. */
  appliedLimit: number | null;
  /**
   * Did `?project_id=` resolve to a real project?
   *
   * `false` is the state that matters: the route applied a project filter to a
   * project that DOES NOT EXIST, so `items` is `[]` for a reason that is not
   * "this project holds none". Rendering those two the same way is the defect
   * `_lib/effective-query.ts` returns `[]` to avoid, and it is only avoided if
   * a caller actually reads this.
   *
   * `null` means the route asserted nothing — no `?project_id=` was sent, or
   * the route does not emit the header at all. Silence must never be read as
   * `true`: that would be a claim of resolution nobody made.
   */
  projectResolved: boolean | null;
}

/**
 * Shared core. Returns the parsed value AND the `Response`, because the
 * page-cap signal (`X-Truncated` / `X-Applied-Limit`) lives in headers — the
 * asset routes keep the `{ data }` envelope, so the signal could not go in
 * the body without changing their shape.
 */
async function assetFetchInner<T>(
  input: string,
  init: RequestInit = {},
): Promise<{ value: T; res: Response }> {
  const res = await authFetch(input, init);

  // 204 No Content — nothing to parse.
  if (res.status === 204) {
    return { value: undefined as T, res };
  }

  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    // Non-JSON body — fall through to generic error handling.
  }

  if (!res.ok) {
    // Normalise both error shapes: the route envelope `{ error: { code, message } }`
    // and the license gate's bare `{ error: '<code>' }` string.
    const rawErr = body?.error;
    const code = typeof rawErr === 'string' ? rawErr : rawErr?.code;
    const errMessage = typeof rawErr === 'string' ? undefined : rawErr?.message;
    // The license gate's shape is a bare string, so guard the object read: an
    // upstream body is genuinely absent there, not empty.
    const upstreamBody =
      typeof rawErr === 'string' ? undefined : rawErr?.upstream?.body;
    // Same guard as above: the license gate's bare-string shape has no service.
    const service = typeof rawErr === 'string' ? undefined : rawErr?.service;
    // A KAG add-on gap gets an honest, KAG-scoped message (the tabs render it
    // inline); it never touches the global fr licenseGate. See ./kag-license.ts.
    const msg =
      code === KAG_LICENSE_REQUIRED_CODE
        ? KAG_LICENSE_REQUIRED_MESSAGE
        : (errMessage ?? `${res.status} ${res.statusText}`);
    throw new AssetError(msg, res.status, code, upstreamBody, service);
  }

  if (body && 'data' in body) {
    return { value: body.data as T, res };
  }
  // Older routes may not wrap — pass through.
  return { value: body as T, res };
}

export async function assetFetch<T>(
  input: string,
  init: RequestInit = {},
): Promise<T> {
  return (await assetFetchInner<T>(input, init)).value;
}

/**
 * Like {@link assetFetch}, but also reports whether the page was capped.
 *
 * ⚠️ A header is invisible to JS unless the server lists it in
 * `Access-Control-Expose-Headers` — `pageCapHeaders()` does. Absent headers
 * degrade to `truncated: false`, which is the honest reading for a route that
 * has not been taught to say.
 */
export async function assetFetchPage<T>(
  input: string,
  init: RequestInit = {},
): Promise<AssetPage<T>> {
  const { value, res } = await assetFetchInner<T>(input, init);
  const rawLimit = res.headers.get('X-Applied-Limit');
  const parsedLimit = rawLimit === null ? NaN : Number(rawLimit);
  // ⚠️ THREE states, deliberately not two. `raw === 'true'` alone would fold an
  // absent header into `false` and make every unscoped list claim a failed
  // resolution; `raw !== 'false'` would fold it into `true` and claim a
  // resolution nobody performed. Only the two literals the backend actually
  // emits (`projectScopeHeaders`) say anything; anything else is `null`.
  const rawResolved = res.headers.get('X-Project-Resolved');
  const projectResolved =
    rawResolved === 'false' ? false : rawResolved === 'true' ? true : null;
  return {
    items: value,
    truncated: res.headers.get('X-Truncated') === 'true',
    appliedLimit: Number.isFinite(parsedLimit) ? parsedLimit : null,
    projectResolved,
  };
}

/** A render-ready reading of a failed asset fetch. */
export interface AssetErrorCause {
  /** One short line naming WHO failed. Safe for end users. */
  headline: string;
  /** The upstream's own sentence, when it said something useful. */
  detail?: string;
  /** Whether a plain retry could plausibly succeed. */
  retryable: boolean;
  /**
   * True when the failure is a misconfiguration on OUR side rather than
   * anything the viewer did or can fix. Callers use this to avoid telling a
   * user to re-authenticate when their session is perfectly fine.
   */
  operatorFault: boolean;
}

/**
 * Turn an `AssetError` into something a picker can render honestly.
 *
 * ## Why this exists — the misreading it is built to prevent
 *
 * `UPSTREAM_UNAUTHORIZED` means *fr's* credential to the upstream was refused.
 * It does NOT mean the viewer's session expired, and saying so sends the user
 * to re-login for a fault they cannot touch. `$lib/bridge/errors.ts` renders
 * this code as "Your session is no longer authorized" — correct for a bridge
 * mutation the user drove, wrong here, which is why this is a second mapping
 * and not a reuse of that one.
 *
 * The case that forced it: kag set `ALLOW_UNVOUCHED_TENANT_HEADER=false` on
 * 2026-09-16 and fr stopped vouching on `GET /api/documents`. kag answered 401,
 * the backend mapped it to a 502 (deliberately — see `httpStatusFor`, a 401 to
 * the browser makes healthy sessions look broken), and the picker rendered the
 * bare string. The screen said "502 Bad Gateway", which reads as "KAG is down",
 * and the actual cause — fr is not authorised to KAG — was sitting unread in
 * `error.code` the whole time.
 */
export function assetErrorCause(err: unknown): AssetErrorCause {
  if (!(err instanceof AssetError)) {
    return {
      headline: err instanceof Error ? err.message : String(err),
      retryable: true,
      operatorFault: false,
    };
  }

  const where = err.service ?? 'the upstream service';
  const upstreamDetail = upstreamSentence(err.upstreamBody);

  switch (err.code) {
    case 'UPSTREAM_UNAUTHORIZED':
    case 'SERVICE_AUTH_FAILED':
      return {
        headline: `fr is not authorised to ${where}. Your session is fine — this needs an operator.`,
        detail: upstreamDetail,
        retryable: false,
        operatorFault: true,
      };
    case 'UPSTREAM_UNREACHABLE':
      return {
        headline: `${where} is unreachable.`,
        detail: upstreamDetail,
        retryable: true,
        operatorFault: true,
      };
    case 'UPSTREAM_TIMEOUT':
      return {
        headline: `${where} timed out.`,
        detail: upstreamDetail,
        retryable: true,
        operatorFault: true,
      };
    case 'UPSTREAM_FORBIDDEN':
      return {
        headline: `${where} refused this request for this tenant.`,
        detail: upstreamDetail,
        retryable: false,
        operatorFault: false,
      };
    default:
      return {
        headline: err.message,
        detail: upstreamDetail,
        // 5xx may be transient; a 4xx will answer the same way next time.
        retryable: err.status >= 500,
        operatorFault: err.status >= 500,
      };
  }
}

/** Pull a human sentence out of an upstream body without inventing one. */
function upstreamSentence(body: unknown): string | undefined {
  if (typeof body === 'string') return body.trim() || undefined;
  if (typeof body !== 'object' || body === null) return undefined;
  const rec = body as Record<string, unknown>;
  for (const key of ['detail', 'message', 'error'] as const) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}
