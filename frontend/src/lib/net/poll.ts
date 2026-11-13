// src/lib/net/poll.ts
//
// usePoll — a polling primitive with exponential backoff on failure,
// visibility-pause, single-flight concurrency, and external-signal abort.
//
// Returns a handle (start/stop/isRunning) rather than running on construction
// so callers can wire it into the component lifecycle (onMount/onDestroy).
//
// Design notes:
// - Single-flight: never two `fn` calls in flight at once. If a timer fires
//   while fn is still running, the firing is skipped (the next tick is
//   scheduled when fn settles).
// - Exponential backoff doubles after each consecutive failure
//   (intervalMs * 2^attempt), capped at maxIntervalMs. A successful call
//   resets the attempt counter.
// - pauseWhenHidden: when document.visibilityState === 'hidden', timers
//   continue ticking but firings are skipped. On the visibilitychange event
//   to 'visible', any pending wait is cancelled and fn is invoked
//   immediately.
// - stop() and signal abort are idempotent and clear all timers + listeners.

export interface PollOptions {
  /** Base interval (after success). */
  intervalMs: number;
  /** Default 0 — fire once immediately, then wait intervalMs. */
  initialDelayMs?: number;
  /** Default 'exponential'. */
  backoff?: 'fixed' | 'exponential';
  /** Cap when backing off. Default 60_000. */
  maxIntervalMs?: number;
  /** Default Infinity — don't bail on consecutive failures by default. */
  maxAttempts?: number;
  /** Default true — uses document.visibilityState. */
  pauseWhenHidden?: boolean;
  /** External abort (e.g. component unmount). */
  signal?: AbortSignal;
}

export interface PollHandle {
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

const DEFAULT_MAX_INTERVAL_MS = 60_000;

export function usePoll<T>(
  fn: () => Promise<T>,
  opts: PollOptions,
): PollHandle {
  const {
    intervalMs,
    initialDelayMs = 0,
    backoff = 'exponential',
    maxIntervalMs = DEFAULT_MAX_INTERVAL_MS,
    maxAttempts = Infinity,
    pauseWhenHidden = true,
    signal,
  } = opts;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0; // consecutive failure count
  let inFlight = false;
  let visibilityHandler: (() => void) | null = null;
  let signalHandler: (() => void) | null = null;

  const hasDocument = typeof document !== 'undefined';

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function isHidden(): boolean {
    return pauseWhenHidden && hasDocument && document.visibilityState === 'hidden';
  }

  function computeWait(): number {
    if (attempt === 0) return intervalMs;
    if (backoff === 'fixed') return intervalMs;
    // exponential: intervalMs * 2^attempt, capped
    const wait = intervalMs * Math.pow(2, attempt);
    return Math.min(wait, maxIntervalMs);
  }

  async function fire(): Promise<void> {
    // Single-flight: if a previous call is still in flight, skip.
    if (inFlight) {
      schedule(intervalMs);
      return;
    }
    // If hidden, skip this firing and schedule the next one.
    if (isHidden()) {
      schedule(intervalMs);
      return;
    }
    if (!running) return;

    inFlight = true;
    try {
      await fn();
      attempt = 0;
    } catch {
      attempt += 1;
      if (attempt >= maxAttempts) {
        inFlight = false;
        stop();
        return;
      }
    } finally {
      inFlight = false;
    }
    if (running) {
      schedule(computeWait());
    }
  }

  function schedule(delayMs: number): void {
    clearTimer();
    if (!running) return;
    timer = setTimeout(() => {
      timer = null;
      void fire();
    }, delayMs);
  }

  function onVisibilityChange(): void {
    if (!running) return;
    if (!hasDocument) return;
    if (document.visibilityState === 'visible') {
      // Resume: cancel pending wait and fire immediately (unless already in
      // flight — in which case the in-flight finally{} will reschedule).
      if (!inFlight) {
        clearTimer();
        void fire();
      }
    }
  }

  function onAbort(): void {
    stop();
  }

  function start(): void {
    if (running) return;
    running = true;
    attempt = 0;
    inFlight = false;

    if (pauseWhenHidden && hasDocument) {
      visibilityHandler = onVisibilityChange;
      document.addEventListener('visibilitychange', visibilityHandler);
    }
    if (signal) {
      if (signal.aborted) {
        // Mirror stop() but synchronous; no need to add listener.
        running = false;
        clearTimer();
        if (visibilityHandler && hasDocument) {
          document.removeEventListener('visibilitychange', visibilityHandler);
          visibilityHandler = null;
        }
        return;
      }
      signalHandler = onAbort;
      signal.addEventListener('abort', signalHandler);
    }

    schedule(initialDelayMs);
  }

  function stop(): void {
    if (!running && timer === null && !visibilityHandler && !signalHandler) {
      // Idempotent — nothing to clean up.
      return;
    }
    running = false;
    clearTimer();
    if (visibilityHandler && hasDocument) {
      document.removeEventListener('visibilitychange', visibilityHandler);
      visibilityHandler = null;
    }
    if (signalHandler && signal) {
      signal.removeEventListener('abort', signalHandler);
      signalHandler = null;
    }
  }

  function isRunning(): boolean {
    return running;
  }

  return { start, stop, isRunning };
}
