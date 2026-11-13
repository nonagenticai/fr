// An upstream provider that is merely UNCONFIGURED must not surface as a 5xx.
//
// The live defect (2026-08-07): worker_management answers
// `/providers/:p/models` for an unconfigured provider with a fast, perfectly
// clear JSON 502:
//
//   {"error":{"code":"BAD_GATEWAY",
//     "message":"Upstream unreachable for provider 'anthropic': ANTHROPIC_API_KEY is not configured"}}
//
// fr passed that through as a 502 — and because it is a 5xx, Cloudflare
// REPLACES the body with its own HTML error page. The one sentence that
// explained everything was destroyed in transit, so /chat rendered an empty
// model dropdown with no reason. Measured live: 7 of 11 providers (anthropic,
// openai, groq, google, deepseek, cohere, vlm_local) behaved this way. That is
// what "fr chat is broken" actually was.
//
// The invariant: this condition never lands in the 5xx range, and the upstream's
// actionable sentence survives.

import { describe, expect, test } from 'bun:test';
import {
  IntegrationError,
  integrationErrorResponse,
} from '../../../src/integrations/_lib/errors';

function unconfigured(provider: string, envVar: string) {
  return new IntegrationError({
    code: 'UPSTREAM_BAD_STATUS',
    message: `worker_management GET /providers/${provider}/models returned 502`,
    service: 'worker_management',
    upstreamStatus: 502,
    upstreamBody: {
      error: {
        code: 'BAD_GATEWAY',
        message: `Upstream unreachable for provider '${provider}': ${envVar} is not configured`,
        status: 502,
      },
    },
  });
}

describe('integrationErrorResponse — provider not configured', () => {
  test('is NOT a 5xx, so Cloudflare cannot swallow the body', async () => {
    const res = integrationErrorResponse(unconfigured('anthropic', 'ANTHROPIC_API_KEY'));
    // The whole point: anything >= 500 gets its body replaced in transit.
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(424);
  });

  test('keeps the actionable sentence naming the missing key', async () => {
    const res = integrationErrorResponse(unconfigured('openai', 'OPENAI_API_KEY'));
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('provider_not_configured');
    expect(body.error.message).toContain('OPENAI_API_KEY is not configured');
    expect(body.error.message).toContain('openai');
  });

  test('every provider seen failing live maps the same way', async () => {
    for (const [p, key] of [
      ['anthropic', 'ANTHROPIC_API_KEY'],
      ['openai', 'OPENAI_API_KEY'],
      ['groq', 'GROQ_API_KEY'],
      ['google', 'GEMINI_API_KEY'],
      ['deepseek', 'DEEPSEEK_API_KEY'],
      ['cohere', 'COHERE_API_KEY'],
    ] as const) {
      const res = integrationErrorResponse(unconfigured(p, key));
      expect(res.status).toBe(424);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain(key);
    }
  });

  test('a REAL gateway failure still collapses to 502 — we did not blanket-downgrade 5xx', async () => {
    const genuine = new IntegrationError({
      code: 'UPSTREAM_BAD_STATUS',
      message: 'worker_management GET /providers/vllm/models returned 502',
      service: 'worker_management',
      upstreamStatus: 502,
      upstreamBody: { error: { code: 'BAD_GATEWAY', message: 'connection refused' } },
    });
    expect(integrationErrorResponse(genuine).status).toBe(502);
  });

  test('a 502 with no parseable body still collapses to 502', async () => {
    const opaque = new IntegrationError({
      code: 'UPSTREAM_BAD_STATUS',
      message: 'returned 502',
      service: 'worker_management',
      upstreamStatus: 502,
      upstreamBody: '<html>gateway</html>',
    });
    expect(integrationErrorResponse(opaque).status).toBe(502);
  });

  test('"not configured" on a NON-502 is untouched (no over-broad matching)', async () => {
    const badRequest = new IntegrationError({
      code: 'UPSTREAM_BAD_STATUS',
      message: 'returned 400',
      service: 'worker_management',
      upstreamStatus: 400,
      upstreamBody: { error: { message: 'model is not configured for this request' } },
    });
    expect(integrationErrorResponse(badRequest).status).toBe(400);
  });
});
