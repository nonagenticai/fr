// Fixture for tests/unit/db/test-database-url-refusal.test.ts — run ONLY as a subprocess `bun test`
// (so the bunfig preloads, tests/setup-env.ts among them, run exactly as for a real test file).
// Not a `.test.ts`: never collected by a suite on its own.
import { expect, test } from 'bun:test';

import { queryClient } from '../../../src/db/client';

test('probe', async () => {
  let out = 'NOT_QUERIED';
  if (process.env.PROBE_QUERY === '1') {
    try {
      await queryClient`select 1 as one`;
      out = 'CONNECTED';
    } catch (err) {
      out = `ERROR ${(err as Error).message}`;
    }
  }
  console.log(`PROBE_RESULT ${JSON.stringify({ refused: process.env.FR_TEST_DATABASE_URL_REFUSED ?? null, url: process.env.DATABASE_URL ?? null, out })}`);
  expect(out.length).toBeGreaterThan(0);
  await queryClient.end({ timeout: 1 });
});
