/**
 * `POST /api/client-errors` — ingest for frontend error reports.
 *
 * Why this route exists: the fr frontend container logged ONE line in 30 hours
 * (a startup banner). Every crash, rejected promise and failed API call a user
 * actually experienced was invisible to every measurement anyone has made. The
 * browser half lives in `frontend/src/lib/telemetry/client-errors.ts`; this is
 * the sink that turns those reports into the same structured, one-line-per-event
 * JSON the rest of the backend already emits.
 *
 * The log shape deliberately MIRRORS `routes/assets/_lib/handler.ts`
 * `logIntegrationFailure` — `telemetry` / `code` / `service` / `path` /
 * `correlation_id` — so a client error and the server-side integration failure
 * that may have caused it can be joined on `correlation_id` in one query
 * instead of two.
 *
 * ## Unauthenticated by design, rate-limited to compensate
 *
 * This handler never calls `validateAuth`. An error during login or first paint
 * is exactly the error you most need and exactly the one an authenticated-only
 * sink cannot see — the user has no token yet, so requiring one would blind the
 * sink precisely where it matters most. The route is also added to
 * `FR_LICENSE_EXEMPT_EXACT` so the package-license gate cannot 403 a report from
 * an unlicensed tenant (the gate is already a no-op without a user tenant; the
 * entry makes the intent explicit and regression-tested).
 *
 * What replaces authentication as the abuse control:
 *   - a hard body cap enforced by STREAMING, not by trusting `content-length`
 *   - a per-client fixed-window request cap
 *   - a per-batch event cap
 *   - a strict field allow-list: only known keys are ever logged, so a caller
 *     cannot smuggle an arbitrary payload into our logs
 *
 * Nothing here touches the database. A hostile caller can burn log lines up to
 * the rate cap and nothing else.
 *
 * ## Attribution is RECORDED here, never ENFORCED here
 *
 * Each event carries an `attribution` (`own` / `third_party` / `opaque`) saying
 * whose code the browser thinks failed — see `attributeError` in
 * `frontend/src/lib/telemetry/client-errors.ts`. It is logged so a reader can
 * split fr's own crashes from browser-extension noise in one query. It is NOT
 * used to allocate any budget on this side: the route is unauthenticated, so
 * the field is attacker-controlled and a hostile client would simply stamp
 * `own` on a flood. The budget attribution actually protects is the BROWSER's,
 * which is where the harm was — noise there consumed a deliberately small cap
 * and a real fr error was refused before it ever became a request.
 */

import { getCorrelationId } from '../integrations/_lib/context';
// (No auth import — see the header comment. This route is unauthenticated by design.)

// --- Caps --------------------------------------------------------------------

/** Max accepted request body. A legitimate batch of 25 events is a few KB. */
export const MAX_BODY_BYTES = 64 * 1024;
/** Max events honoured from one batch; the remainder is counted and discarded. */
const MAX_EVENTS_PER_BATCH = 25;
/** Requests per window per client before 429. */
export const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
/**
 * Ceiling on tracked client keys. The key derives from `X-Forwarded-For`, which
 * is attacker-controlled — an unbounded map here would BE the memory DoS this
 * route is supposed to avoid. Past this size the limiter degrades to a single
 * shared bucket rather than growing.
 */
const MAX_TRACKED_CLIENTS = 5_000;

export const MAX_MESSAGE_CHARS = 512;
export const MAX_STACK_CHARS = 4_096;
export const MAX_ROUTE_CHARS = 256;
const MAX_KIND_CHARS = 32;
const MAX_ID_CHARS = 128;

const ALLOWED_KINDS = new Set(['uncaught', 'unhandledrejection', 'svelte', 'api']);

/**
 * Whose code the CLIENT says failed (`frontend/src/lib/telemetry/client-errors.ts`
 * `attributeError`). Recorded so a reader can separate fr's own crashes from
 * browser-extension noise in one log query instead of eyeballing stacks.
 *
 * ⚠️ This value is ADVISORY and is deliberately NOT used for any budgeting or
 * refusal decision here. The route is unauthenticated by design, so the field is
 * attacker-controlled: a hostile caller would simply stamp `own` on a flood. The
 * abuse controls above stay attribution-blind for exactly that reason. The
 * budget that attribution *does* gate is the browser-side one, which is where
 * the harm was — foreign noise there consumed a deliberately small cap and the
 * next genuine fr error was refused before it ever became a request.
 *
 * An absent or unrecognised value becomes `'unknown'`, mirroring `kind`: an old
 * client that sends no attribution must not be silently relabelled `own` (that
 * would invent a measurement) nor `third_party` (that would hide real errors
 * from anyone filtering noise out).
 */
const ALLOWED_ATTRIBUTIONS = new Set(['own', 'third_party', 'opaque']);

// --- Rate limiting -----------------------------------------------------------

interface Bucket {
  windowStart: number;
  count: number;
}

const rateBuckets = new Map<string, Bucket>();
const OVERFLOW_KEY = '\0overflow';
/**
 * When the overflow bucket was last reported, so the signal is emitted once per
 * window rather than once per request. `-Infinity` so the very first overflow
 * reports immediately instead of waiting out a window.
 */
