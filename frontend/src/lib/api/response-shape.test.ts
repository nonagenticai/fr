// Core of the declared-shape reader.
//
// Every test here is written against ONE question: can a caller still confuse
// "the server has no rows" with "I cannot read this body"? The two outcomes are
// asserted separately and never in the same test, because a test that accepted
// either would be the defect in test form.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ROOT,
  ResponseShapeError,
  arrayOf,
  dataEnvelope,
  dataListEnvelope,
  decodeBody,
  decodeResponse,
  describeValue,
  itemsEnvelope,
  nullable,
  num,
  object,
  oneOf,
  optional,
  record,
  sanitizeEndpoint,
  str,
} from './response-shape';
import { SHAPE_MISMATCH_EVENT, type ShapeMismatchReport } from '$lib/telemetry/shape-mismatch';

const ROW = record<{ id: string }>({ id: str });
const CTX = { endpoint: '/api/reports', method: 'GET', status: 200 };

let reports: ShapeMismatchReport[];

// fr's own telemetry line, captured off console.error (the production sink).
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  reports = [];
  consoleError = vi.spyOn(console, 'error').mockImplementation((event: unknown, p: unknown) => {
    if (event !== SHAPE_MISMATCH_EVENT) return;
    const r = p as { route: string; method: string; status: number; path: string; expected: string; received: string };
    reports.push({ endpoint: r.route, method: r.method, status: r.status, path: r.path, expected: r.expected, received: r.received });
  });
});

afterEach(() => {
  consoleError.mockRestore();
});

// -----------------------------------------------------------------------------
// The distinction. This is the whole point of the module.
// -----------------------------------------------------------------------------

describe('empty is not mismatch', () => {
  it('a legitimately EMPTY {items,total} response resolves to zero rows', () => {
    const out = decodeBody({ items: [], total: 0 }, itemsEnvelope(ROW), CTX);
    expect(out).toEqual({ items: [], total: 0 });
  });

  it('an empty response emits NO telemetry — zero rows is not an incident', () => {
    decodeBody({ items: [], total: 0 }, itemsEnvelope(ROW), CTX);
    expect(reports).toEqual([]);
  });

  it('the WRONG envelope throws instead of resolving to zero rows', () => {
    // The live pair: /api/reports is {items,total}; /api/reports/approval-backlog
    // is {data}. A caller declaring one and served the other used to get [].
    expect(() => decodeBody({ data: { pending: 4 } }, itemsEnvelope(ROW), CTX)).toThrow(
      ResponseShapeError,
    );
  });

  it('⚠️ a mismatch NEVER yields an empty list — the `?? []` fallback is gone', () => {
    // The mutant this pins: making the mismatch path `return { items: [], total: 0 }`.
    // That is the live bug. If decodeBody ever returns for a wrong envelope,
    // this fails on its assertion rather than on a thrown error.
    let returned: unknown = Symbol('did-not-return');
    try {
      returned = decodeBody({ data: [{ id: 'a' }] }, itemsEnvelope(ROW), CTX);
    } catch {
      returned = Symbol('threw');
    }
    expect(returned).not.toEqual({ items: [], total: 0 });
    expect(returned).not.toEqual([]);
    expect(returned).toBeTypeOf('symbol');
    expect(String(returned)).toBe('Symbol(threw)');
  });

  it('a body of zero rows and a body of the wrong shape reach the caller differently', () => {
    const outcome = (body: unknown) => {
      try {
        return { kind: 'value' as const, rows: decodeBody(body, itemsEnvelope(ROW), CTX).items };
      } catch (e) {
        return { kind: 'error' as const, isShape: e instanceof ResponseShapeError };
      }
    };
    expect(outcome({ items: [], total: 0 })).toEqual({ kind: 'value', rows: [] });
    expect(outcome({ data: [] })).toEqual({ kind: 'error', isShape: true });
  });

  it('an empty list under the WRONG envelope is still a mismatch, not an empty list', () => {
    // The nastiest case: both bodies mean "nothing", so a length check can
    // never separate them. Only the declaration can.
    expect(() => decodeBody({ data: [] }, itemsEnvelope(ROW), CTX)).toThrow(ResponseShapeError);
  });
});

// -----------------------------------------------------------------------------
// Envelopes
// -----------------------------------------------------------------------------

