// tests/integration/webhooks-budget-threshold.integration.test.ts
//
// POST /api/webhooks/billing/budget-threshold — exercises the handler directly
// against a real fr-postgres (same skip-if-unreachable pattern as the other
// webhook integration tests). Covers: an 80% crossing writes a durable inbox
// row for the tenant's workspace-admins; idempotency (a re-delivered crossing
// does not double-notify); sub-80 crossings are skipped; a tenant with no
// workspace-admin is a no-op 200.
//
// Auth: PLATFORM_BUDGET_WEBHOOK_SECRET is pinned to a deterministic test value
// in tests/setup-env.ts, so signature verification is LIVE here — every request
// below carries a real X-Metering-Signature. (It used to rely on the secret
// being unset so verification was skipped; that fail-open is gone — an unset
// secret now 401s in production.) Two cases at the bottom pin the rejection
// path: unsigned and wrong-signature. The HMAC primitive itself is unit-tested
// in tests/unit/utils/webhook-hmac.test.ts.
import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createHmac } from 'node:crypto';
import { sql as drizzleSql } from 'drizzle-orm';
import {
  db,
  queryClient,
  notifications,
  userRoles,
  budgetAlertReceipts,
} from '../../src/db/client';
import { handleBudgetThresholdAlert } from '../../src/routes/webhooks/budget-threshold';
import { UnauthorizedError } from '../../src/utils/errors';
import { config } from '../../src/config';

import { createDbSuite } from './helpers/db-suite';

const sql = queryClient;

const TENANT_ID = '0b000000-0000-4000-8000-000000000001';
const ADMIN_ID = '0b000000-0000-4000-8000-0000000000aa';
const NO_ADMIN_TENANT_ID = '0b000000-0000-4000-8000-000000000002';

let reachable = false;

async function clean() {
  await db.execute(drizzleSql`DELETE FROM notifications WHERE user_id = ${ADMIN_ID}`);
  await db.execute(drizzleSql`DELETE FROM budget_alert_receipts WHERE budget_id LIKE 'budget-integ%'`);
  await db.execute(drizzleSql`DELETE FROM user_roles WHERE tenant_id = ${TENANT_ID}`);
}

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM budget_alert_receipts LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[webhooks-budget-threshold] DB not reachable, skipping. Apply migrations to fr-postgres first. — ' +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  await clean();
  await db
    .insert(userRoles)
    .values({ user_id: ADMIN_ID, tenant_id: TENANT_ID, role: 'workspace-admin', granted_by: 'system' })
    .onConflictDoNothing();
});

afterAll(async () => {
  if (!reachable) return;
  await clean();
});

beforeEach(async () => {
  if (!reachable) return;
  await db.execute(drizzleSql`DELETE FROM notifications WHERE user_id = ${ADMIN_ID}`);
  await db.execute(drizzleSql`DELETE FROM budget_alert_receipts WHERE budget_id LIKE 'budget-integ%'`);
});

function payload(over: Record<string, unknown> = {}) {
  return {
    event: 'budget.threshold_crossed',
    tenant_id: TENANT_ID,
    budget_id: 'budget-integ-1',
    threshold_pct: 80,
    period_start: '2026-07-01T00:00:00+00:00',
    budget_tokens: 1_000_000,
    consumed_tokens: 832_145,
    usage_pct: 83.21,
    fired_at: '2026-07-19T03:55:00+00:00',
    ...over,
  };
}

// Must match src/utils/webhook-hmac.ts verifyMeteringSignature EXACTLY:
// header `X-Metering-Signature`, value `sha256=` + lowercase hex HMAC-SHA256 of
// the RAW body bytes under the secret. Read from process.env (not `config`) so
// this stays honest even if the config capture ever moves.
const SECRET = process.env.PLATFORM_BUDGET_WEBHOOK_SECRET ?? '';
const sign = (raw: string): string =>
  'sha256=' + createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex');

/**
 * Build a signed request. The signature is over the EXACT string we send —
 * serialise once, sign that string, and pass the same string as the body.
 * Signing `body` and separately re-stringifying it into the Request would be a
 * latent mismatch the moment key order or spacing differed.
 */
function makeReq(body: unknown, signature?: string | null): Request {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // `signature === null` means "send none"; undefined means "sign correctly".
  const sig = signature === undefined ? sign(raw) : signature;
  if (sig !== null) headers['X-Metering-Signature'] = sig;
  return new Request('http://fr/api/webhooks/billing/budget-threshold', {
    method: 'POST',
    headers,
    body: raw,
  });
}

const { itDb } = createDbSuite('webhooks-budget-threshold');

