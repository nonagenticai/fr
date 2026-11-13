// @vitest-environment jsdom
//
// src/lib/approvals/rationale.test.ts
// ==================================
// Tests for `$lib/approvals/rationale.ts` — the frontend half of the
// absence-marker contract.
//
// ⛔ WHY THIS FILE IS NOT OPTIONAL. `rationale.ts` is a GOVERNANCE SURFACE, not
// a formatter. It decides whether an approver is shown "a worker explained this
// change" or "nobody explained this change". Before this file existed, every
// `producerRationale(x)` call in the app could have been reverted to a bare `x`
// and NOTHING in the suite would have gone red — the implementation shipped
// entirely unexercised. Three separate properties are asserted here and each
// one guards a different way the feature can silently die:
//
//   (A) the classifier itself           → describe('NO_RATIONALE_MARKER' / …)
//   (B) it NEVER synthesises rationale  → describe('never derives absence text …')
//   (C) the renderers actually route
//       through it                      → describe('renderer sites …')
//   (D) the mirrored constant stays in
//       lockstep with the backend       → describe('frontend/backend constant …')
//
// (C) is the one that makes a revert go red, and (D) is the one that catches a
// well-meaning edit to either copy of a constant that is duplicated across two
// runtimes on purpose (see the header of `rationale.ts`).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

import BlockedGateSection from '$lib/cards/sections/BlockedGateSection.svelte';

import {
  NO_RATIONALE_MARKER,
  NO_RATIONALE_SHORT,
  UNREADABLE_OUTPUT_MARKER,
  isNoRationaleSupplied,
  markUnreadableProducerOutput,
  producerRationale,
} from './rationale';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

// A realistic absence value: exactly what `backend/src/lib/approval-rationale.ts
// :: noRationaleSupplied()` writes into the column. Deliberately spelled out
// here rather than imported — the frontend must be able to recognise it WITHOUT
// the backend module, which is the entire reason the marker is a stable
// sentinel. Test (D) below pins the two constants together.
const ABSENCE_VALUE =
  `${NO_RATIONALE_MARKER} No change summary was supplied by the n8n card-approval producer ` +
  '(POST /api/webhooks/n8n/card-approval). fr records the producer\'s own words and ' +
  'synthesises nothing, so this approval carries no worker rationale for this field — ' +
  'decide from the description and the linked card, or send it back to the producer.';

const PROSE = 'Bumped the retry ceiling from 3 to 5 because the upstream 502s cluster in pairs.';

// ---------------------------------------------------------------------------
// (A) The classifier
// ---------------------------------------------------------------------------

describe('NO_RATIONALE_MARKER', () => {
  it('is the exact sentinel the backend writes', () => {
    expect(NO_RATIONALE_MARKER).toBe('[no-rationale-supplied]');
  });

  it('is un-prose-like, so a real summary can never collide with it', () => {
    // Bracketed, hyphenated, no spaces: not something a human writes by accident.
    expect(NO_RATIONALE_MARKER).toMatch(/^\[[a-z-]+\]$/);
    expect(NO_RATIONALE_MARKER).not.toContain(' ');
  });
});

describe('NO_RATIONALE_SHORT', () => {
  it('names the producer rather than rendering an invisible absence', () => {
    // "—" or "" is the invisible absence this whole change exists to remove.
    expect(NO_RATIONALE_SHORT.trim().length).toBeGreaterThan(0);
    expect(NO_RATIONALE_SHORT).not.toBe('—');
    expect(NO_RATIONALE_SHORT).toContain('producer');
  });

  it('does not leak the raw marker into approver-facing copy', () => {
    expect(NO_RATIONALE_SHORT).not.toContain(NO_RATIONALE_MARKER);
  });
});

describe('isNoRationaleSupplied', () => {
  it('true for the bare marker', () => {
    expect(isNoRationaleSupplied(NO_RATIONALE_MARKER)).toBe(true);
  });

  it('true for the full absence sentence the backend actually writes', () => {
    expect(isNoRationaleSupplied(ABSENCE_VALUE)).toBe(true);
  });

  it('false for the legacy shapes that have NOT gone extinct', () => {
    // Rows written before the backend change, plus every route still on `?? null`.
    expect(isNoRationaleSupplied(null)).toBe(false);
    expect(isNoRationaleSupplied(undefined)).toBe(false);
    expect(isNoRationaleSupplied('')).toBe(false);
    expect(isNoRationaleSupplied('   \n\t  ')).toBe(false);
  });

  it('false for ordinary producer prose', () => {
    expect(isNoRationaleSupplied(PROSE)).toBe(false);
  });

  it('false for prose that merely CONTAINS the marker rather than starting with it', () => {
    // The predicate is `startsWith`, not `includes`, precisely so a producer
    // who quotes the sentinel (e.g. describing this very feature) is not
    // reclassified as having supplied nothing.
    const quoting = `We now emit ${NO_RATIONALE_MARKER} when the worker sends no summary.`;
    expect(quoting).toContain(NO_RATIONALE_MARKER);
    expect(isNoRationaleSupplied(quoting)).toBe(false);
    // …and it survives as producer content.
    expect(producerRationale(quoting)).toBe(quoting);
  });

  it('false when the marker is preceded by whitespace (not a value fr wrote)', () => {
    expect(isNoRationaleSupplied(` ${NO_RATIONALE_MARKER}`)).toBe(false);
  });

  it('false for non-string junk', () => {
    expect(isNoRationaleSupplied(0 as unknown as string)).toBe(false);
    expect(isNoRationaleSupplied({} as unknown as string)).toBe(false);
  });
});

