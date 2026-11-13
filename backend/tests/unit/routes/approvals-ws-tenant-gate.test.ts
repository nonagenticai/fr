// tests/unit/routes/approvals-ws-tenant-gate.test.ts
//
// fr row 14d-0b (approvals half) — the refusal counter the approvals WebSocket
// tenant gate reports into. (The live-socket gate tests needed a fake Keycloak
// token check and a fake project lookup and were removed under the
// no-test-doubles ruling.)

import { describe, expect, test } from 'bun:test';
import {
  renderApprovalsWsRefusalMetrics,
  reportApprovalsWsRefusal,
} from '../../../src/lib/approvals-ws-refusal-metrics';


describe('approvals WS refusal metrics', () => {
  test('fr_approvals_ws_refused_total is exposed, pre-seeded, and counts', () => {
    reportApprovalsWsRefusal({ surface: 'subscribe_all', reason: 'tenant_not_platform' });
    const lines = renderApprovalsWsRefusalMetrics();
    expect(lines).toContain('# TYPE fr_approvals_ws_refused_total counter');
    expect(lines).toContain(
      'fr_approvals_ws_refused_total{surface="subscribe_all",reason="tenant_not_platform"} 1',
    );
    expect(lines).toContain(
      'fr_approvals_ws_refused_total{surface="upgrade",reason="tenant_unresolved"} 0',
    );
  });
});
