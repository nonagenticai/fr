// tests/unit/lib/detached-work.test.ts
import { expect, test } from 'bun:test';

import { drainDetachedWork, trackDetached } from '../../../src/lib/detached-work';

test('drain waits for tracked detached work, including work started while draining', async () => {
  const done: string[] = [];
  void trackDetached(
    new Promise<void>((resolve) =>
      setTimeout(() => {
        done.push('a');
        void trackDetached(
          new Promise<void>((r) => setTimeout(() => (done.push('b'), r()), 5)),
        );
        resolve();
      }, 5),
    ),
  );
  await drainDetachedWork();
  expect(done).toEqual(['a', 'b']);
  expect(await drainDetachedWork(1)).toBe(true);
});

test('a rejected detached promise never makes drain throw, and is still returned to the caller', async () => {
  const work = Promise.reject(new Error('downstream down'));
  const returned = trackDetached(work);
  expect(returned).toBe(work);
  await expect(returned).rejects.toThrow('downstream down');
  expect(await drainDetachedWork()).toBe(true);
});

test('drain gives up after its timeout instead of hanging on a promise that never settles', async () => {
  let release!: () => void;
  void trackDetached(new Promise<void>((r) => (release = r)));
  const started = Date.now();
  expect(await drainDetachedWork(20)).toBe(false);
  expect(Date.now() - started).toBeLessThan(1_000);
  // Settle it so no later test inherits a tracked promise (the preload drains after every test).
  release();
  expect(await drainDetachedWork(1_000)).toBe(true);
});

test('a promise the drain gave up on is forgotten: it costs one bound, not one per later drain', async () => {
  void trackDetached(new Promise<void>(() => {}));
  expect(await drainDetachedWork(20)).toBe(false);
  const started = Date.now();
  expect(await drainDetachedWork(1_000)).toBe(true);
  expect(Date.now() - started).toBeLessThan(100);
});
