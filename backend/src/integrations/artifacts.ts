/**
 * artifact_service adapter — read-only browseable surface.
 *
 * Spec: docs/superpowers/specs/completed/2026-04-24-artifacts-browser.md §8.1.
 *
 * Wraps `@fr/service-client-artifacts` behind the shared `createHttpClient`
 * so bearer + correlation-id propagate via AsyncLocalStorage. Every upstream
 * route is project-scoped; `project_id` is required for every adapter call.
 *
 * The token-mint / token-resolve helpers are re-exported from
 * `services/download-tokens.ts` so route handlers have a single import target
 * for "everything artifacts."
 */
import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { IntegrationError } from './_lib/errors';
import { CODING_SERVICE_TOKEN_ENV } from './_lib/service-credential';
import {
  getArtifactsGetCrossProjectUrl,
  getArtifactsListCrossProjectUrl,
  getDownloadArtifactUrl,
  getGetArtifactUrl,
  getGetManifestUrl,
  getListArtifactReviewsUrl,
  getListArtifactsUrl,
  getSubmitArtifactReviewUrl,
  type ArtifactOut,
  type ArtifactsListCrossProjectParams,
  type GetManifestParams,
  type ListArtifactsParams,
  type Manifest,
  type ManifestScope,
  type ReviewDecision,
  type ReviewIn,
  type ReviewOut,
  type ReviewResponse,
} from '@fr/service-client-artifacts';

/**
 * `ArtifactOut` plus `publish_status`, which artifact_service serves on every row
 * (`src/models/schemas.py` ArtifactOut, CHECK draft|published) but which the
 * generated `@fr/service-client-artifacts` model predates. Optional so an older
 * service reads as "unknown", never as "draft".
 */
export type {
  ArtifactOut,
  ArtifactsListCrossProjectParams,
  ListArtifactsParams,
  Manifest,
  ManifestScope,
  ReviewDecision,
  ReviewIn,
  ReviewOut,
  ReviewResponse,
};
export {
  mintDownloadToken,
  resolveDownloadToken,
  DownloadTokenError,
  DownloadTokenInvalidError,
  DownloadTokenExpiredError,
  DownloadTokenConsumedError,
  type DownloadTokenPayload,
} from '../services/download-tokens';

const CRUD_TIMEOUT_MS = 30_000;
// Streaming budget — large artifacts (Office docs, datasets) can take longer
// than the CRUD path. Cap at 5 min; the upstream itself will close the stream
// if it can't make progress.
const STREAM_TIMEOUT_MS = 5 * 60_000;
const STREAM_CHUNK_BYTES = 64 * 1024;

let cachedClient: HttpClient | undefined;

function http(): HttpClient {
  if (!cachedClient) {
    cachedClient = createHttpClient({
      serviceName: 'artifacts',
      baseUrl: config.services.artifacts.baseUrl,
      defaultTimeoutMs: CRUD_TIMEOUT_MS,
      // artifact_service reads `X-Tenant-Id` only (src/auth/middleware.py).
      // ⚠️ A MISSING header IS a silent fallback to DEFAULT_TENANT_ID — the
      // earlier wording here ("never a silent fallback") was wrong, and it is
      // what let `streamArtifact` ship without the header for so long. Only a
      // MALFORMED header is loud (400, via `canonical_tenant_id`). Absent is
      // quiet and lands you in the default tenant, which is why every raw
      // `fetch` on this service has to set the header for itself.
      // (Since artifact_service#52 an absent header is a 401 TENANT_REQUIRED
      // under its default AUTH_TENANT_FALLBACK_MODE=enforce; `requireTenant`
      // below refuses it here first.)
      //
      // NO end-user JWT: since artifact_service#56 `Authorization` is a SECOND
      // licence carrier, and a Keycloak JWT there is a hard 401 once
      // AUTH_TENANT_PROOF_MODE=enforce. artifact_service has no other reader
      // of it.
      sendAuthorization: false,
      // fr's OWN licence, delegated — the same scheme as `workers.ts`:
      // `X-Tenant-Id: Bearer <svc-fr-backend licence>` +
      // `X-Effective-Tenant-Id: <customer tenant>` (+ the `X-Subject-Id` that
      // `buildHeaders` always forwards; artifact_service#56 `_admit_delegated`
      // takes the row-owning subject from it). Without this every read here is
      // a credential-less bare-uuid `X-Tenant-Id` claim from a trusted peer
      // (`explicit_header_unproven`), refused outright under
      // AUTH_TENANT_PROOF_MODE=enforce.
      //
      // ⛔ ORDERING — NO GATE. `CODING_SERVICE_TOKEN` is ALREADY set on the live
      // fr deployment (worker_management uses it), so this is live the moment
      // fr deploys. The receiver must be ready FIRST:
      //   * artifact_service WITHOUT #56: the Bearer is introspected, the
      //     effective-tenant header is ignored and the read is scoped to fr's
      //     SERVICE tenant — a silent wrong-tenant 200.
      //   * #56 but subject `019ffe9f-31fd-70da-b3c5-f921f7290b01`
      //     (`svc-fr-backend`) NOT in `AUTH_DELEGATING_SUBJECTS`: 403
      //     EFFECTIVE_TENANT_FORBIDDEN on every artifact call.
      // So: #56 deployed AND the subject listed, then this ships.
      //
      // Absent secret / no tenant ⇒ the pair is not attached and the request is
      // the plain-uuid one it was before (see `tenantBearerEnvVar`).
      tenantBearerEnvVar: CODING_SERVICE_TOKEN_ENV,
      // Never call artifact_service without a tenant (WM#324 / fr row 15
      // pattern, as in workers.ts): no frame tenant and no explicit one ⇒
      // MISSING_TENANT before anything is sent. fr never substitutes its own or
      // the system tenant.
      requireTenant: true,
    });
  }
  return cachedClient;
}