let overflowLastReportedAt = -Infinity;

/**
 * Identify the caller, preferring a value the caller cannot choose.
 *
 * `X-Forwarded-For`'s FIRST hop is whatever the CLIENT sent — a request can
 * carry any value it likes, so an attacker can mint unlimited distinct keys and
 * push the map past MAX_TRACKED_CLIENTS at will. Bounding the map stops the
 * memory DoS but not this one: past the bound every unknown caller shares ONE
 * bucket, so the flood also denies genuine clients (see `checkRateLimit`).
 *
 * `CF-Connecting-IP` is set and OVERWRITTEN by Cloudflare, so a client cannot
 * forge it, and fr's origin is reachable only through the cloudflared tunnel —
 * there is no direct-to-origin path that would skip that rewrite.
 *
 * ⚠️ NOT the RIGHTMOST XFF hop, the usual "trust your own proxy" advice. The
 * path here is Internet → Cloudflare → cloudflared → istio-ingressgateway → fr,
 * and `numTrustedProxies` is unset in meshConfig, so the rightmost entry is the
 * cloudflared POD address — identical for every request in the estate. Keying
 * on it would collapse all users into a single 30/min bucket: an outage, not a
 * hardening.
 *
 * The XFF/x-real-ip fallbacks are unchanged, so behaviour is identical anywhere
 * Cloudflare is not in front (local, in-cluster, tests).
 */
function clientKeyFor(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) {
    const trimmed = cf.trim();
    if (trimmed) return trimmed.slice(0, 64);
  }
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim().slice(0, 64);
  return 'unknown';
}

/** Drop windows that have already expired. Called only when the map is full. */
function evictExpired(now: number): void {
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(key);
  }
}

/**
 * Fixed-window check. Returns whether the request is allowed and, when it is
 * not, how long until the window resets.
 */
function checkRateLimit(key: string, now: number): { allowed: boolean; retryAfter: number } {
  let effectiveKey = key;
  let bucket = rateBuckets.get(effectiveKey);

  if (!bucket && rateBuckets.size >= MAX_TRACKED_CLIENTS) {
    evictExpired(now);
    if (rateBuckets.size >= MAX_TRACKED_CLIENTS) {
      // Still full: fold this caller into one shared bucket. The limiter gets
      // stricter under pressure instead of consuming unbounded memory.
      effectiveKey = OVERFLOW_KEY;
      bucket = rateBuckets.get(effectiveKey);
      // ...and SAY SO. Every unknown caller now shares one 30/min bucket, so
      // genuine client errors are being 429'd and dropped. This route exists to
      // report failures; degrading it silently makes "no client errors" look
      // identical to "the sink is full", which is the exact defect class this
      // file is supposed to close. Once per window, not per request — the point
      // is a signal, and a per-request line under a flood IS the flood.
      if (now - overflowLastReportedAt >= RATE_LIMIT_WINDOW_MS) {
        overflowLastReportedAt = now;
        console.error(
          JSON.stringify({
            telemetry: 'client_error_sink_overflow',
            tracked_keys: rateBuckets.size,
            max_tracked_clients: MAX_TRACKED_CLIENTS,
            shared_bucket_limit_per_window: RATE_LIMIT_MAX,
            window_ms: RATE_LIMIT_WINDOW_MS,
            message:
              'client-error rate-limit map is full; unknown callers now share one bucket and their reports may be dropped',
          }),
        );
      }
    }
  }

  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(effectiveKey, { windowStart: now, count: 1 });
    return { allowed: true, retryAfter: 0 };
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.max(
      1,
      Math.ceil((bucket.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000),
    );
    return { allowed: false, retryAfter };
  }
  bucket.count += 1;
  return { allowed: true, retryAfter: 0 };
}

// --- Body reading ------------------------------------------------------------

type CappedRead =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large' | 'unreadable' };

/**
 * Read the body, refusing past `maxBytes`.
 *
 * Enforced by consuming the stream and bailing mid-flight — `content-length` is
 * only a cheap fast-reject, because it is client-supplied and a chunked request
 * need not send one at all. (Measured: a `new Request(url, {body})` in Bun has
 * NO content-length header, so a content-length-only cap would be entirely
 * vacuous in exactly the tests meant to prove it.)
 */
async function readCappedText(req: Request, maxBytes: number): Promise<CappedRead> {
  const declared = req.headers.get('content-length');
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return { ok: false, reason: 'too_large' };
  }

  const body = req.body;
  if (!body) return { ok: true, text: '' };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling immediately — do not buffer the rest.
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: false }).decode(merged) };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

// --- Normalisation (the field allow-list) ------------------------------------

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

interface NormalizedEvent {
  kind: string;
  message: string;
  stack: string | null;
  path: string | null;
  status: number | null;
  attribution: string;
  event_id: string | null;
  client_ts: string | null;
}

