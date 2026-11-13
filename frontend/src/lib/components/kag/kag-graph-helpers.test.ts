import { describe, it, expect } from 'vitest';
import { readPath, readStats } from './kag-graph-helpers';

describe('readStats', () => {
  it('prefers a direct document_count over the type distribution', () => {
    const s = readStats({
      node_count: 100,
      edge_count: 250,
      document_count: 12,
      entity_type_distribution: { Document: 3, Concept: 97 },
    });
    expect(s.entities).toBe(100);
    expect(s.relationships).toBe(250);
    expect(s.documents).toBe(12); // direct count wins over the distribution's 3
  });

  it('accepts alternative direct-count field names', () => {
    expect(readStats({ num_documents: 7 }).documents).toBe(7);
    expect(readStats({ total_documents: 9 }).documents).toBe(9);
  });

  it('falls back to the entity-type distribution when no direct count is present', () => {
    const s = readStats({ entity_type_distribution: { document: 5, Person: 10 } });
    expect(s.documents).toBe(5);
  });

  it('returns undefined documents when neither source is present', () => {
    expect(readStats({ node_count: 3 }).documents).toBeUndefined();
    expect(readStats(null).documents).toBeUndefined();
  });
});

describe('readPath', () => {
  it('extracts ids AND node objects from a path of node objects (mergeable)', () => {
    const raw = {
      paths: [
        {
          nodes: [
            { id: 'a', properties: { text: 'Alpha' } },
            { id: 'b', properties: { text: 'Beta' } },
            { id: 'c', properties: { text: 'Gamma' } },
          ],
          relationships: [
            { start_node_id: 'a', end_node_id: 'b', type: 'REL' },
            { start_node_id: 'b', end_node_id: 'c', type: 'REL' },
          ],
        },
      ],
    };
    const { ids, nodes, relationships } = readPath(raw);
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(nodes).toHaveLength(3); // intermediate node 'b' is present to merge
    expect(relationships).toHaveLength(2);
  });

  it('returns ids only (no mergeable nodes) when the path is a bare id list', () => {
    const { ids, nodes, relationships } = readPath({ paths: [['a', 'b', 'c']] });
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(nodes).toHaveLength(0);
    expect(relationships).toHaveLength(0);
  });

  it('treats a null path head as "no path" (does not throw)', () => {
    expect(() => readPath({ paths: [null] })).not.toThrow();
    expect(readPath({ paths: [null] })).toEqual({ ids: [], nodes: [], relationships: [] });
  });

  it('handles empty / malformed input', () => {
    expect(readPath({})).toEqual({ ids: [], nodes: [], relationships: [] });
    expect(readPath(null)).toEqual({ ids: [], nodes: [], relationships: [] });
    expect(readPath({ paths: [] })).toEqual({ ids: [], nodes: [], relationships: [] });
  });

});
