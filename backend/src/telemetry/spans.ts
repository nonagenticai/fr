/**
 * Telemetry span helper.
 *
 * Wave-1 introduced this as a no-op wrapper that structured-logs span lifecycle
 * events to stdout. Wave-3 (analytics slice) replaces the body with a dual
 * emitter: keep the structured log line (downstream log collectors still index
 * it) AND emit a real OpenTelemetry span when an OTLP endpoint is configured.
 *
 * The exported signature `emitSpan(name, attributes, fn)` is FROZEN. No caller
 * is changed — this is a body-only swap. New attributes go in `SpanAttributes`.
 *
 * OTel destination: cluster Tempo via the OTel collector. Endpoint resolved
 * from `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`).
 * When neither env is set the OTel side is a no-op — the structured log line
 * is the only output, matching the Wave-1 behavior. This keeps `bun test` and
 * any cluster-less dev loop from needing a collector.
 *
 * Common attribute keys per spec §10 ("Common attributes on every span"):
 *   user.id, tenant.id, project.id, correlation.id, initiator, channel,
 *   outcome, duration_ms.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE OTel HALF IS CURRENTLY INERT. THE STDOUT LINE IS THE ONLY REAL SINK.
 *
 * Measured 2026-09-26, and worth re-measuring rather than trusting: fr-backend
 * configures NO OTLP exporter anywhere.
 *   - `grep -rn OTEL clusters/prod/services/fr/` → 0 hits,
 *     deployment.yaml and its envFrom keys included (SOPS leaves keys in
 *     plaintext, so an encrypted secrets.yaml is still covered by that grep).
 *   - zero `OTEL_` in any yaml / env / Dockerfile in THIS repo.
 * ⇒ `otel.ts initOnce()` takes its `if (!endpoint) return` branch
 * ⇒ `getTracer()` returns the @opentelemetry/api NO-OP tracer
 * ⇒ every `otelSpan.*` call below is a no-op in production and NO trace leaves
 *   this process. `writeSpanLine`'s stdout JSON is the only output anyone reads.
 *
 * ⛔ Do NOT read that as permission to leave the OTel calls unfalsifiable. They
 * were: deleting BOTH completion-time `setAttributes(toOtelAttrs(baseAttrs,
 * strip(attributes)))` calls left tests/unit/telemetry/spans.test.ts at
 * `14 pass / 0 fail / 44 expect()` — byte-identical. That is the SAME defect
 * class as the `dedup_hit_count` this change fixes: a line that looks like it
 * does work and cannot be shown to. They are now gated by a stub tracer
 * provider (`describe('emitSpan → OTel span (stub tracer provider)')`), which
 * also pins the inertness itself, so this paragraph is asserted rather than
 * merely believed. Deleting either call now fails a test.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⛔ CONSTRAINT ON CALLERS: ATTRIBUTE VALUES MUST BE SCALARS, AND THE COMPLETION
 * RE-READ WIDENED WHAT THAT PROMISE COVERS.
 *
 * Before this change the completion lines spread a snapshot taken BEFORE `fn()`,
 * so the ONLY keys that could ever be emitted were the ones the caller opened
 * the span with — a fixed, reviewable set visible at the call site. The
 * completion lines now re-read the caller's LIVE object, so a key that did not
 * exist at span open escapes too: whatever a handler assigns onto its attrs
 * object mid-flight is published to stdout (and to the SDK, when one exists).
 *
 * ⚠️ No leak exists today — all SIX named-object call sites were checked and
 * none writes a secret, token, tenant id, or unbounded value onto its attrs.
 * This is a LATENT constraint, not a live defect, and it is recorded here
 * because the widening is invisible at the call sites that benefit from it.
 *
 * ⭐ SIX, NOT FIVE — and WHY the number was wrong three independent times (the
 * original author, the first audit, and the follow-up brief all said five) is
 * worth more than the number itself. Measured 2026-09-26 by PARSING the second
 * argument of every `emitSpan` call under `src/`: 72 pass an inline object
 * literal, 6 pass a named object ⇒ 78, which independently corroborates the
 * 78-call-site figure quoted in `toScalar` below.
 *   domain/bridge/drafts.ts:177                 MUTATES (dedup_hit_count, :270)
 *   routes/tools/bridge.ts:202                  MUTATES (count, dedup_known_count, :253-254)
 *   routes/tools/bridge.ts:590                  MUTATES (count, truncated, :601-602)
 *   channels/index.ts:441                       MUTATES (action, via dispatchInbound :239)
 *   agui/registry.ts:338                        never mutates its attrs
 *   domain/engagement/action-approvals.ts:503   never mutates its attrs
 *
 * ⛔ WHY A GREP MISSED THE LAST TWO. They are invisible to the obvious search in
 * TWO independent ways, and either one alone is enough to hide them:
 *   (a) both pass `action.name` as the span NAME — an IDENTIFIER, not a string
 *       literal — so any sweep anchored on `emitSpan('…'` skips them; and
 *   (b) `agui/registry.ts:338` is additionally MODULE-QUALIFIED AND GENERIC,
 *       `spansModule.emitSpan<O | PendingAction>(action.name, spanAttrs, …)`,
 *       so even a sweep keyed on a bare `emitSpan(` token misses it. The first
 *       parser written for THIS correction reported 5 for exactly that reason,
 *       and only (b) explained the gap.
 * ⇒ Enumerate these by the ARGUMENT SHAPE, never by the call spelling.
 *
 * ⚠️ Neither newly-found site mutates its attrs object, so NOTHING about the
 * emitted output changed when they were found. The count in this comment was
 * wrong; the behaviour was not.
 *
 * So, for anything assigned onto a span attrs object:
 *   1. SCALARS ONLY — string | number | boolean | null | undefined, per
 *      `SpanAttributeValue`. `attrs.raw_body = {...}` is a contract violation;
 *      see the runtime guard in `toScalar` below, which now catches it, because
 *      the TYPE alone did not (an `as` cast or a `Record<string, unknown>` value
 *      reaches here unchecked, and the completion re-read is where it would land).
 *   2. BOUNDED CARDINALITY AND BOUNDED SIZE — counts, flags, enum-like names.
 *      Never a free-text field, never a user-supplied string.
 *      ⚠️ Only the SIZE half has a runtime backstop: `toScalar` truncates any
 *      string longer than `MAX_ATTR_STRING_CHARS` and appends a marker naming
 *      the ORIGINAL length, so the length is still reportable after the value
 *      is not. CARDINALITY is NOT enforced and cannot be from here — a
 *      distinct-but-short value per request (a uuid, an email, a correlation
 *      id) passes the cap untouched and still explodes a time-series index.
 *      That half remains a convention callers must honour.
 *   3. NOTHING SENSITIVE — no credential, token, password, bearer, cookie,
 *      request body, or PII. A span line is shipped to log collectors and, once
 *      an exporter is configured, to Tempo.
 *      ⛔ THIS RULE IS A CONVENTION, NOT AN ENFORCED INVARIANT, and nothing in
 *      this file makes it one. There is no key-name denylist, no allowlist and
 *      no value inspection: a short credential under a well-chosen key name is
 *      indistinguishable here from a legitimate enum value. ⚠️ And the rule-2
 *      truncation does NOT stand in for it — truncation keeps the FIRST
 *      characters, so a secret short enough to fit, or one whose leading bytes
 *      are the sensitive part, survives verbatim. MEASURED rather than hedged:
 *      a 200,000-character string carrying a sentinel used to escape IN FULL
 *      and now escapes TRUNCATED — bounded, still leaked. Rule 3 is enforced at
 *      REVIEW OF THE CALL SITE. Do not read the rule-1 and rule-2 guards below
 *      as covering it.
 *
 * ⭐ TWO UNCLAIMED IMPROVEMENTS the scalar guard also bought, recorded because
 * nothing in the commit message claims them and a future reader would otherwise
 * have to re-derive them. A `bigint` value and a CIRCULAR object value each used
 * to make `JSON.stringify` inside `writeSpanLine` THROW outright — MEASURED
 * 2026-09-26: `TypeError: JSON.stringify cannot serialize BigInt` and
 * `… cannot serialize cyclic structures`. On the completion path that throw
 * destroyed the span line AND, because it happens inside the try, the caller's
 * successful result with it. Both are now bounded markers
 * (`[unsupported:bigint]`, `[unsupported:object]`). That is a robustness gain,
 * not only a redaction.
 */

