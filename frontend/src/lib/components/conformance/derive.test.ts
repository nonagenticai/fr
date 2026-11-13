import { describe, it, expect } from 'vitest';
import type { ArchitectureConformanceResult } from '$lib/api/governance';
import { deriveConformanceGraph } from './derive';

function ac(id: string, title = `AC ${id}`) {
  return { id, title, layer: 'application', element_type: 'application_component' };
}
function artifact(id: string, title = `Art ${id}`) {
  return { id, title, layer: 'technology', element_type: 'artifact' };
}

function emptyResult(): ArchitectureConformanceResult {
  return {
    realization_coverage: {
      realization_coverage: 1.0,
      total_application_components: 0,
      realized_count: 0,
      realized: [],
      unrealized: [],
      orphan_artifacts: [],
      unbound_code_units: [],
    },
    dependency_conformance: {
      conformance_score: 1.0,
      designed_count: 0,
      realized_count: 0,
      matched: [],
      missing: [],
      extra: [],
      unmappable_realized_edges: 0,
    },
    illegal_dependencies: {
      illegal_count: 0,
      illegal_dependencies: [],
      unranked_edges: 0,
      layer_order: ['business', 'application', 'technology'],
    },
    summary: {
      realization_coverage: 1.0,
      conformance_score: 1.0,
      illegal_count: 0,
      unrealized_components: 0,
      orphan_artifacts: 0,
    },
  };
}

describe('deriveConformanceGraph', () => {
  it('empty conformance result → empty graph', () => {
    expect(deriveConformanceGraph(emptyResult())).toEqual({ nodes: [], links: [] });
  });

  it('classifies application_component vs artifact via element_type', () => {
    const r = emptyResult();
    r.realization_coverage.realized = [ac('a-1')];
    r.realization_coverage.orphan_artifacts = [artifact('art-1')];
    const g = deriveConformanceGraph(r);
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(byId['a-1'].kind).toBe('application_component');
    expect(byId['art-1'].kind).toBe('artifact');
  });

  it('marks unrealized + orphan as isFinding=true and realized as false', () => {
    const r = emptyResult();
    r.realization_coverage.realized = [ac('a-1')];
    r.realization_coverage.unrealized = [ac('a-2')];
    r.realization_coverage.orphan_artifacts = [artifact('art-orph')];
    const g = deriveConformanceGraph(r);
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(byId['a-1'].isFinding).toBe(false);
    expect(byId['a-2'].isFinding).toBe(true);
    expect(byId['art-orph'].isFinding).toBe(true);
  });

  it('emits one link per matched/missing/extra pair with the correct kind', () => {
    const r = emptyResult();
    r.dependency_conformance.matched = [{ source: ac('m-1'), target: ac('m-2') }];
    r.dependency_conformance.missing = [{ source: ac('x-1'), target: ac('x-2') }];
    r.dependency_conformance.extra = [{ source: ac('e-1'), target: ac('e-2') }];
    const g = deriveConformanceGraph(r);
    const links = Object.fromEntries(g.links.map((l) => [`${l.source}->${l.target}`, l.kind]));
    expect(links['m-1->m-2']).toBe('matched');
    expect(links['x-1->x-2']).toBe('missing');
    expect(links['e-1->e-2']).toBe('extra');
  });

  it('illegal overrides a prior matched/extra classification (illegality wins)', () => {
    const r = emptyResult();
    r.dependency_conformance.matched = [{ source: ac('a'), target: ac('b') }];
    r.illegal_dependencies.illegal_dependencies = [
      {
        source: ac('a'),
        target: ac('b'),
        source_layer: 'application',
        target_layer: 'business',
        reason: 'application cannot depend on business',
      },
    ];
    const g = deriveConformanceGraph(r);
    expect(g.links).toHaveLength(1);
    expect(g.links[0].kind).toBe('illegal');
    expect(g.links[0].reason).toBe('application cannot depend on business');
  });

  it('illegal-only edge becomes a single illegal link, both endpoints are findings', () => {
    const r = emptyResult();
    r.illegal_dependencies.illegal_dependencies = [
      {
        source: ac('a'),
        target: artifact('art-x'),
        source_layer: 'application',
        target_layer: 'business',
        reason: 'wrong layer order',
      },
    ];
    const g = deriveConformanceGraph(r);
    expect(g.links).toEqual([
      { source: 'a', target: 'art-x', kind: 'illegal', reason: 'wrong layer order' },
    ]);
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(byId['a'].isFinding).toBe(true);
    expect(byId['art-x'].isFinding).toBe(true);
  });

  it('dedupes a node that appears in multiple lists, preserving the finding flag', () => {
    const r = emptyResult();
    r.realization_coverage.realized = [ac('a-1')];
    r.dependency_conformance.missing = [{ source: ac('a-1'), target: ac('a-2') }];
    const g = deriveConformanceGraph(r);
    const a1 = g.nodes.find((n) => n.id === 'a-1');
    expect(a1).toBeDefined();
    // a-1 was realized (not a finding) but its outgoing missing edge marks both
    // endpoints as findings — the truthier of the two wins.
    expect(a1!.isFinding).toBe(true);
    expect(g.nodes.filter((n) => n.id === 'a-1')).toHaveLength(1);
  });
});
