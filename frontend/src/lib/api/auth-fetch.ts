import { ensureFreshToken, forceRefreshToken } from '$lib/services/keycloak';
import { reportApiFailure } from '$lib/telemetry/client-errors';
import { toast } from '$lib/stores/toast.svelte';
import { isHandledStateResponse } from './handled-state-codes';
import {
  ACTIVE_TENANT_NOT_PERMITTED_CODE,
  ACTIVE_TENANT_REFUSED_EVENT,
  ACTIVE_TENANT_UNVERIFIABLE_CODE,
  ACTIVE_TENANT_UNVERIFIABLE_MESSAGE,
  activeTenantRefusedMessage,
} from './active-tenant-refusal';

// Single source of truth for the active workspace id is the workspaces
// store (`$lib/stores/workspaces.svelte.ts`), which persists to this same
// localStorage key. Reading directly from localStorage here avoids a
// circular import — the store imports `authFetch`, so authFetch must not
// import the store.
const ACTIVE_TENANT_STORAGE_KEY = 'fr.active_tenant';

/** One toast per refused workspace id, not one per in-flight request. */
const refusedToasted = new Set<string>();
// Same once-per-workspace rule for the transient 503 retry message.
const unverifiableToasted = new Set<string>();

function clearActiveTenantId(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(ACTIVE_TENANT_STORAGE_KEY);
  } catch {
    // Storage unavailable — nothing persisted to clear.
  }
}

/**
 * Is this the refused-switch 403 (→ its `reason`, possibly undefined) or not
 * (`null`)? Reads a CLONE so the caller keeps the body.
 */
async function activeTenantRefusal(response: Response): Promise<{ reason: unknown } | null> {
  if (response.status !== 403) return null;
  try {
    const body = (await response.clone().json()) as { code?: unknown; reason?: unknown } | null;
    return body?.code === ACTIVE_TENANT_NOT_PERMITTED_CODE ? { reason: body.reason } : null;
  } catch {
    return null;
  }
}

/** Is this the 503 `active_tenant_unverifiable` (the switch target could not be checked)? */
async function isActiveTenantUnverifiable(response: Response): Promise<boolean> {
  if (response.status !== 503) return false;
  try {
    const body = (await response.clone().json()) as { code?: unknown } | null;
    return body?.code === ACTIVE_TENANT_UNVERIFIABLE_CODE;
  } catch {
    return false;
  }
}

function readActiveTenantId(): string | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const v = localStorage.getItem(ACTIVE_TENANT_STORAGE_KEY);
    return v ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether this exact request can be SENT A SECOND TIME without corrupting it.
 *
 * A `Request` object's body may already have been consumed by the first send,
 * and a streaming body cannot be re-read — replaying either would issue a
 * request with a silently empty body, which is worse than the 401 it is trying
 * to recover from. Every one of authFetch's ~114 call sites passes a string
 * path, so this excludes nothing that exists today; it is here so that the
 * retry cannot become a corrupt second write when one does.
 */
function canReplay(input: RequestInfo | URL, init: RequestInit): boolean {
  if (typeof input !== 'string' && !(input instanceof URL)) return false;
  const body = init.body;
  if (body === undefined || body === null) return true;
  if (typeof body === 'string') return true;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true;
  return false;
}

