// Unified API Client for FR Frontend
// Production-ready API client with TypeScript generics, singleton pattern,
// Bearer token authentication, error handling, and interceptors

import { auth } from '$lib/stores/auth.svelte';
import { licenseGate } from '$lib/stores/licenseGate.svelte';
import {
  KAG_LICENSE_REQUIRED_CODE,
  KAG_LICENSE_REQUIRED_MESSAGE,
} from '$lib/api/kag-license';
import { ensureFreshToken } from '$lib/services/keycloak';
import { reportApiFailure } from '$lib/telemetry/client-errors';
import {
  arrayOf,
  decodeBody,
  itemsEnvelope,
  nullable,
  num,
  object,
  oneOf,
  optional,
  record,
  str,
  type Decoder,
} from '$lib/api/response-shape';
import { goto } from '$app/navigation';
import type { CardPriorityResponse } from '$lib/priority/priority';
import type {
  ApiResponse,
  PaginatedResponse,
  ListResponse,
  QueryParams,
  ApiClientConfig,
  LoadingState,
  RequestInterceptor,
  ResponseInterceptor,
  ErrorInterceptor,
  // Entity types
  Project,
  ProjectListResponse,
  ProjectCreate,
  ProjectStatusResponse,
  ProjectMetrics,
  ProjectRequest,
  ProjectRequestApproveResponse,
  ProjectRequestDraftResponse,
  Secret,
  SecretCreate,
  SecretUpdate,
  ScheduledTrigger,
  ScheduledTriggerCreate,
  ScheduledTriggerUpdate,
  ScheduledTriggerRun,
  Repository,
  RepositoryCreate,
  RepositoryUpdate,
  ProjectRepositoriesList,
  ProjectRepositoryAttachBody,
  ProjectRepositoryAttachResponse,
  URLCredential,
  URLCredentialCreate,
  URLCredentialUpdate,
  Document,
  DocumentUploadResponse,
  DocumentStatusResponse,
  Approval,
  ApprovalStatus,
  ApprovalCreate,
  ApprovalUpdate,
  ApprovalActionRequest,
  Comment,
  CommentCreate,
  QualityGate,
  ProjectQuality,
  ProjectQualityAnalysis,
  ProjectQualityHistory,
  ArchitectureGraph,
  DependencyReport,
  AggregateMetrics,
  MetricsQueryParams,
  Workflow,
  PlankaBoard,
  PlankaBoardDetail,
  PlankaCard,
  PlankaCardDetail,
  PlankaComment,
  PlankaCreateCardBody,
  PlankaUpdateCardBody,
  PlankaMoveCardBody,
  PlankaDuplicateCardBody,
  PlankaCreateCommentBody,
} from '$lib/types/api';
import type {
  ProducerId,
  ToolOutput,
  KanbanCardDraft,
  BridgeSourceDescriptor,
  BridgeLink,
  CreateDraftBody,
  PatchDraftBody,
  RejectDraftBody,
  CreateDraftsResponse,
  SubmitDraftResponse,
} from '$lib/bridge/types';

// =============================================================================
// API ERROR CLASS
// =============================================================================

/**
 * Custom API Error class with enhanced error information
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  public readonly data: any;
  public readonly endpoint: string;
  public readonly method: string;
  /**
   * True when this is a 403 `kag_license_required` — the tenant lacks the KAG
   * add-on. A KAG-SCOPED signal: the KAG surface renders it inline as "needs a
   * KAG license"; it deliberately does NOT trip the global fr licenseGate (which
   * would blank the whole app). See $lib/api/kag-license.ts.
   */
  public kagLicenseRequired = false;

  constructor(
    message: string,
    status: number,
    statusText: string,
    data?: any,
    endpoint?: string,
    method?: string
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.data = data;
    this.endpoint = endpoint || '';
    this.method = method || '';

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if ((Error as any).captureStackTrace) {
      (Error as any).captureStackTrace(this, ApiError);
    }
  }

  /**
   * Check if error is a network error (no response)
   */
  isNetworkError(): boolean {
    return this.status === 0;
  }

  /**
   * Check if error is an authentication error
   */
  isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /**
   * Check if error is a validation error
   */
  isValidationError(): boolean {
    return this.status === 400 || this.status === 422;
  }

  /**
   * Check if error is a not found error
   */
  isNotFoundError(): boolean {
    return this.status === 404;
  }

  /**
   * Check if error is a server error
   */
  isServerError(): boolean {
    return this.status >= 500;
  }

  /**
   * Get formatted error message
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      statusText: this.statusText,
      data: this.data,
      endpoint: this.endpoint,
      method: this.method,
    };
  }
}

// =============================================================================
// DECLARED RESPONSE SHAPES
// =============================================================================

/**
 * `GET /api/approvals/all` — `{items, total, scope, scope_tenant_id}`.
 *
 * Why this route first: `/approvals` is the busiest list in the product, it is
 * the only high-traffic page on the `UnifiedApiClient` path with a real
 * `<ErrorState>` already wired, and this file's own comments record a prior
 * incident where `items` and `total` disagreed. It also stands in for every
 * other `ListResponse<T>` here — projects, byoc, secrets, repositories — so the
 * next migration is a copy of this line.
 *
 * `items` is strict; `total` is optional and derives from `items.length` when
 * absent, matching how the page already reads it defensively. `scope` is a
 * closed set, so a fourth value invented server-side is a mismatch rather than
 * a silently mis-scoped list — this response is the ONLY thing that says which
 * population it covers, and a consumer is forbidden from re-deriving it.
 */
/**
 * `{ [key: string]: number }` — a server-built aggregate keyed by an enum member.
 *
 * Declared rather than passed through as `anything` for the reason the module
 * header gives: the values are what a facet PRINTS, so a string or a null
 * arriving where a count belongs must be a loud mismatch and not `NaN` rendered
 * beside a status pill. The KEYS are deliberately open — `approval_kind` is a
 * pg enum the backend may gain a member of, and a closed list here would turn an
 * additive server change into a red page, which is the trade `object()` already
 * refuses one level up.
 */
const countsByKey: Decoder<Record<string, number>> = {
  expected: 'object of number',
  read(input, path) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return num.read(input, path) as never; // reuses num's Mismatch wording
    }
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = num.read(value, `${path}.${key}`);
    }
    return out;
  },
};

const APPROVALS_LIST_ALL_SHAPE = object({
  items: arrayOf(
    record<Approval & { projectName: string | null; workspaceName?: string | null }>({
      id: str,
      status: str,
    }),
  ),
  total: optional(num),
  /**
   * ⛔ THIS LIST MUST COVER EVERY VALUE OF THE BACKEND'S `APPROVAL_SCOPE`
   * (`backend/src/lib/approval-roster-lane.ts`). `oneOf` FAILS CLOSED — it calls
   * `fail()`, which THROWS `Mismatch`, and `optional()` only short-circuits on
   * `undefined`/`null`, so a PRESENT-but-unlisted string is a hard decode error,
   * not a soft fallback. The whole `/api/approvals/all` response is then rejected
   * and the page renders its ErrorState.
   *
   * ⚠️ MEASURED LIVE 2026-09-23, and this was a real production break: the list
   * read `['tenant', 'all']` while the deployed backend emitted
   * `tenant_owned_or_rostered`, so every load of /approvals threw. The scope
   * vocabulary was widened the day before and FOUR out-of-repo Python readers
   * were taught the new values — while this decoder, in the same repo as the
   * change, was missed. Widening one fence hid the second.
   *
   * ⭐ P1-TEAM-a (George 2026-10-15): `'tenant'` is the `/api/approvals/all`
   * default again — the tenant lane (every project of the active tenant, no
   * owner pin). `'tenant_owned_or_rostered'` is still emitted by
   * `GET /api/approvals` (raised OR rostered) and keeps a rollback to the
   * previous image decodable instead of turning a rollback into a second outage.
   *
   * Drift is now a CI failure, not a production one:
   * `backend/tests/unit/lib/approval-scope-decoder-mirror.test.ts` reads THIS
   * FILE as text and fails if any `APPROVAL_SCOPE` value is missing here. It
   * reads the file rather than importing it, deliberately — the frontend and
   * backend are separate packages and a cross-boundary import passes locally and
   * fails in CI, which installs each package on its own.
   */
  scope: optional(
    oneOf([
      'all',
      'tenant',
      'tenant_owned_or_rostered',
      'tenant_rostered',
      'project',
    ] as const),
  ),
  scope_tenant_id: optional(nullable(str)),
  /**
   * Per-`approval_kind` counts over the WHOLE matching population — present
   * ONLY when the caller passed `kindCounts` (`?kind_counts=1`). Absent is the
   * normal case, including on every caller that does not render facets and on a
   * pre-aggregate server, so `optional` here is load-bearing: a consumer must
   * fall back rather than read a missing aggregate as a population of zero.
   */
  kind_totals: optional(countsByKey),
  /**
   * Per-`deblock_action` bucket counts — present ONLY when the caller passed
   * `actionCounts` (`?action_counts=1`). `optional` for the same load-bearing
   * reason as `kind_totals`: absent must fall back, never read as a population
   * of zero.
   *
   * ⚠️ These are counted over the population WITHOUT `?deblock_action=` applied,
   * so under a filter they do NOT sum to `total` — deliberately, so the chips a
   * decider has not selected keep reading their real sizes and stay navigable.
   */
  action_totals: optional(countsByKey),
  /** The action filter as APPLIED, echoed back; null when none was asked for. */
  deblock_action: optional(nullable(str)),
});

