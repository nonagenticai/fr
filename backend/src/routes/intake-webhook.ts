// src/routes/intake-webhook.ts
//
// POST /api/intake/webhook/:trigger_id
//
// Inbound webhook for n8n_webhook connector. n8n (or any external source)
// POSTs records here; fr-backend applies payload_mapper + dispatches via
// the configured dispatcher (same dedup path as the cron tick).
//
// Authentication: no bearer token required — the trigger_id UUID acts as
// the shared secret (hard to guess, scoped to one tenant's trigger).
// Optional HMAC verification via x-hmac-sha256 or x-hub-signature-256
// headers when a secret_id is configured on the trigger.
//
// Spec 2 Plan 2-B Track A.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db, userSecrets } from '../db/client';
import { scheduledTriggers, scheduledTriggerRuns } from '../db/schema';
import { compileMapper } from '../lib/payload-mapper';
import { JSONPath } from 'jsonpath-plus';
import { deriveIdempotencyKey } from '../types/intake-envelope';
import { DispatchHttpError, selectDispatcher } from '../connectors/dispatcher';
import { encryption } from '../services/encryption';
import { AppError, BadRequestError, NotFoundError } from '../utils/errors';
import { jsonResponse } from '../utils/response';
import { clientSafeCaughtErrorText } from '../integrations/_lib/errors';
import type { IntakeEnvelope } from '../types/intake-envelope';
import {
  claimIdempotencyKey,
  releaseIdempotencyKeyQuietly,
} from '../domain/engagement/dedup-claim';

// Claim/release are shared with the cron tick (workers/scheduled-trigger-tick)
// via domain/engagement/dedup-claim. This route used to carry a byte-identical
// private copy of both, and the copy carried the same `ON CONFLICT DO NOTHING`
// bug: an EXPIRED row still won the conflict, so the documented 7-day TTL never
// released anything and a claimed record was suppressed permanently.
//
// `releaseIdempotencyKeyQuietly` matters here because the claim is taken BEFORE
// the dispatch attempt and runs on `queryClient`, so it is already committed by
// the time a dispatch fails. Left in place, the sender's retry would dedupe
// against a record that was never delivered.

/**
 * ⚠️ THE SAME CONFUSED DEPUTY AS `workers/scheduled-trigger-tick.ts` (#1030), and
 * this call site is the LOUDER of the two.
 *
 * `secretId` comes from `trigger.connector_config.secret_id`, which the write
 * path (`routes/scheduled-triggers.ts`) validates SHAPE-ONLY — it never checks
 * that the caller owns the secret it names. And this route deliberately loads
 * the trigger with NO TENANT SCOPE ("trigger_id is the auth token", below), so
 * without an ownership predicate a trigger authored by B could name A's secret
 * uuid and every inbound POST would be HMAC-verified against A's key.
 *
 * That is worse than the worker's version of the same bug: the 200-vs-400 at the
 * call site is then an oracle against a secret the caller does not own — submit a
 * body, observe whether the signature verified, and the endpoint answers
 * questions about A's key.
 *
 * The owner comes from the TRIGGER ROW, not from a request context — this route
 * has no authenticated caller by design. Identical predicate to
 * `routes/connectors.ts:101` and to the worker: match the author, or the tenant
 * (fr stores workspace-scope secrets under the tenant uuid). `user_secrets` has
 * no `tenant_id` column; `user_id` IS the owner.
 *
 * Returns `null` for BOTH "no such secret" and "not yours", deliberately — the
 * caller must not be able to distinguish them, and the enclosing branch already
 * refuses rather than accepting an unverified payload.
 */
export async function resolveSecretValue(
  secretId: string,
  owner: { created_by_user_id: string | null; tenant_id: string },
): Promise<string | null> {
  const [row] = await db.select().from(userSecrets).where(eq(userSecrets.id, secretId));
  if (!row) return null;
  if (row.user_id !== owner.created_by_user_id && row.user_id !== owner.tenant_id) {
    return null;
  }
  try {
    return await encryption.decrypt(row.encrypted_value.buffer as ArrayBuffer, row.iv);
  } catch {
    return null;
  }
}

