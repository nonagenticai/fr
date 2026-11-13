// tests/unit/traceability.test.ts
//
// Phase-8 traceability compose-endpoint — pure assembly coverage. Exercises the
// dimension / route / label maps and the relationship-rows → {nodes, links}
// fold. No DB / upstream I/O is touched (the BFS + handler are integration
// surface, covered live).

import { describe, expect, test } from 'bun:test';

process.env.AUTH_BYPASS = 'true';

import {
  buildGraph,
  dimensionOf,
  nodeLabel,
  routeOf,
} from '../../src/routes/traceability';
import type { ArchitectureRelationshipOut } from '@fr/service-client-requirements';

function rel(
  over: Partial<ArchitectureRelationshipOut> &
    Pick<
      ArchitectureRelationshipOut,
      'source_entity_type' | 'source_id' | 'target_entity_type' | 'target_id'
    >,
): ArchitectureRelationshipOut {
  return {
    id: over.id ?? `rel-${over.source_id}-${over.target_id}`,
    slug: over.slug ?? 'slug',
    tenant_id: over.tenant_id ?? 't1',
    relationship_type: over.relationship_type ?? 'depends_on',
    name: over.name ?? null,
    ...over,
  } as ArchitectureRelationshipOut;
}

describe('dimensionOf', () => {
  test('maps table names to 5D dimensions', () => {
    expect(dimensionOf('architecture_elements')).toBe('architecture');
    expect(dimensionOf('architecture_views')).toBe('architecture');
    expect(dimensionOf('requirements')).toBe('requirement');
    expect(dimensionOf('decisions')).toBe('decision');
    expect(dimensionOf('principles')).toBe('principle');
    expect(dimensionOf('pm_risks')).toBe('pm');
    expect(dimensionOf('pm_projects')).toBe('pm');
    expect(dimensionOf('something_else')).toBe('other');
  });
});

describe('routeOf', () => {
  test('wired types get an encoded detail href', () => {
    expect(routeOf('architecture_elements', 'abc')).toBe(
      '/library/architecture/elements/abc',
    );
    expect(routeOf('requirements', 'r1')).toBe('/requirements/r1');
    expect(routeOf('architecture_elements', 'a/b')).toBe(
      '/library/architecture/elements/a%2Fb',
    );
  });

  test('unwired types get no route', () => {
    expect(routeOf('pm_benefits', 'b1')).toBeNull();
    // The /library/pm/* detail pages are retired, so no pm_* type links anywhere.
    for (const t of ['pm_programmes', 'pm_projects', 'pm_risks']) {
      expect(routeOf(t, 'p1')).toBeNull();
    }
    expect(routeOf('mystery', 'x')).toBeNull();
  });
});

describe('nodeLabel', () => {
  test('prefixes a human type and truncates the id to 8 chars', () => {
    expect(nodeLabel('architecture_elements', '0123456789abcdef')).toBe('Element 01234567');
    expect(nodeLabel('requirements', 'short')).toBe('Requirement short');
    expect(nodeLabel('mystery_table', 'id1')).toBe('mystery_table id1');
  });
});

describe('buildGraph', () => {
  test('dedupes nodes, keys links by source|target|type, maps cross-domain edges', () => {
    const rows = [
      rel({
        source_entity_type: 'architecture_elements',
        source_id: 'e1',
        target_entity_type: 'requirements',
        target_id: 'r1',
        relationship_type: 'realizes',
      }),
      // same pair, different relationship type → distinct link, node reused
      rel({
        source_entity_type: 'architecture_elements',
        source_id: 'e1',
        target_entity_type: 'requirements',
        target_id: 'r1',
        relationship_type: 'depends_on',
      }),
      // exact duplicate of the first → collapses
      rel({
        source_entity_type: 'architecture_elements',
        source_id: 'e1',
        target_entity_type: 'requirements',
        target_id: 'r1',
        relationship_type: 'realizes',
      }),
    ];

    const g = buildGraph(rows);
    expect(g.nodes).toHaveLength(2);
    expect(g.links).toHaveLength(2);

    const e1 = g.nodes.find((n) => n.id === 'architecture_elements:e1')!;
    expect(e1.dimension).toBe('architecture');
    expect(e1.route).toBe('/library/architecture/elements/e1');
    expect(e1.is_root).toBe(false);

    const types = g.links.map((l) => l.type).sort();
    expect(types).toEqual(['depends_on', 'realizes']);
    expect(g.links.every((l) => l.source === 'architecture_elements:e1')).toBe(true);
    expect(g.links.every((l) => l.target === 'requirements:r1')).toBe(true);
  });

  test('flags the root node when a rootKey is supplied', () => {
    const rows = [
      rel({
        source_entity_type: 'architecture_elements',
        source_id: 'e1',
        target_entity_type: 'decisions',
        target_id: 'd1',
      }),
    ];
    const g = buildGraph(rows, 'architecture_elements:e1');
    expect(g.nodes.find((n) => n.id === 'architecture_elements:e1')!.is_root).toBe(true);
    expect(g.nodes.find((n) => n.id === 'decisions:d1')!.is_root).toBe(false);
  });

  test('carries relationship name as the link label', () => {
    const rows = [
      rel({
        source_entity_type: 'principles',
        source_id: 'p1',
        target_entity_type: 'requirements',
        target_id: 'r1',
        relationship_type: 'constrains',
        name: 'security baseline',
      }),
    ];
    const g = buildGraph(rows);
    expect(g.links).toHaveLength(1);
    expect(g.links[0]!.label).toBe('security baseline');
  });

  test('empty input yields an empty graph', () => {
    const g = buildGraph([]);
    expect(g.nodes).toHaveLength(0);
    expect(g.links).toHaveLength(0);
  });
});
