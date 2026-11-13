// @vitest-environment jsdom
//
// PageHeader.test.ts
//
// Render tests for the shared page-title header. Svelte 5 mount/flushSync
// pattern. Locks the
// two variants + the actions snippet contract that ProjectInspectHeader and the
// 4 lens pages depend on.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync, createRawSnippet } from 'svelte';
import PageHeader from './PageHeader.svelte';

const actions = createRawSnippet(() => ({
  render: () => `<button data-testid="hdr-action">Go</button>`,
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

describe('PageHeader', () => {
  it('page variant renders title + subtitle and no back-link', () => {
    app = mount(PageHeader, {
      target: host,
      props: { title: 'Control tower', subtitle: 'Fleet-wide operator lens.' },
    });
    flushSync();

    const h1 = host.querySelector('h1');
    expect(h1?.textContent?.trim()).toBe('Control tower');
    expect(h1?.className).toContain('text-lg');
    expect(host.querySelector('p')?.textContent?.trim()).toBe('Fleet-wide operator lens.');
    // No border/back-link chrome in the default page variant.
    expect(host.querySelector('header')).toBeNull();
    expect(host.querySelector('a')).toBeNull();
  });

  it('inspect variant renders a back-link to backHref and the heavier title style', () => {
    app = mount(PageHeader, {
      target: host,
      props: {
        title: 'Executions',
        subtitle: 'Runs reached from the cockpit.',
        variant: 'inspect',
        backHref: '/projects/abc',
        backLabel: 'Cockpit',
      },
    });
    flushSync();

    expect(host.querySelector('header')).not.toBeNull();
    const back = host.querySelector('a');
    expect(back?.getAttribute('href')).toBe('/projects/abc');
    expect(back?.textContent?.trim()).toContain('Cockpit');
    const h1 = host.querySelector('h1');
    expect(h1?.textContent?.trim()).toBe('Executions');
    expect(h1?.className).toContain('text-xl');
  });

  it('inspect variant omits the back-link when backHref is unset', () => {
    app = mount(PageHeader, {
      target: host,
      props: { title: 'No back', variant: 'inspect' },
    });
    flushSync();

    expect(host.querySelector('header')).not.toBeNull();
    expect(host.querySelector('a')).toBeNull();
  });

  it('renders the actions snippet when provided', () => {
    app = mount(PageHeader, {
      target: host,
      props: { title: 'With actions', actions },
    });
    flushSync();

    expect(host.querySelector('[data-testid="hdr-action"]')).not.toBeNull();
  });
});
