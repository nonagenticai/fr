// tests/unit/db/project-delivered.test.ts
//
// services/project-delivered.ts against the real CI postgres. Three invariants:
//
//  1. `deliveryFromRm` is PURE and derives RM's closure: a closed RM project
//     reads `delivered` (with RM's `updated_at` and the evidence pair); open,
//     unreadable and non-live rows read as stored. ⛔ These are PURE-FUNCTION
//     tests. The route's "GET never writes" property (D-run12-9) is
//     deliberately NOT tested here, or anywhere in CI: it needs a CLOSED RM
//     state, which needs a live requirements_management, and faking one is
//     banned (backend/CLAUDE.md, owner ruling 2026-10-29). It is verified
//     LIVE. The missing coverage is ACCEPTED, not an oversight — and do NOT
//     "restore" it by asserting row equality around `deliveryFromRm`: a pure
//     function cannot write, so that assertion can never fail and cannot catch
//     a write re-introduced in the route;
//  2. `stampDeliveryIfRmClosed` — owned by the reconcile worker, never a read —
//     is what frees a repository's ONE live bug_hunt slot. The partial unique
//     index `projects_one_live_bug_hunt_per_repo_idx` excludes only a STORED
//     'delivered', so without that stamp a delivered hunt blocks every later
//     hunt on its repo with a permanent 409 `bug_hunt_project_exists`;
//  3. the stamp stores EXACTLY what the read derives, so a client polling the
//     API sees no jump when the worker stamps: `delivered_at` is RM's
//     `updated_at` on the closed row, and NULL when RM reports none.
//
// No RM test double: `rm()` is the domain input `ProjectStateOrError` these
// functions take — an upstream state, not a replaced transport.
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db, projects } from '../../../src/db/client';
import { projectDeliverables } from '../../../src/db/schema';
import type { ProjectStateOrError } from '../../../src/services/catalogue/project-state';
import {
  deliveryFromRm,
  listProjectDeliverables,
  stampDeliveryIfRmClosed,
} from '../../../src/services/project-delivered';
import { projectsGetHandler } from '../../../src/agui/actions/projects-read';
import {
  assertNoLiveBugHuntProject,
  isBugHuntUniqueViolation,
  ProjectCreateError,
} from '../../../src/routes/projects';

const OWNER = '55555555-5555-4555-8555-555555555555';

/**
 * The domain input: RM's state for a project. `updatedAt` is RM's
 * `pm.updated_at` — a CLOSED pm_project's closure time, which is what the read
 * and the stamp must report as `delivered_at`.
 */
function rm(status: string | null, updatedAt: string | null = '2026-10-31T09:00:00Z') {
  return {
    ok: true as const,
    state: {
      projectId: 'x',
      tenantId: OWNER,
      rmPmProjectId: 'rm-1',
      projectTypeId: null,
      projectType: 'it',
      phase: 'execution',
      phaseId: null,
      phaseUpdatedAt: null,
      priority: null,
      pm: { status, updated_at: updatedAt } as never,
    },
  } satisfies ProjectStateOrError;
}

let projectId: string;

async function load(id: string) {
  const [r] = await db.select().from(projects).where(eq(projects.id, id));
  return r!;
}

beforeEach(async () => {
  const [p] = await db
    .insert(projects)
    .values({ owner_id: OWNER, name: 'delivered-test', status: 'active' })
    .returning({ id: projects.id });
  projectId = p!.id;
});

afterEach(async () => {
  // Cascades to project_deliverables (FK onDelete: cascade).
  await db.delete(projects).where(eq(projects.owner_id, OWNER));
});

// ⛔ NO ROUTE TEST HERE, DELIBERATELY (deleted 2026-10-31). A test that calls
// `handleGetProject` with an injected CLOSED RM state was a test-only seam in
// `src/` — banned outright by backend/CLAUDE.md (owner ruling 2026-10-29). The
// property it asserted, "a GET never writes" (D-run12-9), therefore has NO CI
// test. It needs a live requirements_management, so it can only be checked live,
// AFTER this ships: read a project twice as a read-only caller against the
// deployed build and confirm `updated_at` does not move. ⛔ That check is NOT
// yet done — this comment is a plan, not evidence. The coverage drop is
// accepted. The tests below are pure-function tests of the derivation, which is
// all CI can honestly own.
describe('deliveryFromRm — the derivation itself (pure function)', () => {
  test('a closed RM project derives delivered from RM, not from the row', () => {
    const out = deliveryFromRm(
      { status: 'active', delivered_at: null, delivery_evidence: null },
      rm('closed').state,
    );
    expect(out.status).toBe('delivered');
    expect(out.delivered_at!.toISOString()).toBe('2026-10-31T09:00:00.000Z');
    expect(out.delivery_evidence).toEqual({ source: 'rm_project_closed', rm_pm_project_id: 'rm-1', phase: 'execution' });
  });

  test('RM open, unreadable, or a non-live project reads as stored', () => {
    expect(deliveryFromRm({ status: 'active' }, rm('active').state).status).toBe('active');
    expect(deliveryFromRm({ status: 'active' }, undefined).status).toBe('active');
    expect(deliveryFromRm({ status: 'failed' }, rm('closed').state).status).toBe('failed');
    expect(deliveryFromRm({ status: 'archived' }, rm('closed').state).status).toBe('archived');
    const kept = deliveryFromRm(
      { status: 'delivered', delivered_at: '2026-10-30T12:00:00Z', delivery_evidence: { source: 'x' } },
      undefined,
    );
    expect(kept.delivered_at!.toISOString()).toBe('2026-10-30T12:00:00.000Z');
    expect(kept.delivery_evidence).toEqual({ source: 'x' });
  });
});

