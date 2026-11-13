import { describe, expect, it } from 'vitest';
import {
  andonIntent,
  andonLiveness,
  andonPauseAttempt,
  andonReleaseVerdict,
  andonStateLabel,
  andonTitle,
  andonVerdict,
  clearedPauseNote,
  confirmDisengageMessage,
  confirmEngageMessage,
  liveProbeAgeLabel,
  pauseEvidenceWorkerReplicas,
  pauseEvidenceWorkerReplicasLabel,
  pullFeedback,
  workerReplicasLabel,
  type AndonGlobalState,
  type AndonLiveProbe,
  type AndonToggleResult,
} from './andon-cord-helpers';

// The cord's actuator is the `n8n/n8n-worker` Deployment's `spec.replicas`.
// Every fixture below therefore carries a replica count, and `null` is a
// first-class value throughout: it means NOT MEASURED, never 0.
const released: AndonGlobalState = {
  engaged: false,
  engaged_at: null,
  engaged_by: null,
  worker_replicas: 1,
};

const engaged: AndonGlobalState = {
  engaged: true,
  engaged_at: '2026-05-04T10:00:00Z',
  engaged_by: 'george@nonagentic.ai',
  worker_replicas: 0,
};

/** A successful live probe of a stopped worker. */
const liveStopped = (over: Partial<AndonLiveProbe> = {}): AndonLiveProbe => ({
  measured_at: '2026-11-01T10:00:00Z',
  worker_replicas: 0,
  available_replicas: 0,
  error: null,
  ...over,
});

describe('confirmEngageMessage', () => {
  it('names the actuator and what it stops — no workflow wording', () => {
    const msg = confirmEngageMessage();
    expect(msg).toMatch(/scales the n8n-worker Deployment to 0/);
    expect(msg).toMatch(/STOPS all automatic\s+execution/);
    // The old copy claimed a per-workflow deactivation. That concept is gone,
    // and re-introducing it here would promise a mechanism the backend does not
    // use.
    expect(msg).not.toMatch(/DEACTIVATES every active n8n workflow/);
    expect(msg).not.toMatch(/workflows? paused/);
  });
});

describe('confirmDisengageMessage', () => {
  it('does NOT claim work resumes — only that the scale-up is asked for', () => {
    const msg = confirmDisengageMessage();
    expect(msg).toMatch(/scales the n8n-worker Deployment back to 1/);
    expect(msg).toMatch(/only once the worker pod has started/);
    expect(msg).not.toMatch(/reactivates|resumes work system-wide/);
    expect(msg).not.toMatch(/paused workflow/);
    // KILLS: restoring "This reactivates N paused workflows and resumes work
    // system-wide." — `release_status: 'released'` means the PATCH was accepted,
    // not that the pod is serving.
  });
});

describe('workerReplicasLabel — three facts, three sentences', () => {
  it('0 says execution is STOPPED and names the scale', () => {
    expect(workerReplicasLabel(0)).toBe('execution STOPPED (n8n-worker scaled to 0)');
  });
  it('1 says the worker is running', () => {
    expect(workerReplicasLabel(1)).toBe('worker running (n8n-worker at 1 replica)');
  });
  it('⛔ null says NOT MEASURED — never 0 and never running', () => {
    const l = workerReplicasLabel(null);
    expect(l).toContain('NOT MEASURED');
    expect(l).not.toMatch(/\b0\b/);
    expect(l).not.toMatch(/running/);
    expect(workerReplicasLabel(undefined)).toBe(l);
    // KILLS: `replicas ?? 0` — the absence renders as a measured halt.
  });
});

