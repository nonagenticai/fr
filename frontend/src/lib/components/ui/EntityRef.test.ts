// @vitest-environment jsdom
//
// EntityRef primitive tests. Svelte 5 mount + flushSync (Skeleton.test.ts pattern).
//
// The contract under test is a UX one — "never show the operator a raw uuid
// where a name exists, and never spill a full uuid inline at all" — so every
// assertion reads the RENDERED output. Asserting on props would keep passing
// after the template stopped honouring them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import EntityRef from './EntityRef.svelte';

const UUID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
// The stub is the TAIL of the id (fr#1203), so this is the last 8 characters.
const SHORT = '2a3b4c5d';
// What the stub must NEVER be again: the first 8 characters.
const LEADING = '3f2b1c4d';

// ⚠️ THESE TWO FIXTURES MUST SHARE THEIR FIRST 8 CHARACTERS. Do not "simplify"
// them into two freshly generated random uuids — that version of this test
// PASSES under the leading-slice bug it exists to catch, and is worthless.
//
// They are shaped like the real ids: UUIDv7, i.e. a monotonic timestamp prefix
// followed by random bytes. `06954722` is the literal prefix that 13 different
// apps rendered identically in production (fr#1203). Rows provisioned in one
// batch always look like this, so any id-stub scheme has to discriminate here
// or it discriminates nowhere that matters.
const BATCH_SIBLING_A = '0695472200007000800000000000000a';
const BATCH_SIBLING_B = '0695472200007000800000000000000b';

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

function root(): HTMLElement {
  return host.querySelector<HTMLElement>('[data-testid="entity-ref"]')!;
}

