// src/lib/andon-gate-metrics.ts
//
// ⛔ WHAT THIS COUNTS: an answer the GLOBAL ANDON INTERLOCK gave to a caller
// that was about to start work — today `GET /api/internal/andon`, the consult
// n8n workflows make before they run.
//
// MEASURED 2026-09-23: nothing anywhere held a number for this. The interlock
// answered `{engaged:false}` for a MISSING singleton row and threw a 500 when
// the read failed, and both of those are invisible events: n8n reads the body,
// proceeds, and fr writes nothing. So the one surface whose whole job is to
// stop work could be answering "go ahead" for a reason nobody would ever see.
//
// ⚠️ AN ANSWER IS NOT AUTOMATICALLY A FAULT, and this counter deliberately does
// not decide that. `answer="released"`/`reason="released"` is the normal path
// and is the DENOMINATOR — without it, a burst of `reason="unreadable"` cannot
// be told apart from a quiet system. `reason` is what separates the cases after
// the fact: `engaged` is a human pulling the cord, `released` is ordinary
// traffic, `unreadable` is fr failing CLOSED on an UNKNOWN state, and
// `uninitialised` is an absent singleton.
//
// ⭐ `uninitialised` IS THE PAIR WORTH THE WHOLE MODULE. It rides on
// `answer="released"` — a fault that does NOT refuse, because the shared gate
// reads an absent row as "nobody pulled the cord" and this interlock must not
// be stricter than the chokepoints it speaks for. Counted but permitted, so it
// is invisible in every other signal: no refusal, no error status, nothing for
// an operator to notice. That is exactly the shape of thing a counter is for.
//
// ⛔ THE COUNTER IS THE DURABLE HALF, NOT THE LOG. Prometheus scrapes
// `/api/metrics/prom` and retains, so the counter is what survives a pod
// restart and what an alert can be written against.
//
// ⚠️ DELIBERATE DEVIATION from lib/conveyor-refusal-metrics.ts, which logs one
// line per event: this surface is POLLED (every n8n workflow start consults
// it), so a line per answer would be per-request log spam and would bury the
// case a human needs. The log line is emitted for the two FAULT reasons —
// `unreadable` and `uninitialised` — whose cause lives outside this process,
// and never for `engaged`/`released`, which are the system working. The COUNTER
// is incremented for every answer, unconditionally, because the normal path is
// the denominator.
//
// Cardinality: answer x reason, both CLOSED sets. An unrecognised value
// collapses to `other` rather than minting a series.
//
// ⛔ THE ZERO BASELINE IS REAL, BUT THE PRE-SEED IS NOT WHAT DELIVERS IT, and an
// earlier draft of this note claimed it was ("a series that only appears once it
// fires cannot be distinguished from an exporter that is not wired up", written
// beside the seed loop below). MEASURED by an adversarial validator: deleting the
// seed loop entirely leaves `renderAndonGateMetrics`'s exposition BYTE-IDENTICAL,
// because that function walks the two closed sets and reads each counter as
// `answers.get(k) ?? 0`. The renderer is the guarantor; the seed is redundant to
// it. The claim was therefore load-bearing for a reader and load-bearing for
// nothing else — exactly the defect class this module's own comments police, so
// it is retracted here rather than left to be believed.
//
// The seed loop is KEPT, and its honest job is narrower: it makes the map's key
// set the full cross product from a cold import, which is what
// `__andonGateAnswersForTests()` reads directly (without it a never-fired pair
// reads `undefined` there rather than `0`), and it fixes the map's insertion
// order. The PROMETHEUS zero baseline is pinned where it is actually produced —
// `tests/unit/lib/andon-gate-metrics.test.ts` asserts the renderer emits all
// `ANDON_GATE_ANSWERS × ANDON_GATE_REASONS` series from a cold counter, and that
// assertion reddens when the renderer stops emitting unfired pairs. Do not move
// that guarantee back into a comment.
//
// ⚠️ CORRECTED before merge by a PR auditor. An earlier draft of this note said
// `answer="released"` carries ONLY `released` or `uninitialised`, and that a
// nonzero `released|unreadable` "would mean the fail-closed conversion had been
// inverted". **That is wrong, and it would have made an operator misdiagnose a
// benign transient as an inverted safety gate.**
//
// `released|unreadable` is REACHABLE, two ways, both by design:
//   1. the gate read succeeds and says released, while the REASON read
//      (`readAndon`) throws  ⇒ engaged=false, reason='unreadable';
//   2. the gate says released while the row reads engaged — the two reads
//      disagree, which routes/andon.ts documents as an expected transient.
// In both the halt decision is correct (the gate is the only input); only the
// PRECISION of the reason is degraded. Read it as "the reason axis could not
// corroborate", not as a safety failure.
//
// The one pair that IS structurally impossible is `engaged|uninitialised`: the
// gate maps an absent row to NOT engaged, so absence can never become a halt.
// A nonzero count there is a real finding — it would mean absence had been
// promoted into a halt the chokepoints do not honour.
//
// Lives in `lib/` for the same reason conveyor-refusal-metrics.ts does: it must
// not transitively import `db/client`, so the route unit tests can read it
// without a database.

/** What the interlock actually answered: `engaged:true` or `engaged:false`. */
export const ANDON_GATE_ANSWERS = ['engaged', 'released'] as const;
export type AndonGateAnswer = (typeof ANDON_GATE_ANSWERS)[number];

/**
 * WHY it answered that.
 *
 * ⚠️ Mirrors `AndonInterlockReason` in routes/andon.ts by VALUE, not by import —
 * this module must stay a leaf (see the header). A value that drifts out of this
 * set collapses to `other` instead of minting a series, so a rename there shows
 * up as a rising `other` rather than as silence.
 */
