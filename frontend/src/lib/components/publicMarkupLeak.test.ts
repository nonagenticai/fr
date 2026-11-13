// Svelte markup ships in the PUBLIC bundle. An attribute value naming an
// in-cluster host (`placeholder="https://minio.example.com"` on the S3 connector
// form) told every visitor fr's internal topology. Attribute values only:
// comments are stripped at build time and are not scanned.

import { describe, expect, it } from 'vitest';

const sources = import.meta.glob('/src/**/*.svelte', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const ATTR_VALUE = /=\s*"([^"]*)"/g;
const INTERNAL_HOST = /[a-z0-9-]\.internal\b|svc\.cluster\.local/i;

describe('public svelte markup', () => {
  it('scans a non-trivial set of components (guards against a vacuous glob)', () => {
    // Named component, not a `>50` count: a glob that matched nothing fails here.
    expect(Object.keys(sources)).toContain('/src/lib/layout/SidebarNav.svelte');
  });

  it('no attribute value names an internal host', () => {
    const hits: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      for (const m of src.matchAll(ATTR_VALUE)) {
        if (INTERNAL_HOST.test(m[1]!)) hits.push(`${file}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
