// src/types/connectors.ts
// Spec 2 Plan 2-B: connector configuration discriminated union.
// Tracks A (cron-tick fetcher) and B (frontend forms) both consume this shape.
// Backend uses .parse() for validation at config save-time; frontend mirrors the
// shape in hand-rolled per-kind subforms.
import { z } from 'zod';

const SecretIdNullable = z.string().uuid().nullable();
const SecretIdRequired = z.string().uuid();

export const FileConnectorConfig = z.object({
  kind: z.literal('file'),
  secret_id: SecretIdNullable,
  path: z.string().min(1), // absolute path on fr-backend pod
  format: z.enum(['json', 'ndjson', 'csv']),
  glob: z.string().optional(), // optional pattern when path is a directory
});

export const RssConnectorConfig = z.object({
  kind: z.literal('rss'),
  secret_id: SecretIdNullable,
  feed_url: z.string().url(),
  max_items: z.number().int().positive().max(500).default(50),
});

export const GithubQueryConnectorConfig = z.object({
  kind: z.literal('github_query'),
  secret_id: SecretIdRequired, // token_secret_id (required for github)
  query: z.string().min(1),
  search_type: z.enum(['issues', 'pulls', 'code', 'repositories']),
  max_results: z.number().int().positive().max(1000).default(100),
});

export const S3ConnectorConfig = z.object({
  kind: z.literal('s3'),
  secret_id: SecretIdRequired, // secret holds {access_key_id, secret_access_key} JSON
  bucket: z.string().min(1),
  prefix: z.string().default(''),
  endpoint: z.string().url().optional(), // for MinIO / non-AWS
  region: z.string().default('us-east-1'),
  max_objects: z.number().int().positive().max(1000).default(100),
});

export const N8nWebhookConnectorConfig = z.object({
  kind: z.literal('n8n_webhook'),
  secret_id: SecretIdNullable, // optional HMAC signing key for inbound verification
  webhook_url: z.string().url(), // n8n inbound webhook URL fr-backend POSTs to
  expected_records_path: z.string().default('$'), // JSONPath into incoming payload
});

export const ConnectorConfig = z.discriminatedUnion('kind', [
  FileConnectorConfig,
  RssConnectorConfig,
  GithubQueryConnectorConfig,
  S3ConnectorConfig,
  N8nWebhookConnectorConfig,
]);

export type ConnectorConfig = z.infer<typeof ConnectorConfig>;
export type ConnectorKind = ConnectorConfig['kind'];

// Per-kind inferred data types. Connectors `import type { S3ConnectorConfig }` to
// get the runtime data shape (not the zod schema). Declaration-merging the type
// alongside the const value is intentional — TS resolves `as Foo` to the type.
export type FileConnectorConfig = z.infer<typeof FileConnectorConfig>;
export type RssConnectorConfig = z.infer<typeof RssConnectorConfig>;
export type GithubQueryConnectorConfig = z.infer<typeof GithubQueryConnectorConfig>;
export type S3ConnectorConfig = z.infer<typeof S3ConnectorConfig>;
export type N8nWebhookConnectorConfig = z.infer<typeof N8nWebhookConnectorConfig>;

/**
 * Connector kinds NO user-facing route may create, update or test.
 *
 * `file` reads an arbitrary path on the fr-backend pod's own filesystem, so a
 * licensed caller could read `/proc/self/environ` (every secret fr holds)
 * through `POST /api/connectors/test-connection`. It has no live instance and
 * no legitimate user-facing producer, so it is refused at every user-writable
 * entry point rather than confined.
 */
export const USER_REFUSED_CONNECTOR_KINDS: ReadonlySet<string> = new Set(['file']);

/** Throws-free predicate: may a user-facing route accept this connector kind? */
export function isUserConfigurableConnectorKind(kind: unknown): boolean {
  return typeof kind === 'string' && !USER_REFUSED_CONNECTOR_KINDS.has(kind);
}

export const CONNECTOR_KINDS: readonly ConnectorKind[] = [
  'file',
  'rss',
  'github_query',
  's3',
  'n8n_webhook',
] as const;
