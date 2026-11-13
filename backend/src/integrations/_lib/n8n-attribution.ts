// src/integrations/_lib/n8n-attribution.ts
//
// Per-project / per-member attribution for fr → n8n webhook dispatch.
//
// CONTRACT (ATTRIBUTION-PLAN.md § THE CONTRACT, fixed 2026-09-28):
//   - wire headers `X-Project-Id` (fr project uuid) and `X-Actor-Id` (the
//     acting member's uuid). OMIT when absent. Never a placeholder.
//   - body / item fields `project_id` and `actor_id` (NOT member_id: billing's
//     column is `billing_cost_events.actor_id`).
//
// Both n8n dispatch seams (`integrations/n8n.ts triggerWorkflow` and
// `services/n8n.ts N8nClient.callWebhook`) are raw `fetch` calls, so neither
// gets the X-Project-Id that `http-client.ts buildHeaders` adds to every other
// outbound call. n8n webhooks expose headers only under `$json.headers`, so the
// same values are also merged into the JSON body — without ever overwriting a
// field the caller set.
//
// ACTOR VALUE: the Keycloak `sub` of the acting user. That is what fr's
// request context carries as `userId` (middleware/request-context.ts
// `userIdFromClaims` → `claims.sub`), what the AG-UI `ActionContext.userId` is
// (routes/agui.ts `{ userId: sub, ... }`), what `User.id` is
// (services/keycloak.ts `claims.sub`), and what the tenant billing page
// resolves `actor_id` against (routes/tenant/billing.ts `resolveAll` →
// `keycloak.resolveUsers`). One identity, no mapping layer.
//
// PROJECT VALUE: an explicit id the dispatch seam was handed for THIS dispatch
// (triggerWorkflow's `opts.projectId`, the id fr itself records on
// `n8n_execution_mapping`), otherwise the guard-validated request-context value
// (`getProjectId()`, which only `lib/project-owner-guard.ts guardProjectId()`
// may set). A raw inbound header/body value is never trusted here.

import { isUuidShape } from '../../lib/uuid-shape';
import { getProjectId, getUserId } from './context';

export interface N8nAttribution {
  projectId?: string;
  actorId?: string;
}

/**
 * Explicit attribution a caller can hand the dispatch seam. A key that is
 * PRESENT (even with an invalid value) suppresses the request-context
 * fallback for that field: a dispatch about project A must never borrow the
 * request's project B just because A was malformed.
 */
export interface N8nAttributionInput {
  projectId?: string | null;
  actorId?: string | null;
}

/**
 * The all-zero-prefix family: the nil uuid and the billing sentinels
 * (`UNATTRIBUTED_PROJECT_ID` …0004, `UNATTRIBUTED_ACTOR_ID` …0005 in
 * integrations/metering/usage.ts). These are placeholders, and the contract
 * forbids sending one — an absent id must stay absent so the downstream
 * "unattributed" bucket is computed, not forged.
 */
const PLACEHOLDER_PREFIX = '00000000-0000-0000-0000-';

/** A real uuid, lower-cased, or undefined. Pure. */
export function attributableUuid(value: unknown): string | undefined {
  if (!isUuidShape(value)) return undefined;
  const v = value.toLowerCase();
  if (v.startsWith(PLACEHOLDER_PREFIX)) return undefined;
  return v;
}

function pick(
  explicit: N8nAttributionInput,
  key: keyof N8nAttributionInput,
  fallback: () => string | undefined,
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(explicit, key) && explicit[key] !== undefined) {
    return attributableUuid(explicit[key]);
  }
  return attributableUuid(fallback());
}

/** Resolve the ids to send: explicit first, else the request context. */
export function resolveN8nAttribution(explicit: N8nAttributionInput = {}): N8nAttribution {
  const out: N8nAttribution = {};
  const projectId = pick(explicit, 'projectId', getProjectId);
  const actorId = pick(explicit, 'actorId', getUserId);
  if (projectId) out.projectId = projectId;
  if (actorId) out.actorId = actorId;
  return out;
}

/** Wire headers for the resolved ids; a missing id produces no header. */
export function n8nAttributionHeaders(attr: N8nAttribution): Record<string, string> {
  const h: Record<string, string> = {};
  if (attr.projectId) h['x-project-id'] = attr.projectId;
  if (attr.actorId) h['x-actor-id'] = attr.actorId;
  return h;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Object.prototype.toString.call(v) === '[object Object]';
}

/**
 * Merge `project_id` / `actor_id` into a plain-object JSON body. A field the
 * caller already set (any value other than `undefined`, including null) is
 * left untouched. Non-object bodies (arrays, strings, null) are returned as-is:
 * there is no field to merge into without changing their shape.
 */
export function withN8nAttributionBody(payload: unknown, attr: N8nAttribution): unknown {
  if (!isPlainObject(payload)) return payload;
  const add: Record<string, string> = {};
  if (attr.projectId && payload.project_id === undefined) add.project_id = attr.projectId;
  if (attr.actorId && payload.actor_id === undefined) add.actor_id = attr.actorId;
  return Object.keys(add).length === 0 ? payload : { ...payload, ...add };
}
