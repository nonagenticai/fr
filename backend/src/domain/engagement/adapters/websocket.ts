// src/domain/engagement/adapters/websocket.ts
// WebSocket manager — tracks connected clients and broadcasts approval + kanban events
// Uses Bun's built-in WebSocket pub/sub (ws.subscribe/publish)
import { trackDetached } from '../../../lib/detached-work';
import type { Server, ServerWebSocket } from 'bun';
import type { NotificationChannel, ApprovalWithDetails, ChannelMessage, SendResult } from '../notifications';
import { isPlatformTenant } from '../../../middleware/internal-tenant-only';
import {
  reportKanbanWsRefusal,
  type KanbanWsRefusalReason,
  type KanbanWsRefusalSurface,
} from '../../../lib/kanban-ws-refusal-metrics';
import {
  reportApprovalsWsRefusal,
  type ApprovalsWsRefusalReason,
  type ApprovalsWsRefusalSurface,
} from '../../../lib/approvals-ws-refusal-metrics';
import {
  classifyProjectOwnership,
  type OwnershipCandidateProject,
} from '../../../lib/project-owner-guard';
import { isUuidShape } from '../../../lib/uuid-shape';
import {
  recordWsPublishDropped,
  type WsPublishDropReason,
} from '../../../lib/ws-tenant-publish-metrics';

export type WsData =
  | {
      kind: 'approval';
      userId: string;
      /**
       * The connection's ACTIVE tenant, resolved at upgrade exactly like a
       * kanban socket's (`authorizeKanbanWsUpgrade`, fr row 14d-0b). The
       * upgrade is refused without one; the subscribe gates still treat a
       * missing value as a refusal.
       */
      tenantId: string;
    }
  | {
      kind: 'broadcast';
      containerName: string;
      userId: string;
      tenantId: string;
      userName?: string;
      userEmail?: string;
    }
  | {
      kind: 'kanban';
      userId: string;
      /**
       * The connection's ACTIVE tenant, resolved at upgrade by
       * `routes/kanbanWsAuth.ts` with the same rules as HTTP
       * (`acceptsActiveTenantSwitch`). The upgrade is refused when it cannot
       * be resolved, so a live kanban socket always carries one; the gate in
       * `kanbanTopicRefusal` still treats a missing value as a refusal.
       */
      tenantId: string;
    };

/**
 * ⭐ fr row 14d-2 — PER-TENANT CHANNELS. There is no cross-tenant firehose any
 * more: `kanban:all` / `approvals:all` are gone. Every kanban and approvals
 * event is published ONLY to the channel of the event's OWN tenant (the card's
 * board tenant; the approval's / report's `tenant_id`), and a socket may hold
 * only its OWN tenant's channel (the tenant resolved at upgrade, 14d-0b).
 * Platform sessions — automation included — therefore no longer receive
 * customer events, and customers get their own live updates back.
 *
 * The client protocol is unchanged: `{type:'subscribe', kanbanAll:true}` /
 * `{approvalsAll:true}` now ALIAS the socket's own tenant channel.
 */
export const kanbanTenantChannel = (tenantId: string): string => `kanban:tenant:${tenantId}`;
export const approvalsTenantChannel = (tenantId: string): string => `approvals:tenant:${tenantId}`;

/**
 * Board/card → tenant, for kanban publishes and board/card subscribes.
 * Injected from server.ts (`lib/kanban-ws-tenant-resolver.ts`) so this module
 * stays DB-free; unset means every scoped subscribe is refused and every
 * kanban publish is dropped (fail closed).
 */
export interface KanbanTenantResolver {
  boardTenant(boardId: string): Promise<string | null>;
  cardTenant(cardId: string): Promise<string | null>;
}

/**
 * WHO MAY SUBSCRIBE TO A KANBAN TOPIC (14d-0b, narrowed per tenant by 14d-2):
 * a `kind:'kanban'` socket with a resolved tenant. Which topic it gets is the
 * caller's own tenant channel; board/card topics additionally require the
 * board/card to belong to that tenant (checked in `subscribeKanbanScoped`).
 * Returns the refusal reason, or null when allowed.
 */
function kanbanTopicRefusal(data: WsData): KanbanWsRefusalReason | null {
  if (data.kind !== 'kanban') return 'not_kanban_socket';
  if (typeof data.tenantId !== 'string' || data.tenantId.length === 0) {
    return 'tenant_unresolved';
  }
  return null;
}