describe('envelopes', () => {
  it('itemsEnvelope derives total from items.length when total is absent', () => {
    expect(decodeBody({ items: [{ id: 'a' }] }, itemsEnvelope(ROW), CTX).total).toBe(1);
  });

  it('itemsEnvelope keeps the server total when present', () => {
    expect(decodeBody({ items: [{ id: 'a' }], total: 97 }, itemsEnvelope(ROW), CTX).total).toBe(97);
  });

  it('itemsEnvelope rejects a non-numeric total', () => {
    expect(() => decodeBody({ items: [], total: 'lots' }, itemsEnvelope(ROW), CTX)).toThrow(
      ResponseShapeError,
    );
  });

  it('itemsEnvelope rejects items that is an object rather than an array', () => {
    // `items[0]` on an object is `undefined`, which a page renders as a blank row.
    expect(() => decodeBody({ items: { 0: { id: 'a' } } }, itemsEnvelope(ROW), CTX)).toThrow(
      ResponseShapeError,
    );
  });

  it('dataListEnvelope reads {data: [...]}', () => {
    expect(decodeBody({ data: [{ id: 'a' }] }, dataListEnvelope(ROW), CTX)).toEqual({
      items: [{ id: 'a' }],
      total: 1,
    });
  });

  it('dataListEnvelope rejects {items,total} — the mirror of the reports pair', () => {
    expect(() => decodeBody({ items: [{ id: 'a' }], total: 1 }, dataListEnvelope(ROW), CTX)).toThrow(
      ResponseShapeError,
    );
  });

  it('dataEnvelope reads a non-list {data: X}', () => {
    const shape = dataEnvelope(object({ pending: num }));
    expect(decodeBody({ data: { pending: 4 } }, shape, CTX)).toMatchObject({ pending: 4 });
  });

  it('a null body is a mismatch, not an empty page (204 arrives here as null)', () => {
    expect(() => decodeBody(null, itemsEnvelope(ROW), CTX)).toThrow(ResponseShapeError);
  });
});

// -----------------------------------------------------------------------------
// Tolerance that is deliberate
// -----------------------------------------------------------------------------

describe('additive backend changes do not break a page', () => {
  it('an unknown top-level key is accepted', () => {
    expect(
      decodeBody({ items: [], total: 0, next_cursor: 'abc' }, itemsEnvelope(ROW), CTX).items,
    ).toEqual([]);
  });

  it('an unknown ROW field is accepted AND survives to the caller', () => {
    // record() returns the row by reference. A decoder that rebuilt the object
    // would blank every field its author forgot — a quiet defect traded for a
    // loud one, which is backwards.
    const out = decodeBody({ items: [{ id: 'a', title: 'hi', added_later: 9 }] }, itemsEnvelope(ROW), CTX);
    expect(out.items[0]).toEqual({ id: 'a', title: 'hi', added_later: 9 });
  });

  it('object() carries undeclared keys through as well', () => {
    const out = decodeBody({ count: 2, extra: 'kept' }, object({ count: num }), CTX) as Record<
      string,
      unknown
    >;
    expect(out.extra).toBe('kept');
  });

  it('but a MISSING guarded row field is a mismatch', () => {
    expect(() => decodeBody({ items: [{ name: 'no id here' }] }, itemsEnvelope(ROW), CTX)).toThrow(
      ResponseShapeError,
    );
  });
});

// -----------------------------------------------------------------------------
// Primitives
// -----------------------------------------------------------------------------

describe('primitives', () => {
  it('nullable admits null but optional-absent is different from null', () => {
    expect(decodeBody({ a: null }, object({ a: nullable(str) }), CTX).a).toBeNull();
    expect(decodeBody({}, object({ a: optional(str) }), CTX).a).toBeUndefined();
  });

  it('nullable does NOT admit a missing key', () => {
    expect(() => decodeBody({}, object({ a: nullable(str) }), CTX)).toThrow(ResponseShapeError);
  });

  it('num rejects NaN and Infinity — JSON cannot carry them, so they mean a bug', () => {
    expect(() => decodeBody({ a: NaN }, object({ a: num }), CTX)).toThrow(ResponseShapeError);
    expect(() => decodeBody({ a: Infinity }, object({ a: num }), CTX)).toThrow(ResponseShapeError);
  });

  it('oneOf rejects a value outside the closed set', () => {
    const shape = object({ scope: oneOf(['tenant', 'all'] as const) });
    expect(decodeBody({ scope: 'all' }, shape, CTX).scope).toBe('all');
    expect(() => decodeBody({ scope: 'workspace' }, shape, CTX)).toThrow(ResponseShapeError);
  });

  it('arrayOf rejects one bad element among good ones', () => {
    expect(() => decodeBody({ items: [{ id: 'a' }, { id: 7 }] }, itemsEnvelope(ROW), CTX)).toThrow(
      ResponseShapeError,
    );
  });

  it('arrayOf accepts an empty array — that is the empty case, not a mismatch', () => {
    expect(decodeBody({ items: [] }, itemsEnvelope(arrayOf(str)), CTX).items).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Diagnostics — shape only, never values
// -----------------------------------------------------------------------------

describe('describeValue leaks no data', () => {
  it('names object keys but never their values', () => {
    expect(describeValue({ token: 'eyJhbGciOi.secret.sig', email: 'a@b.c' })).toBe(
      'object{email, token}',
    );
  });

  it('reports array length, not contents', () => {
    expect(describeValue([{ ssn: '123-45-6789' }])).toBe('array(1)');
  });

  it('reports a bare string as its type only', () => {
    expect(describeValue('Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')).toBe('string');
  });

  it('summarises beyond the key cap instead of dumping a wide object', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`k${String(i).padStart(2, '0')}`, i]),
    );
    expect(describeValue(wide)).toBe('object{k00, k01, k02, k03, k04, k05, k06, k07, +3 more}');
  });

  it('distinguishes null, undefined and an empty object', () => {
    expect(describeValue(null)).toBe('null');
    expect(describeValue(undefined)).toBe('undefined');
    expect(describeValue({})).toBe('object{}');
  });
});

