// src/lib/stores/unsavedWork.test.ts
//
// The registry's own contract: the two things only the registry can get wrong.

import { describe, it, expect, afterEach } from 'vitest';
import { registerUnsaved as register, hasUnsavedWork } from './unsavedWork';

// Every probe a case registers is unregistered through the production API.
const stops: Array<() => void> = [];
const registerUnsaved = (...a: Parameters<typeof register>) => {
  const stop = register(...a);
  stops.push(stop);
  return stop;
};
afterEach(() => {
  while (stops.length) stops.pop()!();
});

describe('unsavedWork registry', () => {
  it('is clean with nothing registered', () => {
    expect(hasUnsavedWork()).toBe(false);
  });

  it('evaluates the probe at CHECK time, not at registration time', () => {
    let dirty = false;
    registerUnsaved('page', () => dirty);
    expect(hasUnsavedWork()).toBe(false);
    // The whole reason a probe is a function: registering a boolean would pin
    // the value the page had when it mounted, i.e. always "clean".
    dirty = true;
    expect(hasUnsavedWork()).toBe(true);
  });

  it('unregistering only removes its OWN probe under a reused key', () => {
    // A route transition mounts the incoming component before the outgoing one
    // is torn down, so both hold the same key. A blind `delete(key)` in the
    // outgoing cleanup would silently disarm the incoming page's guard.
    const stopOld = registerUnsaved('page', () => false);
    registerUnsaved('page', () => true); // the incoming mount
    stopOld();
    expect(hasUnsavedWork()).toBe(true);
  });

  it('reads a throwing probe as dirty', () => {
    registerUnsaved('broken', () => {
      throw new Error('closed over dead state');
    });
    expect(hasUnsavedWork()).toBe(true);
  });
});
