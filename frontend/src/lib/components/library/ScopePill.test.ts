// @vitest-environment jsdom
//
// ScopePill.test.ts
//
// Mounts ScopePill in jsdom and asserts the right letter + aria-label render
// for each scope. `@testing-library/svelte`
// is not installed, so we use Svelte 5's mount/unmount/flushSync directly.
//
// Spec: docs/archive/2026-04-27-foundation-design.md §6.4
// Plan: docs/superpowers/plans/2026-04-27-plan-2-org-and-scoping.md Task 13.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ScopePill from './ScopePill.svelte';

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

describe('ScopePill', () => {
  it('renders W chip for workspace scope with the right aria-label', () => {
    app = mount(ScopePill, { target: host, props: { scope: 'workspace' } });
    flushSync();

    const chip = host.querySelector('[data-testid="scope-pill"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent?.trim()).toBe('W');
    expect(chip?.getAttribute('aria-label')).toBe('workspace scope');
    expect(chip?.getAttribute('data-scope')).toBe('workspace');
  });

  it('renders D chip for department scope', () => {
    app = mount(ScopePill, { target: host, props: { scope: 'department' } });
    flushSync();

    const chip = host.querySelector('[data-testid="scope-pill"]');
    expect(chip?.textContent?.trim()).toBe('D');
    expect(chip?.getAttribute('aria-label')).toBe('department scope');
  });

  it('renders P chip for project scope', () => {
    app = mount(ScopePill, { target: host, props: { scope: 'project' } });
    flushSync();

    const chip = host.querySelector('[data-testid="scope-pill"]');
    expect(chip?.textContent?.trim()).toBe('P');
    expect(chip?.getAttribute('aria-label')).toBe('project scope');
  });
});
