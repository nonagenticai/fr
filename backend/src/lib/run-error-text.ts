/**
 * Client-safe run-error text for `scheduled_trigger_runs.error_message` and the
 * parent `scheduled_triggers.last_run_error`.
 *
 * WRITE path (`storedRunErrorText`): the tick worker and the intake webhook
 * store fr's OWN sentences verbatim (they are actionable: a bad cron, a missing
 * destination, the customer's own webhook URL answering 404) and replace every
 * other caught error with a generic sentence; the raw text goes to the log.
 *
 * READ path (`clientSafeRunErrorText`): rows written before that fix hold raw Postgres / fetch / upstream text. A stored string carries no proof
 * of who wrote it, so a non-super-admin reader only sees text whose SHAPE is
 * one fr writes (the allowlist below); anything else reads as a generic
 * sentence. Fail-closed: a new fr sentence that is not on the list is hidden
 * from customers until it is added, never the other way round. The column
 * itself is untouched — operators triage from it.
 */
import {
  clientSafeCaughtErrorText,
  shouldRedactUpstreamDetailForCaller,
} from '../integrations/_lib/errors';
import { AppError } from '../utils/errors';

/** An fr-authored trigger-configuration defect: stored verbatim. */
export class TriggerConfigError extends Error {
  override readonly name = 'TriggerConfigError';
}

/** Generic READ-path sentence for a run error a customer may not see. */
export const RUN_ERROR_REDACTED = 'The run failed — the detail is available to an operator';

/** Prefix the tick puts on a connector_config schema failure (zod issue text). */
export const CONNECTOR_CONFIG_INVALID_PREFIX = 'connector_config invalid: ';

const IDEMP_SUFFIX = '(?:; idempotency key not released)?';
/**
 * The tail fr appends after its own prefix when the tail is library text it
 * relays on purpose (cron-parser / Intl for a bad cron or timezone, zod issue
 * messages for connector_config): ONE line, bounded, ending the string. Matching
 * the whole sentence — not just the prefix — keeps a multi-line raw payload
 * (stack traces, SQL, upstream bodies) from riding in behind an fr prefix.
 */
const ONE_LINE_TAIL = '[^\\r\\n]{1,500}';

/** The two fr prefixes whose tail is relayed LIBRARY text (cron-parser / Intl, zod). */
const LIBRARY_TAIL_PREFIXES = ['invalid cron/timezone: ', CONNECTOR_CONFIG_INVALID_PREFIX] as const;

/**
 * ⛔ DENY-BY-DEFAULT INSIDE A LIBRARY TAIL (FR-7). Being ONE bounded line is not
 * enough: `invalid cron/timezone: connect ECONNREFUSED 10.43.0.10:5432` and
 * `connector_config invalid: fetch http://kag.example.com:8000 failed` are one line
 * each and passed verbatim. A tail is relayed only when it is drawn from the
 * character set cron-parser / Intl / zod messages actually use AND names no
 * host, URL, address, port or e-mail. Anything else keeps the fr prefix (the
 * KIND of defect is still actionable) and loses the tail.
 */
const SAFE_TAIL_CHARS = /^[A-Za-z0-9 _,;:'"()[\]{}<>=+*#?!.\/-]{1,500}$/;
const TAIL_FORBIDDEN: readonly RegExp[] = [
  /:\/\//, // a URL scheme
  /@/, // an e-mail / userinfo
  /[A-Za-z0-9-]\.[A-Za-z]/, // a dotted name (host, svc, file, module path)
  /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/, // an IPv4 literal
  /[A-Za-z0-9]:\d{2,5}\b/, // host:port
];

function isSafeLibraryTail(tail: string): boolean {
  return SAFE_TAIL_CHARS.test(tail) && !TAIL_FORBIDDEN.some((re) => re.test(tail));
}

/** `invalid cron/timezone: …` / `connector_config invalid: …` with an unsafe tail → prefix only. */
function rewriteLibraryTail(text: string): string | null {
  for (const prefix of LIBRARY_TAIL_PREFIXES) {
    if (text.startsWith(prefix) && !isSafeLibraryTail(text.slice(prefix.length))) {
      return `${prefix}the detail is available to an operator`;
    }
  }
  return null;
}
const WEBHOOK_DISPATCH = 'WebhookDispatcher: \\S+ returned HTTP \\d{3}';

/**
 * The shapes fr itself writes into a run-error column. Anchored on BOTH ends
 * where the tail is fr-built, so raw text cannot ride on an fr prefix.
 */
const FR_AUTHORED_RUN_ERROR: readonly RegExp[] = [
  // tick: config defects
  new RegExp(`^invalid cron/timezone: ${ONE_LINE_TAIL}$`),
  /^no destination configured: [a-z_]+$/,
  /^Unknown connector kind: [A-Za-z0-9_-]*$/,
  /^payload_mapper error: mapper key '[^'\r\n]*' (must start with \$|uses forbidden operator)$/,
  new RegExp(`^${CONNECTOR_CONFIG_INVALID_PREFIX}${ONE_LINE_TAIL}$`),
  // tick: dispatch outcomes (the URL is the customer's own, SSRF-guarded)
  new RegExp(`^record \\S+ not delivered: [a-z_]+${IDEMP_SUFFIX}$`),
  new RegExp(`^${WEBHOOK_DISPATCH}${IDEMP_SUFFIX}$`),
  new RegExp(
    `^(auto-disabled after \\d+ consecutive permanent HTTP \\d{3} responses from the dispatch target — this trigger will not run again until it is fixed and re-enabled|permanent HTTP \\d{3} from the dispatch target \\(\\d+ of \\d+ consecutive before this trigger is auto-disabled\\)): ${WEBHOOK_DISPATCH}${IDEMP_SUFFIX}$`,
  ),
  // SSRF guard (utils/ssrf-guard.ts): only the one sentence that carries no
  // host, address or resolver text passes verbatim. Every other guard sentence
  // is REWRITTEN (SSRF_REWRITES below), never passed through.
  new RegExp(`^URL has no host${IDEMP_SUFFIX}$`),
  // H3: the guard's ONE current sentence (utils/ssrf-guard.ts
  // SSRF_BLOCKED_MESSAGE) carries no detail at all, so it passes verbatim.
  new RegExp(`^destination not allowed${IDEMP_SUFFIX}$`),
  // the generic sentences the writers substitute
  new RegExp(`^(dispatch failed|source fetch failed|trigger run failed)${IDEMP_SUFFIX}$`),
];

