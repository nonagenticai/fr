import { describe, expect, it } from 'vitest';
import {
  summary,
  totalEngaged,
  formatEngagedAt,
  globalCordStatus,
  andonHistoryLabel,
  inflightLabel,
  ANDON_TONE_SURFACE,
  ANDON_TONE_TEXT,
  type AndonTone,
  type AndonState,
  type AndonGlobalState,
  type AndonHistoryEntry,
} from './page-helpers';
import {
  andonIntent,
  andonTitle,
  andonVerdict,
} from '$lib/components/andon-cord-helpers';

const state: AndonState = {
  projects: [
    { id: '1', name: 'p1', shape: 'continuous_flow', andon_engaged: true,  andon_engaged_at: null, andon_engaged_by: null },
    { id: '2', name: 'p2', shape: 'deliverable',    andon_engaged: false, andon_engaged_at: null, andon_engaged_by: null },
  ],
  streams: [
    { id: 's1', name: 'wf', kind: 'workflow', tenant_id: 't', andon_engaged: true,  andon_engaged_at: null, andon_engaged_by: null },
    { id: 's2', name: 'pr', kind: 'prompt',   tenant_id: 't', andon_engaged: false, andon_engaged_at: null, andon_engaged_by: null },
  ],
};

describe('totalEngaged', () => {
  it('counts engaged across projects + streams', () => {
    expect(totalEngaged(state)).toBe(2);
  });

  it('zero when nothing engaged', () => {
    expect(totalEngaged({
      projects: [{ ...state.projects[1]! }],
      streams: [{ ...state.streams[1]! }],
    })).toBe(0);
  });
});

describe('summary', () => {
  it('reports x of y', () => {
    expect(summary(state)).toBe('2 of 4 engaged');
  });

  it('handles empty state', () => {
    expect(summary({ projects: [], streams: [] })).toBe('0 of 0 engaged');
  });
});

