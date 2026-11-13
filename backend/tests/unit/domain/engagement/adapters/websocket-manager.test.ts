// WebSocketManager behaviour with no server wired. (Socket/server-level tests
// used hand-built ws/server objects and were removed under the no-test-doubles
// ruling.)
import { test, expect, describe } from 'bun:test';
import { WebSocketManager, type KanbanEvent } from '../../../../../src/domain/engagement/adapters/websocket';

describe('WebSocketManager', () => {
  test('name property is websocket', () => {
    const mgr = new WebSocketManager();
    expect(mgr.name).toBe('websocket');
  });

  test('send returns error when server not initialized', async () => {
    const mgr = new WebSocketManager();
    const result = await mgr.send(
      {
        id: 'test-id',
        project_id: null,
        description: 'test',
        card_id: null,
        callback_path: null,
        source: null,
        metadata: null,
        status: 'pending',
        expires_at: new Date(),
        requester_id: null,
      },
      'broadcast',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Server not initialized');
  });

  test('broadcastDecision does not throw when server not set', () => {
    const mgr = new WebSocketManager();

    // `expect(...).not.toThrow()` rather than a bare call: "should not throw"
    // is the assertion, so making it implicit meant the test passed having
    // executed zero of them.
    expect(() =>
      mgr.broadcastDecision(
      {
        id: 'test-id',
        project_id: 'proj-1',
        description: 'test',
        card_id: 'card-1',
        callback_path: null,
        source: 'n8n',
        metadata: null,
        status: 'approved',
        expires_at: new Date(),
        requester_id: null,
      },
      { status: 'approved', decided_by: 'user-1', comment: 'looks good' },
      ),
    ).not.toThrow();
  });

  test('no-op when server is not set', () => {
    const bare = new WebSocketManager();
    expect(() =>
      bare.publishKanbanEvent({ kind: 'card_deleted', cardId: 'c' } as KanbanEvent),
    ).not.toThrow();
  });

  test('returns channel-disabled when server not initialized', async () => {
    const mgr = new WebSocketManager();
    const res = await mgr.sendMessage('user-1', {
      kind: 'text',
      correlationId: 'cid-1',
      text: 'hi',
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('channel-disabled');
  });
});