describe('producerRationale', () => {
  it('returns ordinary prose UNCHANGED, byte for byte', () => {
    expect(producerRationale(PROSE)).toBe(PROSE);
  });

  it('preserves surrounding whitespace in producer content (trims only for the emptiness test)', () => {
    const padded = `  ${PROSE}  `;
    expect(producerRationale(padded)).toBe(padded);
  });

  it('returns null for the bare marker', () => {
    expect(producerRationale(NO_RATIONALE_MARKER)).toBeNull();
  });

  it('returns null for the full absence sentence', () => {
    expect(producerRationale(ABSENCE_VALUE)).toBeNull();
  });

  it('returns null for null / undefined', () => {
    expect(producerRationale(null)).toBeNull();
    expect(producerRationale(undefined)).toBeNull();
  });

  it('returns null for empty and whitespace-only legacy values', () => {
    expect(producerRationale('')).toBeNull();
    expect(producerRationale('   ')).toBeNull();
    expect(producerRationale('\n\t \r')).toBeNull();
  });

  it('returns null for non-string junk', () => {
    expect(producerRationale(123 as unknown as string)).toBeNull();
  });

  it('is a truthiness test a renderer can branch on directly', () => {
    // `if (producerRationale(x))` must mean "a human wrote something here" —
    // the question every `{#if approval.impact_analysis}` was really asking.
    expect(Boolean(producerRationale(PROSE))).toBe(true);
    expect(Boolean(producerRationale(ABSENCE_VALUE))).toBe(false);
    expect(Boolean(producerRationale(null))).toBe(false);
  });

  it('is NOT a visibility test — absence is still classifiable on the same value', () => {
    // A surface that must SHOW the absence uses isNoRationaleSupplied; the two
    // functions answer different questions about the same string and must not
    // be conflated.
    expect(producerRationale(ABSENCE_VALUE)).toBeNull();
    expect(isNoRationaleSupplied(ABSENCE_VALUE)).toBe(true);
    // Legacy NULL is the third shape: no content AND no absence to show.
    expect(producerRationale(null)).toBeNull();
    expect(isNoRationaleSupplied(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (B) THE PROPERTY THAT MATTERS MOST
//     Absence text must never be derived from card content.
// ---------------------------------------------------------------------------

describe('never derives absence text from card content', () => {
  // Distinctive tokens that only ever appear in the INPUT. If any of them shows
  // up in an absence-path output, something is paraphrasing the card — which is
  // the failure mode `backend/src/lib/approval-rationale.ts` explicitly forbids:
  // "A summary synthesised from adjacent material would let an approver believe
  // they have the worker's reasoning when they have fr's paraphrase of a defect
  // narrative."
  const FINGERPRINTS = ['Zanzibar', 'evidence_gap', 'decision_authoring_gap', 'CVE-2031-9999'];

  const absenceInputs: Array<[string, string | null | undefined]> = [
    ['bare marker', NO_RATIONALE_MARKER],
    ['full backend absence sentence', ABSENCE_VALUE],
    [
      'absence sentence carrying card fingerprints',
      `${ABSENCE_VALUE} Zanzibar evidence_gap decision_authoring_gap CVE-2031-9999`,
    ],
    ['legacy null', null],
    ['legacy undefined', undefined],
    ['legacy empty string', ''],
    ['legacy whitespace-only', '  \t\n '],
  ];

  for (const [label, input] of absenceInputs) {
    it(`returns null (never synthesised text) for: ${label}`, () => {
      const out = producerRationale(input);
      expect(out).toBeNull();
      // Belt and braces: the absence path must not return a string at all, so
      // there is nothing that COULD have been derived from the input.
      expect(typeof out).not.toBe('string');
    });
  }

  it('the compact absence label is a constant, not a function of any input', () => {
    // NO_RATIONALE_SHORT is what the renderers substitute when content is
    // absent. It must be identical regardless of what the card said.
    for (const fp of FINGERPRINTS) {
      expect(NO_RATIONALE_SHORT).not.toContain(fp);
    }
    expect(NO_RATIONALE_SHORT).toBe('No summary supplied by the producer');
  });

  it('producer content is passed through by identity, never rewritten', () => {
    const contentInputs = [
      PROSE,
      'Zanzibar rollout: staged 10% then 100%.',
      'evidence_gap closed — attached the replay log.',
      'a',
      '0', // falsy-looking but genuinely written by a human
      `We now emit ${NO_RATIONALE_MARKER} when the worker sends nothing.`,
    ];
    for (const input of contentInputs) {
      // The last one embeds the marker mid-string; none START with it.
      expect(isNoRationaleSupplied(input)).toBe(false);
      expect(producerRationale(input)).toBe(input);
    }
  });
});

// ---------------------------------------------------------------------------
// (C) The renderer sites actually route through producerRationale
// ---------------------------------------------------------------------------
//
// A source-level assertion over every site: route components need SvelteKit
// `load` data, `$page`, auth stores and a live `onDecide`, so mounting them here
// would be a fixture harness larger than the feature. It is deliberately coarse:
// it proves the call is present, not that the branch is correct.

/**
 * Strip JS line comments and HTML comments so a `producerRationale(...)` written
 * inside an explanatory comment cannot be miscounted as a live call site.
 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

// The renderer sites, as `[path relative to repo root, minimum live calls]`.
// `approvals/[id]/+page.svelte` carries TWO (recommendation + summary).
const RENDERER_SITES: Array<[string, number]> = [
  ['frontend/src/routes/approvals/[id]/+page.svelte', 2],
  ['frontend/src/routes/(project)/projects/[id]/approve/[approvalId]/+page.svelte', 1],
  // R4: the project's Needs you page (replaced NeedsYouQueue).
  ['frontend/src/lib/components/needs-you/ProjectNeedsYou.svelte', 1],
  // ⚠️ Landing in parallel with this file. If THIS is the only row failing, the
  // sibling fix to the approvals list page has not merged yet — that is the
  // guard working, not a broken test. Do not delete the row to go green.
  ['frontend/src/routes/approvals/+page.svelte', 1],
];

describe('C2 · every renderer site imports and calls producerRationale', () => {
  for (const [rel, minCalls] of RENDERER_SITES) {
    it(`${rel} routes ${minCalls} rationale render(s) through producerRationale`, () => {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      const code = stripComments(src);

      expect(code, `${rel}: no import from $lib/approvals/rationale`).toMatch(
        /from\s+'\$lib\/approvals\/rationale'/,
      );

      const calls = code.match(/producerRationale\s*\(/g) ?? [];
      expect(
        calls.length,
        `${rel}: expected at least ${minCalls} live producerRationale(...) call(s), found ${calls.length}. ` +
          'A rationale field rendered on a bare truthiness check shows fr\'s absence marker to the approver as if it were the worker\'s reasoning.',
      ).toBeGreaterThanOrEqual(minCalls);
    });
  }

  // ⛔ DELIBERATELY NOT ASSERTED: "no site branches on raw truthiness of a
  // rationale column". That rule is FALSE, and a draft of this file shipped it
  // as a test before the two counter-examples were read.
  //
  // There are TWO legitimate branch kinds over the same column, and only one of
  // them may use `producerRationale`:
  //
  //   CONTENT branches — the derived headline suffix and the "✦ Review the
  //     impact analysis below" prompt (`approvals/[id]/+page.svelte` and
  //     `projects/[id]/approve/[approvalId]/+page.svelte`, in `$derived(...)`).
  //     These advertise that a human wrote something, so they MUST branch on
  //     `producerRationale`. That is what C2 above counts.
  //
  //   VISIBILITY branches — the "What changed" / "Impact & risk" dossier
  //     sections on those same two pages (`{#if approval.change_summary}`).
  //     These exist to SHOW the absence to the approver, so raw truthiness is
  //     CORRECT there: the marker must render. Forcing them through
  //     `producerRationale` would hide the gap again and undo the whole point of
  //     the feature — the invisible absence behind 1,032 of 1,235 pending rows.
  //
  // A blanket grep cannot tell the two apart, so it would fail on correct code
  // and train the next agent into "fixing" the dossier. If you want to tighten
  // this, assert the CONTENT derivations specifically, not every `{#if}`.
});

// ---------------------------------------------------------------------------
// (D) The mirrored constant
// ---------------------------------------------------------------------------

describe('frontend/backend NO_RATIONALE_MARKER parity', () => {
  // Read the backend source rather than importing it: the backend is a separate
  // Bun package outside the vite root, and the whole point of the sentinel is
  // that the frontend recognises it WITHOUT shipping the backend module. That
  // deliberate duplication is also exactly why it needs a guard — today the two
  // are an unguarded matched pair, and editing either one silently regresses all
  // renderers with nothing going red.
  const BACKEND_SRC = readFileSync(
    join(REPO_ROOT, 'backend', 'src', 'lib', 'approval-rationale.ts'),
    'utf8',
  );

  it('the backend still declares the constant (guard has not gone vacuous)', () => {
    expect(BACKEND_SRC).toMatch(/export const NO_RATIONALE_MARKER\s*=/);
  });

  it('is byte-identical across the two runtimes', () => {
    const m = BACKEND_SRC.match(/export const NO_RATIONALE_MARKER\s*=\s*(['"])([^'"]*)\1/);
    expect(m, 'could not parse NO_RATIONALE_MARKER out of backend/src/lib/approval-rationale.ts').not.toBeNull();
    expect(m![2]).toBe(NO_RATIONALE_MARKER);
  });

  it("the frontend classifier accepts what the backend's writer actually produces", () => {
    // Reconstruct the backend template literal's prefix from source so a change
    // to `noRationaleSupplied()` that stops leading with the marker is caught.
    expect(BACKEND_SRC).toMatch(/return\s*\(\s*`\$\{NO_RATIONALE_MARKER\}/);
    expect(isNoRationaleSupplied(ABSENCE_VALUE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (E) UNREADABLE PRODUCER OUTPUT
//     `[object Object]` / `step undefined` — stored strings from a producer bug
//     that was fixed at source, in rows that do not heal.
// ---------------------------------------------------------------------------
//
// ⛔ THE PROPERTY UNDER TEST IS NOT "IT LOOKS TIDIER". fr stores producer output
// VERBATIM on purpose (`question.ts :: parseProposition`: "REAL DESCRIPTIONS CARRY A
// PRODUCER BUG AND THIS PARSER MUST NOT HIDE IT"), so the three ways to get this
// wrong all pass a naive eyeball check and each is asserted against below:
//
//   a silent blank        → the defect becomes invisible (E2, E3)
//   a guess               → a fact nobody measured (E4)
//   strip and move on     → surrounding prose then reads COMPLETE (E2)
//
// …and the fourth, which is the one a refactor actually breaks: the healthy
// population must come through UNTOUCHED, byte for byte (E1). A marker that fires on
// clean prose is worse than no marker at all.

const CLEAN = 'Promote workflow v7 to production after the 10% canary held for 2h.';
const OBJ = '[object Object]';

describe('E1 · a string with no defect passes through byte-identical', () => {
  // The negative control. Without it, `markUnreadableProducerOutput` could return a
  // marker for every input and every other test in this block would still pass.
  const clean = [
    CLEAN,
    PROSE,
    '',
    '   ',
    'step 3 of 4 failed',
    'undefined',
    'the stepwise undefined behaviour is documented',
    'Sidestep undefined inputs before the join.',
    'object Object without the brackets',
    `${NO_RATIONALE_MARKER} nothing was supplied`,
  ];
  for (const input of clean) {
    it(`unchanged: ${JSON.stringify(input)}`, () => {
      const out = markUnreadableProducerOutput(input);
      expect(out).toBe(input);
      expect(out).not.toContain(UNREADABLE_OUTPUT_MARKER);
      expect(markUnreadableProducerOutput(input)).toBe(input);
    });
  }

  it('is stable across repeated calls (the /g regex carries no lastIndex between them)', () => {
    // A single shared /g RegExp used for both .test() and .replace() skips matches on
    // alternate calls — the clean string would pass, then the dirty one would not.
    for (let i = 0; i < 4; i += 1) {
      expect(markUnreadableProducerOutput(CLEAN)).toBe(CLEAN);
      expect(markUnreadableProducerOutput(`x ${OBJ} y`)).not.toBe(`x ${OBJ} y`);
      expect(markUnreadableProducerOutput(`x ${OBJ} y`)).toBe(`x ${UNREADABLE_OUTPUT_MARKER} y`);
    }
  });
});

// ---------------------------------------------------------------------------
// (E1b) THE NARROWING CONTROL
//       Legible prose that merely LOOKS like the defect.
// ---------------------------------------------------------------------------
//
// ⛔ E1 CANNOT CATCH A TOKEN THAT IS TOO WIDE. Every string in E1's clean list is
// clean the easy way: not one of them contains a bracketed `[object …]` or the
// literal words `step undefined` at all. So a pattern that is far too permissive —
// a case-INSENSITIVE `[object <anything>]`, or a bare `\bstep[ \t]+undefined\b` with
// no context requirement — passes all of E1 and still mangles ordinary approval
// prose. These are the strings that separate "matches the defect" from "matches
// anything that rhymes with the defect", and they are the reason the token is
// narrow rather than generous.
//
// The module's own contract is what makes this the load-bearing direction: a
// rationale with no defect must come back "byte for byte" and the formatter must be
// "a no-op on the healthy population". A marker fired on a legible sentence is not a
// cosmetic miss — it DELETES the author's words and replaces them with an accusation
// that the producer emitted garbage. That is the same class of harm as the "strip and
// move on" repair E2 forbids, pointing the other way.
//
// Each case asserts the formatter's no-op (byte-identical output, the module's
// own stated negative control).

const LEGIBLE_PROSE: Array<[string, string]> = [
  [
    'prose whose subject IS the `step undefined` bug (legible words on BOTH sides)',
    'This documents step undefined behaviour in the C parser.',
  ],
  [
    'a lowercase `[object …]` tag — real prose, not a toString tag',
    'We use [object storage] for blobs rather than the database.',
  ],
  [
    'a bracketed PascalCase phrase whose `Object` is CAPITALISED',
    'The producer posts JavaScript [Object Notation] on the webhook.',
  ],
  [
    '`step undefined` as the grammatical subject of a sentence',
    'the step undefined case is documented in the runbook',
  ],
  [
    '`step undefined` suffixed into another word',
    'skip this step undefined-ly and move on',
  ],
  [
    '`and` that joins prose rather than a second unreadable token',
    'step undefined and the retry never fired',
  ],
  [
    'an all-caps transcription of the defect, which no runtime emits',
    'The log line read [OBJECT OBJECT] which nobody could parse.',
  ],
  [
    'an all-lowercase tag — Object.prototype.toString ALWAYS capitalises it',
    'grep the logs for [object object] before you conclude anything',
  ],
  [
    'a capitalised `Object` in the fixed-literal slot — a human retyping the bug',
    'Someone pasted [Object Object] into the ticket by hand.',
  ],
  [
    'both near-misses in one sentence, neither of which is a coercion',
    'Approve the [object storage] migration at step undefined tier two.',
  ],
];

describe('E1b · legible prose that resembles the defect is left alone, byte for byte', () => {
  for (const [why, input] of LEGIBLE_PROSE) {
    it(`${why}: ${JSON.stringify(input)}`, () => {
      // The predicate: no surface may COUNT or FLAG this row as carrying a defect.
      expect(markUnreadableProducerOutput(input)).toBe(input);
      // The formatter: the module's own stated negative control — the original
      // reference, unmodified, byte for byte.
      expect(markUnreadableProducerOutput(input)).not.toContain(UNREADABLE_OUTPUT_MARKER);
    });
  }

  it('the author\'s own words survive in full — nothing is deleted from a legible sentence', () => {
    // Stated as a length identity as well as an equality, so a future "improvement"
    // that returns a *reworded* clean string (rather than the same reference) is
    // still red for the right reason.
    for (const [, input] of LEGIBLE_PROSE) {
      expect(markUnreadableProducerOutput(input).length).toBe(input.length);
    }
  });

  it('the discriminator against [Object Notation] is the LOWERCASE literal `object`', () => {
    // Not the tag's shape: `Notation` is PascalCase exactly like a real toString tag,
    // so a rule keyed only on the tag cannot tell the two apart. What separates them
    // is that Object.prototype.toString emits the word `object` in lower case, always.
    expect(markUnreadableProducerOutput('[Object Notation]')).toBe('[Object Notation]');
    expect(markUnreadableProducerOutput('[object Notation]')).not.toBe('[object Notation]');
  });
});

describe('E2 · a [object Object] string gets the marker, and the legible half survives', () => {
  it('marks a bare [object Object]', () => {
    expect(markUnreadableProducerOutput(OBJ)).toBe(UNREADABLE_OUTPUT_MARKER);
    expect(markUnreadableProducerOutput(OBJ)).not.toBe(OBJ);
  });

  it('keeps every legible character around the token', () => {
    const mixed = `Approve rollout of ${OBJ} to production.`;
    const out = markUnreadableProducerOutput(mixed);
    expect(out).toBe(`Approve rollout of ${UNREADABLE_OUTPUT_MARKER} to production.`);
    // The two halves of the sentence are still there…
    expect(out).toContain('Approve rollout of ');
    expect(out).toContain(' to production.');
    // …and the raw defect token is gone from the screen.
    expect(out).not.toContain(OBJ);
  });

  it('NEVER strips the token and leaves the prose reading as complete', () => {
    // The worst of the three wrong repairs: the decider believes they have the whole
    // sentence and never learns a value was lost.
    const mixed = `Approve rollout of ${OBJ} to production.`;
    const out = markUnreadableProducerOutput(mixed);
    expect(out).not.toBe('Approve rollout of  to production.');
    expect(out).not.toBe('Approve rollout of to production.');
    expect(out.length).toBeGreaterThan('Approve rollout of  to production.'.length);
  });

  it('NEVER returns a silent blank for a value that is nothing but the defect', () => {
    const out = markUnreadableProducerOutput(OBJ);
    // A trailing `expect(out).not.toBe('')` restated this line and was removed
    // 2026-10-31: a non-empty trimmed result is already not the empty string.
    expect(out.trim().length).toBeGreaterThan(0);
  });

  it('marks the sibling shapes the same bug emits from the same call site', () => {
    for (const tag of ['[object Undefined]', '[object Array]', '[object Promise]']) {
      expect(markUnreadableProducerOutput(`v4 ${tag} blocked`)).toBe(
        `v4 ${UNREADABLE_OUTPUT_MARKER} blocked`,
      );
    }
  });
});

describe('E3 · step undefined, including runs', () => {
  it('marks a single occurrence', () => {
    expect(markUnreadableProducerOutput('Retry failed at step undefined.')).toBe(
      `Retry failed at ${UNREADABLE_OUTPUT_MARKER}.`,
    );
  });

  it('marks a RUN item by item — three losses, three markers', () => {
    // ⛔ This test used to assert the opposite ("collapses a RUN to exactly one
    // marker"). That requirement was withdrawn on 2026-09-15: collapsing is lossy,
    // and a reader who cannot count the losses is reading a sentence that looks
    // complete. See `rationale.ts :: UNREADABLE_RUN_SOURCE`.
    const run = 'Retry failed at step undefined, step undefined, step undefined — see the trace.';
    const out = markUnreadableProducerOutput(run);
    expect(out).toBe(
      `Retry failed at ${UNREADABLE_OUTPUT_MARKER}, ${UNREADABLE_OUTPUT_MARKER}, ${UNREADABLE_OUTPUT_MARKER} — see the trace.`,
    );
    // No marker-count pin: the equality above already spells out three markers.
    expect(out).toContain('— see the trace.');
  });

  it('matches sentence-initial capitalisation and an `and`-joined run', () => {
    // Two losses joined by `and` — two markers, and the `and` survives, so the
    // rendered clause still says there were two of them.
    expect(markUnreadableProducerOutput('Step undefined and step undefined')).toBe(
      `${UNREADABLE_OUTPUT_MARKER} and ${UNREADABLE_OUTPUT_MARKER}`,
    );
  });

  it('does not join two losses across a newline — two lines, two markers', () => {
    const out = markUnreadableProducerOutput('line one step undefined\nline two step undefined');
    expect(out).toBe(
      `line one ${UNREADABLE_OUTPUT_MARKER}\nline two ${UNREADABLE_OUTPUT_MARKER}`,
    );
  });

  it('marks a string carrying BOTH defect shapes, once each', () => {
    const both = `Promote v4: ${OBJ} blocked at step undefined`;
    expect(markUnreadableProducerOutput(both)).toBe(
      `Promote v4: ${UNREADABLE_OUTPUT_MARKER} blocked at ${UNREADABLE_OUTPUT_MARKER}`,
    );
  });
});

describe('E3b · the genuine defect is STILL marked after the narrowing', () => {
  // The other half of E1b. Narrowing a pattern to stop false positives is the easiest
  // way to silently stop catching the real thing, and the formatter
  // returning its input unchanged is INDISTINGUISHABLE from a healthy row at every call site — the
  // row just renders the raw token again, exactly as it did before this module
  // existed. So every tag the coercion actually emits is pinned by name.
  //
  // These are `Object.prototype.toString.call(x)` outputs, which is a FIXED,
  // CAPITALISED set: `String(x)` on any of these values is what puts them in the
  // column.
  const TO_STRING_TAGS = [
    'Object',
    'Undefined',
    'Null',
    'Array',
    'String',
    'Number',
    'Boolean',
    'Function',
    'Symbol',
    'BigInt',
    'Date',
    'RegExp',
    'Error',
    'Promise',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'ArrayBuffer',
    'DataView',
    'Arguments',
    'Math',
    'JSON',
    'GeneratorFunction',
    'AsyncFunction',
    'Generator',
    'Window',
    'HTMLDocument',
    'Module',
  ];

  for (const tag of TO_STRING_TAGS) {
    it(`marks [object ${tag}]`, () => {
      const token = `[object ${tag}]`;
      expect(markUnreadableProducerOutput(token)).not.toBe(token);
      expect(markUnreadableProducerOutput(`Promote v4: ${token} blocked.`)).toBe(
        `Promote v4: ${UNREADABLE_OUTPUT_MARKER} blocked.`,
      );
    });
  }

  it('the four shapes the auditor named specifically are all still marked', () => {
    for (const token of [
      '[object Object]',
      '[object Undefined]',
      '[object Null]',
      '[object Array]',
      '[object Promise]',
    ]) {
      expect(markUnreadableProducerOutput(token)).not.toBe(token);
      expect(markUnreadableProducerOutput(token)).toBe(UNREADABLE_OUTPUT_MARKER);
    }
  });

  it('a tag outside the enumerated builtins is still caught (the list must not rot)', () => {
    // A `Symbol.toStringTag` value, or a host object the enumeration never heard of,
    // is the SAME defect from the SAME call site. Enumerating and stopping there
    // would mean a tag nobody listed prints raw to the decider and nothing goes red.
    for (const token of ['[object HTMLDivElement]', '[object Response]', '[object URLSearchParams]']) {
      expect(markUnreadableProducerOutput(token)).not.toBe(token);
      expect(markUnreadableProducerOutput(token)).toBe(UNREADABLE_OUTPUT_MARKER);
    }
  });

  it('a genuine `step undefined` RUN is marked once PER ITEM', () => {
    const run = 'step undefined, step undefined, step undefined';
    expect(markUnreadableProducerOutput(run)).not.toBe(run);
    const out = markUnreadableProducerOutput(run);
    expect(out).toBe(
      `${UNREADABLE_OUTPUT_MARKER}, ${UNREADABLE_OUTPUT_MARKER}, ${UNREADABLE_OUTPUT_MARKER}`,
    );
    // The expected string above is the claim; a marker count restated it.
  });

  it('a `step undefined` run separated by `;` or by `and` keeps one marker per item', () => {
    expect(markUnreadableProducerOutput('step undefined; step undefined; step undefined')).toBe(
      `${UNREADABLE_OUTPUT_MARKER}; ${UNREADABLE_OUTPUT_MARKER}; ${UNREADABLE_OUTPUT_MARKER}`,
    );
    expect(markUnreadableProducerOutput('step undefined and step undefined')).toBe(
      `${UNREADABLE_OUTPUT_MARKER} and ${UNREADABLE_OUTPUT_MARKER}`,
    );
  });

  it('a lone `step undefined` is still marked at a value/clause boundary', () => {
    // The narrowing is on the TRAILING side: the producer's `step ${idx}` ends the
    // interpolated value or is followed by a separator, whereas prose runs on into
    // another word. Leading prose is normal and must not disqualify it.
    expect(markUnreadableProducerOutput('Retry failed at step undefined')).toBe(
      `Retry failed at ${UNREADABLE_OUTPUT_MARKER}`,
    );
    expect(markUnreadableProducerOutput('Retry failed at step undefined.')).toBe(
      `Retry failed at ${UNREADABLE_OUTPUT_MARKER}.`,
    );
    expect(markUnreadableProducerOutput('Blocked at step undefined; see the trace.')).toBe(
      `Blocked at ${UNREADABLE_OUTPUT_MARKER}; see the trace.`,
    );
    expect(markUnreadableProducerOutput('- step undefined\n- step undefined')).toBe(
      `- ${UNREADABLE_OUTPUT_MARKER}\n- ${UNREADABLE_OUTPUT_MARKER}`,
    );
  });
});

describe('E3c · the marker must never LOSE COUNT (measured on /approvals/b2ddf71e-…)', () => {
  // ⭐ THE DEFECT THIS SECTION EXISTS FOR, measured in a live browser 2026-09-15.
  //
  // The stored description carried SIX unreadable items. The screen showed TWO:
  //
  //   stored:   failed step(s): step undefined ×6
  //   rendered: failed step(s): [marker], step undefined
  //
  // Four values vanished with no trace, and the surviving sentence read as a
  // COMPLETE list — which is the "strip and move on" repair the module header
  // forbids, reached by collapsing instead of by stripping. The governing rule is
  // that the marker must not hide the producer defect and must never let damaged
  // output read as intact; a count that silently drops from six to one breaks the
  // second half of that. So: ONE MARKER PER LOST VALUE.
  //
  // The assertions below are on the COUNT rather than only on the exact string,
  // because the count is the property that was lost. A future "tidy up the repetition"
  // change reddens here.
  const SIX_ITEMS =
    'failed step(s): step undefined, step undefined, step undefined, step undefined, step undefined, step undefined';

  /** Markers in `s`. `split(m).length - 1` counts non-overlapping occurrences. */
  const markers = (s: string): number => s.split(UNREADABLE_OUTPUT_MARKER).length - 1;

  it('the six-item string renders six markers, so a reader can count the losses', () => {
    const out = markUnreadableProducerOutput(SIX_ITEMS);

    // The whole point: six unreadable values in, six losses visible out.
    expect(markers(out)).toBe(6);
    // It is still a six-item list — the separators between the items survived, so
    // the sentence's SHAPE tells the reader there were six of them too.
    expect(out).toBe(
      `failed step(s): ${[UNREADABLE_OUTPUT_MARKER, UNREADABLE_OUTPUT_MARKER, UNREADABLE_OUTPUT_MARKER, UNREADABLE_OUTPUT_MARKER, UNREADABLE_OUTPUT_MARKER, UNREADABLE_OUTPUT_MARKER].join(', ')}`,
    );
    // The legible prose is untouched, as ever.
    expect(out).toContain('failed step(s):');
  });

  it('leaves NO raw token standing beside a marker', () => {
    // The second half of the live defect: five items collapsed and the SIXTH printed
    // raw next to the marker. It was excluded from the run only because of what
    // followed IT — the `|` field separator these block reasons use is not clause
    // punctuation — even though its five identical siblings were marked. A reader
    // then sees a marker and a raw token side by side and cannot tell whether the
    // renderer disagreed with itself or the producer emitted two different things.
    const live = `block reason: failed_step | ${SIX_ITEMS} | card CARD-9`;
    const out = markUnreadableProducerOutput(live);

    expect(markers(out)).toBe(6);
    expect(out).not.toContain('step undefined');
    // Both legible field values still stand.
    expect(out).toContain('block reason: failed_step |');
    expect(out).toContain('| card CARD-9');
  });

  it('a token that runs on into a WORD is prose, even after a `,` inside a run', () => {
    // ⭐ THIS ASSERTION WAS INVERTED, AND THE INVERSION WAS A FALSE-POSITIVE LICENCE.
    // It used to expect TWO markers here, on the argument that a token preceded by
    // `…, ` already has producer context from the left and so need not also end at a
    // boundary. The same argument was rejected one test down for `and`, and `,` is no
    // more the producer's than `and` is — a human writes both. What settled it was the
    // measurement: across all 1,961 unreadable tokens in live `approvals` (worker4
    // `fr`.`public`, 2026-09-15) the relaxed branch and the strict branch mark the
    // IDENTICAL set, so the relaxation bought ZERO live tokens while costing this
    // clause. The token it used to rescue was the one ending in `|`, and `|` is now a
    // boundary in its own right.
    const out = markUnreadableProducerOutput(
      'failed step(s): step undefined, step undefined in the retry loop',
    );
    expect(markers(out)).toBe(1);
    expect(out).toBe(
      `failed step(s): ${UNREADABLE_OUTPUT_MARKER}, step undefined in the retry loop`,
    );
  });

  it('the `,` relaxation\'s false positive is GONE — prose after a real token survives', () => {
    // The constructed case the relaxation was disclosed as costing. It is a MIXED
    // string: `[object Object]` is a genuine token and must still be marked, while
    // the clause after the comma is a sentence a human wrote and must survive byte
    // for byte. Marking both is the § E1b harm; marking neither is a regression on
    // the real token. Exactly one marker is the whole contract.
    for (const sep of [',', ';']) {
      const out = markUnreadableProducerOutput(
        `[object Object]${sep} step undefined semantics are documented upstream`,
      );
      expect(markers(out)).toBe(1);
      expect(out).toBe(`${UNREADABLE_OUTPUT_MARKER}${sep} step undefined semantics are documented upstream`);
    }
  });

  it('does not buy the count with a false positive — `and` + prose is still prose', () => {
    // `and` is the one separator made of letters; relaxing it would let this delete a
    // clause a human wrote — the § E1b harm, pointing the other way.
    const out = markUnreadableProducerOutput(
      '[object Object] and step undefined behaviour in the C parser',
    );
    expect(markers(out)).toBe(1);
    expect(out).toBe(`${UNREADABLE_OUTPUT_MARKER} and step undefined behaviour in the C parser`);
  });

  it('marks a mixed run item by item, so neither defect shape is hidden by the other', () => {
    // A collapse-with-a-count would have summarised these three as one number and
    // erased that TWO different producer bugs fired in the same list.
    const out = markUnreadableProducerOutput('values: [object Object], step undefined, [object Null]');
    expect(markers(out)).toBe(3);
    expect(out).toBe(
      `values: ${UNREADABLE_OUTPUT_MARKER}, ${UNREADABLE_OUTPUT_MARKER}, ${UNREADABLE_OUTPUT_MARKER}`,
    );
  });

  // -------------------------------------------------------------------------
  // ⭐ n = 1. THE FIXTURE THE SIX-ITEM CASE CANNOT PROVIDE.
  // -------------------------------------------------------------------------
  //
  // Every assertion above this point uses a run of SIX. A run of six hides the
  // defect these cases exist for, because the first five items are each followed
  // by a `,` — which was always a boundary — so the run opens on item 1 no matter
  // what terminates item 6. The single-token case has no such cover: if `|` is not
  // a boundary, nothing matches at all and the string comes back BYTE FOR BYTE with
  // a raw token in it.
  //
  // Measured live (worker4 `fr`.`public`, 2026-09-15): after the six-item fix, this
  // shape was the ONLY thing still rendering raw anywhere in `approvals` — row
  // `249c846b-19d3-4be7-bbe3-1ead333acb9c`, on both `description` and
  // `change_summary`, 2 of 1,961 tokens. These assertions are RED without the `|`
  // boundary and green with it.

  it('a SINGLE pipe-delimited token is marked — a run of one has no siblings to ride on', () => {
    const live = 'block reason: failed_step | step undefined | card CARD-9';
    const out = markUnreadableProducerOutput(live);

    // The defect it was: the whole string came back unchanged, 0 markers.
    expect(out).not.toBe(live);
    expect(markers(out)).toBe(1);
    expect(out).not.toContain('step undefined');
    expect(out).toBe(`block reason: failed_step | ${UNREADABLE_OUTPUT_MARKER} | card CARD-9`);
    // The predicate must agree with the formatter, or a counting surface reports
    // this row as clean while the detail view shows a marker.
    expect(markUnreadableProducerOutput(live)).not.toBe(live);
  });

  it('`|` terminates a value on either side and at the end of the string', () => {
    expect(markUnreadableProducerOutput('step undefined | card CARD-9')).toBe(
      `${UNREADABLE_OUTPUT_MARKER} | card CARD-9`,
    );
    expect(markUnreadableProducerOutput('card CARD-9 | step undefined')).toBe(
      `card CARD-9 | ${UNREADABLE_OUTPUT_MARKER}`,
    );
    // Two single-token fields in one string are two separate losses, both marked.
    const out = markUnreadableProducerOutput('a: step undefined | b: step undefined | c: ok');
    expect(markers(out)).toBe(2);
    expect(out).toBe(`a: ${UNREADABLE_OUTPUT_MARKER} | b: ${UNREADABLE_OUTPUT_MARKER} | c: ok`);
  });

  it('the exact live row renders with NO raw token left standing', () => {
    // `249c846b-…`.`change_summary`, truncated to the field that carried the token.
    const live =
      'block reason: failed_step: open_winner_pr | completed 4/5 typed steps | ' +
      'FAILED steps: open_winner_pr | failed step(s): step undefined | ' +
      'reasoning issues: The output_summary claims the card was moved to BLOCKED';
    const out = markUnreadableProducerOutput(live);

    expect(markers(out)).toBe(1);
    expect(out).not.toContain('step undefined');
    // Every legible field around it survives — including `FAILED steps:` and
    // `failed step(s):`, which contain the word `step` and must not be touched.
    expect(out).toContain('FAILED steps: open_winner_pr |');
    expect(out).toContain('| failed step(s): ');
    expect(out).toContain('reasoning issues: The output_summary claims');
  });

  it('a whitespace/tab-separated run leaves no raw token beside a marker', () => {
    // The other way a run failed to OPEN: the first token is followed by a tab and
    // then a word, so the strict boundary failed on it, and the match landed on the
    // SECOND token alone at end-of-value — printing `step undefined<TAB>[marker]`.
    // A raw token standing next to a marker is the § E3c harm exactly.
    for (const sep of ['\t', ' ']) {
      const out = markUnreadableProducerOutput(`step undefined${sep}step undefined`);
      expect(markers(out)).toBe(2);
      expect(out).toBe(`${UNREADABLE_OUTPUT_MARKER}${sep}${UNREADABLE_OUTPUT_MARKER}`);
    }
    // ...and bare adjacency is still not evidence on its own: a following WORD,
    // rather than a following token, keeps the whole thing prose.
    expect(markUnreadableProducerOutput('step undefined retry pending')).toBe(
      'step undefined retry pending',
    );
  });

  it('the three measured near-misses stay BYTE-IDENTICAL under the new counting', () => {
    // The § E1b controls, re-run here: a change that buys the count by widening the
    // token is the wrong fix, and this is where that shows up.
    for (const clean of [
      'This documents step undefined behaviour in the C parser.',
      'we use [object storage] for blobs',
      'JavaScript [Object Notation]',
      'we use [object storage] for blobs, in JavaScript [Object Notation].',
    ]) {
      expect(markUnreadableProducerOutput(clean)).toBe(clean);
    }
  });
});

// ---------------------------------------------------------------------------
// (E3d) `step ?` — THE THIRD SPELLING OF A MISSING STEP INDEX
// ---------------------------------------------------------------------------
//
// ⭐ MEASURED, NOT SPECULATIVE. Fleet-wide over the 1,349 pending rows (worker4
// `fr`.`public`, 2026-09-15): SIX rows carry a raw `step ?` — five in tenant
// `…0003`, one in `…0001` — all in `approvals.description`, all `kind=generic`,
// `source=n8n`, all with a live `PROPOSED_ACTION: RETRY`. In every one of them the
// token sits inside the FIRST 200 CHARACTERS, so this is not a detail-page
// blemish: it prints raw in the QUEUE PREVIEW, which is where a decider meets the
// row before deciding whether to open it at all.
//
// It is the SAME producer bug as `step undefined`, one template away: `step ${idx}`
// with a missing index that rendered as `?` instead of as the string `undefined`.
// Same lost value ⇒ the same marker, never a second one — the decider is being told
// "a producer value was unreadable here", and that fact does not change with the
// spelling of the garbage.
//
// The boundary rule is inherited unchanged, and that is the whole safety argument:
// the token must END a value or a clause. `STEP_BOUNDARY` already contains `|`,
// which is exactly what these pipe-delimited block reasons terminate their fields
// with, so nothing new had to be widened to cover the live shape.
//
// ⚖️ THE RESIDUAL AMBIGUITY, STATED RATHER THAN HIDDEN, in the same register as the
// one `STEP_UNDEFINED` already discloses: a French-spaced interrogative — "at which
// step ?" — is shaped identically to the producer token and is resolved TOWARDS
// marking. English approval prose writes "step?" closed up, which does not match
// (`[ \t]+` is required), so the cost is confined to a spacing convention this
// corpus does not use, and the benefit is six rows measured today.

describe('E3d · `step ?` is the same loss as `step undefined` and gets the same marker', () => {
  /** Markers in `s`. `split(m).length - 1` counts non-overlapping occurrences. */
  const markers = (s: string): number => s.split(UNREADABLE_OUTPUT_MARKER).length - 1;

  it('marks the live pipe-delimited shape, and every legible field survives', () => {
    // ⭐ MUTATION CONTROL: delete the `|${STEP_QUESTION}` alternative from
    // `STEP_MISSING_INDEX` in `rationale.ts` (one line) ⇒ this goes red with the
    // string returned byte-identical and 0 markers, while § E3 and § E3c stay green.
    //
    // Shaped like the rows measured above: pipe-delimited producer fields, token in
    // the preview window.
    const live =
      'block reason: failed_step: open_winner_pr | completed 4/5 typed steps | ' +
      'failed step(s): step ? | reasoning issues: the retry never fired';
    const out = markUnreadableProducerOutput(live);

    // The defect it was: unchanged, 0 markers, raw token in the queue preview.
    expect(out).not.toBe(live);
    expect(markers(out)).toBe(1);
    expect(out).toBe(
      'block reason: failed_step: open_winner_pr | completed 4/5 typed steps | ' +
        `failed step(s): ${UNREADABLE_OUTPUT_MARKER} | reasoning issues: the retry never fired`,
    );
    // The predicate must agree with the formatter, or a counting surface reports the
    // row clean while the queue preview shows a marker.
    expect(markUnreadableProducerOutput(live)).not.toBe(live);
  });

  it('marks it at the end of a value and before ordinary clause punctuation', () => {
    // ⭐ MUTATION CONTROL: remove `$` from `STEP_BOUNDARY`'s alternation ⇒ the
    // end-of-value case below goes red.
    expect(markUnreadableProducerOutput('failed step(s): step ?')).toBe(
      `failed step(s): ${UNREADABLE_OUTPUT_MARKER}`,
    );
    expect(markUnreadableProducerOutput('Retry failed at step ?.')).toBe(
      `Retry failed at ${UNREADABLE_OUTPUT_MARKER}.`,
    );
    expect(markUnreadableProducerOutput('Step ? was skipped')).toBe('Step ? was skipped');
  });

  it('marks a RUN of them item by item — six losses, six markers, separators kept', () => {
    // ⭐ MUTATION CONTROL: revert `UNREADABLE_TOKEN_IN_RUN` to
    // `(?:${OBJECT_COERCION}|\b${STEP_UNDEFINED}\b)` ⇒ the outer pass still finds the
    // run but the inner pass marks nothing inside it, so this reads 0 markers.
    const six = 'failed step(s): step ?, step ?, step ?, step ?, step ?, step ?';
    const out = markUnreadableProducerOutput(six);

    expect(markers(out)).toBe(6);
    expect(out).toBe(
      `failed step(s): ${[
        UNREADABLE_OUTPUT_MARKER,
        UNREADABLE_OUTPUT_MARKER,
        UNREADABLE_OUTPUT_MARKER,
        UNREADABLE_OUTPUT_MARKER,
        UNREADABLE_OUTPUT_MARKER,
        UNREADABLE_OUTPUT_MARKER,
      ].join(', ')}`,
    );
    expect(out).not.toContain('step ?');
  });

  it('mixes with the other two shapes in one run, one marker per lost value', () => {
    // ⭐ MUTATION CONTROL: delete the `|${STEP_QUESTION}` alternative from
    // `STEP_MISSING_INDEX` ⇒ the third item is left raw beside two markers and the
    // count falls to 2. (Verified: this mutation reddens exactly § E3d and § E3e.)
    const out = markUnreadableProducerOutput('values: [object Object], step undefined, step ?');
    expect(markers(out)).toBe(3);
    expect(out).toBe(
      `values: ${UNREADABLE_OUTPUT_MARKER}, ${UNREADABLE_OUTPUT_MARKER}, ${UNREADABLE_OUTPUT_MARKER}`,
    );
  });

  it('a `step ?` ADJACENT to another token leaves no raw token standing beside a marker', () => {
    // ⭐ MUTATION CONTROL: revert `STEP_RUN_AHEAD`'s step branch to `${STEP_UNDEFINED}`
    // ⇒ `step undefined` no longer sees a following token to its right, fails its
    // boundary against the bare space, and prints RAW beside the marker its identical
    // neighbour got — the § E3c harm, reached through the new shape. This is the only
    // fixture that exercises that branch: in a comma- or pipe-separated list every
    // item already terminates at a boundary of its own.
    for (const sep of [' ', '\t']) {
      const out = markUnreadableProducerOutput(`step undefined${sep}step ?`);
      expect(markers(out)).toBe(2);
      expect(out).toBe(`${UNREADABLE_OUTPUT_MARKER}${sep}${UNREADABLE_OUTPUT_MARKER}`);
      expect(out).not.toContain('step undefined');
    }
  });

  it('a `step ?` that runs on into a WORD is prose, byte for byte', () => {
    // ⭐ MUTATION CONTROL: delete the `(?=${STEP_BOUNDARY}|${STEP_RUN_AHEAD})`
    // lookahead from `STEP_COERCION` ⇒ every string here is mangled, which is the
    // § E1b harm arriving through the new branch.
    for (const prose of [
      'confirm at which step ? the retry fires',
      'the step ? placeholder is a known producer bug',
      'grep for step ? tokens before you conclude anything',
    ]) {
      expect(markUnreadableProducerOutput(prose)).toBe(prose);
    }
  });

  it('a closed-up `step?` is English punctuation, not the producer token', () => {
    // ⭐ MUTATION CONTROL: change `[ \t]+` to `[ \t]*` in `STEP_QUESTION` (one
    // character) ⇒ 'which step?' is marked and an ordinary question loses its subject.
    // This is the assertion that bounds the disclosed French-spacing ambiguity: the
    // required whitespace is what confines the cost to a convention this corpus does
    // not use, so a "harmless" relaxation of it must go red HERE rather than in prod.
    for (const clean of ['which step?', 'Approve at which step?', 'which step is it ?']) {
      expect(markUnreadableProducerOutput(clean)).toBe(clean);
    }
  });

  it('does not bite into a word that merely ENDS in `step`', () => {
    // ⭐ MUTATION CONTROL: delete the leading `\b` from `STEP_COERCION`
    // (`\b${STEP_MISSING_INDEX}(?=…)` → `${STEP_MISSING_INDEX}(?=…)`) ⇒ 'Sidestep ?'
    // is marked, i.e. half of a real word is replaced by an accusation.
    for (const clean of [
      'Sidestep ?',
      'Sidestep ?, and move on',
      'FAILED steps: open_winner_pr',
      'completed 4/5 typed steps',
    ]) {
      expect(markUnreadableProducerOutput(clean)).toBe(clean);
    }
  });
});

// ---------------------------------------------------------------------------
// (E3e) PROSE INTEGRITY — THE WHOLE RENDERED STRING, NOT A MARKER COUNT
// ---------------------------------------------------------------------------
//
// ⛔ THIS SECTION EXISTS BECAUSE A MARKER COUNT IS NOT A RENDERING. An earlier
// change to this module passed twenty-four assertions while DESTROYING four of six
// items in a real list: every assertion it had was of the form "a marker appeared"
// or "the token is gone", and both remain true of output that has silently eaten
// the legible items around the token. The § E3c count assertions close half of that
// hole — they prove nothing was COLLAPSED — but a count cannot prove that the words
// BETWEEN the markers survived.
//
// So these two assert on the rendered string as a whole, in both directions:
//
//   nothing added   → no legible word appears that was not in the input;
//   nothing lost    → every legible word of the input is still in the output, and
//                     the list still has as many items as it went in with.
//
// `legibleWords` deliberately subtracts ONLY the exact raw token spans, so the
// expectation still contains `step(s):` and `steps` — the words that contain `step`
// and must survive. A pattern that eats them goes red here and nowhere else.

describe('E3e · a six-item rationale keeps every legible word and every separator', () => {
  const markers = (s: string): number => s.split(UNREADABLE_OUTPUT_MARKER).length - 1;

  /** The input's words, minus the exact unreadable token spans. */
  const legibleWords = (raw: string, tokens: readonly string[]): string[] => {
    let rest = raw;
    for (const token of tokens) rest = rest.split(token).join(' ');
    return rest.split(/\s+/).filter((w) => w.length > 0);
  };

  it('six pipe-delimited producer fields render as six fields, one of them marked', () => {
    // ⭐ MUTATION CONTROL: replace the inner-pass callback in
    // `markUnreadableProducerOutput` with `() => UNREADABLE_OUTPUT_MARKER`, i.e.
    // collapse each run to a single marker — the change that actually shipped once
    // and cost four of six items. Here the `failed step(s)` field's two items become
    // one and the `, ` between them is destroyed: the pipe count stays at 6 and
    // `not.toContain('step ?')` still holds, so a marker-count-only test stays green
    // while a producer value disappears without trace.
    const stored =
      'block reason: failed_step: open_winner_pr | completed 4/5 typed steps | ' +
      'FAILED steps: open_winner_pr | failed step(s): step ?, step ? | ' +
      'reasoning issues: The output_summary claims the card was moved to BLOCKED | ' +
      'PROPOSED_ACTION: RETRY';

    const out = markUnreadableProducerOutput(stored);

    // No field dropped: six pipe-delimited fields in, six out, five separators kept.
    expect(stored.split('|')).toHaveLength(6);
    expect(out.split('|')).toHaveLength(6);
    // ...and no ITEM dropped inside the field that carries the tokens.
    expect(out.split('|')[3].split(',')).toHaveLength(2);
    // Every legible word of the input is still on the screen.
    for (const word of legibleWords(stored, ['step ?'])) {
      expect(out, `legible word lost from the rendered rationale: ${JSON.stringify(word)}`).toContain(word);
    }
    // Two values were lost, and both are gone rather than standing beside a marker.
    expect(markers(out)).toBe(2);
    expect(out).not.toContain('step ?');
    // Nothing was invented: the output is the input with exactly those spans substituted.
    expect(out).toBe(stored.split('step ?').join(UNREADABLE_OUTPUT_MARKER));
  });

  it('a six-item list of MIXED legible and unreadable items loses none of the legible ones', () => {
    // ⭐ MUTATION CONTROL: the same collapse — inner-pass callback replaced by
    // `() => UNREADABLE_OUTPUT_MARKER` ⇒ the adjacent pair that OPENS this list
    // (`step ?, step undefined`) becomes one marker, the list renders as FIVE items,
    // and a reader counting losses is off by one. The legible names survive that
    // mutation, which is why the item count is asserted alongside them.
    //
    // The first two items are deliberately adjacent: a list whose unreadable items
    // are all separated by legible ones forms no run at all, and a run of one cannot
    // be collapsed — the fixture would be inert against the very defect this section
    // was written for.
    const stored =
      'failed step(s): step ?, step undefined, validate_inputs, [object Object], ' +
      'open_winner_pr, post_summary';

    const out = markUnreadableProducerOutput(stored);

    // Six comma-separated items in, six out.
    expect(stored.split(',')).toHaveLength(6);
    expect(out.split(',')).toHaveLength(6);
    // The three legible items are still there, in their original order and spelling.
    expect(out).toBe(
      `failed step(s): ${UNREADABLE_OUTPUT_MARKER}, ${UNREADABLE_OUTPUT_MARKER}, validate_inputs, ` +
        `${UNREADABLE_OUTPUT_MARKER}, open_winner_pr, post_summary`,
    );
    for (const word of legibleWords(stored, ['step ?', 'step undefined', '[object Object]'])) {
      expect(out, `legible word lost from the rendered rationale: ${JSON.stringify(word)}`).toContain(word);
    }
    expect(markers(out)).toBe(3);
    // Three losses, three markers, and NO raw token left standing beside one.
    expect(out).not.toContain('step ?');
    expect(out).not.toContain('step undefined');
    expect(out).not.toContain('[object Object]');
  });
});

// ---------------------------------------------------------------------------
// (E3f) THE TWO POSITIVE CONTROLS, RE-RUN AGAINST THE WIDENED TOKEN
// ---------------------------------------------------------------------------
//
// The population this module actually serves is not the six new rows: it is the
// 184 pending rows carrying `[object Object]` and the 56 carrying `step undefined`
// (worker4 `fr`.`public`, 2026-09-15). A widening that fixes six rows and changes
// how any of those 240 render is a net loss, and § E3 / § E3b would not
// necessarily say so — they were written before the new branch existed and could
// both stay green while the rendered STRING moved.

describe('E3f · `[object Object]` and `step undefined` render exactly as before', () => {
  const markers = (s: string): number => s.split(UNREADABLE_OUTPUT_MARKER).length - 1;

  it('the 184-row `[object Object]` control is unchanged by the new branch', () => {
    // ⭐ MUTATION CONTROL: delete the `${OBJECT_COERCION}|` alternative from
    // `UNREADABLE_TOKEN` ⇒ red here, green in § E3d.
    const stored = 'Approve the payload change: the worker reported [object Object] for the diff.';
    const out = markUnreadableProducerOutput(stored);

    expect(markers(out)).toBe(1);
    expect(out).toBe(
      `Approve the payload change: the worker reported ${UNREADABLE_OUTPUT_MARKER} for the diff.`,
    );
    expect(markUnreadableProducerOutput(stored)).not.toBe(stored);
  });

  it('the 56-row `step undefined` control is unchanged by the new branch', () => {
    // ⭐ MUTATION CONTROL: change `STEP_MISSING_INDEX` to `(?:${STEP_QUESTION})`,
    // dropping the `undefined` branch ⇒ red here, green in § E3d. This is the
    // mutation that proves the two branches are independently load-bearing.
    expect(markUnreadableProducerOutput('Retry failed at step undefined.')).toBe(
      `Retry failed at ${UNREADABLE_OUTPUT_MARKER}.`,
    );
    const run = markUnreadableProducerOutput(
      'failed step(s): step undefined, step undefined, step undefined',
    );
    expect(markers(run)).toBe(3);
    expect(run).toBe(
      `failed step(s): ${UNREADABLE_OUTPUT_MARKER}, ${UNREADABLE_OUTPUT_MARKER}, ${UNREADABLE_OUTPUT_MARKER}`,
    );
    expect(markUnreadableProducerOutput('block reason: failed_step | step undefined | card CARD-9')).toBe(
      `block reason: failed_step | ${UNREADABLE_OUTPUT_MARKER} | card CARD-9`,
    );
  });

  it('every § E1b near-miss is STILL byte-identical after the widening', () => {
    // ⭐ MUTATION CONTROL: add the `/i` flag to `UNREADABLE_RUN_ONCE` /
    // `UNREADABLE_RUN_ALL` ⇒ three of these are mangled. The new branch must not
    // become the excuse that reintroduces it.
    for (const [, input] of LEGIBLE_PROSE) {
      expect(markUnreadableProducerOutput(input)).toBe(input);
    }
    // ...and the clean population from § E1, which the new branch also must not touch.
    for (const clean of [CLEAN, PROSE, 'step 3 of 4 failed', 'Sidestep undefined inputs before the join.']) {
      expect(markUnreadableProducerOutput(clean)).toBe(clean);
    }
  });
});

describe('E4 · the marker never guesses and never synthesises', () => {
  // Same property as (B) above, for the other defect class: the substituted text is a
  // CONSTANT, so it cannot smuggle a paraphrase of the broken value back in.
  const FINGERPRINTS = ['Zanzibar', 'evidence_gap', 'v7', '10%'];

  it('says the producer emitted unreadable output, and names the producer', () => {
    expect(UNREADABLE_OUTPUT_MARKER).toContain('unreadable');
    expect(UNREADABLE_OUTPUT_MARKER).toContain('producer');
    // Bracketed like NO_RATIONALE_MARKER, so it reads as an editorial insertion
    // rather than as the worker's own words.
    expect(UNREADABLE_OUTPUT_MARKER.startsWith('[')).toBe(true);
    expect(UNREADABLE_OUTPUT_MARKER.endsWith(']')).toBe(true);
  });

  it('substitutes the same constant whatever the surrounding card said', () => {
    for (const fp of FINGERPRINTS) {
      const out = markUnreadableProducerOutput(`${fp} rollout hit ${OBJ}`);
      expect(out).toBe(`${fp} rollout hit ${UNREADABLE_OUTPUT_MARKER}`);
      // The marker itself carries nothing from the input.
      expect(UNREADABLE_OUTPUT_MARKER).not.toContain(fp);
    }
  });

  it('never invents a step number for `step undefined`', () => {
    const out = markUnreadableProducerOutput('failed at step undefined');
    expect(out).not.toMatch(/step\s+\d/);
    expect(out).toBe(`failed at ${UNREADABLE_OUTPUT_MARKER}`);
  });

  it('is a FORMATTER, not a classifier — non-strings render as nothing, never as null', () => {
    // It must not be mistaken for the absence contract: `producerRationale` owns
    // "is there content here", and returns null; this one only formats.
    expect(markUnreadableProducerOutput(null)).toBe('');
    expect(markUnreadableProducerOutput(undefined)).toBe('');
    expect(markUnreadableProducerOutput(42 as unknown as string)).toBe('');
  });

  it('is orthogonal to the absence contract — an absence value carries no defect token', () => {
    expect(markUnreadableProducerOutput(ABSENCE_VALUE)).toBe(ABSENCE_VALUE);
    // …and a defect token is real producer CONTENT, not an absence: the decider is
    // told the producer sent something unreadable, not that it sent nothing.
    expect(producerRationale(OBJ)).toBe(OBJ);
    expect(isNoRationaleSupplied(OBJ)).toBe(false);
  });
});

describe('E5b · BlockedGateSection renders the marker, not the raw token', () => {
  let host: HTMLElement;
  let app: ReturnType<typeof mount> | null = null;

  const approval = (description: string) => ({
    approval_id: 'a1',
    description,
    status: 'pending',
    source: 'n8n',
    callback_path: null,
    recipient: null,
    created_at: new Date().toISOString(),
    expires_at: null,
  });

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    if (app) {
      unmount(app);
      app = null;
    }
    host.remove();
  });

  it('a blocked card whose approval carries a defect token shows the marker', () => {
    app = mount(BlockedGateSection, {
      target: host,
      props: { blocked: true, openApprovals: [approval(`Approve rollout of ${OBJ} now.`)] },
    });
    flushSync();

    const text = host.textContent ?? '';
    expect(text).toContain(UNREADABLE_OUTPUT_MARKER);
    expect(text).not.toContain(OBJ);
    // The legible half survives — red if the token is stripped or the row blanked.
    expect(text).toContain('Approve rollout of');
    expect(text).toContain('now.');
  });

  it('the n=1 pipe-delimited shape is marked here too', () => {
    app = mount(BlockedGateSection, {
      target: host,
      props: {
        blocked: true,
        openApprovals: [approval('block reason: failed_step | step undefined | card CARD-9')],
      },
    });
    flushSync();

    const text = host.textContent ?? '';
    expect(text).toContain(UNREADABLE_OUTPUT_MARKER);
    expect(text).not.toContain('step undefined');
    expect(text).toContain('card CARD-9');
  });

  it('a clean description is rendered exactly as stored', () => {
    app = mount(BlockedGateSection, {
      target: host,
      props: { blocked: true, openApprovals: [approval(CLEAN)] },
    });
    flushSync();

    expect(host.textContent ?? '').toContain(CLEAN);
    expect(host.textContent ?? '').not.toContain(UNREADABLE_OUTPUT_MARKER);
  });
});

// Source-level census, for the same reason C2 exists: the route/page components that
// render these strings cannot all be mounted here, and a call that is deleted from
// one of them must go red somewhere.
const UNREADABLE_RENDER_SITES: Array<[string, number]> = [
  // ⭐ THE ONE-CLICK SURFACES. `NeedsYouQueue` marks these columns and links to
  // `/projects/{id}/approve/{approvalId}`, which rendered all four of its stored
  // strings raw — so the token the queue marked reappeared verbatim one click
  // later. Counts: summary description + summary change_summary + the "What
  // changed" body + the "Impact & risk" body. The change_summary body moved
  // (2026-10-27, sign-off plan text) into `ApprovalPlanText`, which BOTH review
  // pages render above the decision bar — so the page keeps 3 and the component
  // carries the fourth.
  ['frontend/src/routes/(project)/projects/[id]/approve/[approvalId]/+page.svelte', 3],
  ['frontend/src/lib/components/approval/ApprovalPlanText.svelte', 1],
  // The BLOCKED band on a card shows the same `approvals.description`.
  ['frontend/src/lib/cards/sections/BlockedGateSection.svelte', 1],
  // The backlog report is read to count and compare rows.
  ['frontend/src/routes/reports/approval-backlog/+page.svelte', 1],
];

describe('E6 · every approval render site routes through the marker', () => {
  for (const [rel, minCalls] of UNREADABLE_RENDER_SITES) {
    it(`${rel} marks ${minCalls} stored string(s)`, () => {
      const code = stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'));
      const calls = code.match(/markUnreadableProducerOutput\s*\(/g) ?? [];
      expect(
        calls.length,
        `${rel}: expected at least ${minCalls} live markUnreadableProducerOutput(...) call(s), found ${calls.length}. ` +
          'A bare interpolation renders `[object Object]` / `step undefined` to the decider as if it were the producer\'s sentence.',
      ).toBeGreaterThanOrEqual(minCalls);
    });
  }
});