describe('formatEngagedAt', () => {
  it('renders em-dash for null', () => {
    expect(formatEngagedAt(null)).toBe('—');
  });

  it('renders a locale string for a real timestamp', () => {
    const out = formatEngagedAt('2026-05-04T10:00:00Z');
    expect(out).not.toBe('—');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('globalCordStatus', () => {
  const released: AndonGlobalState = {
    engaged: false,
    engaged_at: null,
    engaged_by: null,
    worker_replicas: 1,
  };

  it('reads released with a running worker as a safe (ok) running state', () => {
    const s = globalCordStatus(released);
    expect(s.tone).toBe('ok');
    expect(s.label).toBe('✓ Running');
    // The claim is anchored to a MEASUREMENT, not to the cord word alone.
    expect(s.detail).toContain('n8n-worker at 1 replica');
  });

  // ⚠️ CHANGED 2026-09-23. This test used to read:
  //
  //   it('treats null (not loaded / read failed) as released — never a false
  //      halt', () => { expect(globalCordStatus(null).tone).toBe('ok'); });
  //
  // It passed, and what it pinned was the defect: `null` means this page holds
  // NO cord state, and the panel answered with a green "✓ Running". "Never a
  // false halt" was only half a requirement — never a false RUN is the other
  // half, and on a safety interlock it is the dangerous one.
  it('null (no cord state read) renders as UNKNOWN, never as a green Running', () => {
    const unknown = globalCordStatus(null, 0);
    expect(unknown.label).toBe('⚠ UNKNOWN');
    expect(unknown.tone).toBe('warn');
    expect(unknown.detail).toContain('NOT a statement that work is running');
    // The two specific green claims that used to appear here...
    expect(unknown.detail).not.toContain('All automation active');
    expect(unknown.detail).not.toContain('No global halt in effect');
    // ⛔ ...and not the mirror-image lie: an unread cord is not a pulled one.
    expect(unknown.label).not.toContain('STOPPED');
    expect(unknown.tone).not.toBe('danger');
    // It also says nothing was checked, rather than nothing needed checking.
    expect(unknown.verification?.tone).toBe('warn');
    expect(unknown.verification?.text).toContain('Not verified');

    // POSITIVE CONTROL — same helper, same `engagedSurfaces` argument, a state
    // that genuinely IS released with a running worker. Without this the
    // assertions above would also pass if the green sentence were simply
    // deleted from page-helpers.ts, or if every input returned '⚠ UNKNOWN'.
    const genuinely = globalCordStatus(released, 0);
    expect(genuinely.tone).toBe('ok');
    expect(genuinely.label).toBe('✓ Running');
    expect(genuinely.detail).toContain('All automation active');
    // And the difference is visible in the one line an operator reads first.
    expect(unknown.label).not.toBe(genuinely.label);

    // KILLS: restoring `if (!state) return 'RUNNING';` in `andonVerdict`
    // (lib/components/andon-cord-helpers.ts) — `unknown` then takes the RUNNING
    // branch and every assertion on it fails while the control still passes.
  });

  it('reads engaged with a stopped worker as danger, naming the scale', () => {
    const s = globalCordStatus({ ...released, engaged: true, worker_replicas: 0 });
    expect(s.tone).toBe('danger');
    expect(s.label).toBe('🛑 STOPPED');
    expect(s.detail).toContain('execution STOPPED (n8n-worker scaled to 0)');
  });

  // ⛔ THE COPY RULES. 0 / 1 / null are three different facts and the panel must
  // never render one as another — least of all null as "running".
  it('⛔ a released cord whose worker is still at 0 reads STOPPED, not Running', () => {
    const s = globalCordStatus({ ...released, worker_replicas: 0 });
    expect(s.tone).toBe('danger');
    expect(s.label).toBe('⚠ STOPPED');
    expect(s.detail).toContain('automatic execution is STOPPED');
    expect(s.detail).not.toContain('No global halt in effect');
    // KILLS: rendering the released branch from `engaged === false` alone.
  });

  it('⛔ a released cord with an UNMEASURED worker is UNKNOWN, not 0 and not running', () => {
    const s = globalCordStatus({ ...released, worker_replicas: null });
    expect(s.tone).toBe('warn');
    expect(s.label).toBe('⚠ UNKNOWN');
    expect(s.detail).toContain('NOT MEASURED');
    expect(s.detail).not.toContain('All automation active');
    expect(s.detail).not.toContain('execution is STOPPED');
    // KILLS: `worker_replicas ?? 0` or `?? 1` in the released branch.
  });
});

// ---------------------------------------------------------------------------
// globalCordStatus — the HONESTY tests.
//
// Every test below names the mutation it must kill. The defect they pin: the
// panel rendered a system-wide-halt claim out of one success count, so with n8n
// unreachable the count was 0 — and the page asserted a halt anyway. The
// actuator is now the worker Deployment's `spec.replicas`, and the same
// discipline applies to it.
//
// ⭐ THE CLAIM. Exactly one verdict may carry it.
//
// ⚠️ CORRECTED 2026-09-23 — this comment used to say "Asserted as a set below,
// so adding a sixth branch that copies the sentence goes red." That overstated
// its own coverage, in the same direction as the UI defects this file exists to
// pin, so it is worth being exact about what the set test below actually does:
//
//   • It iterates a HAND-WRITTEN LIST OF FIXTURES, not the branches of
//     `globalCordStatus`. Nothing in this file enumerates its branches, and TS
//     cannot: the function returns an object literal per branch, so there is no
//     union to exhaust.
//   • It catches the sentence being copied into a branch one of those fixtures
//     already reaches. A genuinely NEW branch — a new verdict, or a new
//     sub-case inside one — is reached by no fixture here and would go green
//     carrying the claim. Adding the fixture is a manual step, and this comment
//     is the only thing that asks for it.
//
// To check the coverage claim rather than trust it: grep `verdict ===` and
// `return {` inside `globalCordStatus` in page-helpers.ts and compare the branch
// count with the fixture list in the set test below.
const CLAIM = 'halts all new work system-wide';

const ENGAGED_APPLIED: AndonGlobalState = {
  engaged: true,
  engaged_at: '2026-09-23T10:00:00Z',
  engaged_by: 'sa@example.com',
  worker_replicas: 0,
  intent: 'engaged',
  n8n_pause: {
    attempted_at: '2026-09-23T10:00:01Z',
    error: null,
    worker_replicas: 0,
  },
  n8n_live: null, // not probed
};

/** engaged + scale applied + probe measured 0 replicas → the ONLY confirmed halt. */
const CONFIRMED: AndonGlobalState = {
  ...ENGAGED_APPLIED,
  n8n_live: {
    measured_at: '2026-09-23T10:00:05Z',
    worker_replicas: 0,
    available_replicas: 0,
    error: null,
  },
};

/** engaged + the stored scale error → the n8n half never landed. */
const HALF_ENGAGED: AndonGlobalState = {
  ...ENGAGED_APPLIED,
  worker_replicas: null,
  n8n_pause: {
    attempted_at: '2026-09-23T10:00:01Z',
    error: 'k8s scale to 0 failed: 403 Forbidden',
    worker_replicas: null,
  },
};

/** engaged + the probe itself failed → PROBED AND FAILED, not "stopped". */
const PROBE_FAILED: AndonGlobalState = {
  ...ENGAGED_APPLIED,
  n8n_live: {
    measured_at: '2026-09-23T10:00:05Z',
    worker_replicas: null,
    available_replicas: null,
    error: 'socket closed unexpectedly',
  },
};

/** engaged, yet the worker is still running → the halt did not land. */
const CONTRADICTED: AndonGlobalState = {
  ...ENGAGED_APPLIED,
  n8n_live: {
    measured_at: '2026-09-23T10:00:05Z',
    worker_replicas: 1,
    available_replicas: 1,
    error: null,
  },
};

/** The singleton row could not be read — formerly indistinguishable from released. */
const UNREADABLE: AndonGlobalState = {
  engaged: false,
  engaged_at: null,
  engaged_by: null,
  worker_replicas: null,
  intent: 'unreadable',
  n8n_pause: { attempted_at: null, error: null, worker_replicas: null },
  n8n_live: null,
};

describe('globalCordStatus — only a VERIFIED halt may claim a system-wide stop', () => {
  // #1
  it('engaged with a stored scale error never claims a system-wide halt', () => {
    const s = globalCordStatus(HALF_ENGAGED);
    const rendered = `${s.detail} ${s.verification?.text ?? ''}`;
    expect(rendered).not.toContain('system-wide');
    // ...and it says WHY, naming the stored error, so the operator can act.
    expect(rendered).toContain('k8s scale to 0 failed: 403 Forbidden');
    expect(rendered).toContain('Pull again to retry the scale');
    // KILLS: dropping the `pause_attempt === 'failed'` branch from
    // andonVerdict — HALF_ENGAGED would fall through to STOPPED_CONFIRMED or
    // STOPPED_UNVERIFIED and the claim (or silence about the failure) returns.
    expect(andonVerdict(HALF_ENGAGED)).toBe('HALF_ENGAGED');
  });

  // #2
  it('a probe that threw reads as NOT VERIFIED — never as a confirmed halt', () => {
    const s = globalCordStatus(PROBE_FAILED);
    const rendered = `${s.detail} ${s.verification?.text ?? ''}`;
    expect(rendered).toContain('NOT verified');
    expect(rendered).not.toContain(CLAIM);
    // The failure reason is surfaced, and the panel explicitly refuses to let
    // "could not measure" read as "the worker is running".
    expect(s.verification?.text).toContain('socket closed unexpectedly');
    expect(s.verification?.tone).toBe('warn');
    // KILLS: defaulting `live` to 'stopped' on catch (i.e. treating
    // worker_replicas===null as 0) — the verdict would become STOPPED_CONFIRMED
    // and the claim would be printed over an unreachable API server.
    expect(andonVerdict(PROBE_FAILED)).toBe('STOPPED_UNVERIFIED');
  });

  // #3
  it('a probe measuring a RUNNING worker CONTRADICTS the halt', () => {
    const s = globalCordStatus(CONTRADICTED);
    expect(andonVerdict(CONTRADICTED)).toBe('CONTRADICTED');
    expect(s.detail).toContain('n8n-worker still reports 1 replica');
    expect(s.detail).toContain('automatic execution is NOT stopped');
    // The positive claim is absent; only its negation appears.
    expect(s.detail).not.toContain(CLAIM);
    expect(s.verification?.tone).toBe('danger');
    expect(s.verification?.text).toContain('1 replica');
    // KILLS: ignoring `worker_replicas` when `error === null` — a live
    // contradiction would be silently downgraded to STOPPED_CONFIRMED, which is
    // the single most dangerous reading on this surface.
  });

  // #3b — the absence-as-result defect, inside the struct added to prevent it.
  it('HALF_ENGAGED with an UNRECORDED replica count says so — it never prints 0', () => {
    const unrecorded = {
      ...HALF_ENGAGED,
      n8n_pause: { ...HALF_ENGAGED.n8n_pause!, worker_replicas: null },
    };
    const s = globalCordStatus(unrecorded);
    const rendered = `${s.detail} ${s.verification?.text ?? ''}`;
    expect(rendered).toContain('no n8n-worker replica count recorded');
    expect(rendered).not.toContain('n8n-worker scaled to 0');
    expect(rendered).not.toMatch(/undefined|NaN/);

    // CONTROL — a RECORDED zero still prints as a measured stop on the very
    // same branch. An attempt that genuinely measured 0 replicas is a
    // measurement, and if the fix collapsed it into "not recorded" this
    // assertion catches it.
    const recordedZero = globalCordStatus({
      ...HALF_ENGAGED,
      n8n_pause: { ...HALF_ENGAGED.n8n_pause!, worker_replicas: 0 },
    });
    expect(recordedZero.detail).toContain('execution STOPPED (n8n-worker scaled to 0)');
    expect(recordedZero.detail).not.toContain('no n8n-worker replica count recorded');

    // ...and a running worker is still named.
    expect(
      globalCordStatus({
        ...HALF_ENGAGED,
        n8n_pause: { ...HALF_ENGAGED.n8n_pause!, worker_replicas: 1 },
      }).detail,
    ).toContain('worker running (n8n-worker at 1 replica)');

    // KILLS: `?? 0` in the consumer (the `pauseEvidenceWorkerReplicasLabel` call
    // site, or inside the helper). The unrecorded case renders "scaled to 0",
    // which asserts an attempt happened and stopped the worker — and the only
    // field that could contradict it is a SIBLING.
  });

  // #4 — the constraint that outranks everything else here.
  it('EVERY stopped variant still presents as engaged (the button must read Disengage)', () => {
    const variants: Array<[string, AndonGlobalState]> = [
      ['CONFIRMED', CONFIRMED],
      ['UNVERIFIED', ENGAGED_APPLIED],
      ['HALF_ENGAGED', HALF_ENGAGED],
      ['CONTRADICTED', CONTRADICTED],
    ];
    for (const [name, v] of variants) {
      // The axis itself...
      expect(andonIntent(v), name).toBe('engaged');
      // ...and its operator-visible consequences. (Asserting `v.engaged` here
      // would only re-read the fixture, so it is deliberately omitted — these
      // three are derived by the code under test.)
      expect(globalCordStatus(v).label, name).toBe('🛑 STOPPED');
      expect(andonTitle(v).startsWith('STOPPED'), name).toBe(true);
      expect(globalCordStatus(v).tone, name).toBe('danger');
    }
    // KILLS: setting `engaged: false` (or demoting intent/label) when
    // `worker_scale_error` is present. Refusing to present as engaged is a
    // DIFFERENT lie — it invites an operator to re-pull a cord already down.
  });

  it('ONLY the confirmed verdict carries the system-wide claim', () => {
    const confirmed = globalCordStatus(CONFIRMED);
    expect(confirmed.detail).toContain(CLAIM);
    expect(confirmed.verification?.tone).toBe('ok');
    expect(confirmed.verification?.text).toContain('0 replicas');
    // Every other branch, including released and unreadable.
    for (const other of [
      ENGAGED_APPLIED,
      HALF_ENGAGED,
      PROBE_FAILED,
      CONTRADICTED,
      UNREADABLE,
      // Released with a RUNNING worker, released with the worker still at 0,
      // and released with no measurement — none may carry the claim.
      { ...ENGAGED_APPLIED, engaged: false, intent: 'released' as const, worker_replicas: 1 },
      { ...ENGAGED_APPLIED, engaged: false, intent: 'released' as const, worker_replicas: 0 },
      { ...ENGAGED_APPLIED, engaged: false, intent: 'released' as const, worker_replicas: null },
      // `null` — no cord state read at all. Added 2026-09-23 with the fix that
      // stopped that case rendering as RUNNING; before it, this case took the
      // released branch and was covered only by accident.
      null,
    ]) {
      const s = globalCordStatus(other);
      expect(`${s.detail} ${s.verification?.text ?? ''}`).not.toContain(CLAIM);
    }
    // KILLS: copying the claim string into any other branch.
  });

  it('an unreadable cord row is not reported as running', () => {
    const s = globalCordStatus(UNREADABLE);
    expect(andonVerdict(UNREADABLE)).toBe('UNREADABLE');
    expect(s.tone).toBe('warn');
    expect(s.label).toBe('⚠ UNKNOWN');
    expect(s.label).not.toBe('✓ Running');
    expect(s.detail).toContain('could not be read');
    // KILLS: checking `!state.engaged` before `intent === 'unreadable'` — the
    // unreadable row carries engaged:false for fail-open back-compat, so an
    // order swap paints "✓ Running" over a cord whose state is unknown.
  });

  it('a released cord with a running worker has nothing to verify', () => {
    const s = globalCordStatus({ ...ENGAGED_APPLIED, engaged: false, intent: 'released', worker_replicas: 1 });
    expect(s.tone).toBe('ok');
    expect(s.verification).toBeNull();
  });

  it('a legacy payload (no verification blocks) is UNVERIFIED, not confirmed', () => {
    // Rolling deploy / pre-upgrade backend: absence of evidence is not evidence
    // of failure, and equally not evidence of a verified halt.
    const legacy: AndonGlobalState = {
      engaged: true,
      engaged_at: null,
      engaged_by: null,
      worker_replicas: 0,
    };
    expect(andonVerdict(legacy)).toBe('STOPPED_UNVERIFIED');
    const s = globalCordStatus(legacy);
    expect(s.detail).not.toContain(CLAIM);
    expect(s.label).toBe('🛑 STOPPED');
    // It must NOT be reported as "no n8n-worker scale was ever recorded" —
    // nothing was measured either way.
    expect(`${s.detail} ${s.verification?.text ?? ''}`).not.toContain('never');
  });
});

// ---------------------------------------------------------------------------
// The tones must be as distinguishable on screen as they are in the logic.
//
// THE DEFECT THESE PIN: +page.svelte wrote every tone-driven class as a
// two-armed ternary testing for 'ok' and falling through to the danger classes.
// `globalCordStatus` returns THREE tones, so `warn` — "we could not read this"
// and "this halt is merely unconfirmed" — rendered pixel-identical to `danger`,
// a MEASURED live contradiction. Three computed states, two visible ones. The
// class strings now live in ANDON_TONE_SURFACE / ANDON_TONE_TEXT, keyed on the
// tone union, and the page indexes them (grep ANDON_TONE_ in +page.svelte).
// ---------------------------------------------------------------------------
describe('ANDON_TONE_* — three computed tones must be three visible tones', () => {
  const TONES: AndonTone[] = ['ok', 'warn', 'danger'];

  it('no two tones share a surface or a text class', () => {
    for (const record of [ANDON_TONE_SURFACE, ANDON_TONE_TEXT]) {
      const rendered = TONES.map((t) => record[t]);
      expect(new Set(rendered).size).toBe(TONES.length);
      // Every tone must actually be styled — an empty string would be
      // "distinct" while rendering as unstyled default text.
      for (const cls of rendered) expect(cls.length).toBeGreaterThan(0);
    }
    // KILLS: pasting the danger class string into the `warn` slot of either
    // record — which is exactly what the page's two-armed ternary used to do to
    // `warn` before these records existed. Also kills `warn: ''`.
  });

  it('an unread cord does not render like a measured contradiction', () => {
    const unknown = globalCordStatus(null, 0);
    const contradicted = globalCordStatus(CONTRADICTED);
    expect(unknown.tone).toBe('warn');
    expect(contradicted.tone).toBe('danger');
    expect(ANDON_TONE_SURFACE[unknown.tone]).not.toBe(
      ANDON_TONE_SURFACE[contradicted.tone],
    );
    expect(ANDON_TONE_TEXT[unknown.tone]).not.toBe(
      ANDON_TONE_TEXT[contradicted.tone],
    );
    // POSITIVE CONTROL: the records are not simply returning something
    // different for every call — the SAME tone maps to the SAME classes, so the
    // inequality above is about the tones and not about the lookup.
    expect(ANDON_TONE_SURFACE[unknown.tone]).toBe(ANDON_TONE_SURFACE.warn);
    expect(ANDON_TONE_SURFACE[contradicted.tone]).toBe(ANDON_TONE_SURFACE.danger);
    // KILLS: `tone: 'danger'` on the UNREADABLE branch of globalCordStatus, and
    // (as above) making the warn classes equal the danger ones.
  });

  it('a merely-unconfirmed halt does not render like a contradicted one', () => {
    // Same panel, second line. PROBE_FAILED is engaged + scale applied + a probe
    // that THREW: unknown, not refuted.
    const unverified = globalCordStatus(PROBE_FAILED).verification!;
    const contradicted = globalCordStatus(CONTRADICTED).verification!;
    expect(unverified.tone).toBe('warn');
    expect(contradicted.tone).toBe('danger');
    expect(ANDON_TONE_TEXT[unverified.tone]).not.toBe(
      ANDON_TONE_TEXT[contradicted.tone],
    );
    // POSITIVE CONTROL: a verification line that genuinely IS good renders in
    // the success colour, so "the three differ" is not vacuously true by every
    // verification line being amber.
    const confirmed = globalCordStatus(CONFIRMED).verification!;
    expect(confirmed.tone).toBe('ok');
    expect(ANDON_TONE_TEXT[confirmed.tone]).toContain('--color-success');
    // KILLS: collapsing the verification tone union to 'ok' | 'danger' and
    // sending STOPPED_UNVERIFIED / UNREADABLE to 'danger'.
  });

  it('a released cord whose worker is still at 0 renders in the DANGER tone', () => {
    const stopped = globalCordStatus({ ...ENGAGED_APPLIED, engaged: false, intent: 'released', worker_replicas: 0 });
    expect(stopped.tone).toBe('danger');
    expect(ANDON_TONE_SURFACE[stopped.tone]).toBe(ANDON_TONE_SURFACE.danger);
    // ...while an unmeasured one is merely warn — "we cannot see" is not
    // "we measured a stop".
    const unknown = globalCordStatus({ ...ENGAGED_APPLIED, engaged: false, intent: 'released', worker_replicas: null });
    expect(unknown.tone).toBe('warn');
  });
});

describe('andonHistoryLabel', () => {
  const engage: AndonHistoryEntry = {
    id: 'a',
    engaged: true,
    changed_at: '2026-06-24T10:00:00Z',
    changed_by: 'admin@example.com',
  };

  it('labels an engage as the dangerous transition', () => {
    const out = andonHistoryLabel(engage);
    expect(out.tone).toBe('danger');
    expect(out.label).toBe('🛑 Engaged');
  });

  it('labels a release as the safe transition', () => {
    const out = andonHistoryLabel({ ...engage, engaged: false, changed_by: null });
    expect(out.tone).toBe('ok');
    expect(out.label).toBe('✓ Released');
  });
});

describe('inflightLabel', () => {
  it('null count (n8n unreachable) reads as unavailable — never "complete"', () => {
    const out = inflightLabel({ running_count: null, capped: false });
    expect(out.tone).toBe('warn');
    expect(out.text).toContain('unavailable');
  });

  it('treats a fully-null inflight object as unavailable', () => {
    expect(inflightLabel(null).tone).toBe('warn');
  });

  it('zero running means the drain is complete', () => {
    const out = inflightLabel({ running_count: 0, capped: false });
    expect(out.tone).toBe('ok');
    expect(out.text).toContain('drain complete');
  });

  it('reports a positive draining count (plural)', () => {
    const out = inflightLabel({ running_count: 3, capped: false });
    expect(out.tone).toBe('warn');
    expect(out.text).toContain('3 executions still running');
  });

  it('singularizes one draining execution', () => {
    const out = inflightLabel({ running_count: 1, capped: false });
    expect(out.text).toContain('1 execution still running');
    expect(out.text).not.toContain('1 executions');
  });

  it('shows a capped count as N+', () => {
    const out = inflightLabel({ running_count: 250, capped: true });
    expect(out.text).toContain('250+');
  });
});

// ---------------------------------------------------------------------------
// FRESHNESS OF THE VERIFICATION LINE — the reader for `n8n_live.measured_at`.
//
// ⚠️ THE DEFECT THIS PINS: `measured_at` was produced by the live probe,
// declared on `AndonLiveProbe` (lib/components/andon-cord-helpers.ts) and read
// by NOTHING. STOPPED_CONFIRMED is the one branch permitted to print
// `SYSTEM_WIDE_HALT_CLAIM`, and it earns that from a SINGLE live probe. Without
// an age, "✓ Verified — n8n-worker independently reports 0 replicas." read
// identically whether that probe was two seconds or twenty minutes old, and
// only one of those justifies trusting it.
//
// TO MAKE THIS BLOCK GO RED: drop the `${age ? …}` interpolation from the
// STOPPED_CONFIRMED verification text in page-helpers.ts, or `return null` from
// `liveProbeAgeLabel`.
// ---------------------------------------------------------------------------

describe('the verification line dates its own measurement', () => {
  // Real clock: the probe is re-stamped relative to Date.now().
  const stamped = (st: AndonGlobalState, msAgo: number): AndonGlobalState => ({
    ...st,
    n8n_live: { ...st.n8n_live!, measured_at: new Date(Date.now() - msAgo).toISOString() },
  });
  /** A released cord with a running worker — nothing to verify, nothing to date. */
  const RELEASED: AndonGlobalState = {
    ...CONFIRMED,
    engaged: false,
    intent: 'released',
    worker_replicas: 1,
  };

  it('a CONFIRMED halt says how old its verification is', () => {
    const v = globalCordStatus(stamped(CONFIRMED, 7 * 60_000), 0).verification!;
    expect(v.tone).toBe('ok');
    expect(v.text).toContain('0 replicas');
    expect(v.text).toContain('measured 7m ago');
    // CONTROL: the age is computed, not a constant — a nearer probe reads nearer.
    const fresh = globalCordStatus(stamped(CONFIRMED, 12_000), 0).verification!;
    expect(fresh.text).toContain('measured 12s ago');
    expect(fresh.text).not.toContain('7m');
  });

  it('a CONTRADICTED halt dates the contradiction too', () => {
    const v = globalCordStatus(stamped(CONTRADICTED, 7 * 60_000), 0).verification!;
    expect(v.tone).toBe('danger');
    expect(v.text).toContain('1 replica');
    expect(v.text).toContain('measured 7m ago');
  });

  it('⛔ a branch with NO probe invents no age', () => {
    // ENGAGED_APPLIED has `n8n_live: null` (NOT PROBED) and UNREADABLE never
    // probes. Neither may acquire a freshness clause: there is nothing to be
    // fresh. This is the assertion that stops the two above from passing on a
    // suffix appended unconditionally.
    for (const [name, st] of [
      ['not probed', ENGAGED_APPLIED],
      ['unreadable', UNREADABLE],
      ['released', RELEASED],
    ] as const) {
      const v = globalCordStatus(st, 0).verification;
      const text = v?.text ?? '';
      expect(text, name).not.toContain('measured');
      expect(text, name).not.toContain('ago');
      expect(text, name).not.toContain('probe time');
    }
  });

  it('⛔ no rendered verification line can leak NaN, undefined or a bare 0s', () => {
    // Every cord state this module can render, with the probe behind the clock
    // (the skew case), ahead of it, and at it.
    for (const msAgo of [7 * 60_000, -10 * 60_000, 0]) {
      const probed = [CONFIRMED, CONTRADICTED, PROBE_FAILED, HALF_ENGAGED].map((st) =>
        st.n8n_live ? stamped(st, msAgo) : st,
      );
      for (const st of [...probed, ENGAGED_APPLIED, UNREADABLE, RELEASED, null]) {
        const s = globalCordStatus(st, 0);
        const rendered = `${s.label} ${s.detail} ${s.verification?.text ?? ''}`;
        expect(rendered).not.toContain('NaN');
        expect(rendered).not.toContain('undefined');
        expect(rendered).not.toContain('measured 0s');
        expect(rendered).not.toMatch(/measured -\d/);
      }
    }
    // ⭐ And the skew case is not silently swallowed: a probe stamped AHEAD of
    // the reader's clock says so instead of printing an age.
    const skewed = globalCordStatus(stamped(CONFIRMED, -10 * 60_000), 0).verification!;
    expect(skewed.text).toContain('AHEAD of this clock');
    // KILLS: `measured ${(now - Date.parse(measured_at)) / 1000}s ago` with no
    // sign check, which renders a negative age here; and the `?? ''` /
    // `?? 0` shortcuts for an absent timestamp, which render NaN.
  });
});
