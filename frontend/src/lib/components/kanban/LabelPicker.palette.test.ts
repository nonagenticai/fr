// Every swatch the label picker offers must be a colour Planka will accept.
//
// Planka OWNS this domain: `Label.COLORS` in its own model, validated at
// `labels/create.js` with `color: { isIn: Label.COLORS }`, so an unknown value
// is a Sails 400 ValidationError. Nothing in fr narrows it first —
// `types/api.ts` types `color: string`, and `routes/assets/kanban.ts` passes
// the parsed body straight to `createLabel`. So a bad swatch is not caught
// anywhere in fr; the user just clicks it and the label is never created.
//
// Two of the 25 swatches were exactly that: `lagoon-green` and `sun-yellow`
// are not in Planka's 42-colour set and never have been. They look seeded from
// the wrong enum — the palette's first nine entries are Planka's *List* colour
// set, which is a different, smaller domain.
//
// ⛔ This test derives the accepted set from the GENERATED client rather than
// hardcoding 42 strings. A hardcoded copy passes today and rots exactly the way
// the palette did — that is the whole defect class. The generated file is
// produced by orval from Planka's OpenAPI spec, so it moves when Planka moves.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Both sides are PARSED from source rather than imported: the generated client
// lives outside `frontend/`, so it is not resolvable as a dependency here.
// Parsing keeps the property that matters — the accepted set is derived from
// the generated artefact, so it moves when Planka's spec moves.
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// LabelPicker no longer CREATES labels (2026-10-10 — labels are created in
// Planka), so it has no swatch palette left; its colour->class render map is
// the copy of this domain it still owns.
function paletteFromSource(): string[] {
  const src = read('./LabelPicker.svelte');
  const block = src.match(/const map: Record<string, string> = \{([\s\S]*?)\};/);
  if (!block) throw new Error('LabelPicker map not found — update this parser, do not delete it');
  return [...block[1].matchAll(/'([a-z-]+)':/g)].map((m) => m[1]);
}

// `ListColumn.svelte` keeps its OWN colour->class map for rendering a label
// chip. It is a second copy of the same domain, so it rots the same way — it
// carried `lagoon-green` and `sun-yellow` long after `LabelPicker` dropped
// them. Parsed here so the two lists cannot drift apart again silently.
function renderMapFromSource(): string[] {
  const src = read('./ListColumn.svelte');
  const block = src.match(/const map: Record<string, string> = \{([\s\S]*?)\};/);
  if (!block) throw new Error('ListColumn map not found — update this parser, do not delete it');
  return [...block[1].matchAll(/'([a-z-]+)':/g)].map((m) => m[1]);
}

function acceptedFromGeneratedClient(): string[] {
  const src = read(
    '../../../../../packages/service-clients/kanban/src/generated/models/createLabelBodyColor.ts',
  );
  const block = src.match(/export const CreateLabelBodyColor = \{([\s\S]*?)\} as const;/);
  if (!block) throw new Error('generated enum not found — update this parser, do not delete it');
  return [...block[1].matchAll(/'([a-z-]+)':/g)].map((m) => m[1]);
}

describe('LabelPicker / ListColumn label colours are colours Planka accepts', () => {
  const accepted = new Set(acceptedFromGeneratedClient());
  const palette = paletteFromSource();

  // ⛔ NON-VACUITY GUARDS. Without these, a parser that stops matching returns
  // [] and a client import that resolves to {} gives an empty set — and the
  // real assertion below then passes by measuring nothing.
  it('the parser and the generated client both yield a real set', () => {
    expect(palette.length).toBeGreaterThanOrEqual(20);
    expect(accepted.size).toBeGreaterThanOrEqual(40);
  });

  it('every palette colour is accepted by Planka', () => {
    const rejected = palette.filter((c) => !accepted.has(c));
    // Fails on THIS assertion naming the offenders, e.g.
    //   ["lagoon-green", "sun-yellow"]
    expect(rejected).toEqual([]);
  });

  it('the palette has no duplicates', () => {
    expect(new Set(palette).size).toBe(palette.length);
  });

  // The render map is the second copy of this domain. A key Planka rejects can
  // never match a real `PlankaLabel.color`, so it is dead by construction — but
  // dead code that looks authoritative is how the picker's own two bad swatches
  // survived. Same derivation, same guard.
  const renderMap = renderMapFromSource();

  it('the render-map parser yields a real set', () => {
    expect(renderMap.length).toBeGreaterThanOrEqual(20);
  });

  it('every ListColumn render-map colour is accepted by Planka', () => {
    const rejected = renderMap.filter((c) => !accepted.has(c));
    // Fails on THIS assertion naming the offenders, e.g.
    //   ["lagoon-green", "sun-yellow"]
    expect(rejected).toEqual([]);
  });
});
