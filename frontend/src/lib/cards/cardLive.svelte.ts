// src/lib/cards/cardLive.svelte.ts
//
// CardLive — the read + liveness state behind a card detail surface.
//
// ── Why this exists ───────────────────────────────────────────────────────
// Cards are the conveyor. A card detail view is watched by a human or by an
// agent in a seat while work moves through it, so two failures are equally
// unacceptable:
//
//   1. Showing data loaded minutes ago as though it were live. The card
//      detail route used to fetch exactly once, at mount, and never again —
//      so a watched card silently froze at whatever it said when opened.
//   2. Retrying forever in the background while the surface says nothing.
//      Measured on prod 2026-09-10 (pod fr-859f796c55-kcv5j): 118 of 187
//      `GET /api/cards/<id>` requests in one hour answered 401
//      (`JWTExpired: "exp" claim timestamp check failed`, `exp - iat = 300`),
//      one every ~20s, unbroken. Nothing on any screen said so; the only
//      place it existed was the pod log.
//
// So this type refreshes, and it STOPS AND SAYS SO. Every failure ends in a
// state the surface renders — never in silence, and never in an unbounded
// retry.
//
// ── The three exits ───────────────────────────────────────────────────────
//   'ok'       — fresh card; `lastUpdatedAt` moves.
//   'failed'   — transient (5xx, network). Counted. The previous card stays
//                on screen. After MAX_CONSECUTIVE_POLL_FAILURES in a row the
//                surface goes stale-visible (`liveError` set) and the caller
//                stops polling.
//   'terminal' — 404 (the card is gone) or 401 (genuinely unauthorized).
//                Stop immediately; retrying cannot change the answer.
//
// A 401 is terminal HERE because it is not the first thing that happened to
// it: `authFetch` force-refreshes the access token and replays the request
// once (see $lib/api/auth-fetch.ts). A 401 that survives that is an
// authorization verdict, not a stale token — so hammering it would be the
// defect above with extra steps.

import { authFetch } from '$lib/api/auth-fetch';
import type { CardDetail } from '$lib/cards/types';

/**
 * Consecutive transient failures tolerated before the surface stops claiming
 * to be live. Three ticks, not one: a single 502 during a rolling deploy is
 * not a lost connection, and blanking the card for it would be worse than the
 * staleness it reports.
 */
export const MAX_CONSECUTIVE_POLL_FAILURES = 3;

export type RefreshOutcome = 'ok' | 'failed' | 'terminal';

export class CardLive {
  /** Last successfully loaded card. Never cleared by a failure. */
  card = $state<CardDetail | null>(null);
  /** True until the first attempt settles, either way. */
  initialLoading = $state(true);
  /**
   * Fatal for the surface: there is no card to show and there never will be
   * on this id (404 / not authorized / the very first read failed).
   */
  error = $state<string | null>(null);
  /**
   * A card IS on screen but it is no longer being kept current. Rendered as a
   * banner over the card — this is the field that makes the failure visible
   * instead of leaving the user reading a frozen page.
   */
  liveError = $state<string | null>(null);
  /** Epoch ms of the last successful read; drives "as of …" in the banner. */
  lastUpdatedAt = $state<number | null>(null);
  /** Consecutive transient failures. Reset to 0 by any success. */
  consecutiveFailures = $state(0);
  /**
   * Nothing further will be attempted until a person asks. The caller stops
   * its poll on this; `resume()` is the only way back.
   */
  stopped = $state(false);

  async refresh(id: string): Promise<RefreshOutcome> {
    let res: Response;
    try {
      res = await authFetch(`/api/cards/${encodeURIComponent(id)}`);
    } catch (e) {
      return this.recordFailure(e instanceof Error ? e.message : 'failed to load');
    }

    if (res.ok) {
      try {
        this.card = (await res.json()) as CardDetail;
      } catch {
        // A 200 whose body will not parse is not transient — the same request
        // will produce the same unusable bytes — but it is also not an
        // authorization verdict. Count it, so a one-off truncated response
        // during a deploy does not tear down a working surface.
        return this.recordFailure('The card response could not be read.');
      }
      this.lastUpdatedAt = Date.now();
      this.consecutiveFailures = 0;
      this.liveError = null;
      this.error = null;
      this.stopped = false;
      this.initialLoading = false;
      return 'ok';
    }

    if (res.status === 401) {
      // authFetch already force-refreshed and replayed once. Still 401 ⇒ the
      // session genuinely may not read this card.
      return this.terminate(
        'Your session is no longer authorized to read this card. Sign in again to continue.'
      );
    }

    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return this.terminate(
        body?.error === 'board_not_found'
          ? `Card "${id}" exists but its board is missing.`
          : `Card "${id}" not found.`
      );
    }

    return this.recordFailure(`Failed to load card (HTTP ${res.status}).`);
  }

  /**
   * Operator-initiated restart after a visible stop. Bounded by construction:
   * it clears the stop state but issues nothing itself, so a retry only ever
   * happens because a person asked for one.
   */
  resume(): void {
    this.liveError = null;
    this.consecutiveFailures = 0;
    this.stopped = false;
  }

  private recordFailure(message: string): RefreshOutcome {
    this.consecutiveFailures += 1;
    this.initialLoading = false;
    // With no card yet, the failure IS the surface — show it immediately
    // rather than leaving a spinner up for three ticks. It is still only a
    // COUNTED failure: a 502 during a rolling deploy clears itself on the
    // next tick and `error` is nulled by the success.
    if (this.card === null) {
      this.error = message;
    }
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
      // The cap is the whole point: past here we stop and say so, rather than
      // retrying invisibly forever behind data the user reads as current.
      if (this.card !== null) this.liveError = message;
      this.stopped = true;
      return 'terminal';
    }
    return 'failed';
  }

  private terminate(message: string): RefreshOutcome {
    this.initialLoading = false;
    if (this.card === null) {
      this.error = message;
    } else {
      this.liveError = message;
    }
    this.stopped = true;
    return 'terminal';
  }
}