function verifyHmac(body: string, sigHeader: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const provided = sigHeader.replace(/^sha256=/, '');
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch {
    return false;
  }
}

export async function handleIntakeWebhook(req: Request, triggerId: string): Promise<Response> {
  // Load trigger — no tenant scope (trigger_id is the auth token)
  const [trigger] = await db
    .select()
    .from(scheduledTriggers)
    .where(
      and(
        eq(scheduledTriggers.id, triggerId),
        eq(scheduledTriggers.enabled, true),
      ),
    );

  if (!trigger) {
    throw new NotFoundError('Trigger not found');
  }

  const rawBody = await req.text();

  // Optional HMAC verification
  // secret_id is stored inside connector_config (not a top-level column on scheduledTriggers)
  const triggerConfig = trigger.connector_config as Record<string, unknown> | null;
  const secretId =
    typeof triggerConfig?.['secret_id'] === 'string' ? triggerConfig['secret_id'] : null;

  if (secretId) {
    const secretValue = await resolveSecretValue(secretId, {
      created_by_user_id: trigger.created_by_user_id,
      tenant_id: trigger.tenant_id,
    });
    // FAIL CLOSED on an unresolvable secret. This used to be `if (secretValue)`,
    // so a trigger whose owner had explicitly CONFIGURED a secret_id silently
    // downgraded to unauthenticated whenever the secret could not be resolved —
    // `resolveSecretValue` returns null both for a missing row and for a decrypt
    // failure (e.g. after a SECRET_ENCRYPTION_KEY rotation). The two states that
    // matter are "the owner asked for no verification" (secret_id absent, handled
    // by the enclosing `if`) and "the owner asked for verification and we cannot
    // perform it" — and the second must never resolve to "accept anyway".
    //
    // Blast radius, stated plainly: a tenant whose secret row was deleted or
    // whose encryption key rotated now gets 400s on this endpoint instead of
    // silently-unverified intake. That is the correct direction — the same
    // condition previously meant their webhook was accepting unsigned payloads
    // from anyone who knew the trigger id.
    if (!secretValue) {
      console.error(
        `[intake-webhook] configured secret_id ${secretId} could not be resolved (missing row or decrypt failure) — rejecting`,
      );
      throw new BadRequestError(
        'Webhook secret is configured but could not be resolved; re-save the trigger secret',
      );
    }
    const sigHeader =
      req.headers.get('x-hmac-sha256') ??
      req.headers.get('x-hub-signature-256') ??
      '';
    if (!sigHeader) {
      throw new BadRequestError('Missing HMAC signature header');
    }
    if (!verifyHmac(rawBody, sigHeader, secretValue)) {
      throw new BadRequestError('HMAC signature mismatch');
    }
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    throw new BadRequestError('Invalid JSON body');
  }

  // Extract records via expected_records_path
  const recordsPath: string =
    typeof triggerConfig?.['expected_records_path'] === 'string'
      ? (triggerConfig['expected_records_path'] as string)
      : '$';

  let records: unknown[];
  if (recordsPath === '$') {
    records = Array.isArray(payload) ? payload : [payload];
  } else {
    const extracted = JSONPath({ path: recordsPath, json: payload as object, wrap: true });
    records = Array.isArray(extracted) ? extracted : [extracted];
  }

  // Compile payload_mapper
  const mapperObj =
    typeof trigger.payload_mapper === 'object' && trigger.payload_mapper !== null
      ? (trigger.payload_mapper as Record<string, string>)
      : {};
  const compiledMapper = compileMapper(mapperObj);

  const dispatcher = selectDispatcher(process.env);
  const now = new Date();
  let accepted = 0;
  let skipped = 0;
  let failed = 0;
  let firstError: string | null = null;

  // The destination this route has always been documented to POST to (see the
  // module header: "dispatches via the configured dispatcher"). It was never
  // passed, so every dispatch hit WebhookDispatcher's no-URL branch and
  // returned without sending anything — while the audit row below hardcoded
  // status:'ok'. `webhook_url` is a REQUIRED field on N8nWebhookConnectorConfig
  // ("n8n inbound webhook URL fr-backend POSTs to"), so it is present on every
  // well-formed trigger; the cron tick reads it the same way.
  const webhookUrl =
    typeof triggerConfig?.['webhook_url'] === 'string'
      ? (triggerConfig['webhook_url'] as string)
      : undefined;

  for (const record of records) {
    const stableId = createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 32);
    const idempKey = deriveIdempotencyKey({
      trigger_id: trigger.id,
      connector_kind: 'n8n_webhook',
      stable_record_id: stableId,
    });

    const inserted = await claimIdempotencyKey(trigger.tenant_id, idempKey);
    if (!inserted) {
      skipped++;
      continue;
    }

    const mapped = compiledMapper(record);
    const envelope: IntakeEnvelope = {
      idempotency_key: idempKey,
      source: {
        kind: 'n8n_webhook',
        trigger_id: trigger.id,
        fetched_at: now.toISOString(),
      },
      mapped,
      raw_record_id: stableId,
    };

    // Count a record as accepted only if it was actually delivered, and release
    // its idempotency claim otherwise — the claim is written before the attempt
    // (and on queryClient, so it is already committed), so leaving it in place
    // would make the sender's retry dedupe against work that never happened.
    try {
      const outcome = await dispatcher.dispatch(envelope, {
        kind: 'n8n_webhook',
        webhook_url: webhookUrl,
      });
      if (outcome.delivered) {
        accepted++;
      } else {
        failed++;
        firstError ??= `not delivered: ${outcome.reason ?? 'unknown'}`;
        firstError += await releaseIdempotencyKeyQuietly(trigger.tenant_id, idempKey);
      }
    } catch (err) {
      failed++;
      // ⛔ Never the raw text: `firstError` is STORED on
      // `scheduled_trigger_runs.error_message` (the customer's executions table
      // renders it) AND returned to the webhook sender below. A dispatch throw
      // carries raw Postgres or n8n/webhook text (internal hosts, constraint
      // names). The raw error goes to the log line; storage gets fr's sentence.
      // KEPT verbatim: `DispatchHttpError` (fr's sentence about the customer's
      // OWN configured URL, SSRF-guarded to a public host) and any AppError
      // (fr-authored, e.g. SsrfBlockedError) — both are actionable for them.
      console.warn(`[intake-webhook] dispatch failed for trigger ${trigger.id}:`, err);
      firstError ??=
        err instanceof DispatchHttpError || err instanceof AppError
          ? err.message
          : clientSafeCaughtErrorText(err, 'dispatch failed', { forStorage: true });
      firstError += await releaseIdempotencyKeyQuietly(trigger.tenant_id, idempKey);
    }
  }

  // Write audit row. The status is DERIVED, never assumed — this row previously
  // hardcoded 'ok' and reported records_processed for records that were never
  // delivered anywhere.
  await db.insert(scheduledTriggerRuns).values({
    trigger_kind: 'scheduled_intake',
    trigger_id: trigger.id,
    tenant_id: trigger.tenant_id,
    project_id: trigger.project_id,
    fired_at: now,
    finished_at: new Date(),
    status: failed > 0 ? 'partial_failure' : 'ok',
    error_message: firstError,
    kind: 'webhook',
    records_processed: accepted,
  });

  // Nothing got through: answer with a non-2xx so the sender retries instead of
  // believing fr accepted the batch. Returning 200 here is exactly the lie this
  // change exists to remove.
  if (accepted === 0 && failed > 0) {
    return new Response(JSON.stringify({ accepted, skipped, failed, error: firstError }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (accepted === 0 && skipped > 0) {
    // All already seen — 409 to signal full dedup
    return new Response(JSON.stringify({ skipped }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return jsonResponse({ accepted, skipped });
}
