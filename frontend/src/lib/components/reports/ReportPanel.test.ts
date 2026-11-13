// @vitest-environment jsdom
//
// ReportPanel.test.ts
//
// Render tests for the four-state envelope every /reports page uses. Svelte 5
// mount/flushSync pattern (same as PageHeader.test.ts).
//
// These assert what a USER SEES in each state, not that a branch was taken.
// The state that matters most is the third case below: a failed request must
// never be rendered as "no data" — that mistake tells a customer their data is
// gone when the server merely fell over.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync, createRawSnippet, type ComponentProps } from 'svelte';
import ReportPanel from './ReportPanel.svelte';

type PanelProps = ComponentProps<typeof ReportPanel>;

const children = createRawSnippet(() => ({
  render: () => `<table data-testid="rows"><tbody><tr><td>Deploy to prod</td></tr></tbody></table>`,
}));

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

const base = {
  label: 'the approval backlog',
  emptyMessage: 'Nothing is waiting on you.',
  children,
};

// `loading` and `empty` stay REQUIRED here on purpose: every case must state
// which of the four states it is exercising rather than inheriting a default.
function render(
  props: Partial<PanelProps> & Pick<PanelProps, 'loading' | 'empty'>,
): void {
  app = mount(ReportPanel, { target: host, props: { ...base, ...props } });
  flushSync();
}

describe('ReportPanel — loading', () => {
  it('names what is loading and renders no content, error or empty text', () => {
    render({ loading: true, empty: false });
    expect(host.querySelector('[data-testid="report-loading"]')?.textContent).toContain(
      'Loading the approval backlog',
    );
    expect(host.querySelector('[data-testid="report-content"]')).toBeNull();
    expect(host.querySelector('[data-testid="report-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="report-empty"]')).toBeNull();
  });
});

describe('ReportPanel — error', () => {
  it('renders the failure message, not a blank panel', () => {
    render({
      loading: false,
      empty: true,
      error: 'reports.approval-backlog failed: 500 Internal Server Error — db pool exhausted',
    });
    const err = host.querySelector('[data-testid="report-error"]');
    expect(err).not.toBeNull();
    // The status AND the reason must both reach the screen.
    expect(err?.textContent).toContain('Could not load the approval backlog');
    expect(err?.textContent).toContain('500');
    expect(err?.textContent).toContain('db pool exhausted');
  });

  it('an error OUTRANKS empty — a 500 is never shown as "no data"', () => {
    // `empty: true` is passed deliberately: on a failed fetch the row array is
    // still [], so the naive ordering renders the empty message and tells the
    // user their backlog is clear while the server is down.
    render({ loading: false, empty: true, error: 'boom' });
    expect(host.querySelector('[data-testid="report-error"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="report-empty"]')).toBeNull();
    expect(host.textContent).not.toContain('Nothing is waiting on you.');
  });

  it('renders a retry control only when onRetry is supplied', () => {
    render({ loading: false, empty: false, error: 'boom' });
    expect(host.querySelector('[data-testid="report-error-retry"]')).toBeNull();
    unmount(app!);
    app = null;

    let retried = 0;
    render({ loading: false, empty: false, error: 'boom', onRetry: () => (retried += 1) });
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="report-error-retry"]');
    expect(btn).not.toBeNull();
    btn!.click();
    flushSync();
    expect(retried).toBe(1);
  });
});

describe('ReportPanel — empty', () => {
  it('renders the supplied message, not a bare table', () => {
    render({ loading: false, empty: true });
    expect(host.querySelector('[data-testid="report-empty"]')?.textContent).toContain(
      'Nothing is waiting on you.',
    );
    expect(host.querySelector('[data-testid="rows"]')).toBeNull();
    expect(host.querySelector('[data-testid="report-content"]')).toBeNull();
  });

  it('the empty message is caller-supplied, so each report explains its own gap', () => {
    render({
      loading: false,
      empty: true,
      emptyMessage: 'No stored reports for this workspace yet.',
    });
    expect(host.textContent).toContain('No stored reports for this workspace yet.');
  });
});

describe('ReportPanel — populated', () => {
  it('renders the children and none of the three other states', () => {
    render({ loading: false, empty: false });
    expect(host.querySelector('[data-testid="report-content"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="rows"]')?.textContent).toContain('Deploy to prod');
    expect(host.querySelector('[data-testid="report-loading"]')).toBeNull();
    expect(host.querySelector('[data-testid="report-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="report-empty"]')).toBeNull();
  });

  it('loading OUTRANKS populated — stale rows are not shown during a refetch', () => {
    render({ loading: true, empty: false });
    expect(host.querySelector('[data-testid="rows"]')).toBeNull();
  });
});
