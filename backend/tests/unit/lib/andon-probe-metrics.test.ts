// tests/unit/lib/andon-probe-metrics.test.ts
//
// fr#1195 — the chokepoint brake's own health series, and the ONE constraint that
// no diff can catch.
//
// ⭐ WHY THE `fr_andon_engaged` BLOCK IS THE MOST IMPORTANT THING IN THIS FILE.
// Two live Prometheus rules consume `fr_andon_engaged` as EXACTLY "is the cord
// pulled", and one of them GATES a second alert on `== 1`. Making it tri-state, or
// giving it a label, would leave the rule FILE byte-identical while silently
// turning that gate into a permanent suppression of the alert it exists to gate.
// So the regression is not expressible as a review of the rules and not visible in
// a diff of them: it has to be pinned HERE, against the rendered exposition, as
// "every sample of this series is the literal `0` or the literal `1`, unlabelled,
// and there is at most one of them".
//
// ⛔ ASSERTING `toContain('fr_andon_engaged 0')` WOULD BE VACUOUS FOR THAT. It
// stays green for a renderer that ALSO emits `fr_andon_engaged{caller="x"} 2`,
// which is the whole regression. The assertions below therefore EXTRACT every
// matching line and compare the SET, so an extra sample or a labelled variant
// reddens.
//
// ⚠️ Deliberately a plain `test()` file with no database and no reachability
// guard, for the same reason `andon-gate-metrics.test.ts` is: an
// `ifReachable` idiom records a SKIP as a PASS, and a skip
// here would silently retire the constraint above.
//
// The counters, the shared streak and the CALLER REGISTRY are module-level state
// shared across every file in a `bun test` run, and there is no test-only reset.
// So: the streak is cleared before each body with `resetAndonProbeStreak` — the
// PRODUCTION clear (routes/andon.ts calls it on a definite cord read) — counters
// are asserted on callers no other file reports, or relative to a before-count.

import { beforeEach, expect, test } from 'bun:test';

import {
  ANDON_HALT_CAUSES,
  normaliseAndonCaller,
  publishAndonKataHoldersForMetrics,
  publishAndonStateForMetrics,
  recordAndonHalt,
  renderAndonHaltMetrics,
  renderAndonProbeMetrics,
  reportAndonProbeUnreadable,
  resetAndonProbeStreak,
} from '../../../src/lib/andon-halt-metrics';



/** Every SAMPLE line of `name`, metadata excluded, labelled variants INCLUDED. */
const samplesOf = (lines: string[], name: string): string[] =>
  lines.filter((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));

const metaOf = (lines: string[], name: string): string[] =>
  lines.filter((l) => l.startsWith(`# HELP ${name} `) || l.startsWith(`# TYPE ${name} `));

// The streak is a shared MAX: a higher value reported by an earlier body (in any
// order) would otherwise mask the value a body asserts.
beforeEach(() => resetAndonProbeStreak());

// ───────────────────────────── THE THREE NEW SERIES ──────────────────────────

test('a reported failed read emits all three new series, with the caller attributed', () => {
  reportAndonProbeUnreadable({ caller: 'AA-Pattern-Done-Finalize', consecutive: 3, halted: true });
  const lines = renderAndonProbeMetrics();

  // The failed-read counter, on the reporting caller.
  expect(samplesOf(lines, 'fr_andon_probe_unreadable_total')).toContain(
    'fr_andon_probe_unreadable_total{caller="AA-Pattern-Done-Finalize"} 1',
  );
  // `halted: true` is what makes it a HALT as well as a failed read, and the cause
  // must be `unreadable` — nobody pulled the cord.
  expect(samplesOf(lines, 'fr_andon_halt_total')).toContain(
    'fr_andon_halt_total{cause="unreadable",caller="AA-Pattern-Done-Finalize"} 1',
  );
  // ...and NOT as `pulled`, which would misattribute a fail-closed halt to an
  // operator decision. Pinned explicitly: the two causes are the whole point of
  // the label, so a renderer that counted both would read green on the line above.
  expect(samplesOf(lines, 'fr_andon_halt_total')).toContain(
    'fr_andon_halt_total{cause="pulled",caller="AA-Pattern-Done-Finalize"} 0',
  );
  expect(samplesOf(lines, 'fr_andon_probe_unreadable_streak')).toEqual([
    'fr_andon_probe_unreadable_streak 3',
  ]);

  // Types, because a counter rendered as a gauge breaks `rate()` silently.
  expect(metaOf(lines, 'fr_andon_halt_total')).toContain('# TYPE fr_andon_halt_total counter');
  expect(metaOf(lines, 'fr_andon_probe_unreadable_total')).toContain(
    '# TYPE fr_andon_probe_unreadable_total counter',
  );
  expect(metaOf(lines, 'fr_andon_probe_unreadable_streak')).toContain(
    '# TYPE fr_andon_probe_unreadable_streak gauge',
  );
});

