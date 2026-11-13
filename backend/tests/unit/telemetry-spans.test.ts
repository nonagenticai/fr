// tests/unit/telemetry-spans.test.ts
//
// emitSpan keeps its call signature (name + attributes + async handler) and
// returns the handler's value through the real OTel API's default provider.

import { describe, expect, test } from 'bun:test';

import { emitSpan } from '../../src/telemetry/spans';

describe('emitSpan', () => {
  test('signature is unchanged — name + attributes + async handler', async () => {
    const r = await emitSpan('x.y', {}, async () => 42);
    expect(r).toBe(42);
  });
});