/**
 * How complete a list answer is. `exact` and `at_least` are CLAIMS the server
 * made; `unknown` is the absence of a claim and must never be produced from a
 * value the server sent — only from a missing one.
 */
export type ListCountState = 'exact' | 'at_least' | 'unknown';

/**
 * A capped list PLUS the server's own statement about whether it was capped.
 *
 * ⚠️ The truncation signal arrives in RESPONSE HEADERS, not the body:
 * fr's response-envelope convention sanctions only four body
 * shapes for a new route, and the honest one for a list with no COUNT query is
 * `{ items }` — `{ items, total }` would have to report the PAGE SIZE as the
 * match count. Same reasoning, same header names, as `assetFetchPage` in
 * `$lib/api/assets.ts` and `backend/src/routes/assets/_lib/page-cap.ts`.
 */
export interface ListPage<T> {
  items: T[];
  /** `X-Truncated: true` — the server measured MORE rows than it returned. */
  truncated: boolean;
  /** `X-Applied-Limit` — the cap actually applied; `null` if unstated. */
  appliedLimit: number | null;
  /**
   * `X-Count-State`, or `unknown` when the header is absent (an older backend,
   * or a proxy that stripped it). ⚠️ Silence is NOT `exact`: reading it that
   * way turns "I was not told" into "this is the whole set", which is the
   * absence-as-a-result defect this repo keeps shipping.
   */
  countState: ListCountState;
}

// =============================================================================
// UNIFIED API CLIENT
// =============================================================================

/**
 * Unified API Client with TypeScript generics and comprehensive features
 */
class UnifiedApiClient {
  private baseUrl: string;
  private timeout: number;
  private retries: number;
  private defaultHeaders: Record<string, string>;

  // Interceptors
  private requestInterceptors: RequestInterceptor[] = [];
  private responseInterceptors: ResponseInterceptor[] = [];
  private errorInterceptors: ErrorInterceptor[] = [];

  // Loading state management
  private loadingState: LoadingState = {
    isLoading: false,
  };
  private loadingCallbacks: Set<(state: LoadingState) => void> = new Set();

  constructor(config?: ApiClientConfig) {
    this.baseUrl = config?.baseUrl ?? '';
    this.timeout = config?.timeout || 30000; // 30 seconds
    this.retries = config?.retries || 0;
    this.defaultHeaders = config?.headers || {
      'Content-Type': 'application/json',
    };
  }

  // ===========================================================================
  // INTERCEPTOR MANAGEMENT
  // ===========================================================================

  /**
   * Add a request interceptor
   */
  addRequestInterceptor(interceptor: RequestInterceptor): void {
    this.requestInterceptors.push(interceptor);
  }

  /**
   * Add a response interceptor
   */
  addResponseInterceptor(interceptor: ResponseInterceptor): void {
    this.responseInterceptors.push(interceptor);
  }

  /**
   * Add an error interceptor
   */
  addErrorInterceptor(interceptor: ErrorInterceptor): void {
    this.errorInterceptors.push(interceptor);
  }

  /**
   * Clear all interceptors
   */
  clearInterceptors(): void {
    this.requestInterceptors = [];
    this.responseInterceptors = [];
    this.errorInterceptors = [];
  }

  // ===========================================================================
  // LOADING STATE MANAGEMENT
  // ===========================================================================

  /**
   * Subscribe to loading state changes
   */
  onLoadingChange(callback: (state: LoadingState) => void): () => void {
    this.loadingCallbacks.add(callback);
    // Return unsubscribe function
    return () => {
      this.loadingCallbacks.delete(callback);
    };
  }

  /**
   * Get current loading state
   */
  getLoadingState(): LoadingState {
    return { ...this.loadingState };
  }

  /**
   * Update loading state and notify subscribers
   */
  private setLoadingState(isLoading: boolean, endpoint?: string, method?: string): void {
    this.loadingState = { isLoading, endpoint, method };
    this.loadingCallbacks.forEach((callback) => callback(this.loadingState));
  }

  // ===========================================================================
  // CORE REQUEST METHOD
  // ===========================================================================

