// tests/unit/lib/k8s-scale.test.ts
//
// The PURE half of the cord's actuator: URL construction and the Scale/Deployment
// body reader. No doubles, no network — the functions take their inputs.
//
// ⭐ Why the reader is worth pinning: `replicas: 0` is the value that MEANS the line
// is stopped, so the difference between `0` and `null` is the difference between "the
// stop landed" and "nobody measured". A `replicas || null` would report the cord's own
// success as unknown.

import { describe, expect, it } from 'bun:test';

import { apiBase, parseScaleReading, reconcileScaleReading, workerScaleUrl } from '../../../src/lib/k8s-scale';

describe('apiBase', () => {
  it('uses the in-cluster service host and port when both are present', () => {
    expect(apiBase({ KUBERNETES_SERVICE_HOST: '10.43.0.1', KUBERNETES_SERVICE_PORT: '6443' })).toBe(
      'https://10.43.0.1:6443',
    );
  });

  it('defaults the port and falls back to the cluster DNS name', () => {
    expect(apiBase({ KUBERNETES_SERVICE_HOST: '10.43.0.1' })).toBe('https://10.43.0.1:443');
    expect(apiBase({})).toBe('https://kubernetes.default.svc');
  });
});

describe('workerScaleUrl', () => {
  it('addresses the scale subresource of n8n/n8n-worker and nothing else', () => {
    expect(workerScaleUrl('https://api.example')).toBe(
      'https://api.example/apis/apps/v1/namespaces/n8n/deployments/n8n-worker/scale',
    );
  });
});

describe('parseScaleReading', () => {
  it('⭐ keeps 0 as a measurement — it is the cord’s own success', () => {
    expect(parseScaleReading({ spec: { replicas: 0 }, status: { availableReplicas: 0 } })).toEqual({
      replicas: 0,
      available: 0,
    });
  });

  it('reads 1 and its available count', () => {
    expect(parseScaleReading({ spec: { replicas: 1 }, status: { availableReplicas: 1 } })).toEqual({
      replicas: 1,
      available: 1,
    });
  });

  it('⛔ reports null, never 0, when the body carries no count', () => {
    expect(parseScaleReading({})).toEqual({ replicas: null, available: null });
    expect(parseScaleReading({ spec: {} })).toEqual({ replicas: null, available: null });
  });

  it('⛔ accepts only integers — a string or a fraction is NOT a replica count', () => {
    expect(parseScaleReading({ spec: { replicas: '0' } }).replicas).toBeNull();
    expect(parseScaleReading({ spec: { replicas: 0.5 } }).replicas).toBeNull();
  });
});

describe('reconcileScaleReading', () => {
  const readBack = (replicas: number | null, available: number | null = null) => ({
    replicas,
    available,
    error: null,
  });

  it('⭐ a scale to ZERO records 0 from the Deployment even though the Scale body echoed nothing', () => {
    // The defect: autoscaling/v1 ScaleSpec.Replicas is `int32,omitempty`, so the PATCH
    // response to a scale-to-zero has NO `spec.replicas` and parses to null. Every
    // successful pull then stored "not measured" plus a permanent error.
    const echoed = parseScaleReading({ spec: {}, status: {} }).replicas;
    expect(echoed).toBeNull();
    expect(reconcileScaleReading(0, echoed, readBack(0, 0))).toEqual({
      replicas: 0,
      available: 0,
      error: null,
    });
  });

  it('⭐ a scale back to ONE records 1 from the Deployment', () => {
    expect(reconcileScaleReading(1, 1, readBack(1))).toEqual({
      replicas: 1,
      available: null,
      error: null,
    });
  });

  it('⛔ reports the contradiction when the Deployment disagrees with what was asked', () => {
    expect(reconcileScaleReading(0, null, readBack(1, 1))).toEqual({
      replicas: 1,
      available: 1,
      error: 'k8s accepted the scale to 0 but reports replicas=1',
    });
  });

  it('⛔ when the read-back itself failed, falls back to the echoed value and says so', () => {
    const failed = { replicas: null, available: null, error: 'k8s read failed: 403 nope' };
    expect(reconcileScaleReading(0, null, failed)).toEqual({
      replicas: null,
      available: null,
      error: 'k8s accepted the scale to 0 but the read-back failed: k8s read failed: 403 nope',
    });
    // A scale to 1 echoes its count, so the fallback is still a value the API server gave.
    expect(reconcileScaleReading(1, 1, failed).replicas).toBe(1);
  });
});