describe('pullFeedback — engage', () => {
  it('ok: reports the worker stopped at 0 replicas', () => {
    const r: AndonToggleResult = { ...engaged, worker_replicas: 0, worker_scale_error: null };
    expect(pullFeedback('engage', r)).toEqual({
      tone: 'ok',
      text: '🛑 Stopped — execution STOPPED (n8n-worker scaled to 0)',
    });
  });

  it('warn: a stored scale error is surfaced', () => {
    const r: AndonToggleResult = {
      ...engaged,
      worker_replicas: null,
      worker_scale_error: 'k8s scale to 0 failed: 403 Forbidden',
    };
    const fb = pullFeedback('engage', r);
    expect(fb.tone).toBe('warn');
    expect(fb.text).toContain('403 Forbidden');
    expect(fb.text).toContain('NOT MEASURED');
    // KILLS: reporting an unmeasured worker as "stopped".
  });

  it('warn: a worker measured RUNNING contradicts the pull', () => {
    const r: AndonToggleResult = { ...engaged, worker_replicas: 1, worker_scale_error: null };
    const fb = pullFeedback('engage', r);
    expect(fb.tone).toBe('warn');
    expect(fb.text).toContain('automatic execution is NOT stopped');
    expect(fb.text).toContain('1 replica');
    // The reassuring wording must be GONE, not merely accompanied.
    expect(fb.text).not.toContain('🛑 Stopped');
  });

  it('⛔ null is reported as NOT MEASURED, never as stopped', () => {
    const r: AndonToggleResult = { ...engaged, worker_replicas: null, worker_scale_error: null };
    const fb = pullFeedback('engage', r);
    expect(fb.tone).toBe('warn');
    expect(fb.text).toContain('NOT MEASURED');
    expect(fb.text).not.toContain('🛑 Stopped');
  });

  it('already_engaged: no-op re-pull reports the measured count', () => {
    const r: AndonToggleResult = {
      ...engaged,
      worker_replicas: 0,
      worker_scale_error: null,
      already_engaged: true,
    };
    expect(pullFeedback('engage', r)).toEqual({
      tone: 'ok',
      text: 'Already stopped — n8n-worker is at 0 replicas',
    });
  });

  // ⭐ THE LIVE PROBE OUTRANKS THE STORED READING.
  //
  // The stored `worker_replicas` on a re-pull is the row value and nothing was
  // written; the live probe independently re-reads the Deployment. Reporting
  // the stored 0 alone let the one line the operator reads after pulling say a
  // calm green "Already stopped" while the SAME response measured the worker
  // still running.
  it('warn: a MEASURED running worker contradicts a stored 0', () => {
    const r: AndonToggleResult = {
      ...engaged,
      worker_replicas: 0,
      worker_scale_error: null,
      already_engaged: true,
      n8n_live: liveStopped({ worker_replicas: 1, available_replicas: 1 }),
    };
    const fb = pullFeedback('engage', r);
    expect(fb.tone).toBe('warn');
    expect(fb.text).toContain('still reports 1 replica');
    expect(fb.text).not.toContain('Already stopped');
    // KILLS: deleting the `liveShown` branch in pullFeedback.
  });

  it('ok: a probe that FAILED is not a contradiction', () => {
    const r: AndonToggleResult = {
      ...engaged,
      worker_replicas: 0,
      worker_scale_error: null,
      n8n_live: liveStopped({ worker_replicas: null, available_replicas: null, error: 'timeout' }),
    };
    expect(pullFeedback('engage', r)).toEqual({
      tone: 'ok',
      text: '🛑 Stopped — execution STOPPED (n8n-worker scaled to 0)',
    });
  });

  it('ok: NOT PROBED is not a contradiction either (positive control)', () => {
    const r: AndonToggleResult = {
      ...engaged,
      worker_replicas: 0,
      worker_scale_error: null,
      n8n_live: null,
    };
    expect(pullFeedback('engage', r).tone).toBe('ok');
    // KILLS: treating an absent `n8n_live` as a contradiction.
  });
});

describe('pullFeedback — disengage', () => {
  it('ok: an accepted release does NOT claim the worker is running again', () => {
    const r: AndonToggleResult = {
      ...released,
      worker_replicas: 1,
      worker_scale_error: null,
      release_status: 'released',
    };
    const fb = pullFeedback('disengage', r);
    expect(fb.tone).toBe('ok');
    expect(fb.text).toContain('Release accepted');
    expect(fb.text).toContain('the worker pod still has to start');
    // ⛔ The exact over-claim this copy rule forbids.
    expect(fb.text).not.toContain('Running');
    expect(fb.text).not.toMatch(/n8n is back|resumed|reactivated/);
  });

  it('⛔ released_incomplete WARNS — the scale-up was not confirmed', () => {
    const r: AndonToggleResult = {
      ...released,
      worker_replicas: null,
      worker_scale_error: 'k8s scale to 1 failed: 500',
      release_status: 'released_incomplete',
    };
    const fb = pullFeedback('disengage', r);
    expect(fb.tone).toBe('warn');
    expect(fb.text).toContain('NOT confirmed');
    expect(fb.text).toContain('do NOT assume automatic execution has resumed');
    expect(fb.text).toContain('k8s scale to 1 failed: 500');
    expect(fb.text).not.toContain('Release accepted');
    // KILLS: restoring a verdict re-derived from counts that no longer exist.
  });

  it('⛔ an UNRECOGNISED status is amber and says UNKNOWN', () => {
    const r: AndonToggleResult = {
      ...released,
      worker_replicas: 1,
      worker_scale_error: null,
      release_status: 'released_somehow' as never,
    };
    const fb = pullFeedback('disengage', r);
    expect(fb.tone).toBe('warn');
    expect(fb.text).toContain('UNRECOGNISED');
    expect(fb.text).not.toContain('Release accepted');
    // KILLS: defaulting an unrecognised status to the success arm.
  });

  it('⛔ a `released` that contradicts worker_scale_error is amber', () => {
    const r: AndonToggleResult = {
      ...released,
      worker_replicas: 1,
      worker_scale_error: 'k8s read failed after the PATCH',
      release_status: 'released',
    };
    const fb = pullFeedback('disengage', r);
    expect(fb.tone).toBe('warn');
    expect(fb.text).toContain('treat the worker state as UNKNOWN');
    expect(fb.text).not.toContain('Release accepted');
  });

  it('⛔ a released cord whose worker is STILL at 0 says STOPPED', () => {
    const r: AndonToggleResult = {
      ...released,
      worker_replicas: 0,
      worker_scale_error: null,
      release_status: 'released',
    };
    const fb = pullFeedback('disengage', r);
    expect(fb.tone).toBe('warn');
    expect(fb.text).toContain('automatic execution is STOPPED');
    expect(fb.text).not.toContain('Release accepted');
    // KILLS: trusting `release_status: 'released'` to mean the worker came back.
  });

  it('⛔ a null count after a release is NOT MEASURED, not "Running"', () => {
    const fb = pullFeedback('disengage', {
      ...released,
      worker_replicas: null,
      worker_scale_error: null,
      release_status: 'released',
    });
    expect(fb.tone).toBe('warn');
    expect(fb.text).toContain('NOT MEASURED');
    expect(fb.text).not.toContain('Running');
  });
});

