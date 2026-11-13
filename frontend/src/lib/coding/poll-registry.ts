export interface PollRegistry {
  set: (key: string, fn: () => void) => void;
  clear: (key: string) => void;
  clearAll: () => void;
}

/**
 * Tiny named-interval registry. Used by the coding analysis page to track
 * per-job pollers so they can be cleared individually (terminal status) or
 * en masse (component teardown).
 */
export function createPollRegistry(intervalMs: number): PollRegistry {
  const handles = new Map<string, ReturnType<typeof setInterval>>();

  function clear(key: string): void {
    const h = handles.get(key);
    if (h) {
      clearInterval(h);
      handles.delete(key);
    }
  }

  function set(key: string, fn: () => void): void {
    clear(key);
    handles.set(key, setInterval(fn, intervalMs));
  }

  function clearAll(): void {
    for (const key of [...handles.keys()]) clear(key);
  }

  return { set, clear, clearAll };
}
