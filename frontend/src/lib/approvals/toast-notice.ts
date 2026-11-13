// src/lib/approvals/toast-notice.ts
//
// The one place a decision notice becomes a toast.
//
// ⛔ EXHAUSTIVE ON PURPOSE, and deliberately NOT `toast[notice.tone](...)`. The
// dynamic form typechecks as `any` and would keep compiling if a new tone were
// added with no matching toast level — silently falling through to `undefined`
// and throwing at the moment an operator most needs to be told something. The
// switch below is the thing that makes a new tone a COMPILE error.
//
// Kept out of `decision-callback.ts` so that module stays free of the runes
// store and can be unit-tested under the repo's node-env vitest.

import { toast } from '$lib/stores/toast.svelte';
import type { DecisionNotice } from './decision-callback';

export function toastDecisionNotice(notice: DecisionNotice): void {
  switch (notice.tone) {
    case 'success':
      toast.success(notice.message);
      return;
    case 'warning':
      toast.warning(notice.message);
      return;
    case 'error':
      // Longer than the 5s default: a stranded card is an instruction to go and
      // look at something, and the default duration is tuned for "saved".
      toast.error(notice.message, 12_000);
      return;
    case 'info':
      toast.info(notice.message);
      return;
  }
}