/**
 * An explicit tenant + acting user for a call made OUTSIDE the request that owns them (a
 * post-decision hook, a backfill script). Both WIN over the ambient frame in `buildHeaders`:
 * `x-tenant-id` names the delegated tenant, `x-subject-id` is what artifact_service records
 * as `reviewer_id` (`routes/artifacts.py` submit_review: `reviewer_id=subject_id or tenant_id`).
 */
interface ArtifactCallIdentity {
  tenantId: string;
  subjectId?: string;
}

function identityHeaders(as?: ArtifactCallIdentity): { headers?: Record<string, string> } {
  const tenantId = as?.tenantId?.trim();
  if (!tenantId) return {};
  const headers: Record<string, string> = { 'x-tenant-id': tenantId };
  const subjectId = as?.subjectId?.trim();
  if (subjectId) headers['x-subject-id'] = subjectId;
  return { headers };
}

/**
 * List artifacts for a project. `project_id` is required (the upstream URL is
 * project-scoped); `filters` covers the rest of the upstream query surface.
 */
export async function listArtifacts(
  projectId: string,
  filters?: ListArtifactsParams,
  as?: ArtifactCallIdentity,
): Promise<ArtifactOut[]> {
  if (!projectId) {
    throw new IntegrationError({
      // Callers guard first (routes/assets/artifacts.ts) or pass project.id
      // from a DB row. Unreachable from HTTP.
      code: 'INTERNAL_PRECONDITION',
      message: 'project_id is required for listArtifacts',
    });
  }
  return await http().json<ArtifactOut[]>(getListArtifactsUrl(projectId, filters), {
    method: 'GET',
    ...identityHeaders(as),
  });
}

/**
 * List artifacts across ALL projects in the caller's tenant. Tenant scoping is
 * enforced upstream by the artifact_service via `visibility_scope`. Hits
 * `/api/artifacts` (the cross_project_router endpoint) so the Library workspace
 * tab can list a tenant's artifacts without a project_id. Filter surface mirrors
 * the per-project list endpoint.
 */
export async function listArtifactsCrossProject(
  filters?: ArtifactsListCrossProjectParams,
): Promise<ArtifactOut[]> {
  return await http().json<ArtifactOut[]>(getArtifactsListCrossProjectUrl(filters), {
    method: 'GET',
  });
}

/**
 * Flagged-artifact record consumed by the analysis-to-kanban-bridge slice
 * (ArtifactsOutputSource arrow). The "flagged listing" upstream endpoint is
 * scheduled for slice 3 of the artifacts-browser spec and is not yet wired
 * into `@fr/service-client-artifacts`. Per the bridge spec this slice is
 * "empty-list-safe": we return [] and log a single warning so the bridge can
 * stay deployed without a 502 cascade.
 */