describe('andonStateLabel / andonTitle', () => {
  it('a released cord with a running worker reads running', () => {
    expect(andonStateLabel(false, 1)).toBe('Conveyor: running');
    // The sentence moved to the tooltip: the visible label is two words because it
    // shares the top navigation with the tab strip.
    expect(andonTitle(released)).toContain('Click to stop every workspace');
    expect(andonTitle(released)).toContain('worker running (n8n-worker at 1 replica)');
  });

  it('⛔ a released cord whose worker is still at 0 does NOT read running', () => {
    const label = andonStateLabel(false, 0);
    expect(label).toBe('Conveyor: stopped ⚠');
    expect(label).not.toMatch(/: running/);
    expect(andonTitle({ ...released, worker_replicas: 0 })).toContain('execution STOPPED');
    // KILLS: deriving the visible label from `engaged` alone.
  });

  it('⛔ a released cord with NO measurement does NOT read a bare running either', () => {
    const label = andonStateLabel(false, null);
    expect(label).toBe('Conveyor: running ?');
    expect(label).not.toMatch(/: running$/);
    // An omitted count is the same absence, not a licence to assume the worker
    // is up.
    expect(andonStateLabel(false)).toBe(label);
    expect(andonTitle({ ...released, worker_replicas: null })).toContain('NOT MEASURED');
    // KILLS: defaulting the released arm to "running" when the count is null.
  });

  it('engaged: includes by, duration, and the measured worker state', () => {
    expect(andonTitle(engaged, '5m')).toBe(
      'STOPPED by george@nonagentic.ai (5m) — execution STOPPED (n8n-worker scaled to 0)',
    );
  });

  it('engaged with a NOT MEASURED worker says so in the tooltip', () => {
    const t = andonTitle({ ...engaged, worker_replicas: null });
    expect(t.startsWith('STOPPED')).toBe(true);
    expect(t).toContain('NOT MEASURED');
    expect(t).not.toContain('scaled to 0');
    // KILLS: `state.worker_replicas ?? 0` in andonTitle.
  });

  it('an engaged cord whose worker is running marks the contradiction in the label', () => {
    const label = andonStateLabel(true, 1);
    expect(label).toBe('Conveyor: stopped ⚠');
    expect(label).not.toMatch(/: running/);
  });
});

// ---------------------------------------------------------------------------
// The three axes. Each is a DIFFERENT question, and the whole defect was
// answering all three from one success count.
// ---------------------------------------------------------------------------

const pauseApplied = {
  attempted_at: '2026-09-23T10:00:01Z',
  error: null,
  worker_replicas: 0,
};

const engagedApplied: AndonGlobalState = {
  ...engaged,
  intent: 'engaged',
  n8n_pause: pauseApplied,
  n8n_live: null,
};

describe('andonIntent', () => {
  it('prefers the explicit backend axis over the legacy boolean', () => {
    expect(andonIntent({ ...released, intent: 'unreadable' })).toBe('unreadable');
  });
  it('falls back to the legacy boolean when the axis is absent', () => {
    expect(andonIntent(released)).toBe('released');
    expect(andonIntent(engaged)).toBe('engaged');
    // KILLS: making `intent` required, or dropping the fallback — every
    // pre-upgrade payload would derive `undefined` and every verdict with it.
  });
});

