// src/lib/stores/unsavedWork.ts
//
// A registry of "this surface is holding unsaved user input" probes, consulted
// by `switchTenant` before it rebuilds the document.
//
// WHY THIS EXISTS: the tenant switch used to be inert on 15 routes (see the
// defect note at the top of `actions/switchTenant.ts`); the fix makes staying on
// the same route reload the document. A reload discards half-filled forms, and
// before that fix the same click did nothing at all — so the fix opened a NEW
// way to lose work. This is the guard, and it is the smallest one that can be
// honest about the outcome.
//
// ⛔ WHY A REGISTRY AND NOT A PLAIN `beforeunload` LISTENER — read this before
// "simplifying" it away. `beforeunload` is genuinely fewer moving parts and the
// browser owns the dialog, but its ANSWER IS UNREACHABLE FROM SCRIPT: by the
// time it fires, `switchTenant` has already persisted the new tenant and issued
// the reload, so a user who clicks "Stay" lands in exactly the state this PR
// exists to abolish — tenant switched, nothing re-fetched, the old workspace's
// rows under the new workspace's name — and no code can detect it to undo it.
// A registry is consulted while the switch is still ours to cancel, so "no"
// means the selection is put back rather than half-applied.
//
// It is a plain module-level Map, not a rune: a probe is a FUNCTION evaluated at
// check time, so it always reads the caller's current state and nothing here
// needs to be reactive. Deliberately no `.svelte.ts` suffix — reactivity here
// would only invite someone to read this from a template.

/** Returns true while the registering surface holds input the user has not saved. */
export type UnsavedProbe = () => boolean;

const probes = new Map<string, UnsavedProbe>();

/**
 * Declare that `key`'s surface may hold unsaved input.
 *
 * @returns the unregister function — return it straight out of `onMount` so the
 *          probe dies with the component. A probe that outlives its component
 *          closes over dead state and blocks every later switch.
 */
export function registerUnsaved(key: string, isDirty: UnsavedProbe): () => void {
  probes.set(key, isDirty);
  return () => {
    // Only remove OUR entry: two mounts of the same route (a transition) would
    // otherwise have the outgoing one delete the incoming one's probe.
    if (probes.get(key) === isDirty) probes.delete(key);
  };
}

/** True if any registered surface reports unsaved input. */
export function hasUnsavedWork(): boolean {
  for (const isDirty of probes.values()) {
    try {
      if (isDirty()) return true;
    } catch {
      // ⛔ A throwing probe must NOT read as "clean". Fail closed: the cost of
      // being wrong here is one extra confirm the user can accept; the cost of
      // the other direction is silently destroying their work.
      return true;
    }
  }
  return false;
}

/** The prompt text. Exported so the test asserts the same string the user sees. */
export const DISCARD_PROMPT =
  'You have unsaved changes on this page. Switching workspace reloads it and will discard them. Switch anyway?';

/**
 * Ask the user whether to discard. Synchronous on purpose: `confirm` blocks the
 * event loop, so the caller's persist → ask → revert sequence cannot be
 * interleaved with a fetch that would pick up the half-applied tenant.
 *
 * @returns `true` to proceed. With no `confirm` available (SSR, a bare test env)
 *          we proceed: refusing there would restore the original defect — a
 *          switcher that does nothing — and no form state exists off-browser.
 */
export function confirmDiscardUnsaved(): boolean {
  // `globalThis.confirm`, not the bare identifier: the bare one is a ReferenceError
  // off-browser, and this module is imported by an action that also runs in SSR
  // and in the node-environment unit tests.
  if (typeof globalThis.confirm !== 'function') return true;
  return globalThis.confirm(DISCARD_PROMPT);
}