/**
 * WHO MAY SUBSCRIBE TO `approvalsAll` (now: its own `approvals:tenant:<id>`):
 * a `kind:'approval'` socket with a resolved tenant. No auto-subscribe.
 */
function approvalsAllRefusal(data: WsData): ApprovalsWsRefusalReason | null {
  if (data.kind !== 'approval') return 'not_approval_socket';
  if (typeof data.tenantId !== 'string' || data.tenantId.length === 0) {
    return 'tenant_unresolved';
  }
  return null;
}

/**
 * Looks up a project's id + project_data for the `approvals:project:<id>`
 * gate. Injected from server.ts (`lib/approvals-ws-project-tenant.ts`) so this
 * module stays DB-free; unset means every project subscribe is refused.
 */
export type ApprovalsProjectLookup = (
  projectId: string,
) => Promise<OwnershipCandidateProject | null>;

// -------- Kanban event types --------

export type KanbanEvent =
  // Card lifecycle
  | { kind: 'card_created'; boardId?: string; cardId: string; card?: unknown }
  | { kind: 'card_updated'; boardId?: string; cardId: string; card?: unknown }
  | {
      kind: 'card_moved';
      boardId?: string;
      cardId: string;
      card?: unknown;
      fromListId?: string;
      toListId?: string;
    }
  | { kind: 'card_duplicated'; boardId?: string; cardId: string; newCardId: string }
  | { kind: 'card_deleted'; boardId?: string; cardId: string }
  // Comments
  | { kind: 'comment_created'; cardId?: string; commentId: string; comment?: unknown }
  | { kind: 'comment_mentioned'; cardId: string; commentId: string; mentionedUserIds: string[] }
  // Labels (attach/detach an existing board label only)
  | { kind: 'label_attached'; cardId: string; labelId: string }
  | { kind: 'label_detached'; cardId: string; labelId: string };

export class WebSocketManager implements NotificationChannel {
  name = 'websocket';
  private server: Server<WsData> | null = null;
  // Per-user connection registry — multiple sockets per user are possible
  // (e.g. browser + mobile), so each userId maps to a Set of sockets.
  private userSockets: Map<string, Set<ServerWebSocket<WsData>>> = new Map();
  /** `approvals:project:<id>` gate lookup (fr row 14d-0b). Unset = refuse all. */
  private projectLookup: ApprovalsProjectLookup | null = null;
  /** Board/card → tenant (fr row 14d-2). Unset = refuse scoped subscribes, drop publishes. */
  private kanbanResolver: KanbanTenantResolver | null = null;

  /** Inject the board/card → tenant resolver (server.ts). */
  setKanbanTenantResolver(resolver: KanbanTenantResolver | null): void {
    this.kanbanResolver = resolver;
  }

  setServer(server: Server<WsData>): void {
    this.server = server;
  }

  /**
   * Upgrade an HTTP request to a WebSocket connection for approval events.
   * Returns true if the upgrade succeeded.
   *
   * `protocolHeader`, when provided, is echoed back as
   * `Sec-WebSocket-Protocol` in the 101 response — required when the client
   * sent a `bearer.<jwt>` subprotocol on the upgrade request, otherwise the
   * browser closes the connection with code 1006.
   */
  upgrade(
    req: Request,
    server: Server<WsData>,
    userId: string,
    tenantId: string,
    protocolHeader: string | null = null,
  ): boolean {
    return server.upgrade(req, {
      data: { kind: 'approval', userId, tenantId } satisfies WsData,
      headers: protocolHeader ? { 'Sec-WebSocket-Protocol': protocolHeader } : undefined,
    });
  }

  /**
   * Upgrade an HTTP request to a WebSocket connection for kanban events.
   * Returns true if the upgrade succeeded. See `upgrade()` for the
   * `protocolHeader` contract.
   */
  upgradeKanban(
    req: Request,
    server: Server<WsData>,
    userId: string,
    tenantId: string,
    protocolHeader: string | null = null,
  ): boolean {
    return server.upgrade(req, {
      data: { kind: 'kanban', userId, tenantId } satisfies WsData,
      headers: protocolHeader ? { 'Sec-WebSocket-Protocol': protocolHeader } : undefined,
    });
  }

