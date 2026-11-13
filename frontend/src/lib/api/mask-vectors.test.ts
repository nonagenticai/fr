// fr-agui SPEC §10.1 step 2 — the frontend originals of `maskAddress` /
// `maskRecipient` against the ONE vector file the backend port is also pinned to
// (backend/tests/fixtures/redact/mask-vectors.json; backend side:
// backend/tests/unit/capabilities/redact.test.ts). A change to either side's
// masking reds that side until both agree again.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { maskAddress } from './channel-prefs';
import { maskRecipient } from './deliveries';
import { REDACTED, redactForDisplay, redactedSummary, scrubString } from './agent-redact';
import type { ChannelKind } from './channel-prefs';

interface Vector {
  channel: string;
  address: string;
  expected: string;
}
interface PiiVector {
  key: string;
  mask: 'email' | 'address' | 'recipient';
  channel: string | null;
  value: string;
  expected: string;
}
const vectors = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../backend/tests/fixtures/redact/mask-vectors.json'), 'utf8'),
) as {
  maskAddress: Vector[];
  maskRecipient: Vector[];
  piiByKey: PiiVector[];
  scrub: Array<{ name: string; input: string; expected: string }>;
  scrubUnchanged: Array<{ name: string; input: string }>;
};

/** The vector file's «rep:S:N» templates (S repeated N times) — same expansion as the backend test. */
const expand = (t: string): string =>
  t.replace(/«rep:([^:»]+):(\d+)»/g, (_m, unit: string, n: string) => unit.repeat(Number(n)));

describe('mask vectors shared with the backend redact.ts port', () => {
  it('has vectors for both helpers (not vacuous)', () => {
    expect(vectors.maskAddress.length).toBeGreaterThanOrEqual(8);
    expect(vectors.maskRecipient.length).toBeGreaterThanOrEqual(8);
  });

  for (const v of vectors.maskAddress) {
    it(`maskAddress(${v.channel}, ${JSON.stringify(v.address)})`, () => {
      expect(maskAddress(v.channel as ChannelKind, v.address)).toBe(v.expected);
    });
  }

  for (const v of vectors.maskRecipient) {
    it(`maskRecipient(${v.channel}, ${JSON.stringify(v.address)})`, () => {
      expect(maskRecipient(v.channel, v.address)).toBe(v.expected);
    });
  }

  // P1c-a: the PII keys the backend agent view masks (approver_email,
  // engagement_deliveries.recipient_address, a channel-pref address) give the
  // SAME text the frontend cards show for that field.
  it('has PII-by-key vectors (not vacuous)', () => {
    expect(vectors.piiByKey.length).toBeGreaterThanOrEqual(5);
  });
  for (const v of vectors.piiByKey) {
    it(`PII ${v.key} (${v.mask}, ${v.channel ?? 'no channel'})`, () => {
      const value = expand(v.value);
      const got =
        v.mask === 'email'
          ? maskAddress('email', value)
          : v.mask === 'recipient'
            ? maskRecipient(v.channel ?? '', value)
            : maskAddress((v.channel ?? '') as ChannelKind, value);
      expect(got).toBe(v.expected);
    });
  }
});

// P1c-b: the RENDER-side port (agent-redact.ts) of the backend scanner, pinned to
// the SAME vectors. MUTATION (run, red, reverted): drop the slack-webhook pattern
// from agent-redact.ts → "slack webhook" is red here.
describe('agent-redact — the browser half of redact.ts, same vectors', () => {
  it('every secret vector is redacted to its expected form', () => {
    expect(vectors.scrub.length).toBeGreaterThanOrEqual(14);
    for (const v of vectors.scrub) {
      expect({ name: v.name, got: scrubString(expand(v.input)) }).toEqual({ name: v.name, got: v.expected });
    }
  });

  it('no false positive: UUIDs, SHAs, ordinary URLs and identifiers pass unchanged', () => {
    expect(vectors.scrubUnchanged.length).toBeGreaterThanOrEqual(8);
    for (const v of vectors.scrubUnchanged) {
      const input = expand(v.input);
      expect({ name: v.name, got: scrubString(input) }).toEqual({ name: v.name, got: input });
      expect({ name: v.name, got: redactForDisplay({ note: input }).note }).toEqual({ name: v.name, got: input });
    }
  });

  it('PII by key inside a rendered object, by its sibling channel', () => {
    for (const v of vectors.piiByKey) {
      const row: Record<string, unknown> = { [v.key]: expand(v.value) };
      if (v.channel !== null) row.channel = v.channel;
      expect({ key: v.key, got: redactForDisplay(row)[v.key] }).toEqual({ key: v.key, got: v.expected });
    }
  });

  it('secret-named keys and declared secret fields never render; a summary is scrubbed', () => {
    const out = redactForDisplay(
      { github_access_token: 'anything', nested: { client_secret: 'x1' }, title: 'ok', pat: 'p' },
      ['pat'],
    );
    expect(out).toEqual({ github_access_token: REDACTED, nested: { client_secret: REDACTED }, title: 'ok', pat: REDACTED });
    const leaked = expand(vectors.scrub[0]!.input);
    expect(redactedSummary({ url: leaked })).not.toContain(leaked);
    expect(redactedSummary(leaked)).toBe(vectors.scrub[0]!.expected);
  });
});
