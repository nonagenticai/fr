// tests/unit/agui/start-again-every-channel.test.ts
//
// George 2026-10-30/31: web, Telegram and the fr MCP are EQUIVALENT — fr gates nothing as
// web-only. `projects.retry_conveyor_start` ("Start again", with `scope` project | phase) runs
// on every channel through the ONE path the web route runs (`runStartAgain`): on a channel there
// is no browser token, so the caller is the action's resolved member and the project WRITE lane
// (`loadTenantScopedProject`) decides, exactly as on the web.
//
// DB-backed (real CI postgres). The projects here stop before any upstream call: the write
// lane's own refusals (404 foreign, 409 archived) and the first project check after it prove the
// channel call reached the shared path as that member. That check asks requirements_management
// for the project (R345: fr keeps no RM id); the test runs it with fr's RM token unset, so the
// RM client refuses before sending (SERVICE_NOT_CONFIGURED, R351 (7)) — past the lane, no network.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { projectsRetryConveyorStartAction, startAgainAsCaller } from '../../../src/agui/actions/project-execution';
import type { ActionContext } from '../../../src/agui/types';
import type { ZodTypeAny } from 'zod';
import { db, projects, queryClient } from '../../../src/db/client';
import { withRequestContext } from '../../../src/middleware/request-context';
import { AppError } from '../../../src/utils/errors';
import { isIntegrationError } from '../../../src/integrations/_lib/errors';
import { REQUIREMENTS_SERVICE_TOKEN_ENV } from '../../../src/integrations/_lib/service-credential';
import { createDbSuite, dbReachable } from '../../integration/helpers/db-suite';

const sql = queryClient;
const TENANT = 'f3500000-0000-4000-8000-00000000000a';
const OTHER_TENANT = 'f3500000-0000-4000-8000-00000000000b';
const MEMBER = 'f3600000-0000-4000-8000-000000000001';
const ACTIVE = 'f3700000-0000-4000-8000-0000000000a1'; // no RM project yet
const ARCHIVED = 'f3700000-0000-4000-8000-0000000000a2';
const FOREIGN = 'f3700000-0000-4000-8000-0000000000a3'; // another tenant's
const ALL = [ACTIVE, ARCHIVED, FOREIGN];

beforeAll(async () => {
  if (!dbReachable) return;
  await sql`DELETE FROM projects WHERE id IN ${sql(ALL)}`;
  const row = (id: string, status: string, tenant: string) => ({
    id,
    owner_id: MEMBER,
    name: `start-again-${id.slice(-2)}`,
    dept_id: null,
    status,
    project_data: { keycloak_tenant_id: tenant },
  });
  await db.insert(projects).values([row(ACTIVE, 'active', TENANT), row(ARCHIVED, 'archived', TENANT), row(FOREIGN, 'active', OTHER_TENANT)]);
});

afterAll(async () => {
  if (!dbReachable) return;
  await sql`DELETE FROM projects WHERE id IN ${sql(ALL)}`;
});

const { itDb } = createDbSuite('start-again-every-channel');

/** A Telegram / MCP invocation: no browser token in the frame, an unbound context. */
function onChannel<T>(channel: string, fn: (ctx: ActionContext) => Promise<T>): Promise<T> {
  const ctx: ActionContext = { userId: MEMBER, projectId: null, correlationId: `start-again-${channel}`, initiator: 'human', channel, tenantId: TENANT };
  return withRequestContext(
    { correlationId: ctx.correlationId, initiator: 'human', channel, tenantId: TENANT, userId: MEMBER, activeTenantSource: 'jwt' },
    () => fn(ctx),
  );
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return { status: err.statusCode, code: err.code };
    if (isIntegrationError(err)) return { status: -1, code: err.code };
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('projects.retry_conveyor_start on every channel', () => {
  test('declared for every channel: not web-only, scope project | phase, rights decided by the write lane', () => {
    const a = projectsRetryConveyorStartAction;
    const input = a.input as ZodTypeAny;
    expect(a.webOnly).toBeUndefined();
    expect(a.rbac).toEqual({ type: 'public' });
    expect(input.safeParse({ project_id: ACTIVE, scope: 'project' }).success).toBe(true);
    expect(input.safeParse({ project_id: ACTIVE, scope: 'phase', phase: 'execution' }).success).toBe(true);
    expect(input.safeParse({ project_id: ACTIVE, scope: 'card' }).success).toBe(false);
  });

  for (const channel of ['telegram', 'mcp']) {
    itDb(`${channel}: a member's restart reaches the shared path (it asks RM for the project)`, async () => {
      const saved = process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
      delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
      try {
        expect(await refusal(onChannel(channel, (ctx) => startAgainAsCaller({ project_id: ACTIVE, scope: 'project' }, ctx)))).toEqual({
          status: -1,
          code: 'SERVICE_NOT_CONFIGURED',
        });
        // The start retry (no scope) takes the same path.
        expect(await refusal(onChannel(channel, (ctx) => startAgainAsCaller({ project_id: ACTIVE }, ctx)))).toMatchObject({
          code: 'SERVICE_NOT_CONFIGURED',
        });
      } finally {
        if (saved === undefined) delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
        else process.env[REQUIREMENTS_SERVICE_TOKEN_ENV] = saved;
      }
    });

    // With fr's RM token configured the same call is SENT to RM (the suite's RM host is unroutable,
    // so it fails reaching it). RM's own answer for a project it holds no pm_project for — 409
    // rm_project_missing — needs a live requirements_management (faking one is banned, owner ruling
    // 2026-10-29): this asserts the lookup is made, the 409 itself is verified live.
    itDb(`${channel}: with the RM token configured, the shared path asks RM (the request is sent)`, async () => {
      expect(process.env[REQUIREMENTS_SERVICE_TOKEN_ENV]).toBeTruthy();
      const out = await refusal(onChannel(channel, (ctx) => startAgainAsCaller({ project_id: ACTIVE, scope: 'project' }, ctx)));
      expect(out.status).toBe(-1);
      expect(out.code).toMatch(/^UPSTREAM_/);
    });

    itDb(`${channel}: the write lane refuses as on the web — another tenant's project 404, an archived one 409`, async () => {
      expect(await refusal(onChannel(channel, (ctx) => startAgainAsCaller({ project_id: FOREIGN, scope: 'project' }, ctx)))).toMatchObject({
        status: 404,
      });
      expect(
        await refusal(onChannel(channel, (ctx) => startAgainAsCaller({ project_id: ARCHIVED, scope: 'phase', phase: 'setup' }, ctx))),
      ).toMatchObject({ status: 409, code: 'project_archived' });
    });
  }
});
