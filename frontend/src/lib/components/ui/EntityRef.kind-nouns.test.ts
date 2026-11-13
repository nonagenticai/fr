// @vitest-environment jsdom
//
// EntityRef — every `EntityKind` has usable "gone" copy. Svelte 5 mount +
// flushSync (the `EntityRef.test.ts` / `Skeleton.test.ts` pattern).
//
// THE DEFECT this closes: `goneLabel` used to be
// `Deleted ${kind ? KIND_NOUN[kind] : 'record'}`, and `Record<K, V>` types an
// absent key as `string` rather than `string | undefined`. So the moment
// `EntityKind` gained a member without a matching `KIND_NOUN` entry — which is
// exactly what widening the union for fr#1205 does — the component rendered the
// literal text `Deleted undefined` at the operator, with no type error and no
// failing test anywhere.
//
// ⚠️ THIS FILE IS THE ONLY RUNTIME GATE ON THAT PAIRING. It is table-driven over
// `ENTITY_KINDS`, the runtime array `EntityKind` is derived from, so a kind
// cannot be added to the union without also entering this table. Killing
// mutation: add a member to `ENTITY_KINDS` and omit its `KIND_NOUN` entry ⇒ the
// noun falls back to `record` and the "not the generic fallback" assertion here
// goes RED. (Without that third assertion the fallback would absorb the mutation
// and this file would be a gate that cannot fail.)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import EntityRef, { ENTITY_KINDS, type EntityKind } from './EntityRef.svelte';

const UUID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

/** What `kindNoun` falls back to. No real kind may render this. */
const FALLBACK_LABEL = 'Deleted record';

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

function mountUnresolved(props: Record<string, unknown>): HTMLElement {
  app = mount(EntityRef, { target: host, props: { id: UUID, resolved: false, ...props } });
  flushSync();
  return host.querySelector<HTMLElement>('[data-testid="entity-ref-unresolved"]')!;
}

describe('EntityRef — the unresolved label for every EntityKind', () => {
  it('POSITIVE CONTROL — the table is not empty and covers the original four kinds', () => {
    // Without this, emptying `ENTITY_KINDS` would silently delete every
    // assertion below while the file still reported green.
    // ⚠️ 15 (16 until `procedure` was removed). A floor BELOW the real member count
    // lets a later change delete the members this file exists to cover while the
    // control still passes — the ratchet has to sit AT the count, not under it.
    expect(ENTITY_KINDS.length).toBeGreaterThanOrEqual(15);
    for (const kind of ['tenant', 'user', 'app', 'licence']) {
      expect(ENTITY_KINDS as readonly string[]).toContain(kind);
    }
  });

  for (const kind of ENTITY_KINDS) {
    describe(`kind="${kind}"`, () => {
      it('renders a non-empty gone label', () => {
        const gone = mountUnresolved({ kind });
        expect(gone).toBeTruthy();
        expect(gone.textContent!.trim()).not.toBe('');
      });

      it('never renders the string "undefined"', () => {
        // The exact production symptom: `Deleted undefined`.
        const gone = mountUnresolved({ kind });
        expect(gone.textContent).not.toContain('undefined');
        // And nowhere else in the subtree either — the tooltip is operator-facing too.
        const root = host.querySelector<HTMLElement>('[data-testid="entity-ref"]')!;
        expect(root.textContent).not.toContain('undefined');
        expect(root.getAttribute('title')).not.toContain('undefined');
      });

      it('uses its OWN noun, not the generic fallback', () => {
        // ⭐ The killing assertion. A kind with no `KIND_NOUN` entry drops to
        // `Deleted record`, which is non-empty and contains no "undefined" —
        // so only this comparison catches the missing entry.
        const gone = mountUnresolved({ kind });
        expect(gone.textContent!.trim()).not.toBe(FALLBACK_LABEL);
      });
    });
  }

  it('the generic fallback is still reachable when NO kind is given', () => {
    // The negative control for the assertion above: it must be possible to
    // render `Deleted record`, otherwise "not the fallback" would pass for a
    // reason unrelated to KIND_NOUN.
    const gone = mountUnresolved({ kind: undefined });
    expect(gone.textContent!.trim()).toBe(FALLBACK_LABEL);
  });

  it('a kind arriving from untyped data renders the fallback, never "undefined"', () => {
    // `kind` reaches this component from serialised API rows and route params in
    // several places, so an out-of-union value is reachable at runtime even
    // though tsc forbids writing one. `Record<EntityKind, string>` indexing
    // returned `undefined` here and printed it.
    const gone = mountUnresolved({ kind: 'not-a-kind' as EntityKind });
    expect(gone.textContent).not.toContain('undefined');
    expect(gone.textContent!.trim()).toBe(FALLBACK_LABEL);
  });
});
