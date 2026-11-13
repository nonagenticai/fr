// Production fr answered every request with
// `Access-Control-Allow-Origin: http://localhost:3000` (fr#1471 live check):
// the config defaulted CORS_ORIGINS to the dev origin, gitops set it to the same,
// and the middleware fell back to origins[0] for ANY Origin. These pin all three.

import { describe, it, expect, afterEach } from 'bun:test';
import { parseCorsOrigins, config } from '../../../src/config';
import { corsHeaders, handleCorsOptions } from '../../../src/middleware/cors';

describe('parseCorsOrigins', () => {
  it('production has no localhost origin by default', () => {
    expect(parseCorsOrigins(undefined, 'production')).toEqual([]);
    expect(parseCorsOrigins('', 'production')).toEqual([]);
  });

  it('production drops loopback origins even when configured', () => {
    const got = parseCorsOrigins(
      'http://localhost:3000, https://fr.nonagentic.ai,http://127.0.0.1:5173,http://[::1]:3000',
      'production',
    );
    expect(got).toEqual(['https://fr.nonagentic.ai']);
    expect(got.some((o) => /localhost|127\.0\.0\.1|\[::1\]/.test(o))).toBe(false);
  });

  it('dev keeps the localhost default', () => {
    expect(parseCorsOrigins(undefined, 'development')).toEqual(['http://localhost:3000']);
    expect(parseCorsOrigins('http://localhost:5173', 'test')).toEqual(['http://localhost:5173']);
  });
});

describe('corsHeaders', () => {
  // config is `as const`; tests swap the allow-list through a writable view.
  const cors = config.cors as { origins: readonly string[] };
  const saved = cors.origins;
  afterEach(() => {
    cors.origins = saved;
  });

  it('echoes only an allow-listed origin', () => {
    cors.origins = ['https://fr.nonagentic.ai'];
    expect(corsHeaders('https://fr.nonagentic.ai')['Access-Control-Allow-Origin']).toBe('https://fr.nonagentic.ai');
  });

  it('never falls back to the first configured origin for a foreign or absent Origin', () => {
    cors.origins = ['http://localhost:3000'];
    expect(corsHeaders('https://evil.example')).toEqual({});
    expect(corsHeaders(null)).toEqual({});
    expect(handleCorsOptions(new Request('http://x/api/health', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }))
      .headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
