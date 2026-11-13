import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveCardStampTenant } from '../../../../src/routes/cards/project';

/**
 * ─── fr row 14 ──────────────────────────────────────────────────────────────
 * A card minted through `POST /api/cards/project` carried NO
 * `keycloak_tenant_id`, and that made it permanently un-retryable: of the three
 * ways a TODO card is selected, the ROUTER is one-shot, the WATCHDOG
 * `todo_retrigger` is gated OFF, and `AA Maintenance - Todo Sweep` requires
 * `keycloak_tenant_id <> ''`. Only `routes/projects.ts` stamped it, and only on
 * the board's INTAKE card.
 *
 * ─── fr row 14f (THIS FILE'S SUBJECT) ───────────────────────────────────────
 * Row 14 stamped the ACTING identity's tenant (`activeTenantId`), which honours
 * the `X-Active-Tenant` / `X-Tenant-Id` override
 * (middleware/request-context.ts:38,69). So a card minted by the AA
 * orchestrator — or by anyone carrying an override — was labelled with the
 * MINTER's tenant, not the hunted/parent PROJECT's owning tenant. 14f moves the
 * STAMP onto `projects.project_data.keycloak_tenant_id` and fails CLOSED (409,
 * nothing minted) when the project has no tag.
 *
 * ⚠️ `activeTenantId` does TWO JOBS and only ONE of them changed:
 *   - AUTHORISATION — `cardRouteTenantRefusal(user, activeTenantId)` and the
 *     tenant projection inside `resolveCardRouteProject` — UNCHANGED, and
 *     asserted unchanged below. Moving auth onto the project tenant would
 *     WIDEN who may mint.
 *   - the STAMP — "whose data is this" — is the only thing that moved.
 *
 * ⚠️ MEASURED, and the reason the route-level tests here are structural rather
 * than end-to-end: `resolveCardRouteProject` is ALREADY tag-bound (fr row 14b —
 * `cardRouteTagBound` → `guardProjectId(...).allowed`, which passes only
 * `owned`), so on origin/main the project tag provably EQUALS `activeTenantId`
 * by the time the stamp runs, and an untagged project 404s before anything is
 * minted. There is therefore NO end-to-end input that distinguishes the two
 * values today. 14f is a SECOND, INDEPENDENT barrier: it removes the stamp's
 * dependence on an invariant maintained in another function.
 */

const PROJECT_TENANT = '11111111-1111-4111-8111-111111111111';
const ACTING_TENANT = '22222222-2222-4222-8222-222222222222';
const proj = (project_data: unknown) => ({ id: 'p-1', project_data });

describe('fr row 14f — resolveCardStampTenant (the stamp decision, behavioural)', () => {
  it('ACTING TENANT ≠ PROJECT TENANT: the stamp is the PROJECT tenant', () => {
    const r = resolveCardStampTenant(
      proj({ keycloak_tenant_id: PROJECT_TENANT }),
      ACTING_TENANT,
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.tenantId).toBe(PROJECT_TENANT);
    // The whole point: never the minter's.
    expect(r.ok && r.tenantId).not.toBe(ACTING_TENANT);
  });

  it('an X-Active-Tenant override does not move the stamp', () => {
    // Same project row, three different acting tenants (the override's whole
    // effect on this route is the value of `activeTenantId`).
    const tags = [ACTING_TENANT, PROJECT_TENANT, '33333333-3333-4333-8333-333333333333'].map(
      (acting) => {
        const r = resolveCardStampTenant(
          proj({ keycloak_tenant_id: PROJECT_TENANT }),
          acting,
        );
        return r.ok ? r.tenantId : `REFUSED:${acting}`;
      },
    );
    expect(tags).toEqual([PROJECT_TENANT, PROJECT_TENANT, PROJECT_TENANT]);
  });

  it('reads the tag through the ONE shared accessor: a blank/whitespace tag is NO tag', () => {
    const r = resolveCardStampTenant(
      proj({ keycloak_tenant_id: `  ${PROJECT_TENANT}  ` }),
      ACTING_TENANT,
    );
    expect(r.ok && r.tenantId).toBe(PROJECT_TENANT); // trimmed, same as projectKcTenantTag
  });

  it('FAILS CLOSED: an untagged project is a 409 and never defaults to the acting tenant', () => {
    const untagged: unknown[] = [
      null,
      {},
      { keycloak_tenant_id: '' },
      { keycloak_tenant_id: '   ' },
      { keycloak_tenant_id: undefined },
      { other_field: PROJECT_TENANT },
    ];
    for (const pd of untagged) {
      const r = resolveCardStampTenant(proj(pd), ACTING_TENANT);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('project_tenant_unknown');
      // `activeTenantId` may appear as DIAGNOSTICS, never as the answer.
      expect(r.body.active_tenant).toBe(ACTING_TENANT);
      expect(r.body.project_id).toBe('p-1');
      expect(Object.values(r.body)).not.toContain(PROJECT_TENANT);
      expect(r.body).not.toHaveProperty('tenantId');
    }
  });

  it('POSITIVE CONTROL on the 409 probe: a tagged project is NOT refused', () => {
    // Without this, "everything 409s" would pass the test above.
    const r = resolveCardStampTenant(
      proj({ keycloak_tenant_id: PROJECT_TENANT }),
      ACTING_TENANT,
    );
    expect(r.ok).toBe(true);
    expect(r).not.toHaveProperty('status');
  });
});