test('an operator-pulled halt is counted as cause="pulled" on the asking caller', () => {
  recordAndonHalt('pulled', 'AA-Activity-Action');
  const halts = samplesOf(renderAndonProbeMetrics(), 'fr_andon_halt_total');

  expect(halts).toContain('fr_andon_halt_total{cause="pulled",caller="AA-Activity-Action"} 1');
  expect(halts).toContain('fr_andon_halt_total{cause="unreadable",caller="AA-Activity-Action"} 0');
  // Both causes exist for every known caller, so a dashboard can take the ratio
  // "how many of this workflow's halts did nobody choose" from the start.
  expect(ANDON_HALT_CAUSES).toEqual(['pulled', 'unreadable']);
});

// ──────────────────── THE `caller` LABEL IS A CARDINALITY BOMB ────────────────

test('caller charset is restricted, so no wire value can forge a label or break the format', () => {
  // ⛔ THIS IS THE ESCAPING STORY, and it is why there is no escape function to
  // get wrong. A value that cannot contain `"`, `\` or a newline cannot terminate
  // the label early, inject a second label, or split the sample into two lines.
  const hostile = 'a"b\\c\nd e{f}g,h=i';
  const safe = normaliseAndonCaller(hostile);

  expect(safe).not.toContain('"');
  expect(safe).not.toContain('\\');
  expect(safe).not.toContain('\n');
  expect(safe).not.toContain('{');
  expect(safe).not.toContain('=');
  expect(safe).toMatch(/^[A-Za-z0-9_.:-]+$/);

  // The metric state is process-global (no reset hook), so count relative to before.
  const before = samplesOf(renderAndonProbeMetrics(), 'fr_andon_probe_unreadable_total').length;
  reportAndonProbeUnreadable({ caller: `${hostile}-${crypto.randomUUID()}`, consecutive: 1, halted: false });
  const lines = renderAndonProbeMetrics();
  // Exactly ONE sample gained, and every emitted line is still one well-formed
  // sample — the property a naive `caller` pass-through would break.
  expect(samplesOf(lines, 'fr_andon_probe_unreadable_total')).toHaveLength(before + 1);
  for (const line of samplesOf(lines, 'fr_andon_probe_unreadable_total')) {
    expect(line).toMatch(/^fr_andon_probe_unreadable_total\{caller="[A-Za-z0-9_.:-]+"\} \d+$/);
  }
});

// ═══════════ THE CONSTRAINT: `fr_andon_engaged` IS UNTOUCHED (0 or 1) ═════════

/**
 * Drive every fr#1195 path that could plausibly have leaked into the cord gauge,
 * then hand back the WHOLE andon exposition.
 */
const exerciseProbeThenRenderAll = (): string[] => {
  reportAndonProbeUnreadable({ caller: 'brake-a', consecutive: 12, halted: true });
  reportAndonProbeUnreadable({ caller: 'brake-b', consecutive: 4, halted: false });
  recordAndonHalt('pulled', 'brake-a');
  return [...renderAndonHaltMetrics(), ...renderAndonProbeMetrics()];
};

test('fr_andon_engaged stays a single UNLABELLED 0-or-1 sample through every probe path', () => {
  publishAndonStateForMetrics({ engaged: false, reason: 'released' });
  const released = exerciseProbeThenRenderAll();

  // ⛔ THE SET, not `toContain`. A renderer that also emitted a labelled or
  // third-valued variant would satisfy a `toContain` and fail here.
  expect(samplesOf(released, 'fr_andon_engaged')).toEqual(['fr_andon_engaged 0']);
  expect(metaOf(released, 'fr_andon_engaged')).toHaveLength(2);
  expect(metaOf(released, 'fr_andon_engaged')).toContain('# TYPE fr_andon_engaged gauge');

  publishAndonStateForMetrics({ engaged: true, reason: 'engaged' });
  const engaged = exerciseProbeThenRenderAll();
  expect(samplesOf(engaged, 'fr_andon_engaged')).toEqual(['fr_andon_engaged 1']);

  // No third value, no label, no second sample — in either state.
  for (const body of [released, engaged]) {
    for (const line of samplesOf(body, 'fr_andon_engaged')) {
      expect(line).toMatch(/^fr_andon_engaged (0|1)$/);
    }
    expect(body.filter((l) => l.startsWith('fr_andon_engaged{'))).toEqual([]);
  }
});

