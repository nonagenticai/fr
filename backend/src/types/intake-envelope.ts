// src/types/intake-envelope.ts
// Spec 2 Plan 2-B: webhook envelope POSTed by fr-backend cron tick to operator-built
// n8n workflows. The n8n `scheduled-intake-actions` package consumes this shape.
// `deriveIdempotencyKey` is the shared derivation helper — both the cron tick and
// any receiver-side dedup logic must call this to stay aligned.
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const IntakeEnvelope = z.object({
  idempotency_key: z.string().length(64), // sha256 hex
  source: z.object({
    kind: z.string(),
    trigger_id: z.string().uuid(),
    fetched_at: z.string().datetime(),
  }),
  mapped: z.record(z.string(), z.unknown()),
  raw_record_id: z.string(), // stable id from source (rss guid, github node_id, s3 etag, etc.)
});

export type IntakeEnvelope = z.infer<typeof IntakeEnvelope>;

export function deriveIdempotencyKey(args: {
  trigger_id: string;
  connector_kind: string;
  stable_record_id: string;
}): string {
  return createHash('sha256')
    .update(`${args.trigger_id}:${args.connector_kind}:${args.stable_record_id}`)
    .digest('hex');
}
