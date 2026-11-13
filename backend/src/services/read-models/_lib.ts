// src/services/read-models/_lib.ts
//
// Read-model kit — the shared envelope for the cockpit read-model endpoints
// (project cockpit, control tower;
// design contracts: docs/*proposal.html, plan: AA cockpit implementation).
//
// Every read-model response is a composition of independently-sourced
// BLOCKS. Each block carries its own provenance (`source`), freshness
// (`fetched_at`) and availability — so a composite endpoint degrades
// per-block instead of 500ing when one upstream (worker_management,
// metering, n8n, Planka, …) is down, and the frontend
// renders an explicit "source unavailable" card instead of an error page.
// Data that is computed by joining sources (rather than read from an
// authoritative registry) is labeled `confidence: 'derived'` — honest by
// construction.

import { z } from 'zod';

import {
  IntegrationError,
  isIntegrationError,
  integrationErrorResponse,
  reportSwallowedFailure,
} from '../../integrations/_lib/errors';
import { validateAuth } from '../../middleware/auth';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { parseSearchParams } from '../../routes/_lib';

// ---------------------------------------------------------------------------
// Block envelope
// ---------------------------------------------------------------------------

/** Where a block's data came from (one logical source per block). */
export type BlockSource =
  | 'fr-db'
  | 'planka'
  | 'n8n'
  | 'worker-management'
  | 'metering'
  | 'kag'
  | 'requirements'
  | 'artifacts'
  | 'composed'
  | (string & {});

/**
 * Why a block is unavailable. Lets the UI distinguish an intentional
 * gap/empty/no-selection state from a genuine outage instead of collapsing all
 * of them to "temporarily unavailable" (the F-1 mis-copy):
 *  - 'no_selection' — a card/procedure/project must be picked first
 *  - 'no_data'      — nothing recorded for this selection (empty by design)
 *  - 'data_gap'     — datum not captured upstream yet (data-gap register)
 *  - 'no_evidence'  — the upstream answered, authoritatively, that it holds no
 *                      evidence for this subject (verification card evidence:
 *                      ILS 404 `{"detail":"no evidence for card"}`). Distinct
 *                      from 'error': the source is up and said "nothing".
 *  - 'error'        — a real upstream failure (message sanitized in `error`)
 */
export type UnavailableKind = 'no_selection' | 'no_data' | 'data_gap' | 'no_evidence' | 'error';

export interface BlockMeta {
  source: BlockSource;
  /** ISO timestamp stamped when the block resolved (success or failure). */
  fetched_at: string;
  /** false ⇒ `data` is null and `error` says why (sanitized). */
  available: boolean;
  /**
   * 'derived' marks data computed by joining sources in fr rather than read
   * from an authoritative upstream registry (e.g. fleet KPIs folded over
   * several reads). Omitted ⇒ authoritative.
   */
  confidence?: 'derived';
  /**
   * Present only when `available:false`. Classifies the reason so the frontend
   * renders honest copy per state instead of one generic "temporarily
   * unavailable". Omitted on available blocks.
   */
  unavailable_kind?: UnavailableKind;
  /** Sanitized failure reason — never upstream bodies, URLs, or secrets. */
  error?: string;
  /**
   * Mirror of `unavailable_kind` under the name the verification route
   * contract uses (`meta.unavailable = "no_evidence"`). Set only by the
   * verification card-evidence block.
   */
  unavailable?: 'no_evidence';
  /**
   * A caveat about an AVAILABLE block's completeness that the UI must show,
   * e.g. `"policy unknown"` when a merged sub-source could not be read.
   */
  note?: string;
}

export type Block<T> = { data: T | null; meta: BlockMeta };

/**
 * Run one upstream fetch and NEVER throw: failures become
 * `{ data: null, meta: { available: false, error } }`. IntegrationErrors keep
 * their code+message (already sanitized by the integration layer — no
 * upstreamBody is copied); anything else collapses to 'upstream error' so an
 * unexpected exception cannot leak internals into an API payload.
 */
