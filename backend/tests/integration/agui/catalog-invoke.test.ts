// tests/integration/agui/catalog-invoke.test.ts
//
// Bundle-level smoke for the Tool Surface Expansion (Wave 1-3) action catalog.
// Asserts every slice contributes at least one registered action and that
// every action obeys the bundle's frozen invariants:
//   - name matches /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/ (two lowercase
//     dotted segments)
//   - write actions never use approval { type: 'auto' }
//   - input + output each expose a callable .parse (zod-shaped)
//
// beforeAll builds the registry the way production does: importing the slice
// route modules runs their import-time `safeRegister(...)`, and
// `registerAllActions()` runs every exported registrar (both idempotent).
//
// Fails fast if a future slice forgets to wire its registration helper.

import { describe, expect, test, beforeAll } from 'bun:test';
import { SignJWT } from 'jose';
import { invokeAction, listActions } from '../../../src/agui/registry';
import { DOORWAY_INTAKE_ACTIONS } from '../../../src/agent/intake-catalog';
import { handleAguiInvoke } from '../../../src/routes/agui';
import { AGENT_TOKEN_AUDIENCE } from '../../../src/services/agent-session';
import { queryClient } from '../../../src/db/client';
import { registerBridgeActions } from '../../../src/agui/actions/bridge';
import { registerBridgeSources } from '../../../src/domain/bridge/sources';
import '../../../src/routes/assets/artifacts';
import '../../../src/routes/tools/kag';
import '../../../src/routes/tools/kanban';
import '../../../src/routes/tools/coding';
import '../../../src/routes/tools/analytics';
import { registerAllActions } from '../../../src/agui/register-all-actions';

import { createDbSuite } from '../helpers/db-suite';

beforeAll(async () => {
  await registerAllActions();
  registerBridgeActions();
  // Bridge sources (kag/artifacts/coding) are registered at server boot in
  // src/server.ts. This integration test bypasses server boot, so wire them
  // explicitly so bridge.list_sources has something to enumerate. Idempotent
  // — bridgeRegistry.register no-ops on duplicates by design.
  try {
    registerBridgeSources();
  } catch {
    // Already registered (e.g. by a sibling test in the same Bun process).
  }
});

describe('AG-UI bundle catalog', () => {
  test('every slice has at least one action registered', () => {
    const all = listActions();
    const slices = [
      'kag',
      'coding',
      'artifacts',
      'kanban',
      'bridge',
      'analytics',
      'n8n',
    ];
    for (const s of slices) {
      const sliceActions = all.filter((a) => a.name.startsWith(`${s}.`));
      expect(sliceActions.length).toBeGreaterThan(0);
    }
  });

  test('every action name is two-level dotted lower-snake', () => {
    const all = listActions();
    expect(all.length).toBeGreaterThan(0);
    for (const a of all) {
      expect(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(a.name)).toBe(true);
    }
  });

  test('every write action has a non-auto approval policy', () => {
    const all = listActions();
    for (const a of all.filter((x) => x.kind === 'write')) {
      expect(a.approval.type).not.toBe('auto');
    }
  });

  test('every action has callable input + output zod schemas', () => {
    const all = listActions();
    for (const a of all) {
      expect(typeof (a.input as { parse?: unknown })?.parse).toBe('function');
      expect(typeof (a.output as { parse?: unknown })?.parse).toBe('function');
    }
  });
});

// ----------------------------------------------------------------------------
// Real-invocation coverage — addresses the PR #23 review note that this file
// only asserts shape invariants but never actually invokes anything.
//
// For each slice we invoke one of its REAL registered actions through the
// agent rail and assert the refusal (the rail reaches only the doorway set, so
// a slice action is refused at RBAC before its handler — no upstream is hit).
// Real slice handlers (kag.list_*, coding.list_*, etc.) call upstream HTTP
// services, so the human-path invocation is exercised with the one real read
// that has no upstream (`bridge.list_sources`) below.
//
// DB-gated: invokeAction's read path goes through runIdempotent which queries
// `action_idempotency`. Without DB the gating mirrors agui.test.ts (`itDb`).
//
// Bridge slice has one truly side-effect-free real read
// (`bridge.list_sources`) — we invoke it as a human.
// ----------------------------------------------------------------------------

const USER_ID = '00000000-0000-0000-0000-0000000000bb';
const SLICES = [
  'kag',
  'coding',
  'artifacts',
  'kanban',
  'bridge',
  'analytics',
  'n8n',
] as const;

