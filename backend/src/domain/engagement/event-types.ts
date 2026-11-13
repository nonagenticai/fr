// src/domain/engagement/event-types.ts
//
// WS1 Phase 1A — single source of truth for the project-execution notification
// taxonomy. Consumed by:
//   * the inbound webhook validator (routes/webhooks/execution-events.ts),
//   * the preference default + matrix builder (notification-prefs.ts),
//   * the frontend prefs UI labels (mirrored in frontend/src/lib/api/notifications.ts).
//
// These are NON-APPROVAL events. Approvals keep their own path
// (approvals + fanOutToUser) and are deliberately absent here.
//
// Cheap to extend (add a row); costly to rename (it's the contract the n8n AA
// pipeline encodes in its POST bodies). Treat the string keys as stable.
import { z } from 'zod';

export const ExecutionEventTypeSchema = z.enum([
  'card.done',
  'card.blocked',
  'card.failed',
  'pr.opened',
  'pr.merged',
  'outcome.regression',
  'outcome.improvement',
  // billing_service budget threshold crossing (50/80/100%). Emitted by the
  // budget-alert webhook receiver, not the n8n AA pipeline. Default severity
  // 'warning' → external channels default ON (defaultChannelEnabled); the
  // receiver overrides to 'error' at 100%.
  'budget.threshold',
  // U2 — a durable report artifact (project_reports) is ready to read. Written
  // by the report webhook (services/reports/bug-report.ts) in the SAME
  // transaction as the report row; link `/reports/<id>`. 'info' → inbox-only by
  // default (external channels are opt-in per the matrix).
  'report.ready',
  // R311 PR 5 (kanban-coach-errors.md §2.5 / §4.1) — the conveyor's two failure
  // callbacks (routes/webhooks/conveyor-failures.ts), fanned out to EVERY member of
  // the project's tenant (George 2026-10-15). 'error' → external channels default
  // ON (Telegram is the live channel). Record-and-show only: fr decides nothing.
  'project.start_failed',
  'project.coach_failed',
]);
export type ExecutionEventType = z.infer<typeof ExecutionEventTypeSchema>;
export const EXECUTION_EVENT_TYPES = ExecutionEventTypeSchema.options;

export const SeveritySchema = z.enum(['info', 'success', 'warning', 'error']);
export type Severity = z.infer<typeof SeveritySchema>;

// The external delivery channels a user can route events to. `inapp` is NOT
// here on purpose: the durable `notifications` inbox row is ALWAYS written
// (the baseline surface), so it is not a toggleable channel. `telegram` is the
// live comms hub.
export const NOTIFICATION_CHANNELS = ['email', 'telegram', 'teams', 'websocket', 'mcp'] as const;
export type NotificationChannelName = (typeof NOTIFICATION_CHANNELS)[number];

interface EventTypeDef {
  /** Default severity stamped on the inbox row when the caller omits one. */
  severity: Severity;
  /** Human label for the prefs matrix + inbox rendering. */
  label: string;
}

export const EVENT_TYPE_DEFS: Record<ExecutionEventType, EventTypeDef> = {
  'card.done': { severity: 'success', label: 'Card completed' },
  'card.blocked': { severity: 'warning', label: 'Card blocked' },
  'card.failed': { severity: 'error', label: 'Card failed' },
  'pr.opened': { severity: 'info', label: 'PR opened' },
  'pr.merged': { severity: 'success', label: 'PR merged' },
  'outcome.regression': { severity: 'error', label: 'Regression detected' },
  'outcome.improvement': { severity: 'success', label: 'Improvement detected' },
  'budget.threshold': { severity: 'warning', label: 'Budget alert' },
  'report.ready': { severity: 'info', label: 'Report ready' },
  'project.start_failed': { severity: 'error', label: 'Conveyor start failed' },
  'project.coach_failed': { severity: 'error', label: 'Kanban coach could not act' },
};

// Fallback for an event type with no registry entry. `event_type` is a plain
// `text` column (not a PG enum), so a row written by an older/newer deploy — or
// a retired type — can carry a value that is not in EVENT_TYPE_DEFS. Indexing it
// unguarded returned `undefined` and threw `TypeError: Cannot read properties of
// undefined`, and that throw escaped through `fanOutEventToUser`, whose contract
// is documented as "Never throws". Degrade to inbox-only instead.
const FALLBACK_DEF: { severity: Severity } = { severity: 'info' };

/** Default severity for an event type (used when the webhook omits `severity`). */
export function defaultSeverity(eventType: ExecutionEventType): Severity {
  return (EVENT_TYPE_DEFS[eventType] ?? FALLBACK_DEF).severity;
}

/**
 * Smart default for the (event_type × channel) matrix, applied when a user has
 * no explicit `notification_prefs` row for that cell:
 *
 *   external channels are ON only for error/warning-severity events.
 *
 * So `card.failed` / `card.blocked` / `outcome.regression` default to
 * delivering on every configured channel, while `card.done` / `pr.*` /
 * `outcome.improvement` are inbox-only until the user opts in. The inbox row
 * itself is always written and is not governed by this function.
 */
export function defaultChannelEnabled(
  eventType: ExecutionEventType,
  _channel: NotificationChannelName,
): boolean {
  const sev = (EVENT_TYPE_DEFS[eventType] ?? FALLBACK_DEF).severity;
  return sev === 'error' || sev === 'warning';
}
