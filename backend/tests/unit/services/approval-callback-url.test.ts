// tests/unit/services/approval-callback-url.test.ts
//
// ⭐ 409/410 IS A TERMINAL ANSWER, NOT A FAILURE — the live defect this pins.
//
// MEASURED ON PROD 2026-11-03, from `kubectl -n fr logs deploy/fr`:
//
//   [n8n-callback] expired callback to callback_url https://n8n.example.com/webhook-waiting/… for approval 5de473ea-…
//     FAILED: approval callback_url POST to https://n8n.example.com/webhook-waiting/… failed (HTTP 409, non-2xx)
//     — scheduled for re-delivery
//
// n8n answers 409 at `webhook-waiting/<executionId>` exactly when that execution
// is no longer waiting (already resumed, cancelled or expired). The notice is
// MOOT — replaying it can never succeed — but fr classified every error as
// `failed`, recorded a problem on the approval and scheduled a retry, so the
// same notice was replayed forever and `FrApprovalExpiryCallbackFailing` fired
// on a non-problem.
//
// THE CONTRACT PINNED HERE
//   * `postDecisionToCallbackUrl` throws `CallbackUrlHttpError` with the HTTP
//     status as a FIELD (never parsed out of the message);
//   * ONLY 409 and 410 are terminal — every other status, timeout and transport
//     error keeps the pre-existing failed/retry behaviour;
//   * a terminal answer RETIRES the row (`delivered_at`), records NO problem and
//     schedules NO retry, and the lane reports `already-terminal`.
//
// ⛔ NO TEST DOUBLES (backend/CLAUDE.md, owner ruling 2026-10-29): no fetch stub,
// no fake HTTP server, no `mock()`. The status→error construction is exercised
// through the SAME function the response branch calls; the per-row consequences
// are exercised against the real CI Postgres through the SAME production
// function the delivery loop calls.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { db, queryClient } from '../../../src/db/client';
import {
  CALLBACK_URL_PATH_PREFIX,
  callbackUrlNon2xxError,
  isCallbackUrlAlreadyTerminal,
  redactCallbackUrl,
} from '../../../src/lib/approval-callback-url';
import {
  DecisionCallbackTimeout,
  callbackUrlLaneFailureOutcome,
  handleCallbackUrlSendFailure,
} from '../../../src/services/n8n-callback';
import { createDbSuite } from '../../integration/helpers/db-suite';

// ---------------------------------------------------------------------------
// The status → typed-error construction (pure)
// ---------------------------------------------------------------------------

const CALLBACK_URL =
  'https://n8n.example.com/webhook-waiting/exec-abc123?signature=dont-log-me';

describe('callbackUrlNon2xxError — the status is a FIELD, not message text', () => {
  test('carries the receiver status verbatim', () => {
    const err = callbackUrlNon2xxError(409, CALLBACK_URL);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CallbackUrlHttpError');
    expect(err.status).toBe(409);
    expect(err.redirect).toBe(false);
  });

  test('keeps the operator-facing message text exactly as before', () => {
    const err = callbackUrlNon2xxError(500, CALLBACK_URL);
    expect(err.message).toContain('approval callback_url POST to');
    expect(err.message).toContain('failed (HTTP 500, non-2xx)');
  });

  test('the message never carries the execution id or the signature', () => {
    const err = callbackUrlNon2xxError(409, CALLBACK_URL);
    expect(err.message).not.toContain('exec-abc123');
    expect(err.message).not.toContain('dont-log-me');
    // Only the redacted form, exactly as `redactCallbackUrl` renders it.
    expect(err.message).toContain(
      redactCallbackUrl(CALLBACK_URL),
    );
    expect(redactCallbackUrl(CALLBACK_URL)).toBe(
      `https://n8n.example.com${CALLBACK_URL_PATH_PREFIX}…`,
    );
  });

  test('a 3xx is classified as a redirect, not followed', () => {
    const err = callbackUrlNon2xxError(302, CALLBACK_URL);
    expect(err.redirect).toBe(true);
    expect(err.message).toContain('redirect not followed');
  });
});

describe('isCallbackUrlAlreadyTerminal — 409 and 410 ONLY', () => {
  test.each([409, 410])('HTTP %i is terminal', (status) => {
    expect(isCallbackUrlAlreadyTerminal(callbackUrlNon2xxError(status, CALLBACK_URL))).toBe(true);
  });

  // ⛔ THE BOUNDARY. A 500 is the receiver breaking, a 404 may be fr's wrong
  // path, a 429 is a throttle — none of them says the execution is gone, so all
  // of them must keep the failed/retry path.
  test.each([400, 401, 403, 404, 408, 429, 500, 502, 503, 504, 302])(
    'HTTP %i is NOT terminal',
    (status) => {
      expect(isCallbackUrlAlreadyTerminal(callbackUrlNon2xxError(status, CALLBACK_URL))).toBe(false);
    },
  );

  test('a timeout is NOT terminal — fr stopped listening, the execution may still wait', () => {
    expect(
      isCallbackUrlAlreadyTerminal(new DecisionCallbackTimeout('decision callback abandoned after 5ms')),
    ).toBe(false);
  });

  test('a transport error is NOT terminal', () => {
    expect(
      isCallbackUrlAlreadyTerminal(new Error('approval callback_url POST to https://n8n.example.com/webhook-waiting/… failed (TypeError)')),
    ).toBe(false);
  });

  test('a plain object that merely looks like an error is NOT terminal', () => {
    expect(isCallbackUrlAlreadyTerminal({ status: 409 })).toBe(false);
  });
});

