import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Drift + integrity pins for the committed coding-gateway OpenAPI snapshot
// (`tooling/openapi/specs/coding.json`), the input to `@fr/service-client-coding`.
//
// Why this exists (spec area 2 §2.3): the gateway aggregates 7 backends. If a
// backend is down when `openapi:sync` runs, the aggregator historically returned
// a *silently incomplete* spec (hazard H1) — and a diff of the snapshot reads that
// as a legitimate mass deletion. The completeness pin runs BEFORE any diff so a
// half-down scrape fails loudly instead of green. The ref-integrity pin guards
// H2 (nested `$ref`s left dangling after a collision rename).
//
// Pure file read — no network, runs in CI today.

const SNAPSHOT_PATH = join(import.meta.dir, '../../../../tooling/openapi/specs/coding.json');

type OpenApiDoc = {
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
  'x-coding-aggregation'?: {
    complete?: boolean;
    backends?: Array<{ name: string; ok: boolean }>;
    failed?: string[];
  };
};

function loadSnapshot(): OpenApiDoc {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as OpenApiDoc;
}

// The 7 backends the gateway aggregates (coding-gateway `openapi_aggregator.py`).
const EXPECTED_BACKENDS = [
  'analysis',
  'testing',
  'ai',
  'containers',
  'github',
  'security',
  'realtime',
].sort();

// §3.3 spine route table — the upstreams the BFF adapter forwards to. Pinning
// these against wire truth is the D-series structural fix: it would have caught
// the `/api/stats/{c}` 404 (S2) and the `/augmented` crash (S1) at build time.
// Container path-var name follows the gateway spec (`{container_name}`).
const SPINE_UPSTREAMS: Array<{ method: string; path: string }> = [
  { method: 'get', path: '/api/graphs/{container_name}/augmented' },
  { method: 'get', path: '/api/quality/{container_name}/gate' },
  { method: 'get', path: '/api/dependencies/{container_name}/report' },
  { method: 'get', path: '/api/analysis/dependency-report/{container_name}' },
  { method: 'get', path: '/api/containers/' },
  { method: 'post', path: '/api/repositories/provision' },
  { method: 'post', path: '/api/graphs/initialize' },
  { method: 'post', path: '/api/analysis/analyze' },
  { method: 'post', path: '/api/tests/quality-scan' },
];

describe('coding-gateway OpenAPI snapshot', () => {
  test('completeness (H1): x-coding-aggregation reports a complete scrape of all 7 backends', () => {
    const doc = loadSnapshot();
    const agg = doc['x-coding-aggregation'];

    // The aggregation extension MUST be present — its absence means the snapshot
    // predates the honesty fix (gateway #44) and can't be trusted for drift.
    expect(agg, 'snapshot lacks x-coding-aggregation — re-sync against a gateway with the aggregation extension').toBeDefined();
    expect(agg!.complete, `aggregation not complete; failed backends: ${JSON.stringify(agg!.failed ?? [])}`).toBe(true);

    const backends = agg!.backends ?? [];
    const names = backends.map((b) => b.name).sort();
    expect(names).toEqual(EXPECTED_BACKENDS);
    // Every backend scraped OK — a degraded-but-present backend still corrupts the client.
    for (const b of backends) {
      expect(b.ok, `backend ${b.name} did not scrape ok`).toBe(true);
    }
  });

  test('spine route-existence: every §3.3 upstream exists in the snapshot', () => {
    const doc = loadSnapshot();
    const missing = SPINE_UPSTREAMS.filter(
      ({ method, path }) => !doc.paths[path] || !(method in doc.paths[path]!),
    );
    expect(
      missing,
      `spine upstream(s) missing from the gateway spec — the BFF would forward to a 404: ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

  test('ref-integrity (H2): every local $ref resolves to an existing component schema', () => {
    const doc = loadSnapshot();
    const schemas = doc.components?.schemas ?? {};

    const dangling: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref' && typeof value === 'string') {
            const m = value.match(/^#\/components\/schemas\/(.+)$/);
            // Only local component-schema refs are checked; external/other refs
            // (if any) are out of scope for the contamination guard.
            if (m && !(m[1]! in schemas)) dangling.push(value);
          } else {
            walk(value);
          }
        }
      }
    };
    walk(doc.paths);
    walk(schemas);

    expect(
      [...new Set(dangling)],
      'dangling $ref(s) — a colliding schema was renamed but a reference to it was not rewritten (H2)',
    ).toEqual([]);
  });
});
