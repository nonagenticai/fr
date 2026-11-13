// src/routes/_lib/request.ts
//
// The request-shaped helpers every route file needs, in ONE place.
//
// Why this module exists
// ----------------------
// It did not, and that is how a defect class spread. `readJsonBody` had TEN
// byte-identical definitions across 10 route files (94 callers); the
// integration-error catch wrapper had EIGHT (53 callers) under three different
// names -- `withSyncIntegrationCatch`, `withIntegrationCatch`, `withSyncCatch`.
// Nothing was shared, so nothing could be fixed once. When #903 swept 78 sites
// that reported a caller's mistake as an upstream failure, the reason there
// were 78 was that the same six lines had been pasted 18 times.
//
// A copy is also invisible to review: `services/read-models/_lib.ts` reached
// HTTP 400 by inventing `upstreamStatus: 400` and `service: 'read-model'`, and
// nobody noticed for months because it was one more private helper in one more
// file.
//
// Home, deliberately
// ------------------
// NOT `routes/assets/_lib` -- that is the ASSET domain's library, and
// `routes/research/scientific.ts` already reaches across into it, which is a
// layering smell to shrink rather than grow. NOT `integrations/_lib` -- that is
// the OUTBOUND concern (upstream clients, upstream errors); these helpers are
// about the INBOUND request. `routes/_lib` is neutral to both and is what
// `routes/**` can import without either.
//
// The catch wrapper calls `integrationErrorResponse` BARE, exactly like the 8
// copies it replaces -- this is a consolidation, not a behaviour change. In
// particular it does NOT route through `routes/assets/_lib/handler.ts handle`,
// which also logs: open PR #895 moves that logging INTO
// `integrationErrorResponse` for every caller, so adding it here would
// double-log. See that PR's note on handler.ts.
import type { z } from 'zod';

import {
  IntegrationError,
  integrationErrorResponse,
  isIntegrationError,
} from '../../integrations/_lib/errors';

/**
 * Parse the request body as JSON, refusing a malformed one as the CALLER's
 * error.
 *
 * `BAD_REQUEST` (400), never `UPSTREAM_BAD_BODY` (502): fr has not called
 * anyone at this point, so nothing about a malformed body is upstream. The
 * status is not cosmetic -- Cloudflare replaces origin 5xx bodies with its own
 * HTML so the caller never sees this envelope, `routes/agui.ts` advertises a
 * status-less error as `retriable: true`, and 20 n8n node modules retry on
 * `statusCode >= 500`.
 */
export async function readJsonBody<T = unknown>(req: Request): Promise<T> {
  return (await req.json().catch(() => {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'Invalid JSON request body',
    });
  })) as T;
}

/**
 * Convert an `IntegrationError` thrown anywhere under `fn` into its HTTP
 * envelope. Anything else is rethrown untouched -- a bug must not be laundered
 * into a tidy error response.
 */
export async function withIntegrationCatch(
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (isIntegrationError(err)) return integrationErrorResponse(err);
    throw err;
  }
}

/** Require a non-blank string field on a parsed JSON body. */
export function requireStringField(
  body: Record<string, unknown> | null | undefined,
  field: string,
): void {
  const value = body?.[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: `\`${field}\` is required`,
    });
  }
}

/** Require a non-empty array field on a parsed JSON body. */
export function requireArrayField(
  body: Record<string, unknown> | null | undefined,
  field: string,
): void {
  const value = body?.[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: `\`${field}\` is required`,
    });
  }
}

/**
 * Parse+validate the query string against a zod schema, refusing a bad one as
 * the CALLER's error.
 *
 * `listParams` names query keys that arrive comma-separated and should reach
 * the schema as an array (`?dimensions=a,b` -> `['a','b']`). Without it a
 * schema expecting an array silently sees a string, so a caller that omits the
 * option does not get a subtly different parse -- they get a validation error.
 *
 * Three of the four hand-rolled copies of this collapse into it. The fourth,
 * `routes/tools/coding.ts`, keeps a local adapter on purpose: its argument
 * order is reversed and its message is worded differently, and changing
 * user-visible wire text is a separate decision from removing a duplicate.
 */
export function parseSearchParams<T>(
  schema: z.ZodType<T>,
  req: Request,
  opts?: { listParams?: readonly string[] },
): T {
  const url = new URL(req.url);
  const raw: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams.entries()) {
    raw[k] = opts?.listParams?.includes(k)
      ? v.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
      : v;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    });
  }
  return parsed.data;
}

/**
 * Read the body as JSON AND validate it against a zod schema, in one step.
 *
 * A second, equally duplicated idiom: three byte-identical copies of this lived
 * in kaizen-log.ts, improvement-approvals.ts and
 * assets/streams.ts. It differs from `readJsonBody` only in also parsing, and
 * both failure modes are the caller's -- a malformed body and a body that does
 * not fit the schema are both things the caller can fix.
 *
 * The wire messages are preserved exactly as the four copies had them
 * ('Invalid JSON request body' / 'Validation failed: ...'), because changing
 * user-visible text is a separate decision from removing a duplicate.
 */
export async function readJsonValidated<T>(
  req: Request,
  schema: z.ZodSchema<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'Invalid JSON request body',
    });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: `Validation failed: ${parsed.error.message}`,
    });
  }
  return parsed.data;
}

