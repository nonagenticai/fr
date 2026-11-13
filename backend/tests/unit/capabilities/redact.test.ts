// tests/unit/capabilities/redact.test.ts
//
// fr-agui SPEC §10.1 — capabilities/redact.ts, the one redaction the agent's
// four seams share (LLM context, thread append, NDJSON, span attributes).
//
//   1. declared secret paths  2. PII masks (byte-identical to the frontend,
//   pinned by ONE shared vector file)  3. the always-on scanner: secret-shaped
//   VALUES and secret-named KEYS.
// The loop-level acceptance ("no secret in a thread or the NDJSON stream") was
// the p1c-loop suite, deleted 2026-10-29 (no longer in the suite); the span seam is pinned at the bottom here.
//
// Fixture secrets are ASSEMBLED from fragments so this file is not itself a
// gitleaks / private-key-scan hit (the archetype's secret scan).
//
// MUTATION (run, red, reverted — see the P1c report): delete the GitHub-token
// pattern from SECRET_VALUE_PATTERNS → "every secret shape" red.

import { describe, expect, test } from 'bun:test';

import vectors from '../../fixtures/redact/mask-vectors.json';
import {
  AGENT_PII_MASKS,
  REDACTED,
  isSecretKey,
  maskAddress,
  maskRecipient,
  redact,
  redactAttribute,
  scrubString,
} from '../../../src/capabilities/redact';
import { emitSpan } from '../../../src/telemetry/spans';

/** Expand the vector file's «rep:S:N» templates (no secret literal lives in the JSON). */
const expand = (t: string): string => t.replace(/«rep:([^:»]+):(\d+)»/g, (_m, unit: string, n: string) => unit.repeat(Number(n)));

const SHAPES: Record<string, string> = {
  github: 'gh' + 'p_' + 'A'.repeat(36),
  githubPat: 'github' + '_pat_' + 'B'.repeat(30),
  slack: 'xox' + 'p-' + '2'.repeat(20),
  openai: 'sk-' + 'proj-' + 'C'.repeat(24),
  anthropic: 'sk-' + 'ant-' + 'D'.repeat(24),
  aws: 'AK' + 'IA' + 'E'.repeat(16),
  google: 'AI' + 'za' + 'F'.repeat(35),
  stripe: 'sk' + '_live_' + 'G'.repeat(20),
  npm: 'np' + 'm_' + 'H'.repeat(36),
  jwt: 'eyJ' + 'hbGciOiJSUzI1NiJ9' + '.eyJ' + 'zdWIiOiJ1LTEiLCJ0In0' + '.' + 'Ym9ndXNfc2lnbmF0dXJl',
  privateKey: '-----' + 'BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1\n-----' + 'END OPENSSH PRIVATE KEY-----',
};

describe('the scanner (step 3)', () => {
  test('every secret shape is redacted inside free text, the surrounding text kept', () => {
    for (const [name, secret] of Object.entries(SHAPES)) {
      const out = scrubString(`before ${secret} after`);
      expect({ name, leaked: out.includes(secret) }).toEqual({ name, leaked: false });
      expect({ name, out }).toEqual({ name, out: `before ${REDACTED} after` });
    }
  });

  test('credentials in URLs, Bearer headers and key=value pairs keep their non-secret part', () => {
    expect(scrubString('https://svc:hunter2-x@host.example.com/p')).toBe(`https://svc:${REDACTED}@host.example.com/p`);
    expect(scrubString('Authorization: Bearer abcdefghijklmnop.qrstuv')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(scrubString('password=Tr0ub4dor&x=1')).toBe(`password=${REDACTED}&x=1`);
    expect(scrubString('api_key: "anything at all"')).toBe(`api_key: ${REDACTED}`);
    // CONTROL: prose about passwords is not mangled; plain ids are not secrets.
    expect(scrubString('password: minimum length is twelve')).toBe('password: minimum length is twelve');
    expect(scrubString('project 0195f48b-d000-7000-8000-00000000c1b1 card 1764170980260840476')).toBe(
      'project 0195f48b-d000-7000-8000-00000000c1b1 card 1764170980260840476',
    );
  });

  test('secret-NAMED keys are redacted whatever the value looks like; counts are not', () => {
    for (const k of ['token', 'access_token', 'github_access_token', 'licence_token', 'secret', 'client_secret', 'password', 'api_key', 'apiKey', 'credentials', 'cookie', 'private_key']) {
      expect({ k, secret: isSecretKey(k) }).toEqual({ k, secret: true });
    }
    for (const k of ['tokens', 'max_tokens', 'token_count', 'secretFields', 'title', 'card_id']) {
      expect({ k, secret: isSecretKey(k) }).toEqual({ k, secret: false });
    }
    expect(redact({ a: { token: 'plain', tokens: 3, kept: 'x' }, list: [{ password: 'p' }] })).toEqual({
      a: { token: REDACTED, tokens: 3, kept: 'x' },
      list: [{ password: REDACTED }],
    });
  });
});

describe('declared paths (step 1) and PII masks (step 2)', () => {
  test('a declared secret path (JSON pointer or key) is redacted; the input is not mutated', () => {
    const input = { github_access_token: 'whatever', nested: { webhook: 'w' }, title: 't' };
    const out = redact(input, { secretPaths: ['/github_access_token', '/nested/webhook'] });
    expect(out).toEqual({ github_access_token: REDACTED, nested: { webhook: REDACTED }, title: 't' });
    expect(input.github_access_token).toBe('whatever');
  });

  test('PII masks by key: email, address (by sibling channel), recipient', () => {
    expect(
      redact(
        { email: 'alice@example.com', address: '+31600000001', channel: 'voice', recipient: '+31 6 0000 0001' },
        { pii: { email: 'email', address: 'address', recipient: 'recipient' } },
      ),
    ).toEqual({ email: 'a••••@example.com', address: '+31600…', channel: 'voice', recipient: '••••0001' });
  });

  test('cycles and absurd depth are replaced, never walked forever', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect((redact(a) as Record<string, unknown>).self).toBe(REDACTED);
  });
});

