// src/routes/scheduled-triggers-schemas.ts
//
// The scheduled_triggers request bodies, shared by the routes
// (routes/scheduled-triggers.ts, routes/assets/internal-create.ts through
// scheduled-triggers-shared.ts) and their fr-agui P4b capability declarations
// (capabilities/schedules/scheduled-triggers.ts), so the declared input IS the
// route's. Side-effect free (zod only): the declarations import this with no
// environment.
import { z } from 'zod';

export const SourceConnectorEnum = z.enum([
  'file',
  's3',
  'rss',
  'imap',
  'github_query',
  'n8n_webhook',
]);

export const CardTemplateSchema = z.object({
  card_type: z.string().min(1),
  labels: z.array(z.string()).optional(),
  custom_fields: z.record(z.unknown()).optional(),
});

export const ScheduledTriggerCreateSchema = z
  .object({
    project_id: z.string().uuid(),
    name: z.string().min(1).max(256),
    cron: z.string().min(1),
    timezone: z.string().min(1).default('UTC'),
    source_connector: SourceConnectorEnum,
    connector_config: z.record(z.unknown()),
    payload_mapper: z.record(z.string()),
    target_list: z.string().min(1).default('INBOX'),
    card_template: CardTemplateSchema,
    enabled: z.boolean().default(true),
  })
  .strict();

export type ScheduledTriggerCreateInput = z.infer<typeof ScheduledTriggerCreateSchema>;

/** PATCH /api/scheduled-triggers/:id — `project_id` / `tenant_id` / `id` are refused (422 immutable_field) before this parse. */
export const ScheduledTriggerPatchSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    cron: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
    connector_config: z.record(z.unknown()).optional(),
    payload_mapper: z.record(z.string()).optional(),
    target_list: z.string().min(1).optional(),
    card_template: CardTemplateSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