describe('POST /api/webhooks/billing/budget-threshold', () => {
  itDb('an 80% crossing writes an inbox row for the tenant workspace-admin', async () => {
    const res = await handleBudgetThresholdAlert(makeReq(payload()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; recipients: number };
    expect(body.recipients).toBe(1);

    const rows = await db
      .select()
      .from(notifications)
      .where(drizzleSql`user_id = ${ADMIN_ID}`);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.event_type).toBe('budget.threshold');
    expect(row.severity).toBe('warning');
    expect(row.tenant_id).toBe(TENANT_ID);
    expect(row.link).toBe('/admin/budget');
    expect(row.title).toContain('80%');
    expect(row.read_at).toBeNull();
  });

  itDb('is idempotent — a re-delivered crossing does not double-notify', async () => {
    const first = (await (await handleBudgetThresholdAlert(makeReq(payload()))).json()) as {
      recipients: number;
    };
    expect(first.recipients).toBe(1);

    const second = (await (await handleBudgetThresholdAlert(makeReq(payload()))).json()) as {
      deduped?: boolean;
    };
    expect(second.deduped).toBe(true);

    const rows = await db.select().from(notifications).where(drizzleSql`user_id = ${ADMIN_ID}`);
    expect(rows).toHaveLength(1);
  });

  itDb('skips a sub-80% crossing (no inbox row, no receipt)', async () => {
    const res = await handleBudgetThresholdAlert(makeReq(payload({ threshold_pct: 50 })));
    const body = (await res.json()) as { skipped?: string };
    expect(body.skipped).toBe('below_notify_threshold');

    const rows = await db.select().from(notifications).where(drizzleSql`user_id = ${ADMIN_ID}`);
    expect(rows).toHaveLength(0);
    const receipts = await db
      .select()
      .from(budgetAlertReceipts)
      .where(drizzleSql`budget_id = 'budget-integ-1' AND threshold_pct = 50`);
    expect(receipts).toHaveLength(0);
  });

  itDb('a tenant with no workspace-admin is a no-op 200', async () => {
    const res = await handleBudgetThresholdAlert(
      makeReq(payload({ tenant_id: NO_ADMIN_TENANT_ID, budget_id: 'budget-integ-noadmin' })),
    );
    const body = (await res.json()) as { recipients: number };
    expect(body.recipients).toBe(0);
    const rows = await db.select().from(notifications).where(drizzleSql`user_id = ${ADMIN_ID}`);
    expect(rows).toHaveLength(0);
    await db.execute(
      drizzleSql`DELETE FROM budget_alert_receipts WHERE budget_id = 'budget-integ-noadmin'`,
    );
  });

  itDb('rejects a malformed payload at the schema boundary', async () => {
    await expect(
      handleBudgetThresholdAlert(makeReq({ event: 'budget.threshold_crossed', tenant_id: TENANT_ID })),
    ).rejects.toThrow();
  });

  // --- auth boundary -------------------------------------------------------
  // These two need no DB: the signature check runs before any query, so they
  // are plain `test` (not `itDb`) and stay meaningful on a machine without
  // fr-postgres. A perfectly-valid payload is used deliberately — the ONLY
  // reason either is rejected is the signature.

  test('rejects an UNSIGNED request (401) even with a valid payload', async () => {
    const err = await handleBudgetThresholdAlert(makeReq(payload(), null)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as UnauthorizedError).statusCode).toBe(401);
    expect((err as Error).message).toMatch(/signature/i);
  });

  test('rejects a WRONG signature (401)', async () => {
    // Correct format (sha256=<64 hex>), wrong key — proves we verify the HMAC
    // rather than merely checking the header's presence or shape.
    const raw = JSON.stringify(payload());
    const wrong =
      'sha256=' + createHmac('sha256', 'not-the-real-secret').update(raw, 'utf8').digest('hex');
    const err = await handleBudgetThresholdAlert(makeReq(payload(), wrong)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as UnauthorizedError).statusCode).toBe(401);
  });

  // --- the UNSET-secret boundary -------------------------------------------
  // The two cases above both run with a secret configured, so they exercise the
  // signature comparison and NOTHING ELSE. Neither can see a regression in the
  // `if (!secret)` branch — restoring the old `if (secret) { … }` fail-open
  // leaves both of them green. That is precisely the branch this whole change
  // exists to close, so it needs its own coverage. Mutating the exported config
  // singleton is the pattern the repo already uses for env-dependent branches.

  const withConfig = async (
    env: string,
    secret: string,
    fn: () => Promise<void>,
  ): Promise<void> => {
    // `env` and `budgetWebhookSecret` are both declared readonly on Config, so
    // the writes go through one narrow mutable view rather than a cast per line.
    const mutable = config as unknown as {
      env: string;
      services: { billing: { budgetWebhookSecret: string } };
    };
    const prevEnv = mutable.env;
    const prevSecret = mutable.services.billing.budgetWebhookSecret;
    mutable.env = env;
    mutable.services.billing.budgetWebhookSecret = secret;
    try {
      await fn();
    } finally {
      mutable.env = prevEnv;
      mutable.services.billing.budgetWebhookSecret = prevSecret;
    }
  };

  test('an UNSET secret in production is a 401, not a skipped check', async () => {
    await withConfig('production', '', async () => {
      // Deliberately unsigned AND valid: the only reason this can be rejected
      // is that the receiver refuses to run unauthenticated in production.
      const err = await handleBudgetThresholdAlert(makeReq(payload(), null)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(UnauthorizedError);
      expect((err as UnauthorizedError).statusCode).toBe(401);
      expect((err as Error).message).toMatch(/WEBHOOK_AUTH_NOT_CONFIGURED/);
      expect((err as Error).message).toMatch(/PLATFORM_BUDGET_WEBHOOK_SECRET/);
    });
  });

  test('an UNSET secret outside production still skips verification (dev loop)', async () => {
    await withConfig('development', '', async () => {
      // Sub-80% so the handler short-circuits before any DB work — this case is
      // about the auth branch, and must stay meaningful without a database.
      const res = await handleBudgetThresholdAlert(
        makeReq({ ...payload(), threshold_pct: 50 }, null),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ skipped: 'below_notify_threshold' });
    });
  });
});
