import { describe, it, expect } from 'vitest';
import { toCurl, prettyBody, n8nEquivalent, type GatewayCall } from './kagInspect';

describe('toCurl', () => {
  it('builds a curl with method, path and a JSON body', () => {
    const call: GatewayCall = {
      method: 'POST',
      path: '/api/assets/kag/ask',
      body: { query: 'what is rag', mode: 'hybrid_rerank' },
    };
    const curl = toCurl(call);
    expect(curl).toContain(`curl -X POST '/api/assets/kag/ask'`);
    expect(curl).toContain(`-H 'content-type: application/json'`);
    expect(curl).toContain('"query": "what is rag"');
  });

  it('omits the body clause when there is none (e.g. a GET)', () => {
    const curl = toCurl({ method: 'GET', path: '/api/assets/kag/formats' });
    expect(curl).toContain(`curl -X GET '/api/assets/kag/formats'`);
    expect(curl).not.toContain('-d');
  });

  it('escapes single quotes in the body so the shell string stays valid', () => {
    const curl = toCurl({ method: 'POST', path: '/x', body: { q: "it's" } });
    expect(curl).toContain(`'\\''`); // the ' in "it's" is shell-escaped
  });

});

describe('prettyBody', () => {
  it('pretty-prints an object and returns empty for nullish', () => {
    expect(prettyBody({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyBody(undefined)).toBe('');
    expect(prettyBody(null)).toBe('');
  });
});

describe('n8nEquivalent', () => {
  it('maps semantic search to the query/semanticSearch operation', () => {
    const eq = n8nEquivalent({ method: 'POST', path: '/api/assets/kag/search' });
    expect(eq).toEqual({
      node: '@nonagentic/n8n-nodes-kag.kag',
      resource: 'query',
      operation: 'semanticSearch',
    });
  });

  it('maps hierarchical retrieval to the hierarchicalRetrieval operation', () => {
    const eq = n8nEquivalent({ method: 'POST', path: '/api/assets/kag/hierarchical-retrieval' });
    expect(eq?.operation).toBe('hierarchicalRetrieval');
  });

  it('returns null for a RAG ask (no single node operation composes an answer)', () => {
    expect(n8nEquivalent({ method: 'POST', path: '/api/assets/kag/ask' })).toBeNull();
  });

  it('returns null for an unmapped path', () => {
    expect(n8nEquivalent({ method: 'POST', path: '/api/assets/kag/whatever' })).toBeNull();
  });
});
