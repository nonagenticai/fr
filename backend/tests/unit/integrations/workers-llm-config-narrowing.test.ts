// tests/unit/integrations/workers-llm-config-narrowing.test.ts
//
// fr forwarded whatever worker_management sent in an LLM config response,
// straight to the browser.
//
// `http().json<LlmConfigView>(...)` is a CAST, not a parse — the generic is
// erased at runtime — and `routes/settings/llm-provider.ts:128` returns the
// dep's result verbatim. So nothing in fr narrowed the payload, and an `apiKey`
// in the upstream response would have reached the client.
//
// A test that supplies the clean case and asserts the case is clean is not a
// test of the cleaner. These supply the DIRTY case.
//
// SCOPE, deliberately: this pins TOP-LEVEL narrowing only. `params` is a
// declared `Record<string, unknown>` passthrough and is asserted to survive
// intact — see the last case, which exists so a future "tighten params" change
// is a conscious decision rather than an accident.

import { afterEach, describe, expect, test } from 'bun:test';

import {
  pickLlmConfigView,
  type LlmConfigView,
} from '../../../src/integrations/workers';

/** What a well-behaved upstream sends. */
const CLEAN: LlmConfigView = {
  configured: true,
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  baseUrl: null,
  temperature: null,
  maxTokens: null,
  params: {},
  hasKey: true,
  updatedAt: '2026-06-19T00:00:00Z',
};

afterEach(() => {
  // No global state here, but the suite's db-guard requires assertions to have
  // run; keeping the hook explicit documents that this file needs no teardown.
});

describe('an upstream field fr does not declare never reaches the caller', () => {
  test('a top-level apiKey is DROPPED', async () => {
    // The case the old assertion claimed to cover and never did.
    const dirty = { ...CLEAN, apiKey: 'sk-ant-SUPER-SECRET' } as LlmConfigView;

    const out = pickLlmConfigView(dirty);

    expect('apiKey' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('SUPER-SECRET');
  });

  test('any unknown field is dropped, not just ones named like a secret', async () => {
    // Narrowing by allow-list, not by guessing which names are dangerous. A
    // denylist fails in both directions — it misses a differently-named key and
    // it drops a real setting.
    const dirty = {
      ...CLEAN,
      api_key: 'snake-case',
      authorization: 'Bearer x',
      somethingNobodyAnticipated: 1,
    } as LlmConfigView;

    const out = pickLlmConfigView(dirty);

    expect(Object.keys(out).sort()).toEqual(Object.keys(CLEAN).sort());
  });

  test('every DECLARED field survives — narrowing must not become deleting', async () => {
    // The other direction, and the one that would break the settings page:
    // dropping a real field is as much a defect as forwarding a secret.
    const out = pickLlmConfigView(CLEAN);
    expect(out).toEqual(CLEAN);
  });

  test('`params` is forwarded intact, and that is a KNOWN hole', async () => {
    // `params` is a declared passthrough bag, so a secret placed inside it still
    // reaches the client. Narrowing it needs worker_management to declare the
    // shape; until then this is named, not hidden. If someone later tightens
    // `params`, this case failing is the intended signal to update the contract
    // — not a regression to route around.
    const out = pickLlmConfigView({
      ...CLEAN,
      params: { top_p: 0.9, nested: { anything: true } },
    });

    expect(out.params).toEqual({ top_p: 0.9, nested: { anything: true } });
  });
});
