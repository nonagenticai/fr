// src/lib/components/kanban/mutationFeedback.test.ts
//
// The ONE user-visible failure surface for kanban writes.
//
// Before this module every kanban mutation caller swallowed the store's rethrow
// with `catch (e) { console.error(e) }`. The optimistic update rolled back and
// the card silently snapped to its old value — the user's only clue was the
// snap-back itself. `kanbanStore.error` could not serve as the surface: both
// places that render it sit after an `{:else if kanbanStore.board}` arm, so
// neither is reachable while a board is loaded, i.e. never during a mutation.
//
// These tests pin the two halves that a future edit could quietly undo:
//   1. the sentence is human, and never renders `undefined`;
//   2. reporting a failure actually reaches the TOAST store — swapping
//      `toast.error(...)` back for a bare `console.error` fails here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { toast } from '$lib/stores/toast.svelte';
import {
  describeMutationFailure,
  describeBoardLoadFailure,
  reportMutationFailure,
} from './mutationFeedback';

const err = (status: number, message = 'upstream said no') =>
  Object.assign(new Error(message), { status });

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  toast.clear();
  // reportMutationFailure keeps a console.error for diagnostics; silence it so
  // a green run stays readable, but assert it still happens (below).
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  toast.clear();
});

describe('describeMutationFailure', () => {
  it('names the action the user attempted, not the endpoint', () => {
    expect(describeMutationFailure('rename the card', err(500, 'Internal Server Error'))).toBe(
      "Couldn't rename the card: Internal Server Error",
    );
  });

  it('403/401 → a permission sentence rather than the raw upstream noise', () => {
    expect(describeMutationFailure('move the card', err(403, 'Forbidden'))).toBe(
      "Couldn't move the card: you do not have permission",
    );
    expect(describeMutationFailure('move the card', err(401, 'Unauthorized'))).toContain(
      'you do not have permission',
    );
  });

  it('404 → the entity is gone upstream', () => {
    expect(describeMutationFailure('delete the task', err(404))).toBe(
      "Couldn't delete the task: it no longer exists upstream",
    );
  });

  it('409 → a concurrent-edit sentence (the user can retry meaningfully)', () => {
    expect(describeMutationFailure('save the description', err(409))).toContain(
      'someone else changed it first',
    );
  });

  it('status 0 (client-side network/timeout wrapper) and 5xx → Planka unreachable', () => {
    for (const status of [0, 502, 503, 504]) {
      expect(describeMutationFailure('add the card', err(status, ''))).toBe(
        "Couldn't add the card: the board service is unreachable",
      );
    }
  });

  it('an error carrying nothing at all still reads as a sentence, never "undefined"', () => {
    // A thrown string, a thrown null, a bare Error — the failure surface must
    // survive all of them: this is the path a genuinely unexpected bug takes.
    for (const thrown of [undefined, null, 'boom', {}, new Error('')]) {
      const out = describeMutationFailure('post the comment', thrown);
      expect(out).toBe("Couldn't post the comment: unexpected error");
      expect(out).not.toContain('undefined');
    }
  });
});

describe('reportMutationFailure', () => {
  it('raises an ERROR toast carrying the sentence — the only surface the user sees', () => {
    reportMutationFailure('rename the card', err(500, 'Internal Server Error'));

    const raised = toast.items;
    expect(raised).toHaveLength(1);
    expect(raised[0].type).toBe('error');
    expect(raised[0].message).toBe("Couldn't rename the card: Internal Server Error");
  });

  it('also keeps the raw error in the console for diagnostics', () => {
    const boom = err(500, 'Internal Server Error');
    reportMutationFailure('move the card', boom);

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][1]).toBe(boom);
  });

  it('returns the message it showed, so a caller can also pin it inline', () => {
    expect(reportMutationFailure('add the label', err(404))).toBe(
      "Couldn't add the label: it no longer exists upstream",
    );
  });

  it('two failures raise two toasts — a second failure is never swallowed', () => {
    reportMutationFailure('move the card', err(500, 'a'));
    reportMutationFailure('move the card', err(500, 'b'));
    expect(toast.items).toHaveLength(2);
  });
});

describe('describeBoardLoadFailure', () => {
  // A board that will not load is a persistent page state, so this one is
  // rendered in a banner rather than a toast. Same honesty requirements.
  it('404 → not found / not in this workspace', () => {
    expect(describeBoardLoadFailure(err(404))).toBe(
      'Board not found, or not reachable in your active workspace.',
    );
  });

  it('502/503/504 → Planka may not be deployed', () => {
    for (const status of [502, 503, 504]) {
      expect(describeBoardLoadFailure(err(status))).toContain('currently unavailable');
    }
  });

  // ⚠️ A 5xx ON THIS PATH IS NO LONGER NECESSARILY PLANKA. fr's Keycloak
  // boundary now answers 502 when the auth service itself is unreachable
  // (rather than 401'ing every user holding a valid token), so a banner that
  // names Planka unconditionally would send whoever reads it to the wrong
  // dashboard during a Keycloak outage.
  it('502 naming a DIFFERENT upstream names that service, not Planka', () => {
    const kcErr = {
      status: 502,
      data: { error: { code: 'UPSTREAM_UNREACHABLE', service: 'keycloak' } },
    };
    const sentence = describeBoardLoadFailure(kcErr);
    expect(sentence).toContain('keycloak');
    expect(sentence).toContain('currently unavailable');
    expect(sentence).not.toContain('Planka');
  });

  it('502 with no service named still falls back to the board service (unchanged behaviour)', () => {
    // The overwhelmingly common case on this path, and the reason the default
    // was not simply made generic: losing the specific name would degrade every
    // real Planka outage to say nothing useful.
    expect(describeBoardLoadFailure(err(502))).toContain('board service');
  });

  it('anything else quotes the upstream message', () => {
    expect(describeBoardLoadFailure(err(500, 'kanban proxy exploded'))).toBe(
      'kanban proxy exploded',
    );
  });

  it('a message-less failure still says something', () => {
    expect(describeBoardLoadFailure(undefined)).toBe('Failed to load board.');
    expect(describeBoardLoadFailure(err(500, ''))).toBe('Failed to load board.');
  });
});