describe('andonPauseAttempt', () => {
  it('applied when a timestamp is present and no error is stored', () => {
    expect(andonPauseAttempt(engagedApplied)).toBe('applied');
  });
  it('failed when an error is stored, regardless of the timestamp', () => {
    expect(
      andonPauseAttempt({
        ...engagedApplied,
        n8n_pause: { ...pauseApplied, error: 'k8s scale to 0 failed: 403' },
      }),
    ).toBe('failed');
  });
  it('never_attempted when the block is present but empty', () => {
    expect(
      andonPauseAttempt({
        ...engagedApplied,
        n8n_pause: { attempted_at: null, error: null, worker_replicas: null },
      }),
    ).toBe('never_attempted');
  });
  it('n/a when the cord is released — the column is OVERLOADED there', () => {
    // The backend's disengage path reuses the attempt timestamp to mean "the
    // release scale ran at". Deriving a PAUSE from it while released would
    // report a pause that never happened.
    expect(
      andonPauseAttempt({
        ...engagedApplied,
        engaged: false,
        intent: 'released',
        n8n_pause: { attempted_at: '2026-09-23T11:00:00Z', error: null, worker_replicas: 1 },
      }),
    ).toBe('n/a');
    // KILLS: deriving pause_attempt without gating on intent === 'engaged'.
  });
  it('n/a when the backend sent no pause block at all', () => {
    expect(andonPauseAttempt(engaged)).toBe('n/a');
  });
});

describe('pauseEvidenceWorkerReplicas — absent, null and n are THREE facts', () => {
  // ⭐ The mirror of the backend fix. `n8n_pause.worker_replicas` is EVIDENCE
  // about an attempt; a NULL there means nothing was measured, which is not the
  // number 0. The discriminator (`attempted_at`) is a SIBLING field, so any
  // consumer that renders this count on its own must carry the distinction.
  it('null reads as NOT RECORDED, never as zero', () => {
    const r = pauseEvidenceWorkerReplicas({ attempted_at: null, error: null, worker_replicas: null });
    expect(r).toBeNull();
    expect(r).not.toBe(0);
    expect(
      pauseEvidenceWorkerReplicasLabel({ attempted_at: null, error: null, worker_replicas: null }),
    ).toBe('no n8n-worker replica count recorded');
    // ...and never the literal `undefined` leaking into copy.
    expect(
      pauseEvidenceWorkerReplicasLabel({ attempted_at: null, error: null, worker_replicas: null }),
    ).not.toMatch(/undefined|NaN/);
    // KILLS: `?? 0` in pauseEvidenceWorkerReplicas — the absence renders as a
    // measured halt again.
  });

  it('an absent block is also not-recorded, not zero', () => {
    expect(pauseEvidenceWorkerReplicas(undefined)).toBeNull();
    expect(pauseEvidenceWorkerReplicas(null)).toBeNull();
    expect(pauseEvidenceWorkerReplicasLabel(undefined)).toBe('no n8n-worker replica count recorded');
    // KILLS: defaulting an absent/legacy block to 0 — a pre-upgrade backend
    // would be reported as an attempt that stopped the worker.
  });

  it('CONTROL — 0 from a recorded attempt stays 0, and 1 stays 1', () => {
    // An attempt that genuinely measured 0 replicas is a MEASUREMENT and must
    // remain distinguishable from "no attempt". Without this the fix above
    // could over-correct into mapping every falsy count to null.
    const zero = pauseEvidenceWorkerReplicas({
      attempted_at: '2026-09-23T10:00:01Z',
      error: null,
      worker_replicas: 0,
    });
    expect(zero).not.toBeNull();
    expect(zero).toBe(0);
    expect(
      pauseEvidenceWorkerReplicasLabel({ attempted_at: null, error: null, worker_replicas: 0 }),
    ).toBe('execution STOPPED (n8n-worker scaled to 0)');
    expect(
      pauseEvidenceWorkerReplicasLabel({ attempted_at: null, error: null, worker_replicas: 1 }),
    ).toBe('worker running (n8n-worker at 1 replica)');
    // KILLS: `p.worker_replicas || null`, or any `=== 0 ? null` mapping.
  });
});

describe('andonLiveness', () => {
  it('absent when the probe did not run (n8n_live === null)', () => {
    expect(andonLiveness(engagedApplied)).toBe('absent');
    expect(andonLiveness(engaged)).toBe('absent');
  });
  it('unmeasured when the probe RAN and FAILED (worker_replicas === null)', () => {
    expect(
      andonLiveness({
        ...engagedApplied,
        n8n_live: liveStopped({ worker_replicas: null, available_replicas: null, error: 'timeout' }),
      }),
    ).toBe('unmeasured');
    // KILLS: collapsing `worker_replicas === null` into 0. `absent`,
    // `unmeasured` and `stopped` are three different facts; only the third is
    // a measurement.
  });
  it('stopped only for a SUCCESSFUL probe returning zero', () => {
    expect(andonLiveness({ ...engagedApplied, n8n_live: liveStopped() })).toBe('stopped');
  });
  it('running for a positive count', () => {
    expect(
      andonLiveness({
        ...engagedApplied,
        n8n_live: liveStopped({ worker_replicas: 1, available_replicas: 1 }),
      }),
    ).toBe('running');
  });
});

