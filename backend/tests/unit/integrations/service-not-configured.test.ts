// tests/unit/integrations/service-not-configured.test.ts
//
// An OPTIONAL upstream whose base URL is unset must refuse cleanly, before any
// fetch: a 503 `SERVICE_NOT_CONFIGURED`, not an opaque retried
// UPSTREAM_UNREACHABLE from `fetch('/path')`. This is the production shape for
// KAG_API_URL since the KAG family was removed from the cluster (gitops #4968).

import { describe, expect, test } from 'bun:test';
import { createHttpClient } from '../../../src/integrations/_lib/http-client';
import {
  IntegrationError,
  integrationErrorResponse,
} from '../../../src/integrations/_lib/errors';

async function refusal(p: Promise<unknown>): Promise<IntegrationError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof IntegrationError) return err;
    throw err;
  }
  throw new Error('expected the call to be refused');
}

describe('HttpClient with no base URL', () => {
  const client = createHttpClient({ serviceName: 'kag', baseUrl: '', sendAuthorization: false });

  test('json() refuses with SERVICE_NOT_CONFIGURED → 503', async () => {
    const err = await refusal(client.json('/api/documents'));
    expect(err.code).toBe('SERVICE_NOT_CONFIGURED');
    expect(err.service).toBe('kag');
    const res = integrationErrorResponse(err);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('SERVICE_NOT_CONFIGURED');
    expect(body.error.message).toBe('This feature is not available on this deployment');
  });

  test('fetch() refuses the same way', async () => {
    const err = await refusal(client.fetch('/media/api/collections'));
    expect(err.code).toBe('SERVICE_NOT_CONFIGURED');
  });

  test('proxy() refuses the same way', async () => {
    const err = await refusal(client.proxy(new Request('http://fr.test/api/x'), '/x'));
    expect(err.code).toBe('SERVICE_NOT_CONFIGURED');
  });
});