describe('callbackUrlLaneFailureOutcome — the lane summary (pure)', () => {
  const noFailures: Array<{ message: string; timedOut: boolean }> = [];

  test('every claimed row answered 409/410 → already-terminal', () => {
    expect(
      callbackUrlLaneFailureOutcome({
        sent: 0,
        attempted: 2,
        alreadyTerminal: 2,
        failures: noFailures,
        undeliveredRows: 2,
      }),
    ).toEqual({ outcome: 'already-terminal' });
  });

  test('a REAL failure still dominates — terminal rows do not mask it', () => {
    expect(
      callbackUrlLaneFailureOutcome({
        sent: 0,
        attempted: 2,
        alreadyTerminal: 1,
        failures: [{ message: 'boom', timedOut: false }],
        undeliveredRows: 2,
      }),
    ).toEqual({ outcome: 'failed', error: 'boom' });
  });

  test('one delivered + one terminal is still `sent` (the terminal row is not a failure)', () => {
    expect(
      callbackUrlLaneFailureOutcome({
        sent: 1,
        attempted: 2,
        alreadyTerminal: 1,
        failures: noFailures,
        undeliveredRows: 2,
      }),
    ).toBeNull();
  });

  test('nothing claimed because another sender holds the rows stays timeout-unknown', () => {
    expect(
      callbackUrlLaneFailureOutcome({
        sent: 0,
        attempted: 0,
        alreadyTerminal: 0,
        failures: noFailures,
        undeliveredRows: 1,
      }),
    ).toEqual({
      outcome: 'timeout-unknown',
      error: 'every undelivered callback_url is leased by another send or backing off',
    });
  });

  test('timeouts alone keep their own separate outcome', () => {
    expect(
      callbackUrlLaneFailureOutcome({
        sent: 0,
        attempted: 1,
        alreadyTerminal: 0,
        failures: [{ message: 'slow', timedOut: true }],
        undeliveredRows: 1,
      }),
    ).toEqual({ outcome: 'timeout-unknown', error: 'slow' });
  });
});

// ---------------------------------------------------------------------------
// The per-row consequences, against the real database
// ---------------------------------------------------------------------------

const TENANT = 'a0000000-0000-4000-8000-000000000001';
const A_409 = 'a0000000-0000-4000-8000-000000000409';
const A_410 = 'a0000000-0000-4000-8000-000000000410';
const A_500 = 'a0000000-0000-4000-8000-000000000500';
const A_404 = 'a0000000-0000-4000-8000-000000000404';
const A_TIMEOUT = 'a0000000-0000-4000-8000-0000000007f1';
const C_409 = 'a1000000-0000-4000-8000-000000000409';
const C_410 = 'a1000000-0000-4000-8000-000000000410';
const C_500 = 'a1000000-0000-4000-8000-000000000500';
const C_404 = 'a1000000-0000-4000-8000-000000000404';
const C_TIMEOUT = 'a1000000-0000-4000-8000-0000000007f1';

const APPROVALS = [A_409, A_410, A_500, A_404, A_TIMEOUT];

/** A plausible resume URL; the handler only ever redacts it. */
function urlFor(approvalId: string): string {
  return `https://n8n.example.com/webhook-waiting/${approvalId}?signature=s3cret`;
}

async function cleanup(): Promise<void> {
  await queryClient`DELETE FROM approval_callback_urls WHERE approval_id = ANY(${APPROVALS}::uuid[])`;
  await queryClient`DELETE FROM approvals WHERE id = ANY(${APPROVALS}::uuid[])`;
}

interface RowState {
  attempts: number;
  // postgres.js may hand timestamptz back as a Date or as the raw string,
  // depending on the client's type parsers — accept both and normalise below.
  next_attempt_at: Date | string | null;
  delivered_at: Date | string | null;
  last_error: string | null;
}

