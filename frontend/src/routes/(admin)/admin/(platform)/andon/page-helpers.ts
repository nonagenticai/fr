// page-helpers.ts — pure logic for the andon-cord super-admin page.

import {
  andonLiveness,
  andonPauseAttempt,
  andonVerdict,
  liveProbeAgeLabel,
  pauseEvidenceWorkerReplicasLabel,
  workerReplicasLabel,
  type AndonGlobalState,
} from '$lib/components/andon-cord-helpers';

// Re-export so the page imports every andon type from one place.
export type {
  AndonGlobalState,
  AndonLiveProbe,
  AndonPauseEvidence,
  AndonVerdict,
} from '$lib/components/andon-cord-helpers';

export interface AndonProject {
  id: string;
  name: string;
  shape: 'deliverable' | 'continuous_flow';
  andon_engaged: boolean;
  andon_engaged_at: string | null;
  andon_engaged_by: string | null;
}

export interface AndonStream {
  id: string;
  name: string;
  kind: 'workflow' | 'prompt';
  tenant_id: string;
  andon_engaged: boolean;
  andon_engaged_at: string | null;
  andon_engaged_by: string | null;
}

export interface AndonState {
  projects: AndonProject[];
  streams: AndonStream[];
}

export function totalEngaged(state: AndonState): number {
  return (
    state.projects.filter((p) => p.andon_engaged).length +
    state.streams.filter((s) => s.andon_engaged).length
  );
}

export function summary(state: AndonState): string {
  const engaged = totalEngaged(state);
  const total = state.projects.length + state.streams.length;
  return `${engaged} of ${total} engaged`;
}

/** Format a possibly-null ISO timestamp for display. Returns em-dash for null. */
export function formatEngagedAt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

/**
 * Headline + tone for the GLOBAL andon cord panel on this page. The global cord
 * is the hard system-wide stop (scales the `n8n-worker` Deployment to 0);
 * released is the safe state for the CORD — but the panel still has to state
 * what the worker is doing, because a released cord whose scale-up never landed
 * leaves automatic execution stopped.
 *
 * ⚠️ CORRECTED 2026-09-23 — this paragraph used to read "`null` (not loaded /
 * read failed) reads as released so the panel never falsely implies a halt."
 * That was the FINDING, stated as if it were the design: reading `null` as
 * released is exactly how a page holding no cord state came to print a green
 * "✓ Running". `null` now lands in the UNREADABLE branch below; see the comment
 * there, and `andonVerdict` in lib/components/andon-cord-helpers.ts. The
 * fail-open bias it was defending still exists — in the BACKEND, which keeps
 * surfacing `engaged: false` so production runs when the switch is broken.
 *
 * Tone is one of THREE values and the page must render three; see
 * {@link ANDON_TONE_SURFACE}.
 *
 * ⚠️ The released `detail` used to read "All automation active — no global halt
 * in effect." UNCONDITIONALLY. That is a claim about ALL automation, and this
 * same page renders "🛑 N surfaces currently halted" a few hundred pixels below
 * it from the per-project/per-stream cords — so with the global cord released
 * and 18 per-surface cords engaged, the page asserted both. The two SCOPES are
 * legitimately different (global = n8n-wide hard stop; per-surface = fr-side
 * scheduled-trigger/report/suggestion stop on one target); the over-claiming
 * wording was not. `engagedSurfaces` is the per-surface engaged count
 * (`totalEngaged`) so the released panel can state BOTH facts, and `null`/
 * `undefined` — the per-scope read has not landed or failed — falls back to a
 * statement about the global cord ONLY, never about "all automation".
 *
 * ⭐ AND SINCE THE ACTUATOR CHANGE, a released cord alone is not enough to say
 * "Running": `worker_replicas` decides whether the line is actually executing.
 * 0 → STOPPED (danger), null → NOT MEASURED (warn), 1 → running (ok).
 */
