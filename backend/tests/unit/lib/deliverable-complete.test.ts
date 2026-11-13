// tests/unit/lib/deliverable-complete.test.ts — U-PS-COMMIT acceptance (TX §4):
// a 0-finding hunt sets minted_count=0 and its phase can exit; an unfired
// minter blocks exit (control); a repeated `minted` call is a no-op (route test
// + mintedReplayDecision below).

import { describe, expect, test } from 'bun:test';

import { deliverableCompletion } from '../../../src/lib/deliverable-complete';
import { mintedReplayDecision } from '../../../src/routes/deliverable-minted';

const NOW = new Date('2026-10-09T00:00:00Z');
const done = { done: true };
const open = { done: false };

describe('deliverableCompletion — deferred', () => {
  test('0-finding hunt: minted_at set, minted_count=0, no cards ⇒ COMPLETE', () => {
    expect(deliverableCompletion({ deferred: true, minted_at: NOW, minted_count: 0 }, []).complete).toBe(true);
  });

  test('CONTROL — unfired minter (minted_at NULL), no cards ⇒ NOT complete', () => {
    expect(deliverableCompletion({ deferred: true, minted_at: null, minted_count: null }, [])).toEqual({
      complete: false,
      reason: 'minter_not_fired',
    });
  });

  test('unfired minter with every attached card DONE is still NOT complete', () => {
    expect(deliverableCompletion({ deferred: true, minted_at: null, minted_count: null }, [done, done]).complete).toBe(false);
  });

  test('fired with N, all N attached DONE ⇒ complete; one open ⇒ not', () => {
    const d = { deferred: true, minted_at: NOW, minted_count: 2 };
    expect(deliverableCompletion(d, [done, done]).complete).toBe(true);
    expect(deliverableCompletion(d, [done, open])).toEqual({ complete: false, reason: 'card_not_done' });
  });

  test('fired with N but fewer than N attached ⇒ NOT complete (attachment lag)', () => {
    expect(deliverableCompletion({ deferred: true, minted_at: NOW, minted_count: 3 }, [done, done])).toEqual({
      complete: false,
      reason: 'attached_fewer_than_minted',
    });
  });
});

describe('deliverableCompletion — fixed', () => {
  test('every attached card DONE ⇒ complete', () => {
    expect(deliverableCompletion({ deferred: false, minted_at: null, minted_count: null }, [done]).complete).toBe(true);
  });
  test('an open card ⇒ not complete', () => {
    expect(deliverableCompletion({ deferred: false, minted_at: null, minted_count: null }, [done, open]).complete).toBe(false);
  });
  test('zero attached cards is NOT vacuously complete', () => {
    expect(deliverableCompletion({ deferred: false, minted_at: null, minted_count: null }, [])).toEqual({
      complete: false,
      reason: 'no_cards_attached',
    });
  });
});

describe('mintedReplayDecision — a repeated `minted` is a no-op, a different count conflicts', () => {
  test('same count ⇒ replay', () => {
    expect(mintedReplayDecision({ deferred: true, minted_at: NOW, minted_count: 0 }, 0)).toBe('replay');
  });
  test('different count ⇒ conflict', () => {
    expect(mintedReplayDecision({ deferred: true, minted_at: NOW, minted_count: 0 }, 1)).toBe('conflict');
  });
  test('fixed deliverable ⇒ not_deferred', () => {
    expect(mintedReplayDecision({ deferred: false, minted_at: null, minted_count: null }, 0)).toBe('not_deferred');
  });
});