/**
 * Project one client-supplied object onto the allow-list.
 *
 * This is the server-side half of the PII guarantee: whatever else the caller
 * put in the object, only these eight fields can reach a log line. Returns null
 * for anything without a usable message — an event with no message carries no
 * information and would only be log noise.
 */
function normalizeEvent(raw: unknown): NormalizedEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const message = str(o.message, MAX_MESSAGE_CHARS);
  if (message === null) return null;

  const rawKind = str(o.kind, MAX_KIND_CHARS);
  const kind = rawKind !== null && ALLOWED_KINDS.has(rawKind) ? rawKind : 'unknown';

  const rawAttribution = str(o.attribution, MAX_KIND_CHARS);
  const attribution =
    rawAttribution !== null && ALLOWED_ATTRIBUTIONS.has(rawAttribution) ? rawAttribution : 'unknown';

  const statusValue = o.status;
  const status =
    typeof statusValue === 'number' && Number.isInteger(statusValue) && statusValue >= 0 && statusValue <= 599
      ? statusValue
      : null;

  // Strip any query/fragment the client failed to: it can carry OAuth codes.
  let path = str(o.route, MAX_ROUTE_CHARS);
  if (path !== null) {
    const cut = path.search(/[?#]/);
    if (cut !== -1) path = path.slice(0, cut) || null;
  }

  return {
    kind,
    message,
    stack: str(o.stack, MAX_STACK_CHARS),
    path,
    status,
    attribution,
    event_id: str(o.correlation_id, MAX_ID_CHARS),
    client_ts: str(o.ts, 64),
  };
}

function json(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) },
  });
}

// --- Handler -----------------------------------------------------------------

/**
 * Ingest a batch of client error reports.
 *
 * Always terminates in a Response — a malformed or hostile payload is refused,
 * never allowed to throw into the server's 500 path, because a 500 here would
 * itself be a client error and the client would (correctly) try to report it.
 */
export async function handleClientErrors(req: Request): Promise<Response> {
  const now = Date.now();

  const rate = checkRateLimit(clientKeyFor(req), now);
  if (!rate.allowed) {
    return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(rate.retryAfter) });
  }

  const read = await readCappedText(req, MAX_BODY_BYTES);
  if (!read.ok) {
    if (read.reason === 'too_large') {
      return json({ error: 'payload_too_large', max_bytes: MAX_BODY_BYTES }, 413);
    }
    return json({ error: 'invalid_body' }, 400);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json({ error: 'invalid_payload' }, 400);
  }
  const batch = parsed as Record<string, unknown>;
  const rawEvents = batch.events;
  if (!Array.isArray(rawEvents)) {
    return json({ error: 'invalid_payload' }, 400);
  }

  const sessionId = str(batch.session_id, MAX_ID_CHARS);
  const nonNegInt = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  const clientDropped = nonNegInt(batch.dropped);
  const clientDroppedThirdParty = nonNegInt(batch.dropped_third_party);

  const honoured = rawEvents.slice(0, MAX_EVENTS_PER_BATCH);
  const overflow = rawEvents.length - honoured.length;
  const correlationId = getCorrelationId() ?? null;

  let accepted = 0;
  let rejected = overflow;

  for (const raw of honoured) {
    const event = normalizeEvent(raw);
    if (!event) {
      rejected += 1;
      continue;
    }
    accepted += 1;
    try {
      console.error(
        JSON.stringify({
          telemetry: 'client_error',
          code: event.kind,
          service: 'frontend',
          path: event.path,
          status: event.status,
          attribution: event.attribution,
          message: event.message,
          stack: event.stack,
          session_id: sessionId,
          event_id: event.event_id,
          client_ts: event.client_ts,
          correlation_id: correlationId,
        }),
      );
    } catch {
      // Logging must never turn a report into a 500.
    }
  }

  // Surface the CLIENT-side cap. Without this line a runaway loop that the
  // browser correctly refused to send looks identical to no errors at all.
  if (clientDropped > 0) {
    try {
      console.error(
        JSON.stringify({
          telemetry: 'client_error_dropped',
          code: 'client_rate_cap',
          service: 'frontend',
          dropped: clientDropped,
          session_id: sessionId,
          correlation_id: correlationId,
        }),
      );
    } catch {
      // As above.
    }
  }

  // The third-party cap gets its OWN line and its own code, never a field on the
  // line above. They mean opposite things to a reader: `client_rate_cap` is fr
  // signal we lost and is worth paging on; `client_third_party_cap` is browser
  // noise fr cannot fix and is worth ignoring. Folding them into one number is
  // how a metric ends up with two opposite meanings.
  if (clientDroppedThirdParty > 0) {
    try {
      console.error(
        JSON.stringify({
          telemetry: 'client_error_dropped',
          code: 'client_third_party_cap',
          service: 'frontend',
          dropped: clientDroppedThirdParty,
          session_id: sessionId,
          correlation_id: correlationId,
        }),
      );
    } catch {
      // As above.
    }
  }

  return json(
    { accepted, rejected, dropped: clientDropped, dropped_third_party: clientDroppedThirdParty },
    202,
  );
}