/**
 * ⭐ THE ONE SENTENCE THIS FUNCTION EXISTS TO RATION.
 *
 * "halts all new work system-wide" is a claim about the whole estate, and it is
 * only true when all three axes agree: a human engaged the cord, the scale
 * LANDED, and a live probe measured `n8n-worker` at 0 replicas. It may appear in
 * exactly one branch below — STOPPED_CONFIRMED. If you are adding a branch, do
 * not copy it.
 */
const SYSTEM_WIDE_HALT_CLAIM = 'halts all new work system-wide.';

/**
 * The three tones this panel can compute. Declared as ONE type used by both the
 * status shape and {@link ANDON_TONE_SURFACE} / {@link ANDON_TONE_TEXT}, so a
 * tone can never exist in the logic without a class to render it in.
 */
export type AndonTone = 'ok' | 'warn' | 'danger';

export function globalCordStatus(
  state: AndonGlobalState | null,
  engagedSurfaces?: number | null,
): {
  tone: AndonTone;
  label: string;
  detail: string;
  /**
   * The second line: what independently CHECKED the claim above, or `null` when
   * there is nothing to verify (a released cord). Rendered as
   * `data-testid="andon-global-verification"`.
   */
  verification: { tone: AndonTone; text: string } | null;
} {
  const verdict = andonVerdict(state);

  // The cord state could not be read. This used to be indistinguishable from
  // "released": the backend's `!row` branch reported engaged:false and the page
  // printed "✓ Running" over a cord whose state is genuinely unknown.
  //
  // ⭐ TWO CAUSES, ONE EPISTEMIC STATE, and the difference between them is a
  // fact about where to look, not about automation health:
  //   • `state === null` — this page holds NO payload at all. The GET in
  //     `loadGlobal()` (+page.svelte) has not landed yet, or it threw/returned
  //     non-2xx; the reason is kept in that file's `globalError` and rendered as
  //     its own `role="alert"` line under this panel, so the cause is not lost
  //     by being left out of the sentence below.
  //   • a payload carrying `intent: 'unreadable'` — the request reached a
  //     healthy backend that could not read the singleton row (grep
  //     `intent: 'unreadable'` in backend/src/routes/andon.ts).
  // ⚠️ `andonVerdict(null)` returned 'RUNNING' until 2026-09-23, so the FIRST of
  // those two rendered here as a green "✓ Running / All automation active": a
  // page that knew nothing told the operator every automation was healthy. Both
  // now get the identical non-committal label and tone — an operator must not
  // have to read the fine print to find out we are guessing — and only the
  // detail sentence differs, naming which read failed.
  if (verdict === 'UNREADABLE') {
    const unread = state === null;
    return {
      tone: 'warn',
      label: '⚠ UNKNOWN',
      detail: unread
        ? 'No global cord state has been read — the read has not landed, or it failed. This is NOT a statement that work is running. Treat the halt status as unknown until the read recovers.'
        : 'The global cord state could not be read — this is NOT a statement that work is running. Treat the halt status as unknown until the read recovers.',
      verification: {
        tone: 'warn',
        text: unread
          ? 'Not verified — no cord state reached this page, so nothing here has been checked against n8n.'
          : 'Not verified — the cord state row could not be read, so nothing here has been checked against n8n.',
      },
    };
  }

  if (verdict === 'RUNNING') {
    const released = state as AndonGlobalState;
    const worker = released.worker_replicas ?? null;
    const n = engagedSurfaces ?? null;
    const surfaces = n === null
      ? ''
      : n > 0
        ? ` — but ${n} surface${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} halted individually below.`
        : '';
    // ⛔ A RELEASED CORD IS NOT A RUNNING LINE. `release_status: 'released'`
    // only means the scale-up was ACCEPTED; the pod still has to start. If the
    // last measurement says 0, automatic execution is STILL STOPPED even though
    // the brake is off, and the panel must say so instead of "✓ Running".
    if (worker === 0) {
      return {
        tone: 'danger',
        label: '⚠ STOPPED',
        detail: `The cord is released, but n8n-worker is at 0 replicas — automatic execution is STOPPED.${surfaces}`,
        verification: {
          tone: 'danger',
          text: 'Not verified against a live probe — this is the replica count fr last recorded when the cord was released. Release again, or scale n8n-worker to 1 by hand.',
        },
      };
    }
    // ⛔ `null` is NOT 0 and NOT "running": fr holds no measurement of the
    // worker, so the honest statement is that the execution state is unknown.
    if (worker === null) {
      return {
        tone: 'warn',
        label: '⚠ UNKNOWN',
        detail: `No global halt is recorded, but the n8n-worker replica count is NOT MEASURED — the execution state is unknown. This is NOT a statement that work is running.${surfaces}`,
        verification: {
          tone: 'warn',
          text: 'Not verified — fr holds no measurement of n8n-worker, so nothing here has been checked.',
        },
      };
    }
    let detail: string;
    if (n === null) {
      detail = 'No global halt in effect.';
    } else if (n > 0) {
      detail = `No global halt in effect — but ${n} surface${n === 1 ? '' : 's'} ${
        n === 1 ? 'is' : 'are'
      } halted individually below.`;
    } else {
      detail = 'All automation active — no global halt in effect.';
    }
    // ⛔ SCALED UP IS NOT SERVING. `spec.replicas: 1` is true the instant the
    // release PATCH is accepted, but the replacement pod still has to start — and
    // with `strategy: Recreate` on a ReadWriteOnce volume it cannot start until a
    // draining pod is gone. When a live probe reports 0 Ready this must not render
    // as "✓ Running": that is exactly the window in which an operator believes
    // execution resumed and it has not. `undefined` = not probed, so the ordinary
    // (non-live) render is unchanged.
    const readyReplicas = released.n8n_live?.available_replicas;
    if (readyReplicas === 0) {
      return {
        tone: 'warn',
        label: '… STARTING',
        detail: `The cord is released and n8n-worker is scaled to 1, but no worker pod is Ready yet — execution resumes when one is.${surfaces}`,
        verification: {
          tone: 'warn',
          text: 'Not yet verified — the last live probe found 0 available worker replicas.',
        },
      };
    }
    return {
      tone: 'ok',
      label: '✓ Running',
      // The measurement is named, not implied: this is the last recorded
      // replica count, and calling it out is what keeps "Running" a statement
      // about a reading rather than an assumption.
      detail: `${detail} n8n-worker at ${worker} replica${worker === 1 ? '' : 's'} (running).`,
      verification: null,
    };
  }

  // ---- Engaged, in one of four flavours. ----
  //
  // ⭐ The LABEL stays "🛑 STOPPED" for all four, and the toggle keeps reading
  // "Disengage". The cord IS pulled in every one of them; what differs is
  // whether the pull reached n8n. Demoting the label would tell an operator the
  // line is running while fr is frozen — a different and worse lie.
  const engaged = state as AndonGlobalState;
  const label = '🛑 STOPPED';

  if (verdict === 'CONTRADICTED') {
    const live = engaged.n8n_live!;
    const worker = live.worker_replicas;
    // `CONTRADICTED` requires a measured positive count, so this is a number —
    // but the guard keeps "not measured" from ever printing as 0.
    const shown = worker === null || worker === undefined ? 'an unmeasured number of' : `${worker}`;
    const suffix = worker === 1 ? '' : 's';
    // ⭐ WHEN the contradiction was measured. A replica count is a claim about a
    // moment; without its age an operator cannot tell a contradiction observed
    // seconds ago from one observed before they pulled the cord again.
    const age = liveProbeAgeLabel(engaged.n8n_live);
    return {
      tone: 'danger',
      label,
      detail: `Pulled locally — n8n-worker still reports ${shown} replica${suffix}; automatic execution is NOT stopped.`,
      verification: {
        tone: 'danger',
        text: `⚠ Contradicted — n8n-worker still reports ${shown} replica${suffix}${age ? ` (${age})` : ''}. Work can still run. Pull again, or scale n8n-worker to 0 by hand.`,
      },
    };
  }

  if (verdict === 'HALF_ENGAGED') {
    const failed = andonPauseAttempt(engaged) === 'failed';
    const why = failed
      ? `the n8n-worker scale did not land: ${engaged.n8n_pause?.error ?? 'unknown error'}`
      : 'no n8n-worker scale was ever recorded';
    // ⭐ THIS branch reads the replica count off the PAUSE EVIDENCE, not off the
    // top-level `worker_replicas` used by the other engaged flavours. Here the
    // number is the very thing in doubt, and the evidence block is the only
    // source that can say "nothing was measured" (`worker_replicas: null`)
    // instead of the number 0. Rendering `0` when nothing was recorded is the
    // absence-as-result defect; the other branches keep the top-level value,
    // which is the last measurement fr holds.
    const attempted = pauseEvidenceWorkerReplicasLabel(engaged.n8n_pause);
    return {
      tone: 'danger',
      label,
      detail: `${attempted} · app-side work is frozen, but ${why}. Pull again to retry the scale.`,
      verification: {
        tone: 'danger',
        text: failed
          ? `⚠ Half-engaged — fr is frozen but the n8n-worker scale FAILED: ${engaged.n8n_pause?.error ?? 'unknown error'}. Automatic execution may still be running. Pull again to retry the scale.`
          : '⚠ Half-engaged — fr is frozen but no n8n-worker scale was ever recorded. Automatic execution may still be running. Pull again to retry the scale.',
      },
    };
  }

  if (verdict === 'STOPPED_CONFIRMED') {
    // ⭐ THE AGE OF THE ONLY LINE ON THIS PAGE THAT CLAIMS VERIFICATION.
    // STOPPED_CONFIRMED is the sole branch allowed to carry
    // SYSTEM_WIDE_HALT_CLAIM, and it earns that from ONE live probe. A green
    // "✓ Verified" with no timestamp is a verification the operator cannot
    // date — it reads identically whether the worker was measured at 0 two
    // seconds ago or twenty minutes ago, and only one of those justifies
    // walking away from the line. `liveProbeAgeLabel` returns null only when
    // there is no probe, which this branch cannot reach (it requires liveness
    // 'stopped').
    const age = liveProbeAgeLabel(engaged.n8n_live);
    return {
      tone: 'danger',
      label,
      detail: `${workerReplicasLabel(engaged.n8n_live?.worker_replicas ?? null)} · ${SYSTEM_WIDE_HALT_CLAIM}`,
      verification: {
        tone: 'ok',
        text: `✓ Verified — n8n-worker independently reports 0 replicas${age ? ` (${age})` : ''}.`,
      },
    };
  }

  // STOPPED_UNVERIFIED — the cord is down and the scale landed as far as fr
  // knows, but nothing has checked the worker. Note what is MISSING from this
  // detail: the system-wide claim. An unmeasured halt is not a measured one.
  const liveness = andonLiveness(engaged);
  return {
    tone: 'danger',
    label,
    // The top-level value is the LAST MEASURED replica count, and it renders as
    // "NOT MEASURED" when there is none — never as 0.
    detail: `${workerReplicasLabel(engaged.worker_replicas)} · n8n has not confirmed the halt, so it is NOT verified.`,
    verification: {
      tone: 'warn',
      text:
        liveness === 'unmeasured'
          ? `Not verified — the n8n-worker scale could not be read${
              engaged.n8n_live?.error ? ` (${engaged.n8n_live.error})` : ''
            }, so the halt is unconfirmed. This is not the same as "the worker is running".`
          : 'Not verified — n8n-worker has not been re-checked, so the halt is unconfirmed.',
    },
  };
}