/** Customer-facing sentences for the SSRF guard's refusals. */
export const SSRF_NON_PUBLIC_TEXT = 'refused to fetch: the URL resolves to a non-public address';
export const SSRF_UNRESOLVABLE_TEXT = "could not resolve the URL's host";
export const SSRF_INVALID_URL_TEXT = 'refused to fetch: the URL is not a valid absolute URL';
export const SSRF_SCHEME_TEXT = 'refused to fetch: only http and https URLs may be fetched';

/**
 * The SSRF guard's sentences name the host, the address it resolved to, or the
 * resolver's own error text. Passed through verbatim they are an oracle: a
 * customer points a trigger at `postgres.example.com` and reads back the internal
 * address it resolves to. Each shape is matched IN FULL (anchored on both ends,
 * host/address fields constrained) and rewritten to a fixed sentence that keeps
 * only the KIND of refusal; the idempotency suffix the tick appends survives.
 */
const HOST = '[^"\\s]*';
const ADDR = '[0-9A-Fa-f:.]+';
const SSRF_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(`^refusing to fetch "${HOST}": it resolves to non-public address ${ADDR}(${IDEMP_SUFFIX})$`), SSRF_NON_PUBLIC_TEXT],
  [new RegExp(`^refusing to fetch a non-public address: ${HOST}(${IDEMP_SUFFIX})$`), SSRF_NON_PUBLIC_TEXT],
  [new RegExp(`^cannot resolve host "${HOST}": [\\s\\S]*?(${IDEMP_SUFFIX})$`), SSRF_UNRESOLVABLE_TEXT],
  [new RegExp(`^host "${HOST}" resolved to no addresses(${IDEMP_SUFFIX})$`), SSRF_UNRESOLVABLE_TEXT],
  [new RegExp(`^not a valid absolute URL: [\\s\\S]*?(${IDEMP_SUFFIX})$`), SSRF_INVALID_URL_TEXT],
  [new RegExp(`^scheme "[A-Za-z][A-Za-z0-9+.-]*:" is not allowed; only http and https may be fetched(${IDEMP_SUFFIX})$`), SSRF_SCHEME_TEXT],
];

/** The customer-safe rewrite of an SSRF-guard sentence, or null when `text` is not one. */
function rewriteSsrfRunError(text: string): string | null {
  for (const [re, sentence] of SSRF_REWRITES) {
    const m = re.exec(text);
    if (m) return sentence + (m[1] ?? '');
  }
  return null;
}

/** True when `text` passes to a customer VERBATIM (a rewritten SSRF sentence does not). */
export function isFrAuthoredRunError(text: string): boolean {
  for (const prefix of LIBRARY_TAIL_PREFIXES) {
    if (text.startsWith(prefix) && !isSafeLibraryTail(text.slice(prefix.length))) return false;
  }
  return FR_AUTHORED_RUN_ERROR.some((re) => re.test(text));
}

/** READ path. `null` stays `null` ("no error" vs "an error you may not see"). */
export function clientSafeRunErrorText(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (!shouldRedactUpstreamDetailForCaller()) return raw;
  const ssrf = rewriteSsrfRunError(raw);
  if (ssrf !== null) return ssrf;
  if (isFrAuthoredRunError(raw)) return raw;
  return rewriteLibraryTail(raw) ?? RUN_ERROR_REDACTED;
}

/** Rewrite the run-error fields of a row a customer is about to receive. */
export function clientSafeRunErrorRow<T extends object>(row: T): T {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const key of ['error_message', 'last_run_error'] as const) {
    if (key in out) out[key] = clientSafeRunErrorText(out[key] as string | null | undefined);
  }
  return out as T;
}

/**
 * WRITE path. fr's own errors keep their text; anything else becomes
 * `fallback` (an IntegrationError gets its per-status generic text) and the raw
 * error is logged under `where`. Always redacts regardless of the CURRENT
 * caller (the writer is a worker or a webhook sender; the reader is a customer).
 */
export function storedRunErrorText(err: unknown, fallback: string, where: string): string {
  if (
    err instanceof TriggerConfigError ||
    err instanceof AppError ||
    // duck-typed for the same cross-module reason as isPermanentDispatchError
    (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'DispatchHttpError')
  ) {
    return (err as Error).message;
  }
  console.warn(`[${where}] run failed:`, err);
  return clientSafeCaughtErrorText(err, fallback, { forStorage: true });
}
