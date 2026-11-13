// Residual clientSafeStoredJson gaps validator 2 found at 525f73e4 (no writer
// known yet, but the registry is open — any action's output lands here):
//  - `{failed: [{target, why}]}`: `why` was not an error key and the elements
//    carry no failure marker, so the raw text passed;
//  - a STRING `status` ("503 from …") under an error-like parent passed, and a
//    string status did not mark the object error-like at all;
//  - `upstream_body` / `response_text` passed outside a raw-reply position.

import { describe, expect, test } from 'bun:test';
import { clientSafeStoredJson } from '../../../src/integrations/_lib/errors';
import { withRequestContext, type RequestContext } from '../../../src/integrations/_lib/context';

function frame(callerIsSuperAdmin: boolean): RequestContext {
  return {
    correlationId: 'stored-json-r4',
    initiator: 'human',
    channel: 'web',
    tenantId: '0195f48b-d000-7000-8000-0000000000cc',
    callerIsSuperAdmin,
  };
}

const G = 'failed — the detail is available to an operator';
const RAW = 'POST http://workers.example.com:8002/message refused (10.43.0.7)';

const customer = <T>(v: T): Promise<T> =>
  withRequestContext(frame(false), async () => clientSafeStoredJson(v, G));
const operator = <T>(v: T): Promise<T> =>
  withRequestContext(frame(true), async () => clientSafeStoredJson(v, G));

describe('clientSafeStoredJson — round 4 residuals', () => {
  test('failed[].why is redacted; the count and numbers survive', async () => {
    const out = await customer({
      delivered_to: ['alice@example.com'],
      failed: [
        { target: 'bob@example.com', why: RAW, attempts: 3 },
        { target: 'carol@example.com', why: RAW, attempts: 1 },
      ],
    });
    expect(JSON.stringify(out)).not.toContain('workers.workers');
    expect(out.failed).toHaveLength(2);
    expect(out.failed[0]!.why).toBe(G);
    expect(out.failed[0]!.attempts).toBe(3);
    // The success half of a partial failure is the customer's own data.
    expect(out.delivered_to).toEqual(['alice@example.com']);
  });

  test('a lone `why` anywhere is an error key', async () => {
    const out = await customer({ skipped: { why: RAW } });
    expect(out.skipped.why).toBe(G);
  });

  test('a string status under an error-like parent is redacted (root and nested)', async () => {
    const out = await customer({
      error: 'x',
      status: `503 from ${RAW}`,
      nested: { ok: false, status: `502 ${RAW}`, code: 7 },
    });
    expect(JSON.stringify(out)).not.toContain('workers.workers');
    expect(out.status).toBe(G);
    expect(out.nested.status).toBe(G);
    expect(out.nested.code).toBe(7);
  });

  test('a string HTTP-failure status alone marks a nested object error-like (deny-by-default)', async () => {
    const out = await customer({ result: { status: '503', note: RAW } });
    expect(out.result.status).toBe(G);
    expect(out.result.note).toBe(G);
  });

  test('a success status string outside an error-like object is untouched', async () => {
    const out = await customer({ status: 'delivered', result: { status: 'ok', note: 'sent' } });
    expect(out).toEqual({ status: 'delivered', result: { status: 'ok', note: 'sent' } });
  });

  test('upstream_body / response_text are redacted wherever they appear', async () => {
    const out = await customer({
      upstream_body: RAW,
      response_text: RAW,
      result: { upstreamBody: RAW, responseText: RAW },
    });
    expect(JSON.stringify(out)).not.toContain('workers.workers');
  });

  test('super-admin sees the document as stored', async () => {
    const doc = { failed: [{ why: RAW }], error: 'x', status: `503 ${RAW}`, upstream_body: RAW };
    expect(await operator(doc)).toEqual(doc);
  });
});

// FR-7: the residuals left after round 4 — all with RAW text, all customer reads.
describe('clientSafeStoredJson — FR-7 residuals (deny-by-default)', () => {
  test('{ok:false, text} at the ROOT: the unlisted key is denied', async () => {
    const out = await customer({ ok: false, text: RAW, channel: 'telegram', delivery_id: 'd-1' });
    expect(out.text).toBe(G);
    // Identifiers and kinds at the error-like root survive.
    expect(out.channel).toBe('telegram');
    expect(out.delivery_id).toBe('d-1');
  });

  test('a STRING `failed` is failure text', async () => {
    const out = await customer({ delivered_to: ['a@example.com'], failed: RAW });
    expect(out.failed).toBe(G);
    expect(out.delivered_to).toEqual(['a@example.com']);
  });

  test.each(['problem', 'hint', 'cause', 'stdout', 'warning', 'log'])(
    'unlisted key `%s` is redacted outside an error-like object too',
    async (key) => {
      const out = (await customer({ result: { [key]: RAW, count: 2 } })) as {
        result: Record<string, unknown>;
      };
      expect(out.result[key]).toBe(G);
      expect(out.result.count).toBe(2);
    },
  );

  test('a non-error root keeps its own strings', async () => {
    const out = await customer({ ok: true, text: 'Sent to 3 recipients' });
    expect(out.text).toBe('Sent to 3 recipients');
  });

  test('super-admin still sees the raw document', async () => {
    const doc = { ok: false, text: RAW, failed: RAW, result: { problem: RAW } };
    expect(await operator(doc)).toEqual(doc);
  });
});
