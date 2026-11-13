// tests/unit/routes/agui.test.ts
//
// Unit tests for E-9 AG-UI wire protocol (POST /api/agui/invoke): auth,
// envelope validation, unknown-action handling and NDJSON framing, run against
// the route handler directly with real signed tokens. (Cases that registered
// stand-in actions or a substitute ApprovalBackend were removed under the
// no-test-doubles ruling.)

import { describe, expect, test } from 'bun:test';
import { SignJWT } from 'jose';

import { handleAguiInvoke, buildPendingApprovalEvent } from '../../../src/routes/agui';
import { AGENT_TOKEN_AUDIENCE } from '../../../src/services/agent-session';

// --- Helpers ----------------------------------------------------------------

const USER_ID = '00000000-0000-0000-0000-0000000000aa';

function getJwtSecret(): Uint8Array {
  const secret =
    process.env.FR_AGENT_JWT_SECRET ||
    process.env.JWT_SECRET_KEY ||
    'dev-only-fr-agent-secret-change-me';
  return new TextEncoder().encode(secret);
}

// P1-TEAM-a: a token WITHOUT a `tenant_id` claim (pre-097) is refused 401 — the
// `getUserTenant` LIMIT-1 fallback is no longer authority — so every helper token
// carries a tenant unless a test passes `tenantId: null` to mint the legacy shape.
const DEFAULT_TOKEN_TENANT = '0195f48b-d000-7000-8000-0000000000aa';

async function signValidToken(opts: {
  sub?: string;
  audience?: string;
  expiresInSeconds?: number;
  tenantId?: string | null;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const tenantId = opts.tenantId === undefined ? DEFAULT_TOKEN_TENANT : opts.tenantId;
  return await new SignJWT(tenantId ? { tenant_id: tenantId } : {})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(opts.sub ?? USER_ID)
    .setAudience(opts.audience ?? AGENT_TOKEN_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expiresInSeconds ?? 60))
    .sign(getJwtSecret());
}

interface InvokeOpts {
  action: string;
  input?: unknown;
  correlationId?: string;
  channel?: string;
  bearer?: string | null;
  idempotencyKey?: string;
}

async function callInvoke(opts: InvokeOpts): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/x-ndjson',
  };
  if (opts.bearer !== null) {
    if (opts.bearer === undefined) {
      headers.Authorization = `Bearer ${await signValidToken()}`;
    } else {
      headers.Authorization = `Bearer ${opts.bearer}`;
    }
  }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const body = JSON.stringify({
    action: opts.action,
    input: opts.input ?? {},
    ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
    ...(opts.channel ? { channel: opts.channel } : {}),
  });
  const req = new Request('http://test/api/agui/invoke', {
    method: 'POST',
    headers,
    body,
  });
  return await handleAguiInvoke(req);
}

async function readNdjson(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => {
      // Each line MUST be valid JSON. parse exception is intentional —
      // surfaces malformed framing as a test failure.
      return JSON.parse(line) as Record<string, unknown>;
    });
}

// --- Tests ------------------------------------------------------------------

