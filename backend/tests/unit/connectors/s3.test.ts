// tests/unit/connectors/s3.test.ts
import { describe, expect, test } from 'bun:test';
import { s3Connector } from '../../../src/connectors/s3';

const validConfig = {
  kind: 's3' as const,
  secret_id: 'some-uuid',
  bucket: 'my-bucket',
  prefix: '',
  region: 'us-east-1',
  max_objects: 100,
};

describe('s3Connector', () => {
  test('throws MISSING_SECRET when no secret provided', async () => {
    const gen = s3Connector.fetch(validConfig, null);
    await expect(gen.next()).rejects.toThrow(/MISSING_SECRET|secret/i);
  });

  test('throws INVALID_SECRET when secret is not valid JSON', async () => {
    const gen = s3Connector.fetch(validConfig, { value: 'not-json' });
    await expect(gen.next()).rejects.toThrow(/INVALID_SECRET/i);
  });
});
