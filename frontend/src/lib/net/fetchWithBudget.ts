// src/lib/net/fetchWithBudget.ts
//
// fetchWithBudget — a fetch wrapper that emits "still working" / "taking
// longer than usual" callbacks at soft and slow thresholds, and aborts at a
// hard timeout. Pure budget primitive: no retries, no backoff, no circuit
// breaker. The events are imperative callbacks; bring your own UX layer.
//
// Default fetchImpl is `authFetch` so callers automatically get bearer-token
// auth. Callers that must NOT attach the Keycloak bearer (the agent-session
// store, the BYOC page, the AG-UI stream client) pass the plain `fetch`.

import { authFetch } from '$lib/api/auth-fetch';

export interface BudgetEvents {
  /** Fires at softTimeoutMs (default 5_000). */
  onStillWorking?: () => void;
  /** Fires at slowTimeoutMs (default 30_000). */
  onTakingLonger?: () => void;
}

export interface BudgetOptions extends BudgetEvents {
  /** Milliseconds before onStillWorking fires. Default 5_000. */
  softTimeoutMs?: number;
  /** Milliseconds before onTakingLonger fires. Default 30_000. */
  slowTimeoutMs?: number;
  /** Milliseconds before the request is aborted with BudgetExceededError. Default 90_000. */
  hardTimeoutMs?: number;
  /** External AbortSignal (e.g. component unmount). Aborts our internal controller. */
  signal?: AbortSignal;
  /** Fetch implementation to use. Defaults to authFetch; pass plain `fetch` to skip the bearer. */
  fetchImpl?: typeof fetch;
}

export class BudgetExceededError extends Error {
  constructor(public readonly elapsedMs: number) {
    super(`Request exceeded ${elapsedMs}ms budget`);
    this.name = 'BudgetExceededError';
  }
}

const DEFAULT_SOFT_MS = 5_000;
const DEFAULT_SLOW_MS = 30_000;
const DEFAULT_HARD_MS = 90_000;

export async function fetchWithBudget(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: BudgetOptions = {},
): Promise<Response> {
  const {
    softTimeoutMs = DEFAULT_SOFT_MS,
    slowTimeoutMs = DEFAULT_SLOW_MS,
    hardTimeoutMs = DEFAULT_HARD_MS,
    signal: externalSignal,
    fetchImpl = authFetch,
    onStillWorking,
    onTakingLonger,
  } = options;

  const controller = new AbortController();

  // Chain external signal → internal controller. If the external signal is
  // already aborted, abort immediately with its reason.
  let externalAbortHandler: (() => void) | undefined;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalAbortHandler = () => controller.abort(externalSignal.reason);
      externalSignal.addEventListener('abort', externalAbortHandler);
    }
  }

  const timers: ReturnType<typeof setTimeout>[] = [];
  const scheduleEvent = (ms: number, cb: (() => void) | undefined) => {
    if (!cb || ms <= 0 || ms >= hardTimeoutMs) return;
    timers.push(
      setTimeout(() => {
        try {
          cb();
        } catch {
          // Swallow callback errors — budget primitive must not let UX bugs
          // poison the request promise.
        }
      }, ms),
    );
  };

  scheduleEvent(softTimeoutMs, onStillWorking);
  scheduleEvent(slowTimeoutMs, onTakingLonger);

  let hardTimedOut = false;
  const hardTimer = setTimeout(() => {
    hardTimedOut = true;
    controller.abort(new BudgetExceededError(hardTimeoutMs));
  }, hardTimeoutMs);
  timers.push(hardTimer);

  const cleanup = () => {
    for (const t of timers) clearTimeout(t);
    if (externalSignal && externalAbortHandler) {
      externalSignal.removeEventListener('abort', externalAbortHandler);
    }
  };

  try {
    const response = await fetchImpl(input, {
      ...(init ?? {}),
      signal: controller.signal,
    });
    return response;
  } catch (err) {
    if (hardTimedOut) {
      throw new BudgetExceededError(hardTimeoutMs);
    }
    // External abort (or any other error) — re-throw the abort reason if
    // available so callers can distinguish user-cancellation from a hard
    // budget exceedance.
    if (externalSignal?.aborted) {
      throw externalSignal.reason ?? err;
    }
    throw err;
  } finally {
    cleanup();
  }
}
