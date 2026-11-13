// @vitest-environment jsdom
//
// P2.3 — Skeleton primitive tests.
// Uses Svelte 5 mount + flushSync.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import Skeleton from './Skeleton.svelte';

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

describe('Skeleton', () => {
  it('renders one item by default', () => {
    app = mount(Skeleton, { target: host, props: {} });
    flushSync();
    const items = host.querySelectorAll('[data-testid="skeleton-item"]');
    expect(items.length).toBe(1);
  });

  it('renders count placeholders when count=3', () => {
    app = mount(Skeleton, { target: host, props: { count: 3 } });
    flushSync();
    const items = host.querySelectorAll('[data-testid="skeleton-item"]');
    expect(items.length).toBe(3);
  });

  it('text variant rotates widths when count > 1', () => {
    app = mount(Skeleton, {
      target: host,
      props: { variant: 'text', count: 3 },
    });
    flushSync();
    const items = Array.from(
      host.querySelectorAll<HTMLElement>('[data-testid="skeleton-item"]'),
    );
    expect(items.length).toBe(3);
    expect(items[0]!.style.width).toBe('60%');
    expect(items[1]!.style.width).toBe('90%');
    expect(items[2]!.style.width).toBe('70%');
    expect(items[0]!.className).toContain('rounded-sm');
  });

  it('uses motion-safe gate for animate-pulse (respects prefers-reduced-motion)', () => {
    // We don't render Tailwind here; we assert the class string includes the
    // `motion-safe:animate-pulse` token. Tailwind's motion-safe variant is
    // gated by `@media (prefers-reduced-motion: no-preference)` at CSS layer,
    // so emitting the prefixed class is the contract.
    app = mount(Skeleton, { target: host, props: {} });
    flushSync();
    const item = host.querySelector<HTMLElement>('[data-testid="skeleton-item"]')!;
    expect(item.className).toContain('motion-safe:animate-pulse');
    // And it must NOT emit the unconditional `animate-pulse` class.
    const classes = item.className.split(/\s+/);
    expect(classes).not.toContain('animate-pulse');
  });

  it('forwards class prop onto root', () => {
    app = mount(Skeleton, { target: host, props: { class: 'my-extra' } });
    flushSync();
    const root = host.querySelector<HTMLElement>('[data-testid="skeleton-root"]')!;
    expect(root.className).toContain('my-extra');
  });
});