import { redactAttribute } from '../capabilities/redact';
import { getCorrelationId, getInitiator, getChannel } from '../integrations/_lib/context';
import { getTracer } from './otel';

export type SpanAttributeValue = string | number | boolean | null | undefined;

export interface SpanAttributes {
  [key: string]: SpanAttributeValue;
}

/**
 * ⛔ RUNTIME BACKSTOP FOR RULE 2 (BOUNDED), SIZE HALF ONLY. Any attribute string
 * longer than this is truncated by `toScalar` and marked with its original
 * length. It exists because rule 2 was pure prose while rule 1 had a guard: a
 * 200,000-character value used to reach stdout, and the OTel SDK, verbatim.
 *
 * 512 is deliberately generous — every attribute value in `src/` today is a
 * count, a flag, an enum-like name or an id, all far below it — so the cap is a
 * ceiling on the pathological case and NOT a behaviour change for any existing
 * call site. ⚠️ It bounds SIZE, not CARDINALITY, and it is NOT a redaction:
 * truncation keeps the FIRST characters. See rule 3 in the header.
 */
export const MAX_ATTR_STRING_CHARS = 512;

interface SpanLogLine {
  telemetry: 'span';
  name: string;
  status: 'start' | 'ok' | 'error';
  duration_ms?: number;
  correlation_id?: string;
  initiator?: string;
  channel?: string;
  error_name?: string;
  error_message?: string;
  attributes: SpanAttributes;
}