describe('andonVerdict precedence', () => {
  it('unreadable outranks everything, including a live measurement', () => {
    expect(
      andonVerdict({
        ...engagedApplied,
        intent: 'unreadable',
        n8n_live: liveStopped(),
      }),
    ).toBe('UNREADABLE');
  });
  it('a live contradiction outranks a clean stored scale', () => {
    expect(
      andonVerdict({
        ...engagedApplied,
        n8n_live: liveStopped({ worker_replicas: 1, available_replicas: 1 }),
      }),
    ).toBe('CONTRADICTED');
  });
  it('a failed scale outranks an unmeasured probe', () => {
    expect(
      andonVerdict({
        ...engagedApplied,
        n8n_pause: { ...pauseApplied, error: 'boom' },
        n8n_live: liveStopped({ worker_replicas: null, available_replicas: null, error: 'timeout' }),
      }),
    ).toBe('HALF_ENGAGED');
  });
  it('applied + measured 0 replicas is the only confirmed halt', () => {
    expect(andonVerdict({ ...engagedApplied, n8n_live: liveStopped() })).toBe('STOPPED_CONFIRMED');
  });
  // ⚠️ CHANGED 2026-09-23. This test used to read:
  //
  //   it('null state stays fail-open (RUNNING) — a read failure is not a halt',
  //      () => { expect(andonVerdict(null)).toBe('RUNNING'); });
  //
  // It was green, and it asserted the defect: a `null` state is the ABSENCE of a
  // read, and 'RUNNING' is a result. Via globalCordStatus that absence rendered
  // as a green "✓ Running / All automation active" on a safety-interlock
  // surface. The fail-open bias the old name invoked is real but belongs in the
  // backend's behaviour, not in a UI claim — see the comment on andonVerdict.
  it('a null state is UNREADABLE — holding no read is not a green light', () => {
    expect(andonVerdict(null)).toBe('UNREADABLE');
    // ⛔ ...and not the mirror-image lie either. Telling an operator the cord is
    // pulled when it may not be invites them to walk away from a running line.
    expect(andonVerdict(null)).not.toBe('STOPPED_UNVERIFIED');
    expect(andonVerdict(null)).not.toBe('STOPPED_CONFIRMED');
    // POSITIVE CONTROL, in the same test: a payload that genuinely says released
    // still reads RUNNING. Without it, `return 'UNREADABLE'` for every input
    // would pass the three assertions above, and the function would be equally
    // useless in the other direction.
    expect(andonVerdict(released)).toBe('RUNNING');
    // KILLS: restoring `if (!state) return 'RUNNING';` as the first line of
    // andonVerdict — assertion 1 fails. Also kills
    // `if (!state) return 'STOPPED_UNVERIFIED';` and any blanket
    // `return 'UNREADABLE'`, via the control.
  });
});

describe('andonTitle — verification suffix', () => {
  it('appends nothing for a legacy payload (silence is honest there)', () => {
    expect(andonTitle(engaged, '5m')).toBe(
      'STOPPED by george@nonagentic.ai (5m) — execution STOPPED (n8n-worker scaled to 0)',
    );
    // KILLS: appending "· not verified" unconditionally — it would invent a
    // verification claim about a backend that sent no verification data.
  });
  it('names a live contradiction, still starting with STOPPED', () => {
    const t = andonTitle(
      {
        ...engagedApplied,
        n8n_live: liveStopped({ worker_replicas: 1, available_replicas: 1 }),
      },
      '5m',
    );
    expect(t.startsWith('STOPPED')).toBe(true);
    expect(t).toContain('n8n-worker still reports 1 replica');
    expect(t).toContain('did NOT land');
  });
  it('names a confirmed halt', () => {
    const t = andonTitle({ ...engagedApplied, n8n_live: liveStopped() });
    expect(t).toContain('verified: n8n-worker at 0 replicas');
  });
  it('an unreadable cord is not described as running', () => {
    const t = andonTitle({ ...released, intent: 'unreadable' });
    expect(t).toContain('UNREADABLE');
    expect(t).not.toContain('running');
  });
});

// ---------------------------------------------------------------------------
// `n8n_live.measured_at` — WRITE-ONLY UNTIL 2026-09-23.
//
// The backend computed it, shipped it, and the frontend declared it in
// `AndonLiveProbe`. A verification the operator cannot date is not one they
// can judge.
//
// TO MAKE THIS BLOCK GO RED: see the per-test KILLS notes. The cheapest whole-
// block kill is `return null` as the first line of `liveProbeAgeLabel`.
// ---------------------------------------------------------------------------