/**
 * Tone → Tailwind classes for the global-cord panel. THREE entries, because
 * {@link globalCordStatus} computes THREE tones.
 *
 * ⚠️ THE DEFECT THIS REPLACES (fixed 2026-09-23): +page.svelte wrote every
 * tone-driven class as a BINARY expression — `gStatus.tone === 'ok' ? success :
 * danger` for the panel surface and the label, and
 * `gStatus.verification.tone === 'ok' ? success : danger` for the verification
 * line. `warn` is neither arm, so it fell through into the full danger-red one:
 * the `⚠ UNKNOWN` panel (a cord nobody could read) and the STOPPED_UNVERIFIED
 * verification line (a halt merely unconfirmed) rendered pixel-identical to
 * CONTRADICTED (a MEASURED live contradiction). Three states the code can
 * compute were two states a human could see — the same absence-rendered-as-a-
 * result collapse this whole change set exists to remove, in the colour channel
 * instead of the text.
 *
 * The fix belongs here and not in the tone values: `warn` is the correct tone
 * for "unknown / unconfirmed", the tokens for it already exist (grep
 * `--color-warning-` in frontend/src/lib/styles/tokens.css — defined for both
 * the light and the dark theme), and the page was simply not reading them.
 * Idiom copied from `TONE_CLASS` in lib/components/verification/logic.ts.
 *
 * ⛔ Every tone-driven class on that page must come from one of these records.
 * To check that it still does, grep `gStatus.tone ===` and
 * `verification.tone ===` in +page.svelte: both must return nothing, otherwise
 * a ternary has grown back and a fourth tone would silently inherit red.
 */
