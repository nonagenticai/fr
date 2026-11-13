// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ClaimLedgerRow from './ClaimLedgerRow.svelte';

let app: ReturnType<typeof mount> | null = null;
let host: HTMLElement;

function render(props: { claim: string } & Record<string, unknown>): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(ClaimLedgerRow, { target: host, props });
  flushSync();
}
afterEach(() => {
  if (app) {
    unmount(app);
    app = null;
  }
  host?.remove();
});
const q = (t: string) => host.querySelector(`[data-testid="${t}"]`);

describe('ClaimLedgerRow', () => {
  it('renders a supported CoVe verdict with confidence', () => {
    render({ claim: 'X reduces Y', cove: { supported: true, confidence: 0.9 } });
    expect(host.textContent).toContain('X reduces Y');
    expect(q('claim-cove-verdict')?.textContent?.toLowerCase()).toContain('supported');
    expect(q('claim-cove-verdict')?.textContent).toContain('90%');
  });

  it('renders an unsupported verdict', () => {
    render({ claim: 'bogus', cove: { supported: false } });
    expect(q('claim-cove-verdict')?.textContent?.toLowerCase()).toContain('unsupported');
  });

  // Live upstream key: `overall_verdict` with NO legacy `supported`/`verdict` present.
  it('renders a supported badge from overall_verdict=verified (no legacy keys)', () => {
    render({ claim: 'X reduces Y', cove: { overall_verdict: 'verified', confidence: 0.8 } });
    const badge = q('claim-cove-verdict');
    expect(badge?.textContent).toContain('verified');
    // success color, driven by supported===true derivation
    expect(badge?.className).toContain('var(--color-success-bg)');
    expect(badge?.textContent).toContain('80%');
  });

  it('renders a danger badge from overall_verdict=disputed (no legacy keys)', () => {
    render({ claim: 'bogus', cove: { overall_verdict: 'disputed' } });
    const badge = q('claim-cove-verdict');
    expect(badge?.textContent).toContain('disputed');
    expect(badge?.className).toContain('var(--color-danger-bg)');
  });

  // Falsification of the OLD code path: with ONLY overall_verdict present the
  // pre-fix component fell through to the supported-derived word ('inconclusive').
  // The fixed component must show the overall_verdict string, never 'inconclusive'.
  it('does not render "inconclusive" when overall_verdict is present', () => {
    render({ claim: 'X reduces Y', cove: { overall_verdict: 'verified' } });
    expect(q('claim-cove-verdict')?.textContent?.toLowerCase()).not.toContain('inconclusive');
  });

  it('shows overall_verdict=inconclusive as a neutral badge', () => {
    render({ claim: 'meh', cove: { overall_verdict: 'inconclusive' } });
    const badge = q('claim-cove-verdict');
    expect(badge?.textContent).toContain('inconclusive');
    expect(badge?.className).not.toContain('var(--color-success-bg)');
    expect(badge?.className).not.toContain('var(--color-danger-bg)');
  });

  it('shows the contradiction count', () => {
    render({
      claim: 'c',
      contradictions: { contradiction_pairs: [{ a: 1 }, { b: 2 }] },
    });
    expect(q('claim-contradictions')?.textContent?.replace(/\s+/g, ' ')).toContain(
      '2 contradiction',
    );
  });

  it('shows a running state', () => {
    render({ claim: 'c', running: true });
    expect(q('claim-running')).not.toBeNull();
  });

  it('expands the contradiction badge to list each pair target + net-support', () => {
    render({
      claim: 'c',
      contradictions: {
        contradiction_pairs: [
          { target_id: 't1', target_label: 'Effect of X', net_support_score: 0.4 },
          { target_id: 't2', target_label: 'Dosage response', net_support_score: -0.3 },
        ],
      },
    });
    // Collapsed by default — no drilldown yet.
    expect(q('claim-contradiction-detail')).toBeNull();
    // The count badge is the toggle.
    const badge = q('claim-contradictions') as HTMLButtonElement;
    expect(badge).not.toBeNull();
    badge.click();
    flushSync();
    const detail = q('claim-contradiction-detail');
    expect(detail).not.toBeNull();
    expect(detail?.textContent).toContain('Effect of X');
    expect(detail?.textContent).toContain('Dosage response');
    // net-support direction words come from the shared netSupportLabel.
    expect(detail?.textContent).toContain('net support 40%');
    expect(detail?.textContent).toContain('net opposition 30%');
    // Toggling again collapses it.
    badge.click();
    flushSync();
    expect(q('claim-contradiction-detail')).toBeNull();
  });

  it('falls back to target_id when a pair has no label', () => {
    render({
      claim: 'c',
      contradictions: {
        contradiction_pairs: [{ target_id: 'entity-42', net_support_score: 0.1 }],
      },
    });
    (q('claim-contradictions') as HTMLButtonElement).click();
    flushSync();
    expect(q('claim-contradiction-detail')?.textContent).toContain('entity-42');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // A summary-only topology response must not read as a clean bill of health
  //
  // The count was `contradiction_pairs?.length ?? total_contradictions ?? 0`.
  // `??` only falls through on null/undefined, and `[].length` is `0` — not
  // nullish — so `total_contradictions` was UNREACHABLE whenever the pairs key
  // was present but empty. That is a real shape: a summary-only or truncated
  // response carries the total and omits the pair rows. The ledger then printed
  // "0 contradictions", neutral-coloured, about a claim the service had just
  // said was disputed 7 ways — in the surface a lead adjudicates from.
  // ─────────────────────────────────────────────────────────────────────────
  it('reports the total when the pairs array is present but empty', () => {
    render({
      claim: 'c',
      contradictions: { contradiction_pairs: [], total_contradictions: 7 },
    });
    const badge = q('claim-contradictions');
    expect(badge?.textContent?.replace(/\s+/g, ' ')).toContain('7 contradiction');
    // …and it must be flagged, not rendered as the neutral "nothing here" chip.
    expect(badge?.className).toContain('var(--color-warning-bg)');
    // Still not expandable: there are no pair rows to show. Saying 7 and
    // offering a drilldown that lists nothing would be a second lie.
    expect((badge as HTMLButtonElement).disabled).toBe(true);
  });

  it('prefers the larger of the two when the response TRUNCATES its pairs', () => {
    // A response that returns 2 of 9 pairs must report 9, not 2 — otherwise the
    // count silently describes the page size instead of the corpus.
    render({
      claim: 'c',
      contradictions: {
        contradiction_pairs: [{ target_id: 't1' }, { target_id: 't2' }],
        total_contradictions: 9,
      },
    });
    expect(q('claim-contradictions')?.textContent?.replace(/\s+/g, ' ')).toContain(
      '9 contradiction',
    );
    // The two pairs it DID send are still browsable.
    expect((q('claim-contradictions') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a genuinely clean claim still reports zero', () => {
    // Negative control: `Math.max` must not invent a contradiction from an
    // honest empty response, or every clean claim would flag itself.
    render({
      claim: 'c',
      contradictions: { contradiction_pairs: [], total_contradictions: 0 },
    });
    const badge = q('claim-contradictions');
    expect(badge?.textContent?.replace(/\s+/g, ' ')).toContain('0 contradiction');
    expect(badge?.className).not.toContain('var(--color-warning-bg)');
  });

  it('does not expand when there are no contradiction pairs', () => {
    render({ claim: 'c', contradictions: { contradiction_pairs: [] } });
    const badge = q('claim-contradictions') as HTMLButtonElement;
    expect(badge).not.toBeNull();
    expect(badge.disabled).toBe(true);
    badge.click();
    flushSync();
    expect(q('claim-contradiction-detail')).toBeNull();
  });

  it('renders CoVe per-question drilldown when the verdict badge is expanded', () => {
    render({
      claim: 'X reduces Y',
      cove: {
        overall_verdict: 'verified',
        questions: [
          { question: 'Does X reduce Y?', verdict: 'supported', source_node_ids: ['n1', 'n2'] },
          { question: 'Is dose safe?', verdict: 'unsupported' },
        ],
      },
    });
    // Collapsed by default — no drilldown yet.
    expect(q('claim-cove-questions')).toBeNull();
    // The verdict badge is the toggle.
    const badge = q('claim-cove-verdict') as HTMLButtonElement;
    expect(badge).not.toBeNull();
    expect(badge.tagName).toBe('BUTTON');
    badge.click();
    flushSync();
    const container = q('claim-cove-questions');
    expect(container).not.toBeNull();
    expect(container?.textContent).toContain('Does X reduce Y?');
    expect(container?.textContent).toContain('Is dose safe?');
    const v0 = q('claim-cove-question-verdict-0');
    expect(v0?.textContent).toContain('supported');
    expect(v0?.className).toContain('var(--color-success-bg)');
    const v1 = q('claim-cove-question-verdict-1');
    expect(v1?.textContent).toContain('unsupported');
    expect(v1?.className).toContain('var(--color-danger-bg)');
    expect(q('claim-cove-question-evidence-0')?.textContent).toContain('2 sources');
  });

  it('maps the deprecated supported flag to a verdict word', () => {
    render({
      claim: 'q',
      cove: { overall_verdict: 'verified', questions: [{ question: 'q', supported: true }] },
    });
    (q('claim-cove-verdict') as HTMLButtonElement).click();
    flushSync();
    expect(q('claim-cove-question-verdict-0')?.textContent).toContain('supported');
  });

  it('keeps the verdict badge a plain span when there are no questions', () => {
    render({ claim: 'X reduces Y', cove: { overall_verdict: 'verified' } });
    const badge = q('claim-cove-verdict') as HTMLElement;
    expect(badge.tagName).toBe('SPAN');
    expect(badge.getAttribute('aria-expanded')).toBeNull();
    badge.click();
    flushSync();
    expect(q('claim-cove-questions')).toBeNull();
  });

  it('does not toggle when questions is an empty array', () => {
    render({ claim: 'X reduces Y', cove: { overall_verdict: 'verified', questions: [] } });
    const badge = q('claim-cove-verdict') as HTMLElement;
    expect(badge.tagName).toBe('SPAN');
    badge.click();
    flushSync();
    expect(q('claim-cove-questions')).toBeNull();
  });

  it('keeps CoVe and contradiction disclosures independent', () => {
    render({
      claim: 'X reduces Y',
      cove: {
        overall_verdict: 'verified',
        questions: [{ question: 'Does X reduce Y?', verdict: 'supported' }],
      },
      contradictions: {
        contradiction_pairs: [
          { target_id: 't1', target_label: 'Effect of X', net_support_score: 0.4 },
        ],
      },
    });
    // Expanding contradictions must NOT reveal CoVe questions.
    (q('claim-contradictions') as HTMLButtonElement).click();
    flushSync();
    expect(q('claim-contradiction-detail')).not.toBeNull();
    expect(q('claim-cove-questions')).toBeNull();
    // Expanding CoVe reveals questions but leaves contradiction detail as-is.
    (q('claim-cove-verdict') as HTMLButtonElement).click();
    flushSync();
    expect(q('claim-cove-questions')).not.toBeNull();
    expect(q('claim-contradiction-detail')).not.toBeNull();
  });

  it('appends supporting/refuting evidence counts to the verdict badge', () => {
    render({
      claim: 'c',
      cove: { overall_verdict: 'disputed', supporting_evidence: 3, refuting_evidence: 5 },
    });
    const badge = q('claim-cove-verdict');
    expect(badge?.textContent).toContain('3');
    expect(badge?.textContent).toContain('5');
  });
});
