// tests/unit/routes/agui-required-params.test.ts
//
// An agent told "correct the input" with no statement of WHAT to correct cannot
// self-correct, so it repeats the same call.
//
// MEASURED 2026-09-01 from 30 days of fr telemetry, the #2 failure group:
// six identical `BAD_REQUEST`s inside 0.8 seconds —
// "codingOutputSource.listOutputs requires params.job_id and params.user_id".
//
// It was NOT a retry storm. `classifyError` already returns `retriable: false`
// for caller-side refusals (#903, 2026-08-31). The cause is that the CONTRACT is
// per-producer while the SCHEMA is producer-agnostic: `bridge.list_outputs`
// declares `filters: z.record(z.string()).optional()` with the prose hint
// "filter shape varies per producer", and each producer requires a different
// set — artifacts `project_id`, coding `job_id`+`user_id`, kag `session_id`.
// Prose is not something an agent can act on.
//
// The disclosure rule is NOT relaxed here, and that distinction is the reason
// this is safe: a caller-side refusal contacted no upstream, so these names are
// fr's OWN contract. There is nothing external to leak. `err.message` and
// `upstreamBody` stay withheld exactly as before, and the second describe below
// is what keeps that honest.

import { describe, expect, test } from 'bun:test';
import { IntegrationError } from '../../../src/integrations/_lib/errors';
import { codingOutputSource } from '../../../src/domain/bridge/sources/coding';
import { artifactsOutputSource } from '../../../src/domain/bridge/sources/artifacts';
import { kagOutputSource } from '../../../src/domain/bridge/sources/kag';

const ctx = {} as never;

describe('a caller-side refusal names what the caller must supply', () => {
  test('the coding producer names BOTH of its required params', async () => {
    let thrown: unknown;
    try {
      await codingOutputSource.listOutputs(ctx, {});
    } catch (e) {
      thrown = e;
    }
    expect((thrown as IntegrationError).code).toBe('BAD_REQUEST');
    expect((thrown as IntegrationError).requiredParams).toEqual(['job_id', 'user_id']);
  });

  test('each producer names its OWN set — the reason prose could not work', async () => {
    // If all three named the same thing, a single sentence in the action
    // description would have sufficed and this whole mechanism would be
    // unnecessary. They do not.
    const got: Record<string, string[] | undefined> = {};
    for (const [name, src] of [
      ['artifacts', artifactsOutputSource],
      ['kag', kagOutputSource],
    ] as const) {
      try {
        await src.listOutputs(ctx, {});
      } catch (e) {
        got[name] = (e as IntegrationError).requiredParams;
      }
    }
    expect(got.artifacts).toEqual(['project_id']);
    expect(got.kag).toEqual(['session_id']);
  });

});

