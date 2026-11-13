// @vitest-environment jsdom
//
// ApprovedScopeSection — the reader migration 127's columns needed.
//
// Two properties, both of which a plausible-looking component gets wrong:
//   1. ORDER. The approved scope is an ORDERED list; the order is asserted
//      explicitly here so that a component which re-sorts or reverses is caught,
//      and so the backend's `ORDER BY position` has a consumer-side witness.
//   2. ACCEPTANCE CRITERIA ARE NOT EVIDENCE. Nothing in fr validates a criterion
//      against an artefact — measured 2026-09-23: `artifacts.card_id` was NULL on
//      all 58,573 rows. So the rendered criteria must carry NO tick, NO checkbox,
//      NO "done" wording and NO "n of m met" count. Asserted by absence below.
//
// And the empty case must be an HONEST EMPTY STATE, not a spinner: the read
// succeeded and returned nothing, which is an answer. A spinner would say "still
// loading" forever on every project that never had an outline approved.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ApprovedScopeSection from './ApprovedScopeSection.svelte';
import type { Panel } from '$lib/types/panel';
import type { ApprovedScope } from '$lib/types/cockpit';
import { PROGRESS_FRACTION } from './tests/progress-fraction';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

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

function block(scope: ApprovedScope): Panel<ApprovedScope> {
  return {
    data: scope,
    as_of: '2026-09-23T09:00:00.000Z', health: 'ok' as const,
  };
}

const THREE: ApprovedScope = {
  deliverables: [
    {
      id: 'd-1',
      position: 1,
      kind: 'deliverable',
      title: 'Ingestion pipeline',
      description: 'End-to-end ingest',
      acceptance_criteria: ['handles 10k docs', 'retries on 5xx'],
    },
    {
      id: 'd-2',
      position: 2,
      kind: 'intermediate',
      title: 'Schema migration',
      description: null,
      acceptance_criteria: ['forward-only'],
    },
    {
      id: 'd-3',
      position: 3,
      kind: 'deliverable',
      title: 'Operator dashboard',
      description: null,
      acceptance_criteria: [],
    },
  ],
  milestones: [
    { position: 1, name: 'Alpha', target_date: '2026-10-01' },
    { position: 2, name: 'Beta', target_date: null },
  ],
  approved_effort_estimate: { value: 12, unit: 'days', note: 'two engineers' },
};

describe('ApprovedScopeSection — three approved rows', () => {
  it('renders one item per row, IN POSITION ORDER, with their acceptance criteria', () => {
    app = mount(ApprovedScopeSection, { target: host, props: { scope: block(THREE) } });
    flushSync();

    const items = [...host.querySelectorAll('[data-testid="approved-deliverable"]')];
    expect(items).toHaveLength(3);

    // ⛔ ORDER ASSERTED EXPLICITLY, not just membership.
    expect(items.map((el) => el.getAttribute('data-position'))).toEqual(['1', '2', '3']);
    expect(items[0]!.textContent).toContain('Ingestion pipeline');
    expect(items[1]!.textContent).toContain('Schema migration');
    expect(items[2]!.textContent).toContain('Operator dashboard');

    // Every criterion reaches the DOM.
    const criteria = [...host.querySelectorAll('[data-testid="acceptance-criteria"] li')].map(
      (li) => li.textContent?.trim(),
    );
    expect(criteria).toEqual(['handles 10k docs', 'retries on 5xx', 'forward-only']);

    // The kind is shown as what it is — the vocabulary is closed and branched on.
    expect(items[1]!.textContent).toContain('Intermediate');
  });

  it('labels criteria as approved INTENT and shows no evidence-of-completion affordance', () => {
    app = mount(ApprovedScopeSection, { target: host, props: { scope: block(THREE) } });
    flushSync();

    expect(host.querySelector('[data-testid="acceptance-criteria-label"]')!.textContent).toContain(
      'approved intent, not evidence of completion',
    );

    const text = host.textContent ?? '';
    // ⛔ No tick glyph of any kind, and no "done"/"met"/"complete" wording.
    expect(text).not.toMatch(/[✓✔☑√]/);
    expect(text).not.toMatch(/\bdone\b/i);
    expect(text).not.toMatch(/\b(met|completed|verified|satisfied)\b/i);
    // ⛔ No "2 of 3 met" style score.
    expect(text).not.toMatch(PROGRESS_FRACTION);
    // ⛔ No checkbox inputs, no progress bar.
    expect(host.querySelector('input[type=checkbox]')).toBeNull();
    expect(host.querySelector('[role=progressbar]')).toBeNull();
  });

  it('labels the effort figure as an approved estimate, not tracked effort', () => {
    app = mount(ApprovedScopeSection, { target: host, props: { scope: block(THREE) } });
    flushSync();
    expect(host.querySelector('[data-testid="approved-effort-label"]')!.textContent).toBe(
      'Approved estimate — not tracked effort',
    );
    expect(host.querySelector('[data-testid="approved-effort"]')!.textContent).toContain('12');
  });

  it('renders milestones in position order, and a missing target date as itself', () => {
    app = mount(ApprovedScopeSection, { target: host, props: { scope: block(THREE) } });
    flushSync();
    const rows = [...host.querySelectorAll('[data-testid="approved-milestones"] li')];
    expect(rows.map((el) => el.getAttribute('data-position'))).toEqual(['1', '2']);
    expect(rows[1]!.textContent).toContain('no target date');
  });
});