export interface FlaggedArtifact {
  artifact_id: string;
  version: string;
  project_id: string;
  flag_reason?: string;
  flagged_at?: string;
}

let warnedFlaggedStub = false;
export async function listFlaggedArtifacts(
  _ctx: unknown,
  projectId: string,
): Promise<FlaggedArtifact[]> {
  if (!projectId) {
    throw new IntegrationError({
      // Sole caller domain/bridge/sources/artifacts.ts guards before calling.
      code: 'INTERNAL_PRECONDITION',
      message: 'project_id is required for listFlaggedArtifacts',
    });
  }
  if (!warnedFlaggedStub) {
    warnedFlaggedStub = true;
    console.warn(
      '[artifacts.listFlaggedArtifacts] slice 3 endpoint not yet wired in @fr/service-client-artifacts; returning [] (empty-list-safe per analysis-to-kanban-bridge spec)',
    );
  }
  return [];
}

export async function getArtifact(
  projectId: string,
  artifactId: string,
  /**
   * Explicit tenant, which WINS over the ambient one (a per-call `x-tenant-id`
   * beats the request frame in `buildHeaders`) — for a caller that has resolved
   * the project's tenant itself (D13 `assertArtifactRefInProject`). Blank falls
   * through to the ambient tenant. Omit it everywhere the frame is the project's.
   */
  explicitTenantId?: string,
): Promise<ArtifactOut> {
  const tenantId = explicitTenantId?.trim();
  return await http().json<ArtifactOut>(getGetArtifactUrl(projectId, artifactId), {
    method: 'GET',
    ...(tenantId ? { headers: { 'x-tenant-id': tenantId } } : {}),
  });
}

/**
 * Read one artifact by id without knowing its project — the cross-project
 * `/api/artifacts/{artifact_id}` endpoint. Upstream scopes it by tenant AND
 * visibility and answers 404 for both "does not exist" and "not visible to
 * you", so a caller cannot tell the two apart (by design). Used by the
 * `?bound_to=` list mode, where the bound ids come from fr's `asset_bindings`
 * and carry no project of their own.
 */
export async function getArtifactById(artifactId: string): Promise<ArtifactOut> {
  return await http().json<ArtifactOut>(getArtifactsGetCrossProjectUrl(artifactId), {
    method: 'GET',
  });
}

export async function getManifest(
  projectId: string,
  scope: ManifestScope,
  scopeRef?: string,
): Promise<Manifest> {
  const params: GetManifestParams | undefined =
    scopeRef !== undefined ? { scope_ref: scopeRef } : undefined;
  return await http().json<Manifest>(getGetManifestUrl(projectId, scope, params), {
    method: 'GET',
  });
}

export async function submitArtifactReview(
  projectId: string,
  artifactId: string,
  body: ReviewIn,
  as?: ArtifactCallIdentity,
): Promise<ReviewResponse> {
  return await http().json<ReviewResponse>(getSubmitArtifactReviewUrl(projectId, artifactId), {
    method: 'POST',
    body: JSON.stringify(body),
    ...identityHeaders(as),
  });
}

export async function listArtifactReviews(
  projectId: string,
  artifactId: string,
): Promise<ReviewOut[]> {
  return await http().json<ReviewOut[]>(getListArtifactReviewsUrl(projectId, artifactId), {
    method: 'GET',
  });
}

export type RenderFormat = 'html' | 'pdf';

/** One rendered document as artifact_service answered it (DOC-1 `GET …/{id}/render`). */
export interface RenderedDocument {
  contentType: string;
  body: Uint8Array;
  /** artifact_service's `X-Render-Cache` (`hit` | `miss`); null when absent. */
  renderCache: string | null;
  /** artifact_service's `Content-Disposition` (`inline` for html, `attachment` for pdf). */
  disposition: string | null;
}

/** Largest render fr relays (a rendered document; artifact_service caps its source size too). */
const RENDER_MAX_BYTES = 20 * 1024 * 1024;

/**
 * DOC-1 render: `GET /projects/{p}/artifacts/{id}/render?format=html|pdf`. The upstream route is
 * project-scoped (an artifact of another project, or not visible to the tenant, is its 404) and
 * sanitises the HTML itself; fr relays the bytes unchanged. Non-2xx → IntegrationError with the
 * upstream status (404 / 413 / 415 relayed).
 */