describe('liveProbeAgeLabel — the reader for n8n_live.measured_at', () => {
  // Real clock: each probe is stamped relative to Date.now().
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const probe = (measured_at: unknown) => liveStopped({ measured_at } as never);

  it('renders a relative age from a real timestamp', () => {
    expect(liveProbeAgeLabel(probe(ago(5 * 60_000)))).toBe('measured 5m ago');
    expect(liveProbeAgeLabel(probe(ago(12_000)))).toBe('measured 12s ago');
    // KILLS: rendering the raw ISO string instead of an age.
  });

  it('a probe taken this instant is "just now", NEVER "0s"', () => {
    const l = liveProbeAgeLabel(probe(ago(0)));
    expect(l).toBe('measured just now');
    expect(l).not.toContain('0');
    // KILLS: dropping the `ageMs < 1_000` branch, which prints "measured 0s ago".
  });

  it('⛔ a FUTURE timestamp (clock skew) never prints a negative age', () => {
    // Well past the tolerance band: the skew itself is the finding.
    const l = liveProbeAgeLabel(probe(ago(-60_000)))!;
    expect(l).toContain('AHEAD of this clock');
    expect(l).not.toContain('-');
    expect(l).not.toMatch(/\bago\b/);
    // ...and under a second in the future is tolerated as "just now", not amber.
    expect(liveProbeAgeLabel(probe(ago(-500)))).toBe('measured just now');
    // KILLS: `return `measured ${durationText((now - t) / 1000)} ago`` with no
    // sign check — measured: it prints "measured no data ago" for this input,
    // because durationText refuses a negative span but the sentence does not.
  });

  it('⛔ NOT PROBED yields NO age sentence at all', () => {
    expect(liveProbeAgeLabel(null)).toBeNull();
    expect(liveProbeAgeLabel(undefined)).toBeNull();
    // KILLS: returning a phrase (or "measured just now") for an absent probe,
    // which would invent a measurement where there was none — the same
    // absence-as-a-result collapse `andonLiveness` exists to prevent.
  });

  it('ABSENT, NULL and UNPARSEABLE are three different phrases, none a duration', () => {
    const absent = liveProbeAgeLabel({ worker_replicas: 0, available_replicas: 0, error: null } as never)!;
    const nulled = liveProbeAgeLabel(probe(null))!;
    const junk = liveProbeAgeLabel(probe('not-a-date'))!;
    const empty = liveProbeAgeLabel(probe('   '))!;
    expect(absent).toBe('probe time not reported');
    expect(nulled).toBe('probe time not recorded');
    expect(junk).toBe('probe time unreadable');
    expect(empty).toBe('probe time unreadable');
    expect(new Set([absent, nulled, junk]).size).toBe(3);
    // ⛔ and not one of them may leak a broken number or unit.
    for (const l of [absent, nulled, junk, empty]) {
      expect(l).not.toContain('NaN');
      expect(l).not.toContain('undefined');
      expect(l).not.toMatch(/\bago\b/);
    }
    // KILLS: `measured_at ?? ''` / a single 'unknown' phrase for all three —
    // measured: Date.parse(undefined) is NaN, and the naive sentence renders
    // "measured NaN ago".
  });
});

// ---------------------------------------------------------------------------
// `cleared_pause_evidence` — WRITE-ONLY UNTIL 2026-09-23.
//
// Computed in handleDisengageAndon, returned on the disengage response,
// declared on `AndonToggleResult`, and read by NOTHING: grepping
// `cleared_pause_evidence` over frontend/src + backend/src returned the
// producer, the type declaration, two prose comments and ONE test fixture.
// Its docstring claimed it answered "exactly the question an operator asks
// afterwards" — and no operator could see it.
// ---------------------------------------------------------------------------

describe('clearedPauseNote — the reader for cleared_pause_evidence', () => {
  it('names a scale that had FAILED, because the release erases the evidence', () => {
    const note = clearedPauseNote({
      attempted_at: '2026-09-01T00:00:00Z',
      error: 'k8s scale to 0 failed: 403 Forbidden',
      worker_replicas: null,
    })!;
    expect(note.tone).toBe('warn');
    expect(note.text).toContain('k8s scale to 0 failed: 403 Forbidden');
    expect(note.text).toContain('may have continued during the freeze');
    // KILLS: `return null` for a non-null error — the whole point of the field.
  });

  it('names a halt with NO recorded scale attempt at all', () => {
    const note = clearedPauseNote({ attempted_at: null, error: null, worker_replicas: null })!;
    expect(note.tone).toBe('warn');
    expect(note.text).toContain('no n8n-worker scale attempt was ever recorded');
    expect(note.text).not.toContain('0 replicas');
    // KILLS: `worker_replicas ?? 0` here — it turns "nothing measured" into the
    // number 0 and the note goes silent, the collapse
    // pauseEvidenceWorkerReplicas exists to forbid, one field over.
  });

  it('⛔ a MEASURED running worker contradicts the freeze the operator believed in', () => {
    const note = clearedPauseNote({ attempted_at: 'x', error: null, worker_replicas: 1 })!;
    expect(note.tone).toBe('warn');
    expect(note.text).toContain('had NOT landed');
    expect(note.text).toContain('1 replica');
    expect(note.text).toContain('continued during the freeze');
    // KILLS: staying silent for any non-null count — with the old per-workflow
    // semantics a positive count meant success, but a replica count of 1 means
    // the freeze DID NOT LAND.
  });

  it('⛔ worker_replicas 0 is a MEASUREMENT, not an absence: silent', () => {
    expect(clearedPauseNote({ attempted_at: 'x', error: null, worker_replicas: 0 })).toBeNull();
    // KILLS: `if (!ev.worker_replicas)` instead of an explicit null check — it
    // would warn "no scale attempt was ever recorded" about a scale that ran
    // and measured the worker stopped.
  });

  it('ABSENT and NULL are silent, not reassuring and not a warning', () => {
    expect(clearedPauseNote(undefined)).toBeNull(); // pre-upgrade backend
    expect(clearedPauseNote(null)).toBeNull(); // a release that describes no pause
    // KILLS: treating `undefined` as "no scale recorded" — it would warn on
    // every release against a backend that simply never sent the field.
  });

  it('an empty-string error is not an error', () => {
    expect(clearedPauseNote({ attempted_at: 'x', error: '', worker_replicas: 0 })).toBeNull();
    // KILLS: `if (ev.error !== null)` — '' is not null and would render
    // "had NOT fully landed ()" with an empty reason.
  });
});

