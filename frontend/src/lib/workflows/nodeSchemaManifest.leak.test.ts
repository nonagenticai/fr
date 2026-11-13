// The node-schema manifest ships in the PUBLIC frontend bundle. It carried
// in-cluster service URLs (svc.cluster.local), `*.internal` hosts, a secret
// env-var name (N8N_WEBHOOK_SECRET) and a private memory-file reference in
// parameter defaults/descriptions. `bundle-n8n-schemas.ts` now drops any such
// string at generation time; this pins the committed output.

import { describe, expect, it } from 'vitest';
import { nodeTypeToSchema } from './nodeSchemaManifest';
import { LEAK_PATTERNS, leaks, sanitizeSchema } from '../../../scripts/lib/sanitize-node-schema';

describe('nodeSchemaManifest (public bundle)', () => {
  const serialised = JSON.stringify(nodeTypeToSchema);

  it('is non-trivial (guards against a vacuous scan)', () => {
    expect(Object.keys(nodeTypeToSchema).length).toBeGreaterThan(20);
    expect(serialised.length).toBeGreaterThan(100_000);
  });

  it.each([
    ['svc.cluster.local', /svc\.cluster\.local/i],
    ['*.internal host', /[a-z0-9-]\.internal\b/i],
    ['N8N_WEBHOOK_SECRET', /N8N_WEBHOOK_SECRET/],
    ['memory file reference', /\bmemory\b[^"]{0,80}\.md\b/i],
  ])('contains no %s anywhere', (_label, re) => {
    expect(serialised).not.toMatch(re);
  });

  it('every leak pattern finds nothing in the committed manifest', () => {
    for (const re of LEAK_PATTERNS) expect(serialised).not.toMatch(re);
  });
});

describe('sanitizeSchema', () => {
  it('drops leaking defaults/descriptions at every depth and keeps the rest', () => {
    const out = sanitizeSchema({
      displayName: 'X',
      description: 'See memory upstream-license-token-pattern.md',
      properties: [
        {
          name: 'frBaseUrl',
          description: 'Base URL of the fr-backend service',
          default: 'http://fr-backend.fr.svc.cluster.local:8000',
        },
        { name: 'secret', description: 'Matches N8N_WEBHOOK_SECRET env.', default: '' },
        {
          name: 'col',
          values: [{ name: 'ep', description: 'defaults to https://coding.internal' }],
          options: [{ name: 'internal', value: 'internal', description: 'internal docs' }],
        },
      ],
    });
    expect(out.description).toBeUndefined();
    expect(out.properties[0]).toEqual({
      name: 'frBaseUrl',
      description: 'Base URL of the fr-backend service',
    });
    expect(out.properties[1]).toEqual({ name: 'secret', default: '' });
    expect(out.properties[2]!.values).toEqual([{ name: 'ep' }]);
    // The plain English word "internal" is not a host and survives.
    expect(out.properties[2]!.options).toEqual([
      { name: 'internal', value: 'internal', description: 'internal docs' },
    ]);
  });

  // FR-4: the sanitizer covered only `default`/`description`, so an option
  // `value`, a `displayName` or a `placeholder` naming an internal host shipped.
  it('drops internal hosts in option values, placeholders and labels', () => {
    const out = sanitizeSchema({
      displayName: 'Node',
      properties: [
        {
          name: 'endpoint',
          displayName: 'Endpoint',
          type: 'options',
          placeholder: 'http://kag.internal:8000',
          options: [
            { name: 'Cluster', value: 'http://fr-backend.fr.svc:8000' },
            { name: 'Tailnet', value: 'http://100.64.0.11:5432' },
            { name: 'LAN', value: '192.168.1.13' },
            { name: 'Public', value: 'https://api.example.com' },
            { name: 'kag.internal', value: 'k' },
          ],
        },
        { name: 'host', displayName: 'Host (registry.internal:5000)', type: 'string' },
        { name: 'x.svc.cluster.local', displayName: 'kag.kag.svc', type: 'string' },
      ],
    });
    expect(out.properties).toEqual([
      {
        name: 'endpoint',
        displayName: 'Endpoint',
        type: 'options',
        options: [
          { name: 'Cluster' },
          { name: 'Tailnet' },
          { name: 'LAN' },
          { name: 'Public', value: 'https://api.example.com' },
        ],
      },
      { name: 'host', displayName: 'host', type: 'string' },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/internal|\.svc|100\.64|192\.168/);
  });

  it('leaks() flags cluster svc names and private/tailnet IPs but not public ones', () => {
    expect(leaks('http://fr-backend.fr.svc:8000')).toBe(true);
    expect(leaks('10.43.0.219:9090')).toBe(true);
    expect(leaks('172.20.0.5')).toBe(true);
    expect(leaks('100.64.0.10')).toBe(true);
    expect(leaks('8.8.8.8')).toBe(false);
    expect(leaks('127.0.0.1')).toBe(false);
    expect(leaks('version 10.1.2')).toBe(false);
  });

  it('leaks() is false for non-strings and ordinary text', () => {
    expect(leaks(undefined)).toBe(false);
    expect(leaks(42)).toBe(false);
    expect(leaks('internal')).toBe(false);
    expect(leaks('A token for the tenant')).toBe(false);
  });
});
