// @vitest-environment jsdom
//
// QueueRecord — what a reviewer is SHOWN before being asked for a verdict.
//
// Two defects are under test, and both were pure omissions in the template:
// `QueueItem.abstract` has been typed at `lib/api/reviews.ts:162` and served by
// Evidence Review (`services/screening.py:609`, `version.abstract if version
// else None`) the whole time, and the queue row rendered the title and stopped.
// The DOI was rendered as a `<code>`, so there was no route from the queue to
// the paper.
//
// The assertions that matter are the NEGATIVE ones: a record without an
// abstract must say so, and a value that cannot be proven to be a DOI must NOT
// become a link. Silence and a dead link are both indistinguishable from the
// bug they replace.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import QueueRecord from './QueueRecord.svelte';
import type { QueueItem } from '$lib/api/reviews';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function item(over: Partial<QueueItem> = {}): QueueItem {
  return {
    assignment_id: 'a-1',
    review_record_id: 'r-1',
    title: 'Stress echocardiography for prognosis',
    abstract: 'Background: we assessed prognosis. Methods: a cohort. Results: it worked.',
    publication_year: 2021,
    authors: ['A. Author'],
    container_title: 'Journal of Trials',
    doi: '10.1000/abc.123',
    record_type: 'journal-article',
    my_decision: null,
    ...over,
  };
}

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

const q = (t: string) => host.querySelector(`[data-testid="${t}"]`);
function render(props: { item: QueueItem; clampChars?: number }): void {
  app = mount(QueueRecord, { target: host, props });
  flushSync();
}

describe('QueueRecord — the abstract', () => {
  it('renders the abstract the API already returns', () => {
    render({ item: item() });
    const el = q('queue-record-abstract');
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain('Methods: a cohort');
    // The absence notice is the OTHER state; both must never render at once.
    expect(q('queue-record-no-abstract')).toBeNull();
  });

  it('says so explicitly when the record has no abstract', () => {
    render({ item: item({ abstract: null }) });
    expect(q('queue-record-abstract')).toBeNull();
    expect(q('queue-record-no-abstract')?.textContent).toContain('No abstract in this record');
  });

  it('treats a blank abstract as absent, not as an empty box', () => {
    // An import whose abstract column was present but empty. Rendering this as
    // an abstract produces a blank bordered box, which reads as "this paper has
    // nothing to say" rather than "we were never given the text".
    render({ item: item({ abstract: '   \n  ' }) });
    expect(q('queue-record-abstract')).toBeNull();
    expect(q('queue-record-no-abstract')).not.toBeNull();
  });

  it('clamps a long abstract and expands it on request', () => {
    const long = `${'word '.repeat(300)}TAIL_MARKER`;
    render({ item: item({ abstract: long }), clampChars: 100 });

    const el = () => q('queue-record-abstract') as HTMLElement;
    expect(el().dataset.truncated).toBe('true');
    expect(el().textContent).not.toContain('TAIL_MARKER');

    const toggle = q('queue-record-abstract-toggle') as HTMLButtonElement;
    expect(toggle.textContent?.trim()).toBe('Show full abstract');
    toggle.click();
    flushSync();

    expect(el().dataset.truncated).toBe('false');
    expect(el().textContent).toContain('TAIL_MARKER');
  });

  it('offers no toggle for an abstract that already fits', () => {
    render({ item: item(), clampChars: 5000 });
    expect(q('queue-record-abstract-toggle')).toBeNull();
    expect((q('queue-record-abstract') as HTMLElement).dataset.truncated).toBe('false');
  });
});

describe('QueueRecord — the DOI', () => {
  it('renders a bare DOI as a resolver link, not as a <code>', () => {
    render({ item: item() });
    const a = q('queue-record-doi-link') as HTMLAnchorElement;
    expect(a).not.toBeNull();
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe('https://doi.org/10.1000/abc.123');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
    expect(a.getAttribute('rel')).toContain('noreferrer');
    // The reviewer still reads the identifier itself.
    expect(a.textContent?.trim()).toBe('10.1000/abc.123');
    expect(q('queue-record-doi-plain')).toBeNull();
  });

  it('does not double the resolver on an already-prefixed DOI', () => {
    // RIS and CSL-JSON both carry DOIs this way; `https://doi.org/${doi}` would
    // yield https://doi.org/https://doi.org/… and 404.
    render({ item: item({ doi: 'https://doi.org/10.1000/abc.123' }) });
    expect((q('queue-record-doi-link') as HTMLAnchorElement).getAttribute('href')).toBe(
      'https://doi.org/10.1000/abc.123',
    );
  });

  it('refuses to link a value that is not a DOI, but still shows it', () => {
    render({ item: item({ doi: 'PMC123456' }) });
    expect(q('queue-record-doi-link')).toBeNull();
    expect(q('queue-record-doi-plain')?.textContent?.trim()).toBe('PMC123456');
  });

  it('renders no DOI affordance at all when there is no DOI', () => {
    render({ item: item({ doi: null }) });
    expect(q('queue-record-doi-link')).toBeNull();
    expect(q('queue-record-doi-plain')).toBeNull();
  });

  it('still renders the title when it is missing', () => {
    render({ item: item({ title: null }) });
    expect(q('queue-record-title')?.textContent?.trim()).toBe('(untitled)');
  });
});