export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = await ensureFreshToken(30);

  // Whether this request carries a credential at all. `ensureFreshToken`
  // returns undefined when there is no session, and ALSO when it has already
  // started a top-level login redirect — in both cases the request below is
  // sent without an Authorization header and can only come back 401.
  //
  // That 401 is not an API failure; it is this wrapper's own doing. Reporting
  // it pollutes the exact instrument built to rank real production faults.
  // Measured on prod, window 2026-09-02T05:37Z -> 09-04T05:34Z: 30 such rows
  // across /api/cards, /api/approvals, /api/andon,
  // /api/me/notifications/unread-count and /api/tools/kanban/liveness, with
  // ZERO matching `integration_error` rows — none reached an upstream. They are
  // timer-driven pollers (navCounts, LivenessBadge, ActivityTray, AndonCord)
  // still firing while the user is logged out.
  //
  // ⚠️ The request is still SENT. An earlier version of this fix short-circuited
  // it — correct in principle (no endpoint behind this wrapper is public) but it
  // changed the contract every caller and ~40 existing tests rely on, for the
  // sake of one saved round trip on a logged-out page. Suppressing the false
  // telemetry is the whole defect; skipping the request was scope I did not need.
  const callerSuppliedAuth = headers.has('Authorization');
  const hasCredential = !!token || callerSuppliedAuth;

  if (token && !callerSuppliedAuth) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  // X-Active-Tenant override (Plan in-fr-there-are-jazzy-pine):
  // the request-context middleware honours this header for super-admins
  // (platform tenants or their own), ignores it for anyone else. Sending it
  // unconditionally is safe for a non-super-admin. A super-admin's REFUSED
  // switch is a 403 since fr row 14d — handled below.
  // fr row 14d: a super-admin whose STORED workspace is refused gets a 403
  // `active_tenant_not_permitted` — never a silent fallback to home. Only a
  // header THIS wrapper added from storage is ours to clear; a caller that
  // pinned the header (e.g. a procedure-lens queue) owns its own refusal.
  let headerFromStorage: string | undefined;
  if (!headers.has('X-Active-Tenant')) {
    const active = readActiveTenantId();
    if (active) {
      headers.set('X-Active-Tenant', active);
      headerFromStorage = active;
    }
  }

  // Per-user API data never goes through the browser HTTP cache. Measured live
  // 2026-10-30: one URL's cache entry stayed locked in a user's Chrome and
  // every plain GET /api/projects waited ~10 s for it (cache: 'no-store' ~65 ms).
  const cache = init?.cache ?? 'no-store';
  let response = await fetch(input, {
    ...init,
    cache,
    headers
  });
  // The headers of the LAST attempt actually sent (the 401 replay swaps them).
  let sentHeaders = headers;


  // ── One-shot recovery from a token the SERVER rejects ────────────────────
  //
  // `ensureFreshToken(30)` above refreshes only when THIS clock says the token
  // expires within 30s. When the server disagrees — clock skew, a resumed
  // laptop, a token that stopped being accepted — every subsequent request
  // 401s with `JWTExpired: "exp" claim timestamp check failed` and nothing
  // ever changes the token, because nothing here was listening to the 401.
  // Measured on prod 2026-09-10 (pod fr-859f796c55-kcv5j): 118 of 187
  // `GET /api/cards/<id>` in one hour, one every ~20s, UNBROKEN. A poller in
  // that state shows the user a frozen card and says nothing.
  //
  // So: force a refresh and send the request again — EXACTLY ONCE.
  //
  // ⛔ Bounded on purpose, and every clause is load-bearing:
  //   * `status === 401` only. A 5xx is not an auth problem and re-sending it
  //     doubles load on something already failing.
  //   * `!!token && !callerSuppliedAuth` — we only replace a credential WE
  //     minted. A credential-less 401 is this wrapper's own doing (see below),
  //     and a caller-supplied Authorization header is the caller's to manage.
  //   * `fresh !== token` — if the refresh handed back the same string, the
  //     token is not the problem; retrying with it would be a second identical
  //     request for nothing.
  //   * no loop, no counter, no recursion. A 401 that survives a genuine token
  //     refresh is a genuine authorization failure: it is returned to the
  //     caller and reported, so the surface can stop and SAY so. Callers must
  //     not hammer it — see `CardLive` in $lib/cards/cardLive.svelte.ts, which
  //     treats a 401 arriving here as terminal for exactly this reason.
  //
  // Re-sending a POST is safe in this one case specifically: fr rejects an
  // expired token in the auth middleware, BEFORE any route handler runs, so
  // the first attempt had no side effect to duplicate.
  if (
    response.status === 401 &&
    !!token &&
    !callerSuppliedAuth &&
    canReplay(input, init)
  ) {
    const fresh = await forceRefreshToken();
    if (fresh && fresh !== token) {
      // ⚠️ A SEPARATE Headers instance, never `headers.set(...)` on the one
      // above. `Headers` is mutable and was already handed to the first
      // `fetch`: mutating it in place edits, retroactively, the object that
      // request was made with. The live browser has already copied the headers
      // into the sent Request by then, so it changes nothing on the wire — but
      // it makes the two attempts indistinguishable to anything holding a
      // reference, and the first thing that holds one is a test that proves
      // the replay carried a DIFFERENT token. An assertion that cannot see
      // the difference between "replayed with a new token" and "never
      // replayed" is not a test of this branch, so the aliasing has to go.
      const replayHeaders = new Headers(headers);
      replayHeaders.set('Authorization', `Bearer ${fresh}`);
      response = await fetch(input, {
        ...init,
        cache,
        headers: replayHeaders
      });
      sentHeaders = replayHeaders;
    }
  }

  // ── A refused stored workspace: clear it, say so, and refetch from home ──
  //
  // The stored `fr.active_tenant` is stale (the account lost the grant, or the
  // workspace was never switchable). Clear it so no later request repeats the
  // refusal, tell the user WHY the workspace changed (a toast — the fallback
  // is VISIBLE), let the workspaces store fall back to home (event), and send
  // THIS request once more without the header so the caller gets home data
  // instead of an error. Bounded exactly like the 401 replay: once, and only
  // for a replayable request. Placed AFTER the 401 replay so a refused switch
  // that surfaces only on the token-refreshed attempt is handled too.
  const refusal = headerFromStorage ? await activeTenantRefusal(response) : null;
  if (headerFromStorage && refusal) {
    if (readActiveTenantId() === headerFromStorage) clearActiveTenantId();
    if (!refusedToasted.has(headerFromStorage)) {
      refusedToasted.add(headerFromStorage);
      // The copy follows the backend's `reason` (archived / unknown /
      // service_account / untrusted_session) and never names the tenant.
      toast.warning(activeTenantRefusedMessage(refusal.reason), 8000);
    }
    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent(ACTIVE_TENANT_REFUSED_EVENT, { detail: { tenantId: headerFromStorage } })
        );
      }
    } catch {
      // No window (SSR / test) — the cleared storage already does the job.
    }
    if (canReplay(input, init)) {
      const homeHeaders = new Headers(sentHeaders);
      homeHeaders.delete('X-Active-Tenant');
      response = await fetch(input, { ...init, cache, headers: homeHeaders });
    }
  }

  // ── The switch target could not be CHECKED (503 active_tenant_unverifiable) ──
  //
  // A transient backend blip, not a verdict: the stored workspace is KEPT (the
  // next request may well succeed) and the user is told to try again — once per
  // workspace until a request succeeds again. The caller still gets the 503.
  if (headerFromStorage && (await isActiveTenantUnverifiable(response))) {
    if (!unverifiableToasted.has(headerFromStorage)) {
      unverifiableToasted.add(headerFromStorage);
      toast.warning(ACTIVE_TENANT_UNVERIFIABLE_MESSAGE, 8000);
    }
  } else if (headerFromStorage && response.ok) {
    unverifiableToasted.delete(headerFromStorage);
  }

  // Client-side error sink. Hooked HERE — the one shared wrapper — rather than
  // at any of the ~114 call sites, so a new caller is covered by construction.
  // Only status/method/path leave the browser; never a header, cookie or body.
  // `hasCredential` gate: see above. A 401 to a request we knowingly sent with
  // no credential is not a finding. Every OTHER failure still reports —
  // including a 401 the SERVER returned to a request that DID carry one, which
  // is a real signal (expired session, revoked role, wrong audience) and must
  // never be suppressed.
  //
  // `response` here is the FINAL response. A 401 that the forced refresh above
  // recovered from is deliberately not reported: it was a stale token this
  // wrapper then fixed, so it is not an API failure, and one event per poll
  // tick per open tab would drown the instrument. A 401 that SURVIVED the
  // refresh still lands in the sink, which is the case worth ranking.
  //
  // A typed STATE the UI renders (`PROVIDER_NOT_ENABLED` / `PROVIDER_UNAVAILABLE`,
  // see ./handled-state-codes) is not a failure either and is not reported.
  if (
    !response.ok &&
    !(response.status === 401 && !hasCredential) &&
    !(await isHandledStateResponse(response))
  ) {
    reportApiFailure({
      path: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      status: response.status,
      method: (init.method ?? 'GET').toString(),
      statusText: response.statusText
    });
  }

  return response;
}