// -----------------------------------------------------------------------------
// Telemetry
// -----------------------------------------------------------------------------

describe('telemetry', () => {
  it('emits exactly one report per mismatch', () => {
    expect(() => decodeBody({ data: [] }, itemsEnvelope(ROW), CTX)).toThrow();
    expect(reports).toHaveLength(1);
  });

  it('the report names the endpoint, the path, the expectation and what arrived', () => {
    expect(() => decodeBody({ data: [] }, itemsEnvelope(ROW), CTX)).toThrow();
    expect(reports[0]).toEqual({
      endpoint: '/api/reports',
      method: 'GET',
      status: 200,
      path: ROOT,
      expected: 'object{items: array of object{id}, total?: number}',
      received: 'object{data}',
    });
  });

  it('the report points at the exact bad element deep in the body', () => {
    expect(() => decodeBody({ items: [{ id: 'a' }, { id: 7 }] }, itemsEnvelope(ROW), CTX)).toThrow();
    // `toMatchObject` on the whole report, never `reports[0].path` — indexing an
    // empty array throws a TypeError, and a test that dies on a TypeError has
    // stopped asserting anything. Measured: it made 8 of these pass-by-crash
    // under the "sink is never called" mutant.
    expect(reports[0]).toMatchObject({ path: 'items[1].id', received: 'number' });
  });

  it('the report carries no row values', () => {
    expect(() =>
      decodeBody({ items: [{ id: 'a' }, { id: 7, secret: 'hunter2' }] }, itemsEnvelope(ROW), CTX),
    ).toThrow();
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports)).not.toContain('hunter2');
  });

  it('strips the query string — an endpoint can carry a filter or an OAuth code', () => {
    expect(() =>
      decodeBody({ data: [] }, itemsEnvelope(ROW), {
        endpoint: '/api/me/notifications?status=unread&code=abc123',
      }),
    ).toThrow();
    expect(reports[0]).toMatchObject({ endpoint: '/api/me/notifications' });
    expect(sanitizeEndpoint('/a/b?x=1#frag')).toBe('/a/b');
  });

});

// -----------------------------------------------------------------------------
// The error itself
// -----------------------------------------------------------------------------

describe('ResponseShapeError', () => {
  it('says outright that this is not an empty result', () => {
    try {
      decodeBody({ data: [] }, itemsEnvelope(ROW), CTX);
      expect.unreachable('should have thrown');
    } catch (e) {
      // The page renders `err.message` verbatim, so the sentence a user and an
      // operator both read is asserted here, not just the type.
      expect((e as Error).message).toBe(
        'GET /api/reports returned a response this page cannot read: expected ' +
          'object{items: array of object{id}, total?: number} at <response root>, ' +
          'received object{data}. This is a bug, not an empty result.',
      );
    }
  });

  it('is an Error, so an existing `catch (e) { error = e }` renders it unchanged', () => {
    const e = new ResponseShapeError({
      endpoint: '/x',
      method: 'GET',
      status: 200,
      path: ROOT,
      expected: 'a',
      received: 'b',
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ResponseShapeError');
  });
});

// -----------------------------------------------------------------------------
// decodeResponse over a real Response
// -----------------------------------------------------------------------------

describe('decodeResponse', () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('reads a good body', async () => {
    await expect(
      decodeResponse(json({ items: [] }), itemsEnvelope(ROW), { endpoint: '/api/x' }),
    ).resolves.toEqual({ items: [], total: 0 });
  });

  it('a non-JSON body is a mismatch, not a parse crash', async () => {
    // 15 of the 60 measured GET routes return non-JSON; an HTML error page
    // arriving where a list was expected is a live possibility.
    const html = new Response('<!doctype html><h1>502 Bad Gateway</h1>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    await expect(
      decodeResponse(html, itemsEnvelope(ROW), { endpoint: '/api/x' }),
    ).rejects.toBeInstanceOf(ResponseShapeError);
    expect(reports[0]).toMatchObject({ received: 'a body that is not JSON' });
  });

  it('carries the real HTTP status into the report', async () => {
    await expect(
      decodeResponse(json({ data: [] }), itemsEnvelope(ROW), { endpoint: '/api/x' }),
    ).rejects.toThrow(ResponseShapeError);
    expect(reports[0]).toMatchObject({ status: 200 });
  });
});

// -----------------------------------------------------------------------------
// arrayOf index reporting needs a throwing case; keep the suite honest.
// -----------------------------------------------------------------------------

describe('no accidental console noise in the default sink path', () => {
  it('the console sink writes exactly one console.error line per mismatch', () => {
    expect(() => decodeBody({ data: [] }, itemsEnvelope(ROW), CTX)).toThrow();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][0]).toBe('fr.client.response_shape_mismatch');
  });
});