test('an UNNAMEABLE cord state still omits the fr_andon_engaged sample, probe traffic notwithstanding', () => {
  // The fabricated-zero defect in its most tempting form: the probe series are all
  // live and emitting, so a renderer that "filled in" the missing cord sample for
  // tidiness would look consistent and would report RELEASED for "cannot tell".
  publishAndonStateForMetrics({ engaged: true, reason: 'unreadable' });
  const lines = exerciseProbeThenRenderAll();

  expect(samplesOf(lines, 'fr_andon_engaged')).toEqual([]);
  expect(samplesOf(lines, 'fr_andon_state_readable')).toEqual(['fr_andon_state_readable 0']);
  // ...while the fr#1195 series ARE present, which is the point: the new signals
  // must not be able to substitute for, or paper over, the cord's own honesty.
  expect(samplesOf(lines, 'fr_andon_probe_unreadable_streak')).toEqual([
    'fr_andon_probe_unreadable_streak 12',
  ]);
});

test('the fr#1195 renderer cannot emit any pre-existing andon series name', () => {
  // ⭐ A CONTAINMENT ASSERTION, and it is the one that survives a refactor. Every
  // test above pins a value; this one pins the BOUNDARY, so folding the new series
  // into the old renderer (or vice versa) reddens even if every value is right.
  const probe = exerciseProbeThenRenderAll().length; // warm the caches first
  expect(probe).toBeGreaterThan(0);

  // ⚠️ `# HELP` lines are EXCLUDED, and the exclusion is a finding rather than a
  // convenience: this assertion first went RED because `fr_andon_halt_total`'s HELP
  // text CROSS-REFERENCES `fr_andon_engaged` in prose ("Does NOT say whether the
  // cord is pulled right now — that is fr_andon_engaged"). That prose is correct
  // and worth keeping. What must not exist is a SAMPLE or a TYPE declaration for
  // another series, because those are what Prometheus ingests and what a rule
  // resolves — a documentation sentence changes no series. Scoping the check to
  // them keeps it about the boundary instead of about wording.
  const probeOnly = renderAndonProbeMetrics()
    .filter((l) => !l.startsWith('# HELP '))
    .join('\n');

  for (const name of [
    'fr_andon_engaged',
    'fr_andon_state_readable',
    'fr_andon_state_age_seconds',
    'fr_andon_unrestored_workflows',
    'fr_andon_state_initialised',
    'fr_andon_brake_total',
    'fr_andon_gate_total',
  ]) {
    expect(probeOnly).not.toContain(name);
  }
});

// ═══════════ fr_andon_kata_holders (George 2026-11-03: a kata holds the instance) ═════════

test('fr_andon_kata_holders: the holder count when the cord is known, NO SAMPLE when it is not', () => {
  publishAndonStateForMetrics({ engaged: false, reason: 'released', kataHolders: 2 });
  let lines = renderAndonHaltMetrics();
  expect(samplesOf(lines, 'fr_andon_kata_holders')).toEqual(['fr_andon_kata_holders 2']);
  expect(metaOf(lines, 'fr_andon_kata_holders')).toContain('# TYPE fr_andon_kata_holders gauge');

  // A known observation that did not read the holders keeps the last count.
  publishAndonStateForMetrics({ engaged: false, reason: 'released' });
  expect(samplesOf(renderAndonHaltMetrics(), 'fr_andon_kata_holders')).toEqual(['fr_andon_kata_holders 2']);

  // Unknown cord: omitted, never a fabricated 0 (which would re-arm the worker-stopped alert).
  publishAndonStateForMetrics({ engaged: true, reason: 'unreadable', kataHolders: 2 });
  lines = renderAndonHaltMetrics();
  expect(samplesOf(lines, 'fr_andon_kata_holders')).toEqual([]);
  expect(metaOf(lines, 'fr_andon_kata_holders')).toHaveLength(2);
  publishAndonStateForMetrics(null);
  expect(samplesOf(renderAndonHaltMetrics(), 'fr_andon_kata_holders')).toEqual([]);

  // The scrape-time refresher: a count, or no sample for an absent/unreadable row.
  publishAndonKataHoldersForMetrics(0);
  expect(samplesOf(renderAndonHaltMetrics(), 'fr_andon_kata_holders')).toEqual(['fr_andon_kata_holders 0']);
  publishAndonKataHoldersForMetrics(null);
  expect(samplesOf(renderAndonHaltMetrics(), 'fr_andon_kata_holders')).toEqual([]);
});