describe('the shared mask vectors (the frontend runs the SAME file)', () => {
  test('maskAddress — byte-identical to frontend/src/lib/api/channel-prefs.ts', () => {
    // Non-vacuity only; no count of the fixture vectors is pinned.
    expect(vectors.maskAddress.length).toBeGreaterThan(0);
    for (const v of vectors.maskAddress) expect({ v, got: maskAddress(v.channel, v.address) }).toEqual({ v, got: v.expected });
  });

  test('maskRecipient — byte-identical to frontend/src/lib/api/deliveries.ts', () => {
    expect(vectors.maskRecipient.length).toBeGreaterThan(0);
    for (const v of vectors.maskRecipient) expect({ v, got: maskRecipient(v.channel, v.address) }).toEqual({ v, got: v.expected });
  });
});

describe('P1c-a audit item 3: the scanner extensions and PII by key (shared vectors)', () => {
  test('every webhook / query-string / token vector is redacted to its expected form', () => {
    expect(vectors.scrub.length).toBeGreaterThan(0);
    for (const v of vectors.scrub) {
      const got = scrubString(expand(v.input));
      expect({ name: v.name, got }).toEqual({ name: v.name, got: v.expected });
    }
  });

  test('NO false positive: UUIDs, SHAs, ordinary URLs and identifiers pass unchanged', () => {
    expect(vectors.scrubUnchanged.length).toBeGreaterThan(0);
    for (const v of vectors.scrubUnchanged) {
      const input = expand(v.input);
      expect({ name: v.name, got: scrubString(input) }).toEqual({ name: v.name, got: input });
      // …and the same holds as a value inside an agent tool result.
      expect({ name: v.name, got: redact({ note: input }, { pii: AGENT_PII_MASKS }).note }).toEqual({ name: v.name, got: input });
    }
  });

  test('the AGENT PII masks: approver_email, recipient_address (by sibling channel), address', () => {
    expect(vectors.piiByKey.length).toBeGreaterThan(0);
    for (const v of vectors.piiByKey) {
      expect({ key: v.key, mask: AGENT_PII_MASKS[v.key] }).toEqual({ key: v.key, mask: v.mask as never });
      const row: Record<string, unknown> = { [v.key]: expand(v.value) };
      if (v.channel !== null) row.channel = v.channel;
      const got = (redact({ row }, { pii: AGENT_PII_MASKS }) as { row: Record<string, unknown> }).row[v.key];
      expect({ key: v.key, channel: v.channel, got }).toEqual({ key: v.key, channel: v.channel, got: v.expected });
    }
    // CONTROL: a bare `address` key with no channel sibling is not a channel address.
    expect(redact({ address: 'Main Street 1' }, { pii: AGENT_PII_MASKS })).toEqual({ address: 'Main Street 1' });
  });

  test('linear time: a 200k-char run is scanned in well under a second (no quadratic start-per-position)', () => {
    for (const run of ['A'.repeat(200_000), 'a'.repeat(200_000), '1'.repeat(200_000)]) {
      const t = performance.now();
      scrubString(`x ${run} y`);
      expect({ ms: performance.now() - t < 1500 }).toEqual({ ms: true });
    }
  });

  test('a span attribute keyed approver_email is masked; a 40-hex SHA attribute is not', () => {
    const sha = expand('«rep:3f78:10»');
    expect(redactAttribute('approval.approver_email', 'dana@example.com')).toBe('d••••@example.com');
    expect(redactAttribute('git.sha', sha)).toBe(sha);
  });
});

describe('the span seam (§10.1 d)', () => {
  test('emitSpan never writes a secret-shaped attribute value to its log line', async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    try {
      await emitSpan('test.p1c_redact', { note: `leak ${SHAPES.slack}` }, async () => 1);
    } finally {
      console.log = orig;
    }
    const joined = lines.join('\n');
    expect(joined).toContain('test.p1c_redact');
    expect(joined).not.toContain(SHAPES.slack);
  });
});
