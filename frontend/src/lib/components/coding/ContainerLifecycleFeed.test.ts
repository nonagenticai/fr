// Unit tests for the pure describeLifecycleStatus backing ContainerLifecycleFeed
// (the coding-realtime broadcast consumer surface). Tests in node.

import { describe, it, expect } from 'vitest';
import { describeLifecycleStatus } from './ContainerLifecycleFeed.svelte';

describe('describeLifecycleStatus', () => {
  it('running → success', () => {
    expect(describeLifecycleStatus('running')).toEqual({ label: 'RUNNING', tone: 'success' });
  });

  it('creating → warning (in-progress, not yet healthy)', () => {
    expect(describeLifecycleStatus('creating')).toEqual({ label: 'CREATING', tone: 'warning' });
  });

  it('error → danger, never muted-away', () => {
    expect(describeLifecycleStatus('error')).toEqual({ label: 'ERROR', tone: 'danger' });
  });

  it('stopped → muted', () => {
    expect(describeLifecycleStatus('stopped').tone).toBe('muted');
  });

  it('null (before any event) → muted WAITING, never a fabricated running', () => {
    const v = describeLifecycleStatus(null);
    expect(v.tone).toBe('muted');
    expect(v.label).toBe('WAITING');
    expect(v.label).not.toBe('RUNNING');
  });

  it('an unknown status is surfaced uppercased + muted (honest, not hidden)', () => {
    expect(describeLifecycleStatus('degraded')).toEqual({ label: 'DEGRADED', tone: 'muted' });
  });
});