export const ANDON_TONE_SURFACE: Record<AndonTone, string> = {
  ok: 'border-[var(--color-border)] bg-[var(--color-surface)]',
  warn: 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] dark:bg-[var(--color-warning-bg-deep)]/30',
  danger:
    'border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] dark:bg-[var(--color-danger-bg-deep)]/30',
};

/** Text colour per tone, for the headline label and the verification line. */
export const ANDON_TONE_TEXT: Record<AndonTone, string> = {
  ok: 'text-[var(--color-success)]',
  warn: 'text-[var(--color-warning-text)]',
  danger: 'text-[var(--color-danger)] dark:text-[var(--color-danger-text)]',
};

/**
 * One row of the global cord's audit trail, as served by `GET /api/andon/history`
 * (newest first, last 50). Recorded by the engage/disengage handlers since
 * migration 085 (which replaced the old DB trigger), so BOTH engage and release
 * carry the acting super-admin in `changed_by`. Pre-085 release rows may still
 * have `changed_by = null` — render any null actor as an em-dash.
 */
export interface AndonHistoryEntry {
  id: string;
  engaged: boolean;
  changed_at: string | null;
  changed_by: string | null;
}

/**
 * Tone + label for a single audit-history row. An engage (`engaged === true`) is
 * the dangerous transition (a system-wide halt was pulled); a release is the safe
 * one. Tone maps to the page's --color-danger / --color-success surfaces, matching
 * {@link globalCordStatus}.
 */
