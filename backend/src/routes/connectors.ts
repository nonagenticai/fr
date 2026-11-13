// src/routes/connectors.ts
//
// Spec 2 Plan 2-C Phase 3 Task 3.2 — `POST /api/connectors/test-connection`
// powers the "Test connection" button in
// frontend/src/lib/components/scheduled-triggers/ConnectorForm.svelte.
//
// Contract (request):
//   POST /api/connectors/test-connection
//   Auth: any authenticated user (validateAuth)
//   Body: {
//     kind: 'file' | 'rss' | 'github_query' | 's3' | 'n8n_webhook',
//     config: <ConnectorConfig matching kind>,
//     secret_id?: uuid,    // resolves user_secrets.value via existing AES-GCM
//   }
//
// Contract (response — 200 in both ok=true / ok=false cases; 4xx only on
// auth/validation failures):
//   { ok: true,  sample_count: number, sample: FetchedRecord[] }
//   { ok: false, error: { code: string, message: string } }
//
// Sample truncation: every string field on every sample record is
// capped at 512 characters via `truncateSampleForPreview`. This is
// belt-and-braces against accidental upstream-payload leak — for
// instance, a github issue body that happens to echo the bearer token
// in a comment, or an RSS feed item with a 5MB description.
//
// Telemetry note: the Phase 3 plan suggested appending a row to
// `scheduled_trigger_runs` with status 'dry_run', but that table's
// schema requires `trigger_id` (NOT NULL) and `project_id` (FK NOT NULL).
// A "Test connection" call from the create-trigger form has neither —
// the trigger isn't persisted yet. Adding nullable columns or a
// separate `connector_dry_run_log` table is out of Phase 3 scope per
// memory `feedback-no-backwards-compat-pre-prod.md` — we'd rather
// observe nothing than write an orphan-shaped row that breaks the
// existing tick-worker invariants.

import { reportSwallowedFailure } from '../integrations/_lib/errors';
import { eq } from 'drizzle-orm';
import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import {
  ConnectorConfig,
  isUserConfigurableConnectorKind,
} from '../types/connectors';
import { TestConnectionBody } from './connectors-schemas';
import { getConnector } from '../connectors';
import type { DecryptedSecret, DryRunResult, FetchedRecord } from '../connectors/types';
import { truncateSampleForPreview } from '../connectors/_helpers';
import { db, userSecrets } from '../db/client';
import { encryption } from '../services/encryption';
import { BadRequestError } from '../utils/errors';
import { jsonResponse } from '../utils/response';

// ---------- Body validation ----------------------------------------------

// The body schema lives in `./connectors-schemas` (shared with the fr-agui P4b
// capability declaration, so the declared input IS the route's).

// ---------- Internal helpers ---------------------------------------------

/**
 * Resolve a tenant-scoped user_secrets row to its decrypted value.
 * Returns `null` when the secret is not found OR not owned by the
 * caller's tenant. We do NOT distinguish those cases to the FE — both
 * surface as `MISSING_SECRET` from the connector itself, which keeps
 * authorization opaque (no row-existence oracle).
 *
 * `tenantId` here is the caller's `user.tenantId`. user_secrets is
 * keyed by `user_id` in the schema; in fr's RBAC model, tenant-scope
 * secrets attach to the workspace owner UUID (`user_id`). Same pattern
 * as `workers/scheduled-trigger-tick.ts:resolveSecret()`.
 *
 * ⚠️ CORRECTED (fr#1030). This comment used to end "…but with the
 * tenant-isolation guard added because dryRun is user-driven", which read as
 * the worker not needing one. That rationale was WRONG: the worker's
 * `secret_id` is equally user-driven — it lives inside
 * `scheduled_triggers.connector_config`, written by
 * `POST/PATCH /api/scheduled-triggers` and validated only for SHAPE by
 * `validateConnectorConfig` (routes/scheduled-triggers-shared.ts:65), which
 * never inspects `secret_id` at all. The asymmetry the comment described as
 * deliberate was a latent confused deputy; the worker now carries the same
 * predicate, keyed on the trigger row's `created_by_user_id` / `tenant_id`
 * instead of on request context (a cron tick has none).
 */
