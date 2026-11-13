// tests/unit/lib/v4-conveyor-wait-approval.test.ts
//
// The predicate that exempts a v4 conveyor ask (`sub.ask_fr`) from the finished-card
// guard (#1098). Each negative case removes or forges exactly ONE of the four keys.
import { test, expect, describe } from 'bun:test';

import { isV4ConveyorWaitApproval } from '../../../src/lib/approval-card-state';

const V4 = {
  kind: 'execution.ready_signoff',
  metadata: { requested_via: 'licence', source: 'conveyor', flow: 'sub.ask_fr' },
};

describe('isV4ConveyorWaitApproval', () => {
  test('the live v4 shape is exempt', () => {
    expect(isV4ConveyorWaitApproval(V4)).toBe(true);
  });

  test('a JWT row (requested_via is server-written) is NOT exempt', () => {
    expect(
      isV4ConveyorWaitApproval({ ...V4, metadata: { ...V4.metadata, requested_via: 'jwt' } }),
    ).toBe(false);
  });

  test('a row with no requested_via (pre-provenance / other doors) is NOT exempt', () => {
    const { requested_via: _r, ...md } = V4.metadata;
    expect(isV4ConveyorWaitApproval({ ...V4, metadata: md })).toBe(false);
  });

  test('a v3 licence row (no flow / other flow / other source) is NOT exempt', () => {
    const { flow: _f, ...noFlow } = V4.metadata;
    expect(isV4ConveyorWaitApproval({ ...V4, metadata: noFlow })).toBe(false);
    expect(
      isV4ConveyorWaitApproval({ ...V4, metadata: { ...V4.metadata, flow: 'exec.ready' } }),
    ).toBe(false);
    expect(
      isV4ConveyorWaitApproval({ ...V4, metadata: { ...V4.metadata, source: 'n8n' } }),
    ).toBe(false);
  });

  test('any other kind (improvement.*, null) is NOT exempt even with the v4 metadata', () => {
    expect(isV4ConveyorWaitApproval({ ...V4, kind: 'improvement.design' })).toBe(false);
    expect(isV4ConveyorWaitApproval({ ...V4, kind: null })).toBe(false);
  });

  test('null / array / non-object metadata is NOT exempt', () => {
    expect(isV4ConveyorWaitApproval({ kind: V4.kind, metadata: null })).toBe(false);
    expect(isV4ConveyorWaitApproval({ kind: V4.kind, metadata: [] })).toBe(false);
    expect(isV4ConveyorWaitApproval({ kind: V4.kind, metadata: 'x' })).toBe(false);
  });
});