export function andonHistoryLabel(entry: AndonHistoryEntry): {
  tone: 'danger' | 'ok';
  label: string;
} {
  return entry.engaged
    ? { tone: 'danger', label: '🛑 Engaged' }
    : { tone: 'ok', label: '✓ Released' };
}

/** In-flight n8n execution drain, as served by `GET /api/andon/inflight`.
 * `running_count` is null when n8n could not be reached. */
export interface AndonInflight {
  running_count: number | null;
  capped: boolean;
}

/**
 * Label for the in-flight execution drain shown on the engaged global-cord
 * panel. Scaling `n8n-worker` to 0 stops NEW runs (SIGTERM stops job pickup) but
 * already-running executions are left to drain — this cord deliberately does not
 * stop them (n8n 2.46.1 does expose a stop-execution endpoint, deliberately
 * unused). `null` (n8n unreachable) reads as "unavailable" — never
 * "complete" — so a read failure never implies the drain is finished.
 */
export function inflightLabel(inflight: AndonInflight | null): {
  tone: 'ok' | 'warn';
  text: string;
} {
  const n = inflight?.running_count;
  if (n === null || n === undefined) {
    return { tone: 'warn', text: 'In-flight execution count unavailable.' };
  }
  if (n <= 0) {
    return { tone: 'ok', text: '✓ No executions still running — drain complete.' };
  }
  const shown = inflight?.capped ? `${n}+` : `${n}`;
  return {
    tone: 'warn',
    text: `🔄 ${shown} execution${n === 1 ? '' : 's'} still running — draining (new runs already stopped).`,
  };
}
