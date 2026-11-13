// tests/unit/connectors/dry-run.test.ts
//
// Spec 2 Plan 2-C Phase 3 Task 3.1 — every connector must implement
// `dryRun(config, secret)` returning a typed
// `{ ok: true, sample_count, sample } | { ok: false, error: { code, message } }`
// envelope. dryRun reuses the existing `fetch` generator via the
// `takeAsyncIter(gen, 3)` helper for the 4 active connectors and does an
// outbound HEAD/OPTIONS preflight for the passive n8n_webhook connector.
//
// Tests cover what needs no remote service:
//   - github / s3 / n8n: config and secret validation error envelopes, which
//     are refused before any outbound call

import { describe, expect, test } from 'bun:test';
import {
  githubQueryConnector,
  s3Connector,
  n8nWebhookConnector,
} from '../../../src/connectors';

// ---------------------------------------------------------------------------
// githubQueryConnector
// ---------------------------------------------------------------------------

describe('githubQueryConnector.dryRun', () => {
  test('error path → ok: false with MISSING_SECRET when secret null', async () => {
    const result = await githubQueryConnector.dryRun(
      {
        kind: 'github_query',
        secret_id: 'uuid-tok',
        query: 'is:open',
        search_type: 'issues',
        max_results: 100,
      },
      null,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('MISSING_SECRET');
  });
});

// ---------------------------------------------------------------------------
// s3Connector
// ---------------------------------------------------------------------------

describe('s3Connector.dryRun', () => {
  test('error path → ok: false with INVALID_SECRET on bad JSON', async () => {
    const result = await s3Connector.dryRun(
      {
        kind: 's3',
        secret_id: 'uuid',
        bucket: 'my-bucket',
        prefix: '',
        region: 'us-east-1',
        max_objects: 100,
      },
      { value: 'not-json' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('INVALID_SECRET');
  });
});

// ---------------------------------------------------------------------------
// n8nWebhookConnector
// ---------------------------------------------------------------------------

describe('n8nWebhookConnector.dryRun', () => {
  test('error path → ok: false on missing webhook_url', async () => {
    const result = await n8nWebhookConnector.dryRun(
      {
        kind: 'n8n_webhook',
        secret_id: null,
        webhook_url: '',
        expected_records_path: '$',
      },
      null,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('CONFIG_MISMATCH');
  });
});
