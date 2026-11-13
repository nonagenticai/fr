// Unit tests for the neo4j field-tolerance layer. These pin the aliases the
// canvas depends on — if an upstream endpoint changes a field name, one of
// these fails rather than the graph silently rendering blank.

import { describe, it, expect } from 'vitest';
import {
  nodeIdOf,
  nodeLabelOf,
  nodeTypeOf,
  relEndpoints,
  mapSubgraphEdges,
  edgeDetailOf,
  nodeDetailOf,
  kagDetailRows,
  nodeScoreIsBounded,
  formatNodeScore,
} from './graph-normalise';

/** Property rows are now `{key,value,raw}` — collapse to a key→value map for assertions. */
const propMap = (rows: Array<{ key: string; value: string }>) =>
  Object.fromEntries(rows.map((r) => [r.key, r.value]));
const propKeys = (rows: Array<{ key: string }>) => rows.map((r) => r.key);

describe('nodeIdOf', () => {
  it('prefers explicit id keys in priority order', () => {
    expect(nodeIdOf({ id: 'x', entity_id: 'y' })).toBe('x');
    expect(nodeIdOf({ entity_id: 'y' })).toBe('y');
    expect(nodeIdOf({ node_id: 'n' })).toBe('n');
  });
  it('falls back to nested properties.id, then name, then positional', () => {
    expect(nodeIdOf({ properties: { id: 'p' } })).toBe('p');
    expect(nodeIdOf({ name: 'Refund policy' })).toBe('Refund policy');
    expect(nodeIdOf({}, 7)).toBe('idx-7');
  });
});

describe('nodeLabelOf', () => {
  it('uses human name/title before falling back to id', () => {
    expect(nodeLabelOf({ name: 'Alice', id: 'e1' })).toBe('Alice');
    expect(nodeLabelOf({ title: 'Q3 report' })).toBe('Q3 report');
    expect(nodeLabelOf({ properties: { name: 'Nested' } })).toBe('Nested');
    expect(nodeLabelOf({ id: 'e1' })).toBe('e1');
    expect(nodeLabelOf({})).toBe('(unnamed)');
  });
  it('reads the entity name from properties.text (live KAG entity shape)', () => {
    // Real KAG entity: { id, label:'ORGANIZATION', properties:{ text:'Stanford University', ... } }
    expect(
      nodeLabelOf({ id: 'x', label: 'ORGANIZATION', properties: { text: 'Stanford University' } }),
    ).toBe('Stanford University');
  });
});

describe('nodeTypeOf', () => {
  it('reads a native neo4j labels[] array first', () => {
    expect(nodeTypeOf({ labels: ['Policy', 'Doc'], name: 'x' })).toBe('Policy');
  });
  it('reads explicit type/category keys', () => {
    expect(nodeTypeOf({ entity_type: 'Person' })).toBe('Person');
    expect(nodeTypeOf({ category: 'Concept' })).toBe('Concept');
  });
  it('treats `label` as a type only when it is not the display name', () => {
    // label distinct from name → it's a type
    expect(nodeTypeOf({ label: 'Organisation', name: 'Acme' })).toBe('Organisation');
    // label IS the name → not a type, default applies
    expect(nodeTypeOf({ label: 'Acme', name: 'Acme' })).toBe('Entity');
  });
  it('defaults to Entity when nothing type-like is present', () => {
    expect(nodeTypeOf({ name: 'x' })).toBe('Entity');
  });
});

describe('relEndpoints', () => {
  it('tolerates source/target', () => {
    expect(relEndpoints({ source: 'a', target: 'b', type: 'REL' })).toEqual({
      source: 'a',
      target: 'b',
      type: 'REL',
    });
  });
  it('tolerates neo4j start/end and *_id variants', () => {
    expect(relEndpoints({ start: 'a', end: 'b' })).toMatchObject({ source: 'a', target: 'b' });
    expect(relEndpoints({ source_id: 'a', target_id: 'b' })).toMatchObject({
      source: 'a',
      target: 'b',
    });
    expect(relEndpoints({ from: 'a', to: 'b' })).toMatchObject({ source: 'a', target: 'b' });
  });
  it('tolerates graph_traversal path-edge start_node_id/end_node_id (live shape)', () => {
    expect(
      relEndpoints({ type: 'CONTAINS', start_node_id: '4:x:1', end_node_id: '4:x:2' }),
    ).toEqual({ source: '4:x:1', target: '4:x:2', type: 'CONTAINS' });
  });
  it('reads relationship_type as the edge type', () => {
    expect(relEndpoints({ start: 'a', end: 'b', relationship_type: 'MENTIONS' }).type).toBe(
      'MENTIONS',
    );
  });
});

describe('mapSubgraphEdges', () => {
  it('maps source_id/target_id edges to source/target/type while spreading originals through', () => {
    const result = mapSubgraphEdges([
      { source_id: 'a', target_id: 'b', type: 'REL', properties: { x: 1 } },
    ]);
    expect(result[0].source).toBe('a');
    expect(result[0].target).toBe('b');
    expect(result[0].type).toBe('REL');
    // original keys survive the spread.
    expect(result[0].source_id).toBe('a');
    expect(result[0].properties).toEqual({ x: 1 });
  });
  it('returns an empty array for an empty input', () => {
    expect(mapSubgraphEdges([])).toEqual([]);
  });
});