describe('pullFeedback — disengage carries the cleared pause evidence', () => {
  const base: AndonToggleResult = {
    ...released,
    worker_replicas: 1,
    worker_scale_error: null,
    release_status: 'released',
  };

  it('a CLEAN release still goes amber when the halt it ended never landed', () => {
    const fb = pullFeedback('disengage', {
      ...base,
      cleared_pause_evidence: {
        attempted_at: '2026-09-01T00:00:00Z',
        error: 'k8s scale to 0 failed: 403 Forbidden',
        worker_replicas: null,
      },
    });
    // The release itself succeeded — the line still says so...
    expect(fb.text).toContain('Release accepted');
    // ...and it also says what the release just erased.
    expect(fb.text).toContain('k8s scale to 0 failed: 403 Forbidden');
    expect(fb.tone).toBe('warn');
    // KILLS: keeping `tone: 'ok'` on this arm. The text would still carry the
    // warning while the page painted it green (+page.svelte drives the feedback
    // colour off `tone` alone), which is the colour-channel half of exactly the
    // collapse ANDON_TONE_* was introduced to fix.
  });

  it('the note is appended to a FAILED release too, without losing either fact', () => {
    const fb = pullFeedback('disengage', {
      ...base,
      worker_replicas: null,
      worker_scale_error: 'k8s scale to 1 failed: 500',
      release_status: 'released_incomplete',
      cleared_pause_evidence: { attempted_at: null, error: null, worker_replicas: null },
    });
    expect(fb.tone).toBe('warn');
    expect(fb.text).toContain('NOT confirmed'); // this release
    expect(fb.text).toContain('no n8n-worker scale attempt was ever recorded'); // the one it ended
    // KILLS: appending the note to only one of the two arms — the arm that
    // drops it is the one where something ALREADY went wrong.
  });

  it('CONTROL: a clean release of a confirmed pause is unchanged, byte for byte', () => {
    expect(
      pullFeedback('disengage', {
        ...base,
        cleared_pause_evidence: { attempted_at: 'x', error: null, worker_replicas: 0 },
      }),
    ).toEqual({
      tone: 'ok',
      text: '▶ Release accepted — n8n-worker scaled to 1; the worker pod still has to start',
    });
    // ...and identically when the backend sent no such field at all.
    expect(pullFeedback('disengage', base)).toEqual({
      tone: 'ok',
      text: '▶ Release accepted — n8n-worker scaled to 1; the worker pod still has to start',
    });
    // This is the assertion that stops the two above from being satisfied by a
    // note that fires unconditionally.
  });
});

// ---------------------------------------------------------------------------
// `release_status` — WRITE-ONLY UNTIL 2026-09-25, and the field that decides
// whether the emergency brake's release actually brought the worker back.
//
// The producer is `handleDisengageAndon` and its type is:
//
//     export type AndonReleaseStatus = 'released' | 'released_incomplete' | 'released_kata_holds';
//
// Measured on origin/main: its ONLY readers in the entire repo were four
// backend test assertions. ZERO frontend references — and the frontend instead
// RE-DERIVED the answer from workflow counts that no longer exist. An operator
// released the brake, was told "released", and could not see that the worker
// never came back.
// ---------------------------------------------------------------------------

