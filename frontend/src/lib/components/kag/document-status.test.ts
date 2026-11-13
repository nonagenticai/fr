// Pure tests for describeDocumentStatus / describeDegradation — the two
// functions DocumentUploadPanel exports from its `<script module>` block
// (the describeLifecycleStatus idiom in coding/ContainerLifecycleFeed.svelte).
//
// THE CONTRACT UNDER TEST is a three-valued field. `kag_degraded` is
// `true | false | null | undefined`, and only `true` means "degraded":
//
//   true      → the graph is knowingly incomplete → warning pill.
//   false     → the backend looked and found it complete → unchanged render.
//   null      → UNKNOWN. 4 legacy prod rows + every parse-only upload carry
//               NULL forever → MUST render exactly as before this feature.
//   undefined → the field was not in the payload at all → same as null.
//
// So the suite is the full cross-product of status × those four values. Each
// case is named for the mutation it kills; the three that matter are
// `=== true` → truthiness, `=== true` → `!== false`, and `=== true` → `!= null`.

import { describe, it, expect } from 'vitest';
import {
  describeDocumentStatus,
  describeDegradation,
  type DocumentStatusInput,
} from './DocumentUploadPanel.svelte';
import { DEGRADED_GENERIC } from './degradation';

/** The real prod row: karma completed the job with 119 of 137 chunks lost. */
const PROD_DEGRADED: DocumentStatusInput = {
  status: 'completed',
  kag_degraded: true,
  kag_degraded_reason: 'nlp_extraction_degraded: 119 of 137 chunks failed extraction',
  chunks_indexed: 18,
  chunks_failed: 119,
  chunks_total: 137,
};

describe('describeDocumentStatus — the non-degraded statuses are untouched', () => {
  it.each([
    ['completed', 'completed', 'success'],
    ['processing', 'processing', 'accent'],
    ['pending', 'pending', 'warning'],
    ['failed', 'failed', 'danger'],
    // The opt-out path (send_to_kag=false). `info` is why this uses Tag and
    // not Pill — Pill has no `info` tone, so a swap back to Pill breaks here.
    ['parsed', 'parsed', 'info'],
  ] as const)('%s → %s / %s', (status, label, tone) => {
    expect(describeDocumentStatus({ status })).toEqual({ label, tone });
  });

  it('an unrecognised status is surfaced verbatim + neutral, never swallowed', () => {
    expect(describeDocumentStatus({ status: 'rejected' })).toEqual({
      label: 'rejected',
      tone: 'neutral',
    });
  });
});

describe('describeDocumentStatus — the degradation predicate is `=== true`', () => {
  it('completed + kag_degraded true → Partially indexed / warning', () => {
    expect(describeDocumentStatus(PROD_DEGRADED)).toEqual({
      label: 'Partially indexed',
      tone: 'warning',
    });
  });

  it('completed + kag_degraded NULL → plain completed (kills `!== false` and `!= null`)', () => {
    // The whole backwards-compatibility contract. `null !== false` is true and
    // `null != null` is false, so a `!== false` mutant repaints all 4 legacy
    // prod rows warning-orange on no evidence whatsoever.
    expect(describeDocumentStatus({ status: 'completed', kag_degraded: null })).toEqual({
      label: 'completed',
      tone: 'success',
    });
  });

  it('completed + kag_degraded ABSENT → plain completed (an old payload has no such key)', () => {
    expect(describeDocumentStatus({ status: 'completed' })).toEqual({
      label: 'completed',
      tone: 'success',
    });
    expect(describeDocumentStatus({ status: 'completed', kag_degraded: undefined })).toEqual({
      label: 'completed',
      tone: 'success',
    });
  });

  it('completed + kag_degraded FALSE → plain completed (an evaluated-clean job stays green)', () => {
    expect(describeDocumentStatus({ status: 'completed', kag_degraded: false })).toEqual({
      label: 'completed',
      tone: 'success',
    });
  });

  it('a TRUTHY non-true value is NOT degraded (kills `=== true` → truthiness)', () => {
    // Not hypothetical hygiene: a driver or serialiser that hands back
    // postgres' `'f'`/`'t'` text booleans makes `'f'` truthy. Under a
    // truthiness test that row renders "Partially indexed" — the exact
    // false alarm the `=== true` rule exists to prevent. `=== true` also
    // refuses `'t'`, which is correct: an unrecognised encoding is UNKNOWN,
    // and UNKNOWN is never rendered as degraded.
    const pgText: DocumentStatusInput = {
      status: 'completed',
      kag_degraded: 'f' as unknown as boolean,
    };
    expect(describeDocumentStatus(pgText)).toEqual({ label: 'completed', tone: 'success' });
    expect(describeDegradation(pgText)).toBeNull();
  });

  it('degradation only overrides a COMPLETED row — a failed job still reads failed', () => {
    // Ordering mutation: hoisting the degraded branch above the status switch
    // would relabel a hard failure as a partial success.
    // Annotated, not inline: a bare object literal widens `status` to `string`,
    // which does not satisfy `Pick<Document, 'status'>` and fails svelte-check.
    const failed: DocumentStatusInput = { status: 'failed', kag_degraded: true };
    const processing: DocumentStatusInput = { status: 'processing', kag_degraded: true };
    expect(describeDocumentStatus(failed)).toEqual({
      label: 'failed',
      tone: 'danger',
    });
    expect(describeDocumentStatus(processing)).toEqual({
      label: 'processing',
      tone: 'accent',
    });
  });
});

describe('describeDegradation', () => {
  it('the prod row yields the real ratio, not a rounded or invented one', () => {
    expect(describeDegradation(PROD_DEGRADED)).toBe('18 of 137 chunks indexed');
  });

  it('chunks_total null → the generic label, NO ratio (kills a fabricated denominator)', () => {
    expect(describeDegradation({ ...PROD_DEGRADED, chunks_total: null })).toBe(DEGRADED_GENERIC);
  });

  it('chunks_failed 0 → the generic label, NO "18 of 18"', () => {
    expect(
      describeDegradation({ ...PROD_DEGRADED, chunks_failed: 0, chunks_total: 18 }),
    ).toBe(DEGRADED_GENERIC);
  });

  it.each([[null], [false], [undefined]])(
    'kag_degraded %s → null, so a non-degraded row can never render a counts line',
    (flag) => {
      expect(
        describeDegradation({ ...PROD_DEGRADED, kag_degraded: flag as boolean | null | undefined }),
      ).toBeNull();
    },
  );
});