export async function renderArtifact(projectId: string, artifactId: string, format: RenderFormat): Promise<RenderedDocument> {
  const path = `/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/render?format=${format}`;
  const res = await http().fetch(path, {
    method: 'GET',
    headers: { accept: format === 'pdf' ? 'application/pdf' : 'text/html' },
    timeoutMs: STREAM_TIMEOUT_MS,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new IntegrationError({
      code: codeForStatus(res.status),
      message: `artifacts GET ${path} returned ${res.status}`,
      service: 'artifacts',
      path,
      method: 'GET',
      upstreamStatus: res.status,
      upstreamBody: errBody.slice(0, 500),
    });
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > RENDER_MAX_BYTES) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message: `artifacts render of ${artifactId} exceeds ${RENDER_MAX_BYTES} bytes`,
      service: 'artifacts',
      path,
      method: 'GET',
    });
  }
  return {
    contentType: res.headers.get('content-type') ?? (format === 'pdf' ? 'application/pdf' : 'text/html; charset=utf-8'),
    body: buf,
    renderCache: res.headers.get('x-render-cache'),
    disposition: res.headers.get('content-disposition'),
  };
}

interface StreamSink {
  /** Called with the upstream content-type (or undefined) before the first chunk. */
  onHeaders: (info: { contentType: string | undefined; contentLength: number | undefined; status: number }) => void;
  /** Called once per 64 KiB chunk in delivery order. */
  onChunk: (chunk: Uint8Array) => Promise<void> | void;
  /** Called once at end-of-stream; never called if `onChunk` throws. */
  onEnd: () => Promise<void> | void;
}

/**
 * Stream an artifact's bytes through fr-backend to the caller. Headers (the
 * delegated tenant pair, subject, correlation id) come from the shared
 * `HttpClient` and the AsyncLocalStorage context; the caller's sink controls how chunks are written out (e.g. into a `ReadableStream`
 * controller for the route's `Response.body`).
 *
 * 64 KiB chunking matches the spec's "chunked passthrough" requirement and
 * avoids buffering full artifact bodies in memory.
 */