async function resolveSecretForTenant(
  secretId: string | undefined,
  user: { id: string; tenantId: string },
): Promise<DecryptedSecret | null> {
  if (!secretId) return null;
  const [row] = await db.select().from(userSecrets).where(eq(userSecrets.id, secretId));
  if (!row) return null;
  // user_secrets has no tenant_id column — `user_id` is the owner. A
  // secret owned by user A's UUID must not be loadable by a different
  // tenant. Compare against the caller's user_id; workspace-scope
  // secrets stored under the tenant UUID will match because in fr
  // tenantId === workspace owner_id for the standard case.
  if (row.user_id !== user.id && row.user_id !== ctxTenantId(user.tenantId)) {
    return null;
  }
  try {
    const value = await encryption.decrypt(
      row.encrypted_value.buffer as ArrayBuffer,
      row.iv,
    );
    return { value };
  } catch (err) {
    // A DECRYPT failure is not a missing secret. Ownership has already been
    // checked and passed by the time we get here, so the row exists AND belongs
    // to the caller — it simply could not be read (a rotated/incorrect
    // ENCRYPTION_KEY, a corrupted ciphertext). Collapsed into the same `null`
    // as "not found", it reaches the user as MISSING_SECRET, and they re-enter
    // a secret that was never missing. After a key rotation that is EVERY
    // secret at once, presented as a mass user error.
    //
    // The FE-facing signal is deliberately left unchanged: the opacity above
    // exists to deny a row-existence oracle, and this catch must not become one
    // by accident. What changes is that the operator can now SEE it — the
    // difference between "one user typo'd a secret id" and "the encryption key
    // is wrong for the whole estate" was previously invisible on both sides.
    reportSwallowedFailure(err, {
      service: 'fr-encryption',
      path: 'connectors.loadSecret',
      degradedTo: 'null (indistinguishable from a missing or unowned secret)',
    });
    return null;
  }
}

/**
 * Validate `config` against the discriminated `ConnectorConfig` schema
 * for the requested `kind`. Throws BadRequestError with a flattened
 * message on failure. Mirrors `validateConnectorConfig` in
 * routes/scheduled-triggers.ts.
 */
function parseConnectorConfig(kind: string, raw: unknown): unknown {
  // Inject `kind` into the candidate config so the discriminated union
  // can route to the right per-kind schema even if the FE forgets to
  // include it (defensive — current FE always includes it).
  const candidate =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>), kind }
      : raw;
  const result = ConnectorConfig.safeParse(candidate);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new BadRequestError(`config invalid: ${msg}`);
  }
  if (result.data.kind !== kind) {
    throw new BadRequestError(
      `config.kind (${result.data.kind}) does not match request kind (${kind})`,
    );
  }
  return result.data;
}

function shapeResponse(result: DryRunResult): {
  ok: boolean;
  sample_count?: number;
  sample?: FetchedRecord[];
  error?: { code: string; message: string };
} {
  if (result.ok) {
    return {
      ok: true,
      sample_count: result.sample_count,
      sample: truncateSampleForPreview(result.sample, 512),
    };
  }
  return { ok: false, error: result.error };
}

// ---------- Handler ------------------------------------------------------

/**
 * POST /api/connectors/test-connection
 *
 * Always returns 200 when auth + body schema pass, with `ok` indicating
 * connector reachability. 401 on auth, 400 on body/config validation
 * failure.
 */
export async function handleTestConnection(req: Request): Promise<Response> {
  const user = await validateAuth(req);

  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  const bodyResult = TestConnectionBody.safeParse(raw);
  if (!bodyResult.success) {
    const msg = bodyResult.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new BadRequestError(`body invalid: ${msg}`);
  }
  const parsed = bodyResult.data;

  // H1: `file` reads the backend pod's own filesystem. Refused BEFORE the
  // config is parsed or any connector runs, so nothing is ever read.
  if (!isUserConfigurableConnectorKind(parsed.kind)) {
    throw new BadRequestError(`connector kind '${parsed.kind}' is not available`);
  }

  const config = parseConnectorConfig(parsed.kind, parsed.config);

  const secret = await resolveSecretForTenant(parsed.secret_id, user);

  const connector = getConnector(parsed.kind as Parameters<typeof getConnector>[0]);
  const result = await connector.dryRun(config, secret);

  return jsonResponse(shapeResponse(result));
}
