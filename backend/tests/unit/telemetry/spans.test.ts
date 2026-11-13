import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import {
  emitSpan,
  MAX_ATTR_STRING_CHARS,
  type SpanAttributes,
} from '../../../src/telemetry/spans';
import { withRequestContext } from '../../../src/integrations/_lib/context';

type LogLine = { status: 'start' | 'ok' | 'error'; [k: string]: unknown };

const origLog = console.log;
const origErr = console.error;
let logs: LogLine[];
let errs: LogLine[];

function parse(entry: unknown): LogLine {
  return JSON.parse(entry as string) as LogLine;
}

beforeEach(() => {
  logs = [];
  errs = [];
  console.log = (entry: unknown) => {
    logs.push(parse(entry));
  };
  console.error = (entry: unknown) => {
    errs.push(parse(entry));
  };
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe('emitSpan', () => {
  test('returns fn result unchanged', async () => {
    const out = await emitSpan('t.pass', {}, async () => 42);
    expect(out).toBe(42);
  });

  test('emits start and ok lines on success', async () => {
    await emitSpan('t.ok', { foo: 'bar' }, async () => 'done');
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      telemetry: 'span',
      name: 't.ok',
      status: 'start',
      attributes: { foo: 'bar' },
    });
    expect(logs[1]).toMatchObject({
      telemetry: 'span',
      name: 't.ok',
      status: 'ok',
      attributes: { foo: 'bar' },
    });
    expect(typeof logs[1]!.duration_ms).toBe('number');
  });

  test('emits error line when fn throws, and re-throws', async () => {
    const err = new Error('boom');
    let caught: unknown;
    try {
      await emitSpan('t.err', {}, async () => {
        throw err;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe('start');
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({
      name: 't.err',
      status: 'error',
      error_name: 'Error',
      error_message: 'boom',
    });
  });

  test('attaches correlation_id / initiator / channel from request context', async () => {
    await withRequestContext(
      {
        correlationId: 'cid-xyz',
        initiator: 'agent',
        channel: 'telegram',
      },
      async () => {
        await emitSpan('t.ctx', {}, async () => null);
      },
    );
    expect(logs[0]).toMatchObject({
      correlation_id: 'cid-xyz',
      initiator: 'agent',
      channel: 'telegram',
    });
  });

  test('works outside any request context (no crash)', async () => {
    await emitSpan('t.no-ctx', { a: 1 }, async () => null);
    expect(logs[0]!.correlation_id).toBeUndefined();
  });

  test('strips caller-supplied outcome so log lines never lie on error path', async () => {
    // Regression: callers historically passed `outcome: 'ok'` up-front; the
    // error log line spread that attribute alongside `status: 'error'`,
    // so dashboards reading attributes.outcome thought errors were successes.
    const attrs = { foo: 'bar', outcome: 'ok' as const };
    try {
      await emitSpan('t.lying', attrs, async () => {
        throw new Error('boom');
      });
    } catch {
      // expected
    }
    // Start line: outcome stripped (no premature claim of success).
    expect(logs[0]).toMatchObject({ status: 'start' });
    expect(
      (logs[0]!.attributes as Record<string, unknown>).outcome,
    ).toBeUndefined();
    // Error line: outcome is now authoritatively 'error'.
    expect(errs[0]).toMatchObject({ status: 'error' });
    expect((errs[0]!.attributes as Record<string, unknown>).outcome).toBe(
      'error',
    );
    // Caller's object MUST NOT have been mutated.
    expect(attrs.outcome).toBe('ok');
  });

  test('attribute outcome on success line reflects authoritative ok', async () => {
    await emitSpan('t.auth-ok', { foo: 'bar' }, async () => null);
    expect(
      (logs[1]!.attributes as Record<string, unknown>).outcome,
    ).toBe('ok');
  });
  // The three below pin the RETURNED-Response path. Every test above it drives
  // the throw path or a plain value; none of them resolves `fn` to a Response,
  // which is the only way to reach the line these cover. `handler.ts` converts
  // IntegrationError into a returned 4xx/5xx at 41 call sites, so this path is
  // the common one in production, not an edge case.
  test('a returned >=400 Response makes attributes.outcome error, not ok', async () => {
    await emitSpan(
      't.http-error',
      { foo: 'bar' },
      async () => new Response('nope', { status: 502 }),
    );
    // A >=400 Response routes writeSpanLine to console.error, so the finish
    // line lands in `errs`; `logs` holds only the start line.
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe('start');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.status).toBe('error');
    expect((errs[0]!.attributes as Record<string, unknown>).outcome).toBe(
      'error',
    );
  });

  test('a deliberate semantic outcome survives a >=400 Response', async () => {
    // `routes/tools/coding.ts` returns a hardcoded 501 with this outcome on
    // EVERY call — the literal reported it as 'ok'.
    const attrs = { 'coding.job_id': 'j1', outcome: 'not_supported' as const };
    await emitSpan(
      't.not-supported',
      attrs,
      async () => new Response('x', { status: 501 }),
    );
    expect(errs).toHaveLength(1);
    expect((errs[0]!.attributes as Record<string, unknown>).outcome).toBe(
      'not_supported',
    );
  });

  test('a returned 2xx Response still logs ok', async () => {
    // Non-vacuity control: passes BEFORE the fix as well as after, so the two
    // reds above cannot be an assertion that is simply always red, and an
    // over-correction that reported every Response as an error would break it.
    await emitSpan(
      't.http-ok',
      { foo: 'bar' },
      async () => new Response('yes', { status: 200 }),
    );
    expect(errs).toHaveLength(0);
    expect(logs).toHaveLength(2);
    expect(logs[1]!.status).toBe('ok');
    expect((logs[1]!.attributes as Record<string, unknown>).outcome).toBe('ok');
  });

  test('an attribute the handler learns WHILE RUNNING reaches the ok line', async () => {
    // ⛔ THE DEFECT THIS PINS. The `ok` line used to spread a snapshot of the
    // attributes taken BEFORE `fn()`, so every value a handler discovered while
    // running was silently discarded. Measured on this tree before the fix, with
    // exactly this handler:
    //     OK LINE ATTRS = {"count":0,"truncated":false,"outcome":"ok"}
    // Three call sites believed otherwise. `domain/bridge/drafts.ts` even carries
    // the comment "Mutate the same attrs object emitSpan captured so the 'ok'
    // line carries the actual hit count" — and `dedup_hit_count` had read 0 for
    // every draft ever created. The two bridge LIST routes hardcoded `count: 0`
    // and `truncated: false` for the same reason, which in Tempo is not a missing
    // attribute but a MEASURED zero: a flat-zero truncation rate over a question
    // nobody was actually asking.
    //
    // KILLS: reverting either completion line to `{ ...cleanAttrs, outcome }`.
    const attrs: SpanAttributes = { count: 0, truncated: false };
    await emitSpan('t.late-attrs', attrs, async () => {
      attrs.count = 42;
      attrs.truncated = true;
      return 'done';
    });

    expect(logs).toHaveLength(2);
    // The START line is still a SNAPSHOT, and deliberately so — nothing had
    // happened yet, and a start line claiming 42 rows would be the invented
    // measurement in the other direction.
    expect(logs[0]!.status).toBe('start');
    expect(logs[0]!.attributes).toMatchObject({ count: 0, truncated: false });
    // The COMPLETION line reports what was actually true at completion.
    expect(logs[1]!.status).toBe('ok');
    expect(logs[1]!.attributes).toMatchObject({
      count: 42,
      truncated: true,
      outcome: 'ok',
    });
  });

  test('a partial count survives onto the ERROR line too', async () => {
    // KILLS: fixing only the success path. A handler that read 40 rows and then
    // threw should say 40, not 0 — that partial is the most useful number on the
    // span, and an error line narrower than the ok line is an arbitrary gap.
    const attrs: SpanAttributes = { count: 0 };
    let caught: unknown;
    try {
      await emitSpan('t.late-attrs-err', attrs, async () => {
        attrs.count = 40;
        throw new Error('blew up mid-page');
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.attributes).toMatchObject({ count: 40, outcome: 'error' });
  });

  test('a handler that mutates NOTHING is byte-identical to the old snapshot', async () => {
    // Non-vacuity control for the two tests above: the change must be invisible
    // to the ~90 call sites that never touch their attributes object, or it is a
    // behaviour change dressed as a fix. `strip` of an unmutated object equals
    // the pre-call snapshot, and this asserts that rather than assuming it.
    await emitSpan('t.no-mutation', { a: 1, b: 'two', c: true }, async () => 'x');
    expect(logs).toHaveLength(2);
    expect(logs[1]!.attributes).toEqual({ a: 1, b: 'two', c: true, outcome: 'ok' });
    expect(logs[1]!.attributes).toEqual({
      ...(logs[0]!.attributes as Record<string, unknown>),
      outcome: 'ok',
    });
  });

  test('a late-set `outcome` is still stripped and never overrides the authoritative one', async () => {
    // KILLS: reading the live object without re-applying the `outcome` strip —
    // the exact lie the strip exists to prevent, moved to a later moment. A
    // handler that sets `outcome: 'ok'` on its way out and THEN returns a 502
    // must not be believed.
    const attrs: SpanAttributes = { count: 0 };
    await emitSpan('t.late-outcome', attrs, async () => {
      attrs.count = 3;
      attrs.outcome = 'ok';
      return new Response('nope', { status: 502 });
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]!.status).toBe('error');
    expect((errs[0]!.attributes as Record<string, unknown>).outcome).toBe('error');
    expect((errs[0]!.attributes as Record<string, unknown>).count).toBe(3);
  });
});

/**
 * The completion re-read widened what can escape: before it, only keys present
 * at span open could ever be emitted; now any key a handler assigns mid-flight
 * is published to stdout and to the SDK. `SpanAttributes` types values as
 * scalars-only and NO call site violates it today (78 sites, clean strict tsc,
 * no `any`/`@ts-ignore` in any of the 28 call-site files) — so these pin a
 * BACKSTOP against an `as` cast or a `Record<string, unknown>` arriving via the
 * new path, not a live defect.
 */
describe('emitSpan — non-scalar attribute values cannot escape', () => {
  test('an object assigned mid-flight is MARKED, and its contents never appear', async () => {
    // ⛔ THE SHAPE THAT MATTERS. `toOtelAttrs` filters only null/undefined, so
    // before the guard this object reached the SDK as an object and was
    // JSON.stringify'd into the stdout line IN FULL, secret and all.
    const attrs: SpanAttributes = { count: 0 };
    await emitSpan('t.nonscalar', attrs, async () => {
      (attrs as Record<string, unknown>).raw_body = { password: 'hunter2-SENTINEL' };
      attrs.count = 1;
      return 'done';
    });

    expect(logs).toHaveLength(2);
    const completion = logs[1]!.attributes as Record<string, unknown>;
    expect(completion.raw_body).toBe('[unsupported:object]');
    expect(completion.count).toBe(1);
    // The decisive assertion: the secret is absent from the ENTIRE serialised
    // line, not merely from the key we happened to look at.
    expect(JSON.stringify(logs[1])).not.toContain('hunter2-SENTINEL');
  });

  test('an array is marked as an array, not as a generic object', async () => {
    const attrs: SpanAttributes = {};
    await emitSpan('t.nonscalar-arr', attrs, async () => {
      (attrs as Record<string, unknown>).tags = ['a', 'b'];
      return 'x';
    });
    expect((logs[1]!.attributes as Record<string, unknown>).tags).toBe('[unsupported:array]');
  });

  test('CONTROL: null and undefined are NOT marked — they mean "not measured"', async () => {
    // Non-vacuity control AND a regression guard. `null` is the opening value
    // every count on this branch now uses; marking it would turn "not measured"
    // back into a fabricated value, which is the defect this branch exists to
    // fix, reintroduced by its own guard.
    const attrs: SpanAttributes = { count: null, flag: undefined, name: 'kept' };
    await emitSpan('t.nonscalar-null', attrs, async () => 'x');
    const start = logs[0]!.attributes as Record<string, unknown>;
    const done = logs[1]!.attributes as Record<string, unknown>;
    expect(start.count).toBeNull();
    expect(done.count).toBeNull();
    expect(done.name).toBe('kept');
    // JSON.stringify drops undefined values, so assert on the key's absence
    // rather than on a marker having replaced it.
    expect(Object.prototype.hasOwnProperty.call(done, 'flag')).toBe(false);
  });

  test('CONTROL: scalars pass through untouched and no key is added or removed', async () => {
    // The guard must be invisible to the 78 call sites that already comply.
    await emitSpan('t.nonscalar-clean', { a: 1, b: 'two', c: true, d: null }, async () => 'x');
    expect(logs[1]!.attributes).toEqual({ a: 1, b: 'two', c: true, d: null, outcome: 'ok' });
  });

  test('an own __proto__ key is DROPPED, and Object.prototype is not polluted', async () => {
    // ⚠️ The `strip` header used to claim it "adds and removes NO key other than
    // `outcome`". FALSE for exactly one key, and this pins which and in which
    // direction. `copy[k] =` hits `Object.prototype`'s `__proto__` SETTER rather
    // than defining an own property, and the setter ignores every non-object
    // value — so the key vanishes. MEASURED on the same input:
    //     spread {...a}  → {"c":0,"__proto__":"SENTINEL"}   ← the OLD shape
    //     copy[k] = …    → {"c":0}                          ← today
    // ⚠️ A plain `attrs.__proto__ = x` never creates an own property at all, so
    // this needs a COMPUTED key (or defineProperty / JSON.parse) to reach — which
    // is why no call site can hit it and why this is a pinned property of
    // `strip`, not a defect report.
    const attrs: SpanAttributes = { count: 0 };
    await emitSpan('t.proto', attrs, async () => {
      // ⚠️ `defineProperty`, NOT `attrs['__proto__'] = …`. A bracket assignment
      // ALSO goes through the setter and would create nothing, so the test would
      // then assert the absence of a key that was never there — vacuous. The
      // positive control below is what proves it is not.
      Object.defineProperty(attrs, '__proto__', {
        value: 'PROTO-SENTINEL',
        enumerable: true,
        configurable: true,
        writable: true,
      });
      attrs.count = 1;
      return 'done';
    });

    // ⭐ POSITIVE CONTROL ON THE FIXTURE. Without this the assertions below pass
    // for the wrong reason: nothing was ever there to drop. The caller's object
    // really does carry an own, enumerable `__proto__` that `Object.keys` sees.
    expect(Object.prototype.hasOwnProperty.call(attrs, '__proto__')).toBe(true);
    expect(Object.keys(attrs)).toContain('__proto__');
    // And the OLD shape is reproduced here directly, so the "spread would have
    // carried it" claim in `strip`'s header is asserted, not asserted-by-comment.
    expect(Object.prototype.hasOwnProperty.call({ ...attrs }, '__proto__')).toBe(true);
    expect(JSON.stringify({ ...attrs })).toContain('PROTO-SENTINEL');

    const done = logs[1]!.attributes as Record<string, unknown>;
    // Dropped, not marked and not carried through.
    expect(Object.prototype.hasOwnProperty.call(done, '__proto__')).toBe(false);
    expect(JSON.stringify(logs[1])).not.toContain('PROTO-SENTINEL');
    // The sibling key is untouched — this is a per-key drop, not a wipe. Without
    // this the assertion above would also pass if `strip` returned {}.
    expect(done.count).toBe(1);
    // And nothing was polluted: the value reaching the setter is a string.
    expect(Object.getPrototypeOf(done)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).count).toBeUndefined();
  });

  test('a string over the cap is TRUNCATED and marked with its original length', async () => {
    // ⛔ RULE 2 (BOUNDED) HAD NO BACKSTOP while rule 1 did. Measured before the
    // cap: a 200,000-character value carrying a sentinel escaped to stdout
    // VERBATIM, and would have gone to the SDK the same way.
    // KILLS: deleting the `MAX_ATTR_STRING_CHARS` branch in `toScalar`.
    const huge = `${'A'.repeat(200_000)}TRAILING-SENTINEL`;
    const attrs: SpanAttributes = {};
    await emitSpan('t.cap', attrs, async () => {
      attrs.blob = huge;
      return 'x';
    });
    const v = (logs[1]!.attributes as Record<string, unknown>).blob as string;
    expect(v.length).toBe(MAX_ATTR_STRING_CHARS + `[truncated:${huge.length}]`.length);
    expect(v.endsWith(`[truncated:${huge.length}]`)).toBe(true);
    // The trailing sentinel did NOT escape, and the assertion is on the WHOLE
    // serialised line rather than on the one key we looked at.
    expect(JSON.stringify(logs[1])).not.toContain('TRAILING-SENTINEL');
  });

  test('HONEST LIMIT: the cap bounds SIZE and is NOT a redaction — a leading secret survives', async () => {
    // ⛔ THIS TEST EXISTS TO STOP THE CAP BEING READ AS ENFORCEMENT OF RULE 3.
    // Truncation keeps the FIRST characters, so a sensitive value short enough to
    // fit, or one whose leading bytes are the secret, passes through verbatim.
    // Rule 3 is a CONVENTION enforced at review of the call site; asserting that
    // plainly here is the only way a future reader cannot mistake rule 2's guard
    // for rule 3's.
    const attrs: SpanAttributes = {};
    await emitSpan('t.cap-not-redaction', attrs, async () => {
      attrs.token = `LEADING-SECRET${'B'.repeat(200_000)}`;
      attrs.short_token = 'hunter2';
      return 'x';
    });
    const done = logs[1]!.attributes as Record<string, unknown>;
    expect(done.token as string).toContain('LEADING-SECRET');
    expect(done.short_token).toBe('hunter2');
  });

  test('CONTROL: a string AT the cap is untouched, so the cap is off-by-one honest', async () => {
    // Non-vacuity in both directions: the case above must not pass merely because
    // every string is mangled. `MAX_ATTR_STRING_CHARS` is inclusive.
    const atCap = 'C'.repeat(MAX_ATTR_STRING_CHARS);
    const overByOne = 'D'.repeat(MAX_ATTR_STRING_CHARS + 1);
    await emitSpan('t.cap-edge', { at: atCap, over: overByOne }, async () => 'x');
    const done = logs[1]!.attributes as Record<string, unknown>;
    expect(done.at).toBe(atCap);
    expect(done.over).toBe(
      `${'D'.repeat(MAX_ATTR_STRING_CHARS)}[truncated:${MAX_ATTR_STRING_CHARS + 1}]`,
    );
  });

  test('RECORDED, previously unclaimed: bigint and circular values no longer make JSON.stringify THROW', async () => {
    // Not a redaction — a ROBUSTNESS gain the commit never claimed. MEASURED
    // 2026-09-26 on the raw values: `JSON.stringify` raises
    // `TypeError: JSON.stringify cannot serialize BigInt` and
    // `… cannot serialize cyclic structures`. Inside `writeSpanLine` on the
    // completion path that throw is inside the try, so it destroyed the span line
    // AND the caller's result. Pinned so the header's claim is asserted.
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const attrs: SpanAttributes = {};
    const out = await emitSpan('t.unserialisable', attrs, async () => {
      (attrs as Record<string, unknown>).big = 10n;
      (attrs as Record<string, unknown>).circ = circular;
      return 'survived';
    });
    // Control on the premise: these really are unserialisable.
    expect(() => JSON.stringify({ x: 10n })).toThrow();
    expect(() => JSON.stringify({ x: circular })).toThrow();
    // And the span survived both.
    expect(out).toBe('survived');
    expect(logs).toHaveLength(2);
    expect(logs[1]!.attributes).toMatchObject({
      big: '[unsupported:bigint]',
      circ: '[unsupported:object]',
      outcome: 'ok',
    });
  });
});

/**
 * ⛔ THE COMPLETION RE-READ MADE AN ACCESSOR REACHABLE FOR THE FIRST TIME, AND AN
 * ACCESSOR THAT THROWS DESTROYED THE SPAN.
 *
 * Before this change `strip` ran ONCE, before `fn()`, so a getter installed on
 * the attrs object mid-flight was never read. MEASURED on this tree with a getter
 * defined inside `fn` that throws on read, BEFORE the guard existed:
 *   - success path: `fn()` SUCCEEDED and returned its value, `emitSpan` threw
 *     `GETTER-EXPLODED`, and NEITHER the `ok` nor the `error` line was written —
 *     only `start`. The re-read at spans.ts:273 throws inside the `try`, and the
 *     catch block's own re-read throws again before it can log. The caller lost
 *     a successful result to a telemetry fault.
 *   - error path: WORSE. A handler that threw `REAL-FAILURE` surfaced to its
 *     caller as `GETTER-EXPLODED`, with no span line at all — the telemetry
 *     failure MASKED the real one.
 *
 * ⚠️ A telemetry path that can throw is strictly worse than one that
 * under-reports. That is the whole reason these two cases are worth their weight.
 */
describe('emitSpan — a throwing accessor cannot destroy the span', () => {
  test('a getter that throws on read degrades to a marker and the ok line is STILL written', async () => {
    // KILLS: removing the try/catch around the per-key value read in `strip`.
    // ⚠️ It does NOT kill a try/catch placed inside `toScalar` instead — measured
    // byte-identical, because the throw happens during the value READ, strictly
    // before `toScalar` is ever called with it.
    const attrs: SpanAttributes = { count: 0 };
    Object.defineProperty(attrs, 'never_read', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('GETTER-EXPLODED');
      },
    });
    const out = await emitSpan('t.throwing-getter', attrs, async () => {
      attrs.count = 5;
      return 'fn-succeeded';
    });

    // 1. The caller's result survives — this is the half that is not telemetry.
    expect(out).toBe('fn-succeeded');
    // 2. The ok line exists at all.
    expect(logs).toHaveLength(2);
    expect(errs).toHaveLength(0);
    expect(logs[1]!.status).toBe('ok');
    // 3. The unreadable key is REPORTED as unreadable, not dropped: the caller
    //    meant to publish it and only the value was unobtainable.
    const done = logs[1]!.attributes as Record<string, unknown>;
    expect(done.never_read).toBe('[unreadable]');
    // 4. Its siblings are intact, including the mid-flight write — a guard that
    //    bailed out of `strip` entirely would pass (3) and fail here.
    expect(done.count).toBe(5);
    expect(done.outcome).toBe('ok');
    // 5. The thrown message never reaches the line.
    expect(JSON.stringify(logs[1])).not.toContain('GETTER-EXPLODED');
  });

  test("a throwing getter on the ERROR path does not MASK the handler's real error", async () => {
    // KILLS: guarding only the success-path re-read. Measured before the guard:
    // the handler threw `REAL-FAILURE` and the caller caught `GETTER-EXPLODED`,
    // with no span line written — the most expensive shape of this bug, because
    // it corrupts the diagnosis of an unrelated failure.
    const attrs: SpanAttributes = { count: 0 };
    let caught: unknown;
    try {
      await emitSpan('t.throwing-getter-err', attrs, async () => {
        attrs.count = 40;
        Object.defineProperty(attrs, 'never_read', {
          enumerable: true,
          configurable: true,
          get() {
            throw new Error('GETTER-EXPLODED');
          },
        });
        throw new Error('REAL-FAILURE');
      });
    } catch (e) {
      caught = e;
    }
    // The REAL error reaches the caller, unmasked.
    expect((caught as Error).message).toBe('REAL-FAILURE');
    // And the error line exists, with the partial count and the marker.
    expect(errs).toHaveLength(1);
    expect(errs[0]!.error_message).toBe('REAL-FAILURE');
    expect(errs[0]!.attributes).toMatchObject({
      count: 40,
      never_read: '[unreadable]',
      outcome: 'error',
    });
  });

  test('CONTROL: a getter that RETURNS is read normally, not marked', async () => {
    // Non-vacuity. The guard must not turn every accessor into `[unreadable]` —
    // a computed attribute is a legitimate thing for a caller to expose, and a
    // blanket marker would silently under-report it.
    const attrs: SpanAttributes = { count: 0 };
    Object.defineProperty(attrs, 'computed', {
      enumerable: true,
      configurable: true,
      get() {
        return 'fine';
      },
    });
    await emitSpan('t.ok-getter', attrs, async () => 'x');
    expect((logs[1]!.attributes as Record<string, unknown>).computed).toBe('fine');
  });
});

describe('emitSpan → OTel (production: no exporter configured)', () => {
  test('with the API no-op tracer, stdout still carries every attribute', async () => {
    // fr-backend sets no OTEL_* env, so getTracer() returns the API no-op
    // tracer and the stdout span line is the only sink.
    const attrs: SpanAttributes = { count: 0 };
    const out = await emitSpan('t.otel-absent', attrs, async () => {
      attrs.count = 7;
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(logs).toHaveLength(2);
    expect(logs[1]!.attributes).toMatchObject({ count: 7, outcome: 'ok' });
  });
});
