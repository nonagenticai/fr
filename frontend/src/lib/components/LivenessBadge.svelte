<!--
  LivenessBadge.svelte

  Visual indicator for kanban WebSocket liveness. Reads the latest heartbeat
  timestamp from `kanbanLiveness.svelte.ts` and re-derives a green/amber/red
  status every second so the label "Stale Ns" grows in real time even when
  no new frames arrive.

  Spec: docs/superpowers/specs/completed/2026-04-24-n8n-observability-kanban-liveness.md
    §"Frontend"  — green <20s, amber 20–60s, red >60s or socket closed
    §"Architecture decisions / Kanban liveness"

  Connecting state (added 2026-05-02 — see plans/2026-05-02-kanban-pageload.md):
    The backend pushes the first `kanban:heartbeat` ~15s after socket open,
    so without this state the badge sat on "Disconnected" (red) for the
    entire pre-first-heartbeat window. When the WebSocket is open but no
    heartbeat has stamped the ts yet, render "Connecting" (blue) instead.

  ⚠️ Connecting DEADLINE (added 2026-09-09):
    The 1s tick above was added so a stale connection could not show "Live"
    forever. The identical hole was left open on the other side: `connecting`
    had NO time bound at all. The WebSocket opens fine even when Planka is not
    deployed — the socket is to fr, not to Planka — so the first
    `kanban:heartbeat` never arrives, `lastHeartbeatTs` stays null, and the
    pill read "Connecting" indefinitely beside a banner saying the service was
    unavailable. `socketOpenedAtTs` (kanbanLiveness.svelte.ts) bounds it: past
    the deadline the badge goes red, exactly as a heartbeat that stops arriving
    does. Closing one direction of a hole and not the other is what produced
    two badges disagreeing on screen.

  Thresholds (with `now - lastHeartbeatTs = lagSeconds`):
    null + socketOpen=true, no open ts        → connecting (unbounded; caller
                                                supplied no deadline input)
    null + socketOpen=true, <=60s since open  → connecting
    null + socketOpen=true, >60s since open   → disconnected
    null + socketOpen=false                   → disconnected
    0..19                                     → live
    20..60                                    → stale  (label "Stale {n}s")
    >60                                       → disconnected
    future skew                               → clamped to 0 (treated as live)

  Why 60s for the connecting deadline, and not a new number: it is the SAME
  threshold the heartbeat path already uses for red (lag > 60s → disconnected),
  so both roads to "we have heard nothing for a minute" end in the same place.
  It is also ~4x the ~15s first-heartbeat latency the connecting state exists to
  cover, so a slow-but-healthy open is never falsely reddened.
-->
<script lang="ts" module>
  export type LivenessStatus = 'live' | 'stale' | 'disconnected' | 'connecting';

  export interface LivenessResult {
    status: LivenessStatus;
    lagSeconds: number;
    label: string;
  }

  /**
   * How long an open socket may sit with no heartbeat before the badge stops
   * claiming it is still connecting. Deliberately the SAME 60s the heartbeat
   * path uses for red — see the file header for why this is not a new number.
   */
  export const CONNECTING_DEADLINE_SECONDS = 60;

  // Pure derivation. Boundaries:
  //   lastHeartbeatTs === null && socketOpen === true  → connecting, but only
  //     while `now - socketOpenedAtTs <= CONNECTING_DEADLINE_SECONDS`; past
  //     that → disconnected. A null `socketOpenedAtTs` means the caller gave
  //     us no clock to measure against, so the old unbounded behaviour stands
  //     (that is a missing input, not a measurement of a healthy socket).
  //   lastHeartbeatTs === null && socketOpen === false → disconnected
  //   lagSeconds <  20         → live
  //   lagSeconds >= 20 && <= 60 → stale ("Stale {n}s")
  //   lagSeconds >  60         → disconnected
  //   future-clock-skew (now < lastHeartbeatTs) → lag clamped to 0 → live
  //
  // NB when `socketOpenedAtTs` is known, `lagSeconds` on the connecting /
  // deadline-expired branches reports SECONDS SINCE THE SOCKET OPENED, not a
  // heartbeat age — there is no heartbeat to age. It is the honest analogue
  // ("how long since we last had contact"); reporting 0 would assert freshness
  // nobody measured.
  export function computeLiveness(
    lastHeartbeatTs: number | null,
    now: number,
    socketOpen: boolean = false,
    socketOpenedAtTs: number | null = null,
  ): LivenessResult {
    if (lastHeartbeatTs === null) {
      if (socketOpen) {
        if (socketOpenedAtTs === null) {
          return { status: 'connecting', lagSeconds: 0, label: 'Connecting' };
        }
        const openSeconds = Math.max(0, Math.floor((now - socketOpenedAtTs) / 1000));
        if (openSeconds <= CONNECTING_DEADLINE_SECONDS) {
          return { status: 'connecting', lagSeconds: openSeconds, label: 'Connecting' };
        }
        return { status: 'disconnected', lagSeconds: openSeconds, label: 'Disconnected' };
      }
      return { status: 'disconnected', lagSeconds: 0, label: 'Disconnected' };
    }
    const lagSeconds = Math.max(0, Math.floor((now - lastHeartbeatTs) / 1000));
    if (lagSeconds < 20) {
      return { status: 'live', lagSeconds, label: 'Live' };
    }
    if (lagSeconds <= 60) {
      return { status: 'stale', lagSeconds, label: `Stale ${lagSeconds}s` };
    }
    return { status: 'disconnected', lagSeconds, label: 'Disconnected' };
  }