describe('ApprovedScopeSection — zero approved rows', () => {
  it('renders an HONEST empty state, not a spinner', () => {
    app = mount(ApprovedScopeSection, {
      target: host,
      props: {
        scope: block({ deliverables: [], milestones: [], approved_effort_estimate: null }),
      },
    });
    flushSync();

    const empty = host.querySelector('[data-testid="approved-scope-empty"]');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toContain('No approved scope is recorded');

    expect(host.querySelectorAll('[data-testid="approved-deliverable"]').length).toBe(0);
    // ⛔ Not a loading state: the read SUCCEEDED and the answer was "none".
    expect(host.textContent ?? '').not.toMatch(/loading|…\s*$/i);
    expect(host.querySelector('[role=progressbar]')).toBeNull();
    expect(host.querySelector('[data-testid="panel-note"]')).toBeNull();
  });
});

describe('ApprovedScopeSection — a failed read', () => {
  it('degrades to the unavailable block rather than claiming an empty scope', () => {
    app = mount(ApprovedScopeSection, {
      target: host,
      props: {
        scope: {
          data: null,
          as_of: null, health: 'down' as const, detail_code: 'fr_db_error',
        },
      },
    });
    flushSync();
    expect(host.querySelector('[data-testid="panel-note"]')).toBeTruthy();
    // ⛔ A failure must NOT render as "nothing was approved".
    expect(host.querySelector('[data-testid="approved-scope-empty"]')).toBeNull();
  });
});

// ── Controls on the pattern ITSELF ───────────────────────────────────────────
// A negative assertion is only as good as its pattern; these two make the pattern
// falsifiable instead of taking it on trust.
describe('PROGRESS_FRACTION — the pattern behind the anti-fake-progress assertions', () => {
  it('MATCHES a real progress fraction', () => {
    for (const s of ['3 of 7', '3/7', '1 / 9', '12 of 100', 'step 2 of 9 complete']) {
      expect(s).toMatch(PROGRESS_FRACTION);
    }
  });

  it('does NOT match a date or time in any of the renderings CI or a dev box produce', () => {
    for (const s of [
      '10/1/2026',            // en-US toLocaleDateString — the one that broke CI
      '1/10/2026',            // en-GB style
      '2026-10-01',           // ISO
      '1.10.2026',            // de-DE
      '9/23/2026, 9:07:50 AM' // toLocaleString, as the rail stamp renders it
    ]) {
      expect(s).not.toMatch(PROGRESS_FRACTION);
    }
  });
});
