// tests/unit/types/intake-envelope.test.ts
//
// `deriveIdempotencyKey` had NO test of any kind before this file, despite
// being the most widely-shared derived key in the backend:
//
//   * `workers/scheduled-trigger-tick.ts` and `routes/intake-webhook.ts` both
//     derive it, and both feed it to `claimIdempotencyKey(tenant_id, key)` —
//     a PERSISTED uniqueness claim. A re-key makes every already-claimed
//     record claimable again, so the next tick re-dispatches history.
//   * It is stamped onto the wire envelope as `idempotency_key` and consumed
//     by the n8n `scheduled-intake-actions` package. Per this module's own
//     header: "both the cron tick and any receiver-side dedup logic must call
//     this to stay aligned" — i.e. the value is a CROSS-REPO contract, and a
//     change here breaks a consumer that does not live in this repository and
//     will not be caught by any test in it.
import { describe, expect, test } from 'bun:test';
import { deriveIdempotencyKey, IntakeEnvelope } from '../../../src/types/intake-envelope';

const TRIGGER = '11111111-2222-4333-8444-555555555555';

describe('deriveIdempotencyKey', () => {
  test('is deterministic and sha256-hex shaped', () => {
    const a = deriveIdempotencyKey({
      trigger_id: TRIGGER,
      connector_kind: 'rss',
      stable_record_id: 'rec-1',
    });
    const b = deriveIdempotencyKey({
      trigger_id: TRIGGER,
      connector_kind: 'rss',
      stable_record_id: 'rec-1',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // The envelope schema pins the length independently — keep them in step.
    expect(a).toHaveLength(64);
    expect(IntakeEnvelope.shape.idempotency_key.safeParse(a).success).toBe(true);
  });

  test('every field participates — no two distinct tuples share a key', () => {
    const base = {
      trigger_id: TRIGGER,
      connector_kind: 'rss',
      stable_record_id: 'rec-1',
    };
    const keys = new Set([
      deriveIdempotencyKey(base),
      deriveIdempotencyKey({ ...base, trigger_id: '99999999-2222-4333-8444-555555555555' }),
      deriveIdempotencyKey({ ...base, connector_kind: 'n8n_webhook' }),
      deriveIdempotencyKey({ ...base, stable_record_id: 'rec-2' }),
    ]);
    expect(keys.size).toBe(4);
  });

  // The `:` separators are load-bearing, not decoration: without them
  // ("a", "b", "c") and ("ab", "", "c") both hash "abc", so a record from one
  // trigger could claim the idempotency slot of a record from another.
  test('the field separators make tuple boundaries unambiguous', () => {
    expect(
      deriveIdempotencyKey({ trigger_id: 'a', connector_kind: 'b', stable_record_id: 'c' }),
    ).not.toBe(
      deriveIdempotencyKey({ trigger_id: 'ab', connector_kind: '', stable_record_id: 'c' }),
    );
  });

  // ---- DIGEST PIN ---------------------------------------------------------
  // The assertions above are all self-referential: they compare one output of
  // this function to another output of the SAME build. Change the preimage —
  // reorder the fields, swap the `:` separator, add a domain prefix — and every
  // one of them still passes while the key silently changes for all three
  // consumers (the tick, the webhook route, and the out-of-repo n8n package).
  //
  // If this fails you have changed the derivation. That is a BREAKING change:
  // in-flight records lose their claim and the n8n receiver's dedup desyncs.
  // Note this key carries NO version marker (unlike provisioning's `fr-*-v1-`
  // keys, which can at least signal a deliberate re-key) — so there is no way
  // to roll it forward compatibly. Coordinate with the consumer, or put the
  // preimage back. Do NOT just update the expected string.
  test('key scheme is frozen — the exact digest is part of the contract', () => {
    expect(
      deriveIdempotencyKey({
        trigger_id: TRIGGER,
        connector_kind: 'rss',
        stable_record_id: 'rec-1',
      }),
    ).toBe('b480ac1122fd16e686ae1a059241dc4a76a1ec826307c63314df9ca1a2421839');
  });
});