</script>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    getLastHeartbeatTs,
    getSocketOpen,
    getSocketOpenedAtTs,
  } from '$lib/ws/kanbanLiveness.svelte';

  // ⚠️ There are TWO components named LivenessBadge, with the same visual
  // language, measuring DIFFERENT subjects — this one (THIS browser tab's
  // kanban WebSocket heartbeat) and observability/LivenessBadge.svelte (fr's
  // SERVER-SIDE kanban WS subscriber pool, REST-polled every 30s and mounted in
  // the top bar). Neither lies; they answer different questions under labels
  // that did not say which. That is how "Live" and "Connecting" came to sit on
  // one screen. `subject` is the visible half of the fix — keep it short, it
  // renders inside a pill.
  let { subject = 'Board WS' }: { subject?: string } = $props();

  // Tick the local clock every 1s so the badge re-derives even when no new
  // heartbeats arrive (otherwise a stale connection would show "Live" forever
  // until something else triggered a reactive update).
  let now = $state(Date.now());
  let interval: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    interval = setInterval(() => {
      now = Date.now();
    }, 1000);
  });

  onDestroy(() => {
    if (interval !== null) clearInterval(interval);
  });

  let result = $derived(
    computeLiveness(getLastHeartbeatTs(), now, getSocketOpen(), getSocketOpenedAtTs()),
  );

  // Names the subject, the measurement, and — explicitly — what this badge is
  // NOT, because the ambiguity is with a specific other badge on the same page.
  let tooltip = $derived(
    result.status === 'connecting' || (result.status === 'disconnected' && getSocketOpen())
      ? `${subject}: ${result.label} — this browser tab's kanban board WebSocket, open ${result.lagSeconds}s with no heartbeat yet. Not the top-bar badge, which reports fr's server-side subscriber pool.`
      : `${subject}: ${result.label} — this browser tab's kanban board WebSocket, last heartbeat ${result.lagSeconds}s ago. Not the top-bar badge, which reports fr's server-side subscriber pool.`,
  );

  function badgeClass(status: LivenessStatus): string {
    switch (status) {
      case 'live':
        return 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] border-[var(--color-success)] dark:bg-[var(--color-success-bg)] dark:text-[var(--color-success)]';
      case 'stale':
        return 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border-[var(--color-warning-border)]';
      case 'connecting':
        return 'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] border-[var(--color-accent)]';
      case 'disconnected':
        return 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] border-[var(--color-danger-border)]';
    }
  }

  function dotClass(status: LivenessStatus): string {
    switch (status) {
      case 'live':
        return 'bg-[var(--color-success)]';
      case 'stale':
        return 'bg-[var(--color-warning)]';
      case 'connecting':
        return 'bg-[var(--color-accent)]';
      case 'disconnected':
        return 'bg-[var(--color-danger)]';
    }
  }
</script>

<span
  class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-medium {badgeClass(result.status)}"
  data-testid="liveness-badge"
  data-status={result.status}
  data-subject="tab-websocket"
  title={tooltip}
  aria-label={tooltip}
>
  <span class="inline-block w-2 h-2 rounded-full {dotClass(result.status)}"></span>
  <span class="opacity-70">{subject}</span>
  {result.label}
</span>
