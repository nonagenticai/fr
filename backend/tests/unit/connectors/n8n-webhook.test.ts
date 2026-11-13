// tests/unit/connectors/n8n-webhook.test.ts
import { describe, expect, test } from 'bun:test';
import { n8nWebhookConnector } from '../../../src/connectors/n8n-webhook';

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) items.push(item);
  return items;
}

describe('n8nWebhookConnector (passive)', () => {
  test('fetch() yields no records (passive connector)', async () => {
    const records = await collect(
      n8nWebhookConnector.fetch(
        { kind: 'n8n_webhook', secret_id: null, webhook_url: 'https://example.com/webhook', expected_records_path: '$' },
        null,
      ),
    );
    expect(records).toHaveLength(0);
  });

  test('fetch() yields no records even with a secret', async () => {
    const records = await collect(
      n8nWebhookConnector.fetch(
        { kind: 'n8n_webhook', secret_id: 'some-id', webhook_url: 'https://example.com/webhook', expected_records_path: '$' },
        { value: 'secret-value' },
      ),
    );
    expect(records).toHaveLength(0);
  });

  test('fetch() does not throw', async () => {
    const gen = n8nWebhookConnector.fetch(
      { kind: 'n8n_webhook', secret_id: null, webhook_url: 'https://example.com/webhook', expected_records_path: '$' },
      null,
    );
    await expect(gen.next()).resolves.toMatchObject({ done: true });
  });
});