const SRC_DIR = join(import.meta.dir, '../../../../src');
const read = (rel: string) => readFileSync(join(SRC_DIR, rel), 'utf8');
const routeSrc = read('routes/cards/project.ts');

describe('POST /api/cards/project — the stamp call site', () => {
  it('stamps the PROJECT tenant, and does NOT stamp activeTenantId', () => {
    expect(routeSrc).toContain("stamp(metadata, 'keycloak_tenant_id', projectTenantId)");
    expect(routeSrc).not.toContain("stamp(metadata, 'keycloak_tenant_id', activeTenantId)");
  });

  it('files the card_plan_pins row under the PROJECT tenant too, never activeTenantId', () => {
    // The pin row is the same unit as the Metadata stamp: one owner tenant per minted card.
    const call = routeSrc.indexOf('await insertPlanPin({');
    expect(call).toBeGreaterThan(-1);
    const args = routeSrc.slice(call, routeSrc.indexOf('})', call));
    expect(args).toContain('tenantId: projectTenantId');
    expect(args).not.toContain('activeTenantId');
    // Exactly one pin write in this route, so the assertion above covers it.
    expect(routeSrc.match(/insertPlanPin\(\{/g)?.length).toBe(1);
  });

  it('binds projectTenantId from resolveCardStampTenant, not from a second query', () => {
    expect(routeSrc).toContain(
      'const stampTenant = resolveCardStampTenant(project, activeTenantId)',
    );
    expect(routeSrc).toContain('const projectTenantId = stampTenant.tenantId');
    // Exactly ONE read of the tag in this file, through the shared accessor.
    expect(routeSrc.match(/projectKcTenantTag\(/g)?.length).toBe(1);
    expect(routeSrc).not.toContain("project_data as { keycloak_tenant_id");
  });

  it('stamps it in the SAME try block as the other metadata stamps, so it actually runs', () => {
    const cardType = routeSrc.indexOf("stamp(metadata, 'card_type'");
    const tenant = routeSrc.indexOf("stamp(metadata, 'keycloak_tenant_id'");
    const projectId = routeSrc.indexOf("stamp(metadata, 'project_id'");
    expect(cardType).toBeGreaterThan(-1);
    expect(tenant).toBeGreaterThan(-1);
    expect(tenant).toBeGreaterThan(projectId);
    const between = routeSrc.slice(projectId, tenant);
    expect(between).not.toContain('catch');
    expect(between).not.toContain('return ');
  });

  it('MINTS NOTHING on the 409: the refusal precedes the suppression read, the lease and the Planka create', () => {
    const refusal = routeSrc.indexOf('if (!stampTenant.ok) return jsonResponse(');
    const suppressed = routeSrc.indexOf('await isFindingSuppressed(');
    const lease = routeSrc.indexOf('await claimCreateLease(');
    const create = routeSrc.indexOf('await agent.cards.create(');
    for (const [name, i] of Object.entries({ refusal, suppressed, lease, create })) {
      expect(i, `${name} not found`).toBeGreaterThan(-1);
    }
    expect(refusal).toBeLessThan(suppressed);
    expect(refusal).toBeLessThan(lease);
    expect(refusal).toBeLessThan(create);
  });

  it('⛔ AUTHORISATION IS PRESERVED: both auth uses of activeTenantId are untouched', () => {
    // The EXEC pin / cross-tenant-service gate — "may this caller act here".
    expect(routeSrc).toContain('const refusal = cardRouteTenantRefusal(user, activeTenantId)');
    expect(routeSrc).toContain('if (refusal) return refusal;');
    // The tenant PROJECTION that resolves the project at all (and, via
    // cardRouteTagBound, the row-14b tag binding).
    expect(routeSrc).toContain('tenantScopedProjectFilter(user.id, activeTenantId, user.tenantId');
    expect(routeSrc).toContain('guardProjectId(project, activeTenantId, false).allowed');
    // Auth must NOT have been re-pointed at the project tenant.
    expect(routeSrc).not.toContain('cardRouteTenantRefusal(user, projectTenantId');
    expect(routeSrc).not.toContain('tenantScopedProjectFilter(user.id, projectTenantId');
  });

  it('NEGATIVE CONTROL: the sibling stamps are untouched', () => {
    for (const field of ['card_type', 'work_type', 'card_group', 'project_id']) {
      expect(routeSrc).toContain(`stamp(metadata, '${field}'`);
    }
  });
});

describe('all THREE callers are covered by the one chokepoint', () => {
  // routes/cards/project.ts:585 (handleCreateProjectCard),
  // routes/decomposition-commit.ts:798, routes/decomposition-split.ts:519.
  const callers = ['routes/decomposition-commit.ts', 'routes/decomposition-split.ts'];

  it('the two decomposition callers mint ONLY through createProjectCardFor', () => {
    for (const rel of callers) {
      const src = read(rel);
      expect(src, rel).toContain('await createProjectCardFor(user, activeTenantId, {');
      // No second minter and no second stamp: nothing to fix in these files.
      expect(src.includes('cards.create('), `${rel} mints its own card`).toBe(false);
      expect(src.includes('keycloak_tenant_id'), `${rel} stamps its own tenant`).toBe(false);
    }
  });

  it('POSITIVE CONTROL: the chokepoint itself DOES hold the only minter and the only stamp', () => {
    // Without this, the two `false` assertions above would also pass if the
    // substrings had simply been misspelled.
    expect(routeSrc.match(/cards\.create\(/g)?.length).toBe(1);
    expect(routeSrc).toContain("stamp(metadata, 'keycloak_tenant_id'");
  });

  it('the in-process handler passes the SAME (user, activeTenantId) pair through', () => {
    expect(routeSrc).toContain('return await createProjectCardFor(user, activeTenantId, body)');
  });
});

describe('an approval minted from a 14f-stamped card lands in the PROJECT tenant', () => {
  // The reviewer's ask. POST /api/execution/approvals resolves the approval's
  // `tenant_id` from the PROJECT chain (dept→workspace, else the project's own
  // keycloak_tenant_id tag) and NEVER from the caller's active tenant — the
  // same owning tenant 14f now stamps on the card, so the card and the
  // approval it produces cannot disagree.
  const approvalsSrc = read('routes/execution-approvals.ts');

  it('resolves the approval tenant from the project row, not the acting tenant', () => {
    const resolution = approvalsSrc.slice(
      approvalsSrc.indexOf('const tenantId = project'),
      approvalsSrc.indexOf('if (jwtCaller) {'),
    );
    expect(resolution.length).toBeGreaterThan(0);
    expect(resolution).toContain('project.tenant_id');
    expect(resolution).toContain('keycloak_tenant_id');
    expect(resolution).not.toContain('activeTenantId');
  });

  it('fails closed on an untenanted project — same direction as the 14f 409', () => {
    expect(approvalsSrc).toContain('SIGNOFF_BLOCK_REASONS.PROJECT_UNTENANTED');
    expect(approvalsSrc).toContain('tenant_id: tenantId');
    // The approval is scoped to the resolved PROJECT tenant.
    expect(approvalsSrc).not.toContain('tenant_id: activeTenantId');
  });
});