export async function streamArtifact(
  projectId: string,
  artifactId: string,
  sink: StreamSink,
  /**
   * Explicit tenant, which WINS over the ambient one — mirroring
   * `buildHeaders`, where a per-call `x-tenant-id` beats the request frame.
   *
   * The download-token route has no ambient tenant at all (it authenticates by
   * signed token, not by a bearer), so it passes the tenant captured at mint
   * time. Omit it everywhere an ambient tenant exists.
   */
  explicitTenantId?: string,
): Promise<void> {
  const path = getDownloadArtifactUrl(projectId, artifactId);

  // ⛔ THE TENANT RIDES HERE OR THE READ CHANGES SCOPE. This used to be a raw
  // `fetch` that stamped its own headers — `Authorization: Bearer <user JWT>`
  // plus a bare-uuid `X-Tenant-Id` — and drifted from the CRUD client twice
  // (first by omitting the tenant, which moved every download into the default
  // tenant, then by never adopting the delegated licence). It now goes through
  // the SAME `HttpClient` as every other call here, so `buildHeaders` decides
  // the tenant pair, `X-Subject-Id` and the correlation id in one place.
  //
  // The user JWT is deliberately GONE. artifact_service reads no user token:
  // since #56 `Authorization: Bearer` is only a SECOND licence carrier, read
  // when `X-Tenant-Id` carries none. A Keycloak JWT there introspects
  // `token_not_found` and is a hard 401 under AUTH_TENANT_PROOF_MODE=enforce
  // (observe merely pays a license-authz round trip to ignore it). With the
  // delegated pair attached it would never even be read.
  //
  // Explicit tenant first (the download-token route has no ambient frame and
  // passes the tenant captured at mint time), else the ambient frame — the same
  // precedence `buildHeaders` applies to a per-call `x-tenant-id`. Blank is
  // absent, so a blank explicit tenant falls through to the frame; no tenant at
  // all is MISSING_TENANT (`requireTenant`) and nothing is sent.
  const explicitTenant = explicitTenantId?.trim();
  const headers: Record<string, string> = { accept: '*/*' };
  if (explicitTenant) headers['x-tenant-id'] = explicitTenant;

  // Our own controller, passed as `signal`: the client's timer is cleared once
  // response headers arrive, but a download must stay bounded for its whole
  // body, so this one is cleared only when the stream finishes.
  const ac = new AbortController();
  const timeoutHandle = setTimeout(() => ac.abort(new Error('timeout')), STREAM_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await http().fetch(path, {
      method: 'GET',
      headers,
      signal: ac.signal,
      timeoutMs: STREAM_TIMEOUT_MS,
      // One attempt, as before: a stream is not re-requested behind the
      // caller's back.
      noRetry: true,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    throw err;
  }

  if (!upstream.ok) {
    clearTimeout(timeoutHandle);
    // Drain a small slice of the body so the upstream connection releases.
    const errBody = await upstream.text().catch(() => '');
    throw new IntegrationError({
      code: codeForStatus(upstream.status),
      message: `artifacts GET ${path} returned ${upstream.status}`,
      service: 'artifacts',
      path,
      method: 'GET',
      upstreamStatus: upstream.status,
      upstreamBody: errBody.slice(0, 500),
    });
  }

  sink.onHeaders({
    contentType: upstream.headers.get('content-type') ?? undefined,
    contentLength: parseContentLength(upstream.headers.get('content-length')),
    status: upstream.status,
  });

  if (!upstream.body) {
    clearTimeout(timeoutHandle);
    await sink.onEnd();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      // Re-chunk to STREAM_CHUNK_BYTES so the wire never sees a giant frame
      // even when the upstream hands us 1 MiB at a time.
      buffer = concat(buffer, value);
      while (buffer.length >= STREAM_CHUNK_BYTES) {
        const slice = buffer.subarray(0, STREAM_CHUNK_BYTES);
        await sink.onChunk(slice);
        buffer = buffer.subarray(STREAM_CHUNK_BYTES);
      }
    }
    if (buffer.length > 0) {
      await sink.onChunk(buffer);
    }
    await sink.onEnd();
  } finally {
    clearTimeout(timeoutHandle);
    try {
      reader.releaseLock();
    } catch {
      /* reader may already be closed */
    }
  }
}

/**
 * Fetch up to `maxBytes` of an artifact's body for inline preview. Returns the
 * raw bytes plus the upstream content-type and a `truncated` flag. Callers are
 * responsible for the MIME whitelist (the route handler enforces it before
 * calling this); we don't enforce it here so adapter unit tests can probe
 * arbitrary MIMEs.
 */
export async function fetchPreviewBytes(
  projectId: string,
  artifactId: string,
  maxBytes: number,
): Promise<{ mime: string | undefined; bytes: Uint8Array; truncated: boolean }> {
  if (maxBytes <= 0) {
    throw new IntegrationError({
      // Routes reject a non-positive max_bytes first (zod .min(1), and an
      // explicit INVALID_MAX_BYTES 400). Unreachable from HTTP.
      code: 'INTERNAL_PRECONDITION',
      message: 'maxBytes must be positive',
    });
  }

  let mime: string | undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  await streamArtifact(projectId, artifactId, {
    onHeaders: (info) => {
      mime = info.contentType;
    },
    onChunk: (chunk) => {
      if (truncated) return;
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        total += remaining;
        truncated = true;
      } else {
        chunks.push(chunk);
        total += chunk.length;
      }
    },
    onEnd: () => {},
  });

  return { mime, bytes: concatAll(chunks, total), truncated };
}

function concat(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatAll(parts: Uint8Array<ArrayBufferLike>[], total: number): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function parseContentLength(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function codeForStatus(status: number): import('./_lib/errors').IntegrationErrorCode {
  if (status === 401) return 'UPSTREAM_UNAUTHORIZED';
  if (status === 403) return 'UPSTREAM_FORBIDDEN';
  if (status === 404) return 'UPSTREAM_NOT_FOUND';
  if (status === 409) return 'UPSTREAM_CONFLICT';
  // 413 (payload too large) and 415 (unsupported media type) collapse to
  // UPSTREAM_BAD_STATUS per spec §8.5; the raw status is preserved on
  // IntegrationError.upstreamStatus so the route handler can pass it through.
  return 'UPSTREAM_BAD_STATUS';
}