describe('edgeDetailOf', () => {
  it('carries endpoints + type from the same aliases as relEndpoints', () => {
    const d = edgeDetailOf({ source: 'a', target: 'b', relationship_type: 'ACQUIRED' });
    expect(d).toMatchObject({ source: 'a', target: 'b', type: 'ACQUIRED' });
  });
  it('extracts a stable edge id from id/edge_id/element_id/uuid', () => {
    expect(edgeDetailOf({ id: 'e1', source: 'a', target: 'b' }).id).toBe('e1');
    expect(edgeDetailOf({ edge_id: 'e2', source: 'a', target: 'b' }).id).toBe('e2');
    expect(edgeDetailOf({ element_id: 'e3', source: 'a', target: 'b' }).id).toBe('e3');
    expect(edgeDetailOf({ source: 'a', target: 'b' }).id).toBeUndefined();
  });
  it('reads properties from an explicit properties bag', () => {
    const d = edgeDetailOf({
      source: 'a',
      target: 'b',
      type: 'ACQUIRED',
      properties: { year: 2019, confidence: 0.9 },
    });
    expect(propMap(d.properties)).toMatchObject({ year: '2019', confidence: '0.9' });
  });
  it('falls back to top-level keys minus structural ones when no bag', () => {
    const d = edgeDetailOf({
      id: 'e1',
      source_id: 'a',
      target_id: 'b',
      relationship_type: 'MENTIONS',
      weight: 0.42,
      note: 'from paragraph 3',
    });
    // structural keys (id/endpoints/type) are excluded; domain fields survive.
    const keys = propKeys(d.properties);
    expect(keys).toContain('weight');
    expect(keys).toContain('note');
    expect(keys).not.toContain('id');
    expect(keys).not.toContain('source_id');
    expect(keys).not.toContain('relationship_type');
  });
  it('flags object property values as raw (opt-in) and skips null/empty', () => {
    const d = edgeDetailOf({
      source: 'a',
      target: 'b',
      properties: { meta: { k: 1 }, empty: '', missing: null },
    });
    const meta = d.properties.find((r) => r.key === 'meta');
    expect(meta?.raw).toBe(true);
    expect(meta?.value).toContain('"k": 1'); // pretty-printed, carried for opt-in display
    expect(propKeys(d.properties)).not.toContain('empty');
    expect(propKeys(d.properties)).not.toContain('missing');
  });
});

describe('nodeDetailOf', () => {
  it('resolves id/label/type via the same aliases as the individual resolvers', () => {
    const d = nodeDetailOf({
      id: 'e1',
      label: 'ORGANIZATION',
      properties: { text: 'Stanford University' },
    });
    expect(d.id).toBe('e1');
    expect(d.label).toBe('Stanford University'); // properties.text wins for the human name
    expect(d.type).toBe('ORGANIZATION'); // label distinct from name → it's the type
  });

  it('reads properties from an explicit properties bag, minus structural keys', () => {
    const d = nodeDetailOf({
      id: 'x',
      name: 'Acme',
      properties: { founded: 1999, sector: 'AI' },
    });
    const map = propMap(d.properties);
    expect(map.founded).toBe('1999');
    expect(map.sector).toBe('AI');
  });

  it('falls back to top-level keys minus structural ones when there is no bag', () => {
    const d = nodeDetailOf({
      id: 'x',
      name: 'Acme',
      entity_type: 'Company',
      revenue: 4200,
      note: 'from filing',
    });
    const keys = propKeys(d.properties);
    expect(keys).toContain('revenue');
    expect(keys).toContain('note');
    // identity/type keys are surfaced as chrome, not as generic property rows.
    expect(keys).not.toContain('id');
    expect(keys).not.toContain('name');
    expect(keys).not.toContain('entity_type');
  });

  // The four probed keys are four different units — the producer documents `score`
  // as `1 - cosine_distance` in [0, 2] (chunks_repo.py:561) and as unbounded
  // `ts_rank_cd` (:627) — so the raw number alone is not renderable. `scoreField`
  // reports WHICH key it came from; `score` keeps its existing shape.
  it('probes a raw score (flat, nested, or absent→null) and keeps it out of properties', () => {
    expect(nodeDetailOf({ name: 'a', score: 0.82 }).score).toBe(0.82);
    expect(nodeDetailOf({ name: 'a', similarity: 0.5 }).score).toBe(0.5);
    expect(nodeDetailOf({ name: 'a', properties: { relevance: 0.31 } }).score).toBe(0.31);
    expect(nodeDetailOf({ name: 'a' }).score).toBeNull();
    // the score field must not also appear as a property row.
    const d = nodeDetailOf({ name: 'a', score: 0.82, sector: 'AI' });
    expect(propKeys(d.properties)).not.toContain('score');
  });

  it('reports which field the score came from (scoreField), including from properties', () => {
    expect(nodeDetailOf({ name: 'a', score: 1.42 }).scoreField).toBe('score');
    expect(nodeDetailOf({ name: 'a', similarity: 0.5 }).scoreField).toBe('similarity');
    expect(nodeDetailOf({ name: 'a', properties: { relevance: 0.31 } }).scoreField).toBe(
      'relevance',
    );
    expect(nodeDetailOf({ name: 'a', _score: 3 }).scoreField).toBe('_score');
    expect(nodeDetailOf({ name: 'a' }).scoreField).toBeNull();
  });

  it('flags object property values as raw and skips null/empty (parity with edgeDetailOf)', () => {
    const d = nodeDetailOf({
      name: 'a',
      properties: { meta: { k: 1 }, empty: '', missing: null },
    });
    const meta = d.properties.find((r) => r.key === 'meta');
    expect(meta?.raw).toBe(true);
    expect(meta?.value).toContain('"k": 1');
    expect(propKeys(d.properties)).not.toContain('empty');
    expect(propKeys(d.properties)).not.toContain('missing');
  });
});

