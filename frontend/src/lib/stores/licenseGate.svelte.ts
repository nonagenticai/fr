// src/lib/stores/licenseGate.svelte.ts
//
// Authoritative, app-scoped LICENSE GATE for the fr/kag products — the single
// source of truth for "is this workspace's license valid, expiring, or
// blocked?". Fed by the backend `GET /api/license/status` (which derives the
// real state from the licenses service: active / expiring_soon / expired /
// revoked / none, plus the expiry date).
//
// The backend is the real enforcer (every gated route 403s `fr_license_required`
// when missing/expired). This store lets the SPA render an accurate experience
// on top of that: a hard-block renewal screen for expired/revoked/none, and a
// non-blocking "expiring soon" banner — instead of a broken shell or raw error
// toasts.
//
// Two signals feed it:
//   1. A polled GET /api/license/status (on login + on an interval/visibility).
//   2. `handleForbidden()` — called by the API client when ANY request returns
//      403 `fr_license_required`, so a mid-session expiry blocks immediately
//      even before the next poll.
//
// This is the ONLY license model in the app. The legacy demo layer
// (`stores/license.svelte`, `services/license.ts`, `components/LicenseStatus`,
// `components/LicenseProtectedFeature`, `guards/license-guard`) and the old
// `auth.license`/`getUserLicense` path were removed — they read a list-shaped
// API as a single object (silently producing garbage/NaN) and modelled
// fictional free/pro/enterprise tiers. The KagShell badge + dashboard license
// card now read THIS gate.

import { goto } from '$app/navigation';
import { authFetch } from '$lib/api/auth-fetch';

export type LicenseGateState =
  | 'active'
  | 'expiring_soon'
  | 'expired'
  | 'revoked'
  | 'none'
  | 'unknown';

export interface LicenseStatusResponse {
  appKey: string;
  gateEnabled: boolean;
  hasLicense: boolean;
  state: LicenseGateState;
  expiresAt: string | null;
  daysRemaining: number | null;
  planCode: string | null;
}

const BLOCKED_STATES: ReadonlySet<LicenseGateState> = new Set([
  'expired',
  'revoked',
  'none',
]);

export class LicenseGate {
  status = $state<LicenseStatusResponse | null>(null);
  isLoading = $state(false);
  /** Set when a live request returned 403 fr_license_required (mid-session). */
  forcedBlocked = $state(false);
  lastChecked = $state<Date | null>(null);

  state = $derived<LicenseGateState>(this.status?.state ?? 'unknown');
  expiresAt = $derived<string | null>(this.status?.expiresAt ?? null);
  daysRemaining = $derived<number | null>(this.status?.daysRemaining ?? null);
  planCode = $derived<string | null>(this.status?.planCode ?? null);

  /** Expiring within the warning window — show a non-blocking banner. */
  isExpiringSoon = $derived(this.state === 'expiring_soon');

  /**
   * The workspace holds a usable license (entitled). `expiring_soon` is still
   * valid (the app stays usable); `unknown` is treated as valid so a transient
   * licenses blip never flips a badge to "invalid" — the 403 path is the real
   * enforcer. Only the terminal blocked states are "not valid".
   */
  isValid = $derived(this.state === 'active' || this.state === 'expiring_soon' || this.state === 'unknown');

  /**
   * Hard-block the UI: a 403 was seen, OR the polled state is a terminal
   * non-entitled state. `unknown` (transient upstream error) does NOT block —
   * the per-request 403 path is the backstop, so a licenses blip can't lock
   * out an entitled user.
   */
  isBlocked = $derived(this.forcedBlocked || BLOCKED_STATES.has(this.state));

  /** Human-readable reason, used by the block screen. */
  get statusMessage(): string {
    switch (this.state) {
      case 'expired':
        return this.expiresAt
          ? `Your license expired on ${formatDate(this.expiresAt)}.`
          : 'Your license has expired.';
      case 'revoked':
        return 'Your license has been revoked.';
      case 'none':
        return 'No active license for this workspace.';
      case 'expiring_soon':
        return this.daysRemaining != null
          ? `Your license expires in ${this.daysRemaining} day${this.daysRemaining === 1 ? '' : 's'}.`
          : 'Your license is expiring soon.';
      case 'active':
        return 'Your license is active.';
      default:
        return 'License status is temporarily unavailable.';
    }
  }

  /** Fetch the authoritative status. Never throws. */
  async load(): Promise<void> {
    this.isLoading = true;
    try {
      const res = await authFetch('/api/license/status');
      if (res.ok) {
        const body = (await res.json()) as LicenseStatusResponse;
        this.status = body;
        this.lastChecked = new Date();
        // A successful refresh that reports an entitled state clears a stale
        // forced-block (e.g. the license was just renewed).
        if (!BLOCKED_STATES.has(body.state)) {
          this.forcedBlocked = false;
        }
      }
      // Non-OK (e.g. 401 pre-auth) is left as-is; the route auth gate handles it.
    } catch {
      // Network error → leave prior state; do NOT hard-block on a transient blip.
    } finally {
      this.isLoading = false;
    }
  }

  async refresh(): Promise<void> {
    await this.load();
  }

  /**
   * Called by the API client on a 403 `fr_license_required`. Blocks the UI
   * immediately, then refreshes to resolve the precise reason (expired vs
   * revoked vs none) for an accurate message.
   */
  handleForbidden(): void {
    this.forcedBlocked = true;
    void this.load();
  }

  clear(): void {
    this.status = null;
    this.forcedBlocked = false;
    this.lastChecked = null;
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

/**
 * Where the "Renew" CTA points. Defaults to the in-app renew page; set
 * `VITE_LICENSE_RENEW_URL` (e.g. the future portal e-commerce URL) to redirect
 * renewals out of the app — one knob, ports to every frontend / n8n node.
 */
export const LICENSE_RENEW_URL: string =
  (import.meta.env.VITE_LICENSE_RENEW_URL as string | undefined) || '/license-upgrade';

/**
 * Send the user to the renewal destination. Absolute (`https://…`) OR
 * protocol-relative (`//host/…`) URLs → a full browser redirect (e.g. the
 * customer portal); anything else is treated as an in-app route. Centralized
 * here so every "Renew" CTA shares one correct implementation.
 */
export function navigateToRenew(): void {
  if (/^(https?:)?\/\//i.test(LICENSE_RENEW_URL)) {
    window.location.href = LICENSE_RENEW_URL;
  } else {
    void goto(LICENSE_RENEW_URL);
  }
}

export const licenseGate = new LicenseGate();
