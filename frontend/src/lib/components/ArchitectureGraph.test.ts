// Honesty tests for the Architecture map colour/label vocabulary (coding D1/D2).
//
// These pin the two fabrications the map used to render:
//   D2  every node fell to the grey "infrastructure" default because the legend
//       was keyed on architectural LAYERS (presentation/business/…) while the
//       data only carries a code-graph `type` (module/class/…). Colour now keys
//       on the real `type`, and the legend is built from the types present.
//   D1  "hotspot" mode advertised "High complexity / issues" while the score was
//       driven purely by connection degree — the data carries NO complexity or
//       issue metrics. It is now labelled and scored as connectivity.
//
// The fixture mirrors the REAL adapter output shape
// (backend/src/routes/coding/adapters.ts → { id, label, type, metadata }); note
// `metadata` carries only name/label — NO complexity/issues, exactly as the
// coding fixtures (backend tests/unit/routes/coding/adapters.test.ts) prove.

import { describe, it, expect } from 'vitest';

import {
  typeColor,
  distinctTypes,
  connectivityScore,
  connectivityColor,
  CONNECTIVITY_LEGEND,
  TYPE_FALLBACK,
} from './architecture/graph-colors';

// A real graph slice: three distinct code-graph node types, metadata with only
// name/label — never complexity/issues.
const NODES = [
  { id: 'n1', label: 'auth', type: 'module', metadata: { name: 'auth' } },
  { id: 'n2', label: 'db', type: 'service', metadata: { label: 'db' } },
  { id: 'n3', label: 'Handler', type: 'class', metadata: { name: 'Handler' } },
];

describe('D2 — node colouring keys on the real `type`, not architectural layers', () => {
  it('distinct types each get a distinct, non-grey colour (was: all grey)', () => {
    const mod = typeColor('module');
    const svc = typeColor('service');
    const cls = typeColor('class');

    // The old bug: layerColors[type] was always undefined → every node fell to
    // the grey infrastructure default. Honest colouring never returns the grey
    // fallback for a real type.
    expect(mod).not.toBe(TYPE_FALLBACK);
    expect(svc).not.toBe(TYPE_FALLBACK);
    expect(cls).not.toBe(TYPE_FALLBACK);

    // And distinct types are visually distinguishable.
    expect(new Set([mod, svc, cls]).size).toBe(3);
  });

  it('is deterministic — the same type always maps to the same colour', () => {
    expect(typeColor('module')).toBe(typeColor('module'));
  });

  it('only a genuinely absent type falls back to grey', () => {
    expect(typeColor('')).toBe(TYPE_FALLBACK);
    expect(typeColor(undefined)).toBe(TYPE_FALLBACK);
    expect(typeColor('default')).toBe(TYPE_FALLBACK);
  });

  it('the legend is built from the types actually present in the data', () => {
    expect(distinctTypes(NODES)).toEqual(['module', 'service', 'class']);
    // Never the old fixed presentation/business/data/integration/infrastructure set.
    expect(distinctTypes(NODES)).not.toContain('presentation');
    expect(distinctTypes(NODES)).not.toContain('infrastructure');
  });
});

describe('D1 — hotspot mode encodes connectivity (degree), not complexity/issues', () => {
  it('score is driven by connection degree relative to the busiest node', () => {
    // Isolated node → 0 (green); the hub → 1 (red). No metrics involved.
    expect(connectivityScore(0, 8)).toBe(0);
    expect(connectivityScore(8, 8)).toBe(1);
    expect(connectivityScore(4, 8)).toBe(0.5);
  });

  it('a graph with no edges scores every node 0 (no divide-by-zero, all healthy)', () => {
    expect(connectivityScore(0, 0)).toBe(0);
  });

  it('heat ramp: hub → red, mid → amber, sparse → green', () => {
    expect(connectivityColor(connectivityScore(8, 8))).toBe('#ef4444');
    expect(connectivityColor(connectivityScore(4, 8))).toBe('#f59e0b');
    expect(connectivityColor(connectivityScore(1, 8))).toBe('#22c55e');
  });

  it('the legend describes connectivity, NEVER complexity/issues (the old lie)', () => {
    const labels = CONNECTIVITY_LEGEND.map((b) => b.label.toLowerCase()).join(' | ');
    expect(labels).toContain('connected');
    expect(labels).not.toContain('complexity');
    expect(labels).not.toContain('issue');
  });
});

describe('D2 — the legend swatch colour must equal the on-canvas node colour', () => {
  // The graph paints a node with `typeColor(node.type || 'default')`
  // (ArchitectureView builds the graph node's fill field as `node.type || 'default'`),
  // while the legend paints `typeColor(distinctTypes(nodes)[i])`. If the two paths
  // normalise a missing/empty type through different sentinels, a node is drawn one
  // colour and the legend advertises another — the exact D2 regression an adversarial
  // pass caught for `type: ""` (grey node vs a non-grey "unknown" swatch).
  const graphFill = (type: string) => typeColor(type || 'default');

  it.each(['module', 'service', 'class', '', '   ', 'default', 'DEFAULT'])(
    'type %j: legend swatch === graph fill',
    (type) => {
      const legendKey = distinctTypes([{ type }])[0]!;
      expect(typeColor(legendKey)).toBe(graphFill(type));
    },
  );

  it('an empty type is grey on BOTH paths (not an invented non-grey bucket)', () => {
    expect(graphFill('')).toBe(TYPE_FALLBACK);
    expect(typeColor(distinctTypes([{ type: '' }])[0]!)).toBe(TYPE_FALLBACK);
  });
});
