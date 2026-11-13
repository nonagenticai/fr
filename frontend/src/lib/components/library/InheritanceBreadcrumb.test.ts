// @vitest-environment jsdom
//
// InheritanceBreadcrumb.test.ts
//
// Asserts the rendered string composition for the spec §6.4 (1) example
// plus pluralisation + omission of empty segments.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import InheritanceBreadcrumb from './InheritanceBreadcrumb.svelte';

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

function textOf(sel: string): string {
  return (
    host.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  );
}

describe('InheritanceBreadcrumb', () => {
  it('renders the full spec §6.4 (1) string', () => {
    app = mount(InheritanceBreadcrumb, {
      target: host,
      props: {
        defined_at: 'workspace',
        inherited_by_depts: 5,
        inherited_by_projects: 23,
        override_count: 2,
        block_count: 1,
      },
    });
    flushSync();

    expect(textOf('[data-testid="inheritance-defined-at"]')).toBe(
      'Defined at: Workspace',
    );
    expect(textOf('[data-testid="inheritance-inherited-by"]')).toBe(
      'Inherited by: 5 departments, 23 projects',
    );
    expect(textOf('[data-testid="inheritance-adjustments"]')).toBe(
      '2 overrides, 1 block',
    );
  });

  it('singularises the "1 department / 1 project / 1 override / 1 block" cases', () => {
    app = mount(InheritanceBreadcrumb, {
      target: host,
      props: {
        defined_at: 'department',
        inherited_by_depts: 1,
        inherited_by_projects: 1,
        override_count: 1,
        block_count: 1,
      },
    });
    flushSync();

    expect(textOf('[data-testid="inheritance-defined-at"]')).toBe(
      'Defined at: Department',
    );
    expect(textOf('[data-testid="inheritance-inherited-by"]')).toBe(
      'Inherited by: 1 department, 1 project',
    );
    expect(textOf('[data-testid="inheritance-adjustments"]')).toBe(
      '1 override, 1 block',
    );
  });

  it('omits the "Inherited by" + adjustments segments when both counts are zero', () => {
    app = mount(InheritanceBreadcrumb, {
      target: host,
      props: { defined_at: 'project' },
    });
    flushSync();

    expect(textOf('[data-testid="inheritance-defined-at"]')).toBe(
      'Defined at: Project',
    );
    expect(host.querySelector('[data-testid="inheritance-inherited-by"]'))
      .toBeNull();
    expect(host.querySelector('[data-testid="inheritance-adjustments"]'))
      .toBeNull();

    // The wrapper still says "Defined at:" and includes the count summary.
    expect(textOf('[data-testid="inheritance-breadcrumb"]')).toContain(
      'Defined at:',
    );
  });

  it('shows only the segments whose counts are non-zero', () => {
    app = mount(InheritanceBreadcrumb, {
      target: host,
      props: {
        defined_at: 'workspace',
        inherited_by_depts: 0,
        inherited_by_projects: 4,
        override_count: 0,
        block_count: 2,
      },
    });
    flushSync();

    expect(textOf('[data-testid="inheritance-inherited-by"]')).toBe(
      'Inherited by: 4 projects',
    );
    expect(textOf('[data-testid="inheritance-adjustments"]')).toBe('2 blocks');
  });
});
