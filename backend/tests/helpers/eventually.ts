// Bounded polling for eventually-consistent state.
//
// Some production paths deliberately do NOT await their side effects — the
// clearest example is `action-approvals.ts::requestActionApproval`, which fires
// `NotificationService.fanOutToUser` as a floating promise so notification
// fan-out cannot block the caller's request. The row it writes to
// `engagement_deliveries` is therefore eventually consistent: it exists a few
// milliseconds after the call returns, not before.
//
// A test that reads such a row immediately is not testing the seam, it is
// racing it. On a fast machine it wins ~always and looks deterministic; on a
// loaded CI runner it loses occasionally and reads as a flake.
//
// The correct fix is on the TEST side. Do NOT make the production code await
// the fan-out to make a test easier — that would change request latency and
// failure coupling in production to serve a test.
//
// Use `waitFor` to express "this becomes true shortly" without weakening the
// assertion: every original expectation still runs against the polled value,
// and a genuine regression (the row is never written) still fails — just with
// a clear timeout message instead of a confusing `Expected: >= 1`.

export interface WaitForOptions {
  /** Human-readable description of what is being awaited; used in the timeout message. */
  what: string;
  /** Total time to keep polling before giving up. */
  timeoutMs?: number;
  /** Delay between polls. */
  intervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_INTERVAL_MS = 50;
/** Timeout messages get truncated so a big row set cannot flood the CI log. */
const MAX_SNAPSHOT_CHARS = 500;

function snapshot(value: unknown): string {
  let text: string;
  try {
    // `bigint` is the one type JSON.stringify throws on, and Postgres int8
    // columns arrive as bigint. Falling back to String(rows) would print
    // "[object Object]" — destroying the diagnostic exactly when it is needed.
    text = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  } catch {
    text = String(value);
  }
  // JSON.stringify returns undefined for undefined/function values.
  if (typeof text !== 'string') text = String(value);
  return text.length > MAX_SNAPSHOT_CHARS
    ? `${text.slice(0, MAX_SNAPSHOT_CHARS)}… (truncated)`
    : text;
}

/**
 * Poll `read` until `isReady` accepts its result, then return that result.
 *
 * Reads once before sleeping, so a value that is already consistent costs
 * nothing. Throws a descriptive error on timeout — never returns a
 * not-ready value, so callers can assert on the result unconditionally.
 *
 * A throw from `read` or `isReady` is treated as "not ready yet" and retried
 * until the deadline, then rethrown. That is deliberate: the whole point of
 * this helper is surviving a loaded CI runner, and a loaded runner is exactly
 * where the shared `queryClient` pool hands out transient connection and
 * pool-timeout errors. Aborting the poll on the first such blip would
 * reintroduce the flake in a new costume. A genuine, permanent error still
 * surfaces — it is what gets rethrown when the budget runs out.
 */
export async function waitFor<T>(
  read: () => Promise<T>,
  isReady: (value: T) => boolean,
  opts: WaitForOptions,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  let last: T | undefined;
  let lastError: unknown;
  let sawValue = false;

  for (;;) {
    try {
      last = await read();
      sawValue = true;
      lastError = undefined;
      if (isReady(last)) return last;
    } catch (err) {
      lastError = err;
    }

    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const elapsed = Date.now() - startedAt;
  if (lastError !== undefined) {
    throw new Error(
      `[waitFor] gave up after ${elapsed}ms waiting for ${opts.what}; ` +
        `every attempt threw. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      { cause: lastError },
    );
  }
  throw new Error(
    `[waitFor] timed out after ${elapsed}ms waiting for ${opts.what}. ` +
      `Last observed value: ${sawValue ? snapshot(last) : '<never read>'}`,
  );
}
