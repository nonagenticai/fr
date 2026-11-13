// src/lib/detached-work.ts
//
// Fire-and-forget side effects (work a handler deliberately does NOT await, so a
// slow downstream never slows the caller) still finish LATER, in the same
// process. In production that is the point. In the test suite it is a
// leak: bun runs every file in one process, so a detached call started by one
// file resolves inside the NEXT file — measured on main 3189cd96, where the
// archive path's detached `GET /pm/projects?origin_project_id=…` landed in
// documents-delete's process-global `fetch` mock and made it count 2 calls.
//
// `trackDetached` keeps the promise visible; `drainDetachedWork` lets the
// test preload (tests/setup.ts afterEach) wait for every in-flight one before
// the next test starts. It never rejects: the caller's own `.catch` already
// reported the failure.

const inflight = new Set<Promise<unknown>>();

export function trackDetached<T>(work: Promise<T>): Promise<T> {
  const settled = work.then(
    () => undefined,
    () => undefined,
  );
  inflight.add(settled);
  void settled.then(() => inflight.delete(settled));
  return work;
}

/**
 * Await every tracked detached promise, including ones started while waiting.
 * Gives up after `timeoutMs` (returns false) rather than hanging on a call
 * that never settles — and FORGETS what it gave up on. Kept, a promise that
 * never settles would cost every later drain its full bound: on fr#1490 one
 * deliberately hung test POST made each of ~360 later tests wait 5s and the
 * job hit its time limit.
 */
export async function drainDetachedWork(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (inflight.size > 0) {
    const left = deadline - Date.now();
    if (left <= 0) {
      inflight.clear();
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...inflight]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, left);
      }),
    ]);
    clearTimeout(timer);
  }
  return true;
}