  /**
   * Called when a WebSocket connection opens. Nothing is auto-subscribed
   * (14d-0b); a client asks for its OWN tenant channel with
   * `{kanbanAll:true}` / `{approvalsAll:true}` (14d-2).
   */
  handleOpen(ws: ServerWebSocket<WsData>): void {
    if (ws.data.kind === 'approval') {
      this.trackUserSocket(ws.data.userId, ws);
      console.log(
        `[ws] Approval client connected: ${ws.data.userId} tenant=${ws.data.tenantId} ` +
          `platform=${isPlatformTenant(ws.data.tenantId)}`,
      );
    } else if (ws.data.kind === 'kanban') {
      this.trackUserSocket(ws.data.userId, ws);
      console.log(
        `[ws] Kanban client connected: ${ws.data.userId} tenant=${ws.data.tenantId} ` +
          `platform=${isPlatformTenant(ws.data.tenantId)}`,
      );
    }
    // 'broadcast' clients are handled elsewhere (routes/coding/broadcastWebSocket.ts)
  }

  private trackUserSocket(userId: string, ws: ServerWebSocket<WsData>): void {
    let set = this.userSockets.get(userId);
    if (!set) {
      set = new Set();
      this.userSockets.set(userId, set);
    }
    set.add(ws);
  }

  /**
   * Gate a kanban-topic subscribe. On refusal: count + log it and answer with a
   * `subscribe_refused` frame (the protocol acks every subscribe with a frame,
   * so a refusal is answered the same way). Returns true when allowed.
   */
  private admitKanbanSubscribe(
    ws: ServerWebSocket<WsData>,
    surface: KanbanWsRefusalSurface,
    target: Record<string, unknown>,
  ): boolean {
    const reason = kanbanTopicRefusal(ws.data);
    if (reason === null) return true;
    reportKanbanWsRefusal({
      surface,
      reason,
      userId: ws.data.userId,
      tenantId: ws.data.kind === 'kanban' ? ws.data.tenantId : null,
      target: Object.values(target).map(String).join(','),
    });
    ws.send(JSON.stringify({ type: 'subscribe_refused', ...target, reason }));
    return false;
  }

  /**
   * fr row 14d-2: a board/card topic is admitted only when the board/card
   * belongs to the socket's OWN tenant. Unwired resolver, lookup error, an
   * unresolvable board/card, or another tenant's board/card all refuse.
   */
  private async subscribeKanbanScoped(
    ws: ServerWebSocket<WsData>,
    scope: 'board' | 'card',
    id: string,
  ): Promise<void> {
    const surface: KanbanWsRefusalSurface = scope === 'board' ? 'subscribe_board' : 'subscribe_card';
    const target = scope === 'board' ? { boardId: id } : { cardId: id };
    if (!this.admitKanbanSubscribe(ws, surface, target)) return;
    const socketTenant = (ws.data as { tenantId: string }).tenantId;
    const refuse = (reason: KanbanWsRefusalReason): void => {
      reportKanbanWsRefusal({
        surface,
        reason,
        userId: ws.data.userId,
        tenantId: socketTenant,
        target: id,
      });
      try {
        ws.send(JSON.stringify({ type: 'subscribe_refused', ...target, reason }));
      } catch {
        // Socket closed while the decision was in flight — nothing to answer.
      }
    };
    if (!this.kanbanResolver) return refuse('resolver_unset');
    let owner: string | null;
    try {
      owner =
        scope === 'board'
          ? await this.kanbanResolver.boardTenant(id)
          : await this.kanbanResolver.cardTenant(id);
    } catch {
      return refuse('lookup_failed');
    }
    if (!owner || owner !== socketTenant) return refuse('scope_tenant_mismatch');
    ws.subscribe(`kanban:${scope}:${id}`);
    try {
      ws.send(JSON.stringify({ type: 'subscribed', ...target }));
    } catch {
      // closed in flight
    }
  }

  /** Inject the project lookup for the `approvals:project:<id>` gate. */
  setProjectLookup(lookup: ApprovalsProjectLookup | null): void {
    this.projectLookup = lookup;
  }

  private refuseApprovalsSubscribe(
    ws: ServerWebSocket<WsData>,
    surface: ApprovalsWsRefusalSurface,
    reason: ApprovalsWsRefusalReason,
    target: Record<string, unknown>,
  ): void {
    reportApprovalsWsRefusal({
      surface,
      reason,
      userId: ws.data.userId,
      tenantId: ws.data.kind === 'approval' || ws.data.kind === 'kanban' ? ws.data.tenantId : null,
      target: Object.values(target).map(String).join(','),
    });
    try {
      ws.send(JSON.stringify({ type: 'subscribe_refused', ...target, reason }));
    } catch {
      // Socket closed while the decision was in flight — nothing to answer.
    }
  }

