// tempo-url.test.ts
//
// Exhaustive tests for the pure URL builder backing the Tempo / Grafana
// deep-link rendered by ExecutionRow. Mirrors the URL shape produced by
// `backend/src/routes/tools/n8n.ts::buildTraceUrl` so a row carrying only
// a `traceId` ends up at the same Grafana destination as one carrying a
// precomputed `trace_url`.
//
// Plan ref:
//   docs/superpowers/plans/completed/2026-04-25-n8n-observability-implementation.md
//   §"Open follow-ups" — Tempo deep-link.

import { describe, it, expect } from 'vitest';
import { buildTempoUrl } from './tempo-url';

/** Decode the `left` query param back into the structured Grafana payload. */
function decodeLeft(url: string): unknown {
  const u = new URL(url);
  const left = u.searchParams.get('left');
  if (!left) throw new Error(`URL has no left param: ${url}`);
  return JSON.parse(left);
}

describe('buildTempoUrl', () => {
  it('builds an explore URL with execution_id only when workflowId is omitted', () => {
    const url = buildTempoUrl({ executionId: 'exec-123' });
    expect(url.startsWith('https://grafana.nonagentic.ai/explore?left=')).toBe(true);
    expect(url).toContain('execution_id%3D');

    const decoded = decodeLeft(url);
    expect(Array.isArray(decoded)).toBe(true);
    const arr = decoded as unknown[];
    expect(arr[0]).toBe('now-1h');
    expect(arr[1]).toBe('now');
    expect(arr[2]).toBe('tempo');
    const q = arr[3] as { expr: string };
    expect(q.expr).toBe('{execution_id="exec-123"}');
  });

  it('includes workflow_id in the expr when provided', () => {
    const url = buildTempoUrl({ executionId: '5001', workflowId: 'wf-z' });
    const q = (decodeLeft(url) as unknown[])[3] as { expr: string };
    expect(q.expr).toBe('{execution_id="5001", workflow_id="wf-z"}');
    expect(url).toContain('workflow_id%3D');
  });

  it('omits workflow_id when explicitly undefined', () => {
    const url = buildTempoUrl({ executionId: '42', workflowId: undefined });
    const q = (decodeLeft(url) as unknown[])[3] as { expr: string };
    expect(q.expr).toBe('{execution_id="42"}');
    expect(q.expr).not.toContain('workflow_id');
  });

  it('omits workflow_id when empty string (falsy)', () => {
    const url = buildTempoUrl({ executionId: 'e', workflowId: '' });
    const q = (decodeLeft(url) as unknown[])[3] as { expr: string };
    expect(q.expr).toBe('{execution_id="e"}');
  });

  it('uses default Grafana base when grafanaBase is not provided', () => {
    const url = buildTempoUrl({ executionId: 'x' });
    expect(url).toMatch(/^https:\/\/grafana\.nonagentic\.ai\/explore\?/);
  });

  it('honors a custom grafanaBase', () => {
    const url = buildTempoUrl({
      executionId: 'x',
      grafanaBase: 'https://grafana.example.test',
    });
    expect(url).toMatch(/^https:\/\/grafana\.example\.test\/explore\?/);
  });

  it('strips trailing slashes from grafanaBase to avoid // in the path', () => {
    const url = buildTempoUrl({
      executionId: 'x',
      grafanaBase: 'https://grafana.example.test///',
    });
    expect(url).toMatch(/^https:\/\/grafana\.example\.test\/explore\?/);
    expect(url).not.toContain('test///explore');
    expect(url).not.toContain('test//explore');
  });

  it('produces a URL whose `left` round-trips through JSON parse', () => {
    const url = buildTempoUrl({ executionId: 'abc', workflowId: 'wf' });
    const decoded = decodeLeft(url) as [string, string, string, { expr: string }];
    expect(decoded).toHaveLength(4);
    expect(decoded[3].expr).toContain('execution_id="abc"');
    expect(decoded[3].expr).toContain('workflow_id="wf"');
  });

  it('URL-encodes characters that would otherwise break the query string', () => {
    // Spaces in the JSON, quotes, and braces must all end up percent-encoded.
    const url = buildTempoUrl({ executionId: 'has space', workflowId: 'wf' });
    expect(url).not.toContain(' ');
    expect(url).not.toContain('"');
    expect(url).not.toContain('{');
    expect(url).not.toContain('}');
    // The decoded payload still has them, naturally.
    const q = (decodeLeft(url) as unknown[])[3] as { expr: string };
    expect(q.expr).toContain('execution_id="has space"');
  });

  it('handles execution ids with characters that need escaping in the URL', () => {
    // Backslashes / quotes inside the id are NOT escaped at the JSON-string
    // layer here (they would already be sanitised upstream). What we DO
    // promise is that whatever id we get round-trips through the URL.
    const url = buildTempoUrl({ executionId: 'id-with-&-and-=' });
    const q = (decodeLeft(url) as unknown[])[3] as { expr: string };
    expect(q.expr).toBe('{execution_id="id-with-&-and-="}');
  });

  it('treats workflowId of just whitespace as truthy (caller responsibility)', () => {
    // We intentionally don't trim — the caller decides what's a "real" id.
    const url = buildTempoUrl({ executionId: 'e', workflowId: ' ' });
    const q = (decodeLeft(url) as unknown[])[3] as { expr: string };
    expect(q.expr).toBe('{execution_id="e", workflow_id=" "}');
  });

  it('matches the backend buildTraceUrl shape: same params produce the same URL', () => {
    // This is the load-bearing parity assertion. If this test ever drifts the
    // backend mirror in n8n.ts has been changed without updating the helper.
    const executionId = '1001';
    const workflowId = 'wf-a';
    const expected = (() => {
      const expr = `{execution_id="${executionId}", workflow_id="${workflowId}"}`;
      const left = encodeURIComponent(
        JSON.stringify(['now-1h', 'now', 'tempo', { expr }]),
      );
      return `https://grafana.nonagentic.ai/explore?left=${left}`;
    })();
    expect(buildTempoUrl({ executionId, workflowId })).toBe(expected);
  });
});