function writeSpanLine(line: SpanLogLine): void {
  // Structured JSON so downstream log collectors can index. Status: start /
  // ok / error lets a collector compute duration without re-parsing.
  if (line.status === 'error') {
    console.error(JSON.stringify(line));
  } else {
    console.log(JSON.stringify(line));
  }
}

/**
 * Filter undefined/null out before handing attrs to the OTel SDK — the SDK
 * accepts only string/number/boolean/array values, and silently coerces
 * undefined to "undefined" (which would pollute the trace UI).
 */
function toOtelAttrs(
  baseAttrs: Pick<SpanLogLine, 'correlation_id' | 'initiator' | 'channel'>,
  spanAttrs: SpanAttributes,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (baseAttrs.correlation_id) out['correlation.id'] = baseAttrs.correlation_id;
  if (baseAttrs.initiator) out['initiator'] = baseAttrs.initiator;
  if (baseAttrs.channel) out['channel'] = baseAttrs.channel;
  for (const [k, v] of Object.entries(spanAttrs)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

export async function emitSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: () => Promise<T>,
): Promise<T> {
  const baseAttrs: Pick<SpanLogLine, 'correlation_id' | 'initiator' | 'channel'> = {
    correlation_id: getCorrelationId(),
    initiator: getInitiator(),
    channel: getChannel(),
  };

  // Strip any caller-supplied `outcome` so we don't lie in the log/OTel
  // attributes when the inner fn throws. The success/error path below sets
  // outcome authoritatively. (Several callers historically passed
  // `outcome: 'ok'` up-front; that produced `status: error` log lines whose
  // attributes block still claimed `outcome: 'ok'`.) Copy locally — never
  // mutate the caller's object.
  /**
   * ⛔ RUNTIME SCALAR BACKSTOP. `SpanAttributes` already types values as
   * scalars-only, and measured 2026-09-26 NO call site violates it: all 78
   * `emitSpan` call sites in `src/` pass provably scalar values, `bunx tsc
   * --noEmit` is clean under `"strict": true`, and none of the 28 call-site
   * files contains `as any` / `: any` / `@ts-ignore` / `@ts-expect-error`. So
   * this is a no-op on every path that exists today, by type proof as well as
   * by inspection.
   *
   * It exists because the completion re-read WIDENED what the type protects.
   * Previously only keys present at span open could be emitted — a fixed set,
   * visible at the call site, reviewable there. Now any key a handler assigns
   * mid-flight is published, and an `as` cast or a `Record<string, unknown>`
   * value would arrive HERE rather than at a reviewed call site. `attrs.raw_body
   * = { password: '…' }` is the shape that matters: the type forbids it, nothing
   * enforced it, and `toOtelAttrs` filters only null/undefined — so it would
   * have reached both the stdout line (via JSON.stringify, in full) and the SDK.
   *
   * A non-scalar is replaced by a bounded MARKER rather than dropped: dropping
   * silently would hide the contract violation, and the marker names only the
   * TYPE, never the content — so the value cannot leak through it. Bounded
   * cardinality (one string per typeof), so it is safe as a trace attribute.
   *
   * ⚠️ `null` and `undefined` pass through UNCHANGED and deliberately. They are
   * the "not measured yet" signal this whole change depends on: `toOtelAttrs`
   * drops them for the SDK, while the stdout line must keep JSON `null` (pinned
   * by tests/integration/bridge-list-drafts.integration.test.ts, which asserts
   * the start line's `count` is null). Marking them would destroy that.
   */
  const toScalar = (v: SpanAttributeValue | unknown, key = ''): SpanAttributeValue => {
    if (v === null || v === undefined) return v as SpanAttributeValue;
    const t = typeof v;
    if (t === 'string') {
      // Rule 2's size backstop. The marker names the ORIGINAL length so the
      // measurement survives even though the value does not.
      // fr-agui SPEC §10.1 (d): a span attribute never carries a secret-shaped
      // value (token prefixes, JWTs, credentials in URLs, …) nor an unmasked PII
      // key (`*.approver_email`, …) — redacted here, at the one place every
      // attribute passes (capabilities/redact.ts redactAttribute).
      const s = redactAttribute(key, v as string);
      return s.length <= MAX_ATTR_STRING_CHARS
        ? s
        : `${s.slice(0, MAX_ATTR_STRING_CHARS)}[truncated:${s.length}]`;
    }
    if (t === 'number' || t === 'boolean') {
      return v as SpanAttributeValue;
    }
    return `[unsupported:${Array.isArray(v) ? 'array' : t}]`;
  };

  /**
   * Drop a caller-supplied `outcome` and coerce every value to a scalar.
   *
   * ⚠️ Adds NO key, and removes exactly TWO: `outcome`, deliberately, and
   * `__proto__`, as a side effect. Two suites assert the completion attributes
   * with strict `toEqual`, so a guard that injected a summary key would break
   * them (and would be lying about the caller's span).
   *
   * ⚠️ CORRECTED 2026-09-26 — this comment said "adds and removes NO key other
   * than `outcome`", which is FALSE for one key. An OWN enumerable `__proto__`
   * property is SILENTLY DROPPED, because the copy is built with `copy[k] = …`
   * and that hits `Object.prototype`'s `__proto__` SETTER instead of defining an
   * own property. MEASURED in both directions on the same input:
   *     input        { c: 0, ['__proto__']: 'SENTINEL' }
   *     spread {…a}  → {"c":0,"__proto__":"SENTINEL"}   ← the OLD shape
   *     copy[k] = …  → {"c":0}                          ← today
   * ⚠️ The drop is the SAFE direction and pollution is UNREACHABLE: the setter
   * ignores every non-object value, and `toScalar` has already replaced any
   * object with a marker STRING, so the only things that ever reach the setter
   * are strings, numbers, booleans and `undefined` — all ignored — or `null`.
   * `null` IS accepted, so `{ ['__proto__']: null }` leaves the LOCAL `copy`
   * with a null prototype; harmless (`JSON.stringify` and `Object.entries` both
   * still work and the key is still absent from the output), but a real
   * difference, so it is stated instead of rounded off.
   * ⚠️ `attrs.__proto__ = x` by PLAIN ASSIGNMENT never creates an own property
   * at all, so no call site can reach this: it takes a computed key,
   * `Object.defineProperty`, or `JSON.parse`. Pinned below by
   * `an own __proto__ key is DROPPED, and Object.prototype is not polluted`.
   *
   * ⛔ WHY THE VALUE READ IS INSIDE A try/catch, AND WHY IT IS HERE RATHER THAN
   * INSIDE `toScalar`. The completion re-read made an ACCESSOR on the caller's
   * attrs object reachable for the first time: before this change `strip` ran
   * once, BEFORE `fn()`, so a getter installed mid-flight was never read.
   * MEASURED 2026-09-26 with a getter defined inside `fn` that throws on read:
   *   - success path: `fn()` SUCCEEDED, `emitSpan` threw the getter's error,
   *     NEITHER the `ok` nor the `error` line was written (the `:273` re-read
   *     throws inside the try, and the catch re-throws at its own re-read), and
   *     the caller lost its result — a telemetry fault turned into a request
   *     fault.
   *   - error path: WORSE. The getter's error MASKED the real one — a handler
   *     that threw `REAL-FAILURE` surfaced as `GETTER-EXPLODED`, with no span
   *     line at all.
   * A telemetry path that can throw is worse than one that under-reports, so a
   * hostile or accidental accessor now degrades to the bounded marker
   * `[unreadable]`.
   * ⚠️ The guard CANNOT live inside `toScalar`, which is what the audit that
   * found this suggested: the throw happens when the VALUE IS READ, i.e. inside
   * the `Object.entries(a)` / `a[k]` access, strictly BEFORE `toScalar` is ever
   * called with it. MEASURED: a try/catch inside `toScalar`'s body leaves the
   * failure byte-identical. Hence `Object.keys` (which does not invoke getters)
   * plus a guarded per-key read.
   * ⚠️ RESIDUAL, stated rather than implied: a hostile `Proxy` with a throwing
   * `ownKeys` trap would still throw out of `Object.keys` here. No attrs object
   * in `src/` is a Proxy, and guarding it would mean emitting a span with zero
   * attributes — a silent lie in place of a loud failure — so it is left alone
   * deliberately.
   */
  const strip = (a: SpanAttributes): SpanAttributes => {
    const copy: SpanAttributes = {};
    // `Object.keys`, not `Object.entries`: reading keys cannot invoke a getter,
    // so each value read can be guarded individually below.
    for (const k of Object.keys(a)) {
      if (k === 'outcome') continue;
      let raw: unknown;
      try {
        raw = (a as Record<string, unknown>)[k];
      } catch {
        // The key is real and the caller meant to report it; only its value is
        // unobtainable. Say so, bounded, and keep the span.
        copy[k] = '[unreadable]';
        continue;
      }
      copy[k] = toScalar(raw, k);
    }
    return copy;
  };

  /**
   * ⭐ THE START LINE IS A SNAPSHOT; THE COMPLETION LINES ARE NOT, AND THAT
   * DISTINCTION IS THE WHOLE OF THIS CHANGE.
   *
   * `cleanAttrs` below is taken BEFORE `fn()` runs and is used for the `start`
   * line only, where a snapshot is the honest thing: nothing has happened yet.
   * The `ok` / `error` lines and the OTel span now re-read the CALLER'S live
   * object (`strip(attributes)`) at completion, so a handler that learns a value
   * while running — a row count, a truncation flag, a dedup-hit count — can
   * write it onto the same attributes object it passed in and have it reported.
   *
   * ⛔ WHY: it did not work before, and three call sites believed it did. The
   * `ok` line used to spread the PRE-CALL `cleanAttrs`, so every attribute a
   * handler set afterwards was discarded. Measured on this tree before the fix,
   * with a handler that sets `count = 42` inside `fn`:
   *     OK LINE ATTRS = {"count":0,"truncated":false,"outcome":"ok"}
   * `domain/bridge/drafts.ts` carries the comment "Mutate the same attrs object
   * emitSpan captured so the 'ok' line carries the actual hit count" and its
   * `dedup_hit_count` had therefore read 0 for every draft ever created; the two
   * bridge LIST routes hardcoded `count: 0` for the same reason. An attribute
   * that is structurally incapable of being non-zero is worse than a missing
   * one: in Tempo it renders as a MEASURED zero, so "truncation rate" and "dedup
   * rate" were flat-zero dashboards over a question nobody was asking.
   *
   * ⚠️ The signature stays FROZEN — this is a body change, and a caller that
   * never mutates its object sees byte-identical output, because `strip` of an
   * unmutated object equals the snapshot.
   * ⚠️ `assets/_lib/handler.ts` documents the old behaviour ("it snapshots its
   * attributes before running the callback") as the reason error CAUSES are
   * logged in the converter instead. That reasoning is untouched: the cause is
   * not on the attributes object at all, so it still belongs where it is.
   */
  const cleanAttrs: SpanAttributes = strip(attributes);

  writeSpanLine({
    telemetry: 'span',
    name,
    status: 'start',
    ...baseAttrs,
    attributes: cleanAttrs,
  });

  const tracer = getTracer();
  const started = performance.now();

  // OTel branch when configured. The SDK's startActiveSpan ensures parenting
  // through async hooks; when no SDK is initialized, getTracer() returns the
  // no-op tracer and this collapses to fn().
  return tracer.startActiveSpan(name, async (otelSpan) => {
    try {
      otelSpan.setAttributes(toOtelAttrs(baseAttrs, cleanAttrs));
      const result = await fn();
      const elapsed = Math.round(performance.now() - started);
      // Integration handlers convert IntegrationError → 4xx/5xx Response
      // (routes/assets/_lib/handler.ts + integrations/_lib/errors.ts) instead
      // of re-throwing. Without inspecting the result, every optimistic
      // `outcome:'ok'` literal at call sites would survive even on real
      // failures and dashboards would count 502s as successes. Derive span
      // status from the wire-truth response status; only overwrite the
      // call-site `outcome` attribute when it was the optimistic 'ok' literal
      // — preserve semantic outcomes ('accepted', 'not_supported', etc.) that
      // callers set deliberately.
      const responseStatus = result instanceof Response ? result.status : undefined;
      const isHttpError = responseStatus !== undefined && responseStatus >= 400;
      if (isHttpError && (attributes.outcome === 'ok' || attributes.outcome === undefined)) {
        attributes.outcome = 'error';
      }
      if (responseStatus !== undefined) {
        attributes['http.status_code'] = responseStatus;
      }
      const otelOutcome =
        typeof attributes.outcome === 'string' ? attributes.outcome : isHttpError ? 'error' : 'ok';
      // Re-apply the caller's attributes as they stand NOW, so a value the
      // handler learned while running reaches Tempo and not just the log line.
      // Re-setting a key overwrites it, so the up-front call above stays as the
      // context a span carries if it is somehow read before completion.
      otelSpan.setAttributes(toOtelAttrs(baseAttrs, strip(attributes)));
      otelSpan.setAttribute('duration_ms', elapsed);
      otelSpan.setAttribute('outcome', otelOutcome);
      if (responseStatus !== undefined) {
        otelSpan.setAttribute('http.status_code', responseStatus);
      }
      if (isHttpError) {
        otelSpan.setStatus({ code: 2 /* SpanStatusCode.ERROR */, message: `HTTP ${responseStatus}` });
      }
      otelSpan.end();
      writeSpanLine({
        telemetry: 'span',
        name,
        status: isHttpError ? 'error' : 'ok',
        duration_ms: elapsed,
        ...baseAttrs,
        // `otelOutcome`, not the literal 'ok' this used to carry. The comment
        // above describes exactly this bug and claims it fixed — and it was,
        // on the THROW path only (see the catch block's `outcome: 'error'`).
        // A handler that RETURNS a >=400 Response instead of throwing — which
        // `routes/assets/_lib/handler.ts` makes 41 call sites do, by catching
        // IntegrationError and converting it to a Response — took the success
        // branch and wrote `status: 'error'` beside `outcome: 'ok'` in one line.
        // Reusing the computed value also stops deliberate semantic outcomes
        // ('accepted', 'not_supported') being flattened to 'ok'.
        //
        // ⭐ `strip(attributes)`, NOT the pre-call `cleanAttrs` — see the note
        // beside `cleanAttrs` above. This is the line that lets a handler report
        // a count it could not have known when the span opened.
        attributes: { ...strip(attributes), outcome: otelOutcome },
      });
      return result;
    } catch (err) {
      const elapsed = Math.round(performance.now() - started);
      const errorName = err instanceof Error ? err.name : typeof err;
      const errorMessage = err instanceof Error ? err.message : String(err);
      otelSpan.recordException(err instanceof Error ? err : new Error(String(err)));
      // Same re-apply as the success path. A partial count is still information
      // on a failure — "we had read 40 rows when it blew up" is exactly what a
      // trace is for — and dropping it would make the error span narrower than
      // the ok span for no reason.
      otelSpan.setAttributes(toOtelAttrs(baseAttrs, strip(attributes)));
      otelSpan.setAttribute('duration_ms', elapsed);
      otelSpan.setAttribute('outcome', 'error');
      otelSpan.setAttribute('error.name', errorName);
      otelSpan.setStatus({ code: 2 /* SpanStatusCode.ERROR */, message: errorMessage });
      otelSpan.end();
      writeSpanLine({
        telemetry: 'span',
        name,
        status: 'error',
        duration_ms: elapsed,
        ...baseAttrs,
        attributes: { ...strip(attributes), outcome: 'error' },
        error_name: errorName,
        error_message: errorMessage,
      });
      throw err;
    }
  });
}