  /**
   * Gate `approvals:project:<id>`: the project's `keycloak_tenant_id` tag must
   * equal the socket's tenant (the 14b predicate, `classifyProjectOwnership`
   * — untagged and foreign both refuse). One lookup per subscribe.
   */
  private async subscribeApprovalsProject(
    ws: ServerWebSocket<WsData>,
    projectId: unknown,
  ): Promise<void> {
    const target = { projectId };
    if (ws.data.kind !== 'approval') {
      this.refuseApprovalsSubscribe(ws, 'subscribe_project', 'not_approval_socket', target);
      return;
    }
    const tenantId = ws.data.tenantId;
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      this.refuseApprovalsSubscribe(ws, 'subscribe_project', 'tenant_unresolved', target);
      return;
    }
    if (!isUuidShape(projectId)) {
      this.refuseApprovalsSubscribe(ws, 'subscribe_project', 'project_id_invalid', target);
      return;
    }
    let project: OwnershipCandidateProject | null;
    try {
      if (!this.projectLookup) throw new Error('approvals project lookup not wired');
      project = await this.projectLookup(projectId);
    } catch (err) {
      console.warn('[ws] approvals project lookup failed', { projectId, err: String(err) });
      this.refuseApprovalsSubscribe(ws, 'subscribe_project', 'lookup_failed', target);
      return;
    }
    if (!project) {
      this.refuseApprovalsSubscribe(ws, 'subscribe_project', 'project_not_found', target);
      return;
    }
    const outcome = classifyProjectOwnership(project, tenantId);
    if (outcome !== 'owned') {
      this.refuseApprovalsSubscribe(
        ws,
        'subscribe_project',
        outcome === 'untagged' ? 'project_untagged' : 'project_tenant_mismatch',
        target,
      );
      return;
    }
    if (ws.readyState !== 1) return; // closed during the lookup
    ws.subscribe(`approvals:project:${projectId}`);
    ws.send(JSON.stringify({ type: 'subscribed', projectId }));
  }

  private untrackUserSocket(userId: string, ws: ServerWebSocket<WsData>): void {
    const set = this.userSockets.get(userId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.userSockets.delete(userId);
  }

  /**
   * Called when a WebSocket message is received.
   * Supports: ping, subscribe/unsubscribe for approvals (projectId) and kanban (boardId/cardId/kanbanAll).
   */
  handleMessage(ws: ServerWebSocket<WsData>, message: string | Buffer): void {
    try {
      const msg = JSON.parse(typeof message === 'string' ? message : message.toString());

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'subscribe') {
        // Kanban board / card subscription — only the socket's own tenant's (14d-2).
        if (msg.boardId) {
          void this.subscribeKanbanScoped(ws, 'board', String(msg.boardId));
          return;
        }
        if (msg.cardId) {
          void this.subscribeKanbanScoped(ws, 'card', String(msg.cardId));
          return;
        }
        // `kanbanAll` = the socket's OWN tenant channel (14d-2; no firehose).
        if (msg.kanbanAll) {
          if (!this.admitKanbanSubscribe(ws, 'subscribe_all', { kanbanAll: true })) return;
          ws.subscribe(kanbanTenantChannel((ws.data as { tenantId: string }).tenantId));
          ws.send(JSON.stringify({ type: 'subscribed', kanbanAll: true }));
          return;
        }
        // `approvalsAll` = the socket's OWN tenant channel (14d-2; no firehose).
        if (msg.approvalsAll) {
          const reason = approvalsAllRefusal(ws.data);
          if (reason !== null) {
            this.refuseApprovalsSubscribe(ws, 'subscribe_all', reason, { approvalsAll: true });
            return;
          }
          ws.subscribe(approvalsTenantChannel((ws.data as { tenantId: string }).tenantId));
          ws.send(JSON.stringify({ type: 'subscribed', approvalsAll: true }));
          return;
        }
        // Approval project subscription — pinned to the socket's tenant (14d-0b).
        if (msg.projectId) {
          void this.subscribeApprovalsProject(ws, msg.projectId);
          return;
        }
      }

      if (msg.type === 'unsubscribe') {
        if (msg.boardId) {
          ws.unsubscribe(`kanban:board:${msg.boardId}`);
          ws.send(JSON.stringify({ type: 'unsubscribed', boardId: msg.boardId }));
          return;
        }
        if (msg.cardId) {
          ws.unsubscribe(`kanban:card:${msg.cardId}`);
          ws.send(JSON.stringify({ type: 'unsubscribed', cardId: msg.cardId }));
          return;
        }
        if (msg.kanbanAll) {
          if (ws.data.kind === 'kanban' && ws.data.tenantId) {
            ws.unsubscribe(kanbanTenantChannel(ws.data.tenantId));
          }
          ws.send(JSON.stringify({ type: 'unsubscribed', kanbanAll: true }));
          return;
        }
        if (msg.approvalsAll) {
          if (ws.data.kind === 'approval' && ws.data.tenantId) {
            ws.unsubscribe(approvalsTenantChannel(ws.data.tenantId));
          }
          ws.send(JSON.stringify({ type: 'unsubscribed', approvalsAll: true }));
          return;
        }
        if (msg.projectId) {
          ws.unsubscribe(`approvals:project:${msg.projectId}`);
          ws.send(JSON.stringify({ type: 'unsubscribed', projectId: msg.projectId }));
          return;
        }
      }
    } catch {
      // Ignore malformed messages
    }
  }

  handleClose(ws: ServerWebSocket<WsData>): void {
    if (ws.data.kind === 'approval') {
      this.untrackUserSocket(ws.data.userId, ws);
      console.log(`[ws] Approval client disconnected: ${ws.data.userId}`);
    } else if (ws.data.kind === 'kanban') {
      this.untrackUserSocket(ws.data.userId, ws);
      console.log(`[ws] Kanban client disconnected: ${ws.data.userId}`);
    }
  }

  /**
   * NotificationChannel.send — broadcast to all connected clients.
   * The recipientAddress is ignored for WebSocket (broadcast to all).
   */
  async send(
    approval: ApprovalWithDetails,
    _recipientAddress: string,
  ): Promise<SendResult> {
    if (!this.server) {
      return { success: false, error: 'Server not initialized' };
    }

    const eventType = approval.status === 'pending' ? 'new_approval' : 'approval_update';

    const payload = JSON.stringify({
      type: eventType,
      approval: {
        id: approval.id,
        project_id: approval.project_id,
        description: approval.description,
        card_id: approval.card_id,
        status: approval.status,
        source: approval.source,
        expires_at: approval.expires_at,
      },
      timestamp: new Date().toISOString(),
    });

    // fr row 14d-2: the approval's OWN tenant channel only; no tenant ⇒ dropped.
    if (!this.publishApproval(approval, eventType, payload)) {
      return { success: false, error: 'tenant_unresolved' };
    }
    return { success: true };
  }

  /**
   * NotificationChannel.sendMessage (E-6) — push a generic ChannelMessage to a
   * specific user's active sockets. `address` is the recipient userId. If the
   * user has no active socket, returns `{success:false, error:'no-active-connection'}`.
   */
  async sendMessage(
    address: string,
    message: ChannelMessage,
  ): Promise<SendResult> {
    if (!this.server) {
      return { success: false, error: 'channel-disabled' };
    }

    const sockets = this.userSockets.get(address);
    if (!sockets || sockets.size === 0) {
      return { success: false, error: 'no-active-connection' };
    }

    const payload = JSON.stringify({
      type: 'channel_message',
      message: {
        kind: message.kind,
        correlationId: message.correlationId,
        text: message.text,
        meta: message.meta ?? null,
      },
      timestamp: new Date().toISOString(),
    });

    let delivered = 0;
    for (const ws of sockets) {
      try {
        ws.send(payload);
        delivered += 1;
      } catch {
        // Socket may have died between handleClose and now; skip silently —
        // untrackUserSocket will clean it up on the close event.
      }
    }

    if (delivered === 0) {
      return { success: false, error: 'no-active-connection' };
    }
    return { success: true, metadata: { delivered } };
  }

  /**
   * Broadcast a decision event.
   */
  broadcastDecision(
    approval: ApprovalWithDetails,
    decision: { status: string; decided_by: string; comment?: string },
  ): void {
    if (!this.server) return;

    const payload = JSON.stringify({
      type: 'approval_decision',
      approval: {
        id: approval.id,
        project_id: approval.project_id,
        status: decision.status,
        card_id: approval.card_id,
      },
      decision: {
        status: decision.status,
        decided_by: decision.decided_by,
        comment: decision.comment,
      },
      timestamp: new Date().toISOString(),
    });

    this.publishApproval(approval, 'approval_decision', payload);
  }

  /**
   * fr row 14d-2 — publish an approvals-channel payload to the approval's OWN
   * tenant channel (+ its project topic, whose subscribe is pinned to the
   * project's tag, 14d-0b). An approval without a tenant is DROPPED and
   * counted — there is no firehose to fall back to. Returns whether it went out.
   */
  private publishApproval(
    approval: { tenant_id?: string | null; project_id: string | null },
    eventType: string,
    payload: string,
  ): boolean {
    if (!this.server) return false;
    const tenantId = approval.tenant_id;
    if (!tenantId) {
      recordWsPublishDropped({ channel: 'approvals', reason: 'event_has_no_scope', eventType });
      return false;
    }
    this.server.publish(approvalsTenantChannel(tenantId), payload);
    if (approval.project_id) {
      this.server.publish(`approvals:project:${approval.project_id}`, payload);
    }
    return true;
  }

  /**
   * fr row 14d-2 — a `new_report` frame (routes/reports.ts), on the report's
   * OWN tenant's approvals channel. `project_reports.tenant_id` is nullable
   * (migration 080): a NULL-tenant report is dropped and counted.
   */
  publishReport(report: {
    id: string;
    tenant_id: string | null;
    report_type: string;
    title: string;
    summary: string | null;
    project_id: string | null;
    created_at: Date | string | null;
  }): boolean {
    const payload = JSON.stringify({
      type: 'new_report',
      report: {
        id: report.id,
        report_type: report.report_type,
        title: report.title,
        summary: report.summary,
        project_id: report.project_id,
        created_at: report.created_at,
      },
      timestamp: new Date().toISOString(),
    });
    if (!this.server) return false;
    if (!report.tenant_id) {
      recordWsPublishDropped({ channel: 'approvals', reason: 'event_has_no_scope', eventType: 'new_report' });
      return false;
    }
    this.server.publish(approvalsTenantChannel(report.tenant_id), payload);
    return true;
  }

  /**
   * Publish a kanban event — fire-and-forget wrapper over
   * `publishKanbanEventScoped` (the ~30 route call sites are synchronous).
   */
  publishKanbanEvent(event: KanbanEvent): void {
    void trackDetached(
      this.publishKanbanEventScoped(event).catch((err) => {
        console.error('[ws] kanban publish failed', err);
      }),
    );
  }

  /**
   * fr row 14d-2 — publish a kanban event to its OWN tenant only:
   *   - kanban:tenant:{tenant}  (the event's board tenant)
   *   - kanban:board:{boardId}  (if the event carries one; subscribe is tenant-pinned)
   *   - kanban:card:{cardId}    (if the event carries one; subscribe is tenant-pinned)
   * The tenant is the event's BOARD's (`boardId`, else the card's board via
   * `cardId`). An event with neither, an unresolvable board/card, a lookup
   * error, or an unwired resolver ⇒ DROPPED (published to nobody) and counted.
   * Resolves to whether it was published.
   */
  async publishKanbanEventScoped(event: KanbanEvent): Promise<boolean> {
    if (!this.server) return false;
    const boardId = 'boardId' in event ? (event as { boardId?: string }).boardId : undefined;
    const cardId = 'cardId' in event ? (event as { cardId?: string }).cardId : undefined;
    const drop = (reason: WsPublishDropReason): false => {
      recordWsPublishDropped({
        channel: 'kanban',
        reason,
        eventType: event.kind,
        scope: boardId ?? cardId ?? null,
      });
      return false;
    };
    if (!boardId && !cardId) return drop('event_has_no_scope');
    if (!this.kanbanResolver) return drop('resolver_unset');
    let tenantId: string | null;
    try {
      tenantId = boardId
        ? await this.kanbanResolver.boardTenant(boardId)
        : await this.kanbanResolver.cardTenant(cardId as string);
    } catch {
      return drop('lookup_failed');
    }
    if (!tenantId) return drop('tenant_unresolved');
    const server = this.server;
    if (!server) return false;

    const payload = JSON.stringify({
      type: `kanban:${event.kind}`,
      event,
      timestamp: new Date().toISOString(),
    });
    server.publish(kanbanTenantChannel(tenantId), payload);
    if (boardId) server.publish(`kanban:board:${boardId}`, payload);
    if (cardId) server.publish(`kanban:card:${cardId}`, payload);
    return true;
  }
}

export const wsManager = new WebSocketManager();
