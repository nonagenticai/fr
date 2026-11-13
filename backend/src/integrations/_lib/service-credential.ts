/**
 * fr's own service credentials for upstreams that stopped trusting a bare
 * `X-Tenant-Id`.
 *
 * This is NOT the end user's Keycloak JWT. fr must never forward that to the
 * coding hop (S6/S8, and the 2026-04-26 outage class where a JWT got POSTed to
 * licence introspection). This is a licence issued to fr itself, so an upstream
 * can verify *who is asking* while the *whose data* question stays in the
 * separate plain `X-Tenant-Id` header.
 *
 * Why it became necessary: all eight `coding-*` backends now run
 * `TRUST_TENANT_HEADER=false`. A proxied call carrying only a tenant header
 * reaches them with nothing to introspect and 401s. coding-gateway honours the
 * tenant fr asserts only because `svc-fr-backend`'s subject is listed in its
 * `CODING_ONBEHALF_SUBJECTS` — the on-behalf-of vouch.
 *
 * Read from the environment per call rather than captured at import, so
 * rotating the secret needs a pod roll and not a code change. Absent is absent:
 * no header at all, never an empty or fabricated one.
 */

/** Env var holding fr's licence for the coding-* fleet (`svc-fr-backend`). */
export const CODING_SERVICE_TOKEN_ENV = 'CODING_SERVICE_TOKEN';

/**
 * Env var holding fr's licence for the kag WS-4 on-behalf-of hop.
 *
 * DELIBERATELY a different credential from `CODING_SERVICE_TOKEN`, even though
 * the same fr-backend image presents both. They authorise two unrelated trust
 * domains — coding-gateway's job control, and kag's authority to DELEGATE a
 * tenant to the metered modality-gateway (which resolves that tenant's BYO
 * provider credentials and bills it). Sharing one token would mean a rotation
 * forced by a coding incident silently breaks knowledge-graph Ask, and a leak
 * from either namespace would buy both. One credential per trust domain.
 *
 * Absent is absent: `askKag` sends no `Authorization` at all when this is unset,
 * which is exactly the pre-existing behaviour (kag then declines to delegate).
 */
export const KAG_ONBEHALF_TOKEN_ENV = 'KAG_ONBEHALF_TOKEN';

/**
 * Env var holding fr's licence for requirements_management (RM), presented as
 * `X-Tenant-Id: Bearer <token>` + `X-Effective-Tenant-Id: <customer tenant>` by
 * EVERY RM client (`integrations/{pm,requirements,requirements-management,
 * decisions,architecture,pm-catalogue}.ts`) via `tenantBearerEnvVar`.
 *
 * WHY THE BEARER SLOT. RM resolves the tenant from `X-Tenant-Id` alone
 * (kag_common/auth/__init__.py:409-414 "Pull the license token out of
 * `X-Tenant-Id: Bearer <token>` only"); it never reads `Authorization`. So a
 * licence anywhere else is inert, exactly the wrong-slot class `workers.ts`
 * documents for worker_management.
 *
 * Its OWN credential, per the one-credential-per-trust-domain rule above. There
 * is deliberately NO fallback to `CODING_SERVICE_TOKEN`: RM's subject allowlist
 * is a different authority from coding's, and a coding rotation must not be
 * able to take RM down (or the reverse).
 *
 * REQUIRED (R351 (7): every RM caller presents a token). RM lists fr's
 * subject in `AUTH_DELEGATING_SUBJECTS`, so the delegated tenant is honoured.
 * Unset/blank ⇒ every RM call is REFUSED before it is sent
 * (`HttpClientOptions.tenantBearerRequired`, `SERVICE_NOT_CONFIGURED`): there
 * is no plain-uuid `X-Tenant-Id` fallback.
 */
export const REQUIREMENTS_SERVICE_TOKEN_ENV = 'REQUIREMENTS_SERVICE_TOKEN';

/**
 * The raw token in `envVar`, or `undefined` when unset/blank.
 *
 * Trimmed because a SOPS-decrypted value picks up a trailing newline more often
 * than anyone expects, and `Bearer <token>\n` is not the same token.
 */
export function serviceCredential(envVar: string): string | undefined {
  const raw = process.env[envVar];
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Upgrade-request headers for a WebSocket hop to coding-gateway.
 *
 * The two WS proxies (quality, broadcast) build their own header bag rather than
 * going through `HttpClient`, so without this they would drift from the HTTP
 * path — and a WebSocket is exactly where that drift is invisible, since
 * `BaseHTTPMiddleware` never runs on an upgrade and nothing upstream logs
 * headers.
 *
 * Mutates and returns `headers` so callers keep their existing shape.
 */
export function attachCodingServiceCredential(
  headers: Record<string, string>,
): Record<string, string> {
  const token = serviceCredential(CODING_SERVICE_TOKEN_ENV);
  if (token && !('authorization' in headers)) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}