function epochOf(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

async function rowState(id: string): Promise<RowState> {
  const rows = await queryClient<RowState[]>`
    SELECT attempts, next_attempt_at, delivered_at, last_error
      FROM approval_callback_urls
     WHERE id = ${id}::uuid
  `;
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function approvalErrorMessage(id: string): Promise<string | null> {
  const rows = await queryClient<{ error_message: string | null }[]>`
    SELECT error_message FROM approvals WHERE id = ${id}::uuid
  `;
  expect(rows).toHaveLength(1);
  return rows[0]!.error_message;
}

const { itDb, dbReachable } = createDbSuite('approval-callback-url-terminal');

beforeAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  for (const [approvalId, callbackId] of [
    [A_409, C_409],
    [A_410, C_410],
    [A_500, C_500],
    [A_404, C_404],
    [A_TIMEOUT, C_TIMEOUT],
  ] as const) {
    await queryClient`
      INSERT INTO approvals (id, tenant_id, status, description)
      VALUES (${approvalId}::uuid, ${TENANT}::uuid, 'expired', 'approval-callback-url terminal test')
    `;
    await queryClient`
      INSERT INTO approval_callback_urls (id, approval_id, tenant_id, callback_url)
      VALUES (${callbackId}::uuid, ${approvalId}::uuid, ${TENANT}::uuid, ${urlFor(approvalId)})
    `;
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
});

itDb('HTTP 409 retires the row, records nothing and reports already-terminal', async () => {
  // Capture fr's OWN log line — the distinct marker operators look for.
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(' '));
  };
  let result;
  try {
    result = await handleCallbackUrlSendFailure({
      database: db,
      approvalId: A_409,
      decisionLabel: 'expired',
      callbackId: C_409,
      callbackUrl: urlFor(A_409),
      error: callbackUrlNon2xxError(409, urlFor(A_409)),
    });
  } finally {
    console.log = originalLog;
  }

  expect(result.outcome).toBe('already-terminal');
  expect(
    logs.some((l) => l.includes('[n8n-callback] already-terminal (HTTP 409) — the waiting execution is gone')),
  ).toBe(true);

  const row = await rowState(C_409);
  // RETIRED: delivered_at is the marker every sender/retry lane reads.
  expect(row.delivered_at).not.toBeNull();
  expect(row.next_attempt_at).toBeNull();
  expect(row.last_error).toBeNull();
  // ⛔ NO `scheduleCallbackUrlRetry`: only that function writes next_attempt_at
  // on failure, and it is NULL. attempts is 0 — nothing claimed it here, and the
  // terminal branch must not charge an attempt either.
  expect(row.attempts).toBe(0);
  // ⛔ NO `recordDecisionCallbackProblem`: a moot notice is not a broken one.
  expect(await approvalErrorMessage(A_409)).toBeNull();
});

itDb('HTTP 410 is terminal for the same reason', async () => {
  const result = await handleCallbackUrlSendFailure({
    database: db,
    approvalId: A_410,
    decisionLabel: 'expired',
    callbackId: C_410,
    callbackUrl: urlFor(A_410),
    error: callbackUrlNon2xxError(410, urlFor(A_410)),
  });
  expect(result.outcome).toBe('already-terminal');
  const row = await rowState(C_410);
  expect(row.delivered_at).not.toBeNull();
  expect(row.next_attempt_at).toBeNull();
  expect(await approvalErrorMessage(A_410)).toBeNull();
});

itDb('CONTROL — HTTP 500 still fails, records the problem and schedules the retry', async () => {
  const before = Date.now();
  const result = await handleCallbackUrlSendFailure({
    database: db,
    approvalId: A_500,
    decisionLabel: 'expired',
    callbackId: C_500,
    callbackUrl: urlFor(A_500),
    error: callbackUrlNon2xxError(500, urlFor(A_500)),
  });
  expect(result.outcome).toBe('failed');
  expect(result.message).toContain('HTTP 500');

  const row = await rowState(C_500);
  expect(row.delivered_at).toBeNull();
  expect(row.next_attempt_at).not.toBeNull();
  expect(epochOf(row.next_attempt_at!)).toBeGreaterThan(before);
  expect(row.last_error).toContain('HTTP 500');
  // The problem IS recorded — the exact behaviour that must NOT change.
  const recorded = await approvalErrorMessage(A_500);
  expect(recorded).toContain('callback_url decision callback FAILED');
  expect(recorded).toContain('HTTP 500');
});

itDb('CONTROL — HTTP 404 is not terminal: it may be fr holding the wrong path', async () => {
  const result = await handleCallbackUrlSendFailure({
    database: db,
    approvalId: A_404,
    decisionLabel: 'expired',
    callbackId: C_404,
    callbackUrl: urlFor(A_404),
    error: callbackUrlNon2xxError(404, urlFor(A_404)),
  });
  expect(result.outcome).toBe('failed');
  const row = await rowState(C_404);
  expect(row.delivered_at).toBeNull();
  expect(row.next_attempt_at).not.toBeNull();
});

itDb('CONTROL — a timeout stays timeout-unknown and still schedules the retry', async () => {
  const result = await handleCallbackUrlSendFailure({
    database: db,
    approvalId: A_TIMEOUT,
    decisionLabel: 'expired',
    callbackId: C_TIMEOUT,
    callbackUrl: urlFor(A_TIMEOUT),
    error: new DecisionCallbackTimeout('decision callback abandoned after 5000ms (no response)'),
  });
  expect(result.outcome).toBe('timeout-unknown');
  const row = await rowState(C_TIMEOUT);
  expect(row.delivered_at).toBeNull();
  expect(row.next_attempt_at).not.toBeNull();
  // `last_error` carries the scrubbed failure text; `error_message` carries the
  // OUTCOME UNKNOWN classification — the two are deliberately different columns.
  expect(row.last_error).toContain('abandoned');
  expect(await approvalErrorMessage(A_TIMEOUT)).toContain('OUTCOME UNKNOWN');
});
