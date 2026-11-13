// tests/unit/routes/_lib/request.test.ts
//
// These helpers had NO direct test anywhere, in any of their 18 copies. That is
// not an oversight so much as a consequence: a private function in a route file
// is only reachable through the route, so every one of the 94 + 53 call sites
// tested them incidentally and none tested them on purpose. Consolidating them
// is what makes them testable at all.
import { describe, expect, test } from 'bun:test';

import {
  readJsonBody,
  withIntegrationCatch,
  requireArrayField,
  requireStringField,
} from '../../../../src/routes/_lib/request';
import {
  IntegrationError,
  isIntegrationError,
} from '../../../../src/integrations/_lib/errors';

const BASE = 'http://test/api/x';

function post(body: string): Request {
  return new Request(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

async function caught(fn: () => Promise<unknown> | unknown): Promise<IntegrationError> {
  try {
    await fn();
  } catch (err) {
    if (isIntegrationError(err)) return err;
    throw new Error(`expected an IntegrationError, got ${String(err)}`);
  }
  throw new Error('expected a throw');
}

describe('readJsonBody', () => {
  test('parses a well-formed body', async () => {
    expect(await readJsonBody<{ a: number }>(post('{"a":1}'))).toEqual({ a: 1 });
  });

  test('malformed JSON is BAD_REQUEST, not an upstream failure', async () => {
    const err = await caught(() => readJsonBody(post('{ not json')));
    // 400, not 502. Cloudflare replaces origin 5xx bodies with its own HTML,
    // routes/agui.ts calls a status-less error retriable, and 20 n8n modules
    // retry on >= 500 — the status is the signal all three read.
    expect(err.code).toBe('BAD_REQUEST');
  });

  test('it names no service, because none was contacted', async () => {
    const err = await caught(() => readJsonBody(post('{ not json')));
    expect(err.service).toBeUndefined();
    expect(err.upstreamStatus).toBeUndefined();
  });

  test('an empty body is malformed, not an empty object', async () => {
    // Pinned deliberately: one of the copies this replaces
    // (routes/tools/coding.ts parseJsonBody) turned an empty body into `{}`,
    // which silently substitutes a valid-looking value for a missing one.
    const err = await caught(() => readJsonBody(post('')));
    expect(err.code).toBe('BAD_REQUEST');
  });
});

describe('withIntegrationCatch', () => {
  test('passes a successful Response straight through', async () => {
    const res = new Response('ok', { status: 200 });
    expect(await withIntegrationCatch(async () => res)).toBe(res);
  });

  test('converts an IntegrationError into its envelope', async () => {
    const res = await withIntegrationCatch(async () => {
      throw new IntegrationError({ code: 'BAD_REQUEST', message: 'nope' });
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  test('an upstream failure still becomes a 502 — the wrapper decides nothing', async () => {
    const res = await withIntegrationCatch(async () => {
      throw new IntegrationError({
        code: 'UPSTREAM_BAD_BODY',
        message: 'kag returned invalid JSON',
        service: 'kag',
      });
    });
    expect(res.status).toBe(502);
  });

  test('a NON-IntegrationError is rethrown, never laundered into a response', async () => {
    // The important half. A TypeError is a bug; turning it into a tidy error
    // envelope would hide it behind a plausible 4xx/5xx forever.
    const boom = new TypeError('undefined is not a function');
    let thrown: unknown;
    try {
      await withIntegrationCatch(async () => {
        throw boom;
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(boom);
  });
});

describe('requireStringField / requireArrayField', () => {
  test('accept valid values', () => {
    expect(() => requireStringField({ a: 'x' }, 'a')).not.toThrow();
    expect(() => requireArrayField({ a: [1] }, 'a')).not.toThrow();
  });

  test('a blank string is not a string field', async () => {
    const err = await caught(() => requireStringField({ a: '   ' }, 'a'));
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toContain('a');
  });

  test('an empty array is not an array field', async () => {
    const err = await caught(() => requireArrayField({ a: [] }, 'a'));
    expect(err.code).toBe('BAD_REQUEST');
  });

  test('a null or undefined body is refused, not dereferenced', async () => {
    expect((await caught(() => requireStringField(null, 'a'))).code).toBe('BAD_REQUEST');
    expect((await caught(() => requireArrayField(undefined, 'a'))).code).toBe('BAD_REQUEST');
  });
});
