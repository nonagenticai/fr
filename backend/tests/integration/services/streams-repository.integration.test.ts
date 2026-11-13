// tests/integration/services/streams-repository.integration.test.ts
//
// Hits real fr-postgres (DATABASE_URL with migrations 026 + 055 applied).
// Same skip-if-unreachable pattern as user-roles.integration.test.ts so
// the suite stays green on dev machines without a live DB.
//
// Plan 7 Stage 0a — uses kind=principle / kind=requirement for the
// repository CRUD tests because migration 055 enforces a kind-aware
// streams_kind_tenant_check (workflow → __system_workflow__ tenant only;
// prompt → __system_prompt__ tenant only; the three asset kinds accept
// any tenant_id). The tests below exercise CRUD behaviour, not the
// system-tenant pinning — using asset kinds keeps them
// constraint-faithful with prod without binding to specific tenant
// UUIDs that the system tenants own.

import {
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
} from 'bun:test';
import { inArray } from 'drizzle-orm';

import {
  db,
  queryClient,
  streams,
  tenantImprovementProjects,
} from '../../../src/db/client';
import {
  addMember,
  createStream,
  DEFAULT_THRESHOLD_RULES,
  getStream,
  getTenantImprovementProject,
  listAssetMemberships,
  listMembers,
  listStreams,
  removeMember,
  softDeleteStream,
  updateStream,
  upsertTenantImprovementProject,
} from '../../../src/services/streams/repository';

import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('streams-repository');

const sql = queryClient;

const TENANT = '00000000-0000-0000-0000-000000000aaa';
const OTHER_TENANT = '00000000-0000-0000-0000-000000000bbb';
const ASSET_A = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const ASSET_B = '22222222-2222-4222-8222-bbbbbbbbbbbb';

let reachable = false;
const createdStreamIds: string[] = [];

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM streams LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[streams-repository.integration] postgres unreachable or migration 026 not applied — skipping:',
      (err as Error).message,
    );
  }
});

async function cleanup(): Promise<void> {
  if (!reachable) return;
  // Delete in dependency order. Membership rows ON DELETE CASCADE through
  // streams, but we filter by tenant to stay scoped to this suite's data.
  await db
    .delete(streams)
    .where(inArray(streams.tenant_id, [TENANT, OTHER_TENANT]));
  await db
    .delete(tenantImprovementProjects)
    .where(inArray(tenantImprovementProjects.tenant_id, [TENANT, OTHER_TENANT]));
  createdStreamIds.length = 0;
}

beforeEach(cleanup);
afterAll(cleanup);

