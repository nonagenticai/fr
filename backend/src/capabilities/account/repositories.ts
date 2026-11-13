// fr-agui SPEC §13 P4b (part 3) — spec drain: the caller's repository CATALOGUE
// `/api/repositories` (routes/repositories.ts), re-expressed with NO behaviour
// change (`legacyHandler`). Attaching a catalogue row to a project
// (`/api/projects/:id/repositories…`: attach / detach / primary) is project-scoped
// and stays pinned (P2).
//
// Gate: validateAuth only (its doors): `isAuthenticatedUser`. Every row is keyed
// by the caller's id (`repositories.user_id`): another user's row is the same 404
// as an absent one. The platform-repo ownership gate (ruling 2026-09-30) refuses a
// url owned by a platform organisation for a non-platform request tenant (422
// `repo_access_denied`); it judges the INPUT, not the principal.
//
// `secret_id` is a REFERENCE to a stored secret (a uuid), never a secret value.
//
// 🔐 `url` may embed credentials (`https://user:token@host/…`): it is a declared
// secret on every input and output that carries it (as P4b part 2 marked
// worker_management's `base_url_override`). DECLARATION ONLY: the handlers are
// `legacyHandler`s and every row is agent-excluded, so the marking redacts nothing
// that is served — the caller's own catalogue answers its url as stored.
import { z } from 'zod';

import { RepositoryCreateSchema, RepositoryUpdateSchema } from '../../types/api';
import { isAuthenticatedUser } from '../rbac-rules';
import { isoTime, pathId, routeRule, settingsCapabilities, standardResponses } from './_shared';

/** A `repositories` row as `jsonResponse` serialises it. */
const repository = z.object({
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  url: z.string().describe('🔐 SECRET (a URL can embed credentials). The repository clone URL, as stored.'),
  branch: z.string().nullable(),
  path: z.string().nullable(),
  description: z.string().nullable(),
  secret_id: z.string().nullable().describe('A reference (uuid) to a stored secret, not its value.'),
  container_name: z.string().nullable().describe('Set once the repository is provisioned to the coding gateway.'),
  created_at: isoTime,
  updated_at: isoTime,
});

/** 🔐 The body's `url` and the answered row's `url`. */
const URL_IN_AND_OUT = { input: ['/url'], output: ['/url'] };

const id = z.object({ id: pathId('Repository id (uuid)') });
const NOT_FOUND = "404: `error` 'Repository not found' (absent, another user's, or not a uuid). ";
const BODY =
  "422: `error` 'Validation error' (the body fails the schema; `details`), or `error` 'repo_access_denied' (`message`, " +
  "`items`: a platform organisation's repository, refused for this workspace). 400: `error` 'invalid JSON body'. " +
  "500 also when the caller's catalogue already holds this `url` (the unique (user, url) index; not mapped to a 409). ";

export const REPOSITORY_CAPABILITIES = settingsCapabilities(
  {
    area: 'repositories', tag: 'Repositories', tenancy: 'self',
    module: 'src/routes/repositories.ts', load: () => import('../../routes/repositories'),
    rule: routeRule(isAuthenticatedUser),
  },
  [
    {
      id: 'repositories.list', method: 'GET', path: '/api/repositories', handler: 'handleListRepositories',
      summary: "The caller's repository catalogue", effect: 'read',
      input: z.object({
        onboarded_to: z.string().optional().describe("'coding': only repositories provisioned to the coding gateway (any other value filters nothing)."),
      }),
      output: z.object({ items: z.array(repository), total: z.number().int() }),
      responses: standardResponses(),
      secrets: { output: ['/items/url'] },
    },
    {
      id: 'repositories.create', method: 'POST', path: '/api/repositories', handler: 'handleCreateRepository',
      summary: "Add a repository to the caller's catalogue", effect: 'write', successStatus: 201,
      input: RepositoryCreateSchema, output: repository, responses: standardResponses(BODY),
      secrets: URL_IN_AND_OUT,
    },
    {
      id: 'repositories.get', method: 'GET', path: '/api/repositories/:id', handler: 'handleGetRepository',
      summary: "One repository of the caller's catalogue", effect: 'read',
      input: id, output: repository, responses: standardResponses(NOT_FOUND),
      secrets: { output: ['/url'] },
    },
    {
      id: 'repositories.update', method: 'PUT', path: '/api/repositories/:id', handler: 'handleUpdateRepository',
      summary: "Update a repository of the caller's catalogue (only the fields given)", effect: 'write',
      description: 'A new `url` is also checked against every project the row is attached to (422 repo_access_denied).',
      input: RepositoryUpdateSchema.extend(id.shape), output: repository, responses: standardResponses(NOT_FOUND + BODY),
      secrets: URL_IN_AND_OUT,
    },
    {
      id: 'repositories.delete', method: 'DELETE', path: '/api/repositories/:id', handler: 'handleDeleteRepository',
      summary: "Remove a repository from the caller's catalogue", effect: 'destructive', successStatus: 204,
      input: id, output: z.null(), responses: standardResponses(NOT_FOUND),
    },
  ],
);