describe('listProjectDeliverables', () => {
  test('lists customer deliverables in position order, not intermediates', async () => {
    await db.insert(projectDeliverables).values([
      { project_id: projectId, position: 2, kind: 'deliverable', title: 'Second' },
      { project_id: projectId, position: 1, kind: 'deliverable', title: 'First' },
      { project_id: projectId, position: 0, kind: 'intermediate', title: 'Scaffold' },
    ]);
    expect(await listProjectDeliverables(projectId)).toEqual([{ title: 'First' }, { title: 'Second' }]);
  });

  test('a url only when the row names a repository fr can resolve — never a guess', async () => {
    // `repos` is verbatim outline attribution (migration 151), so every shape reaches here.
    await db.insert(projectDeliverables).values([
      { project_id: projectId, position: 0, kind: 'deliverable', title: 'Https', repos: ['https://github.com/acme/api'] },
      { project_id: projectId, position: 1, kind: 'deliverable', title: 'Slug', repos: ['acme/worker'] },
      { project_id: projectId, position: 2, kind: 'deliverable', title: 'Scp', repos: ['git@github.com:acme/cli.git'] },
      { project_id: projectId, position: 3, kind: 'deliverable', title: 'Unattributed', repos: null },
      { project_id: projectId, position: 4, kind: 'deliverable', title: 'Unrecognised', repos: ['not a repo'] },
    ]);
    expect(await listProjectDeliverables(projectId)).toEqual([
      { title: 'Https', url: 'https://github.com/acme/api' },
      { title: 'Slug', url: 'https://github.com/acme/worker' },
      { title: 'Scp', url: 'https://github.com/acme/cli' },
      { title: 'Unattributed' },
      { title: 'Unrecognised' },
    ]);
  });
});

describe('stampDeliveryIfRmClosed — a stored delivered frees the repo bug_hunt slot', () => {
  const REPO = 'https://example.test/delivered-slot.git';
  const HUNT_TENANT = '55555555-5555-4555-8555-5555555555bb';

  function hunt(name: string) {
    return {
      owner_id: OWNER,
      name,
      status: 'active',
      repository_url: REPO,
      project_type: 'it',
      project_data: { bug_hunt: 'true', keycloak_tenant_id: HUNT_TENANT },
    };
  }

  test('after the stamp the SAME repo accepts a second bug_hunt project', async () => {
    const [first] = await db.insert(projects).values(hunt('hunt-1')).returning({ id: projects.id });

    // POSITIVE CONTROL — the index is live in CI and it is OUR index that
    // blocks, so the assertion below cannot pass vacuously.
    let blocked: unknown;
    try {
      await db.insert(projects).values(hunt('hunt-2'));
    } catch (err) {
      blocked = err;
    }
    expect(isBugHuntUniqueViolation(blocked)).toBe(true);

    // The route guard refuses too while the hunt is stored live.
    let refused = false;
    try {
      await assertNoLiveBugHuntProject({ repositoryUrl: REPO, tenantId: HUNT_TENANT });
    } catch (err) {
      refused = err instanceof ProjectCreateError && err.httpStatus === 409;
    }
    expect(refused).toBe(true);

    expect(await stampDeliveryIfRmClosed({ id: first!.id, status: 'active' }, rm('closed'))).toBe(true);
    expect((await load(first!.id)).status).toBe('delivered');

    // The guarantee the audit says the no-write PR broke: the slot is free.
    await assertNoLiveBugHuntProject({ repositoryUrl: REPO, tenantId: HUNT_TENANT });
    const [second] = await db.insert(projects).values(hunt('hunt-2')).returning({ id: projects.id });
    expect(second!.id).not.toBe(first!.id);
  });

  test('two concurrent stamps deliver the project exactly once (self-guarded UPDATE)', async () => {
    const [p] = await db.insert(projects).values(hunt('hunt-race')).returning({ id: projects.id });
    const results = await Promise.all([
      stampDeliveryIfRmClosed({ id: p!.id, status: 'active' }, rm('closed')),
      stampDeliveryIfRmClosed({ id: p!.id, status: 'active' }, rm('closed')),
    ]);
    expect(results.filter(Boolean).length).toBe(1);
    expect((await load(p!.id)).status).toBe('delivered');
  });
});

