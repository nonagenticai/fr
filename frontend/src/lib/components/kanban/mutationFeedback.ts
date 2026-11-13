// src/lib/components/kanban/mutationFeedback.ts
//
// ONE user-visible failure surface for every kanban write.
//
// Why this module exists
// ----------------------
// `kanbanStore` mutations are optimistic: on failure they roll the optimistic
// update back and RETHROW (see kanbanStore.svelte.ts updateCard/moveCard/…).
// Every caller used to swallow that rethrow with a bare `catch (e) {
// console.error(e) }`, so a rejected PATCH was invisible: the card silently
// snapped back to its old value and nothing told the user why.
//
// `kanbanStore.error` cannot serve as that surface — the two places that render
// it (KanbanProjectPanel, BoardView) both sit AFTER an `{:else if
// kanbanStore.board}` arm, so neither is reachable while a board is loaded,
// i.e. never during a mutation. `hooks.client.ts handleError` never sees a
// rejection that was caught inside an event handler either.
//
// So: `<Toast />` (globally mounted in routes/+layout.svelte, `role="alert"`).
// The `console.error` stays for diagnostics — the toast is the human half.

import { toast } from '$lib/stores/toast.svelte';

/** Statuses where the raw upstream message is noise, not information. */
function reasonFor(status: number | undefined, rawMessage: string): string {
  switch (status) {
    case 401:
    case 403:
      return 'you do not have permission';
    case 404:
      return 'it no longer exists upstream';
    case 409:
      return 'someone else changed it first';
    // status 0 is the client-side wrapper ApiError uses for a network failure
    // or a request timeout (unified-client.ts) — there is no server message.
    case 0:
    case 502:
    case 503:
    case 504:
      return 'the board service is unreachable';
    default:
      return rawMessage || 'unexpected error';
  }
}

/**
 * A sentence for a failed kanban write. Pure — unit-tested directly.
 *
 * `action` is an infinitive phrase naming what the user tried to do
 * ("rename the card"), so the result reads "Couldn't rename the card: …".
 */
export function describeMutationFailure(action: string, err: unknown): string {
  const e = err as { status?: unknown; message?: unknown; data?: unknown } | null | undefined;
  const status = typeof e?.status === 'number' ? e.status : undefined;
  // A move on another workspace's project board carries its own plain sentence.
  const data = (e?.data && typeof e.data === 'object' ? e.data : {}) as { code?: unknown; error?: unknown };
  if (data.code === 'move_workspace_mismatch' && typeof data.error === 'string' && data.error.trim()) return data.error;
  const rawMessage = typeof e?.message === 'string' ? e.message.trim() : '';
  return `Couldn't ${action}: ${reasonFor(status, rawMessage)}`;
}

/**
 * Report a failed kanban write: keep the raw error in the console for
 * diagnostics AND raise a toast so the user sees that the change did not stick.
 * Returns the message it showed (handy for tests + callers that also want to
 * pin it inline).
 */
export function reportMutationFailure(action: string, err: unknown): string {
  const message = describeMutationFailure(action, err);
  console.error(`[kanban] failed to ${action}`, err);
  toast.error(message);
  return message;
}

/**
 * A sentence for a failed BOARD LOAD, rendered in a page-level banner rather
 * than a toast (a board that will not load is a persistent page state, not a
 * transient one). Pure.
 */
export function describeBoardLoadFailure(err: unknown): string {
  const e = err as { status?: unknown; message?: unknown; data?: unknown } | null | undefined;
  const status = typeof e?.status === 'number' ? e.status : undefined;
  if (status === 404) return 'Board not found, or not reachable in your active workspace.';
  if (status === 502 || status === 503 || status === 504) {
    // ⚠️ A 5xx HERE IS NOT NECESSARILY PLANKA. This branch keyed on the STATUS
    // and named Planka unconditionally, which was true while Planka was the only
    // upstream that answered 502 on this path. It no longer is: a Keycloak
    // outage now maps to 502 as well (rather than 401'ing every user holding a
    // valid token), so an unconditional sentence here would confidently blame
    // the wrong service — and a banner naming the wrong dependency sends whoever
    // reads it to the wrong dashboard.
    //
    // fr's integration errors carry the failing service in the body
    // (`{ error: { code, message, service } }`), so name it only when it says so.
    const body = e?.data as { error?: { service?: unknown } } | undefined;
    const service = typeof body?.error?.service === 'string' ? body.error.service : undefined;
    if (service === 'planka' || service === undefined) {
      return 'The board service is currently unavailable. It may not be deployed or is experiencing issues.';
    }
    return `The ${service} service is currently unavailable. It may not be deployed or is experiencing issues.`;
  }
  const rawMessage = typeof e?.message === 'string' ? e.message.trim() : '';
  return rawMessage || 'Failed to load board.';
}
