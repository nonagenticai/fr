// GET /api/projects/:id/conveyor-history — the project page's record of what the conveyor did
// (asks + answers, cards + comment timelines, pull requests). A project READ (`loadProjectForRead`),
// out-of-agent-scope like the cockpit it sits beside.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import type { Capability } from '../define';
import { isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { standardResponses } from '../account/_shared';
import { pathId, routeRule, settingsCapabilities } from '../settings/_shared';
import { blockOf } from '../observe/_shared';

const rule = routeRule(isAuthenticatedUserInResolvedTenant);

export const PROJECT_CONVEYOR_HISTORY_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  {
    area: 'projects',
    tag: 'Projects',
    tenancy: 'project',
    rule,
    module: 'src/routes/project-conveyor-history.ts',
    load: () => import('../../routes/project-conveyor-history'),
  },
  [
    {
      id: 'projects.get_conveyor_history', method: 'GET', path: '/api/projects/:id/conveyor-history',
      handler: 'handleGetProjectConveyorHistory', effect: 'read',
      summary: "What the conveyor did on a project: its asks and sign-offs, every card's comment timeline, and the pull requests named there",
      description:
        '`data` holds three read-model blocks. `conversation`: the conveyor asks fr holds for the project (approvals with ' +
        "source n8n, tenant-pinned), newest first, each with its decision, answer and decider. `cards`: every card on the " +
        "project's board (DONE included) with list, card type, last move and its Planka comments newest first (JSON blocks " +
        'folded into `data`). `delivered`: GitHub pull-request URLs found in the card comments, with the branch the card ' +
        'names and the PR state when GitHub answers (`state_unavailable` says why when not). A source that fails makes ' +
        'its own block `meta.available:false` with a reason, never an empty list. The PR state is looked up only for ' +
        "a PR in one of the project's own linked repositories; any other is listed with `state_unavailable` " +
        "'state not checked: not a project repository'. A project with no RM link (not run by the conveyor) answers " +
        "`data: { applicable: false, reason: 'not_a_conveyor_project', message }` and nothing is read.",
      input: z.object({ id: pathId('Project id (a uuid; a malformed id is the same 404 as an absent project)') }),
      output: z.object({
        data: z.discriminatedUnion('applicable', [
          z.object({
            applicable: z.literal(true),
            conversation: blockOf(z.object({ entries: z.array(z.unknown()) })),
            cards: blockOf(z.object({ cards: z.array(z.unknown()) })),
            delivered: blockOf(z.object({ pull_requests: z.array(z.unknown()) })),
          }),
          z.object({
            applicable: z.literal(false),
            reason: z.literal('not_a_conveyor_project'),
            message: z.string(),
          }),
        ]),
      }),
      responses: standardResponses(
        "404: `error` 'Project not found' (absent, malformed id, or not readable in the request tenant). ",
      ),
    },
  ],
);