export async function block<T>(
  source: BlockSource,
  fn: () => Promise<T>,
  opts?: { confidence?: 'derived' },
): Promise<Block<T>> {
  try {
    const data = await fn();
    return {
      data,
      meta: {
        source,
        fetched_at: new Date().toISOString(),
        available: true,
        ...(opts?.confidence ? { confidence: opts.confidence } : {}),
      },
    };
  } catch (err) {
    // ⚠️ ONE line, and it instruments EVERY block() site in the codebase at once
    // — present and future. Added 2026-09-03.
    //
    // `block()` already made the degrade honest TO THE CONSUMER (`available:
    // false` is in the payload, so a caller can tell a dead source from an empty
    // one). It recorded NOTHING for the operator: no log line, no telemetry. So
    // afterwards -- reading logs, ranking failures -- an outage and a genuinely
    // empty result were still byte-identical, which is the half of this defect
    // family that keeps it invisible for months.
    //
    // Fixing it here rather than at each call site is the point: the alternative
    // was ~20 per-site edits that the next copy-paste of the idiom would skip.
    // Behaviour, response shape and `meta` are untouched.
    reportSwallowedFailure(err, {
      service: source,
      degradedTo: `block(${source}) -> available:false`,
    });
    return {
      data: null,
      meta: {
        source,
        fetched_at: new Date().toISOString(),
        available: false,
        ...(opts?.confidence ? { confidence: opts.confidence } : {}),
        unavailable_kind: 'error',
        error: isIntegrationError(err) ? `${err.code}: ${err.message}` : 'upstream error',
      },
    };
  }
}

/** Wrap already-loaded data (e.g. a row the route's gate fetched) as a block. */
export function availableBlock<T>(
  source: BlockSource,
  data: T,
  opts?: { confidence?: 'derived' },
): Block<T> {
  return {
    data,
    meta: {
      source,
      fetched_at: new Date().toISOString(),
      available: true,
      ...(opts?.confidence ? { confidence: opts.confidence } : {}),
    },
  };
}

/**
 * A block that resolved unavailable for a KNOWN reason (not a thrown upstream
 * failure — that path is `block()`, which stamps `kind:'error'`). `kind`
 * classifies it so the UI shows honest per-state copy instead of a generic
 * outage line:
 *  - 'data_gap' (default) — no upstream source yet (data-gap register)
 *  - 'no_selection'       — a card/procedure/project must be picked first
 *  - 'no_data'            — nothing recorded for this selection (empty by design)
 */
export function unavailableBlock<T = never>(
  source: BlockSource,
  reason: string,
  kind: UnavailableKind = 'data_gap',
): Block<T> {
  return {
    data: null,
    meta: {
      source,
      fetched_at: new Date().toISOString(),
      available: false,
      unavailable_kind: kind,
      error: reason,
    },
  };
}

// ---------------------------------------------------------------------------
// Router helpers
// ---------------------------------------------------------------------------

/**
 * Parse+validate URL query params against a zod schema. Throws an
 * IntegrationError that `integrationErrorResponse` maps to HTTP 400.
 *
 * This used to say `UPSTREAM_BAD_STATUS` + `service: 'read-model'` +
 * `upstreamStatus: 400`, and its docstring argued that was deliberate: it got
 * the right STATUS while dodging `UPSTREAM_BAD_BODY`'s 502. The status was
 * right and everything else was invented -- an upstream status for an upstream
 * that was never called, and a service name for a service that was never
 * contacted. It is the same fabricated-attribution shape that #903's audit
 * found four times in routes/tools/analytics.ts.
 *
 * It also sat in the blind spot of the guard meant to catch exactly this:
 * R1 keys on a message lexicon and this message is built from
 * `parsed.error.issues`, an idiom deliberately left OUT of the lexicon because
 * zod parses upstream responses too; R2 keys on `upstreamStatus === undefined`,
 * and a fabricated literal is not undefined. Double-exempt. The guard is
 * tightened in the next commit so this cannot recur.
 */
export function parseQuery<T>(schema: z.ZodType<T>, req: Request): T {
  return parseSearchParams(schema, req);
}

/** Minimal authed-subject shape the read-model gates need. */
export interface ReadModelUser {
  id: string;
  tenantId: string;
  roles: readonly string[];
}

/**
 * Super-admin gate for the admin read models (/api/admin/control-tower,
 * /api/admin/improvement/*). Non-super-admins get the SAME 404 shape as
 * `requireInternalTenant` (middleware/internal-tenant-only.ts) — 404, not
 * 403, so the existence of the operator surface stays private from regular
 * tenants.
 */
export function requireSuperAdminRead(user: { roles?: readonly string[] } | undefined): void {
  if (!isSuperAdmin(user)) {
    throw new IntegrationError({
      code: 'UPSTREAM_NOT_FOUND',
      message: 'Not found',
      service: 'read-model',
    });
  }
}

/**
 * Thin-router wrapper: authenticate, run the handler, map IntegrationErrors
 * (gate 404s, parseQuery 400s) to their JSON responses. Aggregator-level
 * upstream failures never surface here — `block()` swallows them into
 * `available:false` — so anything else escaping is a real bug and rethrows.
 */
export async function runReadModel(
  req: Request,
  fn: (user: ReadModelUser) => Promise<Response>,
): Promise<Response> {
  try {
    const user = await validateAuth(req);
    return await fn({ id: user.id, tenantId: user.tenantId, roles: user.roles });
  } catch (err) {
    if (isIntegrationError(err)) return integrationErrorResponse(err);
    throw err;
  }
}