describe('stampDeliveryIfRmClosed — who must NOT be stamped', () => {
  test('a failed project is never stamped delivered by a later RM closure', async () => {
    const [failed] = await db
      .insert(projects)
      .values({ owner_id: OWNER, name: 'failed-test', status: 'failed' })
      .returning({ id: projects.id });
    expect(await stampDeliveryIfRmClosed({ id: failed!.id, status: 'failed' }, rm('closed'))).toBe(false);
    const after = await load(failed!.id);
    expect(after.status).toBe('failed');
    expect(after.delivered_at).toBeNull();
  });

  test('an open or unreadable RM state is not stamped', async () => {
    const [p] = await db
      .insert(projects)
      .values({ owner_id: OWNER, name: 'open-test', status: 'active' })
      .returning({ id: projects.id });
    expect(await stampDeliveryIfRmClosed({ id: p!.id, status: 'active' }, rm('active'))).toBe(false);
    expect(await stampDeliveryIfRmClosed({ id: p!.id, status: 'active' }, undefined)).toBe(false);
    expect(
      await stampDeliveryIfRmClosed(
        { id: p!.id, status: 'active' },
        { ok: false, code: 'RM_UNREACHABLE', message: 'unreachable' },
      ),
    ).toBe(false);
    const after = await load(p!.id);
    expect(after.status).toBe('active');
    expect(after.delivered_at).toBeNull();
  });
});

describe('stampDeliveryIfRmClosed stores exactly what the read derives (no delivered_at drift)', () => {
  test('RM reports a timestamp: stored delivered_at IS that timestamp, as the read reports it', async () => {
    const [p] = await db
      .insert(projects)
      .values({ owner_id: OWNER, name: 'agree-timestamp', status: 'active' })
      .returning({ id: projects.id });
    const derivedBefore = deliveryFromRm(await load(p!.id), rm('closed', '2026-10-31T09:00:00Z').state);

    expect(await stampDeliveryIfRmClosed({ id: p!.id, status: 'active' }, rm('closed', '2026-10-31T09:00:00Z'))).toBe(true);

    const stored = await load(p!.id);
    expect(stored.status).toBe(derivedBefore.status);
    expect(stored.delivered_at!.toISOString()).toBe(derivedBefore.delivered_at!.toISOString());
    expect(stored.delivery_evidence).toEqual(derivedBefore.delivery_evidence);
    // …and the READ still derives the same value from the stamped row.
    expect(deliveryFromRm(stored, rm('closed', '2026-10-31T09:00:00Z').state)).toEqual({
      status: 'delivered',
      delivered_at: new Date('2026-10-31T09:00:00Z'),
      delivery_evidence: { source: 'rm_project_closed', rm_pm_project_id: 'rm-1', phase: 'execution' },
    });
  });

  test('RM reports no timestamp: both the read and the stamp say NULL (never `now`)', async () => {
    const [p] = await db
      .insert(projects)
      .values({ owner_id: OWNER, name: 'agree-no-timestamp', status: 'active' })
      .returning({ id: projects.id });
    const derivedBefore = deliveryFromRm(await load(p!.id), rm('closed', null).state);
    expect(derivedBefore.delivered_at).toBeNull();
    // The record is a PAIR (migration 173 CHECK): no timestamp ⇒ no evidence,
    // so the value is storable at all.
    expect(derivedBefore.delivery_evidence).toBeNull();

    expect(await stampDeliveryIfRmClosed({ id: p!.id, status: 'active' }, rm('closed', null))).toBe(true);

    const stored = await load(p!.id);
    expect(stored.status).toBe('delivered');
    expect(stored.delivered_at).toBeNull();
    expect(stored.delivery_evidence).toBeNull();
    const derivedAfter = deliveryFromRm(stored, rm('closed', null).state);
    expect(derivedAfter.delivered_at).toBeNull();
    expect(derivedAfter.delivery_evidence).toBeNull();
  });
});

describe('projects.get action: the closure an MCP task polls for', () => {
  test('a delivered project returns its delivery record, deliverables and the phase field', async () => {
    const TENANT = '55555555-5555-4555-8555-5555555555aa';
    await db
      .update(projects)
      .set({
        status: 'delivered',
        delivered_at: new Date('2026-10-30T12:00:00Z'),
        delivery_evidence: { source: 'rm_project_closed', rm_pm_project_id: 'rm-1', phase: 'execution' },
        project_data: { keycloak_tenant_id: TENANT },
      })
      .where(eq(projects.id, projectId));
    await db.insert(projectDeliverables).values({ project_id: projectId, position: 0, kind: 'deliverable', title: 'Fix' });
    const out = await projectsGetHandler(
      { id: projectId },
      { userId: OWNER, projectId: null, correlationId: 'cid', initiator: 'human', channel: 'web', tenantId: TENANT },
    );
    expect(out).toMatchObject({
      id: projectId,
      status: 'delivered',
      delivered_at: '2026-10-30T12:00:00.000Z',
      delivery_evidence: { source: 'rm_project_closed', rm_pm_project_id: 'rm-1', phase: 'execution' },
      deliverables: [{ title: 'Fix' }],
    });
    // RM is not reachable from CI: the phase is unknown, never invented.
    expect(out.phase).toBeNull();
  });
});
