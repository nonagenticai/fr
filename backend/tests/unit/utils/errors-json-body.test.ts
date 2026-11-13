// tests/unit/utils/errors-json-body.test.ts
//
// A malformed INBOUND request body is the caller's fault: 400, never 500.
//
// ~150 handlers call `await req.json()` bare; on `{bad` Bun throws a plain
// SyntaxError("Failed to parse JSON") (empty body: "Unexpected end of JSON
// input") that used to fall through `handleError` to a generic 500.
//
// The half that guards the fix: an UPSTREAM `Response.json()` failure throws a
// byte-identical SyntaxError, and it must NOT be laundered into a client 400.
// Provenance is therefore recorded on the inbound Request
// (`tagInboundJsonParseErrors`, called by server.ts before dispatch), not
// inferred from the message.

import { describe, expect, test } from 'bun:test';

import {
  handleError,
  isInboundJsonBodyParseError,
  statusForError,
  tagInboundJsonParseErrors,
} from '../../../src/utils/errors';
import { toHttpError } from '../../../src/routes/kanban/_errors';

const quiet = <T>(fn: () => T): T => {
  const orig = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = orig;
  }
};

function inbound(body: string | undefined): Request {
  const req = new Request('http://fr.test/api/comments/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  tagInboundJsonParseErrors(req);
  return req;
}

/** A handler shaped like the ~150 bare-`req.json()` routes. */
async function bareHandler(req: Request): Promise<Response> {
  const body = await req.json();
  return new Response(JSON.stringify({ ok: true, body }), { status: 200 });
}

/** server.ts's dispatch shape: run the handler, render a throw via handleError. */
async function dispatch(req: Request, handler = bareHandler): Promise<Response> {
  try {
    return await handler(req);
  } catch (err) {
    return quiet(() => handleError(err));
  }
}

describe('malformed inbound JSON body → 400', () => {
  test('`{bad` → 400 {error: "invalid JSON body"}', async () => {
    const res = await dispatch(inbound('{bad'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid JSON body' });
  });

  test('empty body → 400', async () => {
    const res = await dispatch(inbound(''));
    expect(res.status).toBe(400);
  });

  test('no body at all → 400', async () => {
    const res = await dispatch(inbound(undefined));
    expect(res.status).toBe(400);
  });

  test('statusForError agrees with handleError', async () => {
    const err = await inbound('{bad').json().catch((e: unknown) => e);
    expect(isInboundJsonBodyParseError(err)).toBe(true);
    expect(statusForError(err)).toBe(400);
  });

  test('the kanban shim rethrows it unchanged, so it still lands as 400', async () => {
    const res = await dispatch(inbound('{bad'), async (req) => {
      try {
        await req.json();
        return new Response(null, { status: 204 });
      } catch (err) {
        throw toHttpError(err); // non-Planka → rethrown → handleError
      }
    });
    expect(res.status).toBe(400);
  });
});

describe('no regression', () => {
  test('a valid body still parses through the tagged .json()', async () => {
    const res = await dispatch(inbound('{"a":1}'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, body: { a: 1 } });
  });

  test('the original SyntaxError is rethrown, so a handler catching it is unaffected', async () => {
    const err = await inbound('{bad').json().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyntaxError);
    expect((err as Error).message).toBe('Failed to parse JSON');
  });

  test('tagging twice is idempotent (no double wrap)', async () => {
    const req = inbound('{"a":2}');
    tagInboundJsonParseErrors(req);
    expect(await req.json()).toEqual({ a: 2 });
  });
});

describe('⛔ NOT a client fault — keeps its 500', () => {
  test('an UPSTREAM Response.json() SyntaxError (byte-identical message) → 500, not 400', async () => {
    const res = await dispatch(inbound('{"ok":true}'), async (req) => {
      await req.json(); // inbound body is fine
      await new Response('<html>bad gateway</html>').json(); // upstream is not
      return new Response(null, { status: 204 });
    });
    expect(res.status).toBe(500);
  });

  test('an untagged Request (no server.ts dispatch) → 500, unchanged', async () => {
    const req = new Request('http://fr.test/x', { method: 'POST', body: '{bad' });
    const res = await dispatch(req);
    expect(res.status).toBe(500);
  });

  test('a JSON.parse SyntaxError in our own code → 500', async () => {
    const res = await dispatch(inbound('{}'), async () => {
      JSON.parse('{bad');
      return new Response(null, { status: 204 });
    });
    expect(res.status).toBe(500);
  });

  test('an unrelated thrown Error → 500', async () => {
    const res = await dispatch(inbound('{}'), async () => {
      throw new Error('boom');
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
