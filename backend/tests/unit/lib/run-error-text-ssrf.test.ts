// The SSRF guard's refusal sentences name the host, the address it resolved
// to, or the resolver's own error. A customer who points a trigger at
// `postgres.internal` must not read back `100.64.0.11` from the run history:
// that is an internal-address oracle. The read path rewrites each guard shape
// (matched in FULL) to a fixed sentence; a super-admin still sees the raw text.

import { describe, expect, test } from 'bun:test';
import { withRequestContext, type RequestContext } from '../../../src/integrations/_lib/context';
import {
  clientSafeRunErrorText,
  isFrAuthoredRunError,
  RUN_ERROR_REDACTED,
} from '../../../src/lib/run-error-text';

// Literal on purpose: the customer-visible contract is the sentence itself.
const SSRF_NON_PUBLIC_TEXT = 'refused to fetch: the URL resolves to a non-public address';
const SSRF_UNRESOLVABLE_TEXT = "could not resolve the URL's host";
const SSRF_INVALID_URL_TEXT = 'refused to fetch: the URL is not a valid absolute URL';
const SSRF_SCHEME_TEXT = 'refused to fetch: only http and https URLs may be fetched';

function frame(callerIsSuperAdmin: boolean): RequestContext {
  return {
    correlationId: 'run-error-ssrf-test',
    initiator: 'human',
    channel: 'web',
    tenantId: '0195f48b-d000-7000-8000-0000000000cc',
    callerIsSuperAdmin,
  };
}

const asCustomer = (raw: string): Promise<string | null> =>
  withRequestContext(frame(false), async () => clientSafeRunErrorText(raw));
const asSuperAdmin = (raw: string): Promise<string | null> =>
  withRequestContext(frame(true), async () => clientSafeRunErrorText(raw));

const INTERNAL_PROBE = 'refusing to fetch "postgres.internal": it resolves to non-public address 100.64.0.11';
const RESOLVER_PROBE = 'cannot resolve host "x": getaddrinfo ENOTFOUND x via 10.43.0.10:53 (coredns)';

describe('run-error SSRF sentences — non-super-admin', () => {
  test('validator probe 1: the internal host and address never reach the customer', async () => {
    const out = await asCustomer(INTERNAL_PROBE);
    expect(out).toBe(SSRF_NON_PUBLIC_TEXT);
    expect(out).not.toContain('postgres.internal');
    expect(out).not.toContain('100.64.0.11');
  });

  test('validator probe 2: the resolver text never reaches the customer', async () => {
    const out = await asCustomer(RESOLVER_PROBE);
    expect(out).toBe(SSRF_UNRESOLVABLE_TEXT);
    expect(out).not.toContain('10.43.0.10');
    expect(out).not.toContain('coredns');
  });

  test('neither probe is on the VERBATIM allowlist', () => {
    expect(isFrAuthoredRunError(INTERNAL_PROBE)).toBe(false);
    expect(isFrAuthoredRunError(RESOLVER_PROBE)).toBe(false);
  });

  test('literal non-public address, no-address host, bad URL and bad scheme are rewritten', async () => {
    expect(await asCustomer('refusing to fetch a non-public address: 10.42.0.17')).toBe(SSRF_NON_PUBLIC_TEXT);
    expect(await asCustomer('host "minio.internal" resolved to no addresses')).toBe(SSRF_UNRESOLVABLE_TEXT);
    expect(await asCustomer('not a valid absolute URL: http//postgres.internal:5432')).toBe(SSRF_INVALID_URL_TEXT);
    expect(await asCustomer('scheme "file:" is not allowed; only http and https may be fetched')).toBe(SSRF_SCHEME_TEXT);
  });

  test('the idempotency suffix the tick appends survives the rewrite', async () => {
    expect(await asCustomer(`${INTERNAL_PROBE}; idempotency key not released`)).toBe(
      `${SSRF_NON_PUBLIC_TEXT}; idempotency key not released`,
    );
  });

  test('raw text riding on an SSRF prefix is not passed through', async () => {
    // Prefix-only matching used to bless anything that STARTED like a guard sentence.
    expect(await asCustomer('refusing to fetch anything: pg at 10.0.0.5 said FATAL')).toBe(RUN_ERROR_REDACTED);
    expect(await asCustomer('refusing to fetch "a b": it resolves to non-public address 10.0.0.1 and more')).toBe(
      RUN_ERROR_REDACTED,
    );
  });

  test('"URL has no host" carries nothing internal and stays verbatim', async () => {
    expect(await asCustomer('URL has no host')).toBe('URL has no host');
  });
});

describe('run-error SSRF sentences — super-admin', () => {
  test('sees the raw guard text', async () => {
    expect(await asSuperAdmin(INTERNAL_PROBE)).toBe(INTERNAL_PROBE);
    expect(await asSuperAdmin(RESOLVER_PROBE)).toBe(RESOLVER_PROBE);
  });
});

// Round 4: the two prefix-only allowlist entries (cron/timezone, connector_config)
// now match the WHOLE sentence — one bounded line — and the quoted fields of the
// payload_mapper / template-scope sentences may not span a newline.
describe('run-error allowlist — whole sentences, no newlines', () => {
  const RAW_TAIL = 'ERROR: relation "scheduled_triggers" does not exist\n    at Connection.parseE (postgres.internal:5432)';
  test.each([
    `invalid cron/timezone: bad expr\n${RAW_TAIL}`,
    `connector_config invalid: Required\n${RAW_TAIL}`,
    `connector_config invalid: ${'x'.repeat(501)}`,
    'connector_config invalid: ',
    `payload_mapper error: mapper key 'a\n${RAW_TAIL}\n' must start with $`,
  ])('redacts %#', (text) => {
    expect(isFrAuthoredRunError(text)).toBe(false);
  });
  test.each([
    'invalid cron/timezone: Invalid cron expression',
    'invalid cron/timezone: Invalid time zone specified: Mars/Base',
    'connector_config invalid: Required; Invalid url',
    "payload_mapper error: mapper key 'name' must start with $",
  ])('still passes %#', (text) => {
    expect(isFrAuthoredRunError(text)).toBe(true);
  });
});

// FR-7: one bounded line was not enough — a one-line tail could still name a
// host, URL or address. The tail is deny-by-default; the fr prefix survives.
describe('run-error library tails — deny-by-default (FR-7)', () => {
  test.each([
    ['invalid cron/timezone: ', 'connect ECONNREFUSED 10.43.0.10:5432'],
    ['invalid cron/timezone: ', 'failed to load tzdata from kag.internal'],
    ['connector_config invalid: ', 'fetch http://fr-backend.fr.svc:8000 failed'],
    ['connector_config invalid: ', 'owner george@example.com rejected'],
    ['connector_config invalid: ', 'ENOENT /app/node_modules/x/index.js'],
  ])('keeps %s and drops an unsafe tail (%s)', async (prefix, tail) => {
    const raw = prefix + tail;
    expect(isFrAuthoredRunError(raw)).toBe(false);
    const out = await asCustomer(raw);
    expect(out).toBe(`${prefix}the detail is available to an operator`);
    expect(out).not.toContain(tail);
    // Super-admin still sees the raw text.
    expect(await asSuperAdmin(raw)).toBe(raw);
  });

  test.each([
    'invalid cron/timezone: Invalid time zone specified: America/Argentina/Buenos_Aires',
    'connector_config invalid: String must contain at least 1 character(s)',
    'connector_config invalid: Expected string, received number; Required',
  ])('a real library message still passes verbatim: %s', async (raw) => {
    expect(await asCustomer(raw)).toBe(raw);
  });
});