describe('EntityRef', () => {
  it('shows the name when one is given', () => {
    app = mount(EntityRef, { target: host, props: { id: UUID, name: 'Acme Corp', kind: 'tenant' } });
    flushSync();
    const nameEl = host.querySelector<HTMLElement>('[data-testid="entity-ref-name"]');
    expect(nameEl).toBeTruthy();
    expect(nameEl!.textContent).toContain('Acme Corp');
  });

  it('never renders the full uuid inline, even alongside a name', () => {
    app = mount(EntityRef, { target: host, props: { id: UUID, name: 'Acme Corp', kind: 'tenant' } });
    flushSync();
    // The whole rendered subtree — not just the id slot — must be uuid-free.
    expect(root().textContent).not.toContain(UUID);
    expect(root().textContent).toContain(SHORT);
  });

  it('keeps the full id reachable in the tooltip, not in the flow', () => {
    app = mount(EntityRef, { target: host, props: { id: UUID, name: 'Acme Corp' } });
    flushSync();
    // "Secondary, not absent": an operator cross-referencing a log line still
    // needs the exact value. Losing this turns the name into a dead end.
    expect(root().getAttribute('title')).toContain(UUID);
    expect(root().getAttribute('title')).toContain('Acme Corp');
  });

  it('renders the id as a short monospace stub, not the raw value, when no name is known', () => {
    app = mount(EntityRef, { target: host, props: { id: UUID } });
    flushSync();
    expect(host.querySelector('[data-testid="entity-ref-name"]')).toBeNull();
    const idEl = host.querySelector<HTMLElement>('[data-testid="entity-ref-id"]')!;
    expect(idEl.textContent!.trim()).toBe(`…${SHORT}`);
    expect(idEl.textContent).not.toContain(UUID);
    expect(idEl.className).toContain('font-mono');
  });

  it('takes the stub from the TAIL, so two ids from one provisioning batch differ', () => {
    // fr#1203, the whole point of this file. The ids differ ONLY after character
    // 8 (see BATCH_SIBLING_* above and the comment on why they must). A leading
    // slice renders both as `06954722…` — one stub for two apps, which is the
    // bug: 13 apps shared that stub in production.
    app = mount(EntityRef, { target: host, props: { id: BATCH_SIBLING_A, kind: 'app' } });
    flushSync();
    const stubA = host.querySelector<HTMLElement>('[data-testid="entity-ref-id"]')!.textContent!.trim();
    unmount(app);
    app = mount(EntityRef, { target: host, props: { id: BATCH_SIBLING_B, kind: 'app' } });
    flushSync();
    const stubB = host.querySelector<HTMLElement>('[data-testid="entity-ref-id"]')!.textContent!.trim();

    // RED under `slice(0, 8)`: both sides would be `06954722…`.
    expect(stubA).not.toBe(stubB);
    // And pin WHICH end, so "make them differ" cannot be satisfied by hashing,
    // widening the leading slice, or any other scheme that drops the tail.
    expect(stubA).toBe('…0000000a');
    expect(stubB).toBe('…0000000b');
  });

  it('never renders the LEADING characters of the id as the stub', () => {
    // A second, independent kill for the same defect on a plain dashed uuid:
    // the stub slot must not contain the timestamp-side prefix at all.
    app = mount(EntityRef, { target: host, props: { id: UUID } });
    flushSync();
    const idEl = host.querySelector<HTMLElement>('[data-testid="entity-ref-id"]')!;
    expect(idEl.textContent).not.toContain(LEADING);
    expect(idEl.textContent).toContain(SHORT);
  });

  it('does not truncate an id that is already short', () => {
    app = mount(EntityRef, { target: host, props: { id: 'abc123' } });
    flushSync();
    const idEl = host.querySelector<HTMLElement>('[data-testid="entity-ref-id"]')!;
    expect(idEl.textContent!.trim()).toBe('abc123');
  });

  it('marks an unresolved referent as gone and still shows the short id', () => {
    app = mount(EntityRef, {
      target: host,
      props: { id: UUID, kind: 'user', resolved: false },
    });
    flushSync();
    const gone = host.querySelector<HTMLElement>('[data-testid="entity-ref-unresolved"]')!;
    expect(gone.textContent).toContain('Deleted account');
    expect(gone.className).toContain('text-[var(--color-text-muted)]');
    expect(root().textContent).toContain(SHORT);
    expect(root().textContent).not.toContain(UUID);
  });

  it('an unresolved referent never renders a stale name as if it were live', () => {
    // resolved=false and name==null are different facts; a name left over from
    // a cached row must not make a deleted account look present.
    app = mount(EntityRef, {
      target: host,
      props: { id: UUID, name: 'Jane Doe', kind: 'user', resolved: false },
    });
    flushSync();
    expect(root().textContent).not.toContain('Jane Doe');
    expect(host.querySelector('[data-testid="entity-ref-name"]')).toBeNull();
    expect(root().textContent).toContain('Deleted account');
  });

  it('lets the owning page supply its own unresolved copy', () => {
    app = mount(EntityRef, {
      target: host,
      props: { id: UUID, kind: 'user', resolved: false, unresolvedLabel: 'Account removed' },
    });
    flushSync();
    const gone = host.querySelector<HTMLElement>('[data-testid="entity-ref-unresolved"]')!;
    expect(gone.textContent).toContain('Account removed');
    expect(gone.textContent).not.toContain('Deleted account');
  });

  it('names the kind in the default gone copy', () => {
    app = mount(EntityRef, { target: host, props: { id: UUID, kind: 'tenant', resolved: false } });
    flushSync();
    expect(root().textContent).toContain('Deleted tenant');
  });

  it('resolves to a name by default (no explicit resolved prop)', () => {
    app = mount(EntityRef, { target: host, props: { id: UUID, name: 'Acme Corp' } });
    flushSync();
    expect(host.querySelector('[data-testid="entity-ref-unresolved"]')).toBeNull();
    expect(root().getAttribute('data-resolved')).toBe('true');
  });

  it('forwards class onto the root', () => {
    app = mount(EntityRef, { target: host, props: { id: UUID, class: 'my-extra' } });
    flushSync();
    expect(root().className).toContain('my-extra');
  });
});
