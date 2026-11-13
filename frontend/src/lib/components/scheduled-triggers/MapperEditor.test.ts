// @vitest-environment jsdom
//
// Spec 2 §2-B — MapperEditor component tests.
// Tests: add/remove rows, validation errors, live preview with jsonpath-plus.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import MapperEditor from './MapperEditor.svelte';

const SAMPLE_RECORD = {
  title: 'Hello World',
  link: 'https://example.com/hello',
  categories: ['tech', 'svelte'],
  author: { name: 'Alice', email: 'alice@example.com' },
  nested: { items: [{ id: 1, label: 'a' }, { id: 2, label: 'b' }] },
};

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

describe('MapperEditor', () => {
  it('renders with no rows when value is empty', () => {
    app = mount(MapperEditor, { target: host, props: { value: {} } });
    flushSync();
    const rows = host.querySelectorAll('[data-testid^="mapper-row-"]');
    expect(rows.length).toBe(0);
    expect(host.querySelector('[data-testid="mapper-add-row"]')).toBeTruthy();
  });

  it('renders existing rows from value prop', () => {
    app = mount(MapperEditor, {
      target: host,
      props: {
        value: { card_title: '$.title', card_body: '$.link' },
      },
    });
    flushSync();
    const rows = host.querySelectorAll('[data-testid^="mapper-row-"]');
    expect(rows.length).toBe(2);
  });

  it('adds a new row when + Add field is clicked', async () => {
    app = mount(MapperEditor, { target: host, props: { value: {} } });
    flushSync();
    await tick();

    const addBtn = host.querySelector<HTMLButtonElement>('[data-testid="mapper-add-row"]')!;
    expect(addBtn).toBeTruthy();

    // Click triggers addRow() which reassigns rows = [...rows, newRow].
    addBtn.click();
    flushSync();
    await tick();
    await tick();
    await tick();
    flushSync();

    const rows = host.querySelectorAll('[data-testid^="mapper-row-"]');
    expect(rows.length).toBe(1);
  });

  it('removes a row when × is clicked', async () => {
    app = mount(MapperEditor, {
      target: host,
      props: { value: { card_title: '$.title' } },
    });
    flushSync();

    const removeBtn = host.querySelector<HTMLButtonElement>('[data-testid="mapper-remove-0"]')!;
    removeBtn.click();
    flushSync();
    await tick();

    const rows = host.querySelectorAll('[data-testid^="mapper-row-"]');
    expect(rows.length).toBe(0);
  });

  it('shows validation error when path does not start with $', async () => {
    app = mount(MapperEditor, {
      target: host,
      props: { value: { card_title: '$.title' } },
    });
    flushSync();

    const pathInput = host.querySelector<HTMLInputElement>('[data-testid="mapper-path-0"]')!;
    pathInput.value = 'title';
    pathInput.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    await tick();

    const err = host.querySelector('[data-testid="mapper-path-error-0"]');
    expect(err).toBeTruthy();
    expect(err!.textContent).toContain('Must start with $');
  });

  it('shows validation error for filter expression [?(...)]', async () => {
    app = mount(MapperEditor, {
      target: host,
      props: { value: { card_title: '$.title' } },
    });
    flushSync();

    const pathInput = host.querySelector<HTMLInputElement>('[data-testid="mapper-path-0"]')!;
    pathInput.value = '$.items[?(@.id > 1)]';
    pathInput.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    await tick();

    const err = host.querySelector('[data-testid="mapper-path-error-0"]');
    expect(err).toBeTruthy();
    expect(err!.textContent).toContain('Filter expressions');
  });

  it('shows validation error for script expression [(...)]', async () => {
    app = mount(MapperEditor, {
      target: host,
      props: { value: { card_title: '$.title' } },
    });
    flushSync();

    const pathInput = host.querySelector<HTMLInputElement>('[data-testid="mapper-path-0"]')!;
    pathInput.value = '$.items[(@.length-1)]';
    pathInput.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    await tick();

    const err = host.querySelector('[data-testid="mapper-path-error-0"]');
    expect(err).toBeTruthy();
    expect(err!.textContent).toContain('Script expressions');
  });

  it('shows live preview for scalar path', () => {
    app = mount(MapperEditor, {
      target: host,
      props: {
        value: { card_title: '$.title' },
        sample: SAMPLE_RECORD,
      },
    });
    flushSync();

    const preview = host.querySelector('[data-testid="mapper-preview-0"]');
    expect(preview).toBeTruthy();
    expect(preview!.textContent).toContain('Hello World');
  });

  it('shows live preview for array projection [*]', () => {
    app = mount(MapperEditor, {
      target: host,
      props: {
        value: { card_labels: '$.categories[*]' },
        sample: SAMPLE_RECORD,
      },
    });
    flushSync();

    const preview = host.querySelector('[data-testid="mapper-preview-0"]');
    expect(preview).toBeTruthy();
    expect(preview!.textContent).toContain('tech');
    expect(preview!.textContent).toContain('svelte');
  });

  it('shows live preview for recursive descent', () => {
    app = mount(MapperEditor, {
      target: host,
      props: {
        value: { all_labels: '$..label' },
        sample: SAMPLE_RECORD,
      },
    });
    flushSync();

    const preview = host.querySelector('[data-testid="mapper-preview-0"]');
    expect(preview).toBeTruthy();
    expect(preview!.textContent).toContain('a');
    expect(preview!.textContent).toContain('b');
  });

  it('validate() returns false when any path has an error', () => {
    app = mount(MapperEditor, {
      target: host,
      props: { value: { card_title: 'title' } }, // missing $
    });
    flushSync();
    const component = app as unknown as { validate: () => boolean };
    expect(component.validate()).toBe(false);
    flushSync();
    const err = host.querySelector('[data-testid="mapper-path-error-0"]');
    expect(err).toBeTruthy();
  });

  it('validate() returns true when all paths are valid', () => {
    app = mount(MapperEditor, {
      target: host,
      props: {
        value: {
          card_title: '$.title',
          card_labels: '$.categories[*]',
        },
      },
    });
    flushSync();
    const component = app as unknown as { validate: () => boolean };
    expect(component.validate()).toBe(true);
  });

  it('emits onChange when a row is modified', async () => {
    const emitted: unknown[] = [];
    app = mount(MapperEditor, {
      target: host,
      props: {
        value: { card_title: '$.title' },
        onChange: (v: unknown) => emitted.push(v),
      },
    });
    flushSync();

    // Modify the key of the first row
    const keyInput = host.querySelector<HTMLInputElement>('[data-testid="mapper-key-0"]')!;
    keyInput.value = 'new_title';
    keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    await tick();

    expect(emitted.length).toBeGreaterThan(0);
  });

  it('preview is absent when no sample is provided', () => {
    app = mount(MapperEditor, {
      target: host,
      props: { value: { card_title: '$.title' } },
      // no sample
    });
    flushSync();

    const preview = host.querySelector('[data-testid="mapper-preview-0"]');
    expect(preview).toBeNull();
  });
});