describe('POST /api/agui/invoke — auth', () => {
  test('missing Authorization → 401 with single NDJSON error line', async () => {
    const res = await callInvoke({
      action: 'demo.anything',
      bearer: null,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson');
    const events = await readNdjson(res);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('error');
    expect(events[0]!.code).toBe('unauthorized');
  });

  test('invalid JWT → 401 with single NDJSON error line', async () => {
    const res = await callInvoke({
      action: 'demo.anything',
      bearer: 'not-a-jwt',
    });
    expect(res.status).toBe(401);
    const events = await readNdjson(res);
    expect(events).toHaveLength(1);
    expect(events[0]!.code).toBe('unauthorized');
  });

  test('JWT with wrong audience → 401', async () => {
    const wrongAudToken = await signValidToken({ audience: 'not-fr-agent' });
    const res = await callInvoke({
      action: 'demo.anything',
      bearer: wrongAudToken,
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/agui/invoke — validation', () => {
  test('zod-failed envelope (missing action) → 400 + single NDJSON error line', async () => {
    const req = new Request('http://test/api/agui/invoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await signValidToken()}`,
      },
      body: JSON.stringify({ input: {} }), // no action
    });
    const res = await handleAguiInvoke(req);
    expect(res.status).toBe(400);
    const events = await readNdjson(res);
    expect(events).toHaveLength(1);
    expect(events[0]!.code).toBe('validation_failed');
  });

  test('unknown action → start, error{validation_failed}, done', async () => {
    const res = await callInvoke({ action: 'nope.does_not_exist' });
    expect(res.status).toBe(200);
    const events = await readNdjson(res);
    expect(events.map((e) => e.type)).toEqual(['start', 'error', 'done']);
    expect(events[1]!.code).toBe('validation_failed');
  });
});

describe('POST /api/agui/invoke — stream framing', () => {
  test('every line is valid JSON and ends with newline; no trailing junk', async () => {
    const res = await callInvoke({
      action: 'nope.does_not_exist', // unknown action: error path, no DB needed
    });
    const text = await res.text();
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.split('\n');
    // Last entry after split is empty (because of trailing \n).
    expect(lines[lines.length - 1]).toBe('');
    for (const line of lines.slice(0, -1)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// A failed approval-metadata lookup must not emit a confident event.
//
// The inline version filled every unknown with a plausible default:
// `requiredApprovers: []` (which reads as "nobody needs to approve"), an empty
// `approvalId`, and `expiresAt: now + 24h` — a deadline with no basis at all.
// The result was indistinguishable from a real pending-approval, to an AGENT,
// on the approval path. That is the most dangerous thing this event could say.
//
// The action genuinely IS pending, so the event must still be emitted —
// dropping it would leave the caller waiting forever. Only the unknown half is
// marked unknown.
describe('buildPendingApprovalEvent invents nothing', () => {
  test('an unavailable lookup is FLAGGED, not filled in', () => {
    const ev = buildPendingApprovalEvent({
      correlationId: 'c1',
      actionId: 'a1',
      channel: 'web',
      meta: null,
    });
    expect(ev.type).toBe('pending-approval');
    expect(ev.metaUnavailable).toBe(true);
    // The dangerous field. A fabricated deadline is worse than none: a consumer
    // computing on it acts on fiction, and cannot tell that it did.
    expect(ev.expiresAt).toBeUndefined();
    expect(ev.requiredApprovers).toEqual([]);
  });

  test('a successful lookup is NOT flagged and keeps its real values', () => {
    // The control: the flag must mean something. If it were always set, or
    // never set, the assertion above would be vacuous.
    const ev = buildPendingApprovalEvent({
      correlationId: 'c1',
      actionId: 'a1',
      channel: 'web',
      meta: {
        approvalId: 'ap-9',
        requiredApprovers: ['alice', 'bob'],
        channel: 'slack',
        expiresAt: '2026-09-02T00:00:00.000Z',
      },
    });
    expect(ev.metaUnavailable).toBeUndefined();
    expect(ev.approvalId).toBe('ap-9');
    expect(ev.requiredApprovers).toEqual(['alice', 'bob']);
    expect(ev.expiresAt).toBe('2026-09-02T00:00:00.000Z');
    // The row's own channel wins over the request's.
    expect(ev.channel).toBe('slack');
  });

  test('the pending state itself is still reported when meta is missing', () => {
    // Suppressing the event instead would be a different bug: the caller would
    // wait forever for an action that really is awaiting approval.
    const ev = buildPendingApprovalEvent({
      correlationId: 'c1',
      actionId: 'a1',
      channel: 'web',
      meta: null,
    });
    expect(ev.type).toBe('pending-approval');
    expect(ev.actionId).toBe('a1');
  });
});
