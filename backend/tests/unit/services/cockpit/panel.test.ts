// tests/unit/services/cockpit/panel.test.ts
//
// The cockpit v2 panel kit (R-CK8): detail codes never carry a raw upstream message, and
// health rolls up to the worst. The fetchPanel cases ran on an injected fake clock and were
// removed under the no-test-doubles ruling.
import { describe, expect, test } from 'bun:test';

import { IntegrationError } from '../../../../src/integrations/_lib/errors';
import {
  detailCodeOf,
  worstHealth,
} from '../../../../src/services/cockpit/panel';

const unreachable = () =>
  new IntegrationError({ code: 'UPSTREAM_UNREACHABLE', message: 'connect ECONNREFUSED 10.43.0.7:1337 /api/boards/b1', service: 'kanban' });

describe('detailCodeOf / worstHealth', () => {
  test('codes are lower-case [a-z0-9_] and never carry the message', () => {
    expect(detailCodeOf('planka', unreachable())).toBe('planka_upstream_unreachable');
    expect(detailCodeOf('rm', Object.assign(new Error('x'), { code: 'project-type missing!' }))).toBe('rm_project_type_missing_');
    expect(detailCodeOf('fr_db', new Error('password authentication failed for user fr'))).toBe('fr_db_error');
  });
  test('worst of several', () => {
    expect(worstHealth('ok', 'ok')).toBe('ok');
    expect(worstHealth('ok', 'degraded')).toBe('degraded');
    expect(worstHealth('degraded', 'down', 'ok')).toBe('down');
  });
});
