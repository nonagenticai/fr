// tests/setup.ts — bun test preload (after setup-env.ts).
//
// AUTH_BYPASS: route tests run without a Keycloak; src/config.ts refuses it in
// production. The other values are test-only secrets the modules read at load.
process.env.AUTH_BYPASS = 'true';
process.env.ARTIFACTS_DOWNLOAD_SIGNING_KEY ||= 'test-signing-key-do-not-use-in-prod';
process.env.FR_AGENT_JWT_SECRET ||= 'test-fr-agent-jwt-secret-do-not-use-in-prod';
process.env.N8N_API_KEY ||= 'test-n8n-api-key';

import { afterEach } from 'bun:test';
import { queryClient } from '../src/db/client';
import { drainDetachedWork } from '../src/lib/detached-work';

// Warm one pooled connection so the first test does not pay the connect cost.
if (process.env.CI === 'true' && process.env.DATABASE_URL) {
  try {
    await Promise.race([
      queryClient`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('warm-up timeout')), 10_000)),
    ]);
  } catch (err) {
    console.warn('[tests/setup] queryClient warm-up failed:', err);
  }
}

// Fire-and-forget work a test started must finish before the next test runs.
afterEach(async () => {
  await drainDetachedWork(5_000);
});