describe('andonReleaseVerdict — the reader for release_status', () => {
  it("maps the producer's COMPLETE value set, and nothing wider", () => {
    expect(andonReleaseVerdict({ release_status: 'released' })).toBe('complete');
    expect(andonReleaseVerdict({ release_status: 'released_incomplete' })).toBe('incomplete');
    expect(andonReleaseVerdict({ release_status: 'released_kata_holds' })).toBe('kata_holds');
    // KILLS: swapping the two arms, and any mapping that folds them together.
  });

  it('⛔ an UNRECOGNISED value is explicitly UNKNOWN — never success', () => {
    // A newer backend, a third status, a typo, a non-string off the wire. None
    // of these is 'released', so none of them may render as a clean release.
    for (const raw of ['released_partial', 'RELEASED', 'ok', '', ' released ', 7, true, {}, []]) {
      const v = andonReleaseVerdict({ release_status: raw });
      expect(v, `release_status=${JSON.stringify(raw)}`).toBe('unknown');
      expect(v).not.toBe('complete');
      expect(v).not.toBe('not_reported');
    }
    // KILLS: a `default:` / trailing `else` that returns 'complete' (the
    // mutation this test exists for), and equally a bare
    // `raw === 'released_incomplete' ? 'incomplete' : 'complete'`, which is the
    // shape the obvious inline comparison takes.
  });

  it('an ABSENT field is not_reported — a DIFFERENT fact from unknown', () => {
    // A pre-upgrade backend, or the other half of a rolling deploy, said
    // nothing. Nothing said is not a value we failed to read.
    expect(andonReleaseVerdict({})).toBe('not_reported');
    expect(andonReleaseVerdict({ release_status: undefined })).toBe('not_reported');
    expect(andonReleaseVerdict({ release_status: null })).toBe('not_reported');
    expect(andonReleaseVerdict(null)).toBe('not_reported');
    expect(andonReleaseVerdict(undefined)).toBe('not_reported');
    // ...and it is still not success.
    expect(andonReleaseVerdict({})).not.toBe('complete');
    // KILLS: collapsing absence into 'unknown' (every legacy release would turn
    // amber) or into 'complete' (the original defect, restored).
  });
});

describe('pullFeedback — disengage is decided by release_status, not by the counts', () => {
  const base: AndonToggleResult = {
    ...released,
    worker_replicas: 1,
    worker_scale_error: null,
  };

  it('released_kata_holds says a kata keeps the worker at 0 — never "Release accepted"', () => {
    const fb = pullFeedback('disengage', {
      ...base,
      worker_replicas: 0,
      release_status: 'released_kata_holds',
      kata_holders: ['k-1', 'k-2'],
    });
    expect(fb.tone).toBe('warn');
    expect(fb.text).toContain('2 katas still hold');
    expect(fb.text).toContain('until the last kata releases');
    expect(fb.text).not.toContain('Release accepted');
  });

  it('⛔ released_incomplete WARNS, even when the replica count looks clean', () => {
    // ⭐ THE KILL. A stored `worker_replicas: 1` is exactly what a
    // count-driven verdict would look at, and it would return the green
    // "▶ Release accepted". The authoritative field says the scale-up was not
    // confirmed.
    const fb = pullFeedback('disengage', { ...base, release_status: 'released_incomplete' });
    expect(fb.tone).toBe('warn');
    expect(fb.text).toContain('NOT confirmed');
    // The reassuring wording must be GONE, not merely accompanied.
    expect(fb.text).not.toContain('Release accepted');
    // KILLS: re-deriving the verdict from the replica count.
  });

  it('CONTROL — `released` with a measured count is the ONLY green arm', () => {
    // Without this the tests above are satisfied by warning unconditionally,
    // which would be equally useless in the other direction.
    expect(pullFeedback('disengage', { ...base, release_status: 'released' })).toEqual({
      tone: 'ok',
      text: '▶ Release accepted — n8n-worker scaled to 1; the worker pod still has to start',
    });
  });

  it('CONTROL — a pre-upgrade backend (no release_status) uses the replica count', () => {
    // No `release_status` at all: the measured replica count is then the ONLY
    // evidence in existence.
    expect(
      pullFeedback('disengage', { ...released, worker_replicas: 1, worker_scale_error: null }),
    ).toEqual({
      tone: 'ok',
      text: '▶ Release accepted — n8n-worker scaled to 1; the worker pod still has to start',
    });
    const fb = pullFeedback('disengage', {
      ...released,
      worker_replicas: 0,
      worker_scale_error: null,
    });
    expect(fb.tone).toBe('warn');
    expect(fb.text).toContain('automatic execution is STOPPED');
    // KILLS: making the absence of `release_status` amber (every legacy release
    // would warn) or silencing the measured-count warning entirely.
  });

  it('the cleared-pause note still rides along on every new arm', () => {
    const fb = pullFeedback('disengage', {
      ...base,
      release_status: 'released_incomplete',
      cleared_pause_evidence: { attempted_at: null, error: null, worker_replicas: null },
    });
    expect(fb.text).toContain('NOT confirmed'); // this release
    expect(fb.text).toContain('no n8n-worker scale attempt was ever recorded'); // the one it ended
    // KILLS: appending the note only to the arms that existed before this
    // change — the new arms are the ones where something has ALREADY gone wrong.
  });
});
