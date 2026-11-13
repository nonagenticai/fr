// fr-agui SPEC §13 P4b (part 2) — spec drain: the Suggestion Inbox actions
// (routes/suggested-schedules.ts) `POST /api/suggested-schedules/:id/accept` and
// `…/dismiss`, re-expressed with NO behaviour change (`legacyHandler`).
//
// Both are keyed by the suggestion id: `isAuthenticatedUserInResolvedTenant`
// (ctxTenantId before the store), then the row must be the request tenant's (404)
// and the per-row dept gate (accept: dept-manager, dismiss: dept-member).
//
// NOT here: `GET /api/projects/:projectId/suggested-schedules` (project-scoped; P4d-2a,
// capabilities/projects/project-routes.ts) and `POST /api/internal/suggested-schedules` (P1b).
import { z } from 'zod';

import { isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { DOOR_403, VALIDATE_AUTH_401, pathId, routeRule, settingsCapabilities, unauthorizedBody } from '../settings/_shared';
import { NO_TENANT_500, RESOURCE_403, fr4xxBody, isoTime } from './_shared';
import { scheduledTrigger } from './scheduled-triggers';

const id = z.object({ id: pathId('Suggested schedule id (a uuid; anything else is the same 404 as an absent row)') });

export const suggestion = z.object({
  id: z.string(),
  tenant_id: z.string(),
  project_id: z.string(),
  user_id: z.string().nullable(),
  source: z.enum(['manual', 'heuristic']),
  ad_hoc_summary: z.string(),
  payload: z.record(z.unknown()),
  status: z.enum(['new', 'accepted', 'dismissed']),
  promoted_trigger_id: z.string().nullable(),
  created_at: isoTime,
  updated_at: isoTime,
});

const NOT_FOUND = "404: `error` 'Suggested schedule not found' (absent, malformed id, another tenant's, or its project is gone).";

export const SUGGESTED_SCHEDULE_CAPABILITIES = settingsCapabilities(
  {
    area: 'suggested_schedules', tag: 'Suggested Schedules', tenancy: 'tenant',
    module: 'src/routes/suggested-schedules.ts', load: () => import('../../routes/suggested-schedules'),
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
  },
  [
    {
      id: 'suggested_schedules.accept', method: 'POST', path: '/api/suggested-schedules/:id/accept', handler: 'handleAcceptSuggestedSchedule',
      summary: 'Promote a suggested schedule into a scheduled trigger', effect: 'write', successStatus: 201,
      description:
        "Atomic: creates the trigger from the suggestion's `payload.suggested_*` fields and marks the suggestion accepted. " +
        'Only a `new` suggestion on a continuous-flow project can be accepted. Takes no body. Answers the NEW trigger.',
      input: id, output: scheduledTrigger,
      responses: [
        { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
        {
          status: 'default',
          description:
            `${NOT_FOUND} ${RESOURCE_403} ` +
            "422: `error` 'scheduled_intake triggers require project.shape = continuous_flow' (`details.code` shape_mismatch), or " +
            "'Validation error' (the stored payload is not a promotable trigger; `details`). 409: `error` \"suggestion is in status '…'\" / " +
            "'suggestion was concurrently resolved' (`details.code` already_resolved). 400: the payload's cron / connector / mapper is " +
            `invalid. ${DOOR_403} ${NO_TENANT_500}`,
          schema: fr4xxBody,
        },
      ],
    },
    {
      id: 'suggested_schedules.dismiss', method: 'POST', path: '/api/suggested-schedules/:id/dismiss', handler: 'handleDismissSuggestedSchedule',
      summary: 'Dismiss a suggested schedule (idempotent)', effect: 'write',
      description: 'Takes no body. A dismissed suggestion is answered unchanged; an accepted one is refused (409).',
      input: id, output: suggestion,
      responses: [
        { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
        {
          status: 'default',
          description:
            `${NOT_FOUND} ${RESOURCE_403} 409: \`error\` 'cannot dismiss an accepted suggestion' (\`details.code\` already_resolved). ` +
            `${DOOR_403} ${NO_TENANT_500}`,
          schema: fr4xxBody,
        },
      ],
    },
  ],
);

