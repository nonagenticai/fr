// tests/integration/routes/board-tenant-credential-leak.integration.test.ts
//
// A cross-tenant board read, driven through the SERVER'S real request pipeline
// (`dispatchReal`: the ordered route table + `dispatchRouted`) against the real
// Postgres, in a request frame that CARRIES the caller's bearer token.
//
// Two leaks are refused here, and both assertions are ARMED — the credential is
// present in the frame, so an absence assertion can only hold because the code
// withheld it (scripts/check-credential-absence-armed.ts):
//
//   1. CROSS-TENANT: tenant B asks for tenant A's board. The board gate
//      (`assertBoardTenantAuthorized`) refuses with 404 before any Planka call,
//      and the response names nothing of tenant A.
//   2. CREDENTIAL: the refusal emits ONE structured `board_tenant_gate_refused`
//      line (lib/board-tenant-gate-metrics.ts), which reads the request context
//      — the context holding the caller's live bearer — by NAMED fields only.
//      A `...ctx` spread there would write the token into the log. It must not.
//
// No doubles: the board's owning tenant comes from a real `projects` row, the
// gate and the telemetry are the production code, and `console.error` is only
// CAPTURED (fr's own log line), never replaced with behaviour.

import { afterAll, beforeAll, describe, expect } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db, projects } from '../../../src/db/client';
import { withRequestContext } from '../../../src/integrations/_lib/context';
import { dispatchReal } from '../../unit/capabilities/real-pipeline';
import { createDbSuite } from '../helpers/db-suite';
import { getCapability } from '../../helpers/capabilities';

const { itDb } = createDbSuite('board-tenant-credential-leak');

const RUN = crypto.randomUUID().slice(0, 8);
const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const BOARD = `leak-board-${RUN}`;
// A JWT-shaped bearer: what a browser caller's frame carries.
const CALLER_JWT = `eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJsZWFrLXRlc3QtJHtSVU59In0.c2lnLSR7${RUN}`;
let projectId = '';

beforeAll(async () => {
  try {
    const [row] = await db
      .insert(projects)
      .values({
        owner_id: crypto.randomUUID(),
        name: `credential-leak-${RUN}`,
        repository_url: 'https://example.com/repo',
        status: 'active',
        planka_board_id: BOARD,
        project_data: { keycloak_tenant_id: TENANT_A },
      })
      .returning({ id: projects.id });
    projectId = row!.id;
  } catch {
    // No database: createDbSuite skips (or hard-fails in CI) every itDb below.
  }
});

afterAll(async () => {
  if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
});

/** GET the board as a tenant-B caller whose frame holds CALLER_JWT; capture fr's refusal line. */
async function readBoardAsTenantB(): Promise<{ status: number; body: string; refusals: Record<string, unknown>[]; logged: string }> {
  const cap = getCapability('kanban.get_board');
  if (!cap) throw new Error('kanban.get_board capability is not registered');
  const req = new Request(`http://fr/api/kanban/boards/${BOARD}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${CALLER_JWT}`, 'X-Active-Tenant': TENANT_B },
  });
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  let res: Response;
  try {
    res = await withRequestContext(
      {
        bearerToken: CALLER_JWT,
        correlationId: `credential-leak-${RUN}`,
        initiator: 'human',
        channel: 'web',
        tenantId: TENANT_B,
        activeTenantSource: 'header',
      },
      () => dispatchReal(cap, req),
    );
  } finally {
    console.error = original;
  }
  const refusals = lines
    .filter((l) => l.includes('board_tenant_gate_refused'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { status: res.status, body: await res.text(), refusals, logged: lines.join('\n') };
}

describe('cross-tenant board read with a live bearer in the frame', () => {
  itDb('is refused 404 before Planka, naming nothing of the owning tenant', async () => {
    const r = await readBoardAsTenantB();
    expect(r.status).toBe(404);
    expect(r.body).toContain('Board not found');
    expect(r.body).not.toContain(TENANT_A);
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]!.reason).toBe('tenant_mismatch');
    expect(r.refusals[0]!.owning_tenant).toBe(TENANT_A);
    expect(r.refusals[0]!.active_tenant).toBe(TENANT_B);
  });

  itDb('the refusal telemetry carries no credential from the frame', async () => {
    const r = await readBoardAsTenantB();
    expect(r.refusals).toHaveLength(1);
    const line = r.refusals[0]!;
    // The frame holds bearerToken = CALLER_JWT; none of it may reach the log line.
    expect(line.bearerToken).toBeUndefined();
    expect(line.bearer_token).toBeUndefined();
    expect(line.authorization).toBeUndefined();
    expect(r.logged).not.toContain(CALLER_JWT);
    expect(r.body).not.toContain(CALLER_JWT);
  });
});
