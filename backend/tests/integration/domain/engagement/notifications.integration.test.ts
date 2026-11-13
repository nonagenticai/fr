// tests/integration/domain/engagement/notifications.integration.test.ts
//
// Pure in-memory behaviour of `NotificationService`. The fan-out cases that registered recording channels
// were removed with the no-test-doubles ruling.

import { test, expect, describe } from 'bun:test';
import { NotificationService } from '../../../../src/domain/engagement/notifications';

describe('NotificationService', () => {
  test('getChannel returns undefined for unregistered channel', () => {
    const service = new NotificationService();
    expect(service.getChannel('nonexistent')).toBeUndefined();
  });
});