  /**
   * Build URL with query parameters
   */
  private buildUrl(endpoint: string, params?: QueryParams): string {
    // SSR has no `window.location.origin`. Prefer the explicit `baseUrl` set on
    // the client; fall back to the browser origin client-side; throw under SSR
    // rather than silently routing to `http://localhost` (which would point at
    // whatever happens to listen on the SSR host's port 80 — see
    // `feedback-no-hardcoded-urls-ports-in-code`). fr currently runs with
    // `export const ssr = false` on every authenticated route, so this branch
    // is unreachable in practice — the throw makes that contract explicit.
    let base = this.baseUrl;
    if (!base) {
      if (typeof window !== 'undefined') {
        base = window.location.origin;
      } else {
        throw new Error(
          'UnifiedClient: baseUrl is required in SSR — set it explicitly when constructing the client',
        );
      }
    }
    const url = new URL(endpoint, base);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      });
    }

    return url.toString();
  }

  /**
   * Core request method with all features
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit & {
      params?: QueryParams;
      skipAuth?: boolean;
      /**
       * Hands the caller the `Response` before its body is parsed, so a call
       * site can read RESPONSE HEADERS. `request` otherwise returns the parsed
       * body only and the headers are unreachable.
       *
       * This exists because some list routes keep a fixed body envelope and
       * therefore carry
       * their page-cap signal in headers (`X-Applied-Limit` / `X-Truncated` /
       * `X-Count-State`) — see `backend/src/routes/assets/_lib/page-cap.ts`
       * and `frontend/src/lib/api/assets.ts` `assetFetchPage`, which solve the
       * same problem outside this client.
       *
       * Strictly additive: it is destructured out before `fetch`, is never set
       * by the other call sites, and changes nothing they observe.
       */
      captureResponse?: (res: Response) => void;
      /** A longer (or shorter) client timeout for this one call; default `this.timeout`. */
      timeoutMs?: number;
    } = {}
  ): Promise<T> {
    const { params, skipAuth, captureResponse, timeoutMs, ...fetchOptions } = options;
    let url = this.buildUrl(endpoint, params);
    const method = fetchOptions.method || 'GET';

    // Start loading
    this.setLoadingState(true, endpoint, method);

    try {
      // Build headers
      const headers: Record<string, string> = {
        ...this.defaultHeaders,
        ...(fetchOptions.headers as Record<string, string> || {}),
      };

      // A FormData body MUST NOT carry an explicit Content-Type: the browser
      // sets `multipart/form-data` with the required boundary itself. The
      // default `application/json` from `defaultHeaders` (which `upload()`
      // can't strip — it's merged in here) would otherwise reach the server
      // without a boundary and make `req.formData()` throw
      // ERR_FORMDATA_PARSE_ERROR (HTTP 500). Drop it for FormData bodies.
      if (fetchOptions.body instanceof FormData) {
        delete headers['Content-Type'];
        delete headers['content-type'];
      }

      // Attach a freshly-validated Bearer token. We do NOT gate on
      // `auth.isAuthenticated` — keycloak-js can transiently flip that flag
      // during an in-flight refresh.
      if (!skipAuth) {
        const token = await ensureFreshToken(30);
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
      }

      // Mirrors auth-fetch.ts: super-admin tenant override; backend ignores for non-super-admins.
      if (!('X-Active-Tenant' in headers)) {
        try {
          if (typeof localStorage !== 'undefined') {
            const activeTenant = localStorage.getItem('fr.active_tenant');
            if (activeTenant) {
              headers['X-Active-Tenant'] = activeTenant;
            }
          }
        } catch {
          // localStorage access can throw in restricted contexts; ignore.
        }
      }

      // Prepare fetch options
      let finalOptions: RequestInit = {
        ...fetchOptions,
        headers,
      };

      // Apply request interceptors
      for (const interceptor of this.requestInterceptors) {
        const result = await interceptor(url, finalOptions);
        url = result.url;
        finalOptions = result.options;
      }

      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs ?? this.timeout);

      try {
        // Make the request
        // Never through the browser HTTP cache — see auth-fetch.ts.
        let response = await fetch(url, {
          ...finalOptions,
          cache: finalOptions.cache ?? 'no-store',
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Apply response interceptors
        for (const interceptor of this.responseInterceptors) {
          response = await interceptor(response);
        }

        // Headers, before the body is consumed and before the non-OK branch
        // throws — a caller that reads a page-cap header must see the same
        // response the error handling sees, not a later one.
        captureResponse?.(response);

        // Handle non-OK responses
        if (!response.ok) {
          // Client-side error sink. Hooked at this single shared seam (not at
          // the ~68 call sites) so every non-2xx is captured by construction.
          // Only status/method/path leave the browser — never a header, cookie
          // or body. `endpoint` is the API path, already free of credentials.
          reportApiFailure({
            path: endpoint,
            status: response.status,
            method,
            statusText: response.statusText,
          });
          await this.handleErrorResponse(response, endpoint, method, skipAuth);
        }

        // Handle empty responses (204 No Content)
        if (response.status === 204) {
          return null as T;
        }

        // Parse and return JSON response
        const data = await response.json();
        return data as T;
      } catch (error) {
        clearTimeout(timeoutId);

        // Handle abort/timeout
        if (error instanceof Error && error.name === 'AbortError') {
          throw new ApiError(
            'Request timeout',
            0,
            'Timeout',
            null,
            endpoint,
            method
          );
        }

        throw error;
      }
    } catch (error) {
      // Apply error interceptors
      for (const interceptor of this.errorInterceptors) {
        await interceptor(error as Error);
      }

      // If it's already an ApiError, rethrow it
      if (error instanceof ApiError) {
        throw error;
      }

      // Wrap unknown errors in ApiError
      throw new ApiError(
        error instanceof Error ? error.message : 'Unknown error',
        0,
        'Network Error',
        error,
        endpoint,
        method
      );
    } finally {
      // Stop loading
      this.setLoadingState(false);
    }
  }

  /**
   * Handle error responses with automatic 401 redirect
   */
  private async handleErrorResponse(
    response: Response,
    endpoint: string,
    method: string,
    skipAuth?: boolean
  ): Promise<never> {
    // Read the body as text first (the body stream can only be consumed
    // once), then try JSON. If parsing fails, fall back to a `detail`-keyed
    // text body so callers see meaningful detail even when the server
    // returned plain text or an HTML error page (was previously flattened
    // to `{}`).
    let errorData: Record<string, unknown>;
    const rawText = await response.text().catch(() => '');
    if (rawText) {
      try {
        const parsed = JSON.parse(rawText) as unknown;
        errorData =
          parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>)
            : { detail: String(parsed) };
      } catch {
        errorData = { detail: rawText };
      }
    } else {
      errorData = { detail: response.statusText };
    }

    // Automatic redirect to login on 401 Unauthorized
    if (response.status === 401 && !skipAuth) {
      console.error('Unauthorized - redirecting to login');
      // Use Keycloak login instead of goto
      await auth.login();
    }

    // License gate: a 403 `fr_license_required` means the workspace's fr license
    // is missing/expired. Flip the gate so the root layout renders the hard
    // block immediately (the layout reacts to `licenseGate.isBlocked`) — even
    // before the next status poll. The status/me endpoints are gate-exempt so
    // they never produce this code, so there's no refresh loop.
    const forbiddenCode =
      response.status === 403 && typeof errorData === 'object' && errorData !== null
        ? (errorData as { error?: unknown }).error
        : undefined;
    if (forbiddenCode === 'fr_license_required') {
      licenseGate.handleForbidden();
    }
    // A 403 `kag_license_required` is a KAG add-on gap, NOT the fr hard-block.
    // It must NOT trip the global licenseGate (that blanks the entire fr UI —
    // see $lib/api/kag-license.ts). Instead surface it as an honest, KAG-scoped
    // ApiError: flag it + give an honest message the KAG surface renders inline.
    const isKagLicenseError = forbiddenCode === KAG_LICENSE_REQUIRED_CODE;
    if (isKagLicenseError && !errorData.message) {
      errorData.message = KAG_LICENSE_REQUIRED_MESSAGE;
    }

    // Throw structured API error. Surface the most-detailed string field
    // we can find in the body so callers + UI toasts see something useful.
    const pickString = (v: unknown): string | null =>
      typeof v === 'string' && v.length > 0 ? v : null;
    // For the KAG add-on gap, the honest human message wins over the raw
    // `kag_license_required` code so the KAG surface's inline `err.message`
    // reads plainly.
    const message = isKagLicenseError
      ? KAG_LICENSE_REQUIRED_MESSAGE
      : (pickString(errorData.error) ??
        pickString(errorData.message) ??
        pickString(errorData.detail) ??
        `Request failed with status ${response.status}`);
    const apiError = new ApiError(
      message,
      response.status,
      response.statusText,
      errorData,
      endpoint,
      method
    );
    apiError.kagLicenseRequired = isKagLicenseError;
    throw apiError;
  }

  // ===========================================================================
  // HTTP METHOD HELPERS
  // ===========================================================================

  /**
   * GET request
   */
  async get<T>(
    endpoint: string,
    options?: RequestInit & {
      params?: QueryParams;
      /** See `request`: lets a call site read RESPONSE HEADERS. */
      captureResponse?: (res: Response) => void;
    },
  ): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'GET' });
  }

  /**
   * GET, checked against a DECLARED response shape.
   *
   * `get<T>()` above ends in `return data as T` — a cast, which is a promise
   * the compiler cannot keep. `getShaped` is the same request with the promise
   * actually checked at runtime: a body the caller cannot read throws
   * `ResponseShapeError` and emits a telemetry line, instead of flowing on as a
   * well-typed value whose fields are all `undefined`.
   *
   * Deliberately additive. Nothing about `get<T>` changes, so the other ~68
   * call sites keep working and can be migrated one at a time — or never.
   *
   * A 204 reaches here as `null` and is a mismatch against any list shape,
   * which is correct: "no content" is not "zero rows", and the whole point of
   * this method is refusing to collapse those two.
   */
  async getShaped<T>(
    endpoint: string,
    shape: Decoder<T>,
    options?: RequestInit & { params?: QueryParams },
  ): Promise<T> {
    const body = await this.request<unknown>(endpoint, { ...options, method: 'GET' });
    return decodeBody(body, shape, { endpoint, method: 'GET', status: 200 });
  }

  /**
   * GET a binary response as a Blob (not JSON). Reuses the same Bearer-token +
   * X-Active-Tenant + error handling as `request`, but returns raw bytes — for
   * endpoints like /api/approvals/:id/document that stream a file. A Bearer
   * header can't ride an `<iframe src>`, so the caller fetches the blob here and
   * renders it via `URL.createObjectURL`.
   */
  async getBlob(endpoint: string, options?: { params?: QueryParams }): Promise<Blob> {
    const url = this.buildUrl(endpoint, options?.params);
    const headers: Record<string, string> = {};
    const token = await ensureFreshToken(30);
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      if (typeof localStorage !== 'undefined') {
        const activeTenant = localStorage.getItem('fr.active_tenant');
        if (activeTenant) headers['X-Active-Tenant'] = activeTenant;
      }
    } catch {
      // localStorage can throw in restricted contexts; ignore.
    }
    const response = await fetch(url, { method: 'GET', headers, cache: 'no-store' });
    if (!response.ok) {
      await this.handleErrorResponse(response, endpoint, 'GET');
    }
    return response.blob();
  }

  /**
   * POST request
   */
  async post<T>(
    endpoint: string,
    data?: any,
    options?: RequestInit & { params?: QueryParams }
  ): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  /**
   * PUT request
   */
  async put<T>(
    endpoint: string,
    data?: any,
    options?: RequestInit & { params?: QueryParams }
  ): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  /**
   * PATCH request
   */
  async patch<T>(
    endpoint: string,
    data?: any,
    options?: RequestInit & { params?: QueryParams }
  ): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  /**
   * DELETE request
   */
  async delete<T>(endpoint: string, options?: RequestInit & { params?: QueryParams }): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'DELETE' });
  }

  /**
   * Upload file with FormData
   */
  async upload<T>(endpoint: string, formData: FormData, options?: RequestInit): Promise<T> {
    // Don't set Content-Type header - browser will set it with boundary
    const headers: Record<string, string> = { ...(options?.headers as Record<string, string> || {}) };
    delete headers['Content-Type'];

    return this.request<T>(endpoint, {
      ...options,
      method: 'POST',
      headers,
      body: formData,
    });
  }

  // ===========================================================================
  // PROJECT ENDPOINTS
  // ===========================================================================

  projects = {
    /**
     * List all projects.
     *
     * ⭐ `ProjectListResponse`, NOT `ListResponse<Project>`: the envelope carries
     * `archived_excluded`, the count the route's default `ne(status,'archived')`
     * predicate withheld from THIS request. Typing it away is what let the
     * projects page render "No projects yet" over 133 archived projects
     * (fr#1259) — the signal was on the wire and unreadable to the caller.
     *
     * ⭐ It also carries `dead_board_excluded`, the SECOND withholding count: the
     * route's board-liveness drop removes ACTIVE rows whose Planka board is
     * confirmed gone, and it runs AFTER `archived_excluded` is counted. Without
     * that second number an empty list plus `archived_excluded: 0` is an EXPLICIT
     * "nothing was withheld" about a workspace that has live projects. Both are
     * optional on the type and both mean "the server did not say" when absent —
     * never 0.
     */
    list: (params?: QueryParams) =>
      this.get<ProjectListResponse>('/api/projects', { params }),

    /**
     * Get a project by ID
     */
    get: (id: string) => this.get<Project>(`/api/projects/${id}`),

    /**
     * Create a new project
     */
    create: (data: ProjectCreate, opts?: { idempotencyKey?: string; proposalId?: string }) => {
      // One key per form session (ProjectForm): a retry of the same submit
      // returns the project the first attempt made instead of a second one.
      // `X-Agent-Proposal-Id` (fr-agui SPEC §5.2 W) marks a create the human
      // confirmed from an agent proposal card; the route treats it as any create.
      const headers: Record<string, string> = {
        ...(opts?.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
        ...(opts?.proposalId ? { 'X-Agent-Proposal-Id': opts.proposalId } : {}),
      };
      return this.post<Project>('/api/projects', data, Object.keys(headers).length > 0 ? { headers } : {});
    },

    // (No `patch`: PATCH /api/projects/:id accepts no field since D15/R16 —
    // name, description, branch, priority, question_mode and the programme link
    // are requirements_management's after the request; only the PM writes them.)

    /**
     * Set (or clear, with `null`) a card's priority via
     * PATCH /api/projects/:projectId/cards/:cardId/priority. Every effective
     * change is audited server-side.
     */
    setCardPriority: (projectId: string, cardId: string, priority: string | null) =>
      this.patch<CardPriorityResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(cardId)}/priority`,
        { priority },
      ),

    /**
     * Delete a project (soft delete - archives it)
     */
    delete: (id: string) => this.delete<void>(`/api/projects/${id}`),

    /**
     * Get project status
     */
    getStatus: (id: string) => this.get<ProjectStatusResponse>(`/api/projects/${id}/status`),

    /**
     * Provision this project's coding-containers entry (repo clone + docker
     * environment + code-graph indexing). Required before the Architecture,
     * Dependency Report, and Quality Gate tabs can surface data.
     *
     * Returns the updated Project row (container_name + repository_provisioned
     * get populated on success).
     */
    provision: (id: string) => this.post<Project>(`/api/projects/${id}/provision`, {}),

    /**
     * Get project metrics
     */
    getMetrics: (id: string) => this.get<ProjectMetrics>(`/api/projects/${id}/metrics`),

    /**
     * Project ↔ Repository membership (migration 072 / task #25 scope B PR 2).
     *
     * The project has 0..N attached repositories with exactly one primary;
     * existing readers (AG-UI brief, coding adapter, head-sha resolver)
     * continue to consume the denormalised primary on
     * `projects.repository_url/branch/container_name`. These methods are
     * the operational surface — list enumerates them, attach lets a user
     * add another, promote re-stamps the cache columns inside one backend
     * transaction.
     */
    repositories: {
      list: (projectId: string) =>
        this.get<ProjectRepositoriesList>(`/api/projects/${projectId}/repositories`),
      attach: (
        projectId: string,
        body: ProjectRepositoryAttachBody,
      ) =>
        this.post<ProjectRepositoryAttachResponse>(
          `/api/projects/${projectId}/repositories`,
          body,
        ),
      detach: (projectId: string, repoId: string) =>
        this.delete<void>(`/api/projects/${projectId}/repositories/${repoId}`),
      promote: (projectId: string, repoId: string) =>
        this.put<ProjectRepositoriesList>(
          `/api/projects/${projectId}/repositories/${repoId}/primary`,
          {},
        ),
    },
  };

  // ===========================================================================
  // PROJECT REQUEST ENDPOINTS — the CP→fr bridge RECEIVING half. Common Practice
  // POSTs draft project requests to /api/project-requests (SA-authed); these are
  // the human review/approve surface (tenant-scoped). Approve promotes a draft to
  // a real project identical to POST /api/projects.
  // ===========================================================================
  // ===========================================================================
  // fr-agui SPEC §5.2 (W) — `POST /api/capabilities/:id/invoke`: the route the
  // `capability-invoke` confirm card calls for an AGENT-NATIVE write (no UI
  // route of its own), under the HUMAN's session. The response carries the
  // action's result (or its PendingAction, HTTP 202, when the action's own
  // approval policy parks) and `invalidate`, the resources to re-fetch.
  // `X-Agent-Proposal-Id` is read by the route for AUDIT only; it binds nothing.
  // The route reads no `Idempotency-Key` header: a repeat is deduped by the
  // registry's per-user runIdempotent on the input's `idempotency_key`.
  // ===========================================================================
  capabilities = {
    invoke: (id: string, input: Record<string, unknown>, opts: { proposalId: string }) =>
      this.post<{ data: unknown; invalidate?: string[] }>(
        `/api/capabilities/${encodeURIComponent(id)}/invoke`,
        input,
        { headers: { 'X-Agent-Proposal-Id': opts.proposalId } },
      ),
  };

  projectRequests = {
    /**
     * fr-agui SPEC §5.2 (W): the agent's `project-request` confirm card passes
     * the proposal id it confirms; it rides as `X-Agent-Proposal-Id` (the route
     * treats the request exactly like the classic UI's). Absent ⇒ no header.
     */
    proposalHeaders: (opts?: { proposalId?: string }): RequestInit =>
      opts?.proposalId ? { headers: { 'X-Agent-Proposal-Id': opts.proposalId } } : {},
    list: (params?: QueryParams) =>
      this.get<ListResponse<ProjectRequest>>('/api/project-requests', { params }),
    /**
     * Conversational intake (D5) — free text → single-turn worker extraction →
     * a DRAFT project_request. The caller then redirects to the review page
     * (`/projects/requests/:id`) where the human edits + approves.
     */
    draftFromText: (data: { text: string; name?: string }, opts?: { proposalId?: string }) =>
      this.post<ProjectRequestDraftResponse>(
        '/api/project-requests/draft-from-text',
        data,
        this.projectRequests.proposalHeaders(opts),
      ),
    get: (id: string) => this.get<ProjectRequest>(`/api/project-requests/${id}`),
    /** Edit the draft payload (while draft/failed). */
    patch: (id: string, data: Partial<ProjectCreate>, opts?: { proposalId?: string }) =>
      this.patch<ProjectRequest>(`/api/project-requests/${id}`, data, this.projectRequests.proposalHeaders(opts)),
    /** Promote to a real project. Body is the final edited ProjectCreate. */
    /** An EMPTY body (`{}`) approves the request's stored payload as it is (the route's own rule). */
    approve: (id: string, data: ProjectCreate | Record<string, never>, opts?: { proposalId?: string }) =>
      this.post<ProjectRequestApproveResponse>(
        `/api/project-requests/${id}/approve`,
        data,
        this.projectRequests.proposalHeaders(opts),
      ),
    reject: (id: string, reason: string, opts?: { proposalId?: string }) =>
      this.post<ProjectRequest>(`/api/project-requests/${id}/reject`, { reason }, this.projectRequests.proposalHeaders(opts)),
    /**
     * Lifecycle: draft|failed → submitted (and analysis dispatch). Backend
     * returns `{ data: { ...row, dispatched, dispatch_note? } }`; unwrapped here.
     * `dispatched:false` means analysis did NOT start (e.g. no workflow
     * configured) — callers must say so, never imply it started.
     */
    submit: async (
      id: string,
      opts?: { proposalId?: string },
    ): Promise<import('$lib/components/project-request/types').SubmitProjectRequestResult> => {
      const e = await this.post<{
        data: import('$lib/components/project-request/types').SubmitProjectRequestResult;
      }>(`/api/project-requests/${id}/submit`, {}, this.projectRequests.proposalHeaders(opts));
      return e.data;
    },
    /**
     * Lifecycle: draft|submitted|analysing|outline_proposed -> withdrawn. The
     * REQUESTER takes their own request back; any in-flight outline approval is
     * superseded and voided server-side. Requester-only (403 otherwise) and
     * terminal. Backend returns `{ data: { ...row, voided_approval_ids } }`.
     */
    withdraw: async (id: string, opts?: { proposalId?: string }): Promise<ProjectRequest> => {
      const e = await this.post<{ data: ProjectRequest }>(
        `/api/project-requests/${id}/withdraw`,
        {},
        this.projectRequests.proposalHeaders(opts),
      );
      return e.data;
    },
    /** Versioned outlines, newest version first. */
    listOutlines: (id: string) =>
      this.get<{ items: import('$lib/components/project-request/types').Outline[] }>(
        `/api/project-requests/${id}/outlines`,
      ),
  };

  // ===========================================================================
  // SECRET ENDPOINTS
  // ===========================================================================

  secrets = {
    /**
     * List the current user's secrets. The optional `projectId` arg is accepted
     * for caller compatibility but ignored — the backend stores secrets per
     * user, not per project.
     */
    list: (_projectId?: string) => this.get<ListResponse<Secret>>('/api/secrets'),

    /**
     * Create a new secret
     */
    create: (data: SecretCreate) => this.post<Secret>('/api/secrets', data),

    /**
     * Update a secret
     */
    update: (id: string, data: SecretUpdate) => this.put<Secret>(`/api/secrets/${id}`, data),

    /**
     * Delete a secret
     */
    delete: (id: string) => this.delete<void>(`/api/secrets/${id}`),
  };

  // ===========================================================================
  // REPOSITORY ENDPOINTS
  // ===========================================================================

  repositories = {
    /**
     * List all repositories
     */
    list: () => this.get<ListResponse<Repository>>('/api/repositories'),

    /**
     * Get a repository by ID
     */
    get: (id: string) => this.get<Repository>(`/api/repositories/${id}`),

    /**
     * Create a new repository
     */
    create: (data: RepositoryCreate) => this.post<Repository>('/api/repositories', data),

    /**
     * Update a repository
     */
    update: (id: string, data: RepositoryUpdate) =>
      this.put<Repository>(`/api/repositories/${id}`, data),

    /**
     * Delete a repository
     */
    delete: (id: string) => this.delete<void>(`/api/repositories/${id}`),
  };

  // ===========================================================================
  // URL CREDENTIAL ENDPOINTS
  // ===========================================================================

  urlCredentials = {
    /**
     * List all URL credentials
     */
    list: () => this.get<ListResponse<URLCredential>>('/api/url-credentials'),

    /**
     * Get a URL credential by ID
     */
    get: (id: string) => this.get<URLCredential>(`/api/url-credentials/${id}`),

    /**
     * Create a new URL credential
     */
    create: (data: URLCredentialCreate) =>
      this.post<URLCredential>('/api/url-credentials', data),

    /**
     * Update a URL credential
     */
    update: (id: string, data: URLCredentialUpdate) =>
      this.put<URLCredential>(`/api/url-credentials/${id}`, data),

    /**
     * Delete a URL credential
     */
    delete: (id: string) => this.delete<void>(`/api/url-credentials/${id}`),
  };

  // ===========================================================================
  // DOCUMENT ENDPOINTS
  // ===========================================================================

  documents = {
    /**
     * List documents. If projectId provided, lists project documents; otherwise all user documents.
     */
    list: (projectId?: string, params?: QueryParams) => {
      if (projectId) {
        return this.get<ListResponse<Document>>(`/api/projects/${projectId}/documents`, { params });
      }
      return this.get<ListResponse<Document>>('/api/documents', { params });
    },

    /**
     * Upload a document
     */
    upload: (
      projectId: string | null,
      file: File,
      options: { sendToKag?: boolean } = {},
    ) => {
      const formData = new FormData();
      formData.append('file', file);
      // project_id is optional: omit it for workspace-scoped knowledge (the
      // doc becomes usable by every workflow in the tenant). Only pin to a
      // project when one was explicitly chosen.
      if (projectId) {
        formData.append('project_id', projectId);
      }
      // Default ON: only emit the field when the caller explicitly opts out
      // so that older non-toggle-aware callers preserve their behaviour.
      if (options.sendToKag === false) {
        formData.append('send_to_kag', 'false');
      }
      return this.upload<DocumentUploadResponse>('/api/documents/upload', formData);
    },

    /**
     * Delete a document
     */
    delete: (id: string) => this.delete<void>(`/api/documents/${id}`),

    /**
     * Get document status
     */
    getStatus: (id: string) => this.get<DocumentStatusResponse>(`/api/documents/${id}/status`),
  };

  // ===========================================================================
  // APPROVAL ENDPOINTS
  // ===========================================================================

  approvals = {
    /**
     * List all approvals for a project
     */
    list: (projectId: string) =>
      this.get<ListResponse<Approval>>(`/api/projects/${projectId}/approvals`),

    /**
     * List approvals across EVERY project the caller can see, in one request
     * (replaces the /approvals page's per-project fan-out). Each row carries a
     * `projectName` and a `workspaceName` — the latter is the only scope marker
     * a null-project row has, and a super-admin in their home view reads every
     * workspace's rows here.
     *
     * ⛔ `limit` IS NOT OPTIONAL IN PRACTICE, AND THE OLD SIGNATURE MADE IT
     * UNASKABLE. The previous form took a bare `status` and could express no
     * paging at all, so /approvals called it with neither — and the server
     * applies NO limit when `limit` is absent (handleListAllApprovals:
     * `limit === undefined` skips `.limit()` entirely). Measured on prod
     * 2026-09-13: 3,992 approvals over five statuses, every one of them
     * enriched with its roster + decisions + resolved identities, re-fetched
     * every 30 seconds by every open tab. `total` has counted the WHOLE
     * matching population since #855, so a bounded page can still state the
     * size of the set it came from — which is the only reason bounding here
     * does not hide anything.
     *
     * `status` is the full `ApprovalStatus` union, not the three-member subset
     * this used to accept: `expired` and `voided` are real, tabbed statuses
     * (120 and 892 rows on prod) and the narrow type made them unfetchable
     * through this client even though the endpoint has always served them.
     */
    listAll: (params?: {
      status?: ApprovalStatus;
      limit?: number;
      offset?: number;
      /**
       * Opt in to `kind_totals` — the per-`kind` aggregate over the whole
       * matching population (`?kind_counts=1`).
       *
       * ⛔ OPT-IN ON PURPOSE, AND IT MUST STAY THAT WAY. The flag costs the
       * server a second full scan (one `GROUP BY` over the same `where` as
       * `total`), and the /approvals page issues SIX reads per refresh — one for
       * the rows and five `limit=1` population probes. Setting this on the
       * probes would multiply a 30s poll's cost to serve a number only the facet
       * row reads. Pass it from the ONE request that renders facets, nowhere
       * else. See `parseKindCountsFlag` in backend/src/routes/approvals.ts.
       */
      kindCounts?: boolean;
      /**
       * Opt in to `action_totals` — the per-`deblock_action` aggregate
       * (`?action_counts=1`). Opt-in for exactly the reason `kindCounts` is; the
       * same five `limit=1` probes must not each drag a third scan behind them.
       */
      actionCounts?: boolean;
      /**
       * Narrow the ROWS to one `deblock_action` bucket — a member of
       * `DEBLOCK_ACTIONS`, or `none` / `other` (`?deblock_action=`).
       *
       * ⭐ SERVER-SIDE, AND THAT IS THE POINT. The pending queue is ~1,294 rows
       * against a 200-row page, so the ~395 QUESTION rows in it cannot be
       * reached by filtering what the browser happens to hold. Sending the
       * filter makes the DB stop producing the other 899, which puts the whole
       * subset inside one page AND makes `total` report the subset's real size.
       */
      deblockAction?: string;
      /**
       * Narrow to one project (`?project_id=`). UI review 2026-10-07: the
       * /approvals page gained a project filter. Absent ⇒ every project.
       */
      projectId?: string;
    }) => {
      const query = new URLSearchParams();
      if (params?.status) query.set('status', params.status);
      if (params?.projectId) query.set('project_id', params.projectId);
      if (params?.limit !== undefined) query.set('limit', String(params.limit));
      if (params?.offset) query.set('offset', String(params.offset));
      if (params?.kindCounts) query.set('kind_counts', '1');
      if (params?.actionCounts) query.set('action_counts', '1');
      if (params?.deblockAction) query.set('deblock_action', params.deblockAction);
      const qs = query.toString();
      return this.getShaped(
        `/api/approvals/all${qs ? `?${qs}` : ''}`,
        APPROVALS_LIST_ALL_SHAPE,
      );
    },

    /**
     * Get an approval by ID
     */
    get: (id: string) => this.get<Approval>(`/api/approvals/${id}`),

    /**
     * Fetch the pending document for a KAG document-upload approval as a Blob,
     * for the approval-time preview. Only meaningful when the approval carries a
     * `document` descriptor; 404s otherwise. See handleGetApprovalDocument.
     */
    getDocumentBlob: (id: string) => this.getBlob(`/api/approvals/${id}/document`),

    /**
     * Create a new approval request
     */
    create: (projectId: string, data: ApprovalCreate) =>
      this.post<Approval>(`/api/projects/${projectId}/approvals`, data),

    /**
     * Update an approval
     */
    update: (id: string, data: ApprovalUpdate) =>
      this.put<Approval>(`/api/approvals/${id}`, data),

    /**
     * Approve a request. There is no POST /api/approvals/:id/approve route on
     * the backend — approve/reject are the `status` field on the shared
     * PUT /api/approvals/:id (UpdateApprovalSchema: { status, comment?, reason? }).
     */
    approve: (id: string, data?: ApprovalActionRequest) =>
      this.put<Approval>(`/api/approvals/${id}`, { status: 'approved', ...data }),

    /**
     * Reject a request. See `approve` — same PUT /api/approvals/:id endpoint.
     */
    reject: (id: string, data: ApprovalActionRequest) =>
      this.put<Approval>(`/api/approvals/${id}`, { status: 'rejected', ...data }),
  };

  // ===========================================================================
  // COMMENT ENDPOINTS
  // ===========================================================================

  comments = {
    /**
     * List all comments for a project
     */
    list: (projectId: string) =>
      this.get<ListResponse<Comment>>(`/api/projects/${projectId}/comments`),

    /**
     * Create a new comment
     */
    create: (projectId: string, data: CommentCreate) =>
      this.post<Comment>(`/api/projects/${projectId}/comments`, data),

    /**
     * Update a comment
     */
    update: (id: string, data: CommentCreate) => this.put<Comment>(`/api/comments/${id}`, data),

    /**
     * Delete a comment
     */
    delete: (id: string) => this.delete<void>(`/api/comments/${id}`),
  };

  // ===========================================================================
  // QUALITY & ARCHITECTURE ENDPOINTS
  // ===========================================================================

  quality = {
    /**
     * Get quality gate for a container.
     * Namespaced coding surface returns `{ data: QualityGate }`; unwrap so
     * callers receive the bare typed object.
     */
    getQualityGate: async (containerName: string): Promise<QualityGate> => {
      const e = await this.get<{ data: QualityGate }>(
        `/api/coding/quality/${containerName}/gate`,
      );
      return e.data;
    },

    /** Project Quality tab: STORED result + CI per repo (never re-lints). */
    getProjectQuality: async (projectId: string): Promise<ProjectQuality> => {
      const e = await this.get<{ data: ProjectQuality }>(
        `/api/projects/${encodeURIComponent(projectId)}/quality`,
      );
      return e.data;
    },

    /** Stored run history for one repo of the project (newest first). */
    getProjectQualityHistory: async (
      projectId: string,
      repoId: string,
    ): Promise<ProjectQualityHistory> => {
      const e = await this.get<{ data: ProjectQualityHistory }>(
        `/api/projects/${encodeURIComponent(projectId)}/quality/history`,
        { params: { repo_id: repoId } },
      );
      return e.data;
    },

    /** Start an analysis (202); the backend ensures a workspace per repo first. */
    analyzeProject: async (projectId: string): Promise<ProjectQualityAnalysis> => {
      const e = await this.post<{ data: { analysis: ProjectQualityAnalysis } }>(
        `/api/projects/${encodeURIComponent(projectId)}/quality/analyze`,
      );
      return e.data.analysis;
    },
  };

  architecture = {
    /**
     * Get architecture (augmented) graph for a container.
     * Namespaced coding surface returns `{ data: ArchitectureGraph }`.
     */
    getGraph: async (containerName: string): Promise<ArchitectureGraph> => {
      const e = await this.get<{ data: ArchitectureGraph }>(
        `/api/coding/graphs/${containerName}/augmented`,
      );
      return e.data;
    },
  };

  dependencies = {
    /**
     * Get dependency report for a container.
     * Namespaced coding surface returns `{ data: DependencyReport }`.
     */
    getReport: async (containerName: string): Promise<DependencyReport> => {
      const e = await this.get<{ data: DependencyReport }>(
        `/api/coding/dependencies/${containerName}/report`,
      );
      return e.data;
    },
  };

  // ===========================================================================
  // METRICS ENDPOINTS
  // ===========================================================================

  metrics = {
    /**
     * Get aggregate metrics
     */
    getAggregate: (params?: MetricsQueryParams) =>
      this.get<AggregateMetrics>('/api/metrics/aggregate', { params }),

    /**
     * Get project metrics
     */
    getProject: (projectId: string) =>
      this.get<ProjectMetrics>(`/api/projects/${projectId}/metrics`),
  };

  // ===========================================================================
  // WORKFLOW ENDPOINTS
  // ===========================================================================

  workflows = {
    /**
     * Get a workflow by id (GET /api/workflows/:id — the read-only viewer
     * route; the backend registers no POST/PUT on /api/workflows).
     */
    get: (id: string) => this.get<Workflow>(`/api/workflows/${id}`),
  };

  // ===========================================================================
  // KANBAN ENDPOINTS (Planka proxy — trimmed to the conveyor operations,
  // George 2026-10-10; lists/labels/checklists/members are edited in Planka)
  // ===========================================================================

  kanban = {
    // ----- Reads -----------------------------------------------------------
    /** List all boards across all Planka projects */
    listBoards: () => this.get<ListResponse<PlankaBoard>>('/api/kanban/boards'),

    /** Get a board with its lists, cards, and labels */
    getBoard: (id: string) => this.get<PlankaBoardDetail>(`/api/kanban/boards/${id}`),

    /** Get full card detail with comments, tasks, and actions */
    getCard: (id: string) => this.get<PlankaCardDetail>(`/api/kanban/cards/${id}`),

    // ----- Cards -----------------------------------------------------------
    createCard: (listId: string, body: PlankaCreateCardBody) =>
      this.post<PlankaCard>(`/api/kanban/lists/${listId}/cards`, body),

    updateCard: (cardId: string, patch: PlankaUpdateCardBody) =>
      this.patch<PlankaCard>(`/api/kanban/cards/${cardId}`, patch),

    /** Move a card. Resolves with the moved card (200). */
    moveCard: (cardId: string, body: PlankaMoveCardBody) =>
      this.post<PlankaCard>(`/api/kanban/cards/${cardId}/move`, body),

    duplicateCard: (cardId: string, body?: PlankaDuplicateCardBody) =>
      this.post<PlankaCard>(`/api/kanban/cards/${cardId}/duplicate`, body ?? {}),

    deleteCard: (cardId: string) => this.delete<void>(`/api/kanban/cards/${cardId}`),

    // ----- Comments --------------------------------------------------------
    listComments: (cardId: string) =>
      this.get<ListResponse<PlankaComment>>(`/api/kanban/cards/${cardId}/comments`),

    createComment: (cardId: string, body: PlankaCreateCommentBody) =>
      this.post<PlankaComment>(`/api/kanban/cards/${cardId}/comments`, body),

    // ----- Labels (attach/detach an EXISTING board label) ------------------
    attachLabel: (cardId: string, labelId: string) =>
      this.post<void>(`/api/kanban/cards/${cardId}/labels/${labelId}`, {}),

    detachLabel: (cardId: string, labelId: string) =>
      this.delete<void>(`/api/kanban/cards/${cardId}/labels/${labelId}`),
  };

  // ===========================================================================
  // AUTH ENDPOINTS
  // ===========================================================================

  auth = {
    /**
     * Get current user info
     */
    me: () => this.get<any>('/api/auth/me'),
  };

  // ===========================================================================
  // CONTAINERS ENDPOINTS (coding-gateway)
  // ===========================================================================

  containers = {
    /**
     * List coding-gateway containers.
     * Namespaced coding surface returns `{ data: ... }`; unwrap so callers
     * receive the bare payload.
     */
    list: async (): Promise<any> => {
      const e = await this.get<{ data: any }>('/api/coding/containers');
      return e.data;
    },
  };

  // ===========================================================================
  // ASSET ENDPOINTS (/api/assets/*)
  // ===========================================================================
  //
  // All asset endpoints return `{ data: ... }` on success and
  // `{ error: { code, message, upstream? } }` on failure. We unwrap `data`
  // here so callers receive the underlying payload directly; on failure the
  // envelope surfaces as an ApiError via `handleErrorResponse`.

  private async getAsset<T>(endpoint: string, params?: QueryParams): Promise<T> {
    const envelope = await this.get<{ data: T }>(endpoint, { params });
    return envelope.data;
  }

  private async postAsset<T>(endpoint: string, data?: unknown): Promise<T> {
    const envelope = await this.post<{ data: T }>(endpoint, data);
    return envelope.data;
  }

  private async putAsset<T>(endpoint: string, data?: unknown): Promise<T> {
    const envelope = await this.put<{ data: T }>(endpoint, data);
    return envelope.data;
  }

  requirements = {
    list: (params?: QueryParams) =>
      this.getAsset<unknown[]>('/api/assets/requirements', params),
    get: (rid: string) =>
      this.getAsset<Record<string, unknown>>(`/api/assets/requirements/${encodeURIComponent(rid)}`),
    create: (data: Record<string, unknown>) =>
      this.postAsset<Record<string, unknown>>('/api/assets/requirements', data),
    update: (rid: string, data: Record<string, unknown>) =>
      this.putAsset<Record<string, unknown>>(`/api/assets/requirements/${encodeURIComponent(rid)}`, data),
    remove: (rid: string) =>
      this.delete<void>(`/api/assets/requirements/${encodeURIComponent(rid)}`),
    search: (params?: QueryParams) =>
      this.getAsset<unknown[]>('/api/assets/requirements/search', params),
  };

  principles = {
    list: (params?: QueryParams) =>
      this.getAsset<unknown[]>('/api/assets/principles', params),
    get: (pid: string) =>
      this.getAsset<Record<string, unknown>>(`/api/assets/principles/${encodeURIComponent(pid)}`),
    create: (data: Record<string, unknown>) =>
      this.postAsset<Record<string, unknown>>('/api/assets/principles', data),
    update: (pid: string, data: Record<string, unknown>) =>
      this.putAsset<Record<string, unknown>>(`/api/assets/principles/${encodeURIComponent(pid)}`, data),
    remove: (pid: string) =>
      this.delete<void>(`/api/assets/principles/${encodeURIComponent(pid)}`),
    search: (params?: QueryParams) =>
      this.getAsset<unknown[]>('/api/assets/principles/search', params),
  };

  decisions = {
    list: (params?: QueryParams) =>
      this.getAsset<unknown[]>('/api/assets/decisions', params),
    get: (did: string) =>
      this.getAsset<Record<string, unknown>>(`/api/assets/decisions/${encodeURIComponent(did)}`),
    create: (data: Record<string, unknown>) =>
      this.postAsset<Record<string, unknown>>('/api/assets/decisions', data),
    update: (did: string, data: Record<string, unknown>) =>
      this.putAsset<Record<string, unknown>>(`/api/assets/decisions/${encodeURIComponent(did)}`, data),
    remove: (did: string) =>
      this.delete<void>(`/api/assets/decisions/${encodeURIComponent(did)}`),
    search: (params?: QueryParams) =>
      this.getAsset<unknown[]>('/api/assets/decisions/search', params),
  };

  kag = {
    search: (data: { query_text?: string; query?: string; limit?: number; top_k?: number }) =>
      this.postAsset<Record<string, unknown>>('/api/assets/kag/search', data),
  };

  // ===========================================================================
  // BRIDGE ENDPOINTS (analysis → kanban)
  // ===========================================================================
  //
  // Bridge routes use the `{ data, meta? }` envelope per the spec
  // (2026-04-24-analysis-to-kanban-bridge.md §Envelope). We unwrap `data`
  // here so callers receive the inner payload directly; errors surface as
  // ApiError via handleErrorResponse.

  bridge = {
    /**
     * GET /api/tools/bridge/sources — list registered producers.
     *
     * NOTE: every bridge route is `(user_id, project_id)` scoped by the
     * backend (see backend/src/routes/tools/bridge.ts §requireProjectIdFromQuery
     * and the `body.project_id` checks in handleCreateDrafts / handleSubmitDraft
     * etc). GETs receive `project_id` as a query parameter; writes carry it
     * in the JSON body. Callers MUST supply a project id; calling these
     * methods without one would 400 from the backend.
     */
    listSources: (project_id: string) =>
      this.getAsset<{ sources: BridgeSourceDescriptor[] }>(
        '/api/tools/bridge/sources',
        { project_id },
      ),

    /**
     * GET /api/tools/bridge/sources/:producer/outputs — list promotable outputs
     * for a producer with optional producer-specific filters.
     */
    listOutputs: (
      project_id: string,
      producer: ProducerId,
      filters?: QueryParams,
    ) =>
      this.getAsset<{ outputs: ToolOutput[]; dedup_known_count?: number }>(
        `/api/tools/bridge/sources/${encodeURIComponent(producer)}/outputs`,
        { ...(filters ?? {}), project_id },
      ),

    /**
     * POST /api/tools/bridge/drafts — create one or many drafts from outputs.
     * `project_id` is forced into the body even if the caller already
     * supplied one, to keep the route's scope check authoritative.
     *
     * For producer='coding', when the caller passes `coding_job_id` we
     * additionally send it as the `X-Coding-Job-Id` request header so the
     * backend's bridge source can resolve the output on a cache miss
     * (e.g. after a backend redeploy evicts the per-process LRU). The
     * header carries belt-and-suspenders alongside the body field.
     */
    createDrafts: (project_id: string, body: CreateDraftBody) => {
      const codingJobId =
        body.producer === 'coding' ? body.coding_job_id : undefined;
      const headers: Record<string, string> = {};
      if (codingJobId) headers['X-Coding-Job-Id'] = codingJobId;
      return this.post<{ data: CreateDraftsResponse }>(
        '/api/tools/bridge/drafts',
        { ...body, project_id },
        Object.keys(headers).length > 0 ? { headers } : undefined,
      ).then((envelope) => envelope.data);
    },

    /**
     * GET /api/tools/bridge/drafts — list THIS caller's drafts in a project.
     *
     * Without this, `/bridge` had no way to rehydrate: the page set
     * `drafts = []` on load and a refresh silently destroyed in-progress
     * bulk-review work.
     *
     * ⚠️ PATH — the whole block is now `/api/tools/...`, and it MUST stay that
     * way. Until 2026-09-26 every sibling here was spelled `/tools/...` and
     * none of them could reach the backend: the dev proxy
     * (`frontend/vite.config.ts`, `'^/api/'`) and the production server
     * (`frontend/server.js`, `req.url.startsWith('/api/')`) forward ONLY
     * `/api/*` to the Bun backend, and `buildUrl` prepends nothing (an
     * absolute endpoint discards the base's path), so `/tools/bridge/...`
     * resolved against the page origin and hit SvelteKit's own route tree
     * instead of `backend/src/routes/tools/bridge.ts` — which registers every
     * one of these under `/api/`. Do not drop the prefix.
     *
     * ⚠️ RETURNS A `ListPage`, not a bare array. `truncated` / `countState`
     * are the difference between "these are all your drafts" and "these are
     * the first N of at least N+1", and callers MUST surface a truncated page
     * as truncated. A read that fails REJECTS — it never resolves to an empty
     * list.
     *
     * ⚠️ THE SIGNAL IS IN HEADERS. The body is the sanctioned unpaginated-list
     * envelope `{ items }`;
     * `X-Truncated` / `X-Applied-Limit` / `X-Count-State` carry the rest. A
     * `{ items, total }` body was the alternative and is rejected on purpose:
     * this route runs no COUNT query, so `total` could only be `items.length`,
     * i.e. the page size presented as the match count.
     *
     * ⚠️ THE BODY IS DECODED, NOT CAST. `itemsEnvelope` throws
     * `ResponseShapeError` when the envelope is not the declared one, so a
     * backend that changed shape under us is LOUD. The `?? []` that would make
     * it quiet is exactly what `$lib/api/response-shape.ts` exists to delete.
     */
    listDrafts: async (
      project_id: string,
      opts?: { status?: string[]; limit?: number },
    ): Promise<ListPage<KanbanCardDraft>> => {
      // A holder object, not a `let`: TypeScript's control-flow analysis does
      // not see the assignment made inside the callback below, so a plain
      // `let res: Response | null = null` narrows to `null` for the rest of
      // this function and every header read below becomes an error on `never`.
      const captured: { res: Response | null } = { res: null };
      const body = await this.get<unknown>('/api/tools/bridge/drafts', {
        params: {
          project_id,
          ...(opts?.status && opts.status.length > 0
            ? { status: opts.status.join(',') }
            : {}),
          ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
        },
        captureResponse: (r) => {
          captured.res = r;
        },
      });
      const { items } = decodeBody(
        body,
        itemsEnvelope(record<KanbanCardDraft>({ id: str })),
        { endpoint: '/api/tools/bridge/drafts', method: 'GET', status: 200 },
      );
      // `captured.res` is assigned synchronously inside `request` before the
      // body is parsed, so it is set by the time we get here. The null branch
      // is the honest degrade for a test double or interceptor that never
      // produced a Response: no headers means no claim, i.e. `unknown`.
      const headers = captured.res?.headers ?? null;
      const rawLimit = headers?.get('X-Applied-Limit') ?? null;
      const parsedLimit = rawLimit === null ? NaN : Number(rawLimit);
      const rawState = headers?.get('X-Count-State') ?? null;
      return {
        items,
        truncated: headers?.get('X-Truncated') === 'true',
        appliedLimit: Number.isFinite(parsedLimit) ? parsedLimit : null,
        // ⚠️ Only the two literals the backend actually emits say anything.
        // Anything else — absent header, stripped header, an unrecognised
        // value from a future backend — is `unknown`, never `exact`.
        countState:
          rawState === 'exact'
            ? 'exact'
            : rawState === 'at_least'
              ? 'at_least'
              : 'unknown',
      };
    },

    /**
     * GET /api/tools/bridge/drafts/:id — fetch a single draft.
     */
    getDraft: (project_id: string, id: string) =>
      this.getAsset<KanbanCardDraft>(
        `/api/tools/bridge/drafts/${encodeURIComponent(id)}`,
        { project_id },
      ),

    /**
     * PATCH /api/tools/bridge/drafts/:id — edit title/body/target/assignee/labels.
     * Backend expects `{ project_id, patch }` (see handlePatchDraft).
     */
    patchDraft: (project_id: string, id: string, patch: PatchDraftBody) =>
      this.patch<{ data: KanbanCardDraft }>(
        `/api/tools/bridge/drafts/${encodeURIComponent(id)}`,
        { project_id, patch },
      ).then((envelope) => envelope.data),

    /**
     * POST /api/tools/bridge/drafts/:id/submit — submit for approval, fan out broadcast.
     */
    submitDraft: (
      project_id: string,
      id: string,
      idempotency_key?: string,
    ) =>
      this.postAsset<SubmitDraftResponse>(
        `/api/tools/bridge/drafts/${encodeURIComponent(id)}/submit`,
        idempotency_key
          ? { project_id, idempotency_key }
          : { project_id },
      ),

    /**
     * POST /api/tools/bridge/drafts/:id/reject — soft-delete with audit reason.
     */
    rejectDraft: (
      project_id: string,
      id: string,
      body?: RejectDraftBody,
    ) =>
      this.postAsset<{ ok: true; draft: KanbanCardDraft }>(
        `/api/tools/bridge/drafts/${encodeURIComponent(id)}/reject`,
        { ...(body ?? {}), project_id },
      ),

    /**
     * POST /api/tools/bridge/drafts/:id/commit — commit an approved draft to
     * Planka. Mirrors the new AG-UI `bridge.commit_draft` action; the
     * backend route already exists (see handleCommitDraft).
     */
    commitDraft: (project_id: string, id: string) =>
      this.postAsset<{ ok: true; draft: KanbanCardDraft }>(
        `/api/tools/bridge/drafts/${encodeURIComponent(id)}/commit`,
        { project_id },
      ),

    /**
     * GET /api/tools/bridge/links?producer=&stable_id=&project_id= — dedup lookup.
     */
    listLinks: (
      project_id: string,
      producer: ProducerId,
      stable_id: string,
    ) =>
      this.getAsset<{ links: BridgeLink[] }>('/api/tools/bridge/links', {
        producer,
        stable_id,
        project_id,
      }),
  };

  // ===========================================================================
  // SPEC 2 — SECRETS (me alias) + SCHEDULED TRIGGERS
  // ===========================================================================

  /**
   * /api/me/secrets — same shape as /api/secrets but scoped to
   * the current user. Use for SecretPicker in Spec 2 forms.
   */
  secretsMe = {
    /** List the current user's secrets via the /api/me/secrets alias. */
    listMine: () => this.get<ListResponse<Secret>>('/api/me/secrets'),
    /** Create a secret. Uses the existing /api/secrets POST. */
    create: (data: SecretCreate) => this.post<Secret>('/api/secrets', data),
  };

  scheduledTriggers = {
    /**
     * List scheduled triggers. When `project_id` is provided, scope to that
     * project; when omitted, the backend RBAC filter returns all rows visible
     * to the caller (used by the unified `/channels` global list).
     */
    list: (project_id?: string) =>
      this.get<ListResponse<ScheduledTrigger>>(
        project_id
          ? `/api/scheduled-triggers?project_id=${encodeURIComponent(project_id)}`
          : '/api/scheduled-triggers',
      ),

    /** Fetch a single scheduled trigger by id. */
    get: (id: string) =>
      this.get<ScheduledTrigger>(
        `/api/scheduled-triggers/${encodeURIComponent(id)}`,
      ),

    /**
     * List recent run-audit rows for a scheduled trigger.
     * Backend caps `limit` at 200 and defaults to 50.
     */
    listRuns: (id: string, opts: { limit?: number } = {}) =>
      this.get<ListResponse<ScheduledTriggerRun>>(
        `/api/scheduled-triggers/${encodeURIComponent(id)}/runs?limit=${opts.limit ?? 25}`,
      ),

    /** Create a new scheduled trigger. */
    create: (body: ScheduledTriggerCreate) =>
      this.post<ScheduledTrigger>('/api/scheduled-triggers', body),

    /** Patch an existing scheduled trigger by id. */
    update: (id: string, body: ScheduledTriggerUpdate) =>
      this.patch<ScheduledTrigger>(`/api/scheduled-triggers/${encodeURIComponent(id)}`, body),

    /** Delete a scheduled trigger by id. */
    remove: (id: string) =>
      this.delete<void>(`/api/scheduled-triggers/${encodeURIComponent(id)}`),

    /** Fire a trigger immediately (manual run). */
    runNow: (id: string) =>
      this.post<{ ok: boolean }>(`/api/scheduled-triggers/${encodeURIComponent(id)}/run-now`),
  };

  assetSecrets = {
    list: () => this.getAsset<{ secrets: Array<Record<string, unknown>>; total: number }>('/api/assets/secrets'),
    get: (secretId: string) =>
      this.getAsset<Record<string, unknown>>(`/api/assets/secrets/${encodeURIComponent(secretId)}`),
    create: (data: Record<string, unknown>) =>
      this.postAsset<Record<string, unknown>>('/api/assets/secrets', data),
  };

  // ===========================================================================
  // COMPATIBILITY METHODS (used by auth store)
  // ===========================================================================

  /** Alias for auth.me() — used by auth store */
  getCurrentUser() {
    return this.auth.me();
  }

  /** Get the API base URL */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** No-op — unified client reads token from auth store directly */
  setToken(_token: string): void {}

  /** No-op — unified client reads token from auth store directly */
  clearToken(): void {}

  /** Get current auth token */
  getToken(): string | undefined {
    return auth.getToken();
  }
}

// =============================================================================
// SINGLETON EXPORT
// =============================================================================

/**
 * Singleton instance of the Unified API Client
 * Import and use this throughout your application
 */
export const apiClient = new UnifiedApiClient();

/**
 * Export the class for custom instances (see README.md)
 */
export { UnifiedApiClient };

/**
 * Default export
 */
export default apiClient;
