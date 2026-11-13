// Two read-path scrubbers a validator probed past:
//  - clientSafeStoredJson passed `message`, `error_text`, `failure_reason`,
//    `stderr` and a nested `response.body` raw to a non-super-admin;
//  - clientSafeCallerInputBody passed a top-level validation array (with the
//    echoed `input`), `{message: "Backend service error (…)"}` and a wrapper
//    that did not START the string, unchanged.

import { describe, expect, test } from 'bun:test';
import {
  clientSafeCallerInputBody,
  clientSafeStoredJson,
} from '../../../src/integrations/_lib/errors';
import { withRequestContext, type RequestContext } from '../../../src/integrations/_lib/context';

function frame(callerIsSuperAdmin: boolean): RequestContext {
  return {
    correlationId: 'stored-json-test',
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

describe('clientSafeStoredJson — keys the validator probed', () => {
  test('message, error_text, failure_reason, stderr and any *_reason are redacted', async () => {
    const out = await customer({
      message: RAW,
      error_text: RAW,
      failure_reason: RAW,
      stderr: RAW,
      skip_reason: RAW,
      skipReason: RAW,
      count: 2,
    });
    expect(out).toEqual({
      message: G,
      error_text: G,
      failure_reason: G,
      stderr: G,
      skip_reason: G,
      skipReason: G,
      count: 2,
    });
  });

  test('nested response.body under an error-like parent is denied (unlisted key)', async () => {
    const out = await customer({
      delivered_to: ['email:a@b'],
      kanban: { ok: false, response: { status: 502, body: RAW, headers: { server: 'envoy' } } },
      webhook: { status: 503, body: RAW },
    });
    expect(JSON.stringify(out)).not.toContain('svc.cluster.local');
    expect(JSON.stringify(out)).not.toContain('envoy');
    expect(out).toEqual({
      delivered_to: ['email:a@b'],
      kanban: { ok: false, response: { status: 502, body: G, headers: { server: G } } },
      webhook: { status: 503, body: G },
    });
  });

  test('an error-like ROOT has its raw-reply body denied but keeps the customer\'s own fields', async () => {
    const out = await customer({ ok: false, body: RAW, delivered_to: ['email:a@b'] });
    expect(out).toEqual({ ok: false, body: G, delivered_to: ['email:a@b'] });
  });

  test('a success payload is untouched outside error keys', async () => {
    const ok = { delivered_to: ['email:a@b'], result: { status: 200, body: 'queued' }, count: 1 };
    expect(await customer(ok)).toEqual(ok);
  });

  test('super-admin sees the stored document as is', async () => {
    const doc = { message: RAW, kanban: { ok: false, response: { body: RAW } } };
    expect(await withRequestContext(frame(true), async () => clientSafeStoredJson(doc, G))).toEqual(doc);
  });
});

describe('clientSafeCallerInputBody — the three shapes that passed', () => {
  test('top-level validation array: echoed input dropped, {loc,msg,type} kept', () => {
    const out = clientSafeCallerInputBody([
      { loc: ['body', 'url'], msg: 'bad url', type: 'value_error', input: 'http://postgres.example.com', ctx: { x: 1 } },
    ]);
    expect(out).toEqual([{ loc: ['body', 'url'], msg: 'bad url', type: 'value_error' }]);
    expect(JSON.stringify(out)).not.toContain('postgres.example.com');
  });

  test('{message: "Backend service error (…)"} is dropped', () => {
    expect(clientSafeCallerInputBody({ message: `Backend service error (409): ${RAW}` })).toBeUndefined();
  });

  test('a wrapper that does not start the string is dropped', () => {
    expect(clientSafeCallerInputBody(`kag: Backend service error (422): ${RAW}`)).toBeUndefined();
    expect(clientSafeCallerInputBody({ detail: `proxy said Backend service error (422): ${RAW}` })).toBeUndefined();
    expect(clientSafeCallerInputBody({ error: { reason: `x Backend service error (400) ${RAW}` } })).toBeUndefined();
  });

  test('a typed problem body without the wrapper is unchanged', () => {
    const body = { detail: 'title is required', field: 'title' };
    expect(clientSafeCallerInputBody(body)).toEqual(body);
  });
});