describe('kagDetailRows', () => {
  it('renders scalars inline (raw:false) as labeled key/value', () => {
    const rows = kagDetailRows({ n: 42, s: 'hi', b: false });
    expect(rows).toEqual(
      expect.arrayContaining([
        { key: 'n', value: '42', raw: false },
        { key: 's', value: 'hi', raw: false },
        { key: 'b', value: 'false', raw: false },
      ]),
    );
  });
  it('summarises arrays as a friendly count (raw:false), not a JSON dump', () => {
    expect(kagDetailRows({ tags: ['a', 'b', 'c'] })).toEqual([
      { key: 'tags', value: '3 items', raw: false },
    ]);
    expect(kagDetailRows({ one: [1] })).toEqual([{ key: 'one', value: '1 item', raw: false }]);
  });
  it('carries objects as pretty JSON flagged raw:true (for opt-in display)', () => {
    const [row] = kagDetailRows({ meta: { k: 1 } });
    expect(row.key).toBe('meta');
    expect(row.raw).toBe(true);
    expect(row.value).toBe(JSON.stringify({ k: 1 }, null, 2));
  });
  it('skips null/undefined/empty and excluded keys', () => {
    const rows = kagDetailRows(
      { keep: 'y', drop: 'z', nothing: null, blank: '' },
      ['drop'],
    );
    expect(propKeys(rows)).toEqual(['keep']);
  });
  it('drops echoed-input keys only when dropInputEcho is set', () => {
    const bag = { text: '<pasted>', query: 'q', quality: 0.9 };
    expect(propKeys(kagDetailRows(bag))).toEqual(expect.arrayContaining(['text', 'query', 'quality']));
    expect(propKeys(kagDetailRows(bag, [], { dropInputEcho: true }))).toEqual(['quality']);
  });
});

describe('nodeScoreIsBounded', () => {
  // A meter asserts "this fraction of a known maximum". `score` has no known
  // maximum — chunks_repo.py:561 documents `1 - cosine_distance` in [0, 2] and
  // :627 documents an unbounded `ts_rank_cd` — so it never earns a bar, however
  // small the value happens to be. `relevance`/`_score` are undocumented, same
  // answer. Only `similarity` names a bounded unit, and even then the value is
  // range-checked: the name is a claim, not a guarantee.
  it('vouches only for `similarity` values that really lie in [0, 1]', () => {
    expect(nodeScoreIsBounded(0.87, 'similarity')).toBe(true);
    expect(nodeScoreIsBounded(0, 'similarity')).toBe(true);
    expect(nodeScoreIsBounded(1, 'similarity')).toBe(true);
    expect(nodeScoreIsBounded(1.4, 'similarity')).toBe(false);
    expect(nodeScoreIsBounded(-0.1, 'similarity')).toBe(false);
  });
  it('refuses every undocumented or unbounded field name, in range or not', () => {
    for (const field of ['score', 'relevance', '_score']) {
      expect(nodeScoreIsBounded(0.5, field)).toBe(false);
      expect(nodeScoreIsBounded(1.42, field)).toBe(false);
      expect(nodeScoreIsBounded(7.3, field)).toBe(false);
    }
  });
  it('refuses a null value or a null field', () => {
    expect(nodeScoreIsBounded(null, 'similarity')).toBe(false);
    expect(nodeScoreIsBounded(0.5, null)).toBe(false);
  });
});

describe('formatNodeScore', () => {
  it('renders the raw value to at most 3dp with no unit and no scaling', () => {
    expect(formatNodeScore(1.42)).toBe('1.42');
    expect(formatNodeScore(7.3)).toBe('7.3');
    expect(formatNodeScore(0.87)).toBe('0.87');
    expect(formatNodeScore(0.999642)).toBe('1'); // 3dp, still not "100%"
    expect(formatNodeScore(0)).toBe('0');
    expect(formatNodeScore(12)).toBe('12');
  });
});