export const ANDON_GATE_REASONS = [
  /** A definite read of `engaged=true` — a super-admin pulled the cord. */
  'engaged',
  /** A definite read of `engaged=false` — the normal path, and the denominator. */
  'released',
  /**
   * The state is UNKNOWN: the read threw, or the two reads disagreed.
   *
   * ⚠️ It does NOT always accompany `answer="engaged"` — an earlier draft said
   * so and was wrong. When the GATE read succeeds and says released but the
   * reason read throws or disagrees, this pairs with `answer="released"`: the
   * halt decision is still correct (the gate is its only input) and only the
   * reason's precision is lost. A step change paired with `engaged` is work
   * being refused for an infrastructure reason rather than an operator one;
   * paired with `released` it is reason-axis noise, not a refusal.
   */
  'unreadable',
  /**
   * A DEFINITE read of an ABSENT `andon_state` singleton. Migration 065 inserts
   * it, so a nonzero count here is a broken install, not a pulled cord.
   *
   * ⛔ Deliberately NOT folded into `unreadable`, and deliberately NOT a halt:
   * it accompanies `answer="released"`, because that is what the shared gate
   * answers and the interlock must not be stricter than the chokepoints it
   * speaks for. This series exists precisely so that absence is visible while
   * still being the permissive answer — the one case where "counted but not
   * refused" is the correct pair.
   */
  'uninitialised',
  'other',
] as const;
export type AndonGateReason = (typeof ANDON_GATE_REASONS)[number];

const key = (a: AndonGateAnswer, r: AndonGateReason): string => `${a}|${r}`;

const answers = new Map<string, number>();
// Seeds the full key set at import. NOT the thing that puts zeros in the
// exposition — `renderAndonGateMetrics` does that on its own. See the header.
for (const a of ANDON_GATE_ANSWERS) {
  for (const r of ANDON_GATE_REASONS) answers.set(key(a, r), 0);
}

/**
 * ⛔ THE UNKNOWN-VALUE FALLBACK IS `engaged` ON PURPOSE, AND THE DIRECTION IS THE
 * WHOLE POINT. This module counts the answers of the interlock that decides
 * whether work may START. A value outside `ANDON_GATE_ANSWERS` means the caller
 * and this leaf module have drifted, i.e. we do not know what was answered; the
 * safe way to record an unknown halt-decision is as a HALT, because the opposite
 * mistake buries a refusal inside the `released` denominator, where nothing
 * distinguishes it from ordinary traffic.
 *
 * ⚠️ Honest about reachability: `recordAndonGateAnswer` / `reportAndonGateAnswer`
 * both take `AndonGateAnswer`, so TypeScript makes this branch UNREACHABLE from
 * every caller in this repo (`routes/andon.ts:1141` passes a typed boolean
 * ternary). It is reachable only from untyped JS or a future `as` cast — low
 * severity, which is why this is a pinned default rather than a thrown error. It
 * is pinned anyway because a safety default that no test reads is a default that
 * can be flipped by anyone, in either direction, and read as green: a validator
 * measured exactly that (`'engaged'` → `'released'`, suite GREEN).
 * `tests/unit/lib/andon-gate-metrics.test.ts` now reddens on that flip.
 */
function normaliseAnswer(answer: string): AndonGateAnswer {
  return (ANDON_GATE_ANSWERS as readonly string[]).includes(answer)
    ? (answer as AndonGateAnswer)
    : 'engaged';
}

function normaliseReason(reason: string): AndonGateReason {
  return (ANDON_GATE_REASONS as readonly string[]).includes(reason)
    ? (reason as AndonGateReason)
    : 'other';
}

/** Increment only. Exported for callers that emit their own line. */
export function recordAndonGateAnswer(
  answer: AndonGateAnswer,
  reason: AndonGateReason,
): void {
  const k = key(normaliseAnswer(answer), normaliseReason(reason));
  answers.set(k, (answers.get(k) ?? 0) + 1);
}

export interface AndonGateAnswerDetail {
  answer: AndonGateAnswer;
  reason: AndonGateReason;
  /** Why the read failed, when it did. Named in the log line, never in a label. */
  error?: string | null;
  /** Free-form, log-only. Keep it short and factual. */
  detail?: Record<string, unknown>;
}

/** The reasons that name a fault outside this process. See the header. */
const LOGGED_REASONS: readonly AndonGateReason[] = ['unreadable', 'uninitialised'];

/**
 * Count every answer, and emit one structured line for the fault reasons.
 *
 * ⛔ Never throws. Recording an interlock answer must not itself become a
 * failure — this runs on the path that decides whether work may start, and a
 * throw here would turn a correct refusal into an undiagnosable 500.
 */
export function reportAndonGateAnswer(d: AndonGateAnswerDetail): void {
  try {
    const reason = normaliseReason(d.reason);
    recordAndonGateAnswer(d.answer, reason);
    if (!LOGGED_REASONS.includes(reason)) return;
    console.error(
      JSON.stringify({
        telemetry: 'andon_gate_fault',
        answer: normaliseAnswer(d.answer),
        reason,
        error: d.error ?? null,
        ...(d.detail ?? {}),
      }),
    );
  } catch {
    // Deliberately silent: see above.
  }
}

/** Prometheus text-exposition lines. Rendered by routes/metrics.ts. */
export function renderAndonGateMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_andon_gate_total Global andon interlock answers, by answer and reason.',
    '# TYPE fr_andon_gate_total counter',
  ];
  for (const a of ANDON_GATE_ANSWERS) {
    for (const r of ANDON_GATE_REASONS) {
      lines.push(
        `fr_andon_gate_total{answer="${a}",reason="${r}"} ${answers.get(key(a, r)) ?? 0}`,
      );
    }
  }
  return lines;
}

