// tests/unit/connectors/ssrf-blocking.test.ts
//
// Proves the SSRF guard BLOCKS at each connector call site. Every target here is a
// LITERAL non-global address, so the refusal needs no DNS.
// The other connector
// tests prove the guard does not break the happy path; these prove it does its
// job — a guard nobody has watched refuse something is not known to be a guard.
//
// Reachability that makes this matter: `POST /api/connectors/test-connection`
// (routes/connectors.ts) calls `validateAuth` ONLY — no role gate — so before
// this guard any authenticated tenant user could aim these fetches at any host
// on the Tailnet (100.64.0.0/10).

import { describe, expect, test } from 'bun:test';
import { rssConnector } from '../../../src/connectors/rss';
import { n8nWebhookConnector } from '../../../src/connectors/n8n-webhook';
import { WebhookDispatcher } from '../../../src/connectors/dispatcher';
import type { IntakeEnvelope } from '../../../src/types/intake-envelope';
import { assertPublicUrl } from '../../../src/utils/ssrf-guard';

const envelope = {
  tenant_id: 't1',
  trigger_id: 'tr1',
  records: [],
} as unknown as IntakeEnvelope;

describe('rss connector blocks an internal target', () => {
  test('a literal Tailnet IP is refused even before DNS', async () => {
    const result = await rssConnector.dryRun(
      { kind: 'rss', feed_url: 'http://100.64.0.12:5000/v2/_catalog' }, // the registry
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toMatch(/^destination not allowed$/);
  });
});

describe('n8n-webhook preflight blocks an internal target', () => {
  test('cloud metadata is refused', async () => {
    const result = await n8nWebhookConnector.dryRun(
      { kind: 'n8n_webhook', webhook_url: 'http://169.254.169.254/latest/meta-data/' },
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toMatch(/^destination not allowed$/);
  });
});

describe('WebhookDispatcher blocks an internal target', () => {
  test('a literal internal IP is refused by the dispatcher too', async () => {
    const dispatcher = new WebhookDispatcher();
    await expect(
      dispatcher.dispatch(envelope, { webhook_url: 'http://10.0.0.7/hook' } as never),
    ).rejects.toThrow(/^destination not allowed$/);
  });
});

describe('the shipped default never permits a non-global target', () => {
  test('loopback and CGNAT literals are refused', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow(/^destination not allowed$/);
    await expect(assertPublicUrl('http://100.64.0.1/')).rejects.toThrow(/^destination not allowed$/);
  });
});