describe('streams repository', () => {
  itDb('create + get + list (tenant-scoped)', async () => {
    const a = await createStream({
      tenantId: TENANT,
      kind: 'principle',
      name: 'workflow stream',
      slug: 'workflow-stream-a',
      plankaProjectId: 'pp-1',
      plankaBoardId: 'planka-tbd',
      thresholdRules: { ...DEFAULT_THRESHOLD_RULES },
    });
    expect(a.tenant_id).toBe(TENANT);
    expect(a.kind).toBe('principle');
    expect(a.is_active).toBe(true);
    expect(a.threshold_rules).toMatchObject(DEFAULT_THRESHOLD_RULES);

    // Other-tenant row to prove isolation.
    await createStream({
      tenantId: OTHER_TENANT,
      kind: 'principle',
      name: 'other tenant stream',
      slug: 'other-tenant-stream',
      plankaProjectId: 'pp-x',
      plankaBoardId: 'planka-tbd',
      thresholdRules: {},
    });

    const list = await listStreams(TENANT);
    expect(list.map((r) => r.id)).toEqual([a.id]);

    const fetched = await getStream(a.id, TENANT);
    expect(fetched?.name).toBe('workflow stream');
    expect(await getStream(a.id, OTHER_TENANT)).toBeNull();
  });

  itDb('list with kind filter', async () => {
    const w = await createStream({
      tenantId: TENANT,
      kind: 'principle',
      name: 'w',
      slug: 'kind-filter-w',
      plankaProjectId: 'p',
      plankaBoardId: 'planka-tbd',
      thresholdRules: {},
    });
    const p = await createStream({
      tenantId: TENANT,
      kind: 'requirement',
      name: 'p',
      slug: 'kind-filter-p',
      plankaProjectId: 'p',
      plankaBoardId: 'planka-tbd',
      thresholdRules: {},
    });
    const wOnly = await listStreams(TENANT, { kind: 'principle' });
    expect(wOnly.map((r) => r.id)).toEqual([w.id]);
    const pOnly = await listStreams(TENANT, { kind: 'requirement' });
    expect(pOnly.map((r) => r.id)).toEqual([p.id]);
  });

  itDb('update merges patch fields only', async () => {
    const s = await createStream({
      tenantId: TENANT,
      kind: 'principle',
      name: 'orig',
      slug: 'update-merge-test',
      plankaProjectId: 'p',
      plankaBoardId: 'planka-tbd',
      thresholdRules: { initial: true },
      minSignificanceN: 30,
    });
    const updated = await updateStream(s.id, TENANT, {
      name: 'patched',
      minSignificanceN: 100,
    });
    expect(updated?.name).toBe('patched');
    expect(updated?.min_significance_n).toBe(100);
    // unchanged
    expect(updated?.threshold_rules).toEqual({ initial: true });
  });

  itDb('updateStream rejects cross-tenant', async () => {
    const s = await createStream({
      tenantId: TENANT,
      kind: 'principle',
      name: 'tenant-A',
      slug: 'cross-tenant-update-test',
      plankaProjectId: 'p',
      plankaBoardId: 'planka-tbd',
      thresholdRules: {},
    });
    const result = await updateStream(s.id, OTHER_TENANT, { name: 'hijack' });
    expect(result).toBeNull();
    const fresh = await getStream(s.id, TENANT);
    expect(fresh?.name).toBe('tenant-A');
  });

  itDb('softDeleteStream excludes from default list', async () => {
    const s = await createStream({
      tenantId: TENANT,
      kind: 'principle',
      name: 'doomed',
      slug: 'soft-delete-test',
      plankaProjectId: 'p',
      plankaBoardId: 'planka-tbd',
      thresholdRules: {},
    });
    expect(await softDeleteStream(s.id, TENANT)).toBe(true);
    const visible = await listStreams(TENANT);
    expect(visible).toEqual([]);
    const all = await listStreams(TENANT, { includeInactive: true });
    expect(all.map((r) => r.id)).toEqual([s.id]);
  });

  itDb('membership add/remove + listMembers + listAssetMemberships', async () => {
    const s = await createStream({
      tenantId: TENANT,
      kind: 'principle',
      name: 's',
      slug: 'membership-add-remove-test',
      plankaProjectId: 'p',
      plankaBoardId: 'planka-tbd',
      thresholdRules: {},
    });
    const r1 = await addMember(s.id, 'workflow', ASSET_A, TENANT);
    expect(r1?.asset_id).toBe(ASSET_A);

    // Re-add is idempotent — same row returned.
    const r1b = await addMember(s.id, 'workflow', ASSET_A, TENANT);
    expect(r1b?.asset_id).toBe(ASSET_A);

    const r2 = await addMember(s.id, 'prompt', ASSET_B, TENANT);
    expect(r2?.asset_id).toBe(ASSET_B);

    const members = await listMembers(s.id, TENANT);
    expect(members.length).toBe(2);

    const aMemberships = await listAssetMemberships('workflow', ASSET_A, TENANT);
    expect(aMemberships.map((r) => r.id)).toEqual([s.id]);

    // Cross-tenant: same asset id under wrong tenant returns nothing.
    const empty = await listAssetMemberships('workflow', ASSET_A, OTHER_TENANT);
    expect(empty).toEqual([]);

    expect(await removeMember(s.id, 'workflow', ASSET_A, TENANT)).toBe(true);
    expect(await listMembers(s.id, TENANT)).toHaveLength(1);
    // Removing again is a no-op.
    expect(await removeMember(s.id, 'workflow', ASSET_A, TENANT)).toBe(false);
  });

  itDb('addMember rejects cross-tenant stream id', async () => {
    const s = await createStream({
      tenantId: TENANT,
      kind: 'principle',
      name: 's',
      slug: 'addmember-cross-tenant-test',
      plankaProjectId: 'p',
      plankaBoardId: 'planka-tbd',
      thresholdRules: {},
    });
    const result = await addMember(s.id, 'workflow', ASSET_A, OTHER_TENANT);
    expect(result).toBeNull();
    expect(await listMembers(s.id, TENANT)).toHaveLength(0);
  });

  itDb('upsertTenantImprovementProject is idempotent per (tenant, kind)', async () => {
    const a = await upsertTenantImprovementProject(TENANT, 'workflow', 'pp-w');
    expect(a.planka_project_id).toBe('pp-w');
    // Second call with a different project id returns the EXISTING row.
    const b = await upsertTenantImprovementProject(TENANT, 'workflow', 'pp-w-other');
    expect(b.planka_project_id).toBe('pp-w');
    // Different kind gets its own row.
    const p = await upsertTenantImprovementProject(TENANT, 'prompt', 'pp-p');
    expect(p.planka_project_id).toBe('pp-p');

    expect(await getTenantImprovementProject(TENANT, 'workflow')).toMatchObject({
      planka_project_id: 'pp-w',
    });
    expect(await getTenantImprovementProject(OTHER_TENANT, 'workflow')).toBeNull();
  });
});
