// Tests for the polling helper itself.
//
// `waitFor` exists to stop a test racing an eventually-consistent write. A
// helper like that is dangerous if it is wrong in the permissive direction:
// a version that swallows a timeout, or returns a not-ready value, would turn
// every test built on it into a green light on nothing. So its failure paths
// are tested here at least as carefully as its success path.

import { test, expect, describe } from 'bun:test';

import { waitFor } from '../../helpers/eventually';

describe('waitFor', () => {
  test('returns immediately when the first read is already ready', async () => {
    let reads = 0;
    const started = Date.now();
    const value = await waitFor(
      async () => {
        reads += 1;
        return 'ready';
      },
      (v) => v === 'ready',
      { what: 'an already-consistent value' },
    );
    expect(value).toBe('ready');
    expect(reads).toBe(1);
    // No sleep on the happy path — the poll interval must not be a tax on
    // every test that uses this.
    expect(Date.now() - started).toBeLessThan(50);
  });

  test('polls until the value becomes ready and returns THAT value', async () => {
    let reads = 0;
    const value = await waitFor(
      async () => {
        reads += 1;
        return reads < 3 ? 'pending' : 'ready';
      },
      (v) => v === 'ready',
      { what: 'a value that settles on the third read', intervalMs: 1 },
    );
    expect(value).toBe('ready');
    expect(reads).toBe(3);
  });

  test('throws on timeout — it never returns a not-ready value', async () => {
    // The critical property. If this ever returns instead of throwing, every
    // assertion downstream of a waitFor runs against unsettled state.
    let returned: unknown = Symbol('did-not-return');
    let caught: unknown;
    try {
      returned = await waitFor(async () => 'never-ready', () => false, {
        what: 'a value that is never ready',
        timeoutMs: 30,
        intervalMs: 5,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('timed out');
    expect((caught as Error).message).toContain('a value that is never ready');
    // The observed value is in the message, so a CI log says what it saw.
    expect((caught as Error).message).toContain('never-ready');
    expect(typeof returned).toBe('symbol'); // still the sentinel — nothing was returned
  });

  test('retries a throwing read instead of aborting the poll', async () => {
    // A loaded CI runner hands out transient pool/connection errors from the
    // shared queryClient. Aborting on the first blip would reintroduce the
    // flake this helper exists to remove.
    let reads = 0;
    const value = await waitFor(
      async () => {
        reads += 1;
        if (reads < 3) throw new Error('ECONNRESET (transient)');
        return 'ready';
      },
      (v) => v === 'ready',
      { what: 'a value behind two transient errors', intervalMs: 1 },
    );
    expect(value).toBe('ready');
    expect(reads).toBe(3);
  });

  test('retries a throwing predicate too', async () => {
    let calls = 0;
    const value = await waitFor(
      async () => 'v',
      () => {
        calls += 1;
        if (calls < 2) throw new Error('predicate blew up');
        return true;
      },
      { what: 'a predicate that throws once', intervalMs: 1 },
    );
    expect(value).toBe('v');
    expect(calls).toBe(2);
  });

  test('surfaces the underlying error when EVERY attempt throws', async () => {
    // A permanently broken read must not masquerade as a plain timeout —
    // that is the difference between "the row never arrived" and "the
    // database was unreachable", and they need different fixes.
    let caught: unknown;
    try {
      await waitFor(
        async () => {
          throw new Error('relation "nope" does not exist');
        },
        () => true,
        { what: 'a permanently broken read', timeoutMs: 30, intervalMs: 5 },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain('every attempt threw');
    expect((caught as Error).message).toContain('relation "nope" does not exist');
    expect((caught as Error).cause).toBeInstanceOf(Error);
  });

  test('a bigint in the observed value does not destroy the diagnostic', async () => {
    // Postgres int8 columns arrive as bigint, and JSON.stringify throws on
    // those. A naive fallback prints "[object Object]" — losing the message
    // exactly when it is needed.
    let caught: unknown;
    try {
      await waitFor(async () => [{ count: 7n, name: 'row-a' }], () => false, {
        what: 'a bigint-bearing row',
        timeoutMs: 20,
        intervalMs: 5,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain('row-a');
    expect((caught as Error).message).not.toContain('[object Object]');
  });
});
