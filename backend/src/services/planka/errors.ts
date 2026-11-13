export interface PlankaErrorInit {
  status: number;
  code?: string;
  body?: unknown;
  path?: string;
  cause?: unknown;
}

export class PlankaError extends Error {
  status: number;
  code?: string;
  body?: unknown;
  path?: string;
  constructor(message: string, init: PlankaErrorInit) {
    super(message);
    this.name = this.constructor.name;
    this.status = init.status;
    this.code = init.code;
    this.body = init.body;
    this.path = init.path;
    if (init.cause !== undefined) (this as unknown as { cause?: unknown }).cause = init.cause;
  }
}

/** Whose credential Planka rejected. See `PlankaAuthError.credentialSource`. */
export type PlankaCredentialSource = 'agent' | 'user';

export class PlankaAuthError extends PlankaError {
  /**
   * WHOSE credential Planka rejected — the one fact the status mapping needs
   * and the one fact the mapping site cannot recover.
   *
   *   'user'  — the default for an unstamped error. fr has no per-user Planka
   *             identity (one configured account per fr, George 2026-10-10),
   *             so fr's own transport never produces one; it is only what an
   *             unattributed throw site maps to.
   *   'agent' — fr's OWN Planka account (`PlankaAuth.agentToken()`),
   *             minted from PLANKA_AGENT_EMAIL/PASSWORD and entirely
   *             independent of the calling human's session. If that credential
   *             is wrong, expired or locked, the end user is not the cause.
   *
   * ⚠️ DEFAULTS TO 'user' DELIBERATELY, and the direction matters. 'user' is
   * what every unattributed throw site maps to TODAY, so an un-stamped error
   * keeps its current status and only a site that positively KNOWS it used the
   * agent credential is re-mapped. The opposite default would fail the other
   * way: a genuinely unauthenticated caller would stop being told to
   * re-authenticate, silently, on every path nobody remembered to stamp.
   *
   * Set it at the THROW site (`http.ts`, `auth.ts`), which is the only place
   * the credential source is known — never inferred at the mapping site.
   */
  credentialSource: PlankaCredentialSource;
  constructor(message: string, init: PlankaErrorInit & { credentialSource?: PlankaCredentialSource }) {
    super(message, init);
    this.credentialSource = init.credentialSource ?? 'user';
  }
}
export class PlankaNotFoundError extends PlankaError {}
export class PlankaConflictError extends PlankaError {}
export class PlankaForbiddenError extends PlankaError {}
export class PlankaValidationError extends PlankaError {
  fields: Array<{ attribute?: string; message?: string }>;
  constructor(message: string, init: PlankaErrorInit & { fields?: Array<{ attribute?: string; message?: string }> }) {
    super(message, init);
    this.fields = init.fields ?? [];
  }
}
export class PlankaRateLimitError extends PlankaError {}
export class PlankaServerError extends PlankaError {}
export class PlankaNetworkError extends PlankaError {
  constructor(message: string, init: Omit<PlankaErrorInit, 'status'> = {}) {
    super(message, { ...init, status: 0 });
  }
}

/**
 * A WRITE (non-GET) got a 2xx status line from Planka, and then something
 * failed — reading/parsing the body, or the abort deadline firing mid-body.
 * Planka has ANSWERED SUCCESS, so the write must be presumed APPLIED: a caller
 * that compensates (routes/cards/priority.ts) treats this as landed and
 * restores it; it must never be read as "not applied". `status` is the 2xx
 * that was received. Raised only under a `singleAttempt` request policy
 * (http.ts) — other callers keep the raw error they always got.
 */
export class PlankaWriteOutcomeUnknownError extends PlankaError {
  readonly statusReceived = true as const;
}

/**
 * Did a failed Planka WRITE possibly apply? The one place that decides
 * "landed" for a compensating caller (routes/cards/priority.ts restores every
 * field for which this is true). Only a TYPED Planka refusal with an HTTP
 * status means "not applied"; everything else is presumed applied:
 *   - PlankaWriteOutcomeUnknownError — a 2xx status line was received;
 *   - status 0 (PlankaNetworkError) — no answer, the request may have applied;
 *   - anything that is not a PlankaError — no HTTP classification at all.
 * PlankaTokenNotCachedError (503, nothing sent) is a typed refusal: false.
 */
export function plankaWriteMayHaveApplied(e: unknown): boolean {
  return e instanceof PlankaWriteOutcomeUnknownError || !(e instanceof PlankaError) || e.status === 0;
}

/**
 * A `cachedTokenOnly` request (http.ts RequestPolicy) found no cached token
 * and refused to log in: the caller holds a scarce resource (a lock) and a
 * login there would be an unbounded-by-policy wait. Nothing was sent, so
 * nothing was applied. status 503: retryable.
 */
export class PlankaTokenNotCachedError extends PlankaError {
  constructor(message: string, init: Omit<PlankaErrorInit, 'status'> = {}) {
    super(message, { ...init, status: 503 });
  }
}

interface PlankaErrorBody {
  code?: string;
  message?: string;
  problems?: Array<{ attribute?: string; message?: string }>;
}

/**
 * Stamp an error as an AGENT-credential failure.
 *
 * `mapPlankaError` classifies by HTTP status alone and structurally cannot know
 * whose credential produced the response. Call sites that DO know — the agent
 * login in `auth.ts` — wrap its result in this so the attribution is recorded
 * where it is available rather than guessed where it is not. Non-auth errors
 * pass through untouched: only `PlankaAuthError` carries the field.
 */
export function asAgentCredentialFailure<E>(err: E): E {
  if (err instanceof PlankaAuthError) err.credentialSource = 'agent';
  return err;
}

export async function mapPlankaError(response: Response, path: string): Promise<PlankaError> {
  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text().catch(() => '');
  let body: unknown = raw;
  if (contentType.includes('application/json') && raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }

  const parsed = (typeof body === 'object' && body !== null ? (body as PlankaErrorBody) : {}) ?? {};
  const code = parsed.code;
  // Planka's own error bodies are JSON with a `message` field. Anything that
  // reaches this line WITHOUT a parsed message is almost certainly an upstream
  // hop (Istio ambient ztunnel RBAC, cloudflared, nginx) returning plain text
  // — e.g. "RBAC: access denied". Surface the raw snippet in that case so
  // operators can tell a real Planka 403 from a mesh deny.
  const rawSnippet = typeof body === 'string' ? body.trim().slice(0, 200) : '';
  const baseMsg =
    parsed.message ??
    (rawSnippet.length > 0
      ? `Planka ${response.status} on ${path}: ${rawSnippet}`
      : `Planka ${response.status} on ${path}`);
  const init: PlankaErrorInit = { status: response.status, code, body, path };

  switch (response.status) {
    case 400:
      return new PlankaValidationError(baseMsg, { ...init, fields: parsed.problems ?? [] });
    case 401:
      return new PlankaAuthError(baseMsg, init);
    case 403:
      return new PlankaForbiddenError(baseMsg, init);
    case 404:
      return new PlankaNotFoundError(baseMsg, init);
    case 409:
      return new PlankaConflictError(baseMsg, init);
    case 422:
      return new PlankaValidationError(baseMsg, { ...init, fields: parsed.problems ?? [] });
    case 429:
      return new PlankaRateLimitError(baseMsg, init);
    default:
      if (response.status >= 500) return new PlankaServerError(baseMsg, init);
      return new PlankaError(baseMsg, init);
  }
}
