// The words and layout of an ArchiMate model's contents panel (lib/modeling/archimate.ts).
//
// MUTATIONS: drop the overlap check in nextShapeBounds → "never overlaps" red; sort
// layers alphabetically → "ArchiMate order" red; let a missing type fall back to a
// typed layer → "the layer follows from the type" red.

import { describe, expect, it } from 'vitest';

import { conceptsByLayer, elementTypeLabel, layerLabel, layerOfType, nextShapeBounds, relationshipLabel, relationshipTypeLabel } from './archimate';

const C = (type: string, layer: string) => ({ type, layer, archi_class: '', aspect: '' });

describe('archimate words', () => {
  it('names types, layers and relationships in plain words', () => {
    expect(elementTypeLabel('application_component')).toBe('Application Component');
    expect(layerLabel('implementation_migration')).toBe('Implementation and migration');
    expect(layerLabel(null)).toBe('No layer');
    expect(relationshipTypeLabel('realization')).toBe('Realization');
    const names = new Map([['a', 'Order System'], ['b', 'Order Service']]);
    expect(relationshipLabel({ source_id: 'a', target_id: 'b', relationship_type: 'realization' }, names)).toBe('Order System realizes Order Service');
    expect(relationshipLabel({ source_id: 'a', target_id: 'x', relationship_type: 'serving' }, names)).toBe('Order System serves an element outside this model');
  });

  it('groups the metamodel by layer in ArchiMate order, types by name', () => {
    const groups = conceptsByLayer([C('node', 'technology'), C('business_actor', 'business'), C('application_service', 'application'), C('application_component', 'application'), C('goal', 'motivation')]);
    expect(groups.map((g) => g.label)).toEqual(['Business', 'Application', 'Technology', 'Motivation']);
    expect(groups[1]!.concepts.map((c) => c.type)).toEqual(['application_component', 'application_service']);
  });

  it('the layer follows from the type (never typed)', () => {
    const concepts = [C('application_component', 'application')];
    expect(layerOfType(concepts, 'application_component')).toBe('application');
    expect(layerOfType(concepts, 'spaceship')).toBeNull();
  });
});

describe('nextShapeBounds', () => {
  it('places shapes left to right on a grid and never overlaps one already there', () => {
    const first = nextShapeBounds([]);
    expect(first).toEqual({ x: 24, y: 24, w: 120, h: 55 });
    const second = nextShapeBounds([first]);
    expect(second.x).toBeGreaterThanOrEqual(first.x + first.w);
    // An unsized (-1) shape placed off the grid still blocks the cell it covers.
    expect(nextShapeBounds([{ x: 30, y: 30, w: -1, h: -1 }])).toEqual({ x: 204, y: 24, w: 120, h: 55 });
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (let i = 0; i < 9; i++) placed.push(nextShapeBounds(placed));
    for (const [i, a] of placed.entries())
      for (const b of placed.slice(i + 1)) expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
    expect(placed[4]).toEqual({ x: 24, y: 124, w: 120, h: 55 });
  });
});
