// fr-agui SPEC §13 P4b (part 3): the analytics route + action schemas, moved here
// verbatim from routes/tools/analytics.ts so the capability declarations
// (src/capabilities/tools/analytics.ts) share the SAME objects the route parses
// with and the `analytics.*` AG-UI actions validate with. Side-effect free: zod only
// (analytics.ts registers its actions at module load; this module must not).

import { z } from 'zod';

export const WINDOWS = ['24h', '7d', '30d', '90d'] as const;
export type Window = (typeof WINDOWS)[number];

export const DIMENSIONS = ['tool', 'outcome', 'project', 'initiator', 'channel'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const summaryInput = z
  .object({
    project_id: z.string().uuid().optional(),
    window: z.enum(WINDOWS).default('7d'),
    initiator: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    /**
     * Plan-4 Lane B: when `prev`, the response includes a `previous` block
     * sourced from the immediately-prior window of equal length. Headline
     * counters render ±delta and the sparkline overlays a dashed line.
     */
    compare: z.enum(['prev']).optional(),
  })
  .strip();
export type SummaryInput = z.infer<typeof summaryInput>;

export const kpiSchema = z.object({
  metric: z.string(),
  value: z.number(),
  sparkline: z.array(z.number()),
});

export const summaryOutput = z.object({
  data: z.object({
    window: z.enum(WINDOWS),
    project_id: z.string().nullable(),
    kpis: z.array(kpiSchema),
    previous: z
      .object({
        kpis: z.array(kpiSchema),
      })
      .nullable()
      .optional(),
  }),
  meta: z.object({
    last_tick_ts: z.string().nullable(),
    stale: z.boolean(),
    last_outcome: z.string().nullable(),
  }),
});

export const breakdownInput = z
  .object({
    project_id: z.string().uuid().optional(),
    window: z.enum(WINDOWS).default('7d'),
    dimension: z.enum(DIMENSIONS),
    metric: z.string().min(1),
    /** Plan-4 Lane B: include same buckets for the prior period. */
    compare: z.enum(['prev']).optional(),
  })
  .strip();
export type BreakdownInput = z.infer<typeof breakdownInput>;

// Pivoted breakdown bucket — `value` carries the requested metric (back-compat
// with the legacy single-metric shape) while `tokens` + `cost_usd` carry the
// parallel rollup-row aggregates so the drill-down table can render real
// numbers instead of 0-placeholders. tokens / cost_usd may be null when the
// underlying rollup rows are missing (legacy buckets, or upstream
// metering counters not yet emitting) — the FE renders "—" in that case.
export const bucketSchema = z.object({
  key: z.string(),
  value: z.number(),
  tokens: z.number().nullable(),
  cost_usd: z.number().nullable(),
});

export const breakdownOutput = z.object({
  data: z.object({
    dimension: z.enum(DIMENSIONS),
    metric: z.string(),
    buckets: z.array(bucketSchema),
    previous: z
      .object({ buckets: z.array(bucketSchema) })
      .nullable()
      .optional(),
  }),
  meta: z.object({ row_count: z.number() }),
});

export const exportInput = z
  .object({
    project_id: z.string().uuid().optional(),
    window: z.enum(WINDOWS).default('7d'),
    dimensions: z.array(z.enum(DIMENSIONS)).optional(),
  })
  .strip();
export type ExportInput = z.infer<typeof exportInput>;

// Plan-4 Lane B: per-channel notification send volumes. Sourced from the
// existing `notification_log` table — sends counted as rows whose
// `status` is one of {'sent','delivered'} (i.e. the channel actually
// dispatched). Failed/pending rows are excluded so the bar chart reflects
// outbound volume rather than queue depth.
export const perChannelInput = z
  .object({
    window: z.enum(WINDOWS).default('30d'),
    /**
     * Optional project scope. notification_log doesn't carry a project
     * column directly; we accept the param for API parity but do not
     * filter on it today (joining via approvals.entity_id is out of
     * scope for the polish slice).
     */
    project_id: z.string().uuid().optional(),
  })
  .strip();
export type PerChannelInput = z.infer<typeof perChannelInput>;

export const perChannelOutput = z.object({
  data: z.object({
    channels: z.array(
      z.object({
        kind: z.string(), // 'telegram' | 'teams' | 'email' | 'web' | 'inapp' | 'voice' | future
        sends: z.number(),
      }),
    ),
  }),
  meta: z.object({ window: z.enum(WINDOWS), row_count: z.number() }),
});

// Output for the export action — when invoked over AG-UI, agents receive the
// row payload (not a Response stream). The HTTP route serializes the same
// rows to CSV.
export const exportOutput = z.object({
  data: z.object({
    rows: z.array(
      z.object({
        bucket_ts: z.string(),
        metric_name: z.string(),
        initiator: z.string(),
        channel: z.string(),
        project_id: z.string().nullable(),
        value: z.number(),
      }),
    ),
  }),
  meta: z.object({ row_count: z.number() }),
});