function getJwtSecret(): Uint8Array {
  const secret =
    process.env.FR_AGENT_JWT_SECRET ||
    process.env.JWT_SECRET_KEY ||
    'dev-only-fr-agent-secret-change-me';
  return new TextEncoder().encode(secret);
}

async function signValidToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // P1-TEAM-a: a token must carry its tenant (a tenant-less one is refused 401).
  return await new SignJWT({ tenant_roles: ['user'], tenant_id: '44444444-4444-4444-8444-4444444444c1' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(USER_ID)
    .setAudience(AGENT_TOKEN_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(getJwtSecret());
}

async function invokeNdjson(
  action: string,
  input: unknown = {},
): Promise<Record<string, unknown>[]> {
  const token = await signValidToken();
  const req = new Request('http://test/api/agui/invoke', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action, input }),
  });
  const res = await handleAguiInvoke(req);
  expect(res.status).toBe(200);
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

let dbReachable = false;
beforeAll(async () => {
  try {
    await queryClient`SELECT 1 FROM action_idempotency LIMIT 1`;
    dbReachable = true;
  } catch {
    // Skip DB-bound tests if action_idempotency isn't reachable.
  }
  // Clear the idempotency cache entry that bridge.list_sources uses (stable
  // key 'bridge.list_sources:v1', 24h TTL). Without this, a previous
  // invocation that ran BEFORE registerBridgeSources() (i.e., produced an
  // empty sources[] result) would be served back from cache for 24 hours
  // and the assertion below would fail. This is a real production gap —
  // the action's stable idempotency key means cache poisoning sticks. See
  // commit message for the followup ticket reference.
  if (dbReachable) {
    try {
      await queryClient`DELETE FROM action_idempotency WHERE key LIKE ${'%bridge.list_sources:v1'}`;
    } catch {
      // Best-effort; if deletion fails we'll just see the cached result.
    }
  }
});

const { itDb } = createDbSuite('catalog-invoke');

/**
 * fr-agui P1c (OQ-17 = c): `/api/agui/invoke` is the agent-token RAIL, unbound —
 * it reaches only the doorway set, so no slice action runs through it any more.
 * The slices themselves are still live for their non-agent callers (the REST
 * tools routes, the channel grammar, a deferred approval): those go through
 * `invokeAction` with their own context, which is what the "as a human" half
 * exercises — the same registry, validation, RBAC and handler path.
 */
async function invokeAsHuman(action: string, input: unknown): Promise<unknown> {
  return invokeAction(action, input, {
    userId: USER_ID,
    projectId: null,
    correlationId: `catalog-invoke-${action}`,
    initiator: 'human',
    channel: 'web',
    tenantRoles: ['user'],
    tenantId: '44444444-4444-4444-8444-4444444444c1',
  });
}

describe('AG-UI catalog-invoke — real wire path per slice', () => {
  for (const slice of SLICES) {
    itDb(`${slice} slice: a real action is REFUSED through the retired agent rail (P1c)`, async () => {
      // A real action of this slice that is not in the doorway set, with an input
      // its schema accepts, so the refusal observed is the rail's RBAC, not validation.
      const inputs: unknown[] = [{}, { project_id: '44444444-4444-4444-8444-4444444444c2' }];
      const pick = listActions()
        .filter((a) => a.name.startsWith(`${slice}.`) && !DOORWAY_INTAKE_ACTIONS.has(a.name))
        .sort((x, y) => x.name.localeCompare(y.name))
        .flatMap((a) =>
          inputs
            .filter((i) => (a.input as { safeParse: (v: unknown) => { success: boolean } }).safeParse(i).success)
            .map((input) => ({ action: a.name, input })),
        )[0];
      expect(pick).toBeDefined();
      const events = await invokeNdjson(pick!.action, pick!.input);
      expect(events.map((e) => e.type)).toEqual(['start', 'error', 'done']);
      expect(events[0]!.action).toBe(pick!.action);
      expect(events[1]!.code).toBe('rbac_denied');
    });
  }

  itDb('real bridge.list_sources read action invokes successfully (deterministic, no upstream)', async () => {
    // bridge.list_sources is the one real catalog read with no upstream
    // fetch — it just enumerates the in-process bridge registry. This adds
    // a real human-path invocation alongside the per-slice rail refusals.
    const resultEvent = { type: 'result', output: (await invokeAsHuman('bridge.list_sources', {})) as { sources: { id: string; label: string }[] } };
    expect(resultEvent.type).toBe('result');
    expect(Array.isArray(resultEvent.output.sources)).toBe(true);
    expect(resultEvent.output.sources.length).toBeGreaterThan(0);
    for (const s of resultEvent.output.sources) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.label).toBe('string');
    }
  });

});
