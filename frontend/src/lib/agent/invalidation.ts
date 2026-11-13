/**
 * fr-agui SPEC §5.3 / §13 P1c-b — the `state-invalidate` bus.
 *
 * Invalidation, not a patch: after a write the agent ran or parked (the NDJSON
 * `state-invalidate` event) or a confirm card's route answered (the
 * `invalidate` list in `POST /api/capabilities/:id/invoke`'s response), the
 * named resources are RAISED here and every view that renders one re-fetches.
 *
 * Resource keys are the backend's (agent/state-invalidate.ts):
 *   project:<id>    the cockpit / activeProject
 *   board:<id>      the project's board (kanbanStore)
 *   approvals:me    the caller's approvals / needs-you counts
 *   approvals:<id>  the project's sign-offs
 *   assets:<id>     the project's library tabs
 *
 * A subscriber names the exact keys it renders. Pure module state, no Svelte:
 * `onInvalidate` returns its own unsubscribe, which a component returns from its
 * `$effect` so nothing outlives its view.
 */

type Listener = (resource: string) => void;

const listeners = new Map<string, Set<Listener>>();

/** Subscribe to one or more exact resource keys. Returns the unsubscribe. */
export function onInvalidate(keys: string | readonly string[], cb: Listener): () => void {
	const list = typeof keys === 'string' ? [keys] : [...keys];
	for (const k of list) {
		let set = listeners.get(k);
		if (!set) listeners.set(k, (set = new Set()));
		set.add(cb);
	}
	return () => {
		for (const k of list) {
			const set = listeners.get(k);
			set?.delete(cb);
			if (set && set.size === 0) listeners.delete(k);
		}
	};
}

/** Accept only the backend's key shapes; anything else is ignored, never thrown on. */
const KEY_RE = /^(?:project|board|approvals|assets):[A-Za-z0-9_-]{1,64}$/;

/**
 * Raise the resources a write may have changed. Each listener runs once per
 * raise even when several of its keys are named. A listener that throws does
 * not stop the others.
 */
export function raiseInvalidate(resources: readonly unknown[] | null | undefined): string[] {
	const keys = [...new Set((resources ?? []).filter((r): r is string => typeof r === 'string' && KEY_RE.test(r)))];
	const called = new Set<Listener>();
	for (const k of keys) {
		for (const cb of listeners.get(k) ?? []) {
			if (called.has(cb)) continue;
			called.add(cb);
			try {
				cb(k);
			} catch (err) {
				console.warn('[state-invalidate] a subscriber failed', { resource: k, err });
			}
		}
	}
	return keys;
}

